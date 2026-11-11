import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Node, Session, Surface } from '@stencil-hq/tern';
import { Controller } from '../src/controller';
import { NativeUI } from '../src/ui';
import type { CodexRpc } from '../src/rpc';

const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
function setup() {
  const transport = Object.assign(new EventEmitter(), {
    request: async () => ({ turnId: 'turn' }),
  });
  const c = new Controller(transport as unknown as CodexRpc, '/tmp');
  c.thread = { id: 'thread' } as any; c.connection = 'ready'; c.notifications = false;
  const session = { caps: { cols: 100, dark: false, reduceMotion: false, kinds: [], features: [], cell: { w: 8 } },
    close: async () => {} } as unknown as Session;
  let frame: { main: Node; dock: Node };
  const surface = { closed: false, stylesheet: () => {}, focus: () => {},
    render: (view: typeof frame) => { frame = view; } } as unknown as Surface;
  const ui = new NativeUI(c, session, surface);
  const emit = (method: string, params: object) => transport.emit('notification', {
    method, params: { threadId: 'thread', turnId: 'turn', ...params },
  });
  const item = (id: string, type: string, extra: object = {}, done = true) => emit(done ? 'item/completed' : 'item/started', {
    item: { id, type, ...extra },
  });
  const render = () => {
    ui.render();
    const main = nodes(frame.main), dock = nodes(frame.dock);
    return {
      states: main.filter(n => n.props.role === 'ct.activity.state').map(n => n.props.text),
      spinners: [...main, ...dock].filter(n => n.kind === 'spinner').length,
      stop: dock.some(n => n.props.role === 'omp.composer.stop'),
      previews: main.filter(n => n.props.class === 'ct-activity-preview').length,
    };
  };
  emit('turn/started', { turn: { id: 'turn', status: 'inProgress', items: [] } });
  item('command', 'commandExecution', { command: 'echo ready', status: 'completed', exitCode: 0 });
  item('question', 'agentMessage', { phase: 'final_answer', text: 'Should I change the core rules too?' });
  const working = () => { ui.render(); return nodes(frame.dock).find(n => n.props.role === 'omp.working'); };
  return { ui, c, session, transport, emit, item, render, working, main: () => frame.main };
}

test('a delivered answer and later steering keep activity live until the turn completes', async t => {
  const { ui, c, emit, item, render } = setup(); t.after(() => ui.close());
  assert.deepEqual(render(), { states: ['Activity'], spinners: 1, stop: true, previews: 0 });

  await c.submit('Keep the current core calculus');
  item('steer', 'userMessage', { content: [{ type: 'text', text: 'Keep the current core calculus' }] });
  item('reasoning', 'reasoning', { summary: [] }, false);
  assert.deepEqual(render(), { states: ['Worked', 'Activity'], spinners: 1, stop: true, previews: 0 });

  // Finishing individual items still does not finish the turn.
  item('reasoning', 'reasoning', { summary: ['Checking the source rules.'] });
  item('answer', 'agentMessage', { phase: 'final_answer', text: 'The source rules are updated.' });
  assert.deepEqual(render(), { states: ['Activity'], spinners: 1, stop: true, previews: 0 });

  emit('turn/completed', { turn: { id: 'turn', status: 'completed', items: [] } });
  assert.deepEqual(render(), { states: ['View activity', 'View activity'], spinners: 0, stop: false, previews: 0 });
});

test('input requested after an answer stays visible and returns to Working when resolved', t => {
  const { ui, transport, emit, item, render } = setup(); t.after(() => ui.close());
  item('reasoning', 'reasoning', { summary: [] }, false);
  transport.emit('request', { id: 42, method: 'item/tool/requestUserInput',
    params: { threadId: 'thread', turnId: 'turn', questions: [] } });
  assert.deepEqual(render(), { states: ['Worked', 'Needs input'], spinners: 0, stop: true, previews: 0 });
  emit('serverRequest/resolved', { requestId: 42 });
  assert.deepEqual(render(), { states: ['Worked', 'Activity'], spinners: 1, stop: true, previews: 0 });
});

test('continued work shows its actual terminal status after an earlier answer', async t => {
  for (const [status, label] of [['interrupted', 'Stopped'], ['failed', 'Failed'], ['disconnected', 'Disconnected']]) {
    await t.test(status, t => {
      const { ui, transport, emit, item, render } = setup(); t.after(() => ui.close());
      item('reasoning', 'reasoning', { summary: ['Checking the source rules.'] }, false);
      item('continued-command', 'commandExecution', { command: 'echo continuing', status: 'inProgress' }, false);
      assert.equal(render().states.at(-1), 'Activity');
      if (status === 'disconnected') transport.emit('disconnected', 'Codex disconnected');
      else emit('turn/completed', { turn: { id: 'turn', status, items: [] } });
      const result = render();
      assert.equal(result.states.at(-1), label);
      assert.equal(result.spinners, 0); assert.equal(result.stop, false); assert.equal(result.previews, 0);
    });
  }
});

test('the dock shows work before any activity arrives and while an answer streams', t => {
  const { ui, c, session, item, working, render } = setup(); t.after(() => ui.close());
  c.items = [];
  assert.ok(working());
  assert.deepEqual(render(), { states: [], spinners: 1, stop: true, previews: 0 });
  item('answer', 'agentMessage', { phase: 'final_answer', text: 'A streaming answer' }, false);
  assert.ok(working());
  (session.caps as { reduceMotion: boolean }).reduceMotion = true;
  assert.equal(nodes(working()!).filter(n => n.kind === 'shimmer').length, 0);
  c.activeTurn = null;
  assert.equal(working(), undefined);
});

test('interleaved commentary streams in order, then collapses with work when the turn completes', t => {
  const { ui, c, emit, item, render, main } = setup(); t.after(() => ui.close());
  c.items = [];
  item('before', 'agentMessage', { phase: 'commentary', text: 'I will inspect the release request.' });
  item('tool-a', 'commandExecution', { command: 'echo first', status: 'completed', exitCode: 0 });
  item('progress', 'agentMessage', { phase: 'commentary', text: 'I found ', }, false);
  emit('item/agentMessage/delta', { itemId: 'progress', delta: 'the release.' });
  item('progress', 'agentMessage', { phase: 'commentary', text: 'I found the release.' });
  item('tool-b', 'commandExecution', { command: 'echo second', status: 'completed', exitCode: 0 });
  item('final', 'agentMessage', { phase: 'final_answer', text: 'Release checks are complete.' });
  render();
  assert.deepEqual(nodes(main()).filter(n => n.kind === 'md').map(n => n.props.text),
    ['I will inspect the release request.', 'I found the release.', 'Release checks are complete.']);
  emit('turn/completed', { turn: { id: 'turn', status: 'completed', items: [] } }); render();
  const blocks = main().children.map(wrapper => wrapper.children[0]!);
  assert.deepEqual(blocks.map(n => n.props.role === 'omp.assistant' ? 'assistant' : n.props.class === 'ct-activity' ? 'tools' : 'result'),
    ['tools', 'assistant', 'result']);
  assert.equal(nodes(main()).filter(n => n.props.role === 'ct.activity.details').length, 0, 'tools are collapsed');
  assert.deepEqual(nodes(main()).filter(n => n.kind === 'md').map(n => n.props.text),
    ['Release checks are complete.']);
  assert.equal(c.items.filter(i => i.item.id === 'progress').length, 1);
});


test('public streamed summary and plan collapse on completion without exposing hidden reasoning', t => {
  const { ui, c, emit, item, render, main } = setup(); t.after(() => ui.close()); c.items = [];
  item('command-a', 'commandExecution', { command: 'echo first', status: 'completed' });
  item('summary', 'reasoning', { summary: [], content: ['HIDDEN_REASONING'] }, false);
  emit('item/reasoning/summaryTextDelta', { itemId: 'summary', summaryIndex: 0, delta: 'Public progress' });
  render();
  assert.ok(nodes(main()).some(n => n.kind === 'md' && n.props.text === 'Public progress'));
  item('summary', 'reasoning', { summary: ['Public progress'], content: ['HIDDEN_REASONING'] });
  item('plan', 'plan', { text: 'Public plan progress' });
  item('command-b', 'commandExecution', { command: 'echo second', status: 'completed' });
  emit('turn/completed', { turn: { id: 'turn', status: 'completed', items: [] } }); render();
  const visible = nodes(main());
  assert.equal(visible.filter(n => n.props.role === 'ct.activity.details').length, 0);
  assert.deepEqual(visible.filter(n => n.kind === 'md').map(n => n.props.text), []);
  assert.equal(JSON.stringify(main()).includes('HIDDEN_REASONING'), false);
});

test('completion resets previously expanded work and preserves expandable progress across restored turns', async t => {
  const { ui, c, emit, item, render, main } = setup(); t.after(() => ui.close());
  const click = async () => {
    const toggle = nodes(main()).find(n => String(n.props.class).split(' ').includes('ct-activity-toggle'))!;
    await toggle.handlers!.onClick!({ ev: 'action', sf: 'test', id: 'toggle', act: 'click', raw: {} });
  };
  render(); await click();
  assert.equal(nodes(main()).filter(n => n.props.role === 'ct.activity.details').length, 1);
  // The earlier work is no longer the latest activity, but its expanded state
  // must still reset when the entire turn finishes.
  item('summary', 'reasoning', { summary: [] }, false); render(); await click();
  item('summary', 'reasoning', { summary: ['Public summary'] });
  item('progress', 'agentMessage', { phase: 'commentary', text: 'Saved progress' });
  item('final', 'agentMessage', { phase: 'final_answer', text: 'Final reply' });
  emit('turn/completed', { turn: { id: 'turn', status: 'completed', items: [] } }); render();
  assert.equal(nodes(main()).filter(n => n.props.role === 'ct.activity.details').length, 0);
  assert.deepEqual(nodes(main()).filter(n => n.kind === 'md').map(n => n.props.text), ['Final reply']);
  await click();
  assert.deepEqual(nodes(main()).filter(n => n.kind === 'md').map(n => n.props.text),
    ['Should I change the core rules too?', 'Public summary', 'Saved progress', 'Final reply']);
  await click();
  // Model a restored history page followed by a different live turn.
  c.items = c.items.map(entry => ({ ...entry, done: true }));
  emit('turn/started', { turn: { id: 'next', status: 'inProgress', items: [] } });
  emit('item/completed', { turnId: 'next', item: { id: 'next-progress', type: 'agentMessage', phase: 'commentary', text: 'Next live progress' } });
  render();
  assert.deepEqual(nodes(main()).filter(n => n.kind === 'md').map(n => n.props.text), ['Final reply', 'Next live progress']);
});

test('completed work uses a short localized duration and a trailing chevron', t => {
  const { ui, c, emit, render, main } = setup(); t.after(() => ui.close());
  c.preferences.language = 'zh-CN';
  emit('turn/completed', { turn: { id: 'turn', status: 'completed', durationMs: 194000, items: [] } }); render();
  const toggle = nodes(main()).find(n => String(n.props.class).includes('ct-activity-toggle-quiet'))!;
  assert.deepEqual(toggle.children.map(n => n.props.text ?? n.props.role), ['用时 3m 14s', 'ct.activity.chevron']);
  assert.equal(nodes(toggle).some(n => n.props.class === 'ct-activity-indicator' || n.props.role === 'ct.activity.meta'), false);
  emit('turn/completed', { turn: { id: 'turn', status: 'completed', durationMs: 768000, items: [] } }); render();
  assert.ok(nodes(main()).some(n => n.props.text === '用时 12m 48s'));
});

test('live tool output stays folded across updates while counts, errors and manual disclosure remain usable', async t => {
  const { ui, c, emit, item, render, main } = setup(); t.after(() => ui.close()); c.items = [];
  item('live-command', 'commandExecution', { command: 'echo LIVE_OUTPUT', status: 'inProgress', aggregatedOutput: 'LIVE_OUTPUT' }, false);
  const visible = () => nodes(main());
  const toggle = () => visible().find(n => String(n.props.class).split(' ').includes('ct-activity-toggle'))!;
  const click = async () => toggle().handlers!.onClick!({ ev: 'action', sf: 'test', id: 'toggle', act: 'click', raw: {} });
  render();
  assert.equal((toggle().props.attrs as Record<string, boolean>)['aria-expanded'], false);
  assert.equal(JSON.stringify(main()).includes('LIVE_OUTPUT'), false, 'command and output stay inside details');
  assert.ok(String(toggle().props.title).includes('1 command'));
  assert.deepEqual(toggle().children.map(n => n.props.role), ['ct.activity.state', 'ct.activity.chevron']);
  assert.equal(visible().some(n => n.props.role === 'ct.activity.meta' || n.props.class === 'ct-activity-indicator'), false);
  emit('item/commandExecution/outputDelta', { itemId: 'live-command', delta: '\nSTREAMED_OUTPUT' }); render();
  assert.equal(JSON.stringify(main()).includes('STREAMED_OUTPUT'), false, 'streaming never opens the fold');
  await click();
  assert.equal((toggle().props.attrs as Record<string, boolean>)['aria-expanded'], true);
  assert.ok(visible().some(n => n.kind === 'code' && String(n.props.text).includes('STREAMED_OUTPUT')));
  emit('item/commandExecution/outputDelta', { itemId: 'live-command', delta: '\nLATER_OUTPUT' }); render();
  assert.equal((toggle().props.attrs as Record<string, boolean>)['aria-expanded'], true, 'streaming preserves manual expansion');
  assert.ok(visible().some(n => n.kind === 'code' && String(n.props.text).includes('LATER_OUTPUT')));
  await click();
  item('live-command', 'commandExecution', { command: 'echo LIVE_OUTPUT', status: 'completed', exitCode: 0, aggregatedOutput: 'LATER_OUTPUT' });
  item('failed-command', 'commandExecution', { command: 'false', status: 'completed', exitCode: 1 }); render();
  assert.equal((toggle().props.attrs as Record<string, boolean>)['aria-expanded'], false);
  assert.ok(String(toggle().props.title).includes('2 commands') && String(toggle().props.title).includes('has errors'));
  assert.ok(visible().some(n => n.kind === 'icon' && n.props.name === 'warn'));
  item('final', 'agentMessage', { phase: 'final_answer', text: 'Final reply' });
  emit('turn/completed', { turn: { id: 'turn', status: 'completed', items: [] } }); render();
  assert.equal((toggle().props.attrs as Record<string, boolean>)['aria-expanded'], false);
  assert.deepEqual(visible().filter(n => n.kind === 'md').map(n => n.props.text), ['Final reply']);
});

test('opening completed activity leaves each command closed until selected and resets them on reopening', async t => {
  const { ui, c, emit, item, render, main } = setup(); t.after(() => ui.close()); c.items = [];
  c.preferences.language = 'zh-CN';
  item('first', 'commandExecution', { command: 'echo first', status: 'completed', exitCode: 0, aggregatedOutput: 'FIRST_OUTPUT' });
  // Terminal history may lack an individual item/completed event.
  item('second', 'commandExecution', { command: 'false', status: 'inProgress', exitCode: 1, aggregatedOutput: 'SECOND_OUTPUT' }, false);
  item('final', 'agentMessage', { phase: 'final_answer', text: 'Final reply' });
  emit('turn/completed', { turn: { id: 'turn', status: 'completed', items: [] } }); render();
  const visible = () => nodes(main());
  const parent = () => visible().find(n => String(n.props.class).split(' ').includes('ct-activity-toggle'))!;
  const commands = () => visible().filter(n => String(n.props.class).split(' ').includes('ct-command-toggle'));
  const click = async (node: Node) => node.handlers!.onClick!({ ev: 'action', sf: 'test', id: 'toggle', act: 'click', raw: {} });
  const output = () => visible().filter(n => n.kind === 'code').map(n => n.props.text);
  await click(parent());
  assert.equal(commands().length, 2);
  assert.deepEqual(output(), []);
  assert.deepEqual(visible().filter(n => n.props.role === 'ct.command.state').map(n => n.props.text), ['运行了命令', '运行了命令']);
  assert.ok(nodes(commands()[1]!).some(n => n.kind === 'icon' && n.props.name === 'warn'));
  await click(commands()[0]!);
  assert.deepEqual(output(), ['FIRST_OUTPUT']);
  await click(commands()[1]!);
  assert.deepEqual(output(), ['FIRST_OUTPUT', 'SECOND_OUTPUT']);
  await click(commands()[0]!);
  assert.deepEqual(output(), ['SECOND_OUTPUT']);
  await click(parent()); await click(parent());
  assert.deepEqual(output(), [], 'reopening the parent does not reopen previously selected commands');
  assert.deepEqual(visible().filter(n => n.kind === 'md').map(n => n.props.text), ['Final reply']);
});
