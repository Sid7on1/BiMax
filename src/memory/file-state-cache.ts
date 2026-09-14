import * as fs from 'fs/promises';
import { createHash } from 'crypto';

interface CacheEntry {
  content: string;
  mtime: number;        // ms since epoch — used to detect file changes
  stamp?: string;       // mtime, size and ctime when read (see statStamp); absent when only an mtime was passed
  fileHash?: string;    // hash of the WHOLE file's text when read (see hashFileText); absent when the caller lacked it
  cachedAt: number;     // ms since epoch — used for recency in post-compact restoration
  evictedByModel: boolean;
  hitCount: number;     // how many times this exact (path+range+mtime) combo was served from cache
}

const MAX_ENTRIES = 100;
// Key: `${absPath}\0${offset}\0${limit}` — null byte separator (can't appear in paths)
const SEP = '\0';

function makeKey(absPath: string, offset?: number, limit?: number): string {
  return `${absPath}${SEP}${offset ?? 0}${SEP}${limit ?? -1}`;
}

/**
 * A file's stat stamp: modification time, size and change time together.
 *
 * mtime alone missed a rewrite that put the old modification time back (record 47, A01): `utimes` can
 * restore mtime, but the kernel always moves ctime. A different stamp means "look again", never "the
 * content changed": ctime also moves on chmod, extended-attribute writes and cloud sync.
 */
export function statStamp(stat: { mtimeMs: number; size: number; ctimeMs: number }): string {
  return `${stat.mtimeMs}:${stat.size}:${stat.ctimeMs}`;
}

/** Content identity of a file's text, behind claims like "verified unchanged on disk". */
export function hashFileText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * FileStateCache — tracks every file the model has read (path + mtime + range → content).
 * Serves two purposes:
 *   1. Dedup guard: if the model tries to re-read an unchanged file+range, return cached content
 *      with a stub note so the tool call costs nothing.
 *   2. Post-compact restoration: after ContextManager compaction, re-inject recently-read files
 *      as synthetic [FILE_STILL_UNCHANGED] attachments so the model doesn't need to re-read them.
 */
export class FileStateCache {
  private cache = new Map<string, CacheEntry>();
  private lruOrder: string[] = [];

  /** Get file mtime in ms. Returns null if stat fails. */
  async getMtime(absPath: string): Promise<number | null> {
    try {
      const s = await fs.stat(absPath);
      return s.mtimeMs;
    } catch {
      return null;
    }
  }

  /** The stat fields a cache lookup needs (see statStamp). Returns null if stat fails. */
  async getStat(absPath: string): Promise<{ mtimeMs: number; size: number; ctimeMs: number } | null> {
    try {
      const s = await fs.stat(absPath);
      return { mtimeMs: s.mtimeMs, size: s.size, ctimeMs: s.ctimeMs };
    } catch {
      return null;
    }
  }

  // After DEDUP_WARN_THRESHOLD cache hits for the same unchanged file, return a stub instead of
  // the full content. The model already has it — re-sending it wastes tokens.
  private static readonly DEDUP_WARN_THRESHOLD = 3;

  /**
   * Look up a cached read. Returns content if path+mtime+range all match — and the stat stamp too,
   * when both the entry and the caller have one; null if the file changed or was never cached.
   * After DEDUP_WARN_THRESHOLD identical hits, returns a lightweight stub that tells
   * the model it already has the file — prevents the most common token-wasting pattern.
   */
  get(absPath: string, currentMtime: number, offset?: number, limit?: number, currentStamp?: string): string | null {
    const key = makeKey(absPath, offset, limit);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.mtime !== currentMtime || (entry.stamp && currentStamp && entry.stamp !== currentStamp)) {
      // File changed on disk (or may have: its ctime moved) — evict this entry
      this.cache.delete(key);
      this.lruOrder = this.lruOrder.filter(k => k !== key);
      return null;
    }
    this.touchLru(key);
    entry.hitCount++;
    if (entry.hitCount >= FileStateCache.DEDUP_WARN_THRESHOLD) {
      const lines = entry.content.split('\n').length;
      return `[FileStateCache] ${absPath} (${lines} lines) is unchanged and already in your context from a previous read — do NOT read it again. Use the content you already have, or call FreeContextTool if you need to reclaim the space.`;
    }
    return entry.content;
  }

  /**
   * Store a read result. Always overwrites the previous entry for this key. `version` carries the stat
   * stamp and the whole file's text hash when the caller has them: post-compact restoration can verify
   * only a read that has a hash, or one that was the complete file.
   */
  set(
    absPath: string,
    mtime: number,
    content: string,
    offset?: number,
    limit?: number,
    version: { stamp?: string; fileHash?: string } = {},
  ): void {
    const key = makeKey(absPath, offset, limit);
    this.cache.set(key, {
      content, mtime, stamp: version.stamp, fileHash: version.fileHash,
      cachedAt: Date.now(), evictedByModel: false, hitCount: 0,
    });
    this.touchLru(key);
    this.evictIfNeeded();
  }

  /** Invalidate all cached reads for a path (e.g. after a write/edit). */
  invalidate(absPath: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(absPath + SEP)) {
        this.cache.delete(key);
        this.lruOrder = this.lruOrder.filter(k => k !== key);
      }
    }
  }

  /**
   * Mark a file's cache entries as explicitly released by the model (via FreeContextTool).
   * These entries are kept for dedup but excluded from post-compact restoration.
   */
  markEvicted(absPath: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(absPath + SEP)) {
        const entry = this.cache.get(key);
        if (entry) entry.evictedByModel = true;
      }
    }
  }

  /**
   * Returns the most recently read files (not model-evicted, not stale) for post-compact
   * restoration. Limited to small files to avoid blowing up the restored context.
   *
   * Each row carries the cached mtime, the whole file's hash when known, plus the read's offset/limit
   * so the caller can (a) check the file and refuse to restore stale content after an external edit,
   * and (b) label a partial read honestly instead of presenting it as the complete file.
   */
  getRecentReads(maxAgeMs = 10 * 60 * 1000, maxFileBytes = 50 * 1024): Array<{
    path: string; content: string; mtime: number; fileHash?: string; offset: number; limit: number; complete: boolean;
  }> {
    const now = Date.now();
    const result: Array<{ path: string; content: string; mtime: number; fileHash?: string; offset: number; limit: number; complete: boolean }> = [];
    const seen = new Set<string>();

    for (const key of [...this.lruOrder].reverse()) {
      const entry = this.cache.get(key);
      if (!entry || entry.evictedByModel) continue;
      if (now - entry.cachedAt > maxAgeMs) continue;
      if (entry.content.length > maxFileBytes) continue;

      const [absPath, offsetStr, limitStr] = key.split(SEP);
      if (!seen.has(absPath)) {
        seen.add(absPath);
        const offset = parseInt(offsetStr, 10) || 0;
        const limit = parseInt(limitStr, 10);
        const normalizedLimit = Number.isFinite(limit) ? limit : -1;
        result.push({
          path: absPath, content: entry.content, mtime: entry.mtime, fileHash: entry.fileHash,
          offset, limit: normalizedLimit,
          complete: offset === 0 && normalizedLimit === -1,
        });
      }
      if (result.length >= 5) break;
    }
    return result;
  }

  private touchLru(key: string): void {
    this.lruOrder = this.lruOrder.filter(k => k !== key);
    this.lruOrder.push(key);
  }

  private evictIfNeeded(): void {
    while (this.cache.size > MAX_ENTRIES) {
      const oldest = this.lruOrder.shift();
      if (oldest) this.cache.delete(oldest);
    }
  }
}

export const fileStateCache = new FileStateCache();
