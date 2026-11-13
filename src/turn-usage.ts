/** A turn may contain several model requests. Native totals are cumulative per thread. */
export type TurnUsage = { input: number; cached: number; output?: number };
type Sample = TurnUsage;
const sample = (value: any): Sample | undefined => {
  const input = value?.inputTokens, cached = value?.cachedInputTokens, output = value?.outputTokens;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(cached) || cached < 0 || cached > input) return;
  return { input, cached, ...(Number.isSafeInteger(output) && output >= 0 ? { output } : {}) };
};
export class TurnUsageTracker {
  readonly completed = new Map<string, TurnUsage>();
  private active = new Map<string, { sum: TurnUsage; previous?: Sample; valid: boolean; outputValid: boolean; seen: boolean }>();
  private previous?: Sample;
  begin(id: string) { if (!this.active.has(id)) this.active.set(id, { sum: { input: 0, cached: 0, output: 0 }, previous: this.previous, valid: true, outputValid: true, seen: false }); }
  update(id: string, usage: any) {
    const total = sample(usage?.total), last = sample(usage?.last), state = this.active.get(id);
    if (state) {
      if (!total || !last) state.valid = false;
      else {
        const delta = state.previous ? { input: total.input - state.previous.input, cached: total.cached - state.previous.cached } : last;
        if (delta.input < 0 || delta.cached < 0 || delta.cached > delta.input) state.valid = false;
        else { state.sum.input += delta.input; state.sum.cached += delta.cached; state.seen ||= delta.input > 0 || delta.cached > 0; }
        const output = state.previous ? (total.output !== undefined && state.previous.output !== undefined ? total.output - state.previous.output : undefined) : last.output;
        if (output === undefined || output < 0) state.outputValid = false;
        else if (state.outputValid) state.sum.output! += output;
        state.previous = total;
      }
    }
    if (total) this.previous = total;
  }
  current(id: string): TurnUsage | undefined {
    const state = this.active.get(id);
    if (!state?.valid || !state.seen) return;
    const { input, cached, output } = state.sum;
    return { input, cached, ...(state.outputValid ? { output } : {}) };
  }
  finish(id: string) {
    const result = this.current(id); this.active.delete(id);
    if (result) this.completed.set(id, result);
  }
  disconnect() { this.active.clear(); this.previous = undefined; }
}

/** Output per whole-turn wall time includes tool calls and waits, not pure model speed. */
export function turnMetrics(usage: TurnUsage | undefined, durationMs: number | null | undefined, language: 'en' | 'zh-CN') {
  if (!usage || usage.input <= 0) return;
  const zh = language === 'zh-CN';
  const rate = (usage.cached / usage.input * 100).toFixed(1);
  const tps = usage.output !== undefined && durationMs != null && Number.isFinite(durationMs) && durationMs > 0
    ? (usage.output * 1000 / durationMs).toFixed(1) : undefined;
  return {
    text: `${zh ? '缓存' : 'Cache'} ${rate}%${tps === undefined ? '' : ` · ${zh ? '均速' : 'Avg'} ${tps} t/s`}`,
    title: zh ? '本轮缓存输入占总输入的比例。整轮均速为输出 token 除以整轮耗时，包含工具调用和等待。'
      : 'Cached input as a share of total input for this turn. Turn average is output tokens divided by wall time, including tool calls and waiting.',
  };
}
