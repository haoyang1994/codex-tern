import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileLock } from '@oh-my-pi/pi-natives';
import { Conversation, type PendingRequest } from './conversation';
import type { Turn } from './generated/v2/Turn';
import type { ThreadItem } from './generated/v2/ThreadItem';
import type { UserInput } from './generated/v2/UserInput';
import type { RpcId } from './protocol';
import { findExecutable } from './launch';
import { OmpRpc } from './omp-rpc';
import { isRpcOutcomeUnknown, type CodexRpc } from './rpc';

const extension = fileURLToPath(new URL('../tern-plugin/omp-identity.ts', import.meta.url));
const safeId = /^[a-zA-Z0-9_-]{1,128}$/;

function configDir() {
  const path = process.env.TERN_CONFIG_DIR || (process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support/Tern')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'tern'));
  try { return realpathSync(path); }
  catch { return resolve(path); }
}

function ompExecutable() {
  const override = process.env.OMP_BINARY;
  return override ? findExecutable(override) : findExecutable(join(configDir(), 'omp/bin/omp'))
    ?? findExecutable('omp') ?? findExecutable(join(homedir(), '.local/bin/omp'));
}

type Record = { id: string; cwd: string; file: string; title: string; updatedAt: number };
type Flags = { pinned?: boolean; archived?: boolean };
type Entry = Record & Flags;
type State = { sessionId: string; sessionFile: string; sessionName?: string; model?: { id: string; provider: string }; thinkingLevel?: string };
type Block = { type: string; text?: string; id?: string; name?: string; arguments?: unknown };
type Message = { role: string; content?: string | Block[]; timestamp?: number; stopReason?: string; errorMessage?: string; toolCallId?: string; isError?: boolean };

async function json<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return;
    throw error;
  }
}

export async function writeOmpJson(path: string, value: object) {
  const staging = path + '.' + randomUUID();
  try {
    await writeFile(staging, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(staging, path);
  } finally { await unlink(staging).catch(() => {}); }
}

const messageText = (content: Message['content']) => typeof content === 'string' ? content
  : (content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');

export class OmpProject {
  readonly root: string;
  private readonly entries = new Map<string, Entry>();
  private readonly live = new Map<string, OmpConversation>();
  private opening?: Promise<OmpConversation>;
  private flagWrites = Promise.resolve();
  private closed = false;
  private refreshSequence = 0;

  constructor(readonly cwd: string, private readonly codex: CodexRpc, private readonly changed: () => void) {
    const key = createHash('sha256').update(JSON.stringify([cwd, process.env.PI_CODING_AGENT_DIR || '',
      process.env.OMP_PROFILE || ''])).digest('hex');
    this.root = join(configDir(), 'codex-tern', 'omp', key);
  }

  private index(id: string) { return join(this.root, 'index', id + '.json'); }
  private flags(id: string) { return join(this.root, 'flags', id + '.json'); }
  private lockPath(id: string) { return join(this.root, 'locks', id + '.lock'); }

  private async read(id: string) {
    if (!safeId.test(id)) return;
    const record = await json<Record>(this.index(id));
    if (!record || record.id !== id || record.cwd !== this.cwd || !await this.validFile(record.file)) return;
    const flags = await json<Flags>(this.flags(id));
    return { ...record, pinned: flags?.pinned === true, archived: flags?.archived === true };
  }

  private async validFile(file: unknown): Promise<boolean> {
    return typeof file === 'string' && dirname(file) === join(this.root, 'sessions')
      && file.endsWith('.jsonl') && await lstat(file).then(info => info.isFile(), () => false)
      && await realpath(file).then(path => path === file, () => false);
  }

  async refresh() {
    const sequence = ++this.refreshSequence;
    const names = await readdir(join(this.root, 'index')).catch(error => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    });
    const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => this.read(name.slice(0, -5))));
    if (sequence !== this.refreshSequence) return;
    this.entries.clear();
    for (const record of records) if (record) this.entries.set(record.id, record);
    this.changed();
  }

  rows() {
    return [...this.entries.values()].map(entry => {
      const live = this.live.get(entry.id);
      return { id: entry.id, source: 'omp' as const, title: entry.title || 'New omp session',
        activityAt: Math.max(entry.updatedAt || 0, live?.activityAt ?? 0),
        pinned: entry.pinned === true, archived: entry.archived === true, running: !!live?.activeTurn,
        waiting: !!live?.requests.length, canArchive: this.canArchive(entry.id) };
    });
  }

  find(id: string) { return this.live.get(id); }
  get hasWork() { return [...this.live.values()].some(session => session.busy || session.requests.length || session.unconfirmed.length); }
  canArchive(id: string) {
    const live = this.live.get(id);
    return this.entries.has(id) && !this.entries.get(id)?.archived && !live?.busy && !live?.requests.length && !live?.unconfirmed.length;
  }

  setFlags(id: string, change: Flags | 'toggle-pin') {
    if (this.closed) return Promise.reject(new Error('The omp project is closing.'));
    const write = this.flagWrites.then(() => this.saveFlags(id, change));
    this.flagWrites = write.catch(() => {});
    return write;
  }

  private async saveFlags(id: string, change: Flags | 'toggle-pin') {
    if (!safeId.test(id)) throw new Error('Invalid omp session ID.');
    await Promise.all(['locks', 'flags'].map(dir => mkdir(join(this.root, dir), { recursive: true, mode: 0o700 })));
    const live = this.live.get(id);
    const lock = live?.connection === 'ready' ? undefined : FileLock.tryAcquire(this.lockPath(id));
    try {
      if (lock && !lock.acquired) throw new Error('This omp session is open in another client.');
      const entry = await this.read(id);
      if (!entry) throw new Error('This omp session is unavailable in the current project.');
      if (change !== 'toggle-pin' && change.archived && !this.canArchive(id)) throw new Error('Finish the task and pending input before archiving this omp session.');
      if (entry.archived && (change === 'toggle-pin' || change.archived !== false)) throw new Error('Restore this omp session before changing it.');
      const flags = { pinned: entry.pinned === true, archived: entry.archived === true,
        ...(change === 'toggle-pin' ? { pinned: entry.pinned !== true } : change) };
      await writeOmpJson(this.flags(id), flags);
      this.refreshSequence++;
      this.entries.set(id, { ...entry, ...flags });
      this.changed();
    } finally { lock?.release(); }
  }

  async open(id?: string) {
    if (this.closed || this.opening) throw new Error('Wait for the current omp operation to finish.');
    const work = this.openSession(id);
    this.opening = work;
    try { return await work; } finally { this.opening = undefined; }
  }

  private async openSession(id?: string) {
    const record = id === undefined ? undefined : await this.read(id);
    if (id !== undefined && (!record || record.archived)) throw new Error('This omp session is unavailable in the current project.');
    const previous = id === undefined ? undefined : this.live.get(id);
    if (previous?.connection === 'ready') return previous;
    await previous?.close();
    const executable = ompExecutable();
    if (!executable) throw new Error('omp was not found. Install it in Tern’s Agents settings or put omp on PATH.');
    await Promise.all(['sessions', 'index', 'locks'].map(dir => mkdir(join(this.root, dir), { recursive: true, mode: 0o700 })));
    let lock = id ? FileLock.tryAcquire(this.lockPath(id)) : undefined;
    let rpc: OmpRpc | undefined;
    try {
      if (lock && !lock.acquired) throw new Error('This omp session is open in another client.');
      if (record && (await this.read(record.id))?.archived)
        throw new Error('Restore this omp session before opening it.');
      rpc = new OmpRpc(executable, ['--mode', 'rpc', '--no-pty', '--no-title', '--allow-home', '--cwd', this.cwd,
        '--approval-mode', 'always-ask', '--extension', extension, '--session-dir', join(this.root, 'sessions'),
        ...(record ? ['--resume', record.file] : [])], this.cwd);
      const session = new OmpConversation(this.codex, this.cwd, rpc);
      await rpc.start();
      const state: State = await rpc.request('get_state');
      if (typeof state?.sessionId !== 'string' || !safeId.test(state.sessionId) || (record && (record.id !== state.sessionId || record.file !== state.sessionFile))
        || !await this.validFile(state.sessionFile)) throw new Error('omp did not open a persisted session with the expected ID.');
      const file = await open(state.sessionFile, 'r');
      try {
        const buffer = Buffer.alloc(16384);
        const { bytesRead } = await file.read(buffer);
        const header = buffer.toString('utf8', 0, bytesRead).split('\n', 3).slice(0, 2)
          .map(line => JSON.parse(line)).find(line => line.type === 'session');
        if (!header || header.id !== state.sessionId || await realpath(header.cwd) !== this.cwd)
          throw new Error('omp opened a session belonging to a different project or ID.');
      } finally { await file.close(); }
      lock ??= FileLock.tryAcquire(this.lockPath(state.sessionId));
      if (!lock.acquired) throw new Error('This omp session is open in another client.');
      this.refreshSequence++;
      const update = async () => {
        const entry: Record = { id: state.sessionId, cwd: this.cwd, file: state.sessionFile,
          title: state.sessionName || record?.title || session.firstPrompt,
          updatedAt: session.activityAt || record?.updatedAt || Math.floor(Date.now() / 1000) };
        await writeOmpJson(this.index(entry.id), entry);
        this.refreshSequence++;
        this.entries.set(entry.id, { ...record, ...this.entries.get(entry.id), ...entry });
        this.changed();
      };
      await session.hydrate(state);
      if (previous) session.unconfirmed = [...previous.unconfirmed];
      await update();
      session.on('change', this.changed);
      session.on('settled', () => { void update().catch(error => session.notice(error.message, true)); });
      const acquired = lock;
      session.once('closed', () => acquired.release());
      this.live.set(state.sessionId, session);
      return session;
    } catch (error) {
      await rpc?.close();
      lock?.release();
      throw error;
    }
  }

  async close() {
    this.closed = true;
    await this.opening?.catch(() => {});
    await this.flagWrites;
    await Promise.all([...this.live.values()].map(session => session.close()));
  }
}

// Reuses the transcript/composer state shape. The native ID and RPC are kept
// separately from Codex threads, recovery ownership and sandbox settings.
export class OmpConversation extends Conversation {
  id = '';
  activityAt = 0;
  private modelName = '';
  thinking = '';
  private message?: { id: string; turnId: string };
  private closing = false;

  constructor(codex: CodexRpc, cwd: string, private readonly native: OmpRpc) {
    super(codex, cwd);
    this.account = 'omp';
    native.on('event', event => this.onEvent(event));
    native.on('disconnected', error => {
      this.connection = 'disconnected';
      this.finish('failed'); this.requests = [];
      if (!this.closing) this.notice(`omp disconnected: ${error.message}`, true);
      void this.close().catch(error => this.notice(error.message, true));
    });
  }

  override get model() { return this.modelName || 'omp'; }
  get firstPrompt() {
    const first = this.items.find(item => item.item.type === 'userMessage')?.item;
    return first?.type === 'userMessage' ? first.content.filter(i => i.type === 'text').map(i => i.text)
      .join(' ').replace(/\s+/g, ' ').trim().slice(0, 240) : '';
  }

  async hydrate(state: State) {
    this.id = state.sessionId;
    if (state.model) this.modelName = `${state.model.provider}/${state.model.id}`;
    this.thinking = state.thinkingLevel ?? '';
    await this.refreshHistory();
    this.connection = 'ready';
    this.hydrated = true;
  }

  override async refreshHistory() {
    const result = await this.native.request('get_messages') as { messages: Message[] };
    if (!Array.isArray(result?.messages)) throw new Error('omp did not return its message history.');
    this.resetHistory();
    let turn: Turn | undefined;
    for (const message of result.messages) {
      if (!turn || message.role === 'user') {
        turn = this.makeTurn(message.timestamp);
        this.turns.set(turn.id, turn);
      }
      this.showMessage(message, randomUUID(), turn.id, true);
      if (message.role === 'assistant') {
        if (message.stopReason === 'aborted') turn.status = 'interrupted';
        else if (message.stopReason === 'error') turn.status = 'failed';
      }
    }
    for (const value of this.turns.values()) {
      if (value.status === 'inProgress') value.status = 'completed';
      this.endedTurns.add(value.id);
    }
    this.changed();
  }

  private makeTurn(timestamp?: number): Turn {
    return { id: randomUUID(), rootTurnId: null, items: [], itemsView: 'full', startedAt: Math.floor((timestamp ?? Date.now()) / 1000),
      completedAt: null, durationMs: null, status: 'inProgress', error: null };
  }

  private begin() {
    if (this.activeTurn) return this.activeTurn;
    const turn = this.makeTurn();
    this.turns.set(turn.id, turn);
    this.activeTurn = turn.id;
    this.activityAt = Math.floor(Date.now() / 1000);
    this.changed();
    return turn.id;
  }

  private finish(status: Turn['status']) {
    const turn = this.activeTurn ? this.turns.get(this.activeTurn) : undefined;
    if (!turn) return;
    turn.status = status;
    turn.completedAt = Date.now() / 1000;
    turn.durationMs = Math.max(0, (turn.completedAt - turn.startedAt!) * 1000);
    for (const item of this.items) if (item.turnId === turn.id) {
      item.done = true;
      if (item.item.type === 'commandExecution' && item.item.status === 'inProgress') item.item.status = 'declined';
    }
    this.endedTurns.add(turn.id);
    this.activeTurn = null; this.message = undefined; this.requests = [];
    this.changed();
    this.emit('settled');
  }

  private put(turnId: string, item: ThreadItem, done: boolean) {
    const id = `${turnId}:${item.id}`;
    const current = this.items.find(entry => entry.id === id);
    if (current) Object.assign(current, { item, done });
    else this.items.push({ id, turnId, item, done });
  }

  private tool(turnId: string, id: string, name: string, args: unknown, status: 'inProgress' | 'completed' | 'failed', output: string) {
    const previous = this.items.find(entry => entry.id === `${turnId}:${id}`)?.item;
    this.put(turnId, { type: 'commandExecution', id, command: previous?.type === 'commandExecution' ? previous.command
      : [name, args === undefined ? '' : JSON.stringify(args)].filter(Boolean).join(' '), cwd: this.cwd,
      pluginId: null, scriptPath: null, processId: null, source: 'agent', status, commandActions: [],
      aggregatedOutput: output || null, exitCode: null, durationMs: null }, status !== 'inProgress');
  }

  private showMessage(message: Message, id: string, turnId: string, done: boolean) {
    if (message.role === 'user') {
      const text = messageText(message.content);
      const content: UserInput[] = text ? [{ type: 'text', text, text_elements: [] }] : [];
      if (content.length) this.put(turnId, { type: 'userMessage', id, clientId: null, content }, done);
    }
    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const text = messageText(message.content);
      if (text) this.put(turnId, { type: 'agentMessage', id, text, phase: null, memoryCitation: null, delivery: null, questions: null }, done);
      if (done) for (const block of blocks) if (block.type === 'toolCall' && block.id && block.name)
        this.tool(turnId, block.id, block.name, block.arguments, 'inProgress', '');
    }
    if (message.role === 'toolResult' && message.toolCallId) {
      this.tool(turnId, message.toolCallId, 'omp tool', undefined, message.isError ? 'failed' : 'completed', messageText(message.content));
    }
  }

  private onEvent(event: any) {
    if (event.type === 'extension_error') { this.notice(event.error || event.message || 'omp extension error.', true); return; }
    if (event.type === 'extension_ui_request') { this.dialog(event); return; }
    if (event.type === 'agent_start') { this.begin(); return; }
    if (!this.activeTurn) return;
    const turn = this.activeTurn;
    switch (event.type) {
      case 'message_start':
      case 'message_update':
      case 'message_end': {
        if (!event.message) return;
        if (event.type === 'message_start' || !this.message) this.message = { id: randomUUID(), turnId: turn };
        const done = event.type === 'message_end';
        this.showMessage(event.message, this.message.id, this.message.turnId, done);
        if (done) this.message = undefined;
        if (event.message.stopReason === 'error') {
          this.turns.get(turn)!.status = 'failed';
          if (done) this.notice(event.message.errorMessage || 'omp model execution failed.', true);
        }
        if (event.message.stopReason === 'aborted') this.turns.get(turn)!.status = 'interrupted';
        break;
      }
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
        this.tool(turn, event.toolCallId, event.toolName, event.args,
          event.type === 'tool_execution_end' ? event.isError ? 'failed' : 'completed' : 'inProgress',
          messageText((event.result ?? event.partialResult)?.content));
        break;
      case 'prompt_result':
        if (event.status === 'error' || event.status === 'failed' || event.error) {
          this.notice(event.error?.message || event.error || 'omp could not complete the prompt.', true);
          this.finish('failed');
        } else if (event.sessionSettled || event.agentInvoked === false) {
          if (event.status === 'aborted') this.finish('interrupted');
          else this.settle();
        }
        return;
      case 'session_settled': this.settle(); return;
      default: return;
    }
    this.changed();
  }

  private settle() {
    const status = this.turns.get(this.activeTurn ?? '')?.status;
    this.finish(status && status !== 'inProgress' ? status : 'completed');
  }

  private dialog(event: any) {
    if (event.method === 'notify') { this.notice(String(event.message ?? ''), event.notifyType === 'error'); return; }
    if (['setStatus', 'setWidget', 'setTitle', 'set_editor_text', 'setWorkingMessage', 'setWorkingIndicator'].includes(event.method)) return;
    if (event.method === 'cancel') {
      const target = typeof event.targetId === 'string' ? event.targetId : event.id;
      this.requests = this.requests.filter(request => request.id !== target);
    } else {
      if (typeof event.id !== 'string') return;
      if (!this.requests.some(request => request.id === event.id))
        this.requests.push({ id: event.id, method: 'omp/interaction', params: event, answers: {} });
    }
    this.changed();
  }

  override answer(id: RpcId, result: unknown, expected?: PendingRequest) {
    const request = this.requests.find(request => request.id === id);
    if (!request || (expected && expected !== request) || typeof id !== 'string') return;
    this.native.reply(id, result as object);
    this.requests = this.requests.filter(item => item !== request); this.changed();
  }

  override async submit(text: string, images: string[] = []) {
    if (!text.trim() && !images.length) return;
    if (images.length) throw new Error('Use text or paste a file path in omp.');
    if (this.busy || this.requests.length || this.unconfirmed.length) throw new Error('Wait for this omp turn to finish before sending.');
    this.operation = 'Sending…';
    this.begin();
    try {
      const receipt = await this.native.request('prompt', { message: text }, true);
      if (receipt?.agentInvoked === false) this.settle();
    } catch (error) {
      if (isRpcOutcomeUnknown(error)) this.unconfirmed.push({ id: randomUUID(), text, images: [], nativeDelivery: true });
      this.finish('failed');
      throw error;
    } finally { this.operation = ''; this.changed(); }
  }

  override async stop() {
    const turn = this.activeTurn;
    if (!turn) return;
    const running = this.turns.get(turn);
    if (running) running.status = 'interrupted';
    await this.native.request('abort');
  }

  async close() {
    if (this.closing) return this.native.close();
    this.closing = true;
    await this.native.close();
    this.emit('closed');
  }
}
