import { CombinedAutocompleteProvider, type AutocompleteItem, type AutocompleteProvider } from '@oh-my-pi/pi-tui/autocomplete';
import { commandCompletions } from './commands';
import { skillPrefix, type SkillInput, type Skills } from './skills';
import type { Language } from './i18n';

/** OMP has no automatic `$` trigger. Draft opens its public Tab completion route. */
export class Completion extends CombinedAutocompleteProvider {
  private choices = new Map<string, SkillInput>();
  constructor(cwd: string, language: Language, private readonly skills?: Skills,
    private readonly select?: (skill: SkillInput) => void) { super(commandCompletions(language), cwd); }
  private async skillSuggestions(lines: string[], line: number, col: number, signal?: AbortSignal) {
    const prefix = skillPrefix((lines[line] ?? '').slice(0, col));
    if (!prefix || !this.skills) return undefined;
    try {
      const skills = await this.skills.list();
      if (signal?.aborted) return null;
      const items = skills.filter(s => s.name.toLowerCase().startsWith(prefix.slice(1).toLowerCase())).map(s => {
        const value = `skill-choice:${encodeURIComponent(s.path)}`;
        this.choices.set(value, { type: 'skill', name: s.name, path: s.path });
        return { value, label: `$${s.name}`, description: `${s.path} · ${s.description}`, nativeDetail: s.path };
      });
      return { prefix, items };
    } catch { return null; }
  }
  override async getSuggestions(...args: Parameters<AutocompleteProvider['getSuggestions']>) {
    const result = await this.skillSuggestions(args[0], args[1], args[2], args[3]);
    return result !== undefined ? result : super.getSuggestions(...args);
  }
  override async getForceFileSuggestions(lines: string[], line: number, col: number, signal?: AbortSignal) {
    const result = await this.skillSuggestions(lines, line, col, signal);
    return result !== undefined ? result : super.getForceFileSuggestions(lines, line, col, signal);
  }
  override applyCompletion(lines: string[], line: number, col: number, item: AutocompleteItem, prefix: string) {
    const skill = prefix.startsWith('$') && this.choices.get(item.value);
    if (!skill) return super.applyCompletion(lines, line, col, item, prefix);
    const before = lines[line]!.slice(0, col), after = lines[line]!.slice(col);
    const text = before.slice(0, -prefix.length) + `$${skill.name} `;
    return { lines: lines.map((value, index) => index === line ? text + after : value),
      cursorLine: line, cursorCol: text.length, onApplied: () => this.select?.(skill) };
  }
}
