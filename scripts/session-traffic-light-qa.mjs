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
execFileSync('tern', ['plugin', 'link', resolve(root, 'tern-plugin')], { env, encoding: 'utf8' });
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
  .filter(e => /ct-session-traffic/.test(e.path)).map(e => ({ path: e.path, opacity: Number(e.opacity), background: e.backgroundColor, rect: e.rect }));
try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'private daemon');
  server = spawn('tern', ['serve', '--control', control, '--out', out, '--cwd', root], { env, stdio: ['ignore', fd, fd] });
  await wait(() => existsSync(control), 'private offscreen renderer');
  const source = await readFile(resolve(root, 'tern-plugin/window.luau'), 'utf8');
  const viewSource = await readFile(resolve(root, 'tern-plugin/sessions-view.luau'), 'utf8');
  const view = viewSource.slice(viewSource.indexOf('return function(')).replace('return function(', 'local function view(');
  assert.ok(view, 'load exact production view');
  const traffic = await readFile(resolve(root, 'tern-plugin/traffic-light.luau'), 'utf8');
  const translations = await readFile(resolve(root, 'tern-plugin/i18n.luau'), 'utf8');
  const base = { locked: false, canArchive: true, pinned: false, time: '固定状态预览', running: false, waiting: false, permission: false, completed: false, failed: false };
  const snapshot = { cwd: '单灯预览（合成数据）', current: 'read', canSwitch: true, connected: true,
    archiveProtocol: 1, pinProtocol: 1, language: 'zh-CN', rows: [
      { ...base, id: 'working', title: '核查 pre01 发布准备', running: true },
      { ...base, id: 'waiting', title: '等待用户回答 · 黄灯', waiting: true, running: true },
      { ...base, id: 'permission', title: '等待权限确认 · 红灯', waiting: true, permission: true, running: true },
      { ...base, id: 'complete', title: '任务完成 · 尚未读取结果', completed: true, pinned: true },
      { ...base, id: 'failed', title: '执行失败 · 请查看原会话', failed: true },
      { ...base, id: 'read', title: '结果已读 · 灰灯' },
      { ...base, id: 'locked', title: '其他客户端占用 · 灰灯', locked: true, running: true },
      { ...base, id: 'long', title: '长标题：配置远程仓库并核验状态，星标、关闭与切换位置保持可用', running: true },
    ] };
  const prefix = `local translate=(function()\n${translations}\nend)()\nlocal traffic=(function()\n${traffic}\nend)()\n${view}`;
  const code = `${prefix}\nlocal s=tern.json.decode(${JSON.stringify(JSON.stringify(snapshot))})\nlocal original=cx.session:focused()\nlocal p=cx.canvas:open({title="单灯预览（合成数据）", view=view(s,nil,nil),about="codex-tern.traffic-preview/v1",how="beside",focus=true})\nif p and original then cx.layout:close(original) end\nreturn p`;
  const render = async () => {
    const code = `${prefix}\nlocal s=tern.json.decode(${JSON.stringify(JSON.stringify(snapshot))})\nfor _,p in cx.canvas:list() do if p.about=="codex-tern.traffic-preview/v1" then cx.canvas:set(p.pane,{view=view(s,nil,nil)}) end end`;
    ctl(`carly lua ${JSON.stringify(code)}`);
    await wait(() => tree('.ct-session-working').length === snapshot.rows.filter(r => r.running && !r.waiting && !r.locked).length, 'snapshot frame');
  };
  ctl('resize 580 420');
  const cssResult = ctl('css codex-traffic-preview '+resolve(root, 'tern-plugin/sessions.css'));
  const unrelated = (cssResult.errors ?? []).filter(e => e.message === 'unexpected Ident("fit-content") in `width: fit-content;`');
  if (unrelated.length) limitations.push('Existing title-reveal width:fit-content is unsupported by this host and was left unchanged; all traffic-light rules compile.');
  assert.deepEqual((cssResult.errors ?? []).filter(e => !unrelated.includes(e)), [], 'traffic-light rules must compile');
  ctl(`carly lua ${JSON.stringify(code)}`);
  ctl('wait 6000');
  await wait(() => tree('[data-role="codex-tern.sessions.item"]').length === 8, 'production component preview');
  const rows = tree('[data-role="codex-tern.sessions.item"]');
  assert.ok(rows.every(n => n.rect[3] <= 34), 'compact row heights');
  assert.equal(tree('.ct-session-traffic').length, 8);
  assert.equal(tree('.ct-lamp').length, 0, 'no old three-lamp children');
  assert.equal(tree('[data-role="codex-tern.sessions.pin"]').length, 8);
  assert.equal(tree('[data-role="codex-tern.sessions.archive"]').length, 8);
  assert.ok(tree('.ct-session-traffic').every(n => n.rect[2] === 8 && n.rect[3] === 8), 'one compact circular light per row');
  const semantics = `local traffic=(function()\n${traffic}\nend)()\nlocal s={current="current"}\nassert(traffic.status(s,{id="other",locked=true,running=true})=="off")\nassert(traffic.status(s,{id="current",locked=true,running=true})=="working")\nassert(traffic.status(s,{running=true,completed=true})=="working","reading must not clear running")\nassert(traffic.status(s,{waiting=true,running=true})=="waiting")\nassert(traffic.status(s,{waiting=true,permission=true,running=true})=="permission")\nassert(traffic.status(s,{failed=true,completed=true})=="failed")\nassert(traffic.status(s,{completed=true})=="completed")\nassert(traffic.status(s,{})=="off")`;
  ctl(`carly lua ${JSON.stringify(semantics)}`);
  const accessibility = `${prefix}\nlocal s=tern.json.decode(${JSON.stringify(JSON.stringify(snapshot))})\nlocal v=view(s,nil,nil)\nfor i,item in s.rows do local light; for _,node in v.c[i+2].c[1].c do if node.p.role=="codex-tern.sessions.traffic" then light=node; break end end; assert(light); assert(light.p.aria and light.p.aria==light.p.title and light.p.attrs.role=="img"); assert(light.c==nil) end`;
  ctl(`carly lua ${JSON.stringify(accessibility)}`);
  assert.doesNotMatch(source, /light_timer|light_due|sync_lights|traffic\.lit|traffic\.next_delay/);
  assert.doesNotMatch(traffic, /tern\.now|timer|period|next_delay|function traffic\.lit/);
  const css = await readFile(resolve(root, 'tern-plugin/sessions.css'), 'utf8');
  const lightCss = css.slice(css.indexOf('.ct-session-traffic {'), css.indexOf('.sf.sf-el[data-role="codex-tern.sessions.archive"]'));
  assert.doesNotMatch(lightCss, /@keyframes|ct-session-lit|ct-lamp/);
  assert.match(lightCss, /animation: none; transition: none;/);
  passed.push('snapshot priority, running/read overlap, locked rows, tooltip and accessible names preserved; no light scheduler or phase logic');
  ctl('appearance dark'); ctl('reduce-motion off');
  const first = shot('single-light-dark');
  const colors = {working:'rgb(0, 200, 255)',completed:'rgb(53, 199, 111)',waiting:'rgb(245, 197, 66)',permission:'rgb(239, 68, 68)',failed:'rgb(239, 68, 68)',off:'rgb(69, 75, 78)'};
  const firstLayers = await layers(first);
  assert.equal(firstLayers.length, 8);
  for (const [status,color] of Object.entries(colors)) {
    const lights = firstLayers.filter(e => e.path.includes('ct-session-'+status));
    assert.ok(lights.length > 0 && lights.every(e => e.background===color && e.opacity===1), status+' steady color');
  }
  await pause(1100);
  const later = shot('single-light-later');
  assert.deepEqual(await layers(later), firstLayers, 'unchanged snapshot stays steady without re-render');
  snapshot.rows.push({...base,id:'late-working',title:'新增运行状态 · 常亮',running:true});
  await render(); shot('single-light-updated');
  assert.equal(tree('.ct-session-working').length,3);
  passed.push('native single 8x8 lights render all six colors/states steadily; a real snapshot change adds one working light');
  ctl('appearance light'); shot('single-light-light');
  ctl('reduce-motion on'); shot('single-light-reduced-motion');
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
