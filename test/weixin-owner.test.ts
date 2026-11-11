import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Controller } from '../src/controller';
import { CodexRpc } from '../src/rpc';
import { WeixinOwner } from '../src/weixin-owner';
import { localRelayBridge, type RelayCall } from '../src/weixin-relay';
import { canonicalHash, requestIdentity, requestResponse } from '../src/weixin-requests';
import { findExecutable } from '../src/launch';

const workbench = process.env.CODEX_TERN_WORKBENCH_DIR || resolve(import.meta.dirname, '../../real-workbench');
const node = findExecutable('node')!;
// The public client can be built and tested without the optional local service.
// Keep pure request-validation tests enabled in a standalone checkout.
const integrationTest = node && existsSync(resolve(workbench, 'runtime/weixin/bridge.mjs')) ? test : test.skip;
const pause = (ms = 20) => new Promise(r => setTimeout(r, ms));
async function wait(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await pause(); } throw Error('fixture did not settle'); }
async function setup(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-tern-weixin-'));
  const previous = { QA_CODEX_HOME: process.env.QA_CODEX_HOME, QA_HISTORY_FILE: process.env.QA_HISTORY_FILE };
  const home = join(dir, 'codex'); await mkdir(join(home, 'thread-writer-locks'), { recursive: true });
  process.env.QA_CODEX_HOME = home; delete process.env.QA_HISTORY_FILE;
  const helper = (input: object): Promise<any> => new Promise((yes, no) => {
    const child = spawn(node, ['--disable-warning=ExperimentalWarning', resolve('test/fixtures/weixin-workbench.mjs'), workbench], {
      env: { ...process.env, WB_DATA_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.resume();
    child.on('error', no); child.on('close', code => { if (code) no(Error('isolated workbench fixture failed')); else { try { yes(JSON.parse(output)); } catch (e) { no(e); } } });
    child.stdin.end(JSON.stringify({ ...input, ...(input && (input as any).action === 'control' && /^(允许|回答) R-/.test((input as any).text) ? { deliverDetails: true } : {}) }));
  });
  await helper({ action: 'bind' });
  const rpc = new CodexRpc({ binary: resolve('test/fixtures/ui-app-server.mjs'), cwd: resolve('.'), timeoutMs: 2000 });
  const c = new Controller(rpc, resolve('.'));
  const responses: { id: string | number; result: any }[] = [];
  const respond = rpc.respond.bind(rpc);
  rpc.respond = (id, result) => { responses.push({ id, result }); respond(id, result); };
  let afterClaim: (() => void | Promise<void>) | undefined;
  let loseAck = false, loseClaim = false, losePublish = false;
  const bridge = localRelayBridge(node, workbench, dir);
  const call: RelayCall = async input => {
    const result = await bridge(input);
    if (input.action === 'weixin-relay-claim' && result.command) {
      if (afterClaim) { const hook = afterClaim; afterClaim = undefined; await hook(); }
      if (loseClaim) { loseClaim = false; throw Error('simulated claim reply loss'); }
    }
    if (input.action === 'weixin-relay-ack' && loseAck) { loseAck = false; throw Error('simulated ack reply loss'); }
    if (input.action === 'weixin-relay-publish' && losePublish) { losePublish = false; throw Error('simulated publish reply loss'); }
    return result;
  };
  let now = Date.now(), mode: 'steer' | 'queue' = 'steer';
  const owner = new WeixinOwner(c, call, () => mode, () => now);
  t.after(async () => {
    if (process.env.CODEX_TERN_RELAY_EVIDENCE_DIR) {
      const evidenceDir = resolve(process.env.CODEX_TERN_RELAY_EVIDENCE_DIR);
      await mkdir(evidenceDir, { recursive: true });
      // This fixture driver exposes neither account credentials nor client tokens.
      const state = await helper({ action: 'state' });
      await writeFile(join(evidenceDir, `${canonicalHash(t.name).slice(0,16)}.json`), JSON.stringify({
        scenario: t.name, environment: 'isolated WB_DATA_DIR + fixed backend; no worker/mobile send',
        state, nativeResponses: responses,
      }, null, 2));
    }
    await owner.close(); await rpc.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  });
  await c.connect();
  return { c, rpc, owner, helper, responses, advance: (ms = 3100) => { now += ms; }, mode: (value: typeof mode) => { mode = value; },
    hook: (f: () => void | Promise<void>) => { afterClaim = f; }, loseAck: () => { loseAck = true; }, loseClaim: () => { loseClaim = true; }, losePublish: () => { losePublish = true; },
    state: () => helper({ action: 'state' }),
  };
}

integrationTest('actual owner + Node bridge: multiple native sessions, directed messages, queue mode and incremental completion outbox', async t => {
  const f = await setup(t), { c, owner, helper } = f;
  await c.submit('result before attachment'); await wait(() => !c.activeTurn);
  const a = c.thread!.id; await c.submit('hold'); await c.newThread(); const b = c.thread!.id; await c.submit('hold');
  await owner.attach(false); assert.equal((await f.state()).outbox.length, 0, 'no historical completion replay');
  const target = (await f.state()).snapshots.find((s: any) => s.session === a);
  const q = await helper({ action: 'send', ref: target.ref, text: 'continue first', inbox: 'message-a' });
  await Promise.all([owner.poll(), owner.poll()]);
  await wait(() => !c.sessionStatus(a).running);
  f.losePublish(); await assert.rejects(owner.poll(), /publish reply loss/); await owner.poll();
  const state = await f.state(); assert.equal(c.thread!.id, b); assert.equal(c.sessionStatus(b).running, true);
  assert.equal(state.commands.find((v: any) => v.id === q.id).status, 'accepted');
  assert.ok(state.notices.some((v: any) => v.target === target.ref && v.kind === 'completed'));
  assert.equal(state.notices.filter((v: any) => v.kind === 'completed').length, 1);
  await assert.rejects(helper({ action: 'send', ref: target.ref, text: 'continue first', inbox: 'message-a' }), 'same inbox cannot retarget a changed session version');
  assert.equal((await f.state()).commands.length, 1);
  f.mode('queue'); f.advance(); await owner.poll();
  const second = (await f.state()).snapshots.find((s: any) => s.session === b);
  await helper({ action: 'send', ref: second.ref, text: 'queued in second', inbox: 'message-b' }); await owner.poll();
  assert.equal(c.queue[0].text, 'queued in second'); assert.equal(c.activeTurn, second.turn);
});

integrationTest('actual owner decisions: complete command, typed request identity, single-use approval and exact question answers', async t => {
  const f = await setup(t), { c, owner, helper } = f;
  await c.submit('approval'); await wait(() => c.requests.length === 1); await owner.attach(false);
  let state = await f.state(), notice = state.notices.find((v: any) => v.kind === 'approval');
  assert.ok(notice.data.prompt.includes('echo QA_APPROVAL')); assert.ok(notice.data.prompt.includes(resolve('.')));
  assert.ok(!notice.data.prompt.includes('"threadId"'), 'wire routing metadata is not product prose');
  assert.equal(notice.data.id, JSON.stringify(c.requests[0]!.id)); assert.match(notice.data.hash, /^[a-f0-9]{64}$/);
  await helper({ action: 'control', text: `允许 ${notice.code}`, inbox: 'approve-once' }); await owner.poll();
  await wait(() => !c.activeTurn); assert.equal(c.requests.length, 0);
  assert.ok((await f.state()).commands.every((v: any) => v.status === 'accepted'));
  assert.deepEqual(f.responses[0]!.result, { decision: 'accept' }, 'approval is exactly once, without persistent scope');
  await c.newThread(); await c.submit('question'); await wait(() => c.requests.length === 1);
  f.advance(); await owner.poll(); state = await f.state(); notice = state.notices.filter((v: any) => v.kind === 'input').at(-1);
  await helper({ action: 'control', text: `回答 ${notice.code} Blue`, inbox: 'answer-once' }); await owner.poll();
  await wait(() => !c.activeTurn); assert.equal(c.requests.length, 0);
  assert.ok(c.items.some(i => i.item.type === 'agentMessage' && i.item.text === 'QA_RESPONSE_answered'));
  assert.deepEqual(f.responses[1]!.result, { answers: { color: { answers: ['Blue'] } } });
});

integrationTest('actual UI competes with relay and wins one consume; changed hash, expiry and disconnect reject old decisions', async t => {
  const f = await setup(t), { c, owner, helper } = f;
  await c.submit('approval'); await wait(() => c.requests.length === 1); await owner.attach(false);
  const decide = async (inbox: string) => {
    const n = (await f.state()).notices.filter((v: any) => v.kind === 'approval' && v.status === 'pending').at(-1);
    await helper({ action: 'control', text: `允许 ${n.code}`, inbox });
  };
  const r = c.requests[0]!;
  await decide('ui-race'); f.hook(() => { c.answer(r.id, { decision: 'decline' }, r); }); await owner.poll();
  assert.throws(() => c.answer(r.id, { decision: 'accept' }, r));
  assert.equal((await f.state()).commands.at(-1).status, 'rejected'); await wait(() => !c.activeTurn);
  assert.equal(f.responses.length, 1, 'UI and relay share one consumption');
  await c.newThread(); await c.submit('approval'); await wait(() => c.requests.length === 1); f.advance(); await owner.poll();
  await decide('hash-change'); f.hook(() => { c.requests[0]!.params.command = 'echo CHANGED'; }); await owner.poll();
  assert.equal((await f.state()).commands.at(-1).status, 'rejected'); assert.equal(c.requests.length, 1);
  f.advance(); await owner.poll(); await decide('expiry'); f.hook(() => { f.advance(901000); }); await owner.poll();
  assert.equal((await f.state()).commands.at(-1).status, 'rejected');
  // Expires are owner-local and cannot be revived by another publish.
  f.advance(); await owner.poll(); assert.equal((await f.state()).snapshots.at(-1).requests.length, 0);
  await owner.close(); assert.equal((await f.state()).targets.length, 0);
});

integrationTest('actual backend preserves numeric/string request IDs; failed events notify and new-turn/offline commands reject', async t => {
  const f = await setup(t), { c, owner, helper } = f; await owner.attach(false);
  await c.submit('QA_STATUS_FAIL'); await wait(() => !c.activeTurn); await owner.poll();
  assert.ok((await f.state()).notices.some((v: any) => v.kind === 'failed'));
  await c.newThread(); await c.submit('approval QA_TYPED_REQUESTS'); await wait(() => c.requests.length === 2);
  f.advance(); await owner.poll(); const state = await f.state();
  const requests = state.snapshots.find((s: any) => s.session === c.thread!.id).requests;
  assert.equal(requests.length, 2); assert.notEqual(requests[0].id, requests[1].id);
  const stringNotice = state.notices.find((n: any) => n.data.id?.startsWith('"'));
  await helper({ action: 'control', text: `允许 ${stringNotice.code}`, inbox: 'typed-id' }); await owner.poll();
  assert.equal(typeof f.responses.at(-1)!.id, 'string'); await wait(() => !c.activeTurn);
  await c.newThread(); await c.submit('hold'); f.advance(); await owner.poll();
  let target = (await f.state()).snapshots.find((s: any) => s.session === c.thread!.id);
  await helper({ action: 'send', ref: target.ref, text: 'stale turn message', inbox: 'stale-turn' });
  c.controlledConversations().find(v => v.thread!.id === c.thread!.id)!.checkpoint = async () => {
    await c.stop(); await wait(() => !c.activeTurn);
  };
  await owner.poll();
  assert.equal((await f.state()).commands.at(-1).status, 'rejected');
  assert.equal(c.items.filter(v => v.item.type === 'userMessage').length, 1, 'preflight after the checkpoint prevents stale native send');
  await c.newThread(); f.advance(); await owner.poll(); target = (await f.state()).snapshots.find((s: any) => s.session === c.thread!.id);
  await helper({ action: 'send', ref: target.ref, text: 'offline must not resume', inbox: 'offline' });
  f.hook(async () => { await f.rpc.close(); c.connection = 'disconnected'; }); await owner.poll();
  assert.equal((await f.state()).commands.at(-1).status, 'rejected'); assert.equal(c.items.length, 0);
  f.advance(); await owner.poll(); assert.equal((await f.state()).targets.length, 0);
});

integrationTest('delivery and claim uncertainty never replay; lost ack is recovered only through receipt', async t => {
  const f = await setup(t), { c, owner, helper } = f; await owner.attach(false);
  let target = (await f.state()).snapshots[0];
  await helper({ action: 'send', ref: target.ref, text: 'QA_UNCONFIRMED', inbox: 'uncertain-send' });
  await owner.poll(); assert.equal((await f.state()).commands.at(-1).status, 'uncertain'); assert.equal(c.unconfirmed.length, 1);
  await owner.poll(); assert.equal(c.unconfirmed.length, 1);
  await c.newThread(); f.advance(); await owner.poll(); target = (await f.state()).snapshots.find((s: any) => s.session === c.thread!.id);
  await helper({ action: 'send', ref: target.ref, text: 'background', inbox: 'lost-ack' }); f.loseAck();
  await assert.rejects(owner.poll(), /ack reply loss/); await owner.poll();
  assert.equal((await f.state()).commands.at(-1).status, 'accepted');
  await c.newThread(); f.advance(); await owner.poll(); target = (await f.state()).snapshots.find((s: any) => s.session === c.thread!.id);
  const q = await helper({ action: 'send', ref: target.ref, text: 'do not execute after claim loss', inbox: 'lost-claim' });
  f.loseClaim(); await owner.poll(); await owner.poll();
  assert.equal(c.items.length, 0); assert.equal((await f.state()).commands.at(-1).status, 'claimed');
  await helper({ action: 'sweep', expire: q.id }); assert.equal((await f.state()).commands.at(-1).status, 'uncertain');
});

test('canonical full context and request safety: key order, numeric/string IDs, exact multi-answer mapping and no auth/secret/permanent grant', () => {
  assert.equal(canonicalHash({ z: [2, { b: 1, a: 3 }], a: 1 }), canonicalHash({ a: 1, z: [2, { a: 3, b: 1 }] }));
  assert.notEqual(canonicalHash({ id: 5 }), canonicalHash({ id: '5' }));
  const r: any = { method: 'item/tool/requestUserInput', params: { questions: [
    { id: 'q1', question: 'First?', options: [{ label: 'A' }], isOther: false }, { id: 'q2', question: 'Second?', options: null },
  ] } };
  assert.deepEqual(requestResponse(r, '回答', '{"q1":"A","q2":"exact text"}'), { answers: { q1: { answers: ['A'] }, q2: { answers: ['exact text'] } } });
  assert.throws(() => requestResponse(r, '回答', '{"q1":"a","q2":"text"}'));
  assert.throws(() => requestResponse(r, '回答', '{"wrong":"A"}'));
  assert.throws(() => requestResponse({ method: 'item/commandExecution/requestApproval' } as any, 'acceptForSession', null));
  const c: any = { thread: { id: 'thread' }, activeTurn: 'turn', items: [] };
  const req: any = { id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', command: 'echo safe', cwd: '/tmp' } };
  assert.ok(requestIdentity(c, req)); req.params.command = 'curl -H "Authorization: Bearer secret" example.test'; assert.equal(requestIdentity(c, req), undefined);
  req.method = 'mcpServer/elicitation/request'; assert.equal(requestIdentity(c, req), undefined);
  req.method = 'item/fileChange/requestApproval'; req.params.grantRoot = '/tmp'; assert.equal(requestIdentity(c, req), undefined);
});

integrationTest('unanswerable waits publish only platform attention, and failed native callback stays consumed', async t => {
  const f = await setup(t), { c, owner } = f;
  await c.submit('question'); await wait(() => c.requests.length === 1);
  c.requests[0]!.params.questions[0].isSecret = true;
  await owner.attach(false); const state = await f.state();
  assert.equal(state.snapshots[0].state, 'waiting'); assert.equal(state.snapshots[0].requests.length, 0);
  assert.ok(state.notices.some((n: any) => n.kind === 'attention'));
  assert.ok(state.outbox.some((o: any) => o.text.includes('原会话')));
  const r = c.requests[0]!; f.rpc.respond = () => { throw Error('simulated pipe write failure'); };
  assert.throws(() => c.answer(r.id, { answers: {} }, r), /uncertain/);
  assert.equal(c.requests.length, 0); assert.throws(() => c.answer(r.id, { answers: {} }, r), /no longer active/);
});

integrationTest('a slow original checkpoint does not stop owner snapshot heartbeats or permit a second claim', async t => {
  const f = await setup(t), { c, owner, helper } = f; await owner.attach(true);
  const before = (await f.state()).snapshots[0];
  let release!: () => void;
  const checkpoint = new Promise<void>(done => { release = done; });
  t.after(() => release());
  c.controlledConversations()[0]!.checkpoint = () => checkpoint;
  await helper({ action: 'send', ref: before.ref, text: 'background', inbox: 'slow-original-queue' });
  const sending = owner.poll(); await wait(() => c.operation === 'Sending…');
  try {
    f.advance(); await pause(1300);
    const during = (await f.state()).snapshots[0];
    assert.notEqual(during.updated_at, before.updated_at); assert.equal(during.can_message, false);
    assert.equal((await f.state()).commands.length, 1);
  } finally { release(); await sending; }
  assert.equal((await f.state()).commands[0].status, 'accepted');
});
