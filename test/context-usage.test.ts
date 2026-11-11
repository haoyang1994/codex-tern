import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { CodexRpc } from '../src/rpc';
import { installContextUsage, contextUsageLabel } from '../src/context-usage';

function setup() {
  const rpc = new EventEmitter();
  const store = installContextUsage(rpc as CodexRpc);
  const update = (threadId: string, used: unknown, capacity: unknown) => rpc.emit('notification', {
    method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: {
      total: { totalTokens: 900000 }, last: { totalTokens: used, cachedInputTokens: 40000 }, modelContextWindow: capacity,
    } },
  });
  return { rpc, store, update };
}

test('uses the last native estimate and capacity, includes cache, and shrinks after compaction', () => {
  const { store, update } = setup();
  update('one', 48200, 200000);
  assert.equal(contextUsageLabel(store.get('one'), 'zh-CN').text, '上下文 48.2k / 200k · 24.1%');
  update('one', 24000, 200000);
  assert.equal(contextUsageLabel(store.get('one'), 'en').text, 'Context 24k / 200k · 12%');
});

test('per-thread usage survives compatible UI reload without adding duplicate listeners', () => {
  const { rpc, store, update } = setup();
  update('one', 50000, 200000); update('two', 100000, 400000);
  assert.equal(installContextUsage(rpc as CodexRpc), store);
  assert.equal(rpc.listenerCount('notification'), 1);
  assert.deepEqual(store.get('one'), { used: 50000, capacity: 200000 });
  assert.deepEqual(store.get('two'), { used: 100000, capacity: 400000 });
  rpc.emit('disconnected'); assert.equal(store.get('one'), undefined);
});

test('unknown and invalid values never imply zero use, guessed model limits or a percentage', () => {
  const { store, update } = setup();
  assert.equal(contextUsageLabel(store.get('missing'), 'en').text, 'Context — / — · —%');
  update('one', 45000, null);
  assert.equal(contextUsageLabel(store.get('one'), 'en').text, 'Context 45k / — · —%');
  update('one', -1, 0);
  assert.deepEqual(store.get('one'), { used: null, capacity: null });
  update('one', NaN, Infinity);
  assert.deepEqual(store.get('one'), { used: null, capacity: null });
  update('one', 0, 200000);
  assert.equal(contextUsageLabel(store.get('one'), 'en').text, 'Context 0 / 200k · 0%');
});
