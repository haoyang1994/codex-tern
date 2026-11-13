import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnUsageTracker } from '../src/turn-usage';
const event = (input: number, cached: number, lastInput: number, lastCached: number) => ({
  total: { inputTokens: input, cachedInputTokens: cached }, last: { inputTokens: lastInput, cachedInputTokens: lastCached },
});
test('sums per-turn cumulative deltas and ignores repeated notifications', () => {
  const u = new TurnUsageTracker();
  u.begin('one'); u.update('one', event(100, 40, 100, 40));
  u.update('one', event(250, 140, 150, 100)); u.update('one', event(250, 140, 150, 100)); u.finish('one');
  assert.deepEqual(u.completed.get('one'), { input: 250, cached: 140 });
  u.begin('two'); u.update('two', event(550, 340, 300, 200)); u.finish('two');
  assert.deepEqual(u.completed.get('two'), { input: 300, cached: 200 });
});
test('resumed thread counts its first new request without counting prior thread history', () => {
  const u = new TurnUsageTracker(); u.begin('new'); u.update('new', event(9000, 5000, 200, 100)); u.finish('new');
  assert.deepEqual(u.completed.get('new'), { input: 200, cached: 100 });
});
test('unknown, invalid, and interrupted event streams are not reported as complete', () => {
  const u = new TurnUsageTracker(); u.begin('missing'); u.finish('missing');
  u.begin('bad'); u.update('bad', event(100, 50, 100, 50)); u.update('bad', event(50, 25, 50, 25)); u.finish('bad');
  u.begin('disconnect'); u.update('disconnect', event(100, 50, 100, 50)); u.disconnect(); u.finish('disconnect');
  assert.equal(u.completed.size, 0);
});

test('shows current turn cache percentage and whole-turn output speed only with valid samples', async () => {
  const { turnMetrics } = await import('../src/turn-usage');
  const u = new TurnUsageTracker(); u.begin('one');
  u.update('one', { total: { inputTokens: 200, cachedInputTokens: 101, outputTokens: 20 }, last: { inputTokens: 200, cachedInputTokens: 101, outputTokens: 20 } });
  assert.equal(turnMetrics(u.current('one'), 4000, 'zh-CN')?.text, '缓存 50.5% · 均速 5.0 t/s');
  u.update('one', { total: { inputTokens: 300, cachedInputTokens: 151, outputTokens: 40 }, last: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 } });
  u.finish('one');
  assert.deepEqual(u.completed.get('one'), { input: 300, cached: 151, output: 40 });
  assert.equal(turnMetrics(u.completed.get('one'), 4000, 'en')?.text, 'Cache 50.3% · Avg 10.0 t/s');
  assert.equal(turnMetrics({input: 300, cached: 151}, 4000, 'zh-CN')?.text, '缓存 50.3%');
  assert.equal(turnMetrics({input: 0, cached: 0, output: 1}, 4000, 'zh-CN'), undefined);
  assert.equal(turnMetrics({input: 100, cached: 0, output: 1}, 0, 'zh-CN')?.text, '缓存 0.0%');
});
