// Run with Bun after building. The fixture never calls a model.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareTernQaConfig } from './qa-tern-config.mjs';

const root = resolve(import.meta.dirname, '..');
const out = mkdtempSync('/private/tmp/ct-reasoning-');
const cwd = join(out, 'workspace'), config = join(out, 'config');
const control = join(out, 'control.sock'), daemonSocket = join(out, 'daemon.sock');
const tern = process.env.QA_TERN_BINARY || '/Applications/Tern.app/Contents/MacOS/tern';
const env = {
  HOME: join(out, 'home'), ZDOTDIR: join(out, 'home'), SHELL: '/bin/bash',
  PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`, LANG: 'en_US.UTF-8',
  TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: daemonSocket, CODEX_TERN_CONTROL: control,
  XDG_CACHE_HOME: join(out, 'cache'), XDG_STATE_HOME: join(out, 'state'), STENCIL_LOG_DIR: join(out, 'logs'),
  CODEX_TERN_WEIXIN_DISABLE: '1', CODEX_HOME: join(out, 'codex'), QA_CODEX_HOME: join(out, 'codex'),
  QA_HISTORY_FILE: join(out, 'history.json'), QA_RPC_LOG: join(out, 'rpc.jsonl'), QA_REASONING_GATES: out,
};
const result = { checks: [], screenshots: [], remaining: [], endpointsRemaining: [] };
const children = [];
const run = (file, args) => execFileSync(file, args, { cwd, env, encoding: 'utf8', timeout: 6000, maxBuffer: 8 * 1024 * 1024 });
const processes = () => run('/bin/ps', ['-axo', 'pid=,ppid=,lstart=']).trim().split('\n').map(line => {
  const [, pid, parent, start] = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  return { pid: Number(pid), parent: Number(parent), start };
});
const owned = new Map();
function captureOwned() {
  const all = processes();
  const ids = new Set(all.filter(p => children.some(child => child.pid === p.pid && child.exitCode === null && child.signalCode === null)
    || owned.get(p.pid)?.start === p.start).map(p => p.pid));
  for (let previous = -1; previous !== ids.size;) {
    previous = ids.size;
    for (const p of all) if (ids.has(p.parent)) ids.add(p.pid);
  }
  for (const p of all) if (ids.has(p.pid)) owned.set(p.pid, p);
}
const stillOwned = () => processes().filter(p => owned.get(p.pid)?.start === p.start);
function socketOwned(child, path) {
  try {
    return child.exitCode === null && child.signalCode === null && statSync(path).isSocket()
      && run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-U', '-Fn'])
        .split('\n').some(line => line === 'n' + path || line.startsWith('n' + path + ' '));
  } catch { return false; }
}
function start(args, name) {
  const fd = openSync(join(out, name + '.log'), 'w');
  const child = spawn(tern, args, { cwd, env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  children.push(child);
  child.on('error', error => { result.error = String(error); });
  return child;
}
let server;
function ctl(command) {
  assert.ok(server && socketOwned(server, control), 'only use the owned offscreen control socket');
  const reply = JSON.parse(run(tern, ['ctl', '--control', control, command]));
  assert.ok(reply.ok, `${command} · ${reply.error}`);
  return reply;
}
const role = name => `[data-role="${name}"]`;
const tree = selector => ctl(`tree ${selector}`).nodes ?? [];
const text = (selector = '.sf-main') => tree(selector).map(n => n.text ?? '').join('\n');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const live = role('omp.thinking.live'), done = role('omp.thinking');
const final = role('omp.assistant');
const report = label => { result.checks.push(label); console.log('PASS ' + label); };
const send = value => { ctl('type ' + JSON.stringify(value)); ctl('key Enter'); };
async function wait(check, label) {
  for (let n = 0; n < 95 && !result.error; n++) {
    if (check()) return;
    await delay(100);
  }
  throw Error(result.error ?? 'Timed out waiting for ' + label);
}
function record(name, selector) {
  const bounds = tree(selector);
  writeFileSync(join(out, name + '-tree.json'), JSON.stringify(bounds, null, 2));
  result.screenshots.push(ctl('shot ' + name));
}
function verifySummary(selector, width) {
  const head = tree(selector + ' > .sf-section-head')[0];
  const body = tree(selector + ' > .sf-section-body')[0];
  const paragraphs = tree(selector + ' .md p').filter(n => /核对待清理|确认配置路径|Checking native/.test(n.text));
  assert.equal(paragraphs.length, 3);
  assert.deepEqual(tree(selector + ' .md h3').map(n => n.text), ['下一步 / Next steps']);
  assert.equal(tree(selector + ' .md li').length, 2);
  assert.equal(tree(selector + ' .md li code')[0]?.text, 'fixture');
  const [hx, hy, , hh] = head.rect;
  const [bx, by, bw] = body.rect;
  assert.ok(Math.abs(hx - bx) <= 1 && by >= hy + hh + 3 && bx + bw <= width);
  let bottom = by;
  for (const { rect: [x, y, w, h] } of paragraphs) {
    assert.ok(x >= bx + 12 && x + w <= width && y >= bottom && h > 0);
    if (bottom !== by) assert.ok(y - bottom >= 7 && y - bottom <= 10, 'compact, consistent paragraph spacing');
    bottom = y + h;
  }
  assert.doesNotMatch(text(), /QA_PRIVATE_REASONING|QA_PRIVATE_EMPTY/);
  return paragraphs;
}

for (const path of [cwd, env.HOME, join(env.CODEX_HOME, 'thread-writer-locks'), join(config, 'plugins')])
  mkdirSync(path, { recursive: true });
await prepareTernQaConfig(config);
writeFileSync(join(config, 'welcomed'), '');
writeFileSync(join(config, 'plugins/codex-tern.path'), join(root, 'tern-plugin') + '\n');
const launch = args => ctl('run ' + JSON.stringify(['/usr/bin/env', ...Object.entries(env).map(([k, v]) => k + '=' + v),
  process.execPath, join(root, 'bin/codex-tern'), '--native', '--codex', join(root, 'test/fixtures/ui-app-server.mjs'), ...args].map(quote).join(' ')));
const calls = () => readFileSync(env.QA_RPC_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));

try {
  console.log('ARTIFACTS ' + out);
  const daemon = start(['daemon', '--socket', daemonSocket], 'daemon');
  await wait(() => socketOwned(daemon, daemonSocket), 'private daemon');
  server = start(['serve', '--control', control, '--out', out, '--cwd', cwd], 'renderer');
  await wait(() => socketOwned(server, control), 'private offscreen renderer');
  ctl('resize 1000 800');
  ctl('appearance dark');
  launch([]);
  await wait(() => text('.sf-dock').includes('QA Model'), 'fixed app-server owner');
  send('/language zh-CN');
  await wait(() => text('.sf-dock').includes('上下文'), 'Chinese interface');
  send('QA_REASONING_FIXTURE');
  await wait(() => tree('.ct-activity-toggle').length === 1, 'pending activity');
  ctl('click .ct-activity-toggle');
  await wait(() => text(live).includes('正在思考'), 'pending summary');
  captureOwned();
  assert.equal(tree(live + ' .sf-md').length, 0);
  record('pending-dark', live);
  writeFileSync(join(out, 'stream'), '');
  await wait(() => tree(live + ' .md li code')[0]?.text === 'fixture', 'multi-index public summary deltas');
  const wide = verifySummary(live, 1000);
  record('streaming-dark', live + ', ' + live + ' .md > *');
  report('Pending header and streamed Chinese/English Markdown with three paragraphs, heading, list and inline code');

  writeFileSync(join(out, 'finish'), '');
  await wait(() => text(final).includes('QA_REASONING_FINAL') && tree(live).length === 0, 'finished turn');
  assert.equal(tree(done).length, 0, 'preserve existing collapsed activity');
  ctl('click .ct-activity-toggle');
  await wait(() => tree(done).length === 1, 'completed public summary, empty summary omitted');
  assert.match(text(done + ' > .sf-section-head'), /思考摘要/);
  verifySummary(done, 1000);
  assert.equal(tree(final + ' .sf-section-body').length, 0);
  record('completed-dark', done + ', ' + done + ' .md > *, ' + final);
  ctl('appearance light');
  ctl('resize 670 800');
  const narrow = verifySummary(done, 670);
  assert.ok(narrow[1].rect[3] >= wide[1].rect[3], 'mixed paragraph fits at narrower width');
  record('completed-light', done + ', ' + done + ' .md > *, ' + final);
  report('Completed summary uses its own layout in dark and light, keeps the existing fold and omits the empty item');

  const history = JSON.parse(readFileSync(env.QA_HISTORY_FILE, 'utf8'));
  const thread = history.threads.find(t => t.turns.some(turn => turn.items.some(item => item.id === 'public-reasoning')));
  assert.ok(thread);
  const backendPids = new Set(calls().map(call => call.pid));
  ctl('key Control+q');
  await wait(() => !processes().some(p => backendPids.has(p.pid)), 'first owner closed');
  ctl('quit');
  await wait(() => server.exitCode !== null || server.signalCode !== null, 'first renderer closed');
  if (existsSync(control) && statSync(control).isSocket()) unlinkSync(control);
  server = start(['serve', '--control', control, '--out', out, '--cwd', cwd], 'history-renderer');
  await wait(() => socketOwned(server, control), 'fresh private history renderer');
  ctl('resize 670 800');
  ctl('appearance light');
  launch(['--resume', thread.id]);
  await wait(() => text(final).includes('QA_REASONING_FINAL'), 'history replay');
  assert.equal(tree(done).length, 0);
  ctl('click .ct-activity-toggle');
  await wait(() => tree(done).length === 1, 'history summary visible after expanding');
  verifySummary(done, 670);
  assert.equal(calls().filter(call => call.method === 'turn/start').length, 1);
  assert.ok(calls().some(call => call.method === 'thread/resume' && call.threadId === thread.id));
  assert.ok(calls().some(call => call.method === 'thread/turns/list' && call.threadId === thread.id));
  record('history-light', done + ', ' + done + ' .md > *, ' + final);
  report('Fresh native owner resumes the same history through app-server with unchanged summary and final reply');
} catch (error) {
  result.error = error.stack;
  if (server && socketOwned(server, control)) {
    try { record('failure', '.sf-main'); } catch { /* Keep the original failure. */ }
  }
} finally {
  try { captureOwned(); } catch (error) { result.error ??= String(error); }
  if (server && socketOwned(server, control)) {
    try { ctl('quit'); } catch { /* Owned processes are also cleaned up below. */ }
  }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const { pid } of stillOwned().reverse()) {
      try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await delay(250);
  }
  result.remaining = stillOwned();
  if (!result.remaining.length) for (const path of [control, daemonSocket]) {
    if (existsSync(path) && statSync(path).isSocket()) unlinkSync(path);
  }
  result.endpointsRemaining = [control, daemonSocket].filter(existsSync);
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
}
assert.deepEqual(result.remaining, []);
assert.deepEqual(result.endpointsRemaining, []);
if (result.error) throw Error(result.error);
