import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodexRpc } from './rpc';
import type { Method, RpcId } from './protocol';

export type ReservationProbe = (() => Promise<string | null>) & { peek?: () => string | null; retired?: () => string | null };
export interface ChiefGuard { id(): Promise<string | null>; rememberRequests(requests: Iterable<{ id: RpcId; params: any }>): void }
const installed = Symbol.for('codex-tern.weixin-chief-guard.v2');
const readOnly = new Set(['thread/read', 'thread/turns/list', 'thread/loaded/list', 'thread/unsubscribe']);
export const reservedMessage = '这是微信专用 Chief。请在微信里继续；桌面不能接管或向它发送消息。';

export function reservationProbe(env = process.env): ReservationProbe | undefined {
  if (env.CODEX_TERN_WEIXIN_DISABLE === '1') return;
  // Isolated native tests must opt in with their own explicit data directory.
  if (env.QA_CODEX_HOME && !(env.CODEX_TERN_WEIXIN_RESERVATION_TEST === '1' && env.WB_DATA_DIR)) return;
  const directory = env.WB_DATA_DIR || (env.CODEX_TERN_WORKBENCH_DIR
    ? join(env.CODEX_TERN_WORKBENCH_DIR, 'data') : fileURLToPath(new URL('../../real-workbench/data/', import.meta.url)));
  const marker = join(directory, 'weixin/chief-reservation.json');
  const parse = (raw: string) => {
    const data = JSON.parse(raw);
    if (data.version !== 1 || data.role !== 'weixin-chief' || data.session !== null && (typeof data.session !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.session)))
      throw new Error('微信专用会话保护状态无效，未接管会话。');
    if (data.retired !== undefined && typeof data.retired !== 'boolean') throw new Error('微信专用会话保护状态无效。');
    return data as { session: string | null; retired?: boolean };
  };
  const failure = (error: unknown): null => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('微信专用会话保护状态读取失败，请稍后重试。'); };
  const probe: ReservationProbe = async () => { try { return parse(await readFile(marker, 'utf8')).session; } catch (error) { return failure(error); } };
  probe.peek = () => { try { return parse(readFileSync(marker, 'utf8')).session; } catch (error) { return failure(error); } };
  probe.retired = () => { try { const data = parse(readFileSync(marker, 'utf8')); return data.retired ? data.session : null; } catch (error) { return failure(error); } };
  return probe;
}

/** Compatible with a retained ABI8 controller: no constructor identity check,
 * no new controller method and no automatic unsubscribe during UI reload. */
export function installChiefGuard(rpc: CodexRpc, probe?: ReservationProbe): ChiefGuard | undefined {
  const transport = rpc as CodexRpc & { [installed]?: ChiefGuard };
  if (transport[installed]) return transport[installed];
  // Pure UI unit transports have no native owner lifecycle.
  if (!probe && (!rpc.options?.cwd || typeof rpc.ownsThread !== 'function')) return;
  probe ||= reservationProbe(); if (!probe) return;
  let cached: string | null | undefined;
  const id = async () => cached = await probe!();
  const request = rpc.request.bind(rpc);
  const requests = new Map<string, string>();
  const rememberRequests = (pending: Iterable<{ id: RpcId; params: any }>) => {
    for (const item of pending) if (typeof item.params?.threadId === 'string') requests.set(JSON.stringify(item.id), item.params.threadId);
  };
  if (typeof rpc.on === 'function') rpc.on('request', message => {
    requests.delete(JSON.stringify(message.id)); rememberRequests([message]);
  });
  const protectResponse = (requestId: RpcId) => {
    const thread = requests.get(JSON.stringify(requestId));
    if (!thread) return;
    const reserved = probe!.peek ? probe!.peek() : cached;
    if (reserved === undefined || thread === reserved) throw new Error(reservedMessage);
    requests.delete(JSON.stringify(requestId));
  };
  if (typeof rpc.respond === 'function') {
    const respond = rpc.respond.bind(rpc); rpc.respond = (requestId, result) => { protectResponse(requestId); respond(requestId, result); };
  }
  if (typeof rpc.rejectRequest === 'function') {
    const reject = rpc.rejectRequest.bind(rpc); rpc.rejectRequest = (requestId, message) => { protectResponse(requestId); reject(requestId, message); };
  }
  rpc.request = (async (method: Method, params: any) => {
    if (typeof params?.threadId === 'string' && !readOnly.has(method)) {
      if (params.threadId === await id()) throw new Error(reservedMessage);
    }
    return request(method, params);
  }) as CodexRpc['request'];
  // Auxiliary transports must inherit the same reservation boundary.
  // A new peer may gain resume/fork paths later; it must not bypass the guard.
  if (typeof rpc.createPeer === 'function') {
    const createPeer = rpc.createPeer.bind(rpc);
    rpc.createPeer = () => { const peer = createPeer(); installChiefGuard(peer, probe); return peer; };
  }
  const guard: ChiefGuard = { id, rememberRequests };
  transport[installed] = guard; return guard;
}
