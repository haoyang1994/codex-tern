// Run with bun (the native owner requires Bun).
// Isolated real native owner + deterministic protocol fixture; never touches daily Tern.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile, realpath, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareTernQaConfig } from './qa-tern-config.mjs';
const root = resolve(import.meta.dirname, '..'), out = resolve(root, '.prototype/commentary-entry', `native-${process.pid}`);
const config = resolve(out, 'config'), control = resolve(out, 'control.sock');
await prepareTernQaConfig(config); await mkdir(resolve(out, 'codex/thread-writer-locks'), { recursive: true });
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, TERN_CONFIG_DIR: config,
  TERN_DAEMON_SOCKET: resolve(out, 'daemon.sock'), CODEX_TERN_CONTROL: control, CODEX_TERN_WEIXIN_DISABLE: '1',
  WB_DATA_DIR: resolve(out, 'workbench'), XDG_STATE_HOME: resolve(out, 'state'), XDG_CACHE_HOME: resolve(out, 'cache'),
  CODEX_HOME: resolve(out, 'codex'), QA_CODEX_HOME: resolve(out, 'codex'), QA_RPC_LOG: resolve(out, 'rpc.jsonl'), QA_HISTORY_FILE: resolve(out, 'history.json'), QA_PROGRESS_RELEASE_FILE: resolve(out, 'release-progress'), TERN_TSP_RECORD: resolve(out, 'wire.jsonl') };
await mkdir(resolve(config, 'plugins'), { recursive: true });
await writeFile(resolve(config, 'plugins/codex-tern.path'), resolve(root, 'tern-plugin'));
const entry = resolve(process.env.CODEX_TERN_QA_ENTRY || resolve(root, 'bin/codex-tern'));
assert.equal(await realpath(entry), resolve(root, 'bin/codex-tern'), 'verify the requested executable points to this checkout');
const manifest = JSON.parse(await readFile(resolve(root, 'dist/ui.json'), 'utf8'));
const uiFile = resolve(root, 'dist', manifest.file);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(await readFile(uiFile)), manifest.file.slice(3,-4), 'actual UI contents match immutable hash');
await writeFile(resolve(out, 'actual-entry.json'), JSON.stringify({entry, realpath:await realpath(entry), cli:resolve(root,'dist/cli.mjs'), cliHash:hash(await readFile(resolve(root,'dist/cli.mjs'))), manifest, uiHash:hash(await readFile(uiFile))},null,2));
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
const phrase = '收到，普通对话和任务完成通知两条链路都需要查。';
const md = () => tree('.sf-md');
const text = () => md().map(n => n.text ?? '').join('\n');
function visibleCommentary(final = false) {
  const matches = md().filter(n=>n.text?.includes(phrase)); assert.equal(matches.length,1,'real commentary visible exactly once');
  const [x,y,w,h] = matches[0].rect; assert.ok(w>0 && h>0 && x>=0 && y>=0 && y+h<=900,'actual commentary in viewport');
  assert.ok(!tree('.ct-activity .sf-md').some(n=>n.text?.includes(phrase)),'commentary is outside outer activity group');
  assert.ok(!text().includes('QA_RAW_REASONING_MUST_STAY_HIDDEN'));
  if(final) assert.equal(md().filter(n=>n.text?.includes('QA_COMMENTARY_FINAL')).length,1,'final once');
}
async function evidence(name) { shot(name); await writeFile(resolve(out,name+'-tree.json'),JSON.stringify(ctl('tree'),null,2)); }
async function selectionText() {
  ctl('carly lua '+JSON.stringify('local s=cx.session:selection(nil,{max_chars=2000}); return s and s.text or ""'));
  ctl('wait 150'); const result=ctl('state').carly?.last_tool;
  assert.ok(result && !result.error, 'private native selection query');
  const value=result.text.split('→ ').at(-1);
  return value.startsWith('"') ? JSON.parse(value) : value;
}
async function pasted(expected,name) {
  ctl('click [data-role="omp.editor"] .sf-editor');ctl('key Meta+v');let actual;
  await wait(async()=>{
    for(const f of await readdir(resolve(out,'state/codex-tern/recovery')))if(f.endsWith('.json')) {
      const d=JSON.parse(await readFile(resolve(out,'state/codex-tern/recovery',f),'utf8'));
      actual=d.sessions?.find(s=>s.id===d.selected)?.draft.text;if(actual===expected)return true;
    }return false;
  },name+' clipboard exact value');
  await writeFile(resolve(out,name+'.json'),JSON.stringify({expected,actual,transport:'private native selection -> Tern memory clipboard -> private owner draft'},null,2));
  ctl('key Meta+a');ctl('key Backspace');
}
async function verifyCopies() {
  const paragraph=tree('[data-role="omp.assistant"] .sf-md p').find(n=>n.text?.includes(phrase));assert.ok(paragraph);
  const[x,y,,h]=paragraph.rect;
  const select=async()=>{ctl(`dblclick ${x+60} ${y+h/4}`);const selected=await selectionText();assert.ok(selected.length>0 && selected.length<20,'several selected Chinese characters, not whole block');return selected;};
  let selected=await select();ctl('key Meta+c');await pasted(selected,'actual-entry-cmd-copy');
  selected=await select();ctl(`click ${x+60} ${y+h/4} right`);await evidence('actual-entry-copy-menu');
  const pick=label=>{const n=tree('[role="menuitem"]').find(n=>n.text===label);assert.ok(n,label);const[a,b,w,h]=n.rect;ctl(`click ${a+w/2} ${b+h/2}`);};
  pick('Copy');await pause(300);await pasted(selected,'actual-entry-context-copy');
  await select();ctl(`click ${x+60} ${y+h/4} right`);pick('Copy entire Markdown');await pasted(paragraph.text,'actual-entry-whole-copy');
  // Ctrl+C intentionally retains the application's stop/exit semantics.
  passed.push('actual entry Chinese commentary selection: Cmd+C and ordinary Copy exact; explicit whole-block action only copies full text');
}
async function generation() {
  let value;
  const visit = v => {
    if(!v || typeof v!=='object')return;
    if(typeof v.title==='string' && v.title.startsWith('{"version":1,')) { const s=JSON.parse(v.title); if(typeof s.uiGeneration==='number')value=s.uiGeneration; }
    for(const child of Object.values(v))if(child && typeof child==='object')visit(child);
  };
  for(const line of (await readFile(env.TERN_TSP_RECORD,'utf8')).trim().split('\n'))try{visit(JSON.parse(line));}catch{}
  return value;
}
try {
  await wait(()=>existsSync(env.TERN_DAEMON_SOCKET),'private daemon');
  server=spawn('tern',['serve','--control',control,'--out',out,'--cwd',root],{env,stdio:['ignore',fd,fd]});
  await wait(()=>existsSync(control),'private offscreen renderer'); ctl('resize 1000 900');
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  const keys=['PATH','TERN_CONFIG_DIR','TERN_DAEMON_SOCKET','CODEX_TERN_CONTROL','CODEX_TERN_WEIXIN_DISABLE','WB_DATA_DIR','XDG_STATE_HOME','XDG_CACHE_HOME','CODEX_HOME','QA_CODEX_HOME','QA_RPC_LOG','QA_HISTORY_FILE','QA_PROGRESS_RELEASE_FILE','TERN_TSP_RECORD'];
  const launch=extra=>ctl('run '+JSON.stringify(['env',...keys.map(k=>`${k}=${env[k]}`),process.execPath,entry,'--native','--codex',resolve(root,'test/fixtures/ui-app-server.mjs'),...extra].map(quote).join(' ')));
  launch([]); await wait(()=>tree('[data-role="omp.composer.send"]').length>0,'checkout entry owner ready');
  ctl('type "QA_COMMENTARY_FIXTURE"'); ctl('key Enter');
  await wait(()=>text().includes(phrase),'actual agentMessage commentary delta'); visibleCommentary(); await evidence('actual-entry-streaming');
  const before=await generation(); ctl('key Control+Shift+r');
  await wait(async()=>await generation()>before,'compatible native hot reload'); visibleCommentary(); await evidence('actual-entry-streaming-reloaded');
  await writeFile(env.QA_PROGRESS_RELEASE_FILE,'finish');
  await wait(()=>text().includes('QA_COMMENTARY_FINAL') && tree('[data-role="omp.composer.stop"]').length===0,'terminal commentary fixture');
  visibleCommentary(true); assert.equal(tree('[data-role="ct.activity.details"]').length,0);
  assert.equal(tree('.ct-activity-toggle').length,2,'six commands split into 1+5 around commentary');
  await evidence('actual-entry-collapsed');
  passed.push('verified executable entry renders real streamed commentary once outside tool folds; hot reload keeps it visible');
  const toggle=i=>{const[x,y,w,h]=tree('.ct-activity-toggle')[i].rect;ctl(`click ${x+w/2} ${y+h/2}`);};
  for(const i of [0,1]) {toggle(i);await wait(()=>tree('[data-role="ct.activity.details"]').length===1,'expanded actual tools');visibleCommentary(true);await evidence('actual-entry-expanded-'+i);toggle(i);await wait(()=>tree('[data-role="ct.activity.details"]').length===0,'collapsed actual tools');visibleCommentary(true);}
  passed.push('screenshot-matching commentary stays visible when either native tool group is expanded or collapsed');
  const history=JSON.parse(await readFile(env.QA_HISTORY_FILE,'utf8')), thread=history.threads.find(t=>t.turns.some(t=>t.items.some(i=>i.id==='real-commentary')));
  assert.ok(thread); const saved=thread.turns.flatMap(t=>t.items).find(i=>i.id==='real-commentary');assert.equal(saved.phase,'commentary');
  ctl('key Control+q'); await wait(()=>tree('[data-role="omp.composer.send"]').length===0,'private owner closed');
  const firstPids=[...new Set((await readFile(env.QA_RPC_LOG,'utf8')).trim().split('\n').map(s=>JSON.parse(s).pid))];
  await wait(()=>firstPids.every(pid=>!alive(pid)),'first private backend exited');
  await wait(()=>ctl('state').focused?.prompt,'private shell ready before relaunch');
  ctl('ready');
  launch(['--resume',thread.id]); await wait(()=>text().includes('QA_COMMENTARY_FINAL'),'history restored via same actual entry');
  visibleCommentary(true);assert.equal(tree('[data-role="ct.activity.details"]').length,0);await evidence('actual-entry-history-collapsed');
  toggle(1);await wait(()=>tree('[data-role="ct.activity.details"]').length===1,'history tools expanded');visibleCommentary(true);await evidence('actual-entry-history-expanded');
  toggle(1);await wait(()=>tree('[data-role="ct.activity.details"]').length===0,'history tools collapsed again');visibleCommentary(true);
  const calls=(await readFile(env.QA_RPC_LOG,'utf8')).trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(calls.filter(r=>r.method==='turn/start').length,1,'reload and recovery do not duplicate send');
  assert.ok(calls.some(r=>r.method==='thread/resume') && calls.some(r=>r.method==='thread/turns/list'));
  await writeFile(resolve(out,'protocol-evidence.json'),JSON.stringify({savedCommentary:saved,turnStartCount:1,threadId:thread.id,resumeCalls:calls.filter(r=>r.method==='thread/resume').length,historyCalls:calls.filter(r=>r.method==='thread/turns/list').length,commands:6},null,2));
  passed.push('new native owner restores real agentMessage commentary from thread/resume + turns/list; expanded/collapsed history remains visible once; no raw reasoning');
  await verifyCopies();
} catch(error) {limitations.push(error.message);try{await evidence('failed');}catch{}throw error;}
finally {
  try{ctl('key Control+q');}catch{}try{ctl('quit');}catch{server?.kill('SIGTERM');}
  daemon.kill('SIGTERM');closeSync(fd);let fixturePids=[];
  try{fixturePids=[...new Set((await readFile(env.QA_RPC_LOG,'utf8')).trim().split('\n').map(s=>JSON.parse(s).pid))];}catch{}
  const ownedPids=[daemon.pid,server?.pid,...fixturePids].filter(Boolean);
  for(let i=0;i<30&&ownedPids.some(alive);i++)await pause(100);
  for(const pid of ownedPids.filter(alive))process.kill(pid,'SIGTERM');await pause(150);
  const remainingPids=ownedPids.filter(alive);
  await writeFile(resolve(out,'results.json'),JSON.stringify({passed,limitations,screenshots,ownedPids,remainingPids,config,control},null,2));
  console.log(`ARTIFACTS ${out}`);assert.deepEqual(remainingPids,[]);
}
