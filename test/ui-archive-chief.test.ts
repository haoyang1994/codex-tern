import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Session, Surface } from '@stencil-hq/tern';
import type { CodexRpc } from '../src/rpc';
import { Controller } from '../src/controller';
import { NativeUI } from '../src/ui';
import { installChiefGuard } from '../src/weixin-chief-guard';

function fixture(ids: string[]) {
  const calls: { method: string; params: any }[] = [];
  const rpc = Object.assign(new EventEmitter(), {
    options: { cwd: '/tmp' }, ownsThread: () => false,
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'thread/start' || method === 'thread/resume')
        return { thread: { id: params.threadId || 'new', cwd: '/tmp', name: params.threadId || 'new' }, cwd: '/tmp' };
      return { data: [], nextCursor: null };
    },
  }) as unknown as CodexRpc;
  installChiefGuard(rpc, async () => 'chief');
  const c = new Controller(rpc, '/tmp');
  c.thread = { id: 'selected', cwd: '/tmp', name: 'Selected ordinary conversation' } as any;
  c.connection = 'ready'; c.notifications = false;
  const session = { caps: { cols: 100, dark: false, reduceMotion: false, kinds: [], features: [], cell: { w: 8 } }, close: async () => {} } as unknown as Session;
  const surface = { closed: false, stylesheet: () => {}, focus: () => {}, render: () => {} } as unknown as Surface;
  const ui = new NativeUI(c, session, surface);
  (ui as any).folderSessions.threads = ids.map(id => ({ id, cwd: '/tmp', name: id, updatedAt: 1 }));
  return { c, ui, calls, archive: (id = 'selected') => (ui as any).archiveSession(id) };
}

test('archiving an ordinary selected row skips its reserved Chief neighbour and opens the next ordinary row', async t => {
  const f = fixture(['selected', 'chief', 'other']); t.after(() => f.ui.close());
  await f.archive();
  assert.equal(f.c.isArchived('selected'), true);
  assert.equal(f.c.thread?.id, 'other');
  assert.deepEqual(f.calls.filter(c => ['thread/resume', 'thread/archive'].includes(c.method)), [
    { method: 'thread/resume', params: { threadId: 'other', excludeTurns: true } },
    { method: 'thread/archive', params: { threadId: 'selected' } },
  ]);
  assert.equal(f.calls.some(c => c.params?.threadId === 'chief'), false);
});

test('when only the Chief remains, archiving creates a blank ordinary session without falling back to a cached Chief', async t => {
  const f = fixture(['selected', 'chief']); t.after(() => f.ui.close());
  await assert.rejects(f.c.resume('chief'), /微信专用 Chief/);
  f.calls.length = 0;
  await f.archive();
  assert.equal(f.c.isArchived('selected'), true);
  assert.equal(f.c.thread?.id, 'new');
  assert.deepEqual(f.calls.map(c => c.method), ['thread/start', 'thread/archive']);
  assert.equal(f.calls.some(c => c.params?.threadId === 'chief'), false);
});

test('archiving a background ordinary row does not resume or archive the reserved Chief', async t => {
  const f = fixture(['selected', 'chief', 'other']); t.after(() => f.ui.close());
  await f.archive('other');
  assert.equal(f.c.isArchived('other'), true);
  assert.equal(f.c.thread?.id, 'selected');
  assert.deepEqual(f.calls, [{ method: 'thread/archive', params: { threadId: 'other' } }]);
  await assert.rejects(f.archive('chief'), /微信专用 Chief/);
  assert.equal(f.c.isArchived('chief'), false);
  assert.equal(f.calls.length, 1);
});
