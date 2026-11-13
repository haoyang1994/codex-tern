import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IpcServer, type IpcConnection } from '@oh-my-pi/pi-natives';
import { NATIVE_ABI_VERSION } from '../src/native-abi';
import { contactProject, projectAddress, projectSignature, serveProject, type ProjectInstance } from '../src/project-instance';

const command = { version: 1 as const, signature: projectSignature('test-codex', []) };
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-tern-project-'));
  const address = await projectAddress(dir, dir);
  const owners: ProjectInstance[] = [];
  t.after(async () => { for (const owner of owners) await owner.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, address, owners };
}

test('concurrent project launches have one owner and deliver each command once', async t => {
  const { address, owners } = await fixture(t);
  const received: string[] = [];
  const starts = await Promise.all(Array.from({ length: 5 }, (_, n) => serveProject(address,
    { ...command, prompt: String(n) }, async request => { received.push(request.prompt!); })));
  owners.push(...starts.filter((owner): owner is ProjectInstance => owner !== null));
  assert.equal(owners.length, 1);
  assert.equal(received.length, 4); assert.equal(new Set(received).size, 4);
  await contactProject(address, { ...command, prompt: 'next' });
  assert.equal(received.at(-1), 'next');
});

test('project aliases share an instance; independent folders and profiles do not', async t => {
  const { dir, address } = await fixture(t);
  const alias = dir + '-alias'; await symlink(dir, alias); t.after(() => rm(alias));
  assert.equal(await projectAddress(alias, dir), address);
  assert.notEqual(await projectAddress(dir, dir + '-other-profile'), address);
});

test('project navigation forwards a fork prompt and rejects anchors for a different session', async t => {
  const { address, owners } = await fixture(t);
  const received: unknown[] = [];
  const owner = await serveProject(address, command, async request => { received.push(request.promptAnchor); });
  assert.ok(owner); owners.push(owner);
  const anchor = { threadId: 'fork', turnId: 'turn', itemId: 'prompt' };
  assert.equal(await contactProject(address, { ...command, resume: 'fork', promptAnchor: anchor }), true);
  assert.deepEqual(received, [anchor]);
  await assert.rejects(contactProject(address, { ...command, resume: 'other', promptAnchor: anchor }));
  assert.equal(received.length, 1);
});

test('subfolders in one repository share a project instance', async t => {
  const { dir } = await fixture(t);
  await mkdir(join(dir, '.git')); await mkdir(join(dir, 'src'));
  assert.equal(await projectAddress(join(dir, 'src'), dir), await projectAddress(dir, dir));
});

test('stale socket recovery and changed settings never create a second active owner', async t => {
  const { address, owners } = await fixture(t);
  const stale = spawn(process.execPath, ['-e', 'import {createServer} from "node:net"; createServer().listen(process.env.QA_SOCKET,()=>console.log("ready"))'],
    { env: { ...process.env, QA_SOCKET: address }, stdio: ['ignore', 'pipe', 'pipe'] });
  await once(stale.stdout, 'data');
  stale.kill('SIGKILL'); await once(stale, 'exit');
  let calls = 0;
  const owner = await serveProject(address, command, async () => { calls++; });
  assert.ok(owner); owners.push(owner);
  await assert.rejects(contactProject(address, { ...command, signature: 'different' }), /different settings/);
  assert.equal(calls, 0);
  assert.equal(await contactProject(address, command), true); assert.equal(calls, 1);
});


test('project reuse signature follows stable host/UI ABI rather than build contents', () => {
  const signature = projectSignature('/test/codex', ['approval_policy="on-request"']);
  assert.equal(signature, projectSignature('/test/codex', ['approval_policy="on-request"']));
  assert.deepEqual(JSON.parse(signature), ['/test/codex', ['approval_policy="on-request"'], { nativeAbi: NATIVE_ABI_VERSION }]);
  assert.notEqual(signature, JSON.stringify(['/test/codex', ['approval_policy="on-request"']]));
  assert.notEqual(signature, JSON.stringify(['/test/codex', ['approval_policy="on-request"'], { nativeAbi: 6 }]));
});

test('new owner rejects undeclared/old ABI before handling prompt or resume, while compatible reuse stays exact-once', async t => {
  const { address, owners } = await fixture(t);
  const signature = projectSignature('/test/codex', []);
  const received: any[] = [];
  const owner = await serveProject(address, { version: 1, signature }, async request => { received.push(request); });
  assert.ok(owner); owners.push(owner);
  for (const rejected of [JSON.stringify(['/test/codex', []]), JSON.stringify(['/test/codex', [], { nativeAbi: 6 }])]) {
    await assert.rejects(contactProject(address, { version: 1, signature: rejected, resume: 'original-thread', prompt: 'DO_NOT_SEND' }), /Ctrl\+Q.*resume THREAD_ID.*no prompt was sent/s);
    assert.equal(received.length, 0, 'no focus/resume/new-thread/submit handler before compatibility check');
    await assert.rejects(serveProject(address, { version: 1, signature: rejected, prompt: 'RACE_DO_NOT_SEND' }, async () => { throw Error('second owner must not start'); }), /incompatible host\/UI ABI/);
    assert.equal(received.length, 0, 'the EADDRINUSE race also rejects before handling');
  }
  const resume = { version: 1 as const, signature, resume: 'original-thread' };
  assert.equal(await contactProject(address, resume), true);
  assert.deepEqual(received, [resume], 'same persistent thread, without manufacturing a new prompt');
  const prompt = { version: 1 as const, signature, prompt: 'ONE_COMPATIBLE_INPUT' };
  assert.equal(await contactProject(address, prompt), true);
  assert.deepEqual(received, [resume, prompt], 'compatible same-config owner still handles once');
});

test('built global CLI cannot silently reuse a legacy owner or submit its prompt', async t => {
  const { dir, owners } = await fixture(t);
  const config = join(dir, 'profile'), codexHome = join(dir, 'codex');
  const env: NodeJS.ProcessEnv = { ...process.env, TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: join(dir, 'private-daemon.sock'), CODEX_HOME: codexHome,
    XDG_STATE_HOME: join(dir, 'state'), XDG_CACHE_HOME: join(dir, 'cache'), WB_DATA_DIR: join(dir, 'workbench'), CODEX_TERN_WEIXIN_DISABLE: '1' };
  delete env.TERN_WINDOW_SOCKET; delete env.TERN_WINDOW_KEY;
  // projectAddress's explicit namespace uses the same daemon/profile identity as the CLI.
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  let address: string;
  try { address = await projectAddress(dir, env.TERN_DAEMON_SOCKET); }
  finally { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; }
  const backend = resolve(import.meta.dirname, 'fixtures/ui-app-server.mjs');
  const legacySignature = JSON.stringify([backend, []]);
  let handled = 0, rejected = 0;
  const connections = new Set<IpcConnection>();
  const legacy = await IpcServer.listen(address, { framing: 'lines', maxFrameBytes: 1024 * 1024 }, connection => {
    connections.add(connection); let accepted = false;
    connection.start(line => {
      if (accepted) return; accepted = true;
      const request = JSON.parse(line);
      // Exact pre-fix owner rule: signature validation precedes its business handler.
      if (request.version !== 1 || request.signature !== legacySignature) {
        rejected++; connection.send(JSON.stringify({ ok: false, error: 'This project is already open with different settings. Exit its client before changing the backend settings.' }));
      } else { handled++; connection.send(JSON.stringify({ ok: true })); }
      connection.end();
    }, () => { connections.delete(connection); });
  });
  owners.push({ close: async () => { await legacy.close(); for (const connection of connections) connection.destroy(); } });
  const entry = resolve(process.env.HOME!, '.local/bin/codex-tern');
  const child = spawn(process.execPath, [entry, '--native', '-C', dir, '--codex', backend, '--resume', 'original-thread', 'DO_NOT_SEND_TO_CODEX'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 10000);
  const [exitCode] = await once(child, 'exit'); clearTimeout(timeout);
  assert.equal(exitCode, 1); assert.equal(handled, 0); assert.equal(rejected, 1);
  assert.match(stderr, /incompatible host\/UI ABI/); assert.match(stderr, /Ctrl\+Q/); assert.match(stderr, /resume THREAD_ID/);
  assert.match(stderr, /no prompt was sent to Codex/);
  const evidence = { entry, abi: NATIVE_ABI_VERSION, exitCode, legacyRejected: rejected, businessHandleCalls: handled, stdout, stderr,
    childExited: child.exitCode !== null, dailyWindowOperated: false, note: 'Private IPC only; legacy owner remains live until normal test cleanup; no backend/UI was started.' };
  const out = resolve(import.meta.dirname, '../.prototype/project-abi'); await mkdir(out, { recursive: true });
  await writeFile(join(out, 'global-cli-legacy-rejection.json'), JSON.stringify(evidence, null, 2)+'\n');
});
