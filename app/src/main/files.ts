import { watch, FSWatcher } from 'node:fs';
import path from 'node:path';
import { ProjectFiles, withProjectFiles } from './project.files';

/**
 * Electron-native file tree for the Files panel: lazy per-directory listing, capped read-only
 * file reads, and one recursive watcher per project that fans change events to the renderer
 * (debounced — a `git checkout` touches hundreds of files at once).
 */

const IGNORE = new Set(['node_modules', '.git', '.DS_Store']);

export interface FileEntry {
  name: string;
  dir: boolean;
}

/** Live IPC passes a pinned project descriptor; string callers receive a scoped temporary one. */
export async function listDir(root: string | ProjectFiles, rel: unknown): Promise<FileEntry[]> {
  return withProjectFiles(root, files => files.listDir(rel));
}
export async function readFilePreview(root: string | ProjectFiles, rel: unknown): Promise<{ content: string; truncated: boolean; size: number; binary: boolean }> {
  return withProjectFiles(root, files => files.readFilePreview(rel));
}
export async function writeFileContent(root: string | ProjectFiles, rel: unknown, content: string): Promise<void> {
  return withProjectFiles(root, files => files.writeFileContent(rel, content));
}

/** One session-meta record from the engine's .breakglass/sessions/sessions-meta.jsonl. */
export interface SessionMetaRecord {
  id: string;
  title: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  messageCount: number;
  tokenEstimate: number;
}

/**
 * Read bounded recent session metadata through the selected project's file authority.
 * The last 512 KiB is retained; an incomplete first JSONL record is skipped. This is
 * recent-history metadata, not an unbounded all-time statistics source.
 */
export async function readSessionMeta(root: string | ProjectFiles): Promise<SessionMetaRecord[]> {
  try {
    const { content: raw } = await withProjectFiles(root, files => files.readFilePreview('.breakglass/sessions/sessions-meta.jsonl', true));
    const out: SessionMetaRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        out.push({
          id: String(m.id ?? ''),
          title: String(m.title ?? ''),
          cwd: String(m.cwd ?? ''),
          startedAt: String(m.startedAt ?? ''),
          endedAt: m.endedAt ? String(m.endedAt) : undefined,
          messageCount: Number(m.messageCount ?? 0),
          tokenEstimate: Number(m.tokenEstimate ?? 0),
        });
      } catch { /* skip malformed line */ }
    }
    return out.reverse(); // newest first
  } catch {
    return [];
  }
}

/**
 * A closed project watcher must be silent. `FSWatcher.close()` alone is not: it stops future events
 * but cannot cancel the 400 ms debounce timer already scheduled, and it cannot un-queue a callback
 * the event loop has already dispatched. Either one fires after a project switch and wakes the NEW
 * project's refresh with the OLD project's change — which is exactly the staleness the renderer's
 * generation fence then has to clean up. Close it properly here instead.
 */
export interface ProjectWatch {
  close(): void;
  /** True once `close()` has run. */
  readonly closed: boolean;
  /**
   * True while a debounced change is still pending. Exposed because "the callback stays quiet" and
   * "the timer is actually cancelled" are different guarantees: silencing the callback alone leaves
   * a timer holding the event loop open for its full window after the project is gone.
   */
  readonly pendingChange: boolean;
}

export function watchProject(root: string, onChange: () => void): ProjectWatch | null {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (closed) return; // already dispatched when close() ran
      const name = String(filename ?? '');
      if (name.split(path.sep).some((seg) => IGNORE.has(seg))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; if (!closed) onChange(); }, 400);
    });
    watcher.on('error', () => { /* project deleted mid-session — polling still covers git */ });
  } catch {
    return null; // recursive watch unavailable — renderer's poll interval still refreshes
  }
  return {
    get closed() { return closed; },
    get pendingChange() { return timer !== null; },
    close() {
      if (closed) return;
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { watcher.close(); } catch { /* already gone */ }
    },
  };
}

/**
 * Project-wide filename search for the Files filter.
 *
 * A filter that only matched the folders the user had already expanded would be a worse tool than
 * no filter: it answers "no results" for a file that plainly exists, which teaches the user not to
 * trust it. So the walk is real — but bounded three ways, because this runs on every keystroke:
 * a node budget, a depth cap, and the same IGNORE set the tree uses. Hitting the budget is
 * reported (`truncated`) rather than silently returning a short list.
 */
export interface FileSearchHit {
  /** Project-relative path. */
  rel: string;
  name: string;
  dir: boolean;
}

export interface FileSearchResult {
  hits: FileSearchHit[];
  truncated: boolean;
}

export async function searchFiles(
  root: string | ProjectFiles,
  query: unknown,
  limit = 200,
): Promise<FileSearchResult> {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return { hits: [], truncated: false };
  // Guard the walk itself, not just the result: a deep tree costs the same to walk whether or not
  // anything matches.
  const NODE_BUDGET = 20_000;
  const MAX_DEPTH = 12;
  const deadline = Date.now() + 5000;

  const hits: FileSearchHit[] = [];
  let visited = 0;
  let truncated = false;

  const walk = async (rel: string, depth: number): Promise<void> => {
    if (Date.now() > deadline) { truncated = true; return; }
    if (truncated || depth > MAX_DEPTH || hits.length >= limit) return;
    let entries: FileEntry[];
    try {
      entries = await listDir(root, rel);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      if (++visited > NODE_BUDGET) { truncated = true; return; }
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.toLowerCase().includes(needle)) {
        hits.push({ rel: childRel, name: entry.name, dir: entry.dir });
        if (hits.length >= limit) { truncated = true; return; }
      }
      if (entry.dir) await walk(childRel, depth + 1);
      if (truncated) return;
    }
  };

  // One descriptor for the entire search, so every directory shares the same project authority.
  await withProjectFiles(root, async files => { root = files; await walk('', 0); }).catch(() => {});
  // Files before directories, then shortest path first: a filter is usually looking for a file,
  // and a shallower match is more often the one meant.
  hits.sort((a, b) =>
    Number(a.dir) - Number(b.dir)
    || a.rel.split('/').length - b.rel.split('/').length
    || a.rel.localeCompare(b.rel));
  return { hits, truncated };
}
