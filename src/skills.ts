import type { CodexRpc } from './rpc';
import type { SkillMetadata } from './generated/v2/SkillMetadata';

export interface SkillInput { type: 'skill'; name: string; path: string }
export const skillNames = (text: string) => [...new Set([...text.matchAll(/(?:^|[\s(（【「『“‘，。；：！？、])\$([\w][\w:.-]*)(?=$|[\s),;!?\]}，。；：！？、（）【】「」『』“”‘’])/g)].map(m => m[1]!.replace(/[.:]+$/, '')))];
export const skillPrefix = (text: string) => /(?:^|\s)(\$[\w:.-]*)$/.exec(text)?.[1];

/** Cwd-scoped discovery. Late results never replace another workspace's catalog. */
export class Skills {
  items: SkillMetadata[] = [];
  error = '';
  loading = false;
  private disabled = new Set<string>();
  private cwd = '';
  private generation = 0;
  private pending?: { cwd: string; generation: number; promise: Promise<SkillMetadata[]> };
  constructor(private readonly rpc: CodexRpc, private readonly workspace: () => string,
    private readonly changed: () => void) {}
  invalidate() { this.generation++; this.items = []; this.disabled.clear(); this.error = ''; this.loading = false; }
  sync() {
    if (this.cwd !== this.workspace()) { this.cwd = this.workspace(); this.invalidate(); }
  }
  async list(forceReload = true): Promise<SkillMetadata[]> {
    this.sync();
    const cwd = this.cwd, generation = this.generation;
    if (this.pending?.cwd === cwd && this.pending.generation === generation) return this.pending.promise;
    this.loading = true; this.error = ''; this.changed();
    const current = () => this.workspace() === cwd && this.generation === generation;
    const promise = Promise.resolve().then(async () => {
      try {
        const response = await this.rpc.request('skills/list', { cwds: [cwd], forceReload });
        if (!current()) throw new Error('Skills workspace changed. Try again.');
        const entry = response.data.find(e => e.cwd === cwd);
        if (!entry) throw new Error('No skills result for this workspace.');
        this.items = [...new Map(entry.skills.filter(s => s.enabled).map(s => [s.path, s])).values()];
        this.disabled = new Set(entry.skills.filter(s => !s.enabled).map(s => s.name));
        this.error = entry.errors.map(e => `${e.path}: ${e.message}`).join('\n');
        return this.items;
      } catch (error) {
        if (current()) { this.items = []; this.error = (error as Error).message; }
        throw error;
      } finally {
        if (current()) { this.loading = false; this.changed(); }
        if (this.pending?.promise === promise) this.pending = undefined;
      }
    });
    this.pending = { cwd, generation, promise };
    return promise;
  }
  async resolve(text: string, selected: readonly SkillInput[] = []): Promise<SkillInput[]> {
    const names = skillNames(text);
    if (!names.length) return [];
    const available = await this.list();
    return names.flatMap(name => {
      const matches = available.filter(s => s.name === name);
      const chosen = selected.find(s => s.name === name);
      // Shell variables and other dollar-prefixed prose remain ordinary text.
      if (!matches.length && !chosen && !this.disabled.has(name)) return [];
      const skill = chosen ? matches.find(s => s.path === chosen.path) : matches.length === 1 ? matches[0] : undefined;
      if (!skill) throw new Error(matches.length > 1 ? `Choose a path for $${name} in /skills.`
        : `Skill unavailable: $${name}. Refresh /skills or edit the message.`);
      return [{ type: 'skill' as const, name: skill.name, path: skill.path }];
    });
  }
}
