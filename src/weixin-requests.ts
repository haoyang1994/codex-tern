import { createHash } from 'node:crypto';
import type { Conversation, PendingRequest } from './conversation';

const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const canonicalHash = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(v)) ?? 'undefined').digest('hex');
export const containsSecret = (v: any): boolean => typeof v === 'string'
  ? /\b(?:sk-[\w-]{16,}|Bearer\s+\S+|(?:password|passwd|token|secret|api[_-]?key)\s*(?:[=:]|\s)\s*\S+)/i.test(v)
  : !!v && typeof v === 'object' && Object.entries(v).some(([k, value]) =>
    (/^(password|passwd|(?:access|refresh|bot|context)[_-]?token|token|secret|credentials|authorization|client[_-]?secret|cookie|api[_-]?key|isSecret)$/i.test(k) && !!value) || containsSecret(value));

export type RelayRequest = { id: string; version: string; turn: string; hash: string; kind: 'approval' | 'input'; prompt: string; expires_at: string };
export type RequestIdentity = { hash: string; kind: RelayRequest['kind']; prompt: string };

/** Full native context, never a shortened command or tool title. */
export function requestIdentity(c: Conversation, r: PendingRequest): RequestIdentity | undefined {
  const p = r.params;
  if (!c.thread || p?.threadId !== c.thread.id || !p.turnId || p.turnId !== c.activeTurn || containsSecret(p)) return;
  let kind: RelayRequest['kind'];
  let extra: unknown;
  if (r.method === 'item/commandExecution/requestApproval') {
    if (typeof p.command !== 'string' || !p.command.trim() || typeof p.cwd !== 'string' || !p.cwd.trim()
      || (p.kind && p.kind !== 'command')) return;
    const known = new Set(['kind', 'threadId', 'turnId', 'itemId', 'startedAtMs', 'approvalId', 'environmentId', 'reason',
      'networkApprovalContext', 'command', 'cwd', 'commandActions', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments']);
    if (Object.keys(p).some(k => !known.has(k))) return;
    kind = 'approval';
  } else if (r.method === 'item/fileChange/requestApproval') {
    // Session-wide roots are not representable as one-call approval.
    if (p.grantRoot) return;
    const change = c.items.find(i => i.turnId === p.turnId && i.item.id === p.itemId && i.item.type === 'fileChange');
    if (!change || change.item.type !== 'fileChange' || !change.item.changes.length) return;
    extra = change.item.changes;
    if (containsSecret(extra)) return;
    kind = 'approval';
  } else if (r.method === 'item/tool/requestUserInput') {
    if (!Array.isArray(p.questions) || !p.questions.length || p.questions.some((q: any) => typeof q.id !== 'string'
      || typeof q.question !== 'string' || !q.question.trim() || q.isSecret
      || (q.options != null && (!Array.isArray(q.options) || q.options.some((o: any) => typeof o.label !== 'string'))))) return;
    if (new Set(p.questions.map((q: any) => q.id)).size !== p.questions.length) return;
    kind = 'input';
  } else return; // URL authentication and complex/unknown forms stay in the native client.
  const context = { method: r.method, params: p, cwd: c.cwd, thread: c.thread.id, turn: c.activeTurn, requestId: r.id, ...(extra ? { changes: extra } : {}) };
  // Presentation is separate from the full canonical identity above. Keep
  // multiline commands/diffs literal and omit wire routing metadata from prose.
  const prompt = kind === 'input' ? [
    '需要回答以下问题：', ...p.questions.map((q: any, i: number) => [
      `${i + 1}. ${q.header ? q.header + '：' : ''}${q.question}`,
      ...(q.options ?? []).map((o: any) => `- ${o.label}${o.description ? '：' + o.description : ''}`),
      `问题标识：${q.id}${q.options?.length && !q.isOther ? '（必须使用完整原选项标签）' : '（允许自由回答）'}`,
    ].join('\n')),
    '单题可直接回复原答案；多题必须回复JSON对象 {"真实questionId":"原答案"}。',
  ].join('\n\n') : r.method === 'item/commandExecution/requestApproval' ? [
    '操作：运行命令（仅本次调用，不授予会话或永久权限）', p.reason && `原因：${p.reason}`,
    `目录：${p.cwd}`, p.environmentId && `环境：${p.environmentId}`, '完整命令：', p.command,
    p.networkApprovalContext && `本次网络访问范围：\n${JSON.stringify(p.networkApprovalContext, null, 2)}`,
  ].filter(Boolean).join('\n') : [
    '操作：修改文件（仅本次调用）', p.reason && `原因：${p.reason}`, `目录：${c.cwd}`,
    ...(extra as any[]).map(change => `${change.path}\n变更：${JSON.stringify(change.kind)}\n${change.diff}`),
  ].filter(Boolean).join('\n');
  if (prompt.length > 24000 || containsSecret(prompt)) return;
  return { hash: canonicalHash(context), kind, prompt };
}

export function requestResponse(r: PendingRequest, action: string, answer: unknown): unknown {
  if (r.method.endsWith('/requestApproval')) {
    if (!['允许', '拒绝'].includes(action) || answer !== null) throw Error('Only a decision for this invocation is allowed');
    return { decision: action === '允许' ? 'accept' : 'decline' };
  }
  if (r.method !== 'item/tool/requestUserInput' || action !== '回答' || typeof answer !== 'string' || !answer.trim()) throw Error('Invalid question answer');
  const questions = r.params.questions;
  let values: Record<string, unknown>;
  if (questions.length === 1) values = { [questions[0].id]: answer };
  else {
    try { values = JSON.parse(answer); } catch { throw Error('Multiple questions require an exact question-ID JSON object'); }
    if (!values || Array.isArray(values) || typeof values !== 'object'
      || Object.keys(values).sort().join('\0') !== questions.map((q: any) => q.id).sort().join('\0')) throw Error('Question IDs do not match');
  }
  const answers: Record<string, { answers: string[] }> = {};
  for (const q of questions) {
    const value = values[q.id];
    if (typeof value !== 'string' || !value.trim() || q.isSecret) throw Error('Missing or secret answer');
    if (q.options?.length && !q.options.some((o: any) => o.label === value) && !q.isOther) throw Error('Answer must match an original option label');
    answers[q.id] = { answers: [value] };
  }
  return { answers };
}
