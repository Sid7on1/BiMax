import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SavedThread } from './thread.manager';
import type { ThreadSummary } from '../shared/threads';

/**
 * Serialized atomic snapshots; streamed updates coalesce, completed history survives relaunch.
 *
 * `saveNow` writes one thread at once, for an accepted or dispatched message (backlog F1). Every save carries a
 * generation, and a write never replaces a thread's file with an older generation than the one already written, so a
 * coalesced save still in flight cannot undo a message `saveNow` just recorded.
 */
export interface ThreadStorageOptions {
  /** Told the error when a write fails, and null once everything that failed has been written. */
  onFailure?: (message: string | null) => void;
  /** Schedules a retry. Defaults to the process timer. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

export class ThreadStorage {
  private pending = new Map<string, { value: SavedThread; generation: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<void> = Promise.resolve();
  private generation = 0;
  private written = new Map<string, number>();
  private failures = 0;
  private failure: string | null = null;
  private retryScheduled = false;
  constructor(private dir: string, private options: ThreadStorageOptions = {}) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }

  /** How many threads have changes not yet on disk. */
  unsaved(): number { return this.pending.size; }

  /** The last write error, or null while saving works. */
  lastError(): string | null { return this.failure; }
  load(): SavedThread[] {
    return fs.readdirSync(this.dir).filter(n => /^[\w-]+\.json$/.test(n)).slice(0, 200).flatMap(n => {
      try {
        const file = path.join(this.dir,n);
        if (fs.statSync(file).size > 32 * 1024 * 1024) return [];
        const value = JSON.parse(fs.readFileSync(file,'utf8'));
        return value.summary && Array.isArray(value.state?.items) ? [value] : [];
      } catch { return []; }
    });
  }
  private archiveDir(): string { return path.join(this.dir, 'archive'); }

  /** How many threads are in the archive (backlog N11). */
  archivedCount(): number {
    try { return fs.readdirSync(this.archiveDir()).filter((n) => /^[\w-]+\.json$/.test(n)).length; } catch { return 0; }
  }

  /**
   * Write a thread's final state and stop saving it, because it is leaving the list (archive or Bin). A save still
   * pending or in flight, or a failed write retried later, can then never write its file again. Returns that file.
   */
  async writeFinal(value: SavedThread): Promise<string> {
    const id = value.summary.id;
    if (!/^[\w-]{1,80}$/.test(id)) throw new Error('Thread not found');
    // From here every save of it (pending, in flight, or retried after a failed write) is skipped when its batch runs.
    this.written.set(id, Number.MAX_SAFE_INTEGER);
    await this.writes;
    const file = path.join(this.dir, `${id}.json`);
    const temporary = `${file}.final.tmp`;
    await fsp.writeFile(temporary, this.text(this.copy(value)), { mode: 0o600 });
    await fsp.rename(temporary, file);
    return file;
  }

  /** The thread stays in the list after all (archiving or binning it failed): save it again. */
  readmit(id: string): void {
    this.written.delete(id);
  }

  /** Move a thread, with its final state, out of the list into `archive/`. Nothing is deleted. */
  async archive(value: SavedThread): Promise<void> {
    try {
      const file = await this.writeFinal(value);
      await fsp.mkdir(this.archiveDir(), { recursive: true, mode: 0o700 });
      await fsp.rename(file, path.join(this.archiveDir(), path.basename(file)));
    } catch (error) {
      this.readmit(value.summary.id);
      throw error;
    }
  }

  /** Archived threads, most recently archived first, without their conversations. */
  async archived(limit = 100): Promise<ThreadSummary[]> {
    const names = await fsp.readdir(this.archiveDir()).catch(() => [] as string[]);
    const files = await Promise.all(names.filter((n) => /^[\w-]+\.json$/.test(n)).map(async (n) => {
      const file = path.join(this.archiveDir(), n);
      const stat = await fsp.stat(file).catch(() => null);
      return stat && stat.size <= 32 * 1024 * 1024 ? { file, name: n, mtimeMs: stat.mtimeMs } : null;
    }));
    const newest = files.filter((f): f is NonNullable<typeof f> => !!f).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
    const out: ThreadSummary[] = [];
    for (const { file, name } of newest) {
      try {
        const value = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (value?.summary && `${value.summary.id}.json` === name) out.push({ ...value.summary, status: 'stopped', peers: [] });
      } catch { /* unreadable: not listed */ }
    }
    return out;
  }

  /** An archived thread's file, for moving it to the Bin. */
  archivedFile(id: string): string {
    const file = path.join(this.archiveDir(), `${id}.json`);
    if (!/^[\w-]{1,80}$/.test(id) || !fs.existsSync(file)) throw new Error('That archived thread was not found.');
    return file;
  }

  /** Move an archived thread back into the list's folder and return it. */
  async unarchive(id: string): Promise<SavedThread> {
    const source = this.archivedFile(id);
    const value = JSON.parse(await fsp.readFile(source, 'utf8'));
    if (!value?.summary || value.summary.id !== id || !Array.isArray(value.state?.items)) throw new Error('That archived thread cannot be read.');
    const target = path.join(this.dir, `${id}.json`);
    if (fs.existsSync(target)) throw new Error('That thread is already in the list.');
    await fsp.rename(source, target);
    this.readmit(id);
    return value;
  }

  private copy(value: SavedThread): SavedThread {
    return { summary: { ...value.summary }, state: value.state, ...(value.inputs ? { inputs: value.inputs.map((input) => ({ ...input })) } : {}) };
  }

  private text(value: SavedThread): string {
    // Secrets entered in approval dialogs are never stored in this transcript snapshot.
    return JSON.stringify({ ...value, state: { ...value.state, request: null } });
  }

  save(value: SavedThread): void {
    this.pending.set(value.summary.id, { value: this.copy(value), generation: ++this.generation });
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 500);
  }

  /** Write this thread now, synchronously. Supersedes its pending coalesced save. */
  saveNow(value: SavedThread): void {
    const generation = ++this.generation;
    const file = path.join(this.dir, `${value.summary.id}.json`);
    const temporary = `${file}.${generation}.tmp`;
    fs.writeFileSync(temporary, this.text(this.copy(value)), { mode: 0o600 });
    fs.renameSync(temporary, file);
    this.written.set(value.summary.id, generation);
    const pending = this.pending.get(value.summary.id);
    if (pending && pending.generation < generation) this.pending.delete(value.summary.id);
  }
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = [...this.pending.values()]; this.pending.clear();
    // One failed write used to reject this chain for good, so no later save ever ran, even after the disk was fixed
    // (backlog F12, T05). A failure now stays inside its batch: the thread goes back to pending and is retried.
    this.writes = this.writes.then(async () => {
      let failed: string | null = null;
      for (const entry of batch) {
        const { value, generation } = entry;
        const id = value.summary.id;
        if ((this.written.get(id) ?? 0) > generation) continue;
        const file = path.join(this.dir, `${id}.json`);
        const temporary = `${file}.${generation}.tmp`;
        try {
          await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
          await fsp.writeFile(temporary, this.text(value), { mode: 0o600 });
          // A newer saveNow may have landed while this was being written: never replace it with older state.
          if ((this.written.get(id) ?? 0) > generation) { await fsp.rm(temporary, { force: true }); continue; }
          await fsp.rename(temporary, file);
          this.written.set(id, generation);
        } catch (error) {
          failed = (error as Error).message;
          await fsp.rm(temporary, { force: true }).catch(() => undefined);
          const newer = this.pending.get(id);
          if (!newer || newer.generation < generation) this.pending.set(id, entry);
        }
      }
      this.settle(failed);
    });
    return this.writes;
  }

  /** After a batch: on failure, say so and retry with a growing delay (at most 30 seconds); on recovery, say that. */
  private settle(failed: string | null): void {
    if (failed) {
      this.failures++;
      this.failure = failed;
      this.options.onFailure?.(failed);
      if (this.retryScheduled) return;
      this.retryScheduled = true;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.failures - 1, 5));
      const schedule = this.options.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
      schedule(() => { this.retryScheduled = false; void this.flush(); }, delay);
      return;
    }
    if (this.failure && !this.pending.size) {
      this.failures = 0;
      this.failure = null;
      this.options.onFailure?.(null);
    }
  }
}
