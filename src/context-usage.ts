import type { CodexRpc } from './rpc';
import { translate, type Language } from './i18n';

export interface ContextUsage { used: number | null; capacity: number | null }
export interface ContextUsageStore { get(threadId?: string): ContextUsage | undefined }
const installed = Symbol.for('codex-tern.context-usage.v1');
const valid = (value: unknown, minimum: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum;

/** Keep native estimates beside the retained transport, including across UI reloads.
 * No model-name limits, accumulated totals or cache subtraction are inferred. */
export function installContextUsage(rpc: CodexRpc): ContextUsageStore {
  const owner = rpc as CodexRpc & { [installed]?: ContextUsageStore };
  if (owner[installed]) return owner[installed];
  const values = new Map<string, ContextUsage>();
  rpc.on('notification', message => {
    const p = message.params;
    if (message.method !== 'thread/tokenUsage/updated' || typeof p?.threadId !== 'string') return;
    values.set(p.threadId, {
      used: valid(p.tokenUsage?.last?.totalTokens, 0) ? p.tokenUsage.last.totalTokens : null,
      capacity: valid(p.tokenUsage?.modelContextWindow, 1) ? p.tokenUsage.modelContextWindow : null,
    });
  });
  rpc.on('disconnected', () => values.clear());
  const store: ContextUsageStore = { get: id => id ? values.get(id) : undefined };
  owner[installed] = store;
  return store;
}

const compact = (value: number | null) => value === null ? '—'
  : value >= 1e6 ? `${+(value / 1e6).toFixed(1)}M`
  : value >= 1e3 ? `${+(value / 1e3).toFixed(1)}k` : String(value);
export function contextUsageLabel(usage: ContextUsage | undefined, language: Language) {
  const used = usage?.used ?? null, capacity = usage?.capacity ?? null;
  const percentage = used !== null && capacity !== null ? `${+(used / capacity * 100).toFixed(1)}%` : '—%';
  const t = (value: string) => translate(language, value);
  const exact = (value: number | null) => value === null ? '—' : value.toLocaleString(language);
  return {
    text: `${t('Context')} ${compact(used)} / ${compact(capacity)} · ${percentage}`,
    title: `${t('Context')}: ${exact(used)} / ${exact(capacity)} tokens · ${percentage} ${t('used')}. ${t('Latest native context estimate, not cumulative task usage.')}`,
  };
}
