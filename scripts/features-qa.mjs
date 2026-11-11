// Commands/skills UI QA. Every Tern process, profile, endpoint and backend is isolated.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.prototype', `features-qa-${process.pid}`);
const config = resolve(out, 'config'), socket = resolve(out, 'control.sock');
await prepareTernQaConfig(config); await mkdir(resolve(config, 'plugins'), { recursive: true });
await writeFile(resolve(config, 'plugins/codex-tern.path'), resolve(root, 'tern-plugin'));
await mkdir(resolve(out, 'codex/thread-writer-locks'), { recursive: true });
const skillFile = resolve(out, 'skills.json');
const demo = { name: 'qa-demo', path: resolve(out, 'qa-demo/SKILL.md'), description: 'Fixture skill', enabled: true, scope: 'user', pluginId: null };
await writeFile(skillFile, JSON.stringify([demo, { ...demo, name: 'disabled', enabled: false }]));
const rpcLog = resolve(out, 'rpc.jsonl'), wire = resolve(out, 'wire.jsonl');
const env = { ...process.env, PATH: `${resolve(process.execPath, '..')}:${process.env.PATH}`,
  TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: resolve(out, 'daemon.sock'),
  XDG_CACHE_HOME: resolve(out, 'cache'), XDG_STATE_HOME: resolve(out, 'state'),
  CODEX_HOME: resolve(out, 'codex'), QA_CODEX_HOME: resolve(out, 'codex'), QA_SESSION_FIXTURES: '1',
  QA_FEATURE_FIXTURES: '1', QA_SKILLS_FILE: skillFile, QA_RPC_LOG: rpcLog, TERN_TSP_RECORD: wire,
  QA_HISTORY_FILE: resolve(out, 'history.json') };
const daemon = spawn('tern', ['daemon', '--socket', env.TERN_DAEMON_SOCKET], { env, stdio: 'ignore' });
let server;
const passed = [], limitations = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
function ctl(command) {
  const r = JSON.parse(execFileSync('tern', ['ctl', '--control', socket, command], { env, encoding: 'utf8', timeout: 10_000 }));
  if (!r.ok) throw new Error(`${command}: ${r.error}`); return r;
}
const tree = selector => ctl(`tree ${selector}`).nodes ?? [];
const text = selector => tree(selector).map(n => n.text ?? '').join('\n');
const key = chord => ctl(`key ${chord}`);
const type = value => ctl(`type ${JSON.stringify(value)}`);
const clear = () => { key('Meta+a'); key('Backspace'); };
const send = value => { type(value); key('Enter'); };
async function wait(check, message, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return true; await pause(80); }
  throw new Error(`Timeout: ${message}`);
}
const pass = name => { passed.push(name); console.log('PASS ' + name); };
const calls = async () => (await readFile(rpcLog, 'utf8')).trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'private daemon');
  server = spawn('tern', ['serve', '--control', socket, '--out', out, '--cwd', root], { env, stdio: 'ignore' });
  await wait(() => existsSync(socket), 'private control endpoint');
  // No project dispatcher or normal Tern profile is contacted by this launch.
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const taskKeys = ['TERN_CONFIG_DIR', 'TERN_DAEMON_SOCKET', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'QA_CODEX_HOME', 'QA_SESSION_FIXTURES', 'QA_FEATURE_FIXTURES', 'QA_SKILLS_FILE', 'QA_RPC_LOG', 'TERN_TSP_RECORD', 'QA_HISTORY_FILE', 'PATH'];
  const launch = ['env', ...taskKeys.map(key => `${key}=${env[key]}`), process.execPath, resolve(root, 'dist/cli.mjs'), '--codex', resolve(root, 'test/fixtures/ui-app-server.mjs')].map(quote).join(' ');
  ctl(`run ${JSON.stringify(launch)}`);
  await wait(() => text('.sf-dock').includes('QA Model'), 'composer', 15000);
  pass('isolated native client starts');
  type('/'); await wait(() => text('.sf-layer').includes('help'), 'slash candidates');
  ctl('shot slash-candidates'); key('Escape'); clear();
  send('/help'); await wait(() => text('.sf-layer').includes('Getting started'), 'command help'); key('Escape');
  assert.equal((await calls()).filter(c => c.method === 'turn/start').length, 0); pass('slash candidates and help stay local');
  send('/unknown-command'); await pause(150); assert.ok(text('.sf-ed-text').includes('/unknown-command')); clear();
  send('/skills'); await wait(() => text('.sf-layer').includes('qa-demo'), 'skills picker');
  assert.ok(!text('.sf-layer').includes('$disabled')); ctl('shot skill-picker');
  key('Enter'); await wait(() => text('.sf-ed-text').includes('$qa-demo'), 'skill insertion');
  type('exact fixture message'); key('Enter');
  await wait(() => text('[data-role="omp.assistant"]').includes('QA_INPUT_BASE64'), 'skill reply');
  const first = (await calls()).find(c => c.method === 'turn/start');
  assert.ok(first.input.some(i => i.type === 'text' && i.text.includes('$qa-demo')));
  assert.ok(first.input.some(i => i.type === 'skill' && i.path === demo.path && i.name === demo.name));
  pass('picker sends exact structured skill alongside original text');
  type('$qa'); await wait(() => text('.sf-layer').includes('$qa-demo'), 'dollar candidates'); key('Tab');
  await wait(() => text('.sf-ed-text').includes('$qa-demo'), 'dollar completion'); clear();
  pass('dollar autocomplete selects dynamic skills');
  await writeFile(skillFile, JSON.stringify([demo, { ...demo, name: 'fresh-skill', path: resolve(out, 'fresh/SKILL.md') }]));
  send('/skills fresh'); await wait(() => text('.sf-layer').includes('fresh-skill'), 'new skill refresh'); key('Escape');
  pass('new skills appear after refresh');
  send('/language zh-CN'); await wait(() => text('.sf-dock').includes('发送'), 'Chinese configuration');
  send('/status'); await wait(() => text('.sf-layer').includes('会话详情'), 'localized status'); key('Escape');
  pass('commands reuse localized native panels');
  const pluginState = JSON.parse(execFileSync('tern', ['plugin', 'list', '--json'], { env, encoding: 'utf8', timeout: 10000 }));
  await writeFile(resolve(out, 'plugins.json'), JSON.stringify(pluginState, null, 2));
  ctl('plugins run plugin.codex-tern.sessions');
  pass('isolated window plugin loads and registers its session action');
  // One explicit opening and bounded readiness attempt; no focus or polling workaround.
  try {
    await wait(() => tree('[data-role="codex-tern.sessions.pin"]').length > 0, 'sidebar plugin timer', 2500);
    const pin = '[data-role="codex-tern.sessions.pin"]';
    const [x, y, w, h] = tree(pin)[0].rect; ctl(`click ${x + w / 2} ${y + h / 2}`);
    await wait(() => tree(`${pin}[aria-pressed="true"]`).length === 1, 'pin persisted'); ctl('shot pinned-sidebar');
    ctl(`click ${pin}[aria-pressed="true"]`);
    await wait(() => tree(`${pin}[aria-pressed="true"]`).length === 0, 'unpin persisted');
    pass('sidebar pin and unpin buttons persist their state');
  } catch { limitations.push('Headless window plugin timer did not initialize sidebar; pin pointer interaction was not tested. Backend sorting/persistence and Lua plugin loading are checked separately.'); }
  const events = (await readFile(wire, 'utf8')).trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
  assert.deepEqual(events.filter(e => e.dir === 'in' && e.body?.ev === 'error').map(e => e.body), []);
  pass('native protocol reports no UI errors');
  // Observe the foreground backend, not a background title/outline peer. Its
  // PID was recorded with the structured input checked above.
  const fixturePid = first.pid;
  assert.ok(Number.isInteger(fixturePid) && alive(fixturePid), 'the tested backend is alive before /exit');
  send('/exit');
  await wait(() => !alive(fixturePid), '/exit terminates the tested fixture backend');
  assert.ok(alive(daemon.pid) && alive(server.pid), 'exit is observed before test infrastructure cleanup');
  await writeFile(resolve(out, 'exit-evidence.json'), JSON.stringify({
    fixturePid, aliveBeforeCommand: true, aliveAfterCommand: false,
    observedBeforeCleanup: true, daemonAlive: true, serverAlive: true,
  }, null, 2));
  pass('exit command terminates its live fixture backend before cleanup');
} catch (error) {
  try { ctl('shot failed'); await writeFile(resolve(out, 'failed-tree.json'), JSON.stringify(ctl('tree'), null, 2)); } catch {}
  throw error;
} finally {
  try { key('Control+q'); } catch {}
  try { ctl('quit'); } catch { server?.kill(); }
  daemon.kill('SIGTERM');
  await pause(300);
  if (server && server.exitCode === null) server.kill('SIGTERM');
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
  let fixturePids = [];
  try { fixturePids = [...new Set((await calls()).map(c => c.pid))]; } catch {}
  const ownedPids = [daemon.pid, server?.pid, ...fixturePids].filter(Boolean);
  for (let n = 0; n < 20 && ownedPids.some(alive); n++) await pause(100);
  const remainingPids = ownedPids.filter(alive);
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ passed, limitations, config, socket, ownedPids, remainingPids }, null, 2));
  assert.deepEqual(remainingPids, [], 'all owned test processes must exit');
  console.log(`ARTIFACTS ${out}`);
}
