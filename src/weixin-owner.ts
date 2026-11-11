import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Controller } from './controller';
import type { Conversation, PendingRequest } from './conversation';
import { findExecutable } from './launch';
import { isRpcOutcomeUnknown } from './rpc';
import { localRelayBridge, RelayConnection, type RelayCall } from './weixin-relay';
import { canonicalHash, requestIdentity, requestResponse, type RelayRequest } from './weixin-requests';

type Terminal = { session: string; turn: string; kind: 'completed' | 'failed'; at: string };
type Receipt = { id: string; status: 'accepted' | 'rejected' | 'uncertain'; detail: string };
type Target = { session: string; version: string; turn: string | null; title: string; kind: 'native';
  state: 'working' | 'idle' | 'waiting'; can_message: boolean; requests: RelayRequest[] };
type Stamp = { hash: string; version: string; expires: number; request: PendingRequest };

/** Lives beside one actual registry, independent of selection and UI generations. */
export class WeixinOwner {
  private readonly bridge: RelayConnection;
  private baseline = false;
  private stopped = false;
  private claimUncertain = false;
  private opened = false;
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private publishing?: Promise<void>;
  private lastPublish = -Infinity;
  private revision = 0;
  private readonly stamps = new WeakMap<PendingRequest, Stamp>();
  private readonly platformOnly = new WeakSet<PendingRequest>();
  private readonly events = new Map<string, Terminal & { id: string; summary: string; final_text?: string }>();
  private readonly done = new Map<string, Receipt>();
  private pendingAck?: Receipt;

  constructor(private readonly c: Controller, call: RelayCall,
    private readonly mode: (id: string) => 'steer' | 'queue' = () => 'steer',
    private readonly clock = Date.now) { this.bridge = new RelayConnection(call); }

  async attach(poll = true) {
    if (this.opened || this.stopped) throw Error('Owner relay already opened');
    this.opened = true;
    await this.bridge.open();
    this.c.on('ownerTerminal', this.terminal);
    await this.publish();
    if (poll) this.schedule();
  }

  private terminal = (e: Terminal) => {
    if (!this.baseline || this.stopped) return;
    const id = `${e.turn}:${e.kind}`;
    const conversation = this.c.controlledConversations().find(c => c.thread?.id === e.session);
    const final = conversation?.items.filter(i => i.turnId === e.turn && i.item.type === 'agentMessage' && i.item.phase !== 'commentary').at(-1)?.item;
    this.events.set(`${e.session}:${id}`, { ...e, id, ...(final?.type === 'agentMessage' && final.text.trim() ? { final_text: final.text.slice(0, 12000) } : {}), summary: e.kind === 'completed'
      ? '任务完成，请在原会话查看结果。' : '执行失败，请在原会话核对错误；未自动重试。' });
  };

  private version(c: Conversation) {
    const e = c.effective;
    return `${this.c.ownerGeneration}:${canonicalHash({ session: c.thread?.id, turn: c.activeTurn, ended: [...c.endedTurns].at(-1) ?? null,
      input: c.inputVersion, cwd: c.cwd, model: c.model, effort: c.effort,
      requests: c.requests.map(r => ({ id: r.id, method: r.method, params: canonicalHash(r.params) })),
      policy: e?.approvalPolicy, sandbox: e?.sandbox, reviewer: e?.approvalsReviewer })}`;
  }

  private request(c: Conversation, r: PendingRequest): RelayRequest | undefined {
    const identity = requestIdentity(c, r); if (!identity) return;
    let stamp = this.stamps.get(r);
    if (!stamp || stamp.hash !== identity.hash) {
      const started = Number.isFinite(r.params.startedAtMs) ? r.params.startedAtMs : this.clock();
      const deadline = Math.min(this.clock() + 900000, started + 900000,
        r.method === 'item/tool/requestUserInput' && r.params.autoResolutionMs > 0 ? this.clock() + r.params.autoResolutionMs : Infinity);
      stamp = { request: r, hash: identity.hash, version: String(++this.revision), expires: deadline };
      this.stamps.set(r, stamp);
    }
    if (stamp.expires <= this.clock()) return;
    return { id: JSON.stringify(r.id), version: stamp.version, turn: c.activeTurn!, hash: identity.hash,
      kind: identity.kind, prompt: identity.prompt, expires_at: new Date(stamp.expires).toISOString() };
  }

  private target(c: Conversation): Target {
    return { session: c.thread!.id, version: this.version(c), turn: c.activeTurn,
      title: (c.thread!.name || c.thread!.preview || 'Codex').replace(/\s+/g, ' ').slice(0, 120), kind: 'native',
      state: c.requests.length || c.unconfirmed.length ? 'waiting' : c.activeTurn ? 'working' : 'idle',
      can_message: !c.operation && !c.unconfirmed.length && this.c.operation !== 'Deleting session…',
      requests: c.requests.flatMap(r => {
        const request = this.request(c, r);
        if (!request && !this.platformOnly.has(r)) {
          this.platformOnly.add(r);
          c.notice('This request needs the original client. Weixin cannot process secret input, authentication, incomplete calls or expired requests.', true);
        }
        return request ? [request] : [];
      }) };
  }

  private snapshot() {
    const controlled = this.c.controlledConversations();
    // Do not silently publish an incomplete set or truncate calls.
    if (controlled.length > 200) throw Error('Too many controlled sessions');
    return controlled.map(c => this.target(c));
  }

  private publish(): Promise<void> {
    if (this.publishing) return this.publishing;
    const work = this.publishSnapshot().finally(() => { if (this.publishing === work) this.publishing = undefined; });
    this.publishing = work; return work;
  }

  private async publishSnapshot() {
    const sessions = this.snapshot(), ids = new Set(sessions.map(s => s.session));
    const events = this.baseline ? [...this.events.values()].filter(e => ids.has(e.session)).slice(0, 100) : [];
    // Keep the authenticated snapshot complete; split terminal batches rather
    // than losing all queued completions when final evidence is large.
    while (events.length && Buffer.byteLength(JSON.stringify({ sessions, events })) > 240000) events.pop();
    const reply = await this.bridge.request('publish', { sessions, events });
    if (reply.published !== true) throw Error('Snapshot not confirmed');
    for (const e of events) this.events.delete(`${e.session}:${e.id}`);
    this.baseline = true; this.lastPublish = this.clock();
  }

  /** Serializes claim, validation, original action and receipt. Never replays an action. */
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    const work = this.cycle().finally(() => { if (this.polling === work) this.polling = undefined; });
    this.polling = work; return work;
  }

  private async cycle() {
    if (this.stopped || !this.opened) return;
    if (this.clock() - this.lastPublish >= 3000 || this.events.size) await this.publish();
    if (this.pendingAck) { await this.acknowledge(); return; }
    if (this.claimUncertain) return;
    let command: any;
    try { command = (await this.bridge.request('claim')).command; }
    catch {
      this.claimUncertain = true;
      this.c.notice('Weixin relay claim is uncertain. Check the original session; commands will not be replayed.', true);
      return;
    }
    if (!command) return;
    if (typeof command.id !== 'string') { this.claimUncertain = true; return; }
    let receipt = this.done.get(command.id);
    if (!receipt) {
      try { const detail = await this.execute(command); receipt = { id: command.id, status: 'accepted', detail }; }
      catch (error) {
        receipt = { id: command.id, status: isRpcOutcomeUnknown(error) ? 'uncertain' : 'rejected',
          detail: isRpcOutcomeUnknown(error) ? '原生发送或回应结果不确定；没有重投，请核对原会话。' : '目标、版本、请求内容、有效期或答案校验不通过，或原队列拒绝本次输入；请在原会话核对。' };
      }
      this.done.set(command.id, receipt);
    }
    this.pendingAck = receipt; await this.acknowledge();
  }

  private async acknowledge() {
    const r = this.pendingAck; if (!r) return;
    const { receipt } = await this.bridge.request('receipt', { id: r.id });
    if (receipt && ['accepted', 'rejected', 'uncertain'].includes(receipt.status)) { this.pendingAck = undefined; return; }
    if (!receipt || receipt.status !== 'claimed') throw Error('Claim receipt unavailable');
    const reply = await this.bridge.request('ack', r);
    if (reply.recorded === true) this.pendingAck = undefined;
  }

  private async execute(command: any) {
    if (this.stopped) throw Error('Owner closed');
    const c = this.c.controlledConversations().find(c => c.thread!.id === command.session);
    if (!c) throw Error('Session is offline or belongs to another owner');
    const check = () => {
      if (this.stopped || c.thread?.id !== command.session || !this.c.controlledConversations().includes(c) || command.version !== this.version(c)
        || command.turn !== c.activeTurn || command.payload?.target_version !== command.version
        || this.c.operation === 'Deleting session…') throw Error('Stale target');
    };
    check();
    if (command.operation === 'message') {
      if (!this.target(c).can_message || typeof command.payload.text !== 'string' || !command.payload.text.trim()
        || command.payload.text.length > 12000) throw Error('Message unavailable');
      // Literal user text: do not run slash commands, resolve skills, select or resume.
      const running = !!c.activeTurn, mode = this.mode(c.thread!.id);
      await c.submit(command.payload.text, [], mode, undefined, [], check);
      return running && mode === 'queue' ? '消息已进入目标会话的原队列，等待本轮结束；不代表任务完成。'
        : running ? '消息已通过原会话 turn/steer 接纳，未切换会话或权限。'
          : '消息已按目标会话原有模型与权限接续，turn/start 已确认接纳；不代表任务完成。';
    } else if (command.operation === 'decision') {
      const p = command.payload, current = p.request;
      if (!current || typeof current.id !== 'string') throw Error('Missing request');
      const r = c.requests.find(r => JSON.stringify(r.id) === current.id);
      if (!r) throw Error('Request already consumed');
      const fresh = this.request(c, r);
      if (!fresh || canonicalHash(fresh) !== canonicalHash(current)) throw Error('Request changed or expired');
      const result = requestResponse(r, p.action, p.answer);
      check();
      const again = this.request(c, r);
      if (!again || canonicalHash(again) !== canonicalHash(current)) throw Error('Request changed');
      c.answer(r.id, result, r); // Same synchronous, consume-before-write entry as the UI.
      return current.kind === 'approval' ? '已将仅本次调用的允许/拒绝提交到原生请求回调；未授予会话或永久权限，回调没有独立后端ACK。'
        : '已按真实题目ID将答案提交到原生请求回调；没有把回答当作权限，回调没有独立后端ACK。';
    } else throw Error('Unsupported relay operation');
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.schedule();
      // Keep ownership live while a native RPC or durability checkpoint is slow.
      // Publishing may overlap that wait; command claim/execution remains serial.
      if (this.clock() - this.lastPublish >= 3000 || this.events.size) void this.publish().catch(() => {});
      void this.poll().catch(() => { /* Snapshot/ack may retry; actions never do. */ });
    }, 1000);
    this.timer.unref();
  }

  async close() {
    this.stopped = true; if (this.timer) clearTimeout(this.timer);
    this.c.off('ownerTerminal', this.terminal);
    await this.polling?.catch(() => {});
    await this.publishing?.catch(() => {});
    if (this.pendingAck) await this.acknowledge().catch(() => {});
    await this.bridge.request('publish', { sessions: [], events: [] }).catch(() => {});
  }
}

export async function attachWeixinOwner(c: Controller, mode: (id: string) => 'steer' | 'queue') {
  if (process.env.CODEX_TERN_WEIXIN_DISABLE === '1') return;
  // Existing native QA launchers also use this entry point. They must never
  // discover a real channel merely because a sibling workbench is installed.
  if (process.env.QA_CODEX_HOME) return;
  const directory = process.env.CODEX_TERN_WORKBENCH_DIR || fileURLToPath(new URL('../../real-workbench/', import.meta.url));
  const node = findExecutable(process.env.CODEX_TERN_NODE || 'node');
  if (!node || !(await stat(`${directory}/runtime/weixin/bridge.mjs`).catch(() => null))?.isFile()) return;
  const owner = new WeixinOwner(c, localRelayBridge(node, directory, process.env.WB_DATA_DIR), mode);
  try { await owner.attach(); return owner; }
  catch { await owner.close(); c.notice('Weixin relay is unavailable. Native sessions remain usable.', true); }
}
