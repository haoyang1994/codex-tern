// Offscreen-only coverage for the production sidebar and the stock omp binary.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareTernQaConfig } from './qa-tern-config.mjs';

const repo = resolve(import.meta.dirname, '..');
const out = mkdtempSync('/private/tmp/ct-omp-qa-');
const config = join(out, 'config'), control = join(out, 'control.sock'), socket = join(out, 'daemon.sock');
const tern = process.env.QA_TERN_BINARY || '/Applications/Tern.app/Contents/MacOS/tern';
const omp = process.env.QA_OMP_BINARY;
const fixtureCodex = join(repo, 'test/fixtures/ui-app-server.mjs');
const bun = execFileSync('/usr/bin/which', ['bun'], { encoding: 'utf8' }).trim();
const cwd = join(out, "fixture's project");
const fixtures = join(out, 'fixture-root/crates');
const shim = join(out, 'bin/tern'), selectedBinary = join(out, 'bin/omp');
const ipcKey = createHash('sha256').update(JSON.stringify([cwd, socket, join(out, 'codex')])).digest('hex').slice(0, 28);
const projectSocket = join('/tmp', 'codex-tern-' + process.getuid(), ipcKey + '.sock');
const env = {
  HOME: join(out, 'home'), PATH: [join(out, 'bin'), resolve(bun, '..'), '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':'),
  LANG: 'en_US.UTF-8', SHELL: '/bin/bash', BASH_SILENCE_DEPRECATION_WARNING: '1', ZDOTDIR: join(out, 'home'),
  TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: socket, STENCIL_FIXTURE_ROOT: join(fixtures, 'tern'),
  STENCIL_LOG_DIR: join(out, 'logs'), STENCIL_LOG: 'warn,tern::plugin=debug', CODEX_TERN_CONTROL: control,
  TERN_TSP_RECORD: join(out, 'tsp-wire.jsonl'),
  CODEX_TERN_WEIXIN_DISABLE: '1', CODEX_HOME: join(out, 'codex'), CODEX_BINARY: fixtureCodex, QA_CODEX_HOME: join(out, 'codex'),
  QA_SESSION_FIXTURES: '1', QA_RPC_LOG: join(out, 'rpc.jsonl'), QA_HISTORY_FILE: join(out, 'history.json'),
  QA_EMPTY_SESSION_CWD: cwd, XDG_STATE_HOME: join(out, 'state'), XDG_CACHE_HOME: join(out, 'cache'),
  PI_CODING_AGENT_DIR: join(out, 'omp-agent'), PI_NATIVES_DIR: join(out, 'natives'),
  PI_TEST_SESSION_OWNERS_DIR: join(out, 'owners'), OMP_BINARY: selectedBinary, OMP_SKIP_SETUP: '1',
  NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
};
const result = { out, checks: [], captures: {}, errors: [], limits: [
  'Tern renderer and omp executable are native. Codex app-server and model settings are isolated fixtures.',
  'Only a loopback deterministic model is used. Tern CLI focus and cold launch are relayed to the private offscreen renderer.',
] };
const children = [], owned = new Map();
const quote = v => "'" + v.replaceAll("'", "'\\''") + "'";
const processes = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm='],
  { env: { LC_ALL: 'C' }, encoding: 'utf8' }).trim().split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
    return { pid: +m[1], ppid: +m[2], start: m[3], command: m[4] };
  });
const before = processes();
const same = (a, b) => a && b && a.pid === b.pid && a.start === b.start;
function captureOwned() {
  const rows = processes(), pids = new Set(children.filter(child => child.exitCode === null && child.signalCode === null).map(c => c.pid));
  for (let count = -1; pids.size !== count;) {
    count = pids.size;
    for (const p of rows) if (pids.has(p.ppid)) pids.add(p.pid);
  }
  for (const row of rows) if (pids.has(row.pid) && !before.some(old => same(old, row))) owned.set(row.pid, row);
}
function socketOwned(child, path) {
  try {
    return statSync(path).isSocket() && execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-U', '-Fn'],
      { encoding: 'utf8', timeout: 2000 }).split('\n').some(line => line === 'n' + path || line.startsWith('n' + path + ' '));
  } catch { return false; }
}
let server, model, ready = false;
const modelRequests = [];
let releaseAnswer = false;
function start(args, name) {
  const fd = Bun.file(join(out, name + '.log'));
  const child = spawn(tern, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const writer = fd.writer();
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { writer.write(data); writer.flush(); });
  child.once('close', () => writer.end());
  children.push(child);
  return child;
}
function cli(args, command = tern) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
}
function ctl(command) {
  assert(ready && socketOwned(server, control), 'private control endpoint ownership');
  const reply = JSON.parse(cli(['ctl', '--control', control, command]));
  assert(reply.ok, `${command} · ${reply.error}`);
  return reply;
}
async function wait(check, label, ms = 9000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    if (ready) ctl('wait 100');
    await delay(50);
  }
  throw new Error('Timed out waiting for ' + label);
}
const tree = selector => ctl('tree ' + selector).nodes ?? [];
const text = selector => tree(selector).map(node => node.text ?? '').join('\n');
const click = selector => ctl('click ' + selector);
const key = value => ctl('key ' + value);
const role = name => `[data-role="codex-tern.sessions.${name}"]`;
function lua(source) { ctl('carly lua ' + JSON.stringify(source)); ctl('carly ok'); }
function identity(label) {
  const path = join(out, label + '-identity.json');
  lua(`local p=cx.session:focused(); local tree=cx.session:surface(p,{depth=2,nodes=25});
  tern.fs.write(${JSON.stringify(path)},tern.json.encode({pane=p,info=cx.session:pane(p),surface=type(tree)=="table" and tree.surface or nil,panes=cx.session:panes()}))`);
  return JSON.parse(readFileSync(path, 'utf8'));
}
function shot(label) { result.captures[label] = ctl('shot ' + label); }
async function choose(engine, target = role('new')) {
  click(target);
  await wait(() => tree('[placeholder="Choose a session engine"]').length, 'engine picker');
  if (engine === 'omp') key('Down');
  key('Enter');
}

function installOmp() {
  writeFileSync(selectedBinary, '#!/bin/sh\nexec ' + quote(omp) + ' "$@" --model qa/fixture --no-lsp\n', { mode: 0o700 });
}

function fixtureModel() {
  const encoder = new TextEncoder();
  return Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST') return Response.json({ object: 'list', data: [{ id: 'fixture', object: 'model' }] });
    const body = await request.json();
    const user = body.messages.findLast(message => message.role === 'user');
    const prompt = JSON.stringify(user?.content);
    const toolResult = body.messages.at(-1)?.role === 'tool';
    modelRequests.push({ path: new URL(request.url).pathname, model: body.model, prompt, toolResult });
    const frame = (delta, finish_reason = null) => encoder.encode('data: ' + JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    let cancelled = false;
    const stream = new ReadableStream({
      async start(controller) {
        const enqueue = (delta, reason) => { if (!cancelled) controller.enqueue(frame(delta, reason)); };
        enqueue({ role: 'assistant' });
        if (!toolResult && prompt?.includes('OMP_CONFIRM_QA')) {
          enqueue({ tool_calls: [{ index: 0, id: 'call_read_qa', type: 'function',
            function: { name: 'write', arguments: JSON.stringify({ path: join(cwd, 'approval-output.txt'), content: 'requires consent' }) } }] });
          enqueue({}, 'tool_calls');
        } else if (prompt?.includes('OMP_ABORT_QA')) {
          enqueue({ content: 'OMP_STOP_PARTIAL' });
          for (let ticks = 0; !cancelled && ticks < 200; ticks++) await delay(50);
        } else {
          enqueue({ content: toolResult ? 'OMP_TOOL_REPLY' : 'OMP_LIVE_PARTIAL' });
          if (!toolResult) for (let ticks = 0; !releaseAnswer && !cancelled && ticks < 200; ticks++) await delay(50);
          if (!toolResult) enqueue({ content: ' OMP_PERSISTED_FINAL' });
          enqueue({}, 'stop');
        }
        if (!cancelled) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
      },
      cancel() { cancelled = true; },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  } });
}

const input = '[data-role="omp.editor"] .sf-editor';
const userText = '.sf-ed-text';
const selected = role('item') + '[data-mark="pick"]';
const row = title => role('item') + '[title=' + JSON.stringify(title) + ']';
const pin = role('pin');
const archive = role('archive');
const stop = '[data-role="omp.composer.stop"]';
const assistant = '[data-role="omp.assistant"]';
const select = async title => {
  click(row(title));
  await wait(() => tree(row(title) + '[data-mark="pick"]').length, 'selected ' + title);
};
function type(value) { click(input); ctl('type ' + JSON.stringify(value)); }
function say(value) { type(value); key('Enter'); }
function assertPane(label, original) {
  const current = identity(label);
  assert.equal(current.surface.role, 'codex-tern');
  assert.equal(current.pane, original.pane);
  assert.equal(current.info.tab, original.info.tab);
  assert.equal(current.surface.id, original.surface.id);
  assert.deepEqual(current.panes.map(p => p.pane).sort(), original.panes.map(p => p.pane).sort());
  return current;
}

try {
  assert(omp && statSync(omp).isFile(), 'Set QA_OMP_BINARY to a local stock omp executable.');
  for (const dir of [cwd, env.HOME, env.PI_CODING_AGENT_DIR, join(env.CODEX_HOME, 'thread-writer-locks'), join(out, 'bin'), env.STENCIL_FIXTURE_ROOT,
    join(fixtures, 'plugins/fixtures'), join(config, 'plugins')]) mkdirSync(dir, { recursive: true });
  await prepareTernQaConfig(config);
  writeFileSync(join(config, 'welcomed'), '');
  writeFileSync(join(cwd, 'sample.txt'), 'isolation fixture\n');
  model = fixtureModel();
  writeFileSync(join(env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { qa: {
    baseUrl: model.url.href + 'v1', api: 'openai-completions', apiKey: 'qa-loopback-placeholder',
    models: [{ id: 'fixture', name: 'Offline QA', input: ['text'], reasoning: false }],
  } } }));
  installOmp();
  const relay = `#!${bun}
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2), tern = ${JSON.stringify(tern)}, control = ${JSON.stringify(control)};
function lua(script) {
  const result = JSON.parse(execFileSync(tern, ['ctl','--control',control,'carly lua ' + JSON.stringify(script)], {encoding:'utf8'}));
  if (!result.ok) process.exit(3);
  execFileSync(tern, ['ctl','--control',control,'carly ok']);
}
const log = text => appendFileSync(${JSON.stringify(join(out, 'cli-transport.jsonl'))}, text + ${JSON.stringify('\n')});
if (argv[0] === 'inspect' && process.env.QA_RELAY_COLD === '1') {
  console.log(JSON.stringify({clients: [{kind:'cli'}]}));
} else if (argv[0] === '-e') {
  if (process.env.QA_RELAY_COLD !== '1') process.exit(2);
  const metadata = ${JSON.stringify(join(out, 'cold-pane-id.txt'))};
  lua('local id=assert(cx.layout:new_tab({cwd=' + JSON.stringify(process.cwd()) + '})); tern.fs.write('
    + JSON.stringify(metadata) + ', tostring(id))');
  const pane = readFileSync(metadata, 'utf8');
  const command = ['/usr/bin/env', 'TERN_PANE=' + pane, ...argv.slice(1)].map(${quote.toString()}).join(' ');
  const reply = JSON.parse(execFileSync(tern, ['ctl','--control',control,'run ' + JSON.stringify(command)], {encoding:'utf8'}));
  if (!reply.ok) process.exit(4);
  log('-e');
} else if (argv[0] === 'focus' && /^[0-9]+$/.test(argv[1])) {
  lua('assert(cx.session:pane(' + argv[1] + ')); cx.layout:focus(' + argv[1] + ')');
  log('focus ' + argv[1]);
} else process.stdout.write(execFileSync(tern, argv));
`;
  writeFileSync(shim, relay, { mode: 0o700 });

  const root = join(config, 'codex-tern', 'omp', createHash('sha256')
    .update(JSON.stringify([cwd, env.PI_CODING_AGENT_DIR, ''])).digest('hex'));
  const index = join(root, 'index');
  const files = join(root, 'sessions');
  mkdirSync(index, { recursive: true }); mkdirSync(files);
  const seed = spawnSync(selectedBinary, ['--mode', 'rpc', '--allow-home', '--cwd', cwd, '--session-dir', files,
    '--no-title', '--extension', join(repo, 'tern-plugin/omp-identity.ts')], {
    cwd, env, input: '{"type":"get_state","id":"seed"}\n', encoding: 'utf8', timeout: 15000,
  });
  assert.equal(seed.status, 0, seed.stderr);
  const legacy = seed.stdout.trim().split('\n').map(line => JSON.parse(line)).find(frame => frame.id === 'seed').data;
  const legacyId = legacy.sessionId;
  writeFileSync(join(index, legacyId + '.json'), JSON.stringify({ id: legacyId, file: legacy.sessionFile, cwd,
    title: 'Legacy omp', pid: 1, updatedAt: 1792558800 }));
  const entries = () => readdirSync(index).map(name => JSON.parse(readFileSync(join(index, name), 'utf8')));
  const flags = id => JSON.parse(readFileSync(join(root, 'flags', id + '.json'), 'utf8'));

  const envPlugin = join(out, 'env-plugin');
  mkdirSync(envPlugin);
  writeFileSync(join(envPlugin, 'plugin.toml'), 'schema=1\nid="ct-qa-env"\nname="CT QA env"\nversion="0.1.0"\nhost="host.luau"\n');
  writeFileSync(join(envPlugin, 'host.luau'), `local values=tern.json.decode([=[${JSON.stringify(env)}]=])
  tern.on("spawn",function(spec) for k,v in pairs(values) do spec.env[k]=v end; return spec end)`);
  for (const dir of [join(config, 'plugins'), join(fixtures, 'plugins/fixtures')]) {
    writeFileSync(join(dir, 'codex-tern.path'), join(repo, 'tern-plugin') + '\n');
    writeFileSync(join(dir, 'ct-qa-env.path'), envPlugin + '\n');
  }
  result.tern = cli(['--version']).trim();
  const daemon = start(['daemon', '--socket', socket], 'daemon');
  await wait(() => socketOwned(daemon, socket), 'private daemon');
  server = start(['serve', '--control', control, '--out', out, '--cwd', cwd], 'renderer');
  await wait(() => socketOwned(server, control), 'private renderer');
  ready = true;
  captureOwned();
  ctl('plugins fixtures'); ctl('resize 1200 840');

  const entry = [bun, join(repo, 'dist/cli.mjs')];
  // serve omits the pane shell's TERN_PANE. Supply the renderer's actual ID
  // so the CLI focus command can be observed through this test's relay.
  const startupPane = identity('before-client').pane;
  ctl('run ' + JSON.stringify(['/usr/bin/env', 'TERN_PANE=' + startupPane, ...Object.entries(env).map(([k, v]) => k + '=' + v),
    ...entry].map(quote).join(' ')));
  await wait(() => tree(row('Saved session 1')).length && tree(row('Legacy omp')).length, 'mixed rail with legacy omp');
  const codex = identity('codex-start');
  assert.equal(codex.surface.role, 'codex-tern');
  const startCount = () => readFileSync(env.QA_RPC_LOG, 'utf8').split('\n').filter(line => line.includes('"thread/start"') && !line.includes('ephemeral')).length;
  const initialStarts = startCount();
  await choose('codex', '[data-role="ct.composer.actions"] .sf-icon[title="New session"]');
  await wait(() => startCount() > initialStarts, 'Codex new session');
  await select('Saved session 1');
  say('hold Codex across engine switch');
  await wait(() => tree(stop).length, 'Codex turn is running');
  type('Unsent Codex draft');
  await wait(() => text(userText).includes('Unsent Codex draft'), 'Codex draft');

  click(role('new') + '[aria-label="New session"]');
  await wait(() => tree('[placeholder="Choose a session engine"]').length, 'engine picker');
  shot('engine-picker');
  key('Down'); key('Enter');
  await wait(() => tree(selected + '[title="New omp session"]').length, 'new omp selected', 26000);
  assertPane('omp-new', codex);
  await wait(() => text('[data-role="codex-tern.toc.note"]').includes('Session TOC is available for Codex.'), 'Codex-only TOC feedback');
  assert(tree(role('item')).every(node => node.rect[3] <= 28), 'compact mixed rows');
  assert(tree(row('New omp session') + ' button').some(node => node.tag === 'button'), 'native sidebar actions are buttons');
  const native = entries().find(item => item.id !== legacyId);
  assert(native);
  assert.equal(native.cwd, cwd);
  assert(readFileSync(native.file, 'utf8').includes(native.id));
  result.omp = { id: native.id, file: native.file, legacyId };

  say('OMP_STREAM_QA');
  await wait(() => text(assistant + ' *').includes('OMP_LIVE_PARTIAL'), 'native streaming delta');
  assert(!text(assistant + ' *').includes('OMP_PERSISTED_FINAL'));
  assert(tree(stop).length);
  shot('omp-streaming');
  releaseAnswer = true;
  await wait(() => text(assistant + ' *').includes('OMP_PERSISTED_FINAL') && !tree(stop).length, 'completed stream');
  await select('Saved session 1');
  assertPane('codex-restored', codex);
  assert(text(userText).includes('Unsent Codex draft'));
  assert(tree(stop).length);
  click(stop); await wait(() => !tree(stop).length, 'Codex turn stopped after switch');
  await select('OMP_STREAM_QA');
  assertPane('omp-return', codex);
  assert(text(assistant + ' *').includes('OMP_PERSISTED_FINAL'));
  result.checks.push('Sidebar creates both engines on the same pane, tab, surface ID and role. Codex draft and running turn survive both switches. The real omp stream rendered before its final block.');

  say('OMP_CONFIRM_QA');
  const request = '.ct-request';
  await wait(() => tree(request).length, 'real omp permission request');
  assert(!modelRequests.some(request => request.toolResult));
  assert(!existsSync(join(cwd, 'approval-output.txt')));
  assert(tree(row('OMP_STREAM_QA') + ' ' + archive + '[aria-disabled="true"]').length);
  shot('omp-confirmation');
  const choices = tree(request + ' button').map(node => node.text || node.attrs?.['aria-label']).filter(Boolean);
  assert(choices.includes('Approve') && choices.includes('Deny'));
  click(request + ' button[aria-label="Deny"]');
  await wait(() => !tree(request).length && !tree(stop).length, 'user declines or cancels native approval', 20000);
  assert(!existsSync(join(cwd, 'approval-output.txt')));
  say('OMP_ABORT_QA');
  await wait(() => text(assistant + ' *').includes('OMP_STOP_PARTIAL') && tree(stop).length, 'stream to abort');
  click(stop);
  await wait(() => !tree(stop).length, 'native abort');
  result.checks.push('Native omp requests user input before the tool continues. Archive is disabled during the request. User explicitly declined, and the Stop control interrupted a subsequent native stream.');

  const ompRow = row('OMP_STREAM_QA');
  click(row('Saved session 2') + ' ' + pin);
  await wait(() => tree(row('Saved session 2') + ' ' + pin + '[aria-pressed="true"]').length, 'Codex pin');
  click(ompRow + ' ' + pin);
  await wait(() => tree(ompRow + ' ' + pin + '[aria-pressed="true"]').length, 'omp pin');
  assert.equal(flags(native.id).pinned, true);
  click(ompRow + ' ' + pin); await wait(() => flags(native.id).pinned === false, 'omp unpin');
  click(ompRow + ' ' + pin);
  await wait(() => flags(native.id).pinned === true
    && tree(ompRow + ' ' + pin + '[aria-pressed="true"]').length, 'omp repin on disk and in the sidebar');
  const order = tree(role('label')).map(node => node.text);
  assert.deepEqual(order.slice(0, 2).sort(), ['OMP_STREAM_QA', 'Saved session 2']);
  type('Keep this omp draft');
  await wait(() => tree(ompRow + ' ' + archive + '[aria-disabled="true"]').length, 'draft blocks archive');
  key('Meta+a'); key('Backspace');
  await wait(() => tree(ompRow + ' ' + archive + '[aria-disabled="false"]').length, 'draft cleared');
  click(ompRow + ' ' + archive);
  await wait(() => !tree(ompRow).length && flags(native.id).archived, 'archived and hidden');
  assert.equal(flags(native.id).pinned, true);
  assert(existsSync(native.file));
  assertPane('after-archive', codex);
  const archivedToggle = 'button[aria-label="Archived omp sessions"]';
  click(archivedToggle);
  await wait(() => tree(role('restore')).length, 'archive drawer');
  shot('omp-archive');
  result.checks.push('omp pin/unpin sorts with Codex pins. Draft, busy and approval block archival. Archival switches in the same pane, hides the row and preserves its file and pin.');

  await select('Saved session 1');
  const baseline = entries().map(item => item.id).sort();
  unlinkSync(selectedBinary);
  await choose('omp', role('new') + '[aria-label="New session"]');
  await wait(() => text(role('note')).includes('omp was not found'), 'missing executable');
  assertPane('omp-missing', codex);
  assert(text(userText).includes('Unsent Codex draft'));
  writeFileSync(selectedBinary, '#!/bin/sh\nexit 27\n', { mode: 0o700 });
  await choose('omp', role('new') + '[aria-label="New session"]');
  await wait(() => text(role('note')).includes('omp exited (27)'), 'real startup exit');
  assertPane('omp-start-failed', codex);
  shot('omp-start-failed');
  assert.deepEqual(entries().map(item => item.id).sort(), baseline);
  installOmp();
  result.checks.push('Missing and failing omp executables preserve the original surface, Codex draft and real session index.');

  async function invoke(args, cold = false) {
    const child = spawn(bun, [...entry.slice(1), '--agent', 'omp', ...args], {
      cwd, env: { ...env, QA_RELAY_COLD: cold ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timed out')); }, 44000);
      child.once('error', reject); child.once('close', value => { clearTimeout(timer); resolve(value); });
    });
    assert.equal(code, 0, stderr);
    return stdout.trim();
  }

  assert.equal(await invoke(['--resume', legacyId]), 'omp session ID verified: ' + legacyId);
  await wait(() => tree(selected + '[title="Legacy omp"]').length, 'legacy exact ID on open host');
  assertPane('cli-legacy-resume', codex);
  const newCli = await invoke([]);
  assert.match(newCli, /^omp session ID verified: [a-z0-9-]+$/);
  await wait(() => tree(selected + '[title="New omp session"]').length, 'CLI new on open host');
  assertPane('cli-warm-new', codex);
  result.checks.push('Warm CLI --agent omp and --resume reuse the open codex-tern pane. The legacy record reopens its original native ID.');

  // Close only this private client. Relay a cold launcher invocation to the
  // separately owned renderer because Tern's launcher cannot attach to serve.
  captureOwned();
  key('Control+q');
  await wait(() => !tree(input).length, 'original host exited');
  await wait(() => !existsSync(projectSocket), 'original project endpoint closed');
  assert(socketOwned(server, control));
  assert.equal(await invoke(['--resume', legacyId], true), 'omp session ID verified: ' + legacyId);
  await wait(() => tree(input).length && tree(archivedToggle).length, 'cold host opened and archived flag persisted');
  const restarted = identity('cli-cold');
  assert.equal(restarted.surface.role, 'codex-tern');
  const relayCommands = readFileSync(join(out, 'cli-transport.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(relayCommands, ['focus ' + codex.pane, 'focus ' + codex.pane, '-e']);
  assert.equal(restarted.panes.filter(p => p.tab === restarted.info.tab).length, codex.panes.filter(p => p.tab === codex.info.tab).length);
  assert(!tree(ompRow).length);
  click(archivedToggle);
  await wait(() => tree(role('restore')).length, 'archived row on restarted runtime');
  click(role('restore'));
  await wait(() => tree(ompRow + ' ' + pin + '[aria-pressed="true"]').length && !flags(native.id).archived, 'restored pin and original ID');
  assert.equal(await invoke(['--resume', native.id]), 'omp session ID verified: ' + native.id);
  await wait(() => text(assistant + ' *').includes('OMP_PERSISTED_FINAL'), 'rehydrated original messages after restart');
  assertPane('restored-native-id', restarted);
  shot('omp-restored');
  await select('Saved session 1');
  await wait(() => text(userText).includes('Unsent Codex draft'), 'persisted Codex draft');
  click(row('Saved session 2') + ' ' + pin);
  await wait(() => tree(row('Saved session 2') + ' ' + pin + '[aria-pressed="false"]').length, 'Codex unpin');
  click(row('Saved session 2') + ' ' + archive);
  await wait(() => !tree(row('Saved session 2')).length, 'Codex archive');
  result.checks.push('A cold CLI invocation creates one normal chat pane. After reopening the runtime, omp remains archived and pinned, restores its original ID and transcript, and Codex draft recovery, pin and archive still work.');
  result.modelRequests = modelRequests.map(({ path, model, toolResult }) => ({ path, model, toolResult }));
} catch (error) {
  result.errors.push(error.stack ?? String(error));
  if (ready) try {
    shot('diagnostic');
    result.diagnostic = identity('diagnostic');
    result.tree = tree('[data-surface]');
  } catch { /* The initial error remains the primary result. */ }
} finally {
  model?.stop(true);
  captureOwned();
  if (ready) try { ctl('quit'); } catch { /* Kill only processes started by this test. */ }
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    await delay(250);
    const rows = processes();
    for (const p of [...owned.values()].reverse()) if (rows.some(row => same(p, row))) {
      try { process.kill(p.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  await delay(200);
  result.remaining = processes().filter(p => same(owned.get(p.pid), p));
  result.preExistingTernUnchanged = before.filter(p => p.command === tern).every(p => processes().some(row => same(row, p)));
  const endpoints = [control, socket, socket + '.lock', projectSocket];
  for (const path of endpoints) if (!result.remaining.length && existsSync(path)) unlinkSync(path);
  result.endpointsRemaining = endpoints.filter(existsSync);
  result.ok = !result.errors.length && !result.remaining.length && !result.endpointsRemaining.length && result.preExistingTernUnchanged;
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ out, ok: result.ok, checks: result.checks, errors: result.errors, remaining: result.remaining }));
}
if (!result.ok) process.exitCode = 1;
