// Explicit offscreen-only integration test. Quiet wall-clock intervals contain NO ctl calls.
// Headless frame inspection is deliberately not treated as native realtime presentation.
import {spawn, execFileSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, closeSync, statSync, unlinkSync, cpSync} from 'node:fs';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {prepareTernQaConfig} from './qa-tern-config.mjs';

const repo = resolve(import.meta.dirname, '..');
const out = `/private/tmp/ct-sidebar-host-${Date.now()}-${process.pid}`;
const config = out + '/config', control = out + '/control.sock', socket = out + '/daemon.sock';
const tern = '/Applications/Tern.app/Contents/MacOS/tern';
const fixture = out + '/fixtures/crates/tern';
const env = {PATH: '/Users/yanghao/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8',
  TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: socket, STENCIL_LOG_DIR: out + '/logs',
  XDG_CACHE_HOME: out + '/cache', XDG_STATE_HOME: out + '/state',
  ZDOTDIR: out + '/quiet-zsh', SHELL: out + '/quiet-shell',
  STENCIL_FIXTURE_ROOT: fixture, STENCIL_LOG: 'warn,tern::plugin=debug', CT_SESSION_LIGHT_TRACE: '1', CODEX_TERN_WEIXIN_DISABLE: '1', CODEX_TERN_CONTROL: control,
  CODEX_HOME: out + '/codex', QA_CODEX_HOME: out + '/codex', QA_SESSION_FIXTURES: '1',
  QA_HISTORY_FILE: out + '/history.json', QA_RPC_LOG: out + '/rpc.jsonl', QA_EMPTY_SESSION_CWD: out + '/cwd',
  TERN_TSP_RECORD: out + '/wire.jsonl', WB_DATA_DIR: out + '/workbench'};
for (const k of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', '__CF_USER_TEXT_ENCODING'])
  if (process.env[k]) env[k] = process.env[k];
mkdirSync(out, {recursive: false, mode: 0o700});
mkdirSync(out + '/codex/thread-writer-locks', {recursive: true});
await prepareTernQaConfig(config);
for (const d of [config + '/plugins', fixture, out + '/fixtures/crates/plugins/fixtures', out + '/cwd', env.ZDOTDIR])
  mkdirSync(d, {recursive: true});
for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) writeFileSync(env.ZDOTDIR + '/' + f, '');
const plugin = resolve(repo, 'tern-plugin');
for (const d of [config + '/plugins', out + '/fixtures/crates/plugins/fixtures'])
  writeFileSync(d + '/codex-tern.path', plugin + '\n');
writeFileSync(out + '/quiet-shell', '#!/bin/sh\nexec /bin/zsh -f "$@"\n', {mode: 0o700});
writeFileSync(config + '/settings.json', JSON.stringify({shell: out + '/quiet-shell'}));
const evidence = {out, config, control, daemonSocket: socket, plugin, version: '',
  passed: [], quiet: [], commands: [], phases: [], errors: [],
  limitations: ['No visible native window: foreground application with an unfocused light block is unverified.',
    'serve uses a simulated document clock. Only host monotonic time and external wall time measure heartbeat timing.',
    'Headless tree/layout observations show received frame state at inspection boundaries, not continuous realtime screen presentation.']};
const pause = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => ({wall: Date.now(), mono: performance.now()});
const children = [], owned = new Map(), observed = []; let fd, daemon, server, ready = false, failure;
const processes = () => execFileSync('/bin/ps', ['-axo','pid=,ppid=,lstart=,comm='],
  {encoding: 'utf8', env: {...env, LC_ALL: 'C'}}).trim().split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
    assert(m, 'ps metadata parse'); return {pid: +m[1], ppid: +m[2], start: m[3], comm: m[4]};
  });
const same = (a, b) => !!a && !!b && a.pid === b.pid && a.start === b.start;
const before = processes(); evidence.preExistingTern = before.filter(p => p.comm === tern);
function captureOwned() {
  const rows = processes(), ids = new Set(children.filter(c => c.exitCode === null && c.signalCode === null).map(c => c.pid));
  for (let changed = true; changed;) {
    changed = false;
    for (const p of rows) if (ids.has(p.ppid) && !ids.has(p.pid)) {ids.add(p.pid); changed = true;}
  }
  for (const p of rows.filter(p => ids.has(p.pid))) {
    assert(!before.some(old => same(old, p)), 'must not own pre-existing processes'); owned.set(p.pid, p);
  }
}
const endpointOwned = (child, path) => execFileSync('/usr/sbin/lsof',
  ['-nP','-a','-p',String(child.pid),'-U','-Fn'], {encoding: 'utf8', timeout: 2000})
  .split('\n').some(line => line === 'n' + path || line.startsWith('n' + path + ' '));
function start(args, owner) {
  const child = spawn(tern, args, {env, cwd: out + '/cwd', detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.on('data', data => {
      appendFileSync(out + '/' + owner + '.log', data); appendFileSync(fd, data); buffer += data.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        const match = line.match(/SESSION_LIGHT (\{.*\})/);
        if (match) {
          const event = {...JSON.parse(match[1]), owner, received: stamp()};
          observed.push(event); appendFileSync(out + '/events.jsonl', JSON.stringify(event) + '\n');
        }
      }
    });
  }
  child.on('error', e => {failure = e;}); children.push(child); return child;
}
async function endpoint(child, path) {
  for (let i = 0; i < 80; i++) {
    if (failure) throw failure;
    assert(child.exitCode === null && child.signalCode === null, 'isolated process exited before readiness');
    if (existsSync(path)) {assert(statSync(path).isSocket() && endpointOwned(child, path)); return;}
    await pause(100);
  }
  throw Error('Isolated environment unavailable: ' + path);
}
function cli(args) {
  return execFileSync(tern, args, {env, cwd: out, encoding: 'utf8', timeout: 7000, maxBuffer: 4 * 1024 * 1024});
}
function ctl(command) {
  assert(ready && server.exitCode === null && endpointOwned(server, control), 'private endpoint identity');
  evidence.commands.push({command, at: stamp()});
  const reply = JSON.parse(cli(['ctl', '--control', control, command]));
  assert(reply.ok, command + ': ' + reply.error); return reply;
}
function lua(code) {const result = ctl('carly lua ' + JSON.stringify(code)); ctl('carly ok'); return result;}
const events = () => observed;
async function quiet(label, ms) {
  await pause(30); // Drain logs queued while synchronous boundary commands ran.
  const start = stamp(), count = evidence.commands.length, from = events().length;
  console.log(`QUIET ${label} ${ms}ms (no ctl)`);
  await pause(ms);
  const end = stamp(); assert.equal(evidence.commands.length, count);
  const sample = events().slice(from);
  evidence.quiet.push({label, start, end, events: sample, controlCalls: 0}); return sample;
}
function snapshot(label) {
  const tree = ctl('tree [data-role="codex-tern.sessions.traffic"]');
  const shot = ctl('shot ' + label);
  const stats = ctl('stats');
  writeFileSync(out + '/' + label + '-tree.json', JSON.stringify(tree, null, 2));
  const layout = JSON.parse(readFileSync(shot.layout, 'utf8'));
  const lamps = (layout.elements ?? []).filter(e => /ct-session-traffic/.test(e.path))
    .map(e => ({...e, opacity: Number(e.opacity)}));
  const statePath = out + '/' + label + '-identity.json';
  lua(`tern.fs.write(${JSON.stringify(statePath)},tern.json.encode({focused=cx.session:focused(),panes=cx.session:panes(),clock=tern.now()}))`);
  const identity = JSON.parse(readFileSync(statePath, 'utf8'));
  evidence.phases.push({label, tree, shot, lamps, stats, identity}); return evidence.phases.at(-1);
}
const tree = sel => ctl('tree ' + sel).nodes ?? [];
const text = sel => tree(sel).map(n => n.text ?? '').join('\n');
const row = title => `[data-role="codex-tern.sessions.item"][title="${title}"]`;
const selected = '[data-role="codex-tern.sessions.item"][data-mark="pick"]';
const editor = '[data-role="omp.editor"] .sf-editor';
const click = sel => ctl('click ' + sel);
const type = value => ctl('type ' + JSON.stringify(value));
const key = value => ctl('key ' + value);
async function wait(check, label, timeout = 6000) {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    if (check()) return;
    await pause(100);
  }
  throw Error('Timed out: ' + label);
}
const quote = v => "'" + v.replaceAll("'", "'\\''") + "'";
try {
  evidence.version = cli(['--version']).trim();
  const catalog = JSON.parse(cli(['plugin', 'list', '--json']));
  assert.equal(catalog.problems.length, 0); assert.equal(catalog.plugins.length, 1); evidence.catalog = catalog;
  fd = openSync(out + '/tern.log', 'w');
  daemon = start(['daemon', '--socket', socket], 'daemon'); await endpoint(daemon, socket);
  server = start(['serve', '--control', control, '--out', out, '--cwd', out + '/cwd'], 'renderer');
  await endpoint(server, control); ready = true; captureOwned();
  ctl('resize 1280 1000'); ctl('plugins fixtures');
  const command = ['env', ...Object.entries(env).map(([k,v]) => `${k}=${v}`), '/Users/yanghao/.local/bin/bun', resolve(repo, 'dist/cli.mjs'), '--codex', resolve(repo, 'test/fixtures/ui-app-server.mjs')].map(quote).join(' ');
  ctl('run ' + JSON.stringify(command));
  await wait(() => text('.sf-dock').includes('QA Model'), 'real client with fixed app-server');
  await wait(() => tree('[data-role="codex-tern.sessions.item"]').length >= 4, 'actual automatic host sidebar', 3500);
  const identity = out + '/ids.json';
  lua(`local panes=cx.session:panes(); local light=nil; for _,p in panes do if p.block=="codex-tern.sessions" then light=p.pane end end; tern.fs.write(${JSON.stringify(identity)},tern.json.encode({client=cx.session:focused(),light=light,panes=panes}))`);
  evidence.ids = JSON.parse(readFileSync(identity, 'utf8'));
  assert(evidence.ids.light && evidence.ids.client !== evidence.ids.light);
  assert.equal(tree('[data-role="codex-tern.sessions.traffic"]').length, tree('[data-role="codex-tern.sessions.item"]').length);
  assert(tree('[data-role="codex-tern.sessions.traffic"]').every(n => n.rect[2] === 8 && n.rect[3] === 8 && n.title));
  assert(!text('[data-role="codex-tern.sessions"]').includes('EXCLUDED_OTHER_FOLDER'));
  evidence.passed.push('Actual fixed-backend client auto-opens a host sessions block with one accessible 8x8 lamp per row and preserved focus');
  click(row('Saved session 1'));
  await wait(() => tree(selected)[0]?.title === 'Saved session 1' && text('[data-role="omp.assistant"]').includes('QA_SAVED_HISTORY_1'), 'host row click -> window route -> live client navigation');
  click(`${row('Saved session 1')} [data-role="codex-tern.sessions.pin"]`);
  await wait(() => tree(`${row('Saved session 1')} [data-role="codex-tern.sessions.pin"][data-mark="pinned"]`).length === 1, 'pin click');
  const more = '[data-role="codex-tern.sessions.note"][data-id$="more"]';
  if (tree(more).length) click(more);
  await wait(() => tree('[data-role="codex-tern.sessions.item"]').length === 7, 'pagination');
  evidence.passed.push('Real row navigation, star pinning, folder filtering and pagination survive host/window action bridging');
  click(`${row('Saved session 2')} right`);
  await wait(() => text('[role="menu"] [role="menuitem"]').includes('Rename session'), 'context menu');
  click('[role="menu"] [role="menuitem"]:first-child');
  await wait(() => tree('[data-role="ct.session.name"]').length === 1, 'rename action');
  key('Meta+a'); type('Renamed sidebar row'); key('Enter');
  await wait(() => tree(row('Renamed sidebar row')).length === 1, 'renamed row');
  click(`${row('Saved session 3')} [data-role="codex-tern.sessions.archive"]`);
  await wait(() => tree(row('Saved session 3')).length === 0, 'background archive');
  assert.equal(tree(selected)[0]?.title, 'Saved session 1');
  evidence.passed.push('Native context-menu rename and trailing archive retain row identity and do not switch to a background row');
  click(editor); type('hold'); key('Enter');
  await wait(() => tree('.ct-session-working').length === 1, 'running snapshot delivered to host');
  const before = snapshot('working');
  assert.equal(before.identity.focused, evidence.ids.client);
  const sample = await quiet('actual-sidebar-unfocused-working', 8000);
  const ticks = sample.filter(e => e.event === 'tick');
  const renders = sample.filter(e => e.event === 'render_return');
  const gaps = ticks.slice(1).map((e,i) => e.clock - ticks[i].clock);
  const receipts = ticks.slice(1).map((e,i) => e.received.mono - ticks[i].received.mono);
  assert(ticks.length >= 14 && renders.length >= 14 && new Set(renders.map(e => e.lit)).size === 2);
  evidence.timing = {ticks: ticks.length, renders: renders.length, views: sample.filter(e => e.event === 'view').length,
    maxGapMs: Math.max(...gaps), receiptMaxGapMs: Math.max(...receipts), maxLateMs: Math.max(...ticks.map(e => e.late))};
  assert(evidence.timing.maxGapMs < 900 && evidence.timing.receiptMaxGapMs < 900);
  const after = snapshot('after-quiet');
  const workingLamp = frame => frame.lamps.find(e => e.path.includes('ct-session-working'));
  let opposite = workingLamp(before)?.opacity !== workingLamp(after)?.opacity ? before : undefined;
  for (let i = 0; !opposite && i < 5; i++) {
    await pause(110 + 55 * i);
    const frame = snapshot('phase-' + i);
    if (workingLamp(frame)?.opacity !== workingLamp(after)?.opacity) opposite = frame;
  }
  assert(opposite && workingLamp(opposite) && workingLamp(after));
  assert.equal(after.identity.focused, evidence.ids.client); assert.equal(opposite.identity.focused, evidence.ids.client);
  evidence.passed.push('Actual sidebar has host-driven alternating opacity frames over an 8s real wall-clock interval with no ctl; companion client retains focus');
  const reloadAt = events().length;
  ctl('plugins fixtures');
  // No sessions command: the saved host block and window startup recovery must
  // recover the existing running sidebar on their own.
  await wait(() => tree('.ct-session-working').length === 1, 'active sidebar restored without reopening');
  const reloadQuiet = await quiet('active-reload', 1600);
  const reloadTicks = reloadQuiet.filter(e => e.event === 'tick');
  assert(reloadTicks.length >= 2 && reloadTicks.length <= 4, 'one replacement heartbeat, no duplicate old timer');
  assert(events().slice(reloadAt).some(e => e.event === 'cancel' && e.reason === 'unload'));
  assert(events().slice(reloadAt).some(e => e.event === 'disposed'));
  assert.equal(tree('[data-role="codex-tern.sessions"]').length, 1);
  evidence.passed.push('Active plugin reload cancels old heartbeat and restores one running sidebar without a reopen command');
  click('[data-role="omp.composer.stop"]');
  await wait(() => tree('.ct-session-working').length === 0, 'stop reaches sidebar');
  const stopped = await quiet('no-running-rows', 1600);
  assert(!stopped.some(e => ['tick','render_return'].includes(e.event)), 'no idle animation heartbeat');
  click('[data-role="codex-tern.sessions.new"]');
  await wait(() => tree('[placeholder="Choose a session engine"]').length === 1, 'session engine picker');
  key('Enter');
  await wait(() => text('[data-role="omp.welcome"]').length > 0, 'new session');
  evidence.passed.push('Stop cancels host heartbeat; new-session button still opens a blank conversation');
  // Reload the actual host/window halves in the private fixture catalog only.
  ctl('plugins fixtures'); ctl('plugins run plugin.codex-tern.sessions');
  await wait(() => tree(row('Saved session 1')).length === 1, 'sidebar recovered after reload');
  assert.equal(tree('[data-role="codex-tern.sessions"]').length, 1);
  click(row('Saved session 1')); await wait(() => tree(selected)[0]?.title === 'Saved session 1', 'navigation after reload');
  click(editor); type('hold again'); key('Enter'); await wait(() => tree('.ct-session-working').length === 1, 'run after reload');
  const closePath = out + '/close-id.json';
  lua(`for _,p in cx.session:panes() do if p.block=="codex-tern.sessions" then tern.fs.write(${JSON.stringify(closePath)},tern.json.encode({pane=p.pane})); cx.layout:close(p.pane) end end`);
  ctl('carly close');
  const closed = await quiet('sidebar-closed', 1600);
  assert(closed.filter(e => e.event === 'tick').length <= 1 && !closed.some(e => e.event === 'render_return'));
  evidence.passed.push('Plugin reload reuses one recovered host sidebar; closing a running sidebar releases the heartbeat on the next tick');
  click('[data-role="omp.composer.stop"]');
  const legacyPath = out + '/legacy.json';
  // Carly-authored canvases have owner=carly and must never be migrated. Use
  // a private copy with one fixture-only command to create the correct owner.
  const migrationPlugin = out + '/migration-plugin';
  cpSync(plugin, migrationPlugin, {recursive: true});
  appendFileSync(migrationPlugin + '/window.luau', `\ntern.command({id="qa-legacy",title="QA legacy canvas",run=function(cx) local p=cx.canvas:open({title="Sessions",about="codex-tern.sessions/v1:${evidence.ids.client}",view=tern.ui.col({tern.ui.text("Legacy sidebar migration fixture")}),how="beside",focus=false}); cx.layout:move(p,${evidence.ids.client},"left",{focus=false}); tern.fs.write(${JSON.stringify(legacyPath)},tern.json.encode({pane=p})) end})\n`);
  writeFileSync(out + '/fixtures/crates/plugins/fixtures/codex-tern.path', migrationPlugin + '\n');
  ctl('plugins fixtures'); ctl('plugins run plugin.codex-tern.qa-legacy');
  ctl('plugins run plugin.codex-tern.sessions');
  await wait(() => tree(row('Saved session 1')).length === 1, 'legacy canvas migrated to host block');
  const migrated = snapshot('migrated-legacy');
  const legacy = JSON.parse(readFileSync(legacyPath,'utf8'));
  assert(!migrated.identity.panes.some(p => p.pane === legacy.pane));
  assert.equal(migrated.identity.panes.filter(p => p.block === 'codex-tern.sessions').length, 1);
  assert.equal(migrated.identity.focused, evidence.ids.client);
  evidence.passed.push('Existing window-only sessions canvas migrates in place to one host block, removes the legacy pane and preserves client focus');
  captureOwned();
  assert(!/exceeded \d+ ms|panicked|plugin handler failed|hook failed|cannot load|failed to (?:load|compile)/i.test(readFileSync(out + '/tern.log','utf8')));
} catch (e) {
  failure = e; evidence.errors.push(e.stack ?? String(e));
} finally {
  try {captureOwned();} catch (e) {evidence.errors.push('ownership capture: ' + e.message);}
  if (ready) {try {ctl('quit');} catch {server?.kill('SIGTERM');}}
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
  await pause(300);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const rows = processes();
    for (const p of [...owned.values()].reverse()) if (same(rows.find(r => r.pid === p.pid), p))
      try {process.kill(p.pid, signal);} catch (e) {if (e.code !== 'ESRCH') evidence.errors.push(e.message);}
    await pause(200);
  }
  const rows = processes();
  evidence.ownedProcesses = [...owned.values()];
  evidence.remaining = [...owned.values()].filter(p => same(rows.find(r => r.pid === p.pid), p));
  evidence.preExistingTernStillPresent = evidence.preExistingTern.every(p => same(rows.find(r => r.pid === p.pid), p));
  for (const path of [control, socket]) if (!evidence.remaining.length && existsSync(path) && statSync(path).isSocket()) unlinkSync(path);
  evidence.endpointsRemaining = [control, socket].filter(existsSync);
  evidence.events = existsSync(out + '/tern.log') ? events() : [];
  if (fd !== undefined) closeSync(fd);
  evidence.ok = !failure && !evidence.errors.length && !evidence.remaining.length && !evidence.endpointsRemaining.length;
  writeFileSync(out + '/result.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({out, ok: evidence.ok, timing: evidence.timing, passed: evidence.passed,
    remaining: evidence.remaining, endpointsRemaining: evidence.endpointsRemaining, errors: evidence.errors}, null, 2));
}
if (!evidence.ok) process.exitCode = 1;
