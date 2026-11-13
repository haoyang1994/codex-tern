import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Controller } from '../src/controller';
import { RecoveryStore } from '../src/recovery';
import type { CodexRpc } from '../src/rpc';

for (const retired of [true, false]) test(`automatic recovery ${retired ? 'skips retired' : 'retains legacy'} Chief selection`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'chief-recovery-'));
  await mkdir(join(dir, 'weixin'));
  await writeFile(join(dir, 'weixin/chief-reservation.json'), JSON.stringify({ version: 1, role: 'weixin-chief', session: 'chief', ...(retired ? { retired: true } : {}) }));
  const previous = process.env.WB_DATA_DIR, previousQA = process.env.QA_CODEX_HOME;
  process.env.WB_DATA_DIR = dir; delete process.env.QA_CODEX_HOME;
  t.after(async () => { if (previous === undefined) delete process.env.WB_DATA_DIR; else process.env.WB_DATA_DIR = previous;
    if (previousQA !== undefined) process.env.QA_CODEX_HOME = previousQA; await rm(dir, { recursive: true, force: true }); });
  const calls: string[] = [];
  const rpc = Object.assign(new EventEmitter(), { start: async () => {}, connected: true,
    request: async (method: string, params: any) => {
      calls.push(method);
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || 'new', cwd: '/tmp', turns: [] }, cwd: '/tmp' };
      if (method === 'model/list' || method === 'thread/turns/list') return { data: [], nextCursor: null };
      return {};
    } }) as unknown as CodexRpc;
  const store = await RecoveryStore.open(join(dir, 'recovery.json'));
  store.update({ id: 'chief', cwd: '/tmp', name: 'old', draft: { text: '', images: [] }, queue: [], unconfirmed: [] });
  store.select('chief');
  const c = new Controller(rpc, '/tmp'); c.useRecovery(store);
  await c.connect();
  assert.equal(c.thread?.id, retired ? 'new' : 'chief');
  assert.equal(calls.includes(retired ? 'thread/resume' : 'thread/start'), false);
  assert.ok(store.session('chief'));
});
