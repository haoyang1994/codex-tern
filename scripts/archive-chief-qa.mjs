// Isolated native UI deployment check; never connects a daily daemon/control.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { FileLock } from '@oh-my-pi/pi-natives';
import { prepareTernQaConfig } from './qa-tern-config.mjs';
const root=resolve(import.meta.dirname,'..'), out=resolve(root,'.prototype/weixin-chief',`archive-${process.pid}`);
const config=resolve(out,'config'),control=resolve(out,'control.sock');
await prepareTernQaConfig(config);await mkdir(resolve(out,'codex/thread-writer-locks'),{recursive:true});await mkdir(resolve(out,'workbench/weixin'),{recursive:true});
const env={...process.env,PATH:`${dirname(process.execPath)}:${process.env.PATH}`,TERN_CONFIG_DIR:config,TERN_DAEMON_SOCKET:resolve(out,'daemon.sock'),
  CODEX_TERN_CONTROL:control,CODEX_HOME:resolve(out,'codex'),QA_CODEX_HOME:resolve(out,'codex'),QA_HISTORY_FILE:resolve(out,'history.json'),QA_RPC_LOG:resolve(out,'rpc.jsonl'),
  WB_DATA_DIR:resolve(out,'workbench'),CODEX_TERN_WEIXIN_RESERVATION_TEST:'1',XDG_STATE_HOME:resolve(out,'state'),XDG_CACHE_HOME:resolve(out,'cache')};
delete env.TERN_WINDOW_SOCKET;delete env.TERN_WINDOW_KEY;delete env.TERN_PANE;delete env.CODEX_TERN_WEIXIN_DISABLE;
await mkdir(resolve(config,'plugins'),{recursive:true});await writeFile(resolve(config,'plugins/codex-tern.path'),resolve(root,'tern-plugin'));
const fd=openSync(resolve(out,'tern.log'),'w'),daemon=spawn('tern',['daemon','--socket',env.TERN_DAEMON_SOCKET],{env,stdio:['ignore',fd,fd]});let server;
const passed=[];const pause=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
function ctl(command){const r=JSON.parse(execFileSync('tern',['ctl','--control',control,command],{env,encoding:'utf8',timeout:6000,maxBuffer:4*1024*1024}));if(!r.ok)throw Error(`${command}: ${r.error}`);return r;}
const tree=selector=>ctl(`tree ${selector}`).nodes??[];
const calls=async()=>{try{return (await readFile(env.QA_RPC_LOG,'utf8')).trim().split('\n').map(JSON.parse);}catch{return [];}};
const history=async()=>JSON.parse(await readFile(env.QA_HISTORY_FILE,'utf8'));
async function wait(fn,label){for(let i=0;i<100;i++){if(await fn())return;await pause(100);}throw Error('Timeout: '+label);}
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
try{
  const rows=['ordinary','chief','other'].map((id,i)=>({id,cwd:root,name:id,preview:id,createdAt:100-i,updatedAt:100-i,recencyAt:100-i,
    turns:[{id:'turn-'+id,status:'completed',items:[{id:'answer-'+id,type:'agentMessage',phase:'final_answer',text:'History '+id}]}]}));
  await writeFile(env.QA_HISTORY_FILE,JSON.stringify({seq:0,threads:rows}));
  await writeFile(resolve(env.WB_DATA_DIR,'weixin/chief-reservation.json'),JSON.stringify({version:1,role:'weixin-chief',session:'chief'}));
  await wait(()=>existsSync(env.TERN_DAEMON_SOCKET),'private daemon');
  server=spawn('tern',['serve','--control',control,'--out',out,'--cwd',root],{env,stdio:['ignore',fd,fd]});
  await wait(()=>existsSync(control),'private renderer');ctl('resize 1000 850');
  const keys=['PATH','TERN_CONFIG_DIR','TERN_DAEMON_SOCKET','CODEX_TERN_CONTROL','CODEX_HOME','QA_CODEX_HOME','QA_HISTORY_FILE','QA_RPC_LOG','WB_DATA_DIR','CODEX_TERN_WEIXIN_RESERVATION_TEST','XDG_STATE_HOME','XDG_CACHE_HOME'];
  ctl('run '+JSON.stringify(['env',...keys.map(k=>`${k}=${env[k]}`),process.execPath,resolve(root,'dist/cli.mjs'),'--native','--resume','ordinary','--codex',resolve(root,'test/fixtures/ui-app-server.mjs')].map(quote).join(' ')));
  await wait(()=>tree('[data-role="omp.composer.send"]').length,'actual owner');
  function action(act,value=''){
    const lua=`local t=cx.session:surface("@focused",{root="dock.sessions",nodes=2,max_chars=64000}); return cx.session:event("@focused",{sf=t.surface.id,ev="action",id="dock.sessions",act=${JSON.stringify(act)},value=${JSON.stringify(value)}})`;
    ctl('carly lua '+JSON.stringify(lua));
  }
  action('refresh');await pause(400);
  await wait(async()=> (await calls()).some(c=>c.method==='thread/resume'&&c.threadId==='ordinary'),'ordinary selected');
  await pause(200);action('archive','ordinary');
  await wait(async()=> (await history()).threads.find(t=>t.id==='ordinary')?.archived,'ordinary archived despite Chief neighbour');await pause(200);
  assert.ok((await calls()).some(c=>c.method==='thread/resume'&&c.threadId==='other'));
  ctl('shot ordinary-archived');
  passed.push('actual native archive action skips adjacent reserved Chief and selects the next ordinary session');
  const starts=(await calls()).filter(c=>c.method==='thread/start'&&!c.ephemeral).length;
  action('archive','other');
  await wait(async()=> (await history()).threads.find(t=>t.id==='other')?.archived,'last ordinary archived');await pause(200);
  assert.equal((await calls()).filter(c=>c.method==='thread/start'&&!c.ephemeral).length,starts+1);
  assert.equal(tree('[data-role="omp.composer.send"]').length,1);
  action('archive','chief');await pause(200);
  assert.equal((await history()).threads.find(t=>t.id==='chief')?.archived,undefined);
  assert.equal((await calls()).filter(c=>c.threadId==='chief'&&['thread/resume','thread/archive','turn/start'].includes(c.method)).length,0);
  ctl('shot blank-after-last-ordinary');
  passed.push('only reserved Chief remains: create a blank ordinary session, never resume or archive Chief');
  await writeFile(resolve(out,'evidence.json'),JSON.stringify({passed,calls:(await calls()).filter(c=>['thread/resume','thread/archive','thread/start'].includes(c.method)),threads:(await history()).threads.map(t=>({id:t.id,archived:t.archived}))},null,2));
}catch(error){try{ctl('shot failed');await writeFile(resolve(out,'failure.json'),JSON.stringify({error:error.message,tree:ctl('tree')},null,2));}catch{}throw error;}
finally{
  try{ctl('key Control+q');}catch{}try{ctl('quit');}catch{server?.kill('SIGTERM');}daemon.kill('SIGTERM');closeSync(fd);
  const fixturePids=[...new Set((await calls()).map(c=>c.pid))],owned=[daemon.pid,server?.pid,...fixturePids].filter(Boolean);
  for(let i=0;i<40&&owned.some(alive);i++)await pause(100);
  for(const pid of owned.filter(alive))process.kill(pid,'SIGTERM');await pause(100);
  const remainingPids=owned.filter(alive);await writeFile(resolve(out,'results.json'),JSON.stringify({passed,owned,remainingPids,config,control},null,2));
  console.log('ARTIFACTS '+out);assert.deepEqual(remainingPids,[]);
}
