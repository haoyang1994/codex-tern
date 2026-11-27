import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { HELP, VERSION, nativeArgs, parseOptions, type Options } from './options';
import { findExecutable, openTern, focusClient } from './launch';
import { CodexRpc } from './rpc';
import { Controller } from './controller';
import { parseCommand, commandHelp } from './commands';
import { isLanguage } from './i18n';
import { RecoveryStore, recoveryPath } from './recovery';
import { Preferences, preferencesPath } from './preferences';
import type { ProjectInstance, ProjectCommand, ProjectReply } from './project-instance';
import { attachWeixinOwner, type WeixinOwner } from './weixin-owner';
import { installChiefGuard } from './weixin-chief-guard';
import type { PromptAnchor } from './prompt-anchor';
import { writeOmpJson } from './omp-session';

function reportOmp(reply: ProjectReply) {
  if (!reply.ompId) throw new Error('The open codex-tern pane needs a restart to accept omp sessions.');
  console.log(`omp session ID verified: ${reply.ompId}`);
}

async function launchOmp(options: Options, codex: string) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-tern-omp-'));
  const file = join(dir, 'result.json');
  try {
    let failure: Error | undefined;
    void openTern(fileURLToPath(import.meta.url), nativeArgs({ ...options, ompStartupReceipt: file }, codex), options.cwd, true)
      .then(code => { if (code !== 0) failure = new Error(`Tern could not open codex-tern (status ${code}).`); }, error => { failure = error; });
    const deadline = Date.now() + 42000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const response = await readFile(file, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (response) {
        const result = JSON.parse(response);
        if (result.error) throw new Error(result.error);
        reportOmp(result); return;
      }
      await delay(100);
    }
    throw new Error('Tern did not confirm the omp session in time. Check the pane before retrying.');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseOptions(args);
  if (options.native) Object.assign(process.env, options.runtimeEnv);
  if (options.help) { console.log(HELP); return; }
  if (options.version) { console.log(VERSION); return; }
  if (options.command) {
    await (await import('./tern-plugin')).runPluginCommand(options.command);
    return;
  }
  if (!(await stat(options.cwd).catch(() => null))?.isDirectory())
    throw new Error(`Project directory does not exist or is not a directory: ${options.cwd}`);
  const omp = options.agent === 'omp';
  const binary = options.codex ?? process.env.CODEX_BINARY ?? 'codex';
  const codex = findExecutable(binary) ?? binary;
  if (!omp && !findExecutable(codex)) throw new Error(`Codex executable was not found: ${binary}. Install the official Codex CLI and sign in with codex login, or use --codex /path/to/codex.`);
  const projects = options.plain ? null : await import('./project-instance');
  const address = projects ? await projects.projectAddress(options.cwd) : undefined;
  const command: ProjectCommand = { version: 1, signature: projects?.projectSignature(codex, options.config) ?? '',
    ...(omp ? { agent: 'omp', cwd: options.cwd } : {}),
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.promptAnchor ? { promptAnchor: options.promptAnchor } : {}),
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}) };
  const report = omp ? (reply: ProjectReply) => {
    if (options.ompStartupReceipt) return;
    reportOmp(reply);
  } : undefined;
  const receipt = async (reply: ProjectReply | { error: string }) => {
    if (options.ompStartupReceipt) await writeOmpJson(options.ompStartupReceipt, reply);
  };
  let reused: ProjectReply | undefined;
  const receive = omp ? (reply: ProjectReply) => { reused = reply; report?.(reply); } : undefined;
  if (projects && address && await projects.contactProject(address, command, receive)) {
    if (reused) await receipt(reused);
    return;
  }
  const rpc = new CodexRpc({ binary: codex, cwd: options.cwd,
    args: ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"',
      ...options.config.flatMap(value => ['-c', value])] });
  installChiefGuard(rpc);
  const c = new Controller(rpc, rpc.options.cwd, new Preferences(preferencesPath()));
  let instance: ProjectInstance | null = null;
  let shuttingDown = false;
  let weixinOwner: WeixinOwner | undefined;
  let weixinAttach: Promise<void> | undefined;
  const close = async () => {
    if (shuttingDown) return;
    shuttingDown = true; c.connection = 'disconnected';
    // Keep the project lease until the final journal is saved. A new client
    // must not read an older snapshot while this backend is still closing.
    try { await weixinAttach; await weixinOwner?.close(); await c.closeOmp(); await c.promptTree.close(); await rpc.close(); await c.flushRecovery(); await c.flushOutlines(); }
    finally { await instance?.close(); }
  };
  try {
    const ui = options.plain ? null : await (await import('./native-host')).createNativeUI(c);
    if (!ui && !options.plain) {
      if (options.native) throw new Error('Tern native UI is unavailable. Run directly in a Tern pane without tmux, screen or zellij, or use --plain.');
      if (omp) { await launchOmp(options, codex); return; }
      process.exitCode = await openTern(fileURLToPath(import.meta.url), nativeArgs(options, codex), options.cwd);
      return;
    }
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    if (ui && projects && address) {
      const openProject = async (cwd: string, resume?: string, prompt?: string, promptAnchor?: PromptAnchor) => {
        const target = await projects.projectAddress(cwd);
        const request: ProjectCommand = { version: 1, signature: command.signature, resume, prompt, promptAnchor };
        if (await projects.contactProject(target, request)) return true;
        return await openTern(fileURLToPath(import.meta.url), nativeArgs({ ...options, agent: 'codex', ompStartupReceipt: undefined, cwd, resume, prompt, promptAnchor }, codex), cwd) === 0;
      };
      ui.openProject = (cwd, resume, anchor) => openProject(cwd, resume, undefined, anchor);
      instance = await projects.serveProject(address, command, async request => {
        await started;
        if (shuttingDown) throw new Error('The project is closing.');
        await focusClient();
        if (request.agent === 'omp') {
          if (!request.cwd || await projects.projectAddress(request.cwd) !== address)
            throw new Error('This omp request belongs to another project.');
          return { ompId: await ui.openOmp(request.resume, request.cwd) };
        }
        if (c.codexConnection !== 'ready' || !c.codexThread) throw new Error('Codex is not connected.');
        if (request.resume) {
          if (!rpc.ownsThread(request.resume)) {
            const result = await rpc.request('thread/read', { threadId: request.resume, includeTurns: false });
            if (result.thread?.cwd && await projects.projectAddress(result.thread.cwd) !== address) {
              if (!await openProject(result.thread.cwd, request.resume, request.prompt, request.promptAnchor)) throw new Error('Could not open the project.');
              return;
            }
          }
          if (!await (request.promptAnchor ? ui.openPrompt(request.promptAnchor) : ui.openSession(request.resume))) throw new Error('This session is unavailable or open in another client.');
        } else if (request.prompt !== undefined) {
          if (!await ui.newSession()) throw new Error('Could not create a session.');
        } else if (c.engine === 'omp' && !await ui.openSession(c.codexThread.id)) {
          throw new Error('The Codex session is unavailable.');
        }
        if (request.prompt !== undefined) await c.submit(request.prompt);
      }, receive);
      if (!instance) { if (reused) await receipt(reused); await ui.close(); return; }
      try { c.useRecovery(await RecoveryStore.open(recoveryPath(address))); }
      catch (error) { c.notice((error as Error).message, true); }
      const recoveryFile = recoveryPath(address);
      c.useOutlines(join(dirname(dirname(recoveryFile)), 'outlines', basename(recoveryFile, '.json')));
    }
    // Never await backend work in the UI input loop: approvals and cancellation stay live.
    const launch = async () => {
      if (ui && omp) {
        try { await receipt({ ompId: await ui.openOmp(options.resume) }); }
        catch (error) { await receipt({ error: (error as Error).message }); }
      }
      await c.connect(omp ? undefined : options.resume, options.prompt !== undefined, !options.promptAnchor);
    };
    const connection = launch().then(async () => {
      if (ui && options.promptAnchor) { await focusClient(); await ui.openPrompt(options.promptAnchor); }
      if (options.prompt !== undefined) await c.submit(options.prompt);
    }).catch(e => {
      if (c.engine === 'codex') c.notice(e.message, true);
      c.connection = rpc.connected ? 'ready' : 'disconnected'; c.changed();
    }).finally(ready);
    const sidebar = ui?.openSidebar().catch(error => c.notice(error.message, true));
    if (ui) weixinAttach = connection.then(async () => {
      if (!shuttingDown && c.codexConnection === 'ready') weixinOwner = await attachWeixinOwner(c, () => ui.current.sendMode);
    });
    if (ui) {
      await ui.run();
    } else {
      console.log('Codex × Tern · Plain text mode (launch in Tern for the native interface)');
      c.on('change', (() => {
        const seen = new Set<string>();
        const shownNotices = new WeakSet<object>();
        let account = c.account;
        return () => {
          if (c.account !== account) { account = c.account; console.log(`\n${account}`); }
          for (const item of c.items) {
            if (!item.done || seen.has(item.id)) continue;
            seen.add(item.id);
            if (item.item.type === 'agentMessage') console.log(`\nCodex: ${item.item.text}`);
            else if (item.item.type === 'commandExecution') console.log(`\n[Command] ${item.item.command}\n${item.item.aggregatedOutput ?? ''}`);
            else if (item.item.type === 'fileChange') console.log(`\n[Changes] ${JSON.stringify(item.item.changes, null, 2)}`);
          }
          for (const n of c.notices) if (!shownNotices.has(n)) {
            console.log(`\n${n.error ? 'Error' : 'Notice'}: ${n.text}`); shownNotices.add(n);
          }
        };
      })());
      rpc.on('request', m => console.log(`\n[Pending request ${m.id}] ${m.method}\n${JSON.stringify(m.params, null, 2)}\nRespond with /reply ${m.id} followed by the native JSON response.`));
      await connection;
      if (!c.thread) { process.exitCode = 1; return; }
      console.log(`Workspace: ${c.cwd}\nModel: ${c.model} · ${c.effort}\nType /help for commands.`);
      const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\n› ' });
      rl.on('SIGINT', () => { if (c.activeTurn) void c.act(() => c.stop()); else rl.close(); });
      rl.prompt();
      for await (const line of rl) {
        const parsed = parseCommand(line, [], true);
        if (parsed.kind === 'command' && parsed.name === 'exit') break;
        await c.act(async () => {
          if (parsed.kind === 'error') throw new Error(parsed.message + ' · ' + line);
          if (parsed.kind === 'text') { await c.submit(line); return; }
          const { name, args } = parsed;
          const threads = async () => { await c.listThreads(); console.log(c.threads.map(t => `${t.id}  ${t.name || t.preview}`).join('\n')); };
          switch (name) {
            case 'help': console.log(commandHelp(true, c.preferences.language)); break;
            case 'reconnect': await c.reconnect(); break;
            case 'new': await c.newThread(); break;
            case 'threads': await threads(); break;
            case 'resume': if (args) await c.resume(args); else await threads(); break;
            case 'model':
              if (!args) console.log(c.models.filter(m => !m.hidden).map(m => `${m.model}  ${m.displayName}`).join('\n'));
              else { if (!c.models.some(m => !m.hidden && m.model === args)) throw new Error('Choose an available model.'); c.chooseModel(args); }
              break;
            case 'status': console.log(JSON.stringify({ cwd: c.cwd, threadId: c.thread?.id, model: c.model, effort: c.effort, connection: c.connection, activeTurn: c.activeTurn, queued: c.queue.length }, null, 2)); break;
            case 'language':
              if (!args) console.log(`Language: ${c.preferences.language} · /language en|zh-CN`);
              else { if (!isLanguage(args)) throw new Error('Usage: /language en|zh-CN'); await c.preferences.setLanguage(args); }
              break;
            case 'skills':
              console.log((await c.skills.list()).filter(s => `${s.name} ${s.description} ${s.path}`.toLowerCase().includes(args.toLowerCase())).map(s => `$${s.name}  ${s.path}  ${s.description}`).join('\n'));
              if (c.skills.error) console.error(c.skills.error);
              break;
            case 'stop': await c.stop(); break;
            case 'next': await c.runQueue(); break;
            case 'unconfirmed':
              await c.refreshHistory();
              console.log(c.unconfirmed.map(q => `${q.id}  ${q.text || '[Image]'} (${q.images.length} images)`).join('\n'));
              console.log('Check the conversation, then use /sent ID or /retry ID. Retry only queues the message; /next sends it.');
              break;
            case 'sent': case 'retry':
              if (!args) throw new Error(`Usage: /${name} ID`);
              c.resolveUnconfirmed(args, name === 'retry'); break;
            case 'queue': if (!args) throw new Error('Usage: /queue TEXT'); await c.submit(args, [], 'queue'); break;
            case 'reply': {
              const match = /^(\S+) ([\s\S]+)$/.exec(args);
              if (!match) throw new Error('Usage: /reply ID JSON');
              const req = c.requests.find(r => String(r.id) === match[1]);
              if (!req) throw new Error('This request is no longer active');
              c.answer(req.id, JSON.parse(match[2])); break;
            }
          }
        });
        rl.prompt();
      }
      rl.close();
    }
    await close();
    await Promise.all([connection, sidebar]);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e); process.exitCode = 1;
  } finally { await close(); }
}

main().catch(error => {
  console.error(`codex-tern: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
