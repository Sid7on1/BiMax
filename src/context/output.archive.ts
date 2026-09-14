import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { stateDir } from '../utils/state.dir';

/**
 * The context archive: tool output cleared or cut from the prompt, kept outside it and addressed by its hash.
 *
 * Micro-compaction replaced an old result with a stub that could only say "re-run the tool", and the oversized-result
 * cap cut out the middle with no way back. Both now save the whole text here first and put a handle in the prompt
 * (record 50 step 5). A handle is `archive:<id>`, where the id is the first 32 hex digits of the text's sha256, and
 * every read checks that hash, so what comes back is exactly what was cleared, never a newer version of whatever
 * produced it.
 *
 * Bounded by file count and bytes, oldest first. An evicted handle reads back as missing, never as empty.
 */

const MAX_FILES = 256;
const MAX_BYTES = 64 * 1024 * 1024;
const HANDLE = /^archive:([0-9a-f]{32})$/;

export interface ArchivedOutput {
  handle: string;
  id: string;
  sha256: string;
  bytes: number;
}

export type ArchiveRead =
  | { ok: true; text: string; sha256: string }
  | { ok: false; reason: 'malformed' | 'missing' | 'corrupt' };

export function archiveDirectory(): string {
  return path.join(stateDir('.breakglass'), 'context-archive');
}

/** Save `text` and return its handle, or null when it cannot be saved. A caller then must not mention a handle. */
export function archiveOutput(text: string): ArchivedOutput | null {
  try {
    const sha256 = createHash('sha256').update(text).digest('hex');
    const id = sha256.slice(0, 32);
    const dir = archiveDirectory();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.txt`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
      prune(dir, file);
    }
    return { handle: `archive:${id}`, id, sha256, bytes: Buffer.byteLength(text) };
  } catch {
    return null;
  }
}

/** Read a handle back, refusing text that no longer hashes to its id. */
export function readArchivedOutput(handle: string): ArchiveRead {
  const match = HANDLE.exec(handle.trim());
  if (!match) return { ok: false, reason: 'malformed' };
  let text: string;
  try {
    text = fs.readFileSync(path.join(archiveDirectory(), `${match[1]}.txt`), 'utf8');
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const sha256 = createHash('sha256').update(text).digest('hex');
  return sha256.startsWith(match[1]) ? { ok: true, text, sha256 } : { ok: false, reason: 'corrupt' };
}

/** Keep the archive under its caps, oldest first, never removing the file just written. */
function prune(dir: string, keep: string): void {
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.txt'))
    .map((name) => {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      return { file, bytes: stat.size, mtimeMs: stat.mtimeMs };
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
