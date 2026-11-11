import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexRpc } from '../src/rpc';
import type { Controller } from '../src/controller';
import { installChiefGuard, reservationProbe } from '../src/weixin-chief-guard';

function fixture(probe: () => Promise<string | null> = async () => 'chief') {
  const calls: any[] = [], owned = new Set(['chief', 'other']);
  const rpc = { options: { cwd: '/tmp' }, ownsThread: (id: string) => owned.has(id), request: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/unsubscribe') { owned.delete(params.threadId); return { status: 'unsubscribed' }; }
    return {};
  } } as unknown as CodexRpc;
  const conversation = { thread: { id: 'chief' }, activeTurn: null, requests: [], queue: [], unconfirmed: [], inflight: undefined, operation: '', hydrated: true, connection: 'ready', changed: () => {} } as any;
  const other = { ...conversation, thread: { id: 'other' }, activeTurn: 'running-other' };
  const notices: string[] = [];
  const c = { operation: '', selecting: false, controlledConversations: () => [conversation, other], flushRecovery: async () => {}, notice: (text: string) => notices.push(text) } as unknown as Controller;
  const guard = installChiefGuard(rpc, probe)!;
  return { rpc, c, guard, calls, owned, conversation, other, notices };
}

test('reserved Chief cannot be resumed, forked or sent input, while other sessions and read-only history work', async () => {
  const f = fixture();
  for (const method of ['thread/resume', 'thread/fork', 'turn/start', 'turn/steer', 'thread/archive'])
    await assert.rejects(f.rpc.request(method as any, { threadId: 'chief' } as any), /微信专用 Chief/);
  assert.equal(f.calls.length, 0);
  await f.rpc.request('thread/read', { threadId: 'chief', includeTurns: false });
  await f.rpc.request('thread/resume', { threadId: 'other' });
  assert.equal(f.calls.length, 2); assert.equal(f.other.activeTurn, 'running-other');
  assert.equal(installChiefGuard(f.rpc, async () => 'different'), f.guard);
});

test('private role marker has no credentials and malformed metadata fails closed; QA must explicitly opt in', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'chief-role-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'weixin'));
  assert.equal(reservationProbe({ QA_CODEX_HOME: dir } as any), undefined);
  const probe = reservationProbe({ WB_DATA_DIR: dir } as any)!; assert.equal(await probe(), null);
  await writeFile(join(dir, 'weixin/chief-reservation.json'), JSON.stringify({ version: 1, role: 'weixin-chief', session: 'chief' }));
  assert.equal(await probe(), 'chief');
  await writeFile(join(dir, 'weixin/chief-reservation.json'), '{'); await assert.rejects(probe(), /读取失败/);
});



test('independent peers and their descendants inherit the live reservation boundary', async () => {
  let reserved = 'chief';
  const calls: string[] = [];
  const make = (): CodexRpc => ({ options: { cwd: '/tmp' }, ownsThread: () => false,
    createPeer: make, request: async (_method: string, params: any) => { calls.push(params.threadId); return {}; }
  } as unknown as CodexRpc);
  const root = make(); installChiefGuard(root, async () => reserved);
  const peer = root.createPeer(), nested = peer.createPeer();
  for (const rpc of [root, peer, nested]) {
    await assert.rejects(rpc.request('thread/resume', { threadId: 'chief' }), /微信专用 Chief/);
    await rpc.request('thread/read', { threadId: 'chief', includeTurns: false });
    await rpc.request('thread/resume', { threadId: 'other' });
  }
  assert.deepEqual(calls, ['chief', 'other', 'chief', 'other', 'chief', 'other']);
  reserved = 'next-chief';
  await assert.rejects(nested.request('turn/start', { threadId: 'next-chief', input: [] }), /微信专用 Chief/);
  await nested.request('thread/resume', { threadId: 'chief' });
});

test('cached and newly received Chief answers are blocked through the same live reservation, including peers', async () => {
  let reserved = 'chief'; const responses: unknown[] = [], listeners = new Map<string, Function[]>();
  const make = (): CodexRpc => ({ options: { cwd: '/tmp' }, ownsThread: () => true,
    request: async () => ({}), createPeer: make,
    on: (name: string, callback: Function) => { listeners.set(name, [...(listeners.get(name) || []), callback]); },
    respond: (id: unknown, result: unknown) => responses.push({ id, result }), rejectRequest: (id: unknown) => responses.push({ id })
  } as unknown as CodexRpc);
  const probe = Object.assign(async () => reserved, { peek: () => reserved });
  const rpc = make(), guard = installChiefGuard(rpc, probe)!;
  await guard.id(); guard.rememberRequests([{ id: 'cached', params: { threadId: 'chief' } }, { id: 2, params: { threadId: 'other' } }]);
  assert.throws(() => rpc.respond('cached', { decision: 'accept' }), /微信专用 Chief/);
  rpc.respond(2, { decision: 'accept' }); assert.equal(responses.length, 1);
  for (const fn of listeners.get('request') || []) fn({ id: 3, params: { threadId: 'chief' } });
  assert.throws(() => rpc.rejectRequest(3, 'deny'), /微信专用 Chief/);
  const peer = rpc.createPeer(), peerGuard = installChiefGuard(peer)!;
  peerGuard.rememberRequests([{ id: 4, params: { threadId: 'next-chief' } }]);
  reserved = 'next-chief';
  assert.throws(() => peer.respond(4, { decision: 'accept' }), /微信专用 Chief/);
  assert.equal(responses.length, 1);
});
