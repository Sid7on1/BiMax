import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SavedThread } from './thread.manager';
import type { ThreadSummary, ThreadRecoveryEntry } from '../shared/threads';

/** Encoded snapshot bytes, shared by every writer and reader. Not a renderer/engine memory budget. */
export const THREAD_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
/** Space for the Bin undo envelope, including the largest safe integer timestamp. */
export const THREAD_RECOVERY_MAX_BYTES = THREAD_SNAPSHOT_MAX_BYTES + Buffer.byteLength(JSON.stringify({ value: null, archived: false, at: Number.MAX_SAFE_INTEGER })) - 4;
const HISTORY_LIMIT_MESSAGE = 'Conversation history exceeds the 32 MiB saved-history limit. Export this conversation and start a new one. The previous saved copy is unchanged.';

function historySize(info: fs.Stats, maxBytes: number): number {
  if (!info.isFile() || info.nlink !== 1) throw new Error('Saved history is not a regular private file.');
  if (info.size > maxBytes) throw new Error(HISTORY_LIMIT_MESSAGE);
  return info.size;
}
function unchangedHistory(before: fs.Stats, after: fs.Stats): void {
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
    throw new Error('Saved history changed while reading.');
}
const parseHistory = (bytes: Buffer): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

/** Descriptor-bound, bounded reads; growing/special files cannot bypass the snapshot byte limit. */
export function readBoundedHistoryJson(file: string, maxBytes = THREAD_SNAPSHOT_MAX_BYTES): unknown {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    const bytes = Buffer.alloc(historySize(info, maxBytes));
    let read = 0;
    while (read < bytes.length) {
      const n = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (!n) throw new Error('Saved history changed while reading.');
      read += n;
    }
    unchangedHistory(info, fs.fstatSync(fd));
    return parseHistory(bytes);
  } finally { fs.closeSync(fd); }
}

function threadSnapshot(raw: unknown, id: string): SavedThread {
  const value = raw as SavedThread;
  if (value?.summary?.id !== id || !path.isAbsolute(value.summary.root ?? '') || !Array.isArray(value.state?.items))
    throw new Error('Saved conversation cannot be read.');
  return value;
}
export function readThreadSnapshot(file: string, id: string): SavedThread {
  return threadSnapshot(readBoundedHistoryJson(file), id);
}
/** Interactive archive/restore retains async I/O; only the bounded JSON parse runs in main. */
async function readThreadSnapshotAsync(file: string, id: string): Promise<SavedThread> {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    const bytes = Buffer.alloc(historySize(info, THREAD_SNAPSHOT_MAX_BYTES));
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
      if (!bytesRead) throw new Error('Saved history changed while reading.');
      read += bytesRead;
    }
    unchangedHistory(info, await handle.stat());
    return threadSnapshot(parseHistory(bytes), id);
  } finally { await handle.close(); }
}

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
  private recovery = new Map<string, ThreadRecoveryEntry>();
  constructor(private dir: string, private options: ThreadStorageOptions = {}) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }

  /** How many threads have changes not yet on disk. */
  unsaved(): number { return this.pending.size; }

  /** The last write error, or null while saving works. */
  lastError(): string | null { return this.failure; }
  private recoveryKey(id: string, archived: boolean, backup = false): string { return `${backup ? 'bin/' : archived ? 'archive/' : ''}${id}`; }
  private reportRecovery(file: string, id: string, archived: boolean, reason?: ThreadRecoveryEntry['reason'], backup = false): void {
    let bytes = 0;
    try { bytes = fs.lstatSync(file).size; } catch { /* retain a visible unreadable entry */ }
    this.recovery.set(this.recoveryKey(id, archived, backup), { id, archived, ...(backup ? { backup: true } : {}), bytes, reason: reason ?? (bytes > (backup ? THREAD_RECOVERY_MAX_BYTES : THREAD_SNAPSHOT_MAX_BYTES) ? 'oversized' : 'unreadable') });
  }
  noteRecoveryBackup(id: string): void {
    if (/^[\w-]{1,80}$/.test(id)) this.reportRecovery(path.join(this.dir, '.bin-recovery', `${id}.json`), id, false, undefined, true);
  }
  recoverable(): ThreadRecoveryEntry[] { return [...this.recovery.values()].map(entry => ({ ...entry })); }
  /** Resolve only a catalogued retained record. The renderer supplies an id and location, never a path. */
  recoveryFile(id: string, archived: boolean, backup = false): string {
    if (!/^[\w-]{1,80}$/.test(id) || (archived && backup) || !this.recovery.has(this.recoveryKey(id, archived, backup))) throw new Error('Recovery copy not found.');
    return path.join(this.dir, ...(backup ? ['.bin-recovery'] : archived ? ['archive'] : []), `${id}.json`);
  }
  recoveryRoot(): string { return this.dir; }
  load(): SavedThread[] {
    for (const [key, value] of this.recovery) if (!value.archived && !value.backup) this.recovery.delete(key);
    const loaded: SavedThread[] = [];
    for (const n of fs.readdirSync(this.dir).filter(n => /^[\w-]{1,80}\.json$/.test(n))) {
      const file = path.join(this.dir, n), id = n.slice(0, -5);
      try {
        if (loaded.length >= 200) { this.reportRecovery(file, id, false, 'capacity'); continue; }
        loaded.push(readThreadSnapshot(file, id));
      } catch { this.reportRecovery(file, id, false); }
    }
    // Discover oversized archived files by metadata only, even before Archived is opened.
    if (fs.existsSync(this.archiveDir())) for (const n of fs.readdirSync(this.archiveDir()).filter(n => /^[\w-]{1,80}\.json$/.test(n))) {
      const file = path.join(this.archiveDir(), n);
      try { if (fs.lstatSync(file).size > THREAD_SNAPSHOT_MAX_BYTES) this.reportRecovery(file, n.slice(0, -5), true); }
      catch { this.reportRecovery(file, n.slice(0, -5), true); }
    }
    return loaded;
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
    const text = this.text(this.copy(value));
    // From here every save of it (pending, in flight, or retried after a failed write) is skipped when its batch runs.
    this.written.set(id, Number.MAX_SAFE_INTEGER);
    await this.writes;
    const file = path.join(this.dir, `${id}.json`);
    const temporary = `${file}.final.tmp`;
    await fsp.writeFile(temporary, text, { mode: 0o600 });
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
      if (stat && stat.size > THREAD_SNAPSHOT_MAX_BYTES) this.reportRecovery(file, n.slice(0, -5), true);
      return stat && stat.size <= THREAD_SNAPSHOT_MAX_BYTES ? { file, name: n, mtimeMs: stat.mtimeMs } : null;
    }));
    const newest = files.filter((f): f is NonNullable<typeof f> => !!f).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
    const out: ThreadSummary[] = [];
    for (const { file, name } of newest) {
      try {
        const value = await readThreadSnapshotAsync(file, name.slice(0, -5));
        if (value?.summary && `${value.summary.id}.json` === name) out.push({ ...value.summary, status: 'stopped', peers: [] });
        this.recovery.delete(this.recoveryKey(name.slice(0, -5), true));
      } catch { this.reportRecovery(file, name.slice(0, -5), true); }
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
    const value = await readThreadSnapshotAsync(source, id);
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
    if (this.recovery.has(this.recoveryKey(value.summary.id, false))) throw new Error('Export the recovery copy before replacing this unreadable saved conversation.');
    // Secrets entered in approval dialogs are never stored in this transcript snapshot.
    const text = JSON.stringify({ ...value, state: { ...value.state, request: null } });
    if (Buffer.byteLength(text, 'utf8') > THREAD_SNAPSHOT_MAX_BYTES) throw new Error(HISTORY_LIMIT_MESSAGE);
    return text;
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
    try {
      fs.writeFileSync(temporary, this.text(this.copy(value)), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
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
          // The generation check and replacement must share one main-event-loop turn. An async
          // rename can finish AFTER saveNow has committed a newer generation and erase its input.
          // Only the metadata replacement is synchronous; preparing/writing snapshot bytes stays async.
          fs.renameSync(temporary, file);
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
