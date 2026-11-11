// Isolated native UI deployment check; never connects a daily daemon/control.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { FileLock } from '@oh-my-pi/pi-natives';
import { prepareTernQaConfig } from './qa-tern-config.mjs';
const root=resolve(import.meta.dirname,'..'), out=resolve(root,'.prototype/weixin-chief',`native-${process.pid}`);
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
  await wait(()=>existsSync(env.TERN_DAEMON_SOCKET),'private daemon');
  server=spawn('tern',['serve','--control',control,'--out',out,'--cwd',root],{env,stdio:['ignore',fd,fd]});
  await wait(()=>existsSync(control),'private renderer');ctl('resize 1000 850');
  const keys=['PATH','TERN_CONFIG_DIR','TERN_DAEMON_SOCKET','CODEX_TERN_CONTROL','CODEX_HOME','QA_CODEX_HOME','QA_HISTORY_FILE','QA_RPC_LOG','WB_DATA_DIR','CODEX_TERN_WEIXIN_RESERVATION_TEST','XDG_STATE_HOME','XDG_CACHE_HOME'];
  ctl('run '+JSON.stringify(['env',...keys.map(k=>`${k}=${env[k]}`),process.execPath,resolve(root,'dist/cli.mjs'),'--native','--codex',resolve(root,'test/fixtures/ui-app-server.mjs')].map(quote).join(' ')));
  await wait(()=>tree('[data-role="omp.composer.send"]').length,'actual owner');
  ctl('type "hold"');ctl('key Enter');await wait(async()=> (await history()).threads[0]?.turns.some(t=>t.status==='inProgress'),'another active thread');
  const other=(await history()).threads[0].id;
  ctl('key Control+Shift+n');await wait(async()=> (await history()).threads.length===2,'idle second thread');
  const chief=(await history()).threads.at(-1).id;
  await writeFile(resolve(env.WB_DATA_DIR,'weixin/chief-reservation.json'),JSON.stringify({version:1,role:'weixin-chief',session:chief}));
  ctl('key Control+Shift+r');await wait(()=>tree('[data-role="ct.weixin-chief.readonly"]').length===1,'same owner reload protection');
  assert.equal(tree('[data-role="omp.composer.send"]').length,0);ctl('shot reserved-readonly');
  const rows=await calls();
  assert.equal(tree('button').filter(n=>n.text?.includes('交回微信后台')).length,0,'unverified release action is not offered');
  ctl('type "must not send to reserved Chief"');ctl('key Enter');await pause(200);
  assert.equal((await calls()).filter(r=>r.method==='turn/start').length,1,'read-only Chief cannot start a turn');
  const ownerPid=rows.find(c=>c.method==='thread/start'&&!c.ephemeral)?.pid;
  assert.ok(ownerPid && alive(ownerPid),'same retained owner alive');
  for(const id of [chief,other]){
    const lock=FileLock.tryAcquire(resolve(env.QA_CODEX_HOME,'thread-writer-locks',id+'.lock'));
    try{assert.equal(lock.acquired,false,'UI reload does not pretend to release existing writer');}finally{lock.release();}
  }
  assert.equal((await history()).threads.find(t=>t.id===other).turns.at(-1).status,'inProgress');
  assert.equal((await calls()).filter(r=>['thread/unsubscribe','turn/interrupt','thread/archive'].includes(r.method)).length,0);
  ctl('shot protected-existing-owner');
  passed.push('actual built entry + same retained ABI8 owner hot reload', 'reserved session cannot compose or send', 'read-only protection does not interrupt any active thread or claim writer release', 'normal client exit remains required for existing owner');
  await writeFile(resolve(out,'evidence.json'),JSON.stringify({passed,chief,other,calls:rows.filter(r=>['thread/start','thread/resume','thread/unsubscribe','turn/interrupt'].includes(r.method)),ownerPid},null,2));
}catch(error){try{ctl('shot failed');await writeFile(resolve(out,'failure.json'),JSON.stringify({error:error.message,tree:ctl('tree')},null,2));}catch{}throw error;}
finally{
  try{ctl('key Control+q');}catch{}try{ctl('quit');}catch{server?.kill('SIGTERM');}daemon.kill('SIGTERM');closeSync(fd);
  const fixturePids=[...new Set((await calls()).map(c=>c.pid))],owned=[daemon.pid,server?.pid,...fixturePids].filter(Boolean);
  for(let i=0;i<40&&owned.some(alive);i++)await pause(100);
  for(const pid of owned.filter(alive))process.kill(pid,'SIGTERM');await pause(100);
  const remainingPids=owned.filter(alive);await writeFile(resolve(out,'results.json'),JSON.stringify({passed,owned,remainingPids,config,control},null,2));
  console.log('ARTIFACTS '+out);assert.deepEqual(remainingPids,[]);
}
