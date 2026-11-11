// Explicit offscreen-only integration test. Quiet wall-clock intervals contain NO ctl calls.
// Headless frame inspection is deliberately not treated as native realtime presentation.
import {spawn, execFileSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, closeSync, statSync, unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {prepareTernQaConfig} from './qa-tern-config.mjs';

const repo = resolve(import.meta.dirname, '..');
const out = `/private/tmp/ct-host-light-${Date.now()}-${process.pid}`;
const config = out + '/config', control = out + '/control.sock', socket = out + '/daemon.sock';
const tern = '/Applications/Tern.app/Contents/MacOS/tern';
const fixture = out + '/fixtures/crates/tern';
const env = {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8',
  TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: socket, STENCIL_LOG_DIR: out + '/logs',
  XDG_CACHE_HOME: out + '/cache', XDG_STATE_HOME: out + '/state',
  ZDOTDIR: out + '/quiet-zsh', SHELL: out + '/quiet-shell',
  STENCIL_FIXTURE_ROOT: fixture, STENCIL_LOG: 'warn,tern::plugin=debug', CT_HOST_LIGHT_TRACE: '1'};
for (const k of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', '__CF_USER_TEXT_ENCODING'])
  if (process.env[k]) env[k] = process.env[k];
mkdirSync(out, {recursive: false, mode: 0o700});
await prepareTernQaConfig(config);
for (const d of [config + '/plugins', fixture, out + '/fixtures/crates/plugins/fixtures', out + '/cwd', env.ZDOTDIR])
  mkdirSync(d, {recursive: true});
for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) writeFileSync(env.ZDOTDIR + '/' + f, '');
const plugin = resolve(repo, 'plugins/host-light-prototype');
for (const d of [config + '/plugins', out + '/fixtures/crates/plugins/fixtures'])
  writeFileSync(d + '/host-light-prototype.path', plugin + '\n');
writeFileSync(out + '/quiet-shell', '#!/bin/sh\nexec /bin/sleep 600\n', {mode: 0o700});
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
        const match = line.match(/HOST_LIGHT (\{.*\})/);
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
  const tree = ctl('tree [data-role="host-light.lamp"]');
  const shot = ctl('shot ' + label);
  const stats = ctl('stats');
  writeFileSync(out + '/' + label + '-tree.json', JSON.stringify(tree, null, 2));
  const layout = JSON.parse(readFileSync(shot.layout, 'utf8'));
  const lamps = (layout.elements ?? []).filter(e => /ct-host-light/.test(e.path))
    .map(e => ({...e, opacity: Number(e.opacity)}));
  const statePath = out + '/' + label + '-identity.json';
  lua(`tern.fs.write(${JSON.stringify(statePath)},tern.json.encode({focused=cx.session:focused(),panes=cx.session:panes(),clock=tern.now()}))`);
  const identity = JSON.parse(readFileSync(statePath, 'utf8'));
  evidence.phases.push({label, tree, shot, lamps, stats, identity}); return evidence.phases.at(-1);
}
try {
  evidence.version = cli(['--version']).trim();
  const catalog = JSON.parse(cli(['plugin', 'list', '--json']));
  assert.equal(catalog.problems.length, 0); assert.equal(catalog.plugins.length, 1);
  evidence.catalog = catalog;
  fd = openSync(out + '/tern.log', 'w');
  daemon = start(['daemon', '--socket', socket], 'daemon'); await endpoint(daemon, socket);
  server = start(['serve', '--control', control, '--out', out, '--cwd', out + '/cwd'], 'renderer');
  await endpoint(server, control); ready = true; captureOwned();
  ctl('resize 1000 550'); ctl('plugins fixtures');
  const idPath = out + '/opened.json';
  lua(`local original=cx.session:focused(); local pane=cx:new_block("host-light-prototype.light",{"working"},"beside",{focus=false}); tern.fs.write(${JSON.stringify(idPath)},tern.json.encode({pane=pane,original=original,focused=cx.session:focused()}))`);
  const ids = JSON.parse(readFileSync(idPath, 'utf8'));
  assert(ids.pane && ids.original && ids.focused === ids.original, 'open without moving block focus');
  evidence.ids = ids; ctl('carly close');
  await pause(800); // no ctl polling to sustain heartbeat
  const initial = snapshot('initial');
  assert(initial.lamps.length === 1, 'one native lamp is mounted');
  assert.equal(initial.identity.focused, ids.original);
  const sample = await quiet('working-unfocused', 12000);
  const ticks = sample.filter(e => e.event === 'tick');
  const renders = sample.filter(e => e.event === 'render_return' && e.pane === ids.pane);
  const views = sample.filter(e => e.event === 'view' && e.pane === ids.pane);
  assert(ticks.length >= 22 && renders.length >= 22 && views.length >= 22);
  const gaps = ticks.slice(1).map((e, i) => e.clock - ticks[i].clock);
  const receiptGaps = ticks.slice(1).map((e, i) => e.received.mono - ticks[i].received.mono);
  evidence.timing = {ticks: ticks.length, renders: renders.length, views: views.length,
    maxGapMs: Math.max(...gaps), maxLateMs: Math.max(...ticks.map(e => e.late)),
    receiptMaxGapMs: Math.max(...receiptGaps), receiptSpanMs: ticks.at(-1).received.mono - ticks[0].received.mono,
    first: ticks[0], last: ticks.at(-1)};
  assert(evidence.timing.maxGapMs < 800 && evidence.timing.maxLateMs < 300, 'host heartbeat gap');
  assert(evidence.timing.receiptMaxGapMs < 900 && evidence.timing.receiptSpanMs > 11000,
    'real external receipt timing, independently of the simulated document clock');
  assert(new Set(renders.map(e => e.lit)).size === 2, 'both phases rendered');
  evidence.passed.push('12s real wall-clock quiet interval: host callbacks, view construction and cx:render return alternate without ctl; block focus stays on companion');
  const after = snapshot('after-quiet'); assert.equal(after.identity.focused, ids.original);
  // Two bounded native observations seek opposite received states. They are frame
  // checks, explicitly excluded from timing evidence; never a keepalive strategy.
  let opposite;
  for (let i = 0; i < 3; i++) {
    await pause(230);
    const frame = snapshot('frame-' + i);
    if (frame.lamps[0]?.opacity !== after.lamps[0]?.opacity) {opposite = frame; break;}
  }
  assert(opposite, 'native frame receives both opacity states');
  for (const phase of [after, opposite]) {
    assert.equal(phase.lamps[0].backgroundColor, 'rgb(0, 200, 255)');
    assert.equal(phase.lamps[0].rect[2], 8); assert.equal(phase.lamps[0].rect[3], 8);
  }
  evidence.passed.push('Native headless layout receives one 8x8 cyan lamp with opacity 0.2 and 1 through host block updates');
  // Set business status with the normal surface event API; this does not focus the block.
  const setStatus = status => lua(`local s=cx.session:surface(${ids.pane}); cx.session:event(${ids.pane},{sf=s.surface.id,ev="action",act="status",value=${JSON.stringify(status)}})`);
  setStatus('completed'); ctl('carly close');
  const stopped = await quiet('completed-stops-timer', 1700);
  assert(stopped.every(e => !['tick','render_return'].includes(e.event)), 'no callbacks after stop');
  const complete = snapshot('completed');
  assert.equal(complete.lamps[0].backgroundColor, 'rgb(53, 199, 111)'); assert.equal(complete.lamps[0].opacity, 1);
  evidence.passed.push('Completion cancels pending heartbeat and remains solid green');
  setStatus('off'); ctl('carly close');
  const off = snapshot('off');
  assert.equal(off.lamps[0].backgroundColor, 'rgb(69, 75, 78)'); assert.equal(off.lamps[0].opacity, 1);
  evidence.passed.push('Read/idle status stays solid gray without restarting the timer');
  setStatus('working'); ctl('carly close');
  const restarted = await quiet('restart', 1700);
  assert(restarted.filter(e => e.event === 'render_return').length >= 3);
  lua(`cx.layout:close(${ids.pane})`); ctl('carly close');
  const closed = await quiet('closed-block', 1700);
  assert(closed.filter(e => e.event === 'tick').length <= 1, 'close releases timer by next shared tick');
  assert.equal(closed.filter(e => e.event === 'render_return').length, 0);
  evidence.passed.push('Restart resumes heartbeat; closing the block removes its context and no further render/timer persists');
  // Dispose an active heartbeat through the real plugin unload lifecycle.
  lua('cx:new_block("host-light-prototype.light",{"working"},"beside",{focus=false})'); ctl('carly close');
  await quiet('before-active-unload', 700);
  // serve owns an in-process host; external `tern plugin reload` only reloads
  // the separate daemon. Reset the private fixture catalog in this renderer.
  evidence.reload = ctl('plugins fixtures');
  const unloaded = await quiet('unloaded', 1100);
  // Tern may re-init a live pane on reload. Check old VM cancellation separately
  // rather than claiming a restored active block should stop flashing.
  evidence.unloadEvents = events().filter(e => ['cancel','disposed','init'].includes(e.event));
  assert(evidence.unloadEvents.some(e => e.event === 'cancel' && e.reason === 'unload'));
  assert(evidence.unloadEvents.some(e => e.event === 'disposed'));
  evidence.passed.push('Real plugin reload/unload cancels the active old VM heartbeat and disposes captured contexts');
  const log = readFileSync(out + '/tern.log', 'utf8');
  assert(!/exceeded \d+ ms|panicked|hook failed|cannot load|failed to (?:load|compile)/i.test(log), 'no Lua/budget failures');
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
