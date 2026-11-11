// Run with bun (the native owner requires Bun).
// Isolated real native owner + deterministic protocol fixture; never touches daily Tern.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';
const root = resolve(import.meta.dirname, '..'), out = resolve(root, '.prototype/progress-visibility', `native-${process.pid}`);
const config = resolve(out, 'config'), control = resolve(out, 'control.sock');
await prepareTernQaConfig(config); await mkdir(resolve(out, 'codex/thread-writer-locks'), { recursive: true });
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, TERN_CONFIG_DIR: config,
  TERN_DAEMON_SOCKET: resolve(out, 'daemon.sock'), CODEX_TERN_CONTROL: control, CODEX_TERN_WEIXIN_DISABLE: '1',
  WB_DATA_DIR: resolve(out, 'workbench'), XDG_STATE_HOME: resolve(out, 'state'), XDG_CACHE_HOME: resolve(out, 'cache'),
  CODEX_HOME: resolve(out, 'codex'), QA_CODEX_HOME: resolve(out, 'codex'), QA_RPC_LOG: resolve(out, 'rpc.jsonl'), QA_PROGRESS_RELEASE_FILE: resolve(out, 'release-progress'), TERN_TSP_RECORD: resolve(out, 'wire.jsonl') };
await mkdir(resolve(config, 'plugins'), { recursive: true });
await writeFile(resolve(config, 'plugins/codex-tern.path'), resolve(root, 'tern-plugin'));
const clientDist = resolve(out, 'client/dist'); await mkdir(clientDist, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(root, 'dist/ui.json'), 'utf8'));
for (const file of ['cli.mjs', 'ui.json', manifest.file]) await copyFile(resolve(root, 'dist', file), resolve(clientDist, file));
delete env.TERN_WINDOW_SOCKET; delete env.TERN_WINDOW_KEY;
const fd = openSync(resolve(out, 'tern.log'), 'w');
const daemon = spawn('tern', ['daemon', '--socket', env.TERN_DAEMON_SOCKET], { env, stdio: ['ignore', fd, fd] });
let server; const passed = [], limitations = [], screenshots = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function ctl(command) {
  const r = JSON.parse(execFileSync('tern', ['ctl', '--control', control, command], { env, encoding: 'utf8', timeout: 6000, maxBuffer: 4*1024*1024 }));
  if (!r.ok) throw Error(`${command}: ${r.error}`); return r;
}
const tree = selector => ctl(`tree ${selector}`).nodes ?? [];
async function wait(fn, label) { for (let i = 0; i < 80; i++) { if (await fn()) return; await pause(100); } throw Error(`Timeout: ${label}`); }
const shot = name => { const s = ctl(`shot ${name}`); screenshots.push(s); return s; };
const md = () => tree('.sf-md');
const text = () => md().map(n => n.text ?? '').join('\n');
async function generation() {
  let value;
  const visit = v => {
    if (!v || typeof v !== 'object') return;
    if (typeof v.title === 'string' && v.title.startsWith('{"version":1,')) {
      const s = JSON.parse(v.title); if (typeof s.uiGeneration === 'number') value = s.uiGeneration;
    }
    for (const child of Object.values(v)) if (child && typeof child === 'object') visit(child);
  };
  for (const line of (await readFile(env.TERN_TSP_RECORD, 'utf8')).trim().split('\n')) { try { visit(JSON.parse(line)); } catch {} }
  return value;
}
function visibleProgress(final) {
  for (const token of ['QA_PROGRESS_1','QA_PUBLIC_SUMMARY','QA_PROGRESS_2', ...(final ? ['QA_PLAN','QA_FINAL'] : [])]) {
    const matches = md().filter(n => n.text?.includes(token)); assert.equal(matches.length, 1, token+' renders exactly once');
    const [x,y,w,h] = matches[0].rect;
    assert.ok(w > 0 && h > 0 && y >= 0 && y+h <= 900 && x >= 0, token+' actually in viewport');
    assert.ok(!tree('.ct-activity .sf-md').some(n=>n.text?.includes(token)), token+' outside tool fold');
  }
  assert.ok(!text().includes('QA_HIDDEN_REASONING'), 'raw reasoning content is never rendered');
}
async function evidence(name) {
  shot(name); await writeFile(resolve(out, name+'-tree.json'),JSON.stringify(ctl('tree'),null,2));
}
try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'private daemon');
  server = spawn('tern', ['serve', '--control', control, '--out', out, '--cwd', root], { env, stdio: ['ignore', fd, fd] });
  await wait(() => existsSync(control), 'private offscreen renderer'); ctl('resize 1000 900');
  const quote = s => "'"+s.replaceAll("'", "'\\''")+"'";
  const keys = ['PATH','TERN_CONFIG_DIR','TERN_DAEMON_SOCKET','CODEX_TERN_CONTROL','CODEX_TERN_WEIXIN_DISABLE','WB_DATA_DIR','XDG_STATE_HOME','XDG_CACHE_HOME','CODEX_HOME','QA_CODEX_HOME','QA_RPC_LOG','QA_PROGRESS_RELEASE_FILE','TERN_TSP_RECORD'];
  ctl('run '+JSON.stringify(['env', ...keys.map(k=>`${k}=${env[k]}`),process.execPath,resolve(clientDist,'cli.mjs'),'--codex',resolve(root,'test/fixtures/ui-app-server.mjs')].map(quote).join(' ')));
  await wait(() => tree('[data-role="omp.composer.send"]').length > 0, 'real native owner ready');
  ctl('type "QA_PROGRESS_FIXTURE"'); ctl('key Enter');
  await wait(() => text().includes('正在核对。'), 'streamed progress delta');
  visibleProgress(false); await evidence('streaming-progress');
  const clickToggle = i => { const [x,y,w,h]=tree('.ct-activity-toggle')[i].rect; ctl(`click ${x+w/2} ${y+h/2}`); };
  assert.equal(tree('.ct-activity-preview').length,0,'running work has no output preview');
  assert.equal(tree('[data-role="ct.activity.details"]').length,0,'running work starts collapsed');
  assert.equal(tree('[data-role="ct.activity.meta"]').length,0,'running toggle omits visible counters');
  assert.equal(tree('.ct-activity-indicator').length,0,'running toggle omits leading status housing');
  assert.ok(tree('.ct-activity-toggle').some(n=>n.title?.includes('1 command')),'live count remains available on hover');
  for (const width of [480,1000]) {
    ctl(`resize ${width} 900`);
    for (const toggle of tree('.ct-activity-toggle')) {
      assert.ok(toggle.rect[3] <= 28, 'live toggle stays short at '+width);
      assert.ok(toggle.rect[2] < 240, 'live toggle hugs its label at '+width);
    }
    await evidence('running-collapsed-'+width);
  }
  clickToggle(0); await wait(()=>tree('[data-role="ct.activity.details"]').length===1,'running work opens manually');
  assert.ok(tree('.ct-activity').some(n=>n.text?.includes('QA_TOOL_OUTPUT_ONE')),'live output available on demand');
  await evidence('running-expanded');
  clickToggle(0); await wait(()=>tree('[data-role="ct.activity.details"]').length===0,'running work closes manually');
  ctl('appearance dark'); await pause(150); await evidence('running-dark');
  ctl('appearance light'); await pause(150);
  passed.push('running work uses a short content-width text toggle at 480/1000 pixels, with hover metadata and on-demand output');
  passed.push('real native owner renders commentary and public summary outside tool group during streaming; no hidden reasoning');
  const before = await generation(); assert.equal(typeof before,'number');
  ctl('key Control+Shift+r');
  await wait(async () => (await generation()) > before, 'native UI reload generation advances');
  visibleProgress(false); await evidence('streaming-reloaded');
  await writeFile(env.QA_PROGRESS_RELEASE_FILE, 'finish');
  await wait(() => text().includes('QA_FINAL') && tree('[data-role="omp.composer.stop"]').length === 0, 'terminal fixture');
  visibleProgress(true); assert.equal(tree('[data-role="ct.activity.details"]').length,0,'default tool groups collapsed');
  assert.equal(tree('.ct-activity-toggle').length,2,'tools split at progress boundaries');
  const order = md().filter(n => /QA_PROGRESS_1|QA_PUBLIC_SUMMARY|QA_PROGRESS_2|QA_PLAN|QA_FINAL/.test(n.text??'')).map(n=>n.text);
  assert.deepEqual(order.map(t=>t.match(/QA_PROGRESS_1|QA_PUBLIC_SUMMARY|QA_PROGRESS_2|QA_PLAN|QA_FINAL/)[0]), ['QA_PROGRESS_1','QA_PUBLIC_SUMMARY','QA_PROGRESS_2','QA_PLAN','QA_FINAL']);
  await evidence('finished-collapsed');
  passed.push('terminal default folds hide tools only; progress/summary/plan/final remain ordered and unique');
  for (const i of [0,1]) {
    clickToggle(i); await wait(()=>tree('[data-role="ct.activity.details"]').length===1, 'expanded tool group');
    visibleProgress(true); await evidence('tool-'+i+'-expanded');
    clickToggle(i); await wait(()=>tree('[data-role="ct.activity.details"]').length===0, 'collapsed tool group'); visibleProgress(true);
  }
  passed.push('expanding and collapsing each real native tool group cannot hide progress');
  const ended = await generation(); ctl('key Control+Shift+r');
  await wait(async () => (await generation()) > ended,'terminal reload'); visibleProgress(true);
  assert.equal(tree('[data-role="ct.activity.details"]').length,0);
  await evidence('finished-reloaded');
  const requests = (await readFile(env.QA_RPC_LOG,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(requests.filter(r=>r.method==='turn/start').length,1,'reload does not resend fixture');
  await writeFile(resolve(out,'reload-evidence.json'),JSON.stringify({initialGeneration:before,finalGeneration:await generation(),manifest,turnStartCount:1},null,2));
  passed.push('actual native Ctrl+Shift+R reload path preserves streaming and terminal progress without resending; API version protection unchanged');
} catch (error) {
  limitations.push(error.message); try { await evidence('failed'); } catch {} throw error;
} finally {
  try { ctl('key Control+q'); } catch {} try { ctl('quit'); } catch { server?.kill('SIGTERM'); }
  daemon.kill('SIGTERM'); closeSync(fd); let fixturePids = [];
  try { fixturePids = [...new Set((await readFile(env.QA_RPC_LOG,'utf8')).trim().split('\n').map(s=>JSON.parse(s).pid))]; } catch {}
  const ownedPids = [daemon.pid,server?.pid,...fixturePids].filter(Boolean);
  for(let i=0;i<30&&ownedPids.some(alive);i++) await pause(100);
  for(const pid of ownedPids.filter(alive)) process.kill(pid,'SIGTERM'); await pause(150);
  const remainingPids=ownedPids.filter(alive);
  await writeFile(resolve(out,'results.json'),JSON.stringify({passed,limitations,screenshots,ownedPids,remainingPids,config,control},null,2));
  console.log(`ARTIFACTS ${out}`); assert.deepEqual(remainingPids,[]);
}
