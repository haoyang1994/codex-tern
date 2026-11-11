import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Node, Session, Surface } from '@stencil-hq/tern';
import { Controller } from '../src/controller';
import { NativeUI, UI_API_VERSION } from '../src/ui';
import { NativeHost } from '../src/native-host';
import type { CodexRpc } from '../src/rpc';

function setup() {
  const transport = Object.assign(new EventEmitter(), { request: async () => ({ data: [] }) });
  const c = new Controller(transport as unknown as CodexRpc, '/tmp');
  c.thread = { id: 'one' } as any; c.connection = 'ready'; c.notifications = false;
  let frame: { main: Node; dock: Node };
  const session = { caps: { cols: 100, cell: { w: 8, h: 16 }, kinds: [], features: [] }, close: async () => {} } as unknown as Session;
  const surface = { closed: false, stylesheet: () => {}, focus: () => {}, render: (view: typeof frame) => { frame = view; } } as unknown as Surface;
  const ui = new NativeUI(c, session, surface);
  const emit = (method: string, params: object, id = 'one') => transport.emit('notification', { method, params: { threadId: id, ...params } });
  const finish = (turn = 'a', status = 'completed', id = 'one') => emit('turn/completed', { turn: { id: turn, status, items: [] } }, id);
  const start = (turn = 'a', id = 'one') => emit('turn/started', { turn: { id: turn, status: 'inProgress', items: [] } }, id);
  let fullyVisible: string[] = [], offset = 0;
  (ui as any).inspectResult = async () => ({ fullyVisible, visible: fullyVisible,
    position: { anchor: { id: 'main.result:a', offset }, following: false } });
  const inspect = () => (ui as any).readVisibleResult() as Promise<void>;
  const visible = (turn = 'a') => { fullyVisible = [`main.result:${turn}`]; };
  return { c, ui, emit, transport, start, finish, inspect, visible, frame: () => frame!, scroll: () => { offset -= 40; } };
}

test('completion, selection, visibility and refresh alone cannot consume a result', async t => {
  const { c, ui, start, finish, inspect, visible } = setup(); t.after(() => ui.close());
  start(); ui.render(); ui.noteInteraction(); // Old interaction belongs to the running turn.
  finish(); visible(); ui.render(); ui.setVisible(true); c.changed(); ui.render();
  await inspect(); await inspect();
  assert.equal(c.sessionStatus('one').completed, true);
  ui.noteInteraction(); await inspect();
  assert.equal(c.sessionStatus('one').completed, false);
  assert.equal(c.sessionResult('one')?.turnId, 'a', 'reading keeps the rendered status/scroll anchor stable');
});

test('result must be rendered and fully visible; hidden panes and open panels preserve unread', async t => {
  const { c, ui, finish, inspect, visible } = setup(); t.after(() => ui.close());
  finish(); ui.noteInteraction(); ui.render(); visible(); await inspect();
  assert.ok(c.unreadResult('one'), 'interaction before result render is stale');
  ui.setVisible(false); ui.noteInteraction(); await inspect();
  ui.setVisible(true); await inspect(); assert.ok(c.unreadResult('one'));
  ui.panel = 'details'; ui.noteInteraction(); await inspect(); ui.panel = null;
  await inspect(); assert.ok(c.unreadResult('one'));
  ui.noteInteraction(); await inspect(); assert.equal(c.unreadResult('one'), undefined);
});

test('scrolling after the terminal layout reaches its visible result and clears only that result', async t => {
  const { c, ui, finish, inspect, visible, scroll } = setup(); t.after(() => ui.close());
  finish(); ui.render(); await inspect();
  ui.noteInteraction(); await inspect(); assert.ok(c.unreadResult('one'), 'old messages are still in view');
  scroll(); visible(); await inspect(); assert.equal(c.unreadResult('one'), undefined);
  finish('b', 'failed'); ui.render(); visible('b'); await inspect();
  assert.equal(c.sessionStatus('one').failed, true, 'old read and old interaction cannot clear a new failure');
  ui.noteInteraction(); await inspect(); assert.equal(c.sessionStatus('one').failed, false);
});

test('settled native scroll changes count as interaction without TOC or key events', async t => {
  const { c, ui, finish, inspect, visible, scroll } = setup(); t.after(() => ui.close());
  finish(); ui.render(); await inspect(); scroll(); visible(); await inspect();
  assert.equal(c.unreadResult('one'), undefined);
});

test('work and waiting survive reads, resolve independently and new work lights again', async t => {
  const { c, ui, transport, start, finish, emit, inspect, visible } = setup(); t.after(() => ui.close());
  start(); ui.render(); ui.noteInteraction(); visible(); await inspect(); assert.equal(c.sessionStatus('one').running, true);
  transport.emit('request', { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'one', turnId: 'a', questions: [] } });
  ui.render(); ui.noteInteraction(); await inspect(); assert.equal(c.sessionStatus('one').waiting, true);
  emit('serverRequest/resolved', { requestId: 1 }); assert.equal(c.sessionStatus('one').waiting, false);
  finish(); ui.render(); ui.noteInteraction(); await inspect(); assert.equal(c.sessionStatus('one').completed, false);
  start('b'); assert.equal(c.sessionStatus('one').running, true); assert.equal(c.sessionResult('one'), undefined);
});

test('a late inspection cannot read another session, newer result, or replaced UI', async t => {
  const { c, ui, finish, inspect, visible } = setup(); t.after(() => ui.close());
  finish(); ui.render(); visible(); ui.noteInteraction();
  let resolve!: (value: any) => void;
  (ui as any).inspectResult = () => new Promise(done => { resolve = done; });
  const reading = inspect();
  finish('b', 'failed'); ui.render();
  resolve({ fullyVisible: ['main.result:a'] }); await reading;
  assert.equal(c.sessionStatus('one').failed, true);
  const event = c.unreadResult('one')!;
  finish('other', 'completed', 'two');
  c.markRead('two', c.unreadResult('two')!); assert.ok(c.unreadResult('two'), 'background session cannot be read');
  ui.noteInteraction(); const closing = inspect(); ui.disposeForReload();
  resolve({ fullyVisible: ['main.result:b'] }); await closing; assert.equal(c.unreadResult('one'), event);
});

test('terminal marker appears after failure details, and native scroll baseline resets on a render', async t => {
  const { c, ui, finish, inspect, visible, scroll, frame } = setup(); t.after(() => ui.close());
  finish('a', 'failed'); ui.render(); await inspect();
  scroll(); visible(); ui.render(); await inspect(); assert.ok(c.unreadResult('one'));
  assert.equal(frame().main.children.at(-1)!.props.key, 'result:a');
});

test('selecting an existing result counts only after navigation; a result during navigation stays unread', async t => {
  const { c, ui, finish, inspect, visible } = setup(); t.after(() => ui.close());
  finish(); ui.render(); visible();
  (ui as any).navigate = async () => true;
  await ui.openSession('one', false); await inspect(); assert.ok(c.unreadResult('one'), 'external navigation is not user interaction');
  assert.equal(await ui.openSession('one'), true); await inspect(); assert.equal(c.unreadResult('one'), undefined);
  (ui as any).navigate = async () => { finish('b'); ui.render(); return true; };
  await ui.openSession('one'); visible('b'); await inspect(); assert.ok(c.unreadResult('one'));
});

test('native pointer dispatch counts user actions but excludes bridge polling', async t => {
  const { c, ui, finish } = setup(); t.after(() => ui.close());
  ui.surface.dispatch = () => () => {};
  const host = new NativeHost(c, ui.session, ui.surface, { NativeUI, UI_API_VERSION }); t.after(() => host.close());
  finish(); host.current.render();
  (host.current as any).inspectResult = async () => ({ fullyVisible: ['main.result:a'] });
  await ui.surface.dispatch({ ev: 'action', sf: 's1', id: 'dock.sessions', act: 'refresh', raw: {} })?.();
  await (host.current as any).readVisibleResult(); assert.ok(c.unreadResult('one'));
  await ui.surface.dispatch({ ev: 'action', sf: 's1', id: 'main.result:a', act: 'click', raw: {} })?.();
  await (host.current as any).readVisibleResult(); assert.equal(c.unreadResult('one'), undefined);
});

test('UI reload retains unread results but discards prior interaction and viewport baselines', async t => {
  const { c, ui, finish, visible } = setup(); t.after(() => ui.close());
  const host = new NativeHost(c, ui.session, ui.surface, { NativeUI, UI_API_VERSION }); t.after(() => host.close());
  finish(); host.current.render(); visible(); host.current.noteInteraction();
  const before = c.unreadResult('one'); await host.reload();
  (host.current as any).inspectResult = async () => ({ fullyVisible: ['main.result:a'] });
  await (host.current as any).readVisibleResult(); assert.equal(c.unreadResult('one'), before);
});


test('terminal read anchor adds no visible completion text and leaves real errors visible', async t => {
  const { ui, c, finish, frame } = setup(); t.after(() => ui.close());
  c.notices.push({ id: 1, error: true, text: 'Actual execution error' });
  finish('a', 'failed'); ui.render();
  const nodes = (n: Node): Node[] => [n, ...n.children.flatMap(nodes)];
  const marker = nodes(frame().main).find(n => n.props.role === 'ct.turn.result')!;
  assert.ok(marker); assert.deepEqual(marker.props.attrs, { 'aria-hidden': true });
  assert.equal(nodes(marker).some(n => n.props.text), false);
  assert.equal(nodes(frame().main).some(n => n.props.text === 'Task complete' || n.props.text === 'Task failed'), false);
  assert.ok(nodes(frame().main).some(n => n.props.text === 'Actual execution error'));
});

test('footer shows live context usage and keeps its estimate after compatible UI replacement', async t => {
  const { ui, c, emit, frame, transport } = setup(); t.after(() => ui.close());
  await c.preferences.setLanguage('zh-CN');
  emit('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 48200 }, total: { totalTokens: 900000 }, modelContextWindow: 200000 } });
  ui.render();
  const nodes = (n: Node): Node[] => [n, ...n.children.flatMap(nodes)];
  let footer = nodes(frame().dock).find(n => n.props.role === 'ct.context.usage')!;
  assert.ok(JSON.stringify(footer).includes('上下文 48.2k / 200k · 24.1%'));
  const listeners = transport.listenerCount('notification');
  const host = new NativeHost(c, ui.session, ui.surface, { NativeUI, UI_API_VERSION }); t.after(() => host.close());
  await host.reload(); host.current.render();
  footer = nodes(frame().dock).find(n => n.props.role === 'ct.context.usage')!;
  assert.ok(JSON.stringify(footer).includes('上下文 48.2k / 200k · 24.1%'));
  assert.equal(transport.listenerCount('notification'), listeners);
});


test('selected visible completion is quiet while another session still gets its notification', async t => {
  const { ui, c, finish, frame } = setup(); t.after(() => ui.close());
  c.notifications = true;
  const notices: string[] = []; ui.notify = e => notices.push(e.threadId);
  finish(); ui.render();
  assert.deepEqual(notices, []);
  const nodes = (n: Node): Node[] => [n, ...n.children.flatMap(nodes)];
  assert.equal(nodes(frame().dock).some(n => n.props.role === 'ct.completion'), false);
  finish('b', 'completed', 'two'); ui.render();
  assert.deepEqual(notices, ['two']);
  assert.equal(nodes(frame().dock).some(n => n.props.role === 'ct.completion'), true);
});
