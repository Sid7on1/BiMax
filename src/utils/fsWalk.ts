import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Directories that are almost never worth scanning and that would otherwise
 * dominate search results (and walk time) in a real project.
 */
export const DEFAULT_IGNORE_DIRS = new Set<string>([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt',
  '.cache', '.breakglass', '.evolution_worktrees', '.turbo', 'out', 'vendor',
]);

export interface WalkOptions {
  signal?: AbortSignal;
  onDirectory?: (path: string, entries: import('fs').Dirent[]) => void;
  onIncomplete?: (reason: string) => void;
  /** Directory names to skip entirely. Defaults to DEFAULT_IGNORE_DIRS. */
  ignoreDirs?: Set<string>;
  /** Hard cap on the number of files yielded, to bound runaway walks. */
  maxFiles?: number;
}

/**
 * Iteratively walk a directory tree yielding absolute file paths.
 *
 * Symlinked directories are not followed (they report as non-directories via
 * Dirent), which keeps the walk free of cycles without extra bookkeeping.
 */
export async function* walkFiles(root: string, opts: WalkOptions = {}): AsyncGenerator<string> {
  const ignore = opts.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const maxFiles = opts.maxFiles ?? 50_000;
  let count = 0;

  const stack: string[] = [root];
  while (stack.length > 0) {
    opts.signal?.throwIfAborted();
    const dir = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
      opts.onDirectory?.(dir, entries);
    } catch {
      opts.onIncomplete?.('Directory could not be read');
      continue; // unreadable directory — skip rather than abort the whole walk
    }
    for (const entry of entries) {
      opts.signal?.throwIfAborted();
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        yield full;
        if (++count >= maxFiles) { opts.onIncomplete?.('File scan limit reached'); return; }
      }
    }
  }
}
