/**
 * The semantic code index — retrieval over the repository's own source.
 *
 * ## Why this exists when grep and the code graph already do
 *
 * Grep (and GrepTool) is exact-token retrieval: it finds "RRF_K" and it will never find "where
 * ranks from two retrievers are combined" unless the comment happens to contain those words. The
 * code graph answers structural questions (callers, dependencies) but not meaning questions. The
 * one query class nothing in the engine could answer was "where is this *behaviour* implemented,
 * phrased the way a person would phrase it" — which is also the query class a user actually types
 * when they don't already know the codebase.
 *
 * This is the same four-stage pipeline the memory store runs (chunk → BM25 ∥ dense → RRF →
 * rerank), pointed at code instead of notes. Two things are different, and both are load-bearing:
 *
 *   1. **Chunks are symbol-shaped with contextual headers.** Each chunk is a window of source
 *      lines that begins at a declaration boundary where possible, and every chunk's text is
 *      prefixed with `path :: kind name (lines)`. The header rides into BOTH retrievers: BM25
 *      indexes the path and symbol tokens (contextual BM25), and the embedding averages them in
 *      (contextual embeddings) — a bare function body embeds as slightly-about everything it
 *      touches and strongly about nothing, which is the exact failure mode the memory pipeline's
 *      chunker exists to prevent, restated for code.
 *   2. **Sync is incremental and bounded.** A manifest of mtime+size per file decides what
 *      re-indexes; each sync processes a bounded batch so a first run over a large repo trickles
 *      in over several turns instead of blocking boot behind hundreds of embedding calls. With no
 *      API key the chunks still index — BM25 over path+symbol+body — and gain vectors the moment
 *      a key exists (backfill), the same honest degradation as memory.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { VectorDocument } from './vector.store';
import { SqliteCodeVectorStore } from './sqlite.code.store';
import type { EmbeddingBackend } from './embeddings';
import type { RemoteReranker } from './rerank';
import { Logger } from '../utils';

/** Directories never worth indexing. Matched by basename anywhere in the tree. */
const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', '.breakglass', 'node_modules', 'dist', 'build', 'coverage',
  '.cache', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'out',
]);

/**
 * How long one indexing slice may hold the event loop before yielding.
 *
 * Not a throughput tuning knob — a liveness floor. The engine's protocol heartbeat is a 3s timer,
 * and the desktop supervisor kills an engine that goes 20s without one. 250ms leaves that beat an
 * order of magnitude of headroom, so a slice cannot swallow one even when the next file costs far
 * more than the average. The check runs after each file, so the true worst case is this budget
 * plus one file.
 */
const SLICE_BUDGET_MS = 250;

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt',
]);

/** Above this a "source" file is generated/minified output; indexing it is noise. */
const MAX_FILE_BYTES = 200_000;
const CHUNK_LINES = 80;
const CHUNK_OVERLAP_LINES = 10;

export interface CodeIndexOptions {
  root?: string;
  /** SQLite index file. One path below the memory dir keeps everything in .breakglass together. */
  storePath?: string;
  maxVectors?: number;
  /** Hard disk ceiling for the index (default 512 MB); past it, syncs store nothing new. */
  maxIndexBytes?: number;
  /** Cosine floor for dense-only candidates; below it the semantic stage abstains. */
  minDenseScore?: number;
  /** A/B switch for the contextual-header technique; the benchmark measures both positions. */
  contextualHeaders?: boolean;
  /** Optional graph expansion attached to the top hits (see HitExpander). */
  expandHit?: HitExpander;
  /** Evaluation/test seam for excluding fixture definitions from the indexed corpus. */
  excludePath?: (relativePath: string) => boolean;
  /** Override {@link SLICE_BUDGET_MS}. 0 commits and yields after every file. */
  sliceBudgetMs?: number;
}

export interface CodeHit {
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
  text: string;
  /**
   * Graph-adjacent symbols (callers/callees in other files), attached by the optional expander.
   * This is the fusion step no rival welds: the vector index finds WHERE by meaning, the code
   * graph answers WHO CARES by structure — retrieval returns both in one result.
   */
  related?: string[];
}

/**
 * Expands a retrieved hit with structural neighbours. Injected by the container (which owns the
 * graph store); injected rather than imported so the index stays graph-optional and testable.
 */
export type HitExpander = (hit: CodeHit) => Promise<string[]>;

interface Manifest {
  [relPath: string]: { m: number; s: number };
}

/**
 * Declaration-boundary detection without a grammar. Tree-sitter grammars are per-language
 * dependencies this engine does not carry for its own languages; a conservative regex over the
 * few declaration shapes that matter for chunk *boundaries* is enough — mis-detection costs a
 * slightly ragged chunk edge, never a wrong index entry, because the id is line-based.
 */
const DECLARATION = /^\s{0,2}(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:(?:function\s*\*?\s*([A-Za-z_$][\w$]*))|(?:class\s+([A-Za-z_$][\w$]*))|(?:interface\s+([A-Za-z_$][\w$]*))|(?:type\s+([A-Za-z_$][\w$]*)\s*=)|(?:enum\s+([A-Za-z_$][\w$]*))|(?:const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))|(?:(?:async\s+)?def\s+([A-Za-z_][\w]*))|(?:struct\s+([A-Za-z_][\w]*))|(?:fn\s+([A-Za-z_][\w]*))|(?:func\s+([A-Za-z_][\w]*)))/;

function declarationName(line: string): string | null {
  const m = DECLARATION.exec(line);
  if (!m) return null;
  for (const g of m.slice(1)) if (g) return g;
  return null;
}

export class CodeIndex {
  private readonly root: string;
  private readonly store: SqliteCodeVectorStore;
  private readonly contextualHeaders: boolean;
  private readonly expandHit?: HitExpander;
  private readonly excludePath?: (relativePath: string) => boolean;
  private readonly sliceBudgetMs: number;
  private readonly manifestPath: string;
  private manifest: Manifest | null = null;
  private syncing = false;

  constructor(embeddings: EmbeddingBackend | null, reranker: RemoteReranker | null = null, options: CodeIndexOptions = {}) {
    this.root = path.resolve(options.root ?? process.cwd());
    this.contextualHeaders = options.contextualHeaders ?? true;
    this.expandHit = options.expandHit;
    this.excludePath = options.excludePath;
    this.sliceBudgetMs = Math.max(0, options.sliceBudgetMs ?? SLICE_BUDGET_MS);
    const storePath = options.storePath ?? path.join(this.root, '.breakglass/memory/code-index.db');
    // Per-STORE manifest: deriving it from the directory would make two indexes over the same
    // root (a benchmark's lexical/hybrid pair, or a future second space) share one manifest and
    // silently skip each other's files.
    this.manifestPath = `${storePath}.manifest.json`;
    // SQLite-backed: texts in FTS5, int8 vectors in BLOBs, ~100 resident bytes per document.
    // The JSON VectorStore keeps every text and float vector in RAM — right for 500 memories,
    // wrong for a codebase (see sqlite.code.store.ts for the full ledger).
    this.store = new SqliteCodeVectorStore(embeddings, reranker, {
      storePath,
      maxVectors: options.maxVectors ?? 150_000,
      maxIndexBytes: options.maxIndexBytes,
      minDenseScore: options.minDenseScore,
    });
  }

  stats() {
    return this.store.stats();
  }

  /**
   * Bring the index up to date, bounded. Returns { indexed, pending } so a caller can report
   * progress; run repeatedly (boot, or /retrieval-style commands) to drain a large backlog.
   */
  async sync(budgetFiles: number = 200): Promise<{ indexed: number; removed: number; pending: number }> {
    if (this.syncing) return { indexed: 0, removed: 0, pending: 0 }; // one flight at a time
    this.syncing = true;
    try {
      await this.loadManifest();
      const files = await this.walkSources();
      let removed = 0;

      // Deleted/renamed files first: their chunks are pure noise in every future search.
      const known = new Set(files.map((f) => f.rel));
      for (const rel of Object.keys(this.manifest!)) {
        if (!known.has(rel)) {
          await this.store.deleteWhere((d) => d.tags.includes(fileTag(rel)));
          delete this.manifest![rel];
          removed += 1;
        }
      }

      const changed = files.filter((f) => {
        const prev = this.manifest![f.rel];
        return !prev || prev.m !== f.mtimeMs || prev.s !== f.size;
      });
      const batch = changed.slice(0, Math.max(0, budgetFiles));
      let indexed = 0;

      if (batch.length) {
        // Bounded is not the same as non-blocking. `await fs.readFile` yields; chunking and the
        // FTS commit that follow it are synchronous CPU, so one pass over the whole budget held
        // the event loop for ~15s on a 200-file batch (measured 2026-09-04: ~76ms/file). That
        // stops every timer in the process, and the protocol heartbeat is a timer — 20s of
        // silence is exactly what the desktop supervisor kills an engine for. The batch is still
        // bounded by `budgetFiles`; it is now also SLICED, so the loop comes up for air on a
        // wall-clock budget rather than a fixed file count, because per-file cost varies by an
        // order of magnitude with file size and disk state.
        const rescanned = new Set<string>();
        const currentIds = new Set<string>();
        const nextManifest: Manifest = {};
        let sliceFiles: { rel: string; m: number; s: number }[] = [];
        let sliceTags = new Set<string>();
        let sliceDocs: { id: string; text: string; tags: string[] }[] = [];
        let sliceStart = Date.now();

        // Commit one slice, then hand the loop back so pending timers (the heartbeat) can run.
        // A slice that fails to store contributes nothing — not its manifest entries and not its
        // file tags, so the stale-row sweep below can never delete rows for a file whose
        // replacement never committed. That is the same all-or-nothing rule the single-batch
        // version had, applied per slice.
        const flushSlice = async (): Promise<void> => {
          if (sliceFiles.length) {
            if (await this.store.storeDocuments(sliceDocs)) {
              for (const d of sliceDocs) currentIds.add(d.id);
              for (const t of sliceTags) rescanned.add(t);
              for (const f of sliceFiles) nextManifest[f.rel] = { m: f.m, s: f.s };
            }
          }
          sliceFiles = [];
          sliceTags = new Set();
          sliceDocs = [];
          await new Promise<void>((resolve) => setImmediate(resolve));
          sliceStart = Date.now();
        };

        for (const file of batch) {
          try {
            const source = await fs.readFile(file.abs, 'utf-8');
            sliceTags.add(fileTag(file.rel));
            for (const chunk of chunkSource(file.rel, source, this.contextualHeaders)) {
              sliceDocs.push({
                id: chunk.id,
                text: chunk.text,
                tags: ['code', fileTag(file.rel), `sym:${chunk.symbol}`, `lines:${chunk.startLine}-${chunk.endLine}`],
              });
            }
            sliceFiles.push({ rel: file.rel, m: file.mtimeMs, s: file.size });
          } catch {
            // Unreadable mid-sync (deleted, permissions): skip; next sync reconsiders it.
          }
          if (Date.now() - sliceStart >= this.sliceBudgetMs) await flushSlice();
        }
        await flushSlice();

        if (Object.keys(nextManifest).length) {
          // Only after the new rows commit, remove stale line windows from older file versions.
          // A disabled/full store therefore retains its last good index and leaves files pending.
          await this.store.deleteWhere((d) => (
            d.tags.includes('code') && d.tags.some((t) => rescanned.has(t)) && !currentIds.has(d.id)
          ));
          Object.assign(this.manifest!, nextManifest);
          indexed = Object.keys(nextManifest).length;
          await this.saveManifest();
        }
      } else if (removed > 0) {
        await this.saveManifest();
      }
      // Chunks stored keyless gain vectors incrementally: one bounded batch per sync, so a
      // large backlog drains across syncs instead of one giant embedding run.
      if (this.store.stats().pending > 0) {
        await this.store.backfillPending(64).catch(() => undefined);
      }

      const pending = changed.length - indexed;
      if (indexed || removed || pending) {
        Logger.info(`[CodeIndex] ${indexed} file(s) indexed, ${removed} removed, ${pending} pending.`);
      }
      return { indexed, removed, pending };
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Semantic search over the codebase. `pathPrefix` scopes to a subtree (e.g. `src/memory`)
   * by over-retrieving then filtering — tag equality cannot express prefixes.
   */
  async search(
    query: string,
    limit = 5,
    pathPrefix?: string,
    mode: 'hybrid' | 'lexical' | 'dense' = 'hybrid',
  ): Promise<CodeHit[]> {
    const overfetch = pathPrefix ? limit * 4 : limit;
    const docs = await this.store.semanticSearch(query, overfetch, 0.05, { tags: ['code'], mode });
    const hits: CodeHit[] = [];
    for (const doc of docs) {
      const hit = docToHit(doc);
      if (!hit) continue;
      if (pathPrefix && !hit.path.startsWith(pathPrefix.replace(/^\/+|\/+$/g, ''))) continue;
      hits.push(hit);
      if (hits.length >= limit) break;
    }
    // Structural expansion rides on the TOP hits only: it is context the model will act on, and
    // graph walks are not free. Failure is silent by the same rule as everything here — the
    // vector hit stands on its own.
    if (this.expandHit) {
      await Promise.all(hits.slice(0, 2).map(async (hit) => {
        hit.related = await this.expandHit!(hit).catch(() => [] as string[]);
      }));
    }
    return hits;
  }

  private async loadManifest(): Promise<void> {
    if (this.manifest) return;
    try {
      this.manifest = JSON.parse(await fs.readFile(this.manifestPath, 'utf-8')) as Manifest;
    } catch {
      this.manifest = {};
    }
  }

  private async saveManifest(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.manifestPath), { recursive: true });
      await fs.writeFile(this.manifestPath, JSON.stringify(this.manifest), 'utf-8');
    } catch {
      // Manifest loss costs a re-index, never correctness.
    }
  }

  private async walkSources(): Promise<{ abs: string; rel: string; mtimeMs: number; size: number }[]> {
    const out: { abs: string; rel: string; mtimeMs: number; size: number }[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) await walk(abs);
        } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
          try {
            const stat = await fs.stat(abs);
            if (stat.size > MAX_FILE_BYTES) continue;
            const rel = path.relative(this.root, abs).replace(/\\/g, '/');
            if (this.excludePath?.(rel)) continue;
            out.push({ abs, rel, mtimeMs: stat.mtimeMs, size: stat.size });
          } catch { /* raced away */ }
        }
      }
    };
    await walk(this.root);
    return out;
  }
}

function fileTag(rel: string): string {
  return `file:${rel}`;
}

/**
 * The process-wide code index, set by the container (which owns the embedding credentials) so
 * commands like /retrieval can report on and drain it without reaching into the container.
 * Null until the container builds it, or entirely when BIMAX_CODE_INDEX=0.
 */
let activeCodeIndex: CodeIndex | null = null;

export function setActiveCodeIndex(index: CodeIndex | null): void {
  activeCodeIndex = index;
}

export function getActiveCodeIndex(): CodeIndex | null {
  return activeCodeIndex;
}

/** Split a source file into line-window chunks that begin at declaration boundaries. */
export function chunkSource(
  rel: string,
  source: string,
  contextualHeaders = true,
): { id: string; text: string; startLine: number; endLine: number; symbol: string }[] {
  const lines = source.split('\n');
  if (!lines.length) return [];
  const chunks: { id: string; text: string; startLine: number; endLine: number; symbol: string }[] = [];

  let start = 0;
  let symbol = path.basename(rel);
  while (start < lines.length) {
    let end = Math.min(start + CHUNK_LINES, lines.length);
    // Prefer to end just before the NEXT declaration (if one lands inside the window) so chunks
    // align with how code is read: one declaration, not one and a third.
    for (let i = start + CHUNK_OVERLAP_LINES; i < end; i++) {
      if (declarationName(lines[i]) !== null) {
        end = i;
        break;
      }
    }
    const body = lines.slice(start, end);
    // The chunk's symbol: the declaration it starts at, else the first declaration inside it,
    // else whatever enclosing declaration was in effect — a bare import block should not stamp
    // the whole file with the basename when the interesting symbol is three lines down.
    const inner = body.map((l) => declarationName(l)).find((n) => n !== null) ?? null;
    const nextSymbol = declarationName(body[0] ?? '') ?? inner ?? symbol;
    symbol = nextSymbol;
    const header = contextualHeaders ? `${rel} :: ${symbol} (lines ${start + 1}-${end})\n` : '';
    chunks.push({
      id: `code:${rel}:L${start + 1}`,
      text: header + body.join('\n'),
      startLine: start + 1,
      endLine: end,
      symbol,
    });
    if (end >= lines.length) break;
    start = Math.max(end - CHUNK_OVERLAP_LINES, start + 1);
  }
  return chunks;
}

function docToHit(doc: VectorDocument): CodeHit | null {
  const m = /^code:(.+):L(\d+)$/.exec(doc.id);
  if (!m) return null;
  const tags = doc.metadata?.tags ?? [];
  const symbol = tags.find((t) => t.startsWith('sym:'))?.slice(4) ?? path.basename(m[1]);
  const lines = tags.find((t) => t.startsWith('lines:'))?.slice(6)?.split('-');
  return {
    path: m[1],
    startLine: Number(m[2]),
    endLine: lines ? Number(lines[1]) : Number(m[2]),
    symbol,
    text: doc.metadata?.content ?? '',
  };
}
