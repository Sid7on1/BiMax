import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { stateDir } from '../utils/state.dir';

/**
 * The context archive: tool output cleared or cut from the prompt, kept outside it and addressed by its hash.
 *
 * Micro-compaction replaced an old result with a stub that could only say "re-run the tool", and the oversized-result
 * cap cut out the middle with no way back. Both now save the whole text here first and put a handle in the prompt
 * (record 50 step 5). A handle is `archive:<id>`, where the id is the first 32 hex digits (128 bits) of the text's
 * sha256, and every read checks that prefix, so what comes back is what was cleared, never a newer version of whatever
 * produced it.
 *
 * The hash checks content, not authority to read (audit 51, U05). So the archive never follows a symlink: not for the
 * directory, not for a file in it. Writes go to a temporary name and are renamed into place, so a reader never sees
 * half a file and a link at the final name is replaced rather than written through.
 *
 * Bounded: one result over MAX_ARCHIVED_BYTES is not archived, and the store keeps at most MAX_FILES files and
 * MAX_BYTES bytes, oldest first. Because one item is far below the total, the newest file always fits (U06). An evicted
 * handle reads back as missing, never as empty.
 */

const MAX_FILES = 256;
const MAX_BYTES = 64 * 1024 * 1024;
/** The largest single result the archive keeps. A larger one is not archived, and its stub mentions no handle. */
export const MAX_ARCHIVED_BYTES = 8 * 1024 * 1024;
const HANDLE = /^archive:([0-9a-f]{32})$/;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export interface ArchivedOutput {
  handle: string;
  id: string;
  sha256: string;
  bytes: number;
}

export type ArchiveRead =
  | { ok: true; text: string; sha256: string }
  | { ok: false; reason: 'malformed' | 'missing' | 'corrupt' | 'unsafe' };

export function archiveDirectory(): string {
  return path.join(stateDir('.breakglass'), 'context-archive');
}

/** The archive directory when it is a plain directory; `unsafe` when it is a link or anything else. */
function directory(create: boolean): { dir: string } | { reason: 'missing' | 'unsafe' } {
  const dir = archiveDirectory();
  try {
    if (create) fs.mkdirSync(dir, { recursive: true });
    const stat = fs.lstatSync(dir);
    return stat.isDirectory() ? { dir } : { reason: 'unsafe' };
  } catch {
    return { reason: 'missing' };
  }
}

/** One archive file's text, opened without following a link, and only a regular file within the per-item cap. */
function readRegular(file: string): { text: string } | { reason: 'missing' | 'unsafe' } {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    return { reason: (error as NodeJS.ErrnoException).code === 'ELOOP' ? 'unsafe' : 'missing' };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ARCHIVED_BYTES) return { reason: 'unsafe' };
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = fs.readSync(fd, buffer, read, stat.size - read, read);
      if (!n) break;
      read += n;
    }
    return { text: buffer.subarray(0, read).toString('utf8') };
  } catch {
    return { reason: 'missing' };
  } finally {
    fs.closeSync(fd);
  }
}

const sha256Of = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Save `text` and return its handle, or null when it cannot be saved. A caller then must not mention a handle. */
export function archiveOutput(text: string): ArchivedOutput | null {
  try {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_ARCHIVED_BYTES) return null;
    const opened = directory(true);
    if (!('dir' in opened)) return null;
    const sha256 = sha256Of(bytes);
    const id = sha256.slice(0, 32);
    const file = path.join(opened.dir, `${id}.txt`);
    // A stored copy is reused only after it is checked: a damaged one used to be handed out again, and every read of
    // it then failed (audit 51, U06).
    const existing = readRegular(file);
    if ('text' in existing && sha256Of(existing.text) === sha256) {
      const now = new Date();
      fs.utimesSync(file, now, now); // still in use: the oldest-first prune should reach it last
    } else {
      const temporary = path.join(opened.dir, `.${id}.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(temporary, bytes, { flag: 'wx' });
      fs.renameSync(temporary, file);
      prune(opened.dir, file);
    }
    return { handle: `archive:${id}`, id, sha256, bytes: bytes.length };
  } catch {
    return null;
  }
}

/** Read a handle back, refusing text that no longer hashes to its id and anything reached through a link. */
export function readArchivedOutput(handle: string): ArchiveRead {
  const match = HANDLE.exec(handle.trim());
  if (!match) return { ok: false, reason: 'malformed' };
  const opened = directory(false);
  if (!('dir' in opened)) return { ok: false, reason: opened.reason };
  const read = readRegular(path.join(opened.dir, `${match[1]}.txt`));
  if (!('text' in read)) return { ok: false, reason: read.reason };
  const sha256 = sha256Of(read.text);
  return sha256.startsWith(match[1]) ? { ok: true, text: read.text, sha256 } : { ok: false, reason: 'corrupt' };
}

/** Keep the archive under its caps, oldest first, never removing the file just written. */
function prune(dir: string, keep: string): void {
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.txt') && !name.startsWith('.'))
    .flatMap((name) => {
      const file = path.join(dir, name);
      try {
        const stat = fs.lstatSync(file);
        return [{ file, bytes: stat.size, mtimeMs: stat.mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  let count = files.length;
  let bytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of files) {
    if (count <= MAX_FILES && bytes <= MAX_BYTES) break;
    if (entry.file === keep) continue;
    try {
      fs.unlinkSync(entry.file);
      count--;
      bytes -= entry.bytes;
    } catch { /* raced away */ }
  }
}
