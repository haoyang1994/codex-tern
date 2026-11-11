import { resolve } from 'node:path';
import type { Controller } from './controller';
import type { Thread } from './generated/v2/Thread';
import { probeWriterLocks, type LockProbe } from './session-locks';

export interface FolderSession {
  id: string;
  title: string;
  titleRevision?: string;
  updatedAt: number;
  time: string;
  locked: boolean;
  running: boolean;
  waiting: boolean;
  permission: boolean;
  completed: boolean;
  failed: boolean;
  canArchive: boolean;
  pinned: boolean;
}

function activityAt(thread: Thread) {
  return [thread.recencyAt, thread.updatedAt, thread.createdAt].find(time => typeof time === 'number' && Number.isFinite(time)) ?? 0;
}

/** A separate list cache: the legacy history picker's scope cannot change it. */
export class FolderSessions {
  private cwd: string;
  private threads: Thread[] = [];
  // Pins discovered beyond the visible pages must not advance normal pagination
  // or leak into the unpinned list when their preference is removed.
  private pinnedThreads: Thread[] = [];
  private cursor: string | null = null;
  private pages = 0;
  private generation = 0;
  private request?: { generation: number; more: boolean; promise: Promise<void> };
  private moreRequest?: { generation: number; promise: Promise<void> };
  private visible = false;
  private disposed = false;
  private observed = '';
  private connection: Controller['connection'];
  private locked = new Set<string>();
  private conflicts = new Map<string, number>();
  private lockRequest?: { generation: number; ids: string; promise: Promise<void> };
  private readonly timeFormat = new Intl.DateTimeFormat(undefined,
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  loading = false;
  error = '';

  constructor(private readonly c: Controller, private readonly changed: () => void,
    private readonly probe: LockProbe = ids => probeWriterLocks(c.rpc, ids)) {
    this.cwd = c.cwd;
    this.connection = c.connection;
    this.rememberCurrent();
    this.observed = this.fingerprint();
    c.on('change', this.observe);
  }

  // Opening history changes updatedAt, but does not constitute chat activity.
  private fingerprint() { return JSON.stringify([this.c.cwd, this.c.connection, this.c.sessionsVersion]); }

  private sort() { this.threads.sort((a, b) => activityAt(b) - activityAt(a)); }
  private allThreads() {
    const known = new Set(this.threads.map(t => t.id));
    return [...this.threads, ...this.pinnedThreads.filter(t => this.c.isPinned(t.id) && !known.has(t.id))];
  }

  private mergeLocal() {
    const merge = (thread: Thread) => {
      const local = this.c.sessionThread(thread.id);
      return local ? { ...thread, ...(local.name !== undefined ? { name: local.name } : {}),
        ...(local.preview ? { preview: local.preview } : {}),
        recencyAt: Math.max(activityAt(thread), activityAt(local)) } : thread;
    };
    this.threads = this.threads.map(merge);
    this.pinnedThreads = this.pinnedThreads.map(merge);
    this.sort();
  }

  private rememberCurrent() {
    const current = this.c.thread;
    if (!current?.cwd || this.c.isArchived(current.id) || resolve(current.cwd) !== resolve(this.cwd)) return;
    const at = this.threads.findIndex(t => t.id === current.id);
    if (at < 0) this.threads.push(current);
    this.mergeLocal();
  }

  private observe = () => {
    if (this.connection !== this.c.connection) {
      this.connection = this.c.connection;
      if (this.connection !== 'ready') { this.generation++; this.loading = false; }
    }
    if (this.cwd !== this.c.cwd) {
      this.cwd = this.c.cwd; this.generation++;
      this.threads = []; this.pinnedThreads = []; this.cursor = null; this.pages = 0; this.loading = false; this.error = '';
      this.locked.clear(); this.conflicts.clear();
    }
    this.rememberCurrent();
    const next = this.fingerprint();
    if (next === this.observed) return;
    this.observed = next;
    if (this.visible && this.c.connection === 'ready') void this.refresh();
  };

  get snapshot() {
    this.sort();
    const current = this.c.thread;
    const rows: FolderSession[] = this.allThreads().filter(t => !t.ephemeral && !this.c.isArchived(t.id)
      && (t.name?.trim() || t.preview?.trim() || this.c.sessionHasContent(t.id)))
      .sort((a, b) => Number(this.c.isPinned(b.id)) - Number(this.c.isPinned(a.id)) || activityAt(b) - activityAt(a)).map(t => ({
      id: t.id, title: (t.name || t.preview || 'New session').replace(/\s+/g, ' ').slice(0, 240),
      titleRevision: this.c.sessionTitleRevision(t.id),
      updatedAt: t.updatedAt,
      time: activityAt(t) ? this.timeFormat.format(new Date(activityAt(t) * 1000)) : '',
      locked: this.isLocked(t.id),
      pinned: this.c.isPinned(t.id),
      canArchive: this.c.canArchiveSession(t.id) && !this.isLocked(t.id),
      ...this.c.sessionStatus(t.id),
      permission: this.c.sessionNeedsPermission(t.id),
    }));
    return { version: 1, cwd: this.cwd, current: current?.id ?? '', rows,
      loading: this.loading, error: this.error, more: !!this.cursor,
      blockedReason: this.c.selecting ? 'Opening session…' : '',
      canSwitch: this.c.connection === 'ready' && !this.c.selecting,
      connected: this.c.connection === 'ready', connecting: this.c.connection === 'connecting' };
  }

  contains(id: string) { return this.allThreads().some(t => t.id === id); }
  get(id: string) { return this.allThreads().find(t => t.id === id); }
  isLocked(id: string) {
    // Ownership may change after an asynchronous probe or a previous conflict.
    // Loaded background conversations must stay selectable, just like this one.
    return id !== this.c.thread?.id && !this.c.rpc.ownsThread?.(id) && this.locked.has(id);
  }
  markLocked(id: string) {
    this.locked.add(id); this.conflicts.set(id, Date.now() + 15000);
    this.error = ''; this.changed();
  }
  clearError() { if (this.error) { this.error = ''; this.changed(); } }
  fail(message: string) { this.error = message; this.changed(); }
  hide() { this.visible = false; }

  refreshLocks(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const generation = this.generation;
    const ids = this.allThreads().map(t => t.id);
    const key = JSON.stringify(ids);
    if (this.lockRequest?.generation === generation && this.lockRequest.ids === key) return this.lockRequest.promise;
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await this.probe(ids);
        if (this.disposed || generation !== this.generation || this.lockRequest?.promise !== promise) return;
        const previous = [...this.locked].sort().join(',');
        if (result !== null) { this.locked = result; this.conflicts.clear(); }
        else for (const [id, until] of this.conflicts) if (Date.now() >= until) {
          this.locked.delete(id); this.conflicts.delete(id);
        }
        if (previous !== [...this.locked].sort().join(',')) this.changed();
      } catch { /* Keep the last known state when process inspection is unavailable. */ }
      finally { if (this.lockRequest?.promise === promise) this.lockRequest = undefined; }
    });
    this.lockRequest = { generation, ids: key, promise };
    return promise;
  }

  refresh(more = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.visible = true;
    this.observe();
    if (this.c.connection !== 'ready') return Promise.resolve();
    if (this.request?.generation === this.generation) {
      if (!more || this.request.more) return this.request.promise;
      if (this.moreRequest?.generation === this.generation) return this.moreRequest.promise;
      // A click during background repair must advance from the repaired cursor,
      // rather than disappearing into the refresh already in progress.
      const generation = this.generation;
      const promise = this.request.promise.then(() => {
        if (this.moreRequest?.promise === promise) this.moreRequest = undefined;
        if (!this.disposed && generation === this.generation) return this.refresh(true);
      }).finally(() => { if (this.moreRequest?.promise === promise) this.moreRequest = undefined; });
      this.moreRequest = { generation, promise };
      return promise;
    }
    if (more && !this.cursor) return Promise.resolve();
    const generation = this.generation;
    const cwd = this.cwd;
    const first = this.pages === 0 && !more;
    const current = () => !this.disposed && generation === this.generation;
    this.loading = true; this.error = ''; this.changed();
    // A deferred start also coalesces changes emitted while an RPC is being set up.
    const promise = Promise.resolve().then(async () => {
      const read = async (indexed = false) => {
        // Refresh all pages already shown. A session switch must not collapse
        // a paged list back to its first page while the user is clicking it.
        const rows: Thread[] = [];
        let cursor = more ? this.cursor : null;
        let count = 0;
        const pages = more ? 1 : Math.max(1, this.pages);
        const inFolder = (t: Thread) => !t.ephemeral && !this.c.isArchived(t.id) && resolve(t.cwd) === resolve(cwd);
        const listPage = (cursor: string | null) => this.c.rpc.request('thread/list', {
          cwd, archived: false, limit: 30, sortKey: 'recency_at', sortDirection: 'desc',
          ...(cursor ? { cursor } : {}),
          ...(indexed ? { useStateDbOnly: true } : {}),
        });
        do {
          const page = await listPage(cursor);
          if (!current()) return;
          rows.push(...page.data.filter(inFolder));
          cursor = page.nextCursor ?? null; count++;
        } while (cursor && count < pages);
        // Only the authoritative scan-and-repair read supplements pins. Keep
        // its cursor separate: Load more must still start at the visible page.
        let pinnedRows: Thread[] | undefined;
        if (!indexed && !more) {
          pinnedRows = [];
          const wanted = new Set(this.c.preferences.pinned);
          for (const row of rows) wanted.delete(row.id);
          let pinCursor = cursor;
          const visited = new Set<string>();
          while (pinCursor && wanted.size) {
            if (visited.has(pinCursor)) throw new Error('Session pagination repeated a cursor while finding pinned sessions.');
            visited.add(pinCursor);
            const page = await listPage(pinCursor);
            if (!current()) return;
            for (const row of page.data.filter(inFolder)) if (wanted.delete(row.id)) pinnedRows.push(row);
            pinCursor = page.nextCursor ?? null;
          }
        }
        const incoming = new Map(rows.map(t => [t.id, t]));
        const known = new Set(this.threads.map(t => t.id));
        const retained = this.threads
          .filter(t => !this.c.isArchived(t.id)
            && (pinnedRows === undefined || !this.c.isPinned(t.id) || incoming.has(t.id))
            && (more || cursor || incoming.has(t.id) || t.id === this.c.thread?.id))
          .map(t => incoming.get(t.id) ?? t);
        const added = [...incoming.values()].filter(t => !known.has(t.id));
        // Refresh follows backend activity order, including its tie order.
        // Pagination keeps earlier pages and merges duplicates before sorting.
        this.threads = more ? [...retained, ...added]
          : [...incoming.values(), ...retained.filter(t => !incoming.has(t.id))];
        if (pinnedRows !== undefined) this.pinnedThreads = pinnedRows;
        this.mergeLocal();
        this.cursor = cursor; this.pages = more ? this.pages + count : count;
        await this.refreshLocks();
      };
      try {
        if (first) {
          try {
            await read(true);
            if (!current()) return;
            // Publish indexed rows before scanning rollouts. An empty index
            // stays in Loading until repair can confirm that the folder is empty.
            this.loading = this.snapshot.rows.length === 0; this.changed();
          } catch { /* Older backends or an unavailable index use the normal read below. */ }
        }
        if (current()) await read();
      } catch (error) {
        if (!this.disposed && generation === this.generation)
          this.error = error instanceof Error ? error.message : String(error);
      } finally {
        if (!this.disposed && generation === this.generation) {
          this.request = undefined; this.loading = false; this.changed();
        }
      }
    });
    this.request = { generation, more, promise };
    return promise;
  }

  dispose() { this.disposed = true; this.generation++; this.c.off('change', this.observe); }

  reloadState() {
    return { cwd: this.cwd, threads: this.threads, pinnedThreads: this.pinnedThreads, cursor: this.cursor, pages: this.pages,
      visible: this.visible, locked: this.locked, conflicts: this.conflicts, error: this.error };
  }
  restoreReloadState(state: ReturnType<FolderSessions['reloadState']>) {
    Object.assign(this, state);
  }
}
