// Private native traffic-light component preview only; the exact production view and CSS are used.
// It does not claim to exercise the window plugin's offscreen timer/event loop.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';
const root = resolve(import.meta.dirname, '..'), out = resolve(root, '.prototype/session-traffic-light', `native-${process.pid}`);
const config = resolve(out, 'config'), control = resolve(out, 'control.sock');
await prepareTernQaConfig(config); await mkdir(resolve(config, 'plugins'), { recursive: true });
await writeFile(resolve(config, 'plugins/codex-tern.path'), resolve(root, 'tern-plugin'));
const env = { ...process.env, TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: resolve(out, 'daemon.sock'),
  XDG_CACHE_HOME: resolve(out, 'cache'), XDG_STATE_HOME: resolve(out, 'state'), WB_DATA_DIR: resolve(out, 'workbench'), CODEX_TERN_WEIXIN_DISABLE: '1' };
delete env.TERN_WINDOW_KEY; delete env.TERN_WINDOW_SOCKET;
const fd = openSync(resolve(out, 'tern.log'), 'w');
const daemon = spawn('tern', ['daemon', '--socket', env.TERN_DAEMON_SOCKET], { env, stdio: ['ignore', fd, fd] });
let server; const passed = [], screenshots = [], limitations = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function ctl(command) {
  const r = JSON.parse(execFileSync('tern', ['ctl', '--control', control, command], { env, encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024 }));
  if (!r.ok) throw Error(`${command.slice(0,80)}: ${r.error}`); return r;
}
const tree = sel => ctl(`tree ${sel}`).nodes ?? [];
async function wait(fn, label) { for (let i = 0; i < 60; i++) { if (fn()) return; await pause(100); } throw Error(`Isolated environment unavailable: ${label}`); }
const shot = name => { const r = ctl(`shot ${name}`); screenshots.push(r); return r; };
const layers = async shot => (JSON.parse(await readFile(shot.layout, 'utf8')).elements ?? [])
  .filter(e => /ct-lamp-lit/.test(e.path)).map(e => ({ path: e.path, opacity: Number(e.opacity), background: e.backgroundColor, rect: e.rect }));
try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'private daemon');
  server = spawn('tern', ['serve', '--control', control, '--out', out, '--cwd', root], { env, stdio: ['ignore', fd, fd] });
  await wait(() => existsSync(control), 'private offscreen renderer');
  const source = await readFile(resolve(root, 'tern-plugin/window.luau'), 'utf8');
  const view = source.match(/local function view\(snapshot, selection, reveals\)[\s\S]*?(?=local function paint\()/)?.[0];
  assert.ok(view, 'load exact production view');
  const translations = await readFile(resolve(root, 'tern-plugin/i18n.luau'), 'utf8');
  const base = { locked: false, canArchive: true, pinned: false, time: '固定状态预览', running: false, waiting: false, permission: false, completed: false, failed: false };
  const snapshot = { cwd: '三灯条预览（固定数据）', current: 'read', canSwitch: true, connected: true,
    archiveProtocol: 1, pinProtocol: 1, language: 'zh-CN', rows: [
      { ...base, id: 'working', title: '核查 pre01 发布准备', running: true },
      { ...base, id: 'waiting', title: '等待用户回答 · 黄灯', waiting: true, running: true },
      { ...base, id: 'permission', title: '等待权限确认 · 红灯', waiting: true, permission: true, running: true },
      { ...base, id: 'complete', title: '任务完成 · 尚未读取结果', completed: true, pinned: true },
      { ...base, id: 'failed', title: '执行失败 · 请查看原会话', failed: true },
      { ...base, id: 'read', title: '结果已读 · 三灯全灭' },
      { ...base, id: 'long', title: '长标题：配置远程仓库并核验状态，星标、关闭与切换位置保持可用', running: true },
    ] };
  const code = `local translate=(function()\n${translations}\nend)()\n${view}\nlocal s=tern.json.decode(${JSON.stringify(JSON.stringify(snapshot))})\nlocal original=cx.session:focused()\nlocal p=cx.canvas:open({title="三灯条预览（固定数据）", view=view(s,nil,nil),about="codex-tern.traffic-preview/v1",how="beside",focus=true})\nif p and original then cx.layout:close(original) end\nreturn p`;
  ctl('resize 580 420');
  const cssResult = ctl('css codex-traffic-preview '+resolve(root, 'tern-plugin/sessions.css'));
  const unrelated = (cssResult.errors ?? []).filter(e => e.message === 'unexpected Ident("fit-content") in `width: fit-content;`');
  if (unrelated.length) limitations.push('Existing title-reveal width:fit-content is unsupported by this host and was left unchanged; all traffic-light rules compile.');
  assert.deepEqual((cssResult.errors ?? []).filter(e => !unrelated.includes(e)), [], 'traffic-light rules must compile');
  ctl(`carly lua ${JSON.stringify(code)}`);
  ctl('wait 6000');
  await wait(() => tree('[data-role="codex-tern.sessions.item"]').length === 7, 'production component preview');
  const rows = tree('[data-role="codex-tern.sessions.item"]');
  assert.ok(rows.every(n => n.rect[3] <= 34), 'compact row heights');
  assert.equal(tree('.ct-session-traffic').length, 7);
  assert.equal(tree('.ct-lamp').length, 21);
  assert.equal(tree('.ct-session-dust').length, 0);
  assert.equal(tree('[data-role="codex-tern.sessions.pin"]').length, 7);
  assert.equal(tree('[data-role="codex-tern.sessions.archive"]').length, 7);
  assert.ok(tree('.ct-session-traffic').every(n => n.rect[2] === 36 && n.rect[3] === 14), 'visible native lamp housings');
  assert.ok(tree('.ct-lamp').every(n => n.rect[2] === 8 && n.rect[3] === 8), 'visible native lenses');
  passed.push('production rows show seven real 36x14 three-lamp housings, keep compact height and star/close controls, remove background dust');
  ctl('appearance dark'); ctl('reduce-motion off');
  const frames = [];
  for (const ms of [0, 250, 325, 500, 650, 750, 1000, 1500, 2000]) {
    ctl('motion-at '+ms); const frame = shot('traffic-dark-'+ms);
    frames.push({ ms, lamps: await layers(frame) });
  }
  const active = (frame, state, color) => frame.lamps.filter(e => e.path.includes('ct-session-'+state) && e.path.includes('ct-lamp-'+color));
  for (const [state, color, peak, end] of [['working', 'green', 500, 1000], ['waiting', 'yellow', 750, 1500], ['permission', 'red', 750, 1500], ['failed', 'red', 325, 650]]) {
    const zero = active(frames[0], state, color), bright = active(frames.find(f => f.ms === peak), state, color), dark = active(frames.find(f => f.ms === end), state, color);
    assert.ok(zero.length > 0 && bright.length === zero.length && dark.length === zero.length, state+' rendered lenses');
    assert.ok(zero.every(e => e.opacity < .05) && dark.every(e => e.opacity < .05) && bright.every(e => e.opacity > .95), state+' exact bright/dark rhythm');
  }
  assert.ok(frames.every(f => f.lamps.every(e => e.opacity === 0 || e.opacity === 1)), 'reference flash has distinct on/off states; smooth breathe is a different effect');
  assert.ok(frames.every(f => active(f, 'working', 'green').every(e => e.background === 'rgb(0, 200, 255)')), 'working lens is cyan even with reduced motion');
  assert.ok(frames.every(f => active(f, 'completed', 'green').every(e => e.background === 'rgb(53, 199, 111)')), 'done lens remains green');
  assert.ok(frames.every(f => active(f, 'completed', 'green').length === 1 && active(f, 'completed', 'green').every(e => e.opacity === 1)), 'done stays green');
  assert.ok(frames.every(f => f.lamps.filter(e => e.path.includes('ct-session-off')).every(e => e.opacity === 0)), 'read/idle stays off');
  await writeFile(resolve(out, 'frames.json'), JSON.stringify(frames, null, 2));
  passed.push('native distinct flash and sampled Working cyan 1s / Attention and Permission 1.5s / Blocked .65s bright-dark cycles; Done steady and Off dark');
  ctl('appearance light'); ctl('motion-at 750'); shot('traffic-light');
  ctl('reduce-motion on'); ctl('motion-at 0'); const reduced = shot('traffic-reduced-motion');
  ctl('motion-at 1400'); const reducedLater = shot('traffic-reduced-motion-later');
  assert.deepEqual(await layers(reduced), await layers(reducedLater), 'reduced motion keeps lamps stationary');
  passed.push('reduced motion keeps native lamps static');
  ctl('appearance dark'); ctl('resize 390 420'); shot('traffic-narrow');
  assert.ok(tree('[data-role="codex-tern.sessions.item"]').every(n => n.rect[3] <= 34), 'narrow row heights');
  const pins = tree('[data-role="codex-tern.sessions.pin"]'), closes = tree('[data-role="codex-tern.sessions.archive"]');
  assert.ok(closes.every((n,i) => n.rect[0] > pins[i].rect[0] && n.rect[0]+n.rect[2] <= 390), 'narrow star/close positions remain visible');
  passed.push('narrow panel preserves row heights and right-side star/close positions');
  await writeFile(resolve(out, 'tree.json'), JSON.stringify(ctl('tree'), null, 2));
  limitations.push('This is a labelled component preview from production Luau/CSS; sidebar timer initialization and owner pointer routing are separate from this test.');
} catch (error) {
  limitations.push(error.message); try { shot('failed'); await writeFile(resolve(out, 'failed-tree.json'), JSON.stringify(ctl('tree'), null, 2)); } catch {}
  throw error;
} finally {
  try { ctl('quit'); } catch { server?.kill('SIGTERM'); }
  daemon.kill('SIGTERM'); closeSync(fd);
  const ownedPids = [daemon.pid, server?.pid].filter(Boolean);
  for (let i = 0; i < 30 && ownedPids.some(alive); i++) await pause(100);
  for (const pid of ownedPids.filter(alive)) process.kill(pid, 'SIGTERM'); await pause(150);
  const remainingPids = ownedPids.filter(alive);
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ passed, screenshots, limitations, ownedPids, remainingPids, config, control }, null, 2));
  console.log(`ARTIFACTS ${out}`); assert.deepEqual(remainingPids, []);
}
