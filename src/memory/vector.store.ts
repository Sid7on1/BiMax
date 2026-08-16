import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../utils';
import { Mutex } from 'async-mutex';
import { Bm25Index, tokenize } from './bm25';
import { reciprocalRankFusion } from './fusion';
import { chunkDocument } from './chunking';
import { dot, type EmbeddingBackend } from './embeddings';
import type { RemoteReranker } from './rerank';

/**
 * File-backed memory with a four-stage retrieval pipeline.
 *
 *   chunk → { BM25 ∥ dense } → reciprocal rank fusion → cross-encoder rerank
 *
 * Each stage exists because the one before it has a specific ceiling:
 *
 *   - **Chunking** because an embedding is an average: a long note embeds as slightly-about each of
 *     the eight things it covers and strongly about none, so the information is present and the
 *     representation buries it.
 *   - **Two retrievers** because they fail in opposite directions. BM25 owns exact tokens — error
 *     codes, identifiers, branch names — which are precisely where a model that never saw them is
 *     worst. Dense owns paraphrase, which is precisely where a lexical matcher scores zero.
 *   - **Rank fusion** rather than score addition, because BM25 is unbounded and corpus-dependent
 *     while cosine is bounded: adding them lets one drown the other with no error and no way to see
 *     it from the output.
 *   - **Reranking** because both retrievers score a document without ever seeing it beside the
 *     query. That is what makes them fast enough to run over everything, and it is their ceiling.
 *     Fusion is good at putting the right document *somewhere* in the top twenty and mediocre at
 *     putting it in the top three — and the top three is all that fits in a prompt.
 *
 * ## Every stage degrades separately, and says so
 *
 * Embeddings and reranking each need a network and a key. When either is unavailable it returns
 * null and the pipeline runs without that stage — never with a fabricated substitute. A reranker
 * that silently returned its input unchanged, or an embedder that returned hashed pseudo-vectors,
 * would be indistinguishable from one that worked. `lastSearchMode()` reports which stages actually
 * ran, so a caller can admit to degraded results instead of quietly serving them.
 */
export interface StoredChunk {
  id: string;
  text: string;
  /** Unit-length dense vector, absent until embedded. */
  embedding?: number[];
  /** The vector space `embedding` belongs to. A mismatch invalidates it rather than comparing. */
  space?: string;
}

export interface VectorDocument {
  id: string;
  metadata: {
    tags: string[];
    content: string;
  };
  /** Retrieval operates on these; the document is what gets returned. */
  chunks?: StoredChunk[];
  /**
   * When this document was last *retrieved*, not when it was written.
   *
   * Eviction reads this. FIFO — the previous policy — discards the oldest record regardless of how
   * often it has proved useful, which on a memory store means the hard-won fact learned in week one
   * is the first thing thrown away. Least-recently-retrieved keeps what the system actually uses.
   */
  lastUsedAt?: number;
}

/** Which stages ran. Reported rather than inferred — a degraded pipeline looks identical. */
export interface SearchMode {
  lexical: boolean;
  dense: boolean;
  reranked: boolean;
}

/** Kept exported: callers outside this module score ad-hoc text against a query with it. */
export function lexicalRelevance(query: string, text: string): number {
  const q = new Set(tokenize(query));
  const d = tokenize(text);
  if (!q.size || !d.length) return 0;
  let hits = 0;
  for (const term of d) if (q.has(term)) hits++;
  return hits / d.length;
}

export class VectorStore {
  private store: VectorDocument[] = [];
  private readonly STORE_PATH = path.join(process.cwd(), '.breakglass/memory', 'vectors.json');
  private rwMutex = new Mutex();
  private readonly MAX_VECTORS = 500;

  private readonly embeddings: EmbeddingBackend | null;
  private readonly reranker: RemoteReranker | null;
  /** Indexed over CHUNKS, not documents — the unit retrieval scores. */
  private index = new Bm25Index();
  private indexDirty = true;
  private chunkOwner = new Map<string, VectorDocument>();
  private mode: SearchMode = { lexical: true, dense: false, reranked: false };

  constructor(embeddings: EmbeddingBackend | null = null, reranker: RemoteReranker | null = null) {
    this.embeddings = embeddings;
    this.reranker = reranker;
    this.loadStore().catch(() => {});
  }

  lastSearchMode(): SearchMode {
    return this.mode;
  }

  private async loadStore(alreadyLocked: boolean = false) {
    const load = async () => {
      try {
        const data = await fs.readFile(this.STORE_PATH, 'utf-8');
        const parsed = JSON.parse(data);
        this.store = Array.isArray(parsed) ? parsed : [];
        for (const doc of this.store) {
          // Records written before chunking existed have no `chunks`. Derive them on load rather
          // than migrating the file: a read-time upgrade cannot corrupt anything, and the next
          // write persists the result anyway.
          if (!doc.chunks?.length) {
            doc.chunks = chunkDocument(doc.id, doc.metadata?.content || '').map((c) => ({ id: c.id, text: c.text }));
          }
          if (this.embeddings) {
            for (const chunk of doc.chunks) {
              if (chunk.space && chunk.space !== this.embeddings.id) {
                delete chunk.embedding;
                delete chunk.space;
              }
            }
          }
        }
        this.indexDirty = true;
        Logger.info(`[VectorStore] Loaded ${this.store.length} memories from disk.`);
      } catch {
        // Missing file is fine
      }
    };

    if (alreadyLocked) await load();
    else await this.rwMutex.runExclusive(load);
  }

  private async saveStore() {
    try {
      await fs.mkdir(path.dirname(this.STORE_PATH), { recursive: true });
      await fs.writeFile(this.STORE_PATH, JSON.stringify(this.store, null, 2), 'utf-8');
    } catch {
      Logger.error(`[VectorStore] Failed to write memories to disk.`);
    }
  }

  private rebuildIndex(): void {
    if (!this.indexDirty) return;
    const documents: { id: string; text: string }[] = [];
    this.chunkOwner = new Map();
    for (const doc of this.store) {
      for (const chunk of doc.chunks ?? []) {
        documents.push({ id: chunk.id, text: chunk.text });
        this.chunkOwner.set(chunk.id, doc);
      }
    }
    this.index.build(documents);
    this.indexDirty = false;
  }

  async storeDocument(id: string, text: string, tags: string[]): Promise<void> {
    const chunks: StoredChunk[] = chunkDocument(id, text).map((c) => ({ id: c.id, text: c.text }));

    // Embed OUTSIDE the mutex: this is a network call, and holding the store lock across it would
    // serialize every concurrent memory operation behind an HTTP request.
    let vectors: number[][] | null = null;
    if (this.embeddings && chunks.length) {
      vectors = await this.embeddings.embed(chunks.map((c) => c.text), 'passage').catch(() => null);
    }
    if (vectors) {
      chunks.forEach((chunk, i) => {
        if (!vectors![i]) return;
        chunk.embedding = vectors![i];
        chunk.space = this.embeddings!.id;
      });
    }

    await this.rwMutex.runExclusive(async () => {
      const doc: VectorDocument = { id, metadata: { tags, content: text }, chunks, lastUsedAt: Date.now() };
      const existingIdx = this.store.findIndex((d) => d.id === id);
      if (existingIdx >= 0) this.store[existingIdx] = doc;
      else this.store.push(doc);

      // Least-recently-USED, not first-in. See `lastUsedAt`.
      if (this.store.length > this.MAX_VECTORS) {
        this.store.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
        this.store.splice(0, this.store.length - this.MAX_VECTORS);
      }
      this.indexDirty = true;
      await this.saveStore();
      Logger.info(`[VectorStore] Memorized '${id}' (${chunks.length} chunk(s)).`);
    });
  }

  /**
   * The full pipeline.
   *
   * `minScore` is kept for API compatibility and reinterpreted: RRF scores and cross-encoder logits
   * are not similarities, so a cosine floor is meaningless against them. It is applied as a lexical
   * overlap floor, and ONLY to documents that no semantic stage surfaced — filtering a dense hit by
   * shared words would delete the capability the dense stage exists to add.
   */
  async semanticSearch(query: string, limit: number = 3, minScore: number = 0.25): Promise<VectorDocument[]> {
    if (!query.trim()) return [];

    const queryVector = this.embeddings
      ? (await this.embeddings.embed([query], 'query').catch(() => null))?.[0] ?? null
      : null;

    // Stages 1–3 under the lock; stage 4 is another network call and must not hold it.
    const fusedCandidates = await this.rwMutex.runExclusive(async () => {
      await this.loadStore(true);
      if (!this.store.length) return null;
      this.rebuildIndex();

      // Deeper than `limit` on purpose: fusion can only promote a candidate that appears in a list,
      // and the reranker can only reorder what it is given. Truncating early throws away the
      // agreement RRF exists to find and the recovery reranking exists to perform.
      const depth = Math.max(limit * 8, 32);
      const lexical = this.index.search(query).slice(0, depth).map((h) => h.id);

      let dense: string[] = [];
      if (queryVector) {
        const scored: { id: string; score: number }[] = [];
        for (const doc of this.store) {
          for (const chunk of doc.chunks ?? []) {
            if (!chunk.embedding || chunk.space !== this.embeddings?.id) continue;
            scored.push({ id: chunk.id, score: dot(queryVector, chunk.embedding) });
          }
        }
        scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        dense = scored.slice(0, depth).map((s) => s.id);
      }

      const fused = reciprocalRankFusion({ lexical: { ids: lexical }, dense: { ids: dense } });
      return {
        dense: dense.length > 0,
        // Chunk id → its text, for the reranker; and → its document, for the result.
        candidates: fused
          .map((hit) => {
            const doc = this.chunkOwner.get(hit.id);
            const chunk = doc?.chunks?.find((c) => c.id === hit.id);
            return doc && chunk ? { id: hit.id, text: chunk.text, doc, fromDense: hit.ranks.dense !== undefined } : null;
          })
          .filter((c): c is NonNullable<typeof c> => c !== null),
      };
    });

    if (!fusedCandidates) {
      this.mode = { lexical: true, dense: false, reranked: false };
      return [];
    }

    // Stage 4. A null result keeps the fused order — never a reordering we did not compute.
    let ordered = fusedCandidates.candidates;
    let reranked = false;
    if (this.reranker && ordered.length > 1) {
      const scores = await this.reranker
        .rerank(query, ordered.map((c) => ({ id: c.id, text: c.text })))
        .catch(() => null);
      if (scores?.length) {
        const rank = new Map(scores.map((s, i) => [s.id, i]));
        // Candidates outside the reranker's window keep their fused order, after the reranked ones.
        ordered = [...ordered].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
        reranked = true;
      }
    }

    this.mode = { lexical: true, dense: fusedCandidates.dense, reranked };
    Logger.info(
      `[VectorStore] search "${query.substring(0, 30)}" — lexical${fusedCandidates.dense ? '+dense' : ''}${reranked ? '+rerank' : ''}`,
    );

    // Chunks collapse to documents: several chunks of one note are one result, ranked by its best.
    const seen = new Set<string>();
    const results: VectorDocument[] = [];
    for (const candidate of ordered) {
      if (seen.has(candidate.doc.id)) continue;
      if (!candidate.fromDense && minScore > 0) {
        if (lexicalRelevance(query, candidate.text) < minScore) continue;
      }
      seen.add(candidate.doc.id);
      results.push(candidate.doc);
      if (results.length >= limit) break;
    }

    // Retrieval is what "used" means for eviction, and it is recorded IN MEMORY only.
    //
    // Writing the file here was the obvious implementation and it was wrong twice: it puts a disk
    // write on the read path of every search, and — because it cannot be awaited without making
    // every search wait for I/O it does not need — it races anything that inspects the store right
    // after a read. Eviction happens on `storeDocument`, which persists the whole store anyway, so
    // the in-memory value is always current at the moment it is used. The cost is that recency is
    // forgotten across a restart, which is the correct trade: it is a hint for choosing what to
    // discard, not a fact anything depends on.
    if (results.length) {
      const now = Date.now();
      for (const doc of results) {
        const live = this.store.find((d) => d.id === doc.id);
        if (live) live.lastUsedAt = now;
      }
    }

    return results;
  }

  /** Embed every chunk that has no usable vector. Idempotent; safe to call repeatedly. */
  async backfillEmbeddings(batch: number = 32): Promise<{ embedded: number; pending: number }> {
    if (!this.embeddings) return { embedded: 0, pending: 0 };

    const stale = await this.rwMutex.runExclusive(async () => {
      await this.loadStore(true);
      const out: { id: string; text: string }[] = [];
      for (const doc of this.store) {
        for (const chunk of doc.chunks ?? []) {
          if (!chunk.embedding || chunk.space !== this.embeddings!.id) out.push({ id: chunk.id, text: chunk.text });
          if (out.length >= batch) return out;
        }
      }
      return out;
    });
    if (!stale.length) return { embedded: 0, pending: 0 };

    const vectors = await this.embeddings.embed(stale.map((s) => s.text), 'passage').catch(() => null);
    if (!vectors) return { embedded: 0, pending: stale.length };

    return this.rwMutex.runExclusive(async () => {
      const byId = new Map<string, StoredChunk>();
      for (const doc of this.store) for (const chunk of doc.chunks ?? []) byId.set(chunk.id, chunk);

      let embedded = 0;
      stale.forEach((item, i) => {
        const chunk = byId.get(item.id);
        if (!chunk || !vectors[i]) return;
        chunk.embedding = vectors[i];
        chunk.space = this.embeddings!.id;
        embedded++;
      });
      if (embedded) { this.indexDirty = true; await this.saveStore(); }

      let pending = 0;
      for (const doc of this.store) {
        for (const chunk of doc.chunks ?? []) {
          if (!chunk.embedding || chunk.space !== this.embeddings!.id) pending++;
        }
      }
      return { embedded, pending };
    });
  }
}
