import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { recoveryPath } from './recovery';
import { isLanguage, type Language } from './i18n';

export const preferencesPath = () => join(dirname(dirname(recoveryPath(''))), 'preferences.json');

/** Client preferences are shared across projects, independently of Codex config. */
export class Preferences {
  model?: string;
  language: Language = 'en';
  pinned: string[] = [];
  private writing: Promise<void> = Promise.resolve();
  constructor(readonly path?: string) {}

  async load() {
    await this.writing;
    if (!this.path) return;
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (data?.version !== 1 || (data.defaultModel !== undefined
        && (typeof data.defaultModel !== 'string' || !data.defaultModel.trim())))
        throw new Error('Invalid new session preferences.');
      if (data.language !== undefined && !isLanguage(data.language)) throw new Error('Invalid interface language.');
      if (data.pinned !== undefined && (!Array.isArray(data.pinned) || !data.pinned.every((id: unknown) => typeof id === 'string')))
        throw new Error('Invalid pinned sessions.');
      this.model = data.defaultModel;
      this.language = data.language ?? 'en';
      this.pinned = [...new Set<string>(data.pinned ?? [])];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.model = undefined; this.language = 'en'; this.pinned = [];
    }
  }

  setModel(model?: string) { return this.save({ defaultModel: model }); }
  setPinned(id: string, pinned: boolean) { return this.save({ pin: { id, pinned } }); }
  setLanguage(language: Language) {
    if (!isLanguage(language)) return Promise.reject(new Error('Invalid interface language.'));
    return this.save({ language });
  }
  private save(update: { defaultModel?: string; language?: Language; pin?: { id: string; pinned: boolean } }) {
    const work = this.writing.then(async () => {
      let data = { version: 1, defaultModel: this.model, language: this.language, pinned: this.pinned };
      if (this.path) {
        try {
          const saved = JSON.parse(await readFile(this.path, 'utf8'));
          if (saved?.version !== 1 || (saved.language !== undefined && !isLanguage(saved.language)))
            throw new Error('Invalid interface preferences.');
          data = { ...data, ...saved };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const { pin, ...fields } = update;
      if (!Array.isArray(data.pinned) || !data.pinned.every(id => typeof id === 'string')) throw new Error('Invalid pinned sessions.');
      data = { ...data, ...fields, pinned: pin ? [...new Set([...data.pinned.filter(id => id !== pin.id), ...(pin.pinned ? [pin.id] : [])])] : data.pinned };
      if (this.path) {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(data) + '\n', { mode: 0o600 });
          await rename(temporary, this.path);
        } finally { await rm(temporary, { force: true }); }
      }
      this.model = data.defaultModel; this.language = data.language; this.pinned = data.pinned;
    });
    this.writing = work.catch(() => {});
    return work;
  }
}
