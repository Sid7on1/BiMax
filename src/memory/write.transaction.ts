import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { openSqlite } from '../core/sqlite';

/** Maximum wait for a cooperating memory writer, not a lease that can steal live ownership. */
const WRITE_WAIT_MS = 30_000;

function busy(error: unknown): boolean {
  const e = error as { code?: string; errcode?: number; errno?: number; message?: string };
  const code = e.errcode ?? e.errno;
  return (typeof code === 'number' && [5, 6].includes(code & 0xff))
    || /SQLITE_(?:BUSY|LOCKED)/.test(e.code ?? '')
    || /database (?:is )?(?:locked|busy)/i.test(e.message ?? '');
}

/**
 * Serialize JSON reload/mutate/publish across isolates and processes using SQLite's OS-backed
 * write reservation. The sidecar holds no application data. Never unlink it or steal a live lock.
 * A killed holder releases its connection automatically; async retries let its event loop run.
 * Every cooperating writer must use this protocol. Local filesystems only are qualified.
 */
export async function withMemoryWriteTransaction<T>(file: string, run: (canonicalFile: string) => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const canonicalFile = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
  try {
    if ((await fs.lstat(canonicalFile)).isSymbolicLink()) throw new Error('Memory store must not be a symbolic link.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const lockFile = `${canonicalFile}.writer.sqlite`;
  try {
    if ((await fs.lstat(lockFile)).isSymbolicLink()) throw new Error('Memory writer coordinator must not be a symbolic link.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const db = openSqlite(lockFile);
  if (!db) throw new Error('Memory writes require the SQLite coordinator; no uncoordinated write was attempted.');
  let held = false;
  try {
    db.exec('PRAGMA busy_timeout = 0');
    const deadline = performance.now() + WRITE_WAIT_MS;
    for (;;) {
      try { db.exec('BEGIN IMMEDIATE'); held = true; break; }
      catch (error) {
        if (!busy(error)) throw error;
        if (performance.now() >= deadline) throw new Error('Memory writer is busy; the update was not saved.', { cause: error });
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    return await run(canonicalFile);
  } finally {
    try { if (held) db.exec('ROLLBACK'); }
    finally { db.close(); }
  }
}
