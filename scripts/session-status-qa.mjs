// Offscreen-only native QA. No default Tern daemon, profile or control socket is used.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.prototype/status-lights', `native-${process.pid}`);
const config = resolve(out, 'config'), control = resolve(out, 'control.sock'), wire = resolve(out, 'wire.jsonl');
await prepareTernQaConfig(config); await mkdir(resolve(config, 'plugins'), { recursive: true });
await writeFile(resolve(config, 'plugins/codex-tern.path'), resolve(root, 'tern-plugin'));
await mkdir(resolve(out, 'codex/thread-writer-locks'), { recursive: true });
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: resolve(out, 'daemon.sock'),
  CODEX_TERN_CONTROL: control,
  CODEX_TERN_WEIXIN_DISABLE: '1', WB_DATA_DIR: resolve(out, 'workbench'),
  XDG_CACHE_HOME: resolve(out, 'cache'), XDG_STATE_HOME: resolve(out, 'state'),
  CODEX_HOME: resolve(out, 'codex'), QA_CODEX_HOME: resolve(out, 'codex'),
  QA_SESSION_FIXTURES: '1', QA_RPC_LOG: resolve(out, 'rpc.jsonl'), TERN_TSP_RECORD: wire,
  QA_HISTORY_FILE: resolve(out, 'history.json') };
delete env.TERN_WINDOW_KEY; delete env.TERN_WINDOW_SOCKET;
const fd = openSync(resolve(out, 'tern.log'), 'w');
const daemon = spawn('tern', ['daemon', '--socket', env.TERN_DAEMON_SOCKET], { env, stdio: ['ignore', fd, fd] });
let server;
const passed = [], limitations = [], screenshots = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
function ctl(command) {
  const reply = JSON.parse(execFileSync('tern', ['ctl', '--control', control, command], { env, encoding: 'utf8', timeout: 5000 }));
  if (!reply.ok) throw Error(`${command}: ${reply.error}`); return reply;
}
const tree = selector => ctl(`tree ${selector}`).nodes ?? [];
const text = selector => tree(selector).map(n => n.text ?? '').join('\n');
async function wait(check, label, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await check()) return; await pause(100); }
  throw Error(`Timeout: ${label}`);
}
const pass = name => { passed.push(name); console.log(`PASS ${name}`); };
async function snapshot() {
  let latest;
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.title === 'string' && value.title.startsWith('{"version":1,')) latest = JSON.parse(value.title);
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  }
  for (const line of (await readFile(wire, 'utf8')).trim().split('\n')) { try { visit(JSON.parse(line)); } catch {} }
  assert.ok(latest, 'client publishes its own session snapshot'); return latest;
}
const current = async () => { const s = await snapshot(); return s.rows.find(r => r.id === s.current); };
const send = value => { ctl(`type ${JSON.stringify(value)}`); ctl('key Enter'); };
const shot = name => { screenshots.push(ctl(`shot ${name}`)); };
try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'private daemon');
  server = spawn('tern', ['serve', '--control', control, '--out', out, '--cwd', root], { env, stdio: ['ignore', fd, fd] });
  await wait(() => existsSync(control), 'private offscreen renderer');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const keys = ['PATH', 'TERN_CONFIG_DIR', 'TERN_DAEMON_SOCKET', 'CODEX_TERN_CONTROL', 'CODEX_TERN_WEIXIN_DISABLE', 'WB_DATA_DIR', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'QA_CODEX_HOME', 'QA_SESSION_FIXTURES', 'QA_RPC_LOG', 'TERN_TSP_RECORD', 'QA_HISTORY_FILE'];
  ctl('run ' + JSON.stringify(['env', ...keys.map(k => `${k}=${env[k]}`), process.execPath, resolve(root, 'dist/cli.mjs'), '--codex', resolve(root, 'test/fixtures/ui-app-server.mjs')].map(quote).join(' ')));
  await wait(() => text('.sf-dock').includes('QA Model'), 'native client');
  pass('native client uses private profile, daemon, control endpoint and fixed backend');
  // One bounded readiness attempt. Do not open a normal window or force plugin timers.
  ctl('plugins run plugin.codex-tern.sessions');
  try { await wait(() => tree('[data-role="codex-tern.sessions.item"]').length > 0, 'sidebar initialization', 2500); }
  catch { limitations.push('This Tern offscreen runner does not initialize the window-plugin sidebar timer; sidebar pointer interactions and integrated light appearance were not tested.'); }
  send('background');
  await wait(async () => (await current())?.running, 'working state');
  shot('working');
  await wait(async () => (await current())?.completed, 'completion');
  await pause(900); assert.equal((await current()).completed, true, 'no new interaction');
  assert.ok(text('[data-role="ct.turn.result"]').includes('Task complete'));
  shot('complete-unread'); pass('actual terminal completion stays unread while the selected result is shown without new interaction');
  ctl('key ArrowRight');
  await wait(async () => !(await current())?.completed, 'read result');
  pass('new key input plus native result geometry clears completion');
  send('QA_STATUS_FAIL'); await wait(async () => (await current())?.failed, 'failure');
  await pause(700); assert.equal((await current()).failed, true); shot('failure-unread');
  ctl('key ArrowRight'); await wait(async () => !(await current())?.failed, 'read failure');
  pass('a new failed turn prompts again and clears only after reading');
  send('approval'); await wait(async () => (await current())?.waiting, 'approval');
  ctl('key ArrowRight'); await pause(500); assert.equal((await current()).waiting, true);
  shot('waiting-approval'); pass('reading old messages does not clear pending approval');
  ctl('key Control+c'); await wait(async () => !(await current())?.running, 'stop fixture turn');
  ctl('reduce-motion on'); ctl('appearance dark'); shot('dark-reduced-motion');
  ctl('resize 600 700'); shot('narrow');
  const events = (await readFile(wire, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(e => e.dir === 'in' && e.body?.ev === 'error').map(e => e.body), []);
  pass('native protocol reports no UI errors');

} catch (error) {
  try { shot('failed'); await writeFile(resolve(out, 'failed-tree.json'), JSON.stringify(ctl('tree'), null, 2)); } catch {}
  limitations.push(error.message); throw error;
} finally {
  try { ctl('key Control+q'); } catch {}
  try { ctl('quit'); } catch { server?.kill('SIGTERM'); }
  daemon.kill('SIGTERM'); closeSync(fd);
  let fixturePids = [];
  try { fixturePids = [...new Set((await readFile(env.QA_RPC_LOG, 'utf8')).trim().split('\n').map(line => JSON.parse(line).pid))]; } catch {}
  const ownedPids = [daemon.pid, server?.pid, ...fixturePids].filter(Boolean);
  for (let i = 0; i < 20 && ownedPids.some(alive); i++) await pause(100);
  for (const pid of ownedPids.filter(alive)) process.kill(pid, 'SIGTERM');
  await pause(200);
  const remainingPids = ownedPids.filter(alive);
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ passed, limitations, screenshots, config, control, ownedPids, remainingPids }, null, 2));
  console.log(`ARTIFACTS ${out}`); assert.deepEqual(remainingPids, [], 'test processes exit');
}
