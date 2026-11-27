import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { RpcOutcomeUnknown } from './rpc';
import { closeOwnedRpcChild, spawnOwnedRpcChild } from './owned-rpc-process';

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout; write: boolean };
type Chunk = { id: string; count: number; size: number; parts: Buffer[]; bytes: number };

// This JSONL transport has its own handshake and command/response IDs.
export class OmpRpc extends EventEmitter {
  private readonly child;
  private readonly pending = new Map<string, Pending>();
  private readonly ready: Promise<number[]>;
  private readonly exited: Promise<void>;
  private sequence = 0;
  private stderr = '';
  private failure?: Error;
  private closing = false;
  private chunk?: Chunk;

  constructor(binary: string, args: string[], cwd: string) {
    super();
    this.child = spawnOwnedRpcChild(binary, args, { cwd, env: process.env });
    this.child.stderr.on('data', bytes => { this.stderr = (this.stderr + bytes.toString()).slice(-1600); });
    this.child.stdin.on('error', error => this.fail(error.message));
    this.child.on('error', error => this.fail(error.message));
    this.exited = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.fail(this.stderr.trim() || `omp exited (${signal ?? code}).`);
      resolve();
    }));
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('Timed out waiting for omp RPC to start.'), 20000);
      this.once('ready', versions => { clearTimeout(timer); resolve(versions); });
      this.once('disconnected', error => { clearTimeout(timer); reject(error); });
    });
    createInterface({ input: this.child.stdout }).on('line', line => {
      if (this.failure) return;
      try { this.decode(JSON.parse(line)); }
      catch (error) { this.fail(`Invalid omp RPC frame: ${(error as Error).message}`); }
    });
  }

  async start() {
    if ((await this.ready).includes(2)) await this.request('negotiate_protocol', { protocolVersion: 2 });
  }

  request(type: string, fields = {}, write = false): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(`Timed out waiting for omp ${type}.`), 15000);
      this.pending.set(id, { resolve, reject, timer, write });
      this.send({ ...fields, type, id });
    });
  }

  reply(id: string, fields: object) {
    if (this.failure) throw this.failure;
    this.send({ ...fields, type: 'extension_ui_response', id });
  }

  private send(frame: object) {
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }

  private decode(frame: any) {
    if (frame.type === 'rpc_chunk') {
      const current = this.chunk ??= { id: frame.chunkId, count: frame.count, size: frame.byteLength, parts: [] as Buffer[], bytes: 0 };
      if (typeof current.id !== 'string' || !Number.isSafeInteger(current.count) || current.count < 1 || current.count > 1024
        || !Number.isSafeInteger(current.size) || current.size < 1 || current.size > 64 * 1024 * 1024
        || current.id !== frame.chunkId || current.parts.length !== frame.index || current.count !== frame.count
        || current.size !== frame.byteLength || typeof frame.data !== 'string') throw new Error('Invalid chunk sequence');
      const bytes = Buffer.from(frame.data, 'base64');
      current.bytes += bytes.length;
      if (current.bytes > current.size) throw new Error('Chunk size exceeded');
      current.parts.push(bytes);
      if (current.parts.length < current.count) return;
      if (current.bytes !== current.size) throw new Error('Incomplete chunk');
      this.chunk = undefined;
      this.decode(JSON.parse(Buffer.concat(current.parts).toString('utf8')));
      return;
    }
    if (this.chunk || typeof frame.type !== 'string') throw new Error('Invalid frame sequence');
    if (frame.type === 'ready') this.emit('ready', frame.supportedProtocolVersions ?? []);
    else if (frame.type === 'response') {
      const request = this.pending.get(frame.id);
      if (!request) return;
      this.pending.delete(frame.id);
      clearTimeout(request.timer);
      if (frame.success) request.resolve(frame.data);
      else request.reject(new Error(frame.error || `omp rejected ${frame.command}.`));
    } else if (frame.type === 'rpc_frame_error') this.fail(frame.error || 'omp reported an RPC framing error.');
    else this.emit('event', frame);
  }

  private fail(message: string) {
    if (this.failure) return;
    this.failure = new Error(message);
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(request.write ? new RpcOutcomeUnknown('omp/prompt', id, message) : this.failure);
    }
    this.pending.clear();
    this.emit('disconnected', this.failure);
    if (!this.closing) void this.close().catch(() => {});
  }

  async close() {
    this.closing = true;
    await closeOwnedRpcChild(this.child);
    await this.exited;
  }
}
