import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type RelayCall = (input: Record<string, unknown>) => Promise<any>;

/** One short-lived private Node process per call. No token in argv, env or logs. */
export function localRelayBridge(node: string, directory: string, dataDir?: string): RelayCall {
  return input => new Promise((resolve, reject) => {
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 262144) { reject(new Error('Relay payload exceeds 256KiB')); return; }
    const child = spawn(node, ['--disable-warning=ExperimentalWarning', 'runtime/weixin/bridge.mjs'], {
      cwd: directory, env: { ...process.env, ...(dataDir ? { WB_DATA_DIR: dataDir } : {}) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', failed = false;
    const timeout = setTimeout(() => { failed = true; child.kill('SIGTERM'); reject(new Error('Private relay response is uncertain')); }, 8000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 300000) { failed = true; child.kill(); reject(new Error('Invalid relay response')); }
    });
    child.stderr.resume(); // Never forward bridge output/errors containing capabilities.
    child.on('error', () => { clearTimeout(timeout); failed = true; reject(new Error('Private Node relay could not start')); });
    child.stdin.on('error', () => { /* Exit/timeout handles uncertain transport. */ });
    child.on('close', () => {
      clearTimeout(timeout); if (failed) return;
      try {
        const reply = JSON.parse(output);
        if (reply.ok !== true) throw new Error();
        resolve(reply.result);
      } catch { reject(new Error('Private relay did not confirm this call')); }
    });
    child.stdin.end(body);
  });
}

/** Capability is intentionally private and never included in application state. */
export class RelayConnection {
  readonly client = `codex-tern:${randomUUID()}`;
  #token?: string;
  constructor(private readonly call: RelayCall) {}
  async open() {
    const reply = await this.call({ action: 'weixin-relay-open', client: this.client });
    if (reply.protocol !== 1 || typeof reply.token !== 'string' || !/^[a-f0-9]{64}$/.test(reply.token)) throw Error('Invalid relay protocol');
    this.#token = reply.token;
  }
  async request(action: 'publish' | 'claim' | 'ack' | 'receipt', input: Record<string, unknown> = {}) {
    if (!this.#token) throw Error('Relay is not attached');
    return this.call({ ...input, action: `weixin-relay-${action}`, client: this.client, token: this.#token });
  }
}
