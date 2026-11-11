import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnOwnedRpcChild, closeOwnedRpcChild } from '../src/owned-rpc-process';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
function fixture(t: any, code: string, owned = true) {
  const child = owned ? spawnOwnedRpcChild('node', ['-e', code], { cwd: process.cwd(), env: { ...process.env } }) : spawn('node', ['-e', code], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  t.after(async () => {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    for (let n = 0; n < 80 && alive(-child.pid!); n++) await delay(25);
    assert.equal(alive(-child.pid!), false, 'all isolated fixture processes must be reaped');
  });
  return child;
}
const ready = async (child: import('node:child_process').ChildProcessWithoutNullStreams) => Number((await once(child.stdout, 'data'))[0].toString().trim());

test('closing a native wrapper waits for its stubborn grandchild; concurrent cancel is idempotent and unrelated processes survive', async t => {
  const other = fixture(t, "console.log(process.pid);setInterval(()=>{},1000)"); await ready(other);
  const wrapper = fixture(t, `const {spawn}=require('node:child_process');
    const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
    c.stdout.pipe(process.stdout);process.on('SIGTERM',()=>{if(!c.killed)c.kill('SIGTERM')});c.on('exit',()=>process.exit(0));`);
  const native = await ready(wrapper);
  const closing = closeOwnedRpcChild(wrapper);
  assert.equal(closeOwnedRpcChild(wrapper), closing);
  assert.deepEqual(await closing, undefined);
  assert.equal(alive(native), false); assert.equal(alive(-wrapper.pid!), false);
  assert.equal(alive(other.pid!), true);
  assert.equal(closeOwnedRpcChild(wrapper), closing, 'finished cleanup never signals a stale group again');
  await closeOwnedRpcChild(other);
});

test('an already exited wrapper does not hide a remaining native writer', async t => {
  const wrapper = fixture(t, `const {spawn}=require('node:child_process');
    const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
    c.stdout.once('data',x=>{process.stdout.write(x);process.exit(0)});`);
  const native = await ready(wrapper);
  if (wrapper.exitCode === null) await once(wrapper, 'exit');
  assert.equal(wrapper.exitCode, 0); assert.equal(alive(native), true);
  assert.deepEqual(await closeOwnedRpcChild(wrapper), undefined);
  assert.equal(alive(native), false); assert.equal(alive(-wrapper.pid!), false);
});

test('cleanup refuses an unregistered process instead of inferring ownership from its PID', async t => {
  const unrelated = fixture(t, "console.log(process.pid);setInterval(()=>{},1000)", false); await ready(unrelated);
  await assert.rejects(closeOwnedRpcChild(unrelated), /unowned app-server/);
  assert.equal(alive(unrelated.pid!), true);
});

test('failed spawn has no group and cleanup does not signal the caller', async () => {
  const child = spawnOwnedRpcChild('/private/tmp/weixin-no-such-executable-cleanup-fixture', [], { cwd: process.cwd(), env: { ...process.env } });
  await once(child, 'error');
  assert.deepEqual(await closeOwnedRpcChild(child), undefined);
});
