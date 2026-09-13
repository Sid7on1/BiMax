/**
 * The SQLite-backed vector store for the code index — same retrieval science as
 * vector.store.ts (BM25 ∥ dense → reciprocal rank fusion → cross-encoder rerank), a different
 * memory posture.
 *
 * ## Why a second store instead of extending the first
 *
 * The JSON store keeps every document, chunk text, and float vector resident in RAM — correct
 * for a 500-memory note store (~4 MB) and wrong for a code index, where the same design holds
 * ~6 KB of vector per chunk and dies with the laptop somewhere around 10k chunks. This store
 * keeps ONLY a small tag map resident; texts live in FTS5, int8-quantized vectors live in BLOBs,
 * and both stream from disk per query. Resident cost is metadata; corpus size buys disk, not RAM.
 *
 * ## The three RAM decisions
 *
 *   1. **int8 quantization.** A unit vector's ranking survives 8-bit quantization easily
 *      (cosine error ~0.5%, monotone for ranking purposes); 768 dims drop from 6 KB (boxed JS
 *      numbers) to 768 bytes on disk, dequantized into a reused scratch buffer per row.
 *   2. **No ANN.** A streamed scan touches every vector but materializes none of them: ~100 ms
 *      at 100k chunks on an agent tool-call budget (not autocomplete), for ZERO resident index.
 *      HNSW would buy milliseconds and cost 80–800 MB — the exact trade this store exists to
 *      refuse.
 *   3. **Texts only on demand.** Chunk text is fetched for the final top-k (and the rerank
 *      window), never for the scan.
 *
 * Lexical candidates come from FTS5 (bm25() ranking, unicode61 tokenizer) so corpus statistics
 * never live in RAM either. Fusions, the reranker, the lexical-overlap floor and the
 * hybrid/lexical/dense modes behave exactly as in vector.store.ts — the science is imported,
 * only the plumbing is new.
 */

import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { openSqlite, type SqliteDB } from '../core/sqlite';
import { Logger } from '../utils';
import { tokenize } from './bm25';
import { reciprocalRankFusion } from './fusion';
import { type SearchMode, type SearchOptions } from './vector.store';
import type { VectorDocument } from './vector.store';
import type { EmbeddingBackend } from './embeddings';
import type { RemoteReranker } from './rerank';

export interface SqliteStoreOptions {
  storePath?: string;
  maxVectors?: number;
  /** Hard disk ceiling; a sync past it stores nothing new (the index self-limits, never grows). */
  maxIndexBytes?: number;
  /** Dense candidates below this cosine abstain instead of becoming confident-looking noise. */
  minDenseScore?: number;
}

const DEFAULT_MAX_VECTORS = 150_000;
const DEFAULT_MAX_INDEX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MIN_DENSE_SCORE = 0.20;

export class SqliteCodeVectorStore {
  private db: SqliteDB | null = null;
  private readonly storePath: string;
  private readonly maxVectors: number;
  private readonly maxIndexBytes: number;
  private readonly minDenseScore: number;
  /** id → tags: the ONLY resident per-document state (~100 bytes/doc; texts/vectors stay on disk). */
  private tagsById = new Map<string, string[]>();
  private scratch = new Float32Array(0);
  private queryScratch = new Float32Array(0);
  private mode: SearchMode = { lexical: true, dense: false, reranked: false };

  constructor(
    private readonly embeddings: EmbeddingBackend | null,
    private readonly reranker: RemoteReranker | null,
    options: SqliteStoreOptions = {},
  ) {
    this.storePath = options.storePath ?? path.join(stateDir('.breakglass'), 'memory', 'code-index.db');
    this.maxVectors = Math.max(1, options.maxVectors ?? DEFAULT_MAX_VECTORS);
    this.maxIndexBytes = options.maxIndexBytes ?? DEFAULT_MAX_INDEX_BYTES;
    this.minDenseScore = options.minDenseScore ?? DEFAULT_MIN_DENSE_SCORE;
    this.open();
  }

  private open(): void {
    try {
      // SQLite cannot create its parent directory. A first launch must not permanently poison the
      // manifest by opening the store before .breakglass/memory exists.
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      const db = openSqlite(this.storePath);
      if (!db) throw new Error('no SQLite backend on this runtime');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 3000');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(`CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        tags TEXT NOT NULL,
        last_used INTEGER NOT NULL
      )`);
      // The FTS table carries the text itself (id UNINDEXED): one copy on disk, zero in RAM, and
      // deletes stay trivial (no external-content bookkeeping).
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(id UNINDEXED, content)`);
      db.exec(`CREATE TABLE IF NOT EXISTS embs (
        chunk_id TEXT PRIMARY KEY,
        space TEXT NOT NULL,
        scale REAL NOT NULL,
        vec BLOB NOT NULL
      )`);
      this.db = db;
      this.loadTagMap();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.warn(`[SqliteCodeVectorStore] unavailable (${message}); the code index will be empty this session.`);
      this.db = null;
    }
  }

  available(): boolean { return this.db !== null; }

  private loadTagMap(): void {
    this.tagsById.clear();
    if (!this.db) return;
    for (const row of this.db.prepare('SELECT id, tags FROM docs').iterate()) {
      this.tagsById.set(String(row.id), JSON.parse(String(row.tags)));
    }
  }

  lastSearchMode(): SearchMode {
    return this.mode;
  }

  stats() {
    const docs = this.tagsById.size;
    let embedded = 0;
    let indexBytes = 0;
    if (this.db) {
      const space = this.embeddings?.id;
      if (space) {
        embedded = Number(this.db.prepare('SELECT COUNT(*) AS n FROM embs WHERE space = ?').get(space)?.n ?? 0);
      }
      const page = this.db.prepare('PRAGMA page_size').get();
      const count = this.db.prepare('PRAGMA page_count').get();
      indexBytes = Number(page?.page_size ?? 0) * Number(count?.page_count ?? 0);
    }
    return {
      documents: docs,
      chunks: docs,
      embedded,
      pending: docs - embedded,
      maxVectors: this.maxVectors,
      indexBytes,
      denseConfigured: Boolean(this.embeddings),
      minDenseScore: this.minDenseScore,
      lastMode: this.mode,
    };
  }

  /** Resident-metadata bytes — the number the RAM ledger test watches. */
  residentBytes(): number {
    let total = 0;
    for (const [id, tags] of this.tagsById) total += id.length + tags.join('').length + 32;
    return total;
  }

  async storeDocuments(inputs: { id: string; text: string; tags: string[] }[]): Promise<boolean> {
    if (!this.db) return false;
    if (!inputs.length) return true;

    const newDocuments = inputs.reduce((n, input) => n + (this.tagsById.has(input.id) ? 0 : 1), 0);
    if (this.tagsById.size + newDocuments > this.maxVectors) {
      Logger.warn(`[SqliteCodeVectorStore] ${this.maxVectors}-chunk ceiling would be exceeded; storing nothing new.`);
      return false;
    }
    // Refuse before the network call. The estimate is deliberately conservative; a ceiling is a
    // safety boundary, not a storage target to squeeze to the last byte.
    const estimatedBytes = inputs.reduce((n, input) => n + Buffer.byteLength(input.text, 'utf8') + 2048, 0);
    if (this.stats().indexBytes + estimatedBytes > this.maxIndexBytes) {
      Logger.warn(`[SqliteCodeVectorStore] ${Math.round(this.maxIndexBytes / 1e6)} MB disk ceiling would be exceeded; storing nothing new.`);
      return false;
    }

    // Embed OUTSIDE any transaction — network call.
    let vectors: number[][] | null = null;
    if (this.embeddings) {
      vectors = await this.embeddings.embed(inputs.map((i) => i.text), 'passage').catch(() => null);
    }

    const space = this.embeddings?.id;
    this.db.exec('BEGIN');
    try {
      const insDoc = this.db.prepare('INSERT OR REPLACE INTO docs (id, tags, last_used) VALUES (?, ?, ?)');
      const insFts = this.db.prepare('INSERT INTO fts (id, content) VALUES (?, ?)');
      const delFts = this.db.prepare("DELETE FROM fts WHERE id = ?");
      const delEmb = this.db.prepare('DELETE FROM embs WHERE chunk_id = ?');
      const insEmb = this.db.prepare('INSERT OR REPLACE INTO embs (chunk_id, space, scale, vec) VALUES (?, ?, ?, ?)');
      const now = Date.now();
      const committedTags: [string, string[]][] = [];

      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        // Replace semantics: drop the previous fts row (INSERT OR REPLACE on docs keeps the id,
        // but FTS5 has no upsert) and any stale embedding before writing fresh ones.
        delFts.run(input.id);
        if (vectors?.[i]) {
          delEmb.run(input.id);
        }
        insDoc.run(input.id, JSON.stringify(input.tags), now);
        insFts.run(input.id, input.text);
        if (space && vectors?.[i]) {
          const { blob, scale } = quantizeInt8(vectors[i]);
          insEmb.run(input.id, space, scale, blob);
        }
        committedTags.push([input.id, input.tags]);
      }

      this.db.exec('COMMIT');
      for (const [id, tags] of committedTags) this.tagsById.set(id, tags);
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async deleteWhere(predicate: (doc: { id: string; tags: string[] }) => boolean): Promise<number> {
    if (!this.db) return 0;
    const victims: string[] = [];
    for (const [id, tags] of this.tagsById) {
      if (predicate({ id, tags })) victims.push(id);
    }
    if (!victims.length) return 0;
    this.db.exec('BEGIN');
    try {
      const delFts = this.db.prepare('DELETE FROM fts WHERE id = ?');
      const delEmb = this.db.prepare('DELETE FROM embs WHERE chunk_id = ?');
      const delDoc = this.db.prepare('DELETE FROM docs WHERE id = ?');
      for (const id of victims) {
        delFts.run(id);
        delEmb.run(id);
        delDoc.run(id);
      }
      this.db.exec('COMMIT');
      for (const id of victims) this.tagsById.delete(id);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return victims.length;
  }

  /**
   * The full pipeline, parity with VectorStore.semanticSearch: FTS5-bm25 ∥ streamed int8 dense →
   * RRF → optional cross-encoder rerank. FTS membership is the lexical confidence boundary;
   * dense candidates additionally have an explicit cosine abstention floor.
   */
  async semanticSearch(
    query: string,
    limit: number = 3,
    _minScore: number = 0.25,
    options: SearchOptions = {},
  ): Promise<VectorDocument[]> {
    void _minScore; // retained for VectorStore API compatibility; FTS/dense each own confidence.
    if (!this.db || !query.trim()) return [];
    const mode = options.mode ?? 'hybrid';

    const queryVector = this.embeddings && mode !== 'lexical'
      ? (await this.embeddings.embed([query], 'query').catch(() => null))?.[0] ?? null
      : null;

    const tagSet = options.tags?.length ? new Set(options.tags) : null;
    const exclSet = options.excludeTags?.length ? new Set(options.excludeTags) : null;
    const allowed = (id: string): boolean => {
      const tags = this.tagsById.get(id);
      if (!tags) return false;
      if (tagSet && !tags.some((t) => tagSet.has(t))) return false;
      if (exclSet && tags.some((t) => exclSet.has(t))) return false;
      return true;
    };

    const depth = Math.max(limit * 8, 64);

    // Lexical half: FTS5 bm25. Tokens are quoted so punctuation in a chunk id can never become
    // FTS query syntax; OR keeps every term a candidate and bm25() does the ranking.
    let lexicalIds: string[] = [];
    if (mode !== 'dense') {
      const terms = tokenize(query).map((t) => `"${t.replace(/"/g, '')}"`).slice(0, 24);
      if (terms.length) {
        try {
          const rows = this.db.prepare(
            'SELECT id FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ?',
          ).all(terms.join(' OR '), depth * 2);
          lexicalIds = rows.map((row) => String(row.id)).filter(allowed).slice(0, depth);
        } catch { /* malformed match — lexical half simply abstains */ }
      }
    }

    // Dense half: streamed scan, nothing materialized. int8 rows dequantize into a reused
    // scratch buffer; scores collect as (id, score) pairs and sort once at the end.
    let denseIds: string[] = [];
    if (queryVector) {
      const space = this.embeddings!.id;
      if (this.queryScratch.length !== queryVector.length) {
        this.queryScratch = new Float32Array(queryVector);
      } else {
        this.queryScratch.set(queryVector);
      }
      const scored: { id: string; score: number }[] = [];
      const stmt = this.db.prepare('SELECT chunk_id, scale, vec FROM embs WHERE space = ?');
      for (const row of stmt.iterate(space)) {
        const id = String(row.chunk_id);
        if (!allowed(id)) continue;
        const blob: Uint8Array = row.vec;
        if (this.scratch.length !== blob.length) this.scratch = new Float32Array(blob.length);
        const scale = Number(row.scale);
        let dot = 0;
        for (let i = 0; i < this.queryScratch.length && i < this.scratch.length; i++) {
          // Encode is q = v/scale + 127 (0..254); decode is exactly its inverse. Getting this
          // wrong by even a constant per-dim offset silently reranks everything — the failure is
          // confident garbage, not an error.
          dot += this.queryScratch[i] * ((blob[i] - 127) * scale);
        }
        scored.push({ id, score: dot });
      }
      scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      // Absolute abstention rejects unrelated spaces; the relative window prevents a long tail of
      // weak-but-positive vectors from receiving the same RRF vote as the query's true neighbours.
      const denseFloor = Math.max(this.minDenseScore, (scored[0]?.score ?? 0) - 0.05);
      denseIds = scored.filter((s) => s.score >= denseFloor).slice(0, depth).map((s) => s.id);
    }

    // Source search gives exact lexical evidence a modest prior. Dense still owns tokenless queries
    // (where the lexical list is empty) and promotes agreement, but cannot swamp known identifiers.
    const fused = reciprocalRankFusion({ lexical: { ids: lexicalIds, weight: 1.5 }, dense: { ids: denseIds } });

    // Rerank window: candidates' texts fetched from FTS only now, only for the window.
    let ordered = fused;
    let reranked = false;
    if (this.reranker && ordered.length > 1) {
      const window = ordered.slice(0, 24);
      const texts = this.textsFor(window.map((w) => w.id));
      const present = window.filter((w) => texts.has(w.id));
      if (present.length > 1) {
        const scores = await this.reranker
          .rerank(query, present.map((w) => ({ id: w.id, text: texts.get(w.id)! })))
          .catch(() => null);
        if (scores?.length) {
          const guarded = reciprocalRankFusion({
            retrieval: { ids: ordered.map((candidate) => candidate.id), weight: 1.25 },
            rerank: { ids: scores.map((score) => score.id) },
          });
          const rank = new Map(guarded.map((hit, i) => [hit.id, i]));
          ordered = [...ordered].sort(
            (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
          );
          reranked = true;
        }
      }
    }

    this.mode = { lexical: lexicalIds.length > 0 || !queryVector, dense: denseIds.length > 0, reranked };

    // Collapse to documents. An FTS5 result already proves lexical membership; a token divided by
    // a long source chunk is not a useful confidence score and used to erase exact identifiers.
    const seen = new Set<string>();
    const resultIds: string[] = [];
    for (const candidate of ordered) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      resultIds.push(candidate.id);
      if (resultIds.length >= limit) break;
    }
    const texts = this.textsFor(resultIds);
    const finalIds = resultIds;

    if (finalIds.length) {
      const now = Date.now();
      const upd = this.db.prepare('UPDATE docs SET last_used = ? WHERE id = ?');
      for (const id of finalIds) upd.run(now, id);
    }

    return finalIds.map((id) => ({
      id,
      metadata: { tags: this.tagsById.get(id) ?? [], content: texts.get(id) ?? '' },
      lastUsedAt: Date.now(),
    }));
  }

  /** Re-embed chunks stored without vectors (keyless first sync) — bounded batches, SQL updates. */
  async backfillPending(batch: number = 64): Promise<{ embedded: number; pending: number }> {
    if (!this.db || !this.embeddings) return { embedded: 0, pending: 0 };
    const space = this.embeddings.id;
    const rows: { id: string; text: string }[] = [];
    const stmt = this.db.prepare(
      `SELECT f.id AS id, f.content AS text FROM fts f
       LEFT JOIN embs e ON e.chunk_id = f.id AND e.space = ?
       WHERE e.chunk_id IS NULL LIMIT ?`,
    );
    for (const row of stmt.iterate(space, batch)) rows.push({ id: String(row.id), text: String(row.text) });
    if (!rows.length) return { embedded: 0, pending: 0 };

    const vectors = await this.embeddings.embed(rows.map((r) => r.text), 'passage').catch(() => null);
    if (!vectors) return { embedded: 0, pending: rows.length };

    const ins = this.db.prepare('INSERT OR REPLACE INTO embs (chunk_id, space, scale, vec) VALUES (?, ?, ?, ?)');
    let embedded = 0;
    this.db.exec('BEGIN');
    try {
      rows.forEach((row, i) => {
        if (!vectors[i]) return;
        const { blob, scale } = quantizeInt8(vectors[i]);
        ins.run(row.id, space, scale, blob);
        embedded++;
      });
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    const pending = Number(
      this.db.prepare(
        'SELECT COUNT(*) AS n FROM fts f WHERE NOT EXISTS (SELECT 1 FROM embs e WHERE e.chunk_id = f.id AND e.space = ?)',
      ).get(space)?.n ?? 0,
    );
    return { embedded, pending };
  }

  private textsFor(ids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (!this.db || !ids.length) return out;
    const stmt = this.db.prepare('SELECT id, content FROM fts WHERE id = ?');
    for (const id of ids) {
      const row = stmt.get(id);
      if (row) out.set(String(row.id), String(row.content));
    }
    return out;
  }
}

/** int8 quantization: one scale per vector; dequant is (q / 127) * scale. */
function quantizeInt8(vector: number[]): { blob: Uint8Array; scale: number } {
  let maxAbs = 0;
  for (const v of vector) maxAbs = Math.max(maxAbs, Math.abs(v));
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const blob = new Uint8Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    blob[i] = Math.max(0, Math.min(255, Math.round((vector[i] / scale + 127))));
  }
  return { blob, scale };
}
