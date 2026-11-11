import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Session, Surface } from '@stencil-hq/tern';
import { parseCommand, commandHelp, commandCompletions } from '../src/commands';
import { Controller } from '../src/controller';
import { NativeUI } from '../src/ui';
import { Draft } from '../src/draft';
import { Completion } from '../src/completion';
import { Skills, type SkillInput } from '../src/skills';
import { Preferences } from '../src/preferences';
import { RecoveryStore } from '../src/recovery';
import { FolderSessions } from '../src/folder-sessions';
import { CodexRpc, RpcOutcomeUnknown } from '../src/rpc';
import { validateResult } from '../src/protocol';

const cwd = '/tmp';
const skill = (name = 'demo', path = '/skills/demo/SKILL.md', enabled = true) =>
  ({ name, path, enabled, description: `Use ${name}`, scope: 'user' as const, pluginId: null });
const input: SkillInput = { type: 'skill', name: 'demo', path: '/skills/demo/SKILL.md' };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(preferences = new Preferences()) {
  const calls: { method: string; params: any }[] = [];
  let seq = 0, closed = 0;
  const rpc = Object.assign(new EventEmitter(), {
    ownsThread: () => false,
    respond: (_id: unknown, _result: unknown) => {},
    request: async (method: string, params: any): Promise<any> => {
      calls.push({ method, params });
      if (method === 'skills/list') return { data: [{ cwd: params.cwds[0], skills: [skill()], errors: [] }] };
      if (method === 'thread/start' || method === 'thread/resume') return {
        thread: { id: params.threadId ?? `created-${++seq}`, cwd: params.cwd ?? cwd, name: 'Saved', preview: '', updatedAt: 1 }, cwd: params.cwd ?? cwd, model: 'demo-model',
      };
      if (method === 'turn/start') return { turn: { id: `turn-${++seq}` } };
      if (method === 'thread/list' || method === 'thread/turns/list') return { data: [], nextCursor: null };
      return {};
    },
  });
  const c = new Controller(rpc as unknown as CodexRpc, cwd, preferences);
  c.connection = 'ready'; c.thread = { id: 'original', cwd, name: 'Saved', updatedAt: 20 } as any;
  const ui = new NativeUI(c, { close: async () => { closed++; } } as unknown as Session,
    { closed: true, stylesheet() {}, focus() {} } as unknown as Surface);
  return { c, rpc, ui, calls, closed: () => closed };
}

test('shared command registry handles aliases and arguments while paths, attachments and multiline remain text', () => {
  for (const text of ['/exit', '/quit', ' /quit  ']) assert.deepEqual(parseCommand(text), { kind: 'command', name: 'exit', args: '' });
  assert.deepEqual(parseCommand('/resume abc'), { kind: 'command', name: 'resume', args: 'abc' });
  for (const text of ['/tmp', '/tmp/notes', '/a.md', '/help\nmore', 'explain /exit', '$demo /help']) assert.equal(parseCommand(text).kind, 'text');
  assert.equal(parseCommand('/exit', ['image']).kind, 'text');
  assert.equal(parseCommand('/unknown-command').kind, 'error');
  assert.equal(parseCommand('/help arguments').kind, 'error');
  assert.equal(parseCommand('/reconnect').kind, 'error');
  assert.deepEqual(parseCommand('/queue  exact text  ', [], true), { kind: 'command', name: 'queue', args: ' exact text  ' });
  assert.match(commandHelp(true), /\/reply/); assert.match(commandHelp(), /\/quit/);
  assert.ok(commandCompletions('zh-CN').some(c => c.name === 'skills' && c.description === '技能'));
});

test('native commands open existing panels, choose language/model and stop without model input', async t => {
  const { ui, c, calls } = setup(); t.after(() => ui.close());
  for (const [text, panel] of [['/help', 'help'], ['/resume', 'history'], ['/model', 'models'], ['/status', 'details'], ['/language', 'language'], ['/skills demo', 'skills']]) {
    ui.draft.set(text!); await ui.send(); assert.equal(ui.panel, panel); assert.equal(ui.draft.text, '');
    (ui as any).closePanel();
  }
  c.models.push({ model: 'other', hidden: false } as any);
  ui.draft.set('/model other'); await ui.send(); assert.equal(c.model, 'other');
  ui.draft.set('/language zh-CN'); await ui.send(); assert.equal(c.preferences.language, 'zh-CN');
  c.activeTurn = 'working'; ui.draft.set('/stop'); await ui.send();
  assert.ok(calls.some(c => c.method === 'turn/interrupt' && c.params.turnId === 'working'));
  assert.ok(!calls.some(c => c.method === 'turn/start' || c.method === 'turn/steer'));
});

test('native new/resume reuse navigation, unknown/invalid commands retain text and images bypass commands', async t => {
  const { ui, c, calls } = setup(); t.after(() => ui.close());
  ui.draft.set('/new'); await ui.send(); assert.match(c.thread!.id, /^created-/);
  ui.draft.set('/resume original'); await ui.send(); assert.equal(c.thread!.id, 'original');
  for (const text of ['/unknown-command', '/help arg', '/language invalid', '/model unavailable']) {
    ui.draft.set(text); await ui.send(); assert.equal(ui.draft.text, text);
  }
  ui.draft.set('/exit'); ui.images = ['/tmp/image.png']; await ui.send();
  assert.deepEqual(calls.find(x => x.method === 'turn/start')!.params.input, [
    { type: 'text', text: '/exit', text_elements: [] }, { type: 'localImage', path: '/tmp/image.png' },
  ]);
});

test('help/exit work offline and question answers containing commands never execute them', async t => {
  const { ui, c, closed } = setup(); t.after(() => ui.close());
  const request = { id: 'q', method: 'item/tool/requestUserInput', params: {}, answers: {} };
  c.requests.push(request); ui.answerTarget = { requestId: 'q', questionId: 'question' };
  ui.draft.set('/exit'); await ui.send(); assert.deepEqual(request.answers, { question: ['/exit'] }); assert.equal(closed(), 0);
  c.connection = 'disconnected'; ui.draft.set('/help'); await ui.send(); assert.equal(ui.panel, 'help');
  (ui as any).closePanel(); ui.draft.set('/quit'); await ui.send(); assert.equal(closed(), 1);
});

test('slash autocomplete Enter executes the selected native action once', async t => {
  const { ui, c, calls } = setup(); t.after(() => ui.close());
  ui.draft.setWorkspace(cwd, c.skills);
  ui.draft.key({ name: '/', text: '/', ctrl: false, alt: false, meta: false, shift: false });
  await tick(); assert.equal(ui.draft.completing, true);
  ui.draft.key({ name: 'h', text: 'h', ctrl: false, alt: false, meta: false, shift: false });
  ui.draft.key({ name: 'e', text: 'e', ctrl: false, alt: false, meta: false, shift: false });
  await tick(); ui.handleKey({ name: 'enter', ctrl: false, alt: false, meta: false, shift: false }); await tick();
  assert.equal(ui.panel, 'help'); assert.ok(!calls.some(c => c.method === 'turn/start'));
});

test('skills RPC scopes cwd, filters disabled paths, reports scan errors and refreshes additions', async t => {
  const { c, rpc, ui, calls } = setup(); t.after(() => ui.close());
  const request = rpc.request;
  rpc.request = async (method, params) => method === 'skills/list'
    ? { data: [{ cwd, skills: [skill(), skill('disabled', '/disabled', false)], errors: [{ path: '/broken', message: 'Invalid YAML' }] }] }
    : request(method, params);
  assert.deepEqual((await c.skills.list()).map(s => s.name), ['demo']); assert.match(c.skills.error, /Invalid YAML/);
  rpc.request = request; await c.skills.list(); assert.deepEqual(calls.at(-1), { method: 'skills/list', params: { cwds: [cwd], forceReload: true } });
  rpc.request = async () => ({ data: [{ cwd, skills: [skill(), skill('new-skill', '/new')], errors: [] }] });
  assert.equal((await c.skills.list()).length, 2);
  assert.throws(() => validateResult('skills/list', { data: [{ cwd, skills: [{}], errors: [] }] }));
});

test('skill discovery coalesces reads and rejects late results from a different cwd or invalidation', async () => {
  let workspace = cwd, calls = 0;
  const first = deferred(), second = deferred();
  const rpc = { request: () => (++calls === 1 ? first.promise : second.promise) } as unknown as CodexRpc;
  const catalog = new Skills(rpc, () => workspace, () => {});
  const a = catalog.list(); const duplicate = catalog.list(); await tick(); assert.equal(calls, 1);
  workspace = '/tmp/other'; const b = catalog.list();
  second.resolve({ data: [{ cwd: workspace, skills: [skill('other')], errors: [] }] }); await b;
  first.resolve({ data: [{ cwd, skills: [skill('stale')], errors: [] }] });
  await assert.rejects(a, /workspace changed/); await assert.rejects(duplicate, /workspace changed/);
  assert.equal(catalog.items[0]!.name, 'other');
  const late = deferred(); (rpc as any).request = () => late.promise;
  const stale = catalog.list(); await tick(); catalog.invalidate(); late.resolve({ data: [{ cwd: workspace, skills: [skill()], errors: [] }] });
  await assert.rejects(stale, /workspace changed/); assert.equal(catalog.items.length, 0);
});

test('same-name skills require a chosen exact path; disabled and removed selections cannot send', async t => {
  const { c, rpc, ui } = setup(); t.after(() => ui.close());
  rpc.request = async () => ({ data: [{ cwd, skills: [skill(), skill('demo', '/other/SKILL.md')], errors: [] }] });
  await assert.rejects(c.skills.resolve('$demo do it'), /Choose a path/);
  assert.deepEqual(await c.skills.resolve('$demo do it', [input]), [input]);
  assert.deepEqual(await c.skills.resolve('Use ($demo), keep $HOME and $PROJECT_ROOT unchanged.', [input]), [input]);
  assert.deepEqual(await c.skills.resolve('$demo.', [input]), [input]);
  rpc.request = async () => ({ data: [{ cwd, skills: [skill('demo', input.path, false)], errors: [] }] });
  await assert.rejects(c.skills.resolve('$demo do it', [input]), /unavailable/);
  ui.draft.set('$demo keep this'); ui.images = ['/tmp/attached']; ui.draft.selectSkill(input); await ui.send();
  assert.equal(ui.draft.text, '$demo keep this'); assert.deepEqual(ui.images, ['/tmp/attached']);
});

test('$ autocomplete inserts text and binds the path; picker selection preserves draft and attachment', async t => {
  const { c, ui } = setup(); t.after(() => ui.close());
  const provider = new Completion(cwd, 'en', c.skills, s => ui.draft.selectSkill(s));
  const suggestions = await provider.getSuggestions(['Use $de'], 0, 7);
  assert.equal(suggestions!.items[0]!.label, '$demo');
  const applied = provider.applyCompletion(['Use $de next'], 0, 7, suggestions!.items[0]!, '$de');
  assert.equal(applied.lines[0], 'Use $demo  next'); ui.draft.set(applied.lines[0]!); (applied as any).onApplied(); assert.deepEqual(ui.draft.selectedSkills, [input]);
  const draft = new Draft(); draft.setWorkspace(cwd, c.skills); draft.set('$de'); await tick(); assert.equal(draft.completing, true);
  draft.key({ name: 'tab', ctrl: false, alt: false, meta: false, shift: false }); await tick();
  assert.equal(draft.text, '$demo '); assert.deepEqual(draft.selectedSkills, [input]);
  ui.draft.set('Original text'); ui.images = ['/tmp/attachment'];
  (ui as any).openPanel('skills'); await tick(); (ui as any).pickerSelected = input.path; (ui as any).activatePicker();
  assert.equal(ui.draft.text, 'Original text $demo '); assert.deepEqual(ui.images, ['/tmp/attachment']); assert.deepEqual(ui.draft.selectedSkills, [input]);
});

test('start, steer and local queue carry text, attachments and exact skill input; retries restore snapshots', async t => {
  const { c, rpc, ui, calls } = setup(); t.after(() => ui.close());
  const text = '  $demo 用原文\nnext line  ', images = ['/tmp/image'];
  await c.submit(text, images); assert.deepEqual(calls.at(-1)!.params.input, [{ type: 'text', text, text_elements: [] }, { type: 'localImage', path: images[0] }, input]);
  await c.submit('$demo steer', images); assert.equal(calls.at(-1)!.method, 'turn/steer'); assert.deepEqual(calls.at(-1)!.params.input.at(-1), input);
  await c.submit('$demo queued', images, 'queue'); assert.deepEqual(c.queue[0]!.skills, [input]);
  c.activeTurn = null; rpc.request = async (method, params) => { calls.push({ method, params }); if (method === 'skills/list') throw new Error('Queue must use saved metadata'); return { turn: { id: 'drained' } }; };
  await c.runQueue(); assert.deepEqual(calls.at(-1)!.params.input.at(-1), input); assert.equal(c.queue.length, 0);
  rpc.request = async () => { throw new RpcOutcomeUnknown('turn/steer', 1, 'unknown'); };
  await assert.rejects(c.submit('$demo uncertain', images, 'steer', [input])); assert.deepEqual(c.unconfirmed[0]!.skills, [input]);
  const id = c.unconfirmed[0]!.id; c.resolveUnconfirmed(id, true); assert.deepEqual(c.queue[0]!.skills, [input]);
});

test('skills survive recovery for draft, queued and uncertain input and resend without re-resolving', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tern-skills-recovery-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'recovery.json'); const store = await RecoveryStore.open(path);
  store.update({ id: 'restored', cwd, draft: { text: '$demo draft', images: [], skills: [input] },
    queue: [{ id: 'q', text: '$demo queued', images: [], skills: [input] }], unconfirmed: [],
    inflight: { id: 'inflight', text: '$demo uncertain', images: [], skills: [input] } });
  await store.flush(); const reopened = await RecoveryStore.open(path);
  const { c, ui, calls } = setup(); t.after(() => ui.close()); c.useRecovery(reopened);
  assert.deepEqual(c.savedDraft('restored')!.skills, [input]); await c.resume('restored');
  assert.deepEqual(c.unconfirmed[0]!.skills, [input]); c.resolveUnconfirmed('inflight');
  await c.runQueue(); assert.deepEqual(calls.at(-1)!.params.input.at(-1), input);
  const controls = ui as any; controls.syncComposer(); assert.deepEqual(ui.draft.selectedSkills, [input]);
});

test('rejected UI skill send preserves metadata alongside original text/images and new typing', async t => {
  const { c, rpc, ui } = setup(); t.after(() => ui.close());
  const sending = deferred(); const request = rpc.request;
  rpc.request = (method, params) => method === 'turn/start' ? sending.promise : request(method, params);
  ui.draft.set('$demo original'); ui.draft.selectSkill(input); ui.images = ['/tmp/image'];
  const work = ui.send(); await tick(); ui.draft.set('New draft'); sending.reject(new Error('Rejected')); await work;
  assert.equal(ui.draft.text, 'New draft'); assert.equal(c.queue[0]!.text, '$demo original'); assert.deepEqual(c.queue[0]!.skills, [input]);
});

test('late skill resolution never sends edited text or input from another session', async t => {
  const { c, rpc, ui, calls } = setup(); t.after(() => ui.close());
  const pending = deferred(), request = rpc.request;
  rpc.request = (method, params) => method === 'skills/list' ? pending.promise : request(method, params);
  ui.draft.set('$demo old draft'); const sending = ui.send(); await tick();
  ui.draft.set('New draft'); pending.resolve({ data: [{ cwd, skills: [skill()], errors: [] }] }); await sending;
  assert.equal(ui.draft.text, 'New draft'); assert.equal(calls.some(c => c.method.startsWith('turn/')), false);
  const next = deferred(); rpc.request = (method, params) => method === 'skills/list' ? next.promise : request(method, params);
  ui.draft.set('$demo old session'); const stale = ui.send(); await tick(); await c.newThread();
  next.resolve({ data: [{ cwd, skills: [skill()], errors: [] }] }); await stale;
  assert.equal(calls.some(c => c.method.startsWith('turn/')), false);
});

test('plain mode shares command parsing, preserves queue text and never sends local commands to the backend', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tern-plain-commands-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'rpc.jsonl'), skillsFile = join(dir, 'skills.json'); await writeFile(skillsFile, JSON.stringify([skill()]));
  const fixture = fileURLToPath(new URL('./fixtures/ui-app-server.mjs', import.meta.url));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const child = spawn(process.execPath, [cli, '--plain', '--cwd', dir, '--codex', fixture], {
    env: { ...process.env, TERN_TSP: '0', XDG_STATE_HOME: dir, QA_RPC_LOG: log, QA_FEATURE_FIXTURES: '1', QA_SKILLS_FILE: skillsFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  child.stdin.write('/help\n/status\n/model\n/language zh-CN\n/skills\n/resume\n/threads\n/reconnect\n/stop\n/next\n/reply missing {}\n/unconfirmed\n/sent missing\n/retry missing\n/unknown-command\n/queue  $demo keep spaces  \n/quit\n');
  assert.equal(await exited, 0, output);
  const rpcCalls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const sends = rpcCalls.filter(c => c.method === 'turn/start' || c.method === 'turn/steer');
  assert.equal(sends.length, 1); assert.equal(sends[0].input[0].text, ' $demo keep spaces  ');
  assert.deepEqual(sends[0].input.at(-1), input); assert.match(output, /Unknown command/); assert.match(output, /\/reply/);
});

test('pins persist alongside language/model and independent preference writers preserve each field', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tern-pins-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'preferences.json'), prefs = new Preferences(path), other = new Preferences(path);
  await prefs.setModel('my-model'); await prefs.setLanguage('zh-CN');
  await other.setPinned('locked-session', true); await prefs.setModel('new-model');
  const restored = new Preferences(path); await restored.load(); assert.deepEqual(restored.pinned, ['locked-session']);
  assert.equal(restored.language, 'zh-CN'); assert.equal(restored.model, 'new-model');
  await restored.setPinned('locked-session', false); await restored.load(); assert.deepEqual(restored.pinned, []);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).language, 'zh-CN');
  await writeFile(path, 'invalid'); await assert.rejects(restored.setPinned('nope', true)); assert.deepEqual(restored.pinned, []);
});

test('pins move locked sessions first without changing recency/tie order or claiming writer; archived pins stay hidden', async t => {
  const { c, rpc, ui, calls } = setup(); t.after(() => ui.close());
  const rows = ['newest', 'tie-a', 'tie-b', 'oldest'].map((id, i) => ({ id, cwd, name: id, updatedAt: [30, 10, 10, 1][i] }));
  const request = rpc.request;
  rpc.request = (method, params) => method === 'thread/list' ? Promise.resolve({ data: rows, nextCursor: null }) : request(method, params);
  const list = new FolderSessions(c, () => {}, async () => new Set(['oldest'])); t.after(() => list.dispose());
  await list.refresh(); await c.setPinned('oldest', true); await c.setPinned('tie-b', true);
  const ids = () => list.snapshot.rows.map(r => r.id);
  assert.deepEqual(ids(), ['tie-b', 'oldest', 'newest', 'original', 'tie-a']);
  assert.equal(list.snapshot.rows.find(r => r.id === 'oldest')!.locked, true);
  assert.equal(c.thread!.id, 'original'); assert.ok(!calls.some(c => c.method === 'thread/resume'));
  await c.setPinned('tie-b', false); assert.deepEqual(ids(), ['oldest', 'newest', 'original', 'tie-a', 'tie-b']);
  await c.archiveThread('oldest'); assert.ok(!ids().includes('oldest')); assert.equal(c.isPinned('oldest'), true);
});

test('native sidebar bridge toggles only local pin preference and ignores unknown row actions', async t => {
  const { c, ui, calls } = setup(); t.after(() => ui.close());
  (ui.session as any).caps = { cols: 100, cell: { w: 8 } };
  const bridge = (ui as any).renderSessionBridge();
  const snapshot = JSON.parse(bridge.props.title);
  assert.equal(snapshot.pinProtocol, 1); assert.equal(snapshot.rows[0].pinned, false);
  bridge.handlers.onAction.pin({ value: 'original' }); await tick(); assert.equal(c.isPinned('original'), true);
  bridge.handlers.onAction.pin({ value: 'unlisted' }); await tick(); assert.equal(c.isPinned('unlisted'), false);
  bridge.handlers.onAction.pin({ value: 'original' }); await tick(); assert.equal(c.isPinned('original'), false);
  assert.equal(c.thread!.id, 'original'); assert.ok(!calls.some(c => ['thread/archive', 'thread/resume', 'turn/start'].includes(c.method)));
});

test('Chinese punctuation delimits skill markers while preserving exact start/steer text and paths', async t => {
  const { c, ui, calls } = setup(); t.after(() => ui.close());
  for (const text of ['$demo，处理', '$demo。', '$demo：说明', '请用（$demo）处理', '先处理，$demo；然后完成！']) {
    const method = c.activeTurn ? 'turn/steer' : 'turn/start';
    await c.submit(text);
    const sent = calls.at(-1)!; assert.equal(sent.method, method);
    assert.deepEqual(sent.params.input, [{ type: 'text', text, text_elements: [] }, input]);
  }
  ui.draft.set('$demo，处理'); ui.draft.selectSkill(input);
  ui.draft.set('$demo：说明'); assert.deepEqual(ui.draft.selectedSkills, [input]);
});

test('unknown dollar variables and amounts followed by Chinese punctuation stay ordinary text', async t => {
  const { c, ui, calls } = setup(); t.after(() => ui.close());
  const text = '$HOME，$PATH。金额为 $100，另有 $12.50。未知 $unknown：说明';
  await c.submit(text);
  assert.deepEqual(calls.at(-1)!.params.input, [{ type: 'text', text, text_elements: [] }]);
});
