import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../utils';
import { Mutex } from 'async-mutex';
import { Bm25Index, tokenize } from './bm25';
import { reciprocalRankFusion } from './fusion';
import { dot, type EmbeddingBackend } from './embeddings';

/**
 * File-backed memory with HYBRID retrieval: BM25 + dense embeddings, fused by reciprocal rank.
 *
 * ## What changed and why
 *
 * This file used to carry an apology. It had once claimed "semantic" search over 512-bucket hash
 * embeddings, a previous pass caught that the maths did not support the claim, and rather than fix
 * it the claim was downgraded to honest keyword search — with a note saying to swap in real
 * embeddings "if true semantic recall is needed later". It was needed all along: a memory store
 * that cannot connect "the build is failing" to "CI is red" is a grep with extra steps.
 *
 * The two retrievers fail in opposite directions, which is the whole reason to run both:
 *
 *   - **BM25** owns exact tokens — identifiers, error codes, file names, a 51-character branch
 *     name. Terms an embedding model has never seen are precisely where dense retrieval is worst.
 *   - **Dense** owns paraphrase — the query and the document share no words but mean the same
 *     thing. Exactly where a lexical matcher scores zero.
 *
 * Running one is choosing which half of your queries to be bad at. They are fused by rank
 * (`./fusion`) rather than by score, because their scores are on incomparable scales.
 *
 * ## Degradation is a feature, not a fallback
 *
 * Embeddings need a network and a key. When they are unavailable `embed()` returns null and this
 * store returns **the BM25 ranking, unmodified** — not a blend of a real ranking with an absent
 * one, and never hashed pseudo-vectors standing in for the real thing. Retrieval gets worse in a
 * way that is explainable; it does not start lying. `lastSearchMode()` reports which happened, so a
 * caller can say so instead of quietly serving degraded results.
 *
 * ## Cached vectors are stamped, and a mismatch means re-embed
 *
 * A vector is only comparable to vectors from the same model at the same dimensionality. Records
 * carry the space id they were embedded in; on a model change the old vectors are ignored and
 * re-embedded rather than compared. Silently mixing two spaces yields similarity scores that look
 * entirely plausible and mean nothing.
 */
export interface VectorDocument {
  id: string;
  metadata: {
    tags: string[];
    content: string;
  };
  /** Unit-length dense vector, absent until embedded. Persisted so a restart does not re-pay. */
  embedding?: number[];
  /** The vector space `embedding` belongs to. A mismatch invalidates it — see the header. */
  space?: string;
}

export type SearchMode = 'hybrid' | 'lexical';

/** Kept exported: callers outside this module scored ad-hoc text against a query with it. */
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
  // Hard cap: evict oldest entries once exceeded to prevent unbounded growth & O(N) blowup.
  private readonly MAX_VECTORS = 500;

  private readonly embeddings: EmbeddingBackend | null;
  private index = new Bm25Index();
  private indexDirty = true;
  private mode: SearchMode = 'lexical';

  /**
   * `embeddings` is injected rather than constructed here, and that is deliberate: this class must
   * be constructible in a test, in an offline run and in the packaged binary without any of them
   * needing a key. Passing nothing is a supported configuration, not a broken one.
   */
  constructor(embeddings: EmbeddingBackend | null = null) {
    this.embeddings = embeddings;
    this.loadStore().catch(() => {});
  }

  /** Which retrieval the last search actually used. For telling the user, not for control flow. */
  lastSearchMode(): SearchMode {
    return this.mode;
  }

  private async loadStore(alreadyLocked: boolean = false) {
    const load = async () => {
      try {
        const data = await fs.readFile(this.STORE_PATH, 'utf-8');
        const parsed = JSON.parse(data);
        this.store = Array.isArray(parsed) ? parsed : [];
        // Vectors from a different model are not comparable to ours. Dropping them here — rather
        // than at compare time — means the re-embed happens once, on the next write or search,
        // instead of being re-decided per query.
        if (this.embeddings) {
          for (const doc of this.store) {
            if (doc.space && doc.space !== this.embeddings.id) {
              delete doc.embedding;
              delete doc.space;
            }
          }
        }
        this.indexDirty = true;
        Logger.info(`[VectorStore] Loaded ${this.store.length} memories from disk.`);
      } catch {
        // Missing file is fine
      }
    };

    if (alreadyLocked) {
      await load();
    } else {
      await this.rwMutex.runExclusive(load);
    }
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
    this.index.build(this.store.map((d) => ({ id: d.id, text: d.metadata?.content || '' })));
    this.indexDirty = false;
  }

  async storeDocument(id: string, text: string, tags: string[]): Promise<void> {
    await this.rwMutex.runExclusive(async () => {
      const doc: VectorDocument = { id, metadata: { tags, content: text } };

      // Embed on write, so a search never pays for indexing. A failure here is not an error: the
      // document is stored without a vector and picked up by the next backfill, and BM25 can rank
      // it in the meantime. Refusing the write because the network was down would lose the memory
      // entirely, which is a far worse outcome than a memory that is briefly lexical-only.
      if (this.embeddings) {
        const vectors = await this.embeddings.embed([text], 'passage').catch(() => null);
        if (vectors?.[0]) {
          doc.embedding = vectors[0];
          doc.space = this.embeddings.id;
        }
      }

      const existingIdx = this.store.findIndex((d) => d.id === id);
      if (existingIdx >= 0) {
        this.store[existingIdx] = doc;
      } else {
        this.store.push(doc);
        // Evict oldest entries once the cap is exceeded (FIFO).
        if (this.store.length > this.MAX_VECTORS) {
          this.store.splice(0, this.store.length - this.MAX_VECTORS);
        }
      }
      this.indexDirty = true;
      await this.saveStore();
      Logger.info(`[VectorStore] Memorized '${id}'.`);
    });
  }

  /**
   * Hybrid search.
   *
   * `minScore` is kept for API compatibility and reinterpreted: RRF scores are not similarities and
   * a cosine floor is meaningless against them. It is now applied to the **lexical** overlap of the
   * best-matching field, which is the closest honest reading of "don't return junk" — and it is
   * applied AFTER fusion so a dense-only match (no shared words at all, which is the case dense
   * retrieval exists for) is not filtered out by a lexical threshold. A caller that wants no floor
   * passes 0.
   */
  async semanticSearch(query: string, limit: number = 3, minScore: number = 0.25): Promise<VectorDocument[]> {
    if (!query.trim()) return [];

    // The dense query embedding is taken OUTSIDE the mutex: it is a network call that can take
    // hundreds of milliseconds, and holding the store's lock across it would serialize every
    // concurrent memory write behind an HTTP request.
    const queryVector = this.embeddings
      ? (await this.embeddings.embed([query], 'query').catch(() => null))?.[0] ?? null
      : null;

    return this.rwMutex.runExclusive(async () => {
      await this.loadStore(true);
      if (this.store.length === 0) return [];
      this.rebuildIndex();

      const byId = new Map(this.store.map((d) => [d.id, d]));
      // Deeper than `limit` on purpose: fusion can only promote a document that appears in a list,
      // so truncating each retriever to the final limit would throw away the agreement RRF exists
      // to find. A document ranked 8th by both should beat one ranked 1st by only one.
      const depth = Math.max(limit * 5, 20);

      const lexical = this.index.search(query).slice(0, depth).map((h) => h.id);

      let dense: string[] = [];
      if (queryVector) {
        const scored: { id: string; score: number }[] = [];
        for (const doc of this.store) {
          if (!doc.embedding || doc.space !== this.embeddings?.id) continue;
          // Both sides are unit vectors, so the dot product IS the cosine.
          scored.push({ id: doc.id, score: dot(queryVector, doc.embedding) });
        }
        scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        dense = scored.slice(0, depth).map((s) => s.id);
      }

      this.mode = dense.length ? 'hybrid' : 'lexical';
      Logger.info(`[VectorStore] ${this.mode} search for: "${query.substring(0, 30)}..."`);

      const fused = reciprocalRankFusion({
        lexical: { ids: lexical },
        dense: { ids: dense },
      });

      const results: VectorDocument[] = [];
      for (const hit of fused) {
        const doc = byId.get(hit.id);
        if (!doc) continue;
        // A document the dense retriever found is exempt from the lexical floor — no shared words
        // is the *point* of dense retrieval, and filtering it out would delete the capability this
        // whole change exists to add.
        const foundByDense = hit.ranks.dense !== undefined;
        if (!foundByDense && minScore > 0) {
          if (lexicalRelevance(query, doc.metadata?.content || '') < minScore) continue;
        }
        results.push(doc);
        if (results.length >= limit) break;
      }
      return results;
    });
  }

  /**
   * Embed every document that has no usable vector.
   *
   * Exists because the store predates embeddings and because a model change invalidates the whole
   * corpus at once. Returns how many were embedded so a caller can report progress rather than
   * appearing to hang. Safe to call repeatedly: documents that already have a current vector are
   * skipped, so this is idempotent and cheap once warm.
   */
  async backfillEmbeddings(batch: number = 32): Promise<{ embedded: number; pending: number }> {
    if (!this.embeddings) return { embedded: 0, pending: 0 };

    const stale = await this.rwMutex.runExclusive(async () => {
      await this.loadStore(true);
      return this.store
        .filter((d) => !d.embedding || d.space !== this.embeddings!.id)
        .slice(0, batch)
        .map((d) => ({ id: d.id, text: d.metadata?.content || '' }));
    });
    if (!stale.length) return { embedded: 0, pending: 0 };

    const vectors = await this.embeddings.embed(stale.map((s) => s.text), 'passage').catch(() => null);
    if (!vectors) return { embedded: 0, pending: stale.length };

    return this.rwMutex.runExclusive(async () => {
      let embedded = 0;
      stale.forEach((item, i) => {
        const doc = this.store.find((d) => d.id === item.id);
        if (!doc || !vectors[i]) return;
        doc.embedding = vectors[i];
        doc.space = this.embeddings!.id;
        embedded++;
      });
      if (embedded) await this.saveStore();
      const pending = this.store.filter((d) => !d.embedding || d.space !== this.embeddings!.id).length;
      return { embedded, pending };
    });
  }
}
