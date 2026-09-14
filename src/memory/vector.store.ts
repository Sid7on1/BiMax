import { stateDir } from '../utils/state.dir';
import { reportCapability } from '../core/capability.status';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../utils';
import { Mutex } from 'async-mutex';
import { Bm25Index, tokenize } from './bm25';
import { contentStems } from './sufficiency';
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
 *
 * ## Writes deduplicate before they store
 *
 * A memory that keeps every phrasing of the same fact is a store that slowly fills with near
 * copies, and retrieval then spends its top-three budget on the same fact twice. `storeDocument`
 * therefore merges into an existing document when the new text is near-identical (embedding
 * centroid cosine, with a lexical Jaccard fallback when embeddings are off) instead of appending.
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
   * Only on search results requested with `SearchOptions.passages`: this document's chunks that matched,
   * best first. Those results are copies, so this is never stored.
   */
  matchedChunks?: StoredChunk[];
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

export interface SearchOptions {
  /**
   * Restrict retrieval to documents carrying at least one of these tags. Applied BEFORE depth is
   * consumed, not as a post-filter: a caller asking for 3 project-memories must get the 3 best
   * project-memories, not the 3 best documents of which 1 happens to be tagged.
   */
  tags?: string[];
  /**
   * Exclude documents carrying any of these tags. The two injection paths divide the store this
   * way: the persona's prompt block owns project-memory (conventions deliberately re-shown every
   * turn), automatic recall owns everything else — without the exclusion, one memory would be
   * injected twice in the same turn from two paths that cannot see each other.
   */
  excludeTags?: string[];
  /**
   * Restrict retrieval to documents whose tags pass this test, applied before depth is consumed like
   * `tags`. Tag equality cannot express a path scope, and filtering the results afterwards returned
   * nothing whenever out-of-scope documents ranked higher (record 47, A02).
   */
  where?: (tags: readonly string[]) => boolean;
  /**
   * Report which chunks of each result matched (`VectorDocument.matchedChunks`), best first, so a caller
   * can quote the part of a long note that answers instead of its opening (record 47, A03). Honoured by
   * VectorStore; the code store's documents are single chunks already.
   */
  passages?: boolean;
  /**
   * Which retrievers run. Default 'hybrid'. 'lexical' skips the embedding call entirely (no key,
   * or a caller that wants grep-class results fast); 'dense' skips BM25 — the diagnostic position
   * that isolates what fusion adds over either retriever alone.
   */
  mode?: 'hybrid' | 'lexical' | 'dense';
}

export interface StoreStats {
  documents: number;
  chunks: number;
  /** Chunks with a live vector in the active space. */
  embedded: number;
  /** Chunks the dense stage cannot see — embedded by `backfillEmbeddings` once a key exists. */
  pending: number;
  maxVectors: number;
  lastMode: SearchMode;
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

/**
 * Jaccard over content tokens — the dedup floor when embeddings are off. Word order and length do
 * not matter, which is the point: "the fix asks a freshly spawned child" and "a freshly spawned
 * child is what the fix asks for" are the same memory.
 */
function tokenJaccard(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  return shared / (sa.size + sb.size - shared);
}

/** Above this a stored document and the incoming text are the same memory in different words. */
const DEDUP_COSINE = 0.92;
/**
 * Lexical corroboration required alongside the cosine. Embedding centroids of two DIFFERENT facts
 * about the same topic can collide above any fixed threshold — the coarser the space (a small
 * Matryoshka cut, a low-dimension model), the easier — and a merge is a deletion of the older
 * memory, so embeddings alone must never be enough to trigger it. A genuine paraphrase shares most
 * of its content words with the original, which a different fact about the same topic does not.
 */
const DEDUP_CORROBORATION = 0.35;
/** Near-verbatim, with or without embeddings. */
const DEDUP_JACCARD = 0.8;

/**
 * Unit-length mean of a document's chunk vectors in the given space, or null when it has none
 * there. Chunk-level detail is deliberately averaged away: dedup wants "same fact?", and two
 * phrasings of one note share their centre of mass even when their chunk boundaries differ.
 */
function centroidOf(chunks: StoredChunk[], spaceId: string | null): number[] | null {
  if (!spaceId) return null;
  let sum: number[] | null = null;
  for (const chunk of chunks) {
    if (!chunk.embedding || chunk.space !== spaceId) continue;
    if (!sum) sum = new Array(chunk.embedding.length).fill(0);
    chunk.embedding.forEach((v, i) => { sum![i] += v; });
  }
  if (!sum) return null;
  const norm = Math.sqrt(sum.reduce((acc, v) => acc + v * v, 0));
  if (!norm || !Number.isFinite(norm)) return null;
  return sum.map((v) => v / norm);
}

export interface VectorStoreOptions {
  /** Where the JSON store lives. Default: <cwd>/.breakglass/memory/vectors.json. */
  storePath?: string;
  /**
   * Document cap before LRU-by-retrieval eviction. The memory store's 500 is tuned for
   * hand-written notes; a code index over a real repo needs an order of magnitude more.
   */
  maxVectors?: number;
  /**
   * How a document becomes chunks. The default splits prose; a code index passes an identity
   * chunker because it pre-chunks by source symbol, and re-splitting code on sentence
   * boundaries would index tokens the file never contained.
   */
  chunker?: (id: string, text: string) => { id: string; text: string }[];
  /**
   * Near-duplicate merging is right for memory (two phrasings of one fact are one memory) and
   * WRONG for code (two files with similar bodies are two files). Default true.
   */
  dedup?: boolean;
}

export class VectorStore {
  private store: VectorDocument[] = [];
  private readonly STORE_PATH: string;
  private rwMutex = new Mutex();
  private readonly MAX_VECTORS: number;

  private readonly embeddings: EmbeddingBackend | null;
  private readonly reranker: RemoteReranker | null;
  private readonly chunk: (id: string, text: string) => { id: string; text: string }[];
  private readonly dedup: boolean;
  /** Indexed over CHUNKS, not documents — the unit retrieval scores. */
  private index = new Bm25Index();
  private indexDirty = true;
  private chunkOwner = new Map<string, VectorDocument>();
  private mode: SearchMode = { lexical: true, dense: false, reranked: false };
  /** Recency changed on the read path and is waiting for the coalesced flush (see semanticSearch). */
  private recencyDirty = false;
  private recencyTimer: NodeJS.Timeout | null = null;
  /** Tunable for tests and tight loops; 10s is the production default. */
  private readonly recencyFlushMs = Math.max(1, Number(process.env.BIMAX_RECENCY_FLUSH_MS ?? 10_000));

  constructor(
    embeddings: EmbeddingBackend | null = null,
    reranker: RemoteReranker | null = null,
    options: VectorStoreOptions = {},
  ) {
    this.embeddings = embeddings;
    this.reranker = reranker;
    this.STORE_PATH = options.storePath ?? path.join(stateDir('.breakglass'), 'memory', 'vectors.json');
    this.MAX_VECTORS = Math.max(1, options.maxVectors ?? 500);
    this.chunk = options.chunker ?? ((id, text) => chunkDocument(id, text));
    this.dedup = options.dedup ?? true;
    this.loadStore().catch(() => {});
  }

  lastSearchMode(): SearchMode {
    return this.mode;
  }

  private stemCache = new WeakMap<VectorDocument, { content: string; stems: Set<string> }>();

  /**
   * Which of these stemmed content words appear in no document a search with `scope` could return (see
   * `memory/sufficiency.ts`). Reads the store as the last search left it.
   */
  unknownTerms(stems: readonly string[], scope: Pick<SearchOptions, 'tags' | 'excludeTags' | 'where'> = {}): string[] {
    const remaining = new Set(stems);
    for (const doc of this.store) {
      if (!remaining.size) break;
      const tags = doc.metadata?.tags ?? [];
      if (scope.tags?.length && !tags.some((t) => scope.tags!.includes(t))) continue;
      if (scope.excludeTags?.length && tags.some((t) => scope.excludeTags!.includes(t))) continue;
      if (scope.where && !scope.where(tags)) continue;
      const content = doc.metadata?.content ?? '';
      let cached = this.stemCache.get(doc);
      if (!cached || cached.content !== content) {
        cached = { content, stems: new Set(contentStems(content)) };
        this.stemCache.set(doc, cached);
      }
      for (const term of cached.stems) remaining.delete(term);
    }
    return [...remaining];
  }

  /** A snapshot for readouts (/retrieval) — counts, not contents. */
  stats(): StoreStats {
    let chunks = 0;
    let embedded = 0;
    const space = this.embeddings?.id;
    for (const doc of this.store) {
      for (const chunk of doc.chunks ?? []) {
        chunks++;
        if (space && chunk.embedding && chunk.space === space) embedded++;
      }
    }
    return {
      documents: this.store.length,
      chunks,
      embedded,
      pending: chunks - embedded,
      maxVectors: this.MAX_VECTORS,
      lastMode: this.mode,
    };
  }

  private async loadStore(alreadyLocked: boolean = false) {
    const load = async () => {
      try {
        // A retrieval may have updated recency in memory while its coalesced disk flush is still
        // pending. Reloading the file for the next search must not erase that newer timestamp.
        const pendingRecency = this.recencyDirty
          ? new Map(this.store.map((doc) => [doc.id, doc.lastUsedAt ?? 0]))
          : null;
        const data = await fs.readFile(this.STORE_PATH, 'utf-8');
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) throw new Error('Invalid memory store');
        this.store = parsed;
        for (const doc of this.store) {
          if (pendingRecency?.has(doc.id)) {
            doc.lastUsedAt = Math.max(doc.lastUsedAt ?? 0, pendingRecency.get(doc.id) ?? 0);
          }
          // Records written before chunking existed have no `chunks`. Derive them on load rather
          // than migrating the file: a read-time upgrade cannot corrupt anything, and the next
          // write persists the result anyway.
          if (!doc.chunks?.length) {
            const chunks = this.chunk(doc.id, doc.metadata?.content || '').map((c) => ({ id: c.id, text: c.text }));
            doc.chunks = chunks;
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
        reportCapability({ id: 'memory-storage-read', label: 'Memory storage', state: 'ready',
          reason: 'Stored memories were read successfully.', impact: '', action: '' });
      } catch (error: any) {
        if (error?.code === 'ENOENT') return;
        reportCapability({ id: 'memory-storage-read', label: 'Memory storage', state: 'unavailable',
          reason: 'Stored memories could not be read.', impact: 'Memory results cannot be trusted as complete.',
          action: 'Check the memory file and disk access before retrying.' });
        throw error;
      }
    };

    if (alreadyLocked) await load();
    else await this.rwMutex.runExclusive(load);
  }

  private async saveStore() {
    try {
      await fs.mkdir(path.dirname(this.STORE_PATH), { recursive: true });
      await fs.writeFile(this.STORE_PATH, JSON.stringify(this.store, null, 2), 'utf-8');
      reportCapability({ id: 'memory-storage-write', label: 'Memory persistence', state: 'ready',
        reason: 'Stored memories were saved successfully.', impact: '', action: '' });
    } catch (error) {
      reportCapability({ id: 'memory-storage-write', label: 'Memory persistence', state: 'unavailable',
        reason: 'Memories could not be saved.', impact: 'The update is not durable.',
        action: 'Check free disk space and memory-directory permissions, then retry.' });
      throw error;
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
    return this.storeDocuments([{ id, text, tags }]);
  }

  /**
   * Store many documents with ONE embedding pass over all their chunks. A code index syncing a
   * directory is hundreds of documents; per-document embed calls would turn that into hundreds of
   * HTTP round trips carrying one vector each, when the backend exists to batch 64 to a call.
   */
  async storeDocuments(inputs: { id: string; text: string; tags: string[] }[]): Promise<void> {
    if (!inputs.length) return;
    const prepared = inputs.map((input) => ({
      ...input,
      chunks: this.chunk(input.id, input.text).map((c): StoredChunk => ({ id: c.id, text: c.text })),
    }));

    // Embed OUTSIDE the mutex: network call, and the store lock must not serialize behind it.
    const flatText = prepared.flatMap((d) => d.chunks.map((c) => c.text));
    let vectors: number[][] | null = null;
    if (this.embeddings && flatText.length) {
      vectors = await this.embeddings.embed(flatText, 'passage').catch(() => null);
    }
    if (vectors) {
      let k = 0;
      for (const doc of prepared) {
        for (const chunk of doc.chunks) {
          const v = vectors[k++];
          if (v) {
            chunk.embedding = v;
            chunk.space = this.embeddings!.id;
          }
        }
      }
    }

    await this.rwMutex.runExclusive(async () => {
      // Never overwrite an unreadable store with the constructor's empty in-memory default.
      await this.loadStore(true);
      for (const input of prepared) {
        // Near-duplicate merge BEFORE insert (memory only — see VectorStoreOptions.dedup): a
        // store that keeps every phrasing of one fact spends its top-three retrieval budget
        // showing the same memory twice. The incoming text replaces the older copy's content
        // (newest phrasing wins) under the OLD id, so references and the retrieval history
        // attached to that memory survive; tags union so nothing is lost.
        const centroid = this.dedup ? centroidOf(input.chunks, this.embeddings?.id ?? null) : null;
        const duplicateId = this.dedup ? this.findNearDuplicate(input.id, input.text, centroid) : null;
        const targetId = duplicateId ?? input.id;
        const existing = this.store.find((d) => d.id === targetId);
        const mergedTags = Array.from(new Set([...(existing?.metadata?.tags ?? []), ...input.tags]));
        const doc: VectorDocument = {
          id: targetId,
          metadata: { tags: mergedTags, content: input.text },
          chunks: input.chunks,
          lastUsedAt: Date.now(),
        };
        const existingIdx = this.store.findIndex((d) => d.id === targetId);
        if (existingIdx >= 0) this.store[existingIdx] = doc;
        else this.store.push(doc);
        if (duplicateId) {
          Logger.info(`[VectorStore] Merged near-duplicate of '${duplicateId}' (${input.chunks.length} chunk(s)).`);
        }
      }
      const memorized = prepared.filter((p) => this.store.some((d) => d.id === p.id));
      if (memorized.length) {
        Logger.info(`[VectorStore] Memorized ${memorized.length} document(s) (${prepared.reduce((n, p) => n + p.chunks.length, 0)} chunk(s)).`);
      }

      // Least-recently-USED, not first-in. See `lastUsedAt`.
      if (this.store.length > this.MAX_VECTORS) {
        this.store.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
        this.store.splice(0, this.store.length - this.MAX_VECTORS);
      }
      this.indexDirty = true;
      await this.saveStore();
    });
  }

  /**
   * The closest existing memory to the incoming text, or null. Merging is a deletion of the older
   * copy, so it demands AGREEMENT between two independent signals:
   *
   *   - near-verbatim: token Jaccard ≥ 0.8, with or without embeddings; or
   *   - paraphrase: embedding centroid cosine ≥ 0.92 AND Jaccard ≥ 0.35 — semantic proximity says
   *     "same idea", lexical overlap says "same words rearranged", and only together do they say
   *     "same memory". Either alone deletes distinct facts that happen to be nearby in the space.
   */
  private findNearDuplicate(incomingId: string, incomingText: string, incomingCentroid: number[] | null): string | null {
    let best: { id: string; cosine: number; jaccard: number } | null = null;
    for (const doc of this.store) {
      if (doc.id === incomingId) continue; // exact re-store is an update, not a merge
      const jaccard = tokenJaccard(incomingText, doc.metadata?.content || '');
      let cosine = 0;
      if (incomingCentroid) {
        const c = centroidOf(doc.chunks ?? [], this.embeddings?.id ?? null);
        if (c) cosine = dot(incomingCentroid, c);
      }
      if (
        jaccard >= DEDUP_JACCARD
        || (cosine >= DEDUP_COSINE && jaccard >= DEDUP_CORROBORATION)
      ) {
        if (!best || cosine + jaccard > best.cosine + best.jaccard) best = { id: doc.id, cosine, jaccard };
      }
    }
    return best?.id ?? null;
  }

  /** Remove documents matching the predicate. Returns how many were removed. Persists immediately. */
  async deleteWhere(predicate: (doc: VectorDocument) => boolean): Promise<number> {
    return this.rwMutex.runExclusive(async () => {
      await this.loadStore(true);
      const before = this.store.length;
      this.store = this.store.filter((doc) => !predicate(doc));
      const removed = before - this.store.length;
      if (removed > 0) {
        this.indexDirty = true;
        await this.saveStore();
      }
      return removed;
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
  async semanticSearch(query: string, limit: number = 3, minScore: number = 0.25, options: SearchOptions = {}): Promise<VectorDocument[]> {
    if (!query.trim()) return [];

    const mode = options.mode ?? 'hybrid';
    const queryVector = this.embeddings && mode !== 'lexical'
      ? (await this.embeddings.embed([query], 'query').catch(() => null))?.[0] ?? null
      : null;

    // Stages 1–3 under the lock; stage 4 is another network call and must not hold it.
    const fusedCandidates = await this.rwMutex.runExclusive(async () => {
      await this.loadStore(true);
      if (!this.store.length) return null;
      this.rebuildIndex();

      // Tag scoping happens BEFORE depth is consumed (see SearchOptions) — filtering after
      // truncation quietly returns fewer results than asked for whenever unscoped documents rank
      // higher, which reads to the caller as "the memory doesn't exist".
      const tagSet = options.tags?.length ? new Set(options.tags) : null;
      const exclSet = options.excludeTags?.length ? new Set(options.excludeTags) : null;
      const docAllowed = (doc: VectorDocument | undefined): boolean => {
        if (!doc) return false;
        const tags = doc.metadata?.tags ?? [];
        if (tagSet && !tags.some((t) => tagSet.has(t))) return false;
        if (exclSet && tags.some((t) => exclSet.has(t))) return false;
        if (options.where && !options.where(tags)) return false;
        return true;
      };
      const allowed = (chunkId: string): boolean => docAllowed(this.chunkOwner.get(chunkId));

      // Deeper than `limit` on purpose: fusion can only promote a candidate that appears in a list,
      // and the reranker can only reorder what it is given. Truncating early throws away the
      // agreement RRF exists to find and the recovery reranking exists to perform. The floor scales
      // with corpus reality: 32 was tuned on a memory store of hundreds of chunks; a code index
      // runs to thousands, where a 32-deep window is a sample, not a ranking.
      const depth = Math.max(limit * 8, 64);
      const lexical = mode === 'dense'
        ? []
        : this.index.search(query).filter((h) => allowed(h.id)).slice(0, depth).map((h) => h.id);

      let dense: string[] = [];
      if (queryVector) {
        const scored: { id: string; score: number }[] = [];
        for (const doc of this.store) {
          if (!docAllowed(doc)) continue;
          for (const chunk of doc.chunks ?? []) {
            if (!chunk.embedding || chunk.space !== this.embeddings?.id) continue;
            scored.push({ id: chunk.id, score: dot(queryVector, chunk.embedding) });
          }
        }
        scored.sort((a, b) =>
          b.score - a.score
          // Ties go to what retrieval has already proved useful — a hint, never a rank change.
          || (this.chunkOwner.get(b.id)?.lastUsedAt ?? 0) - (this.chunkOwner.get(a.id)?.lastUsedAt ?? 0)
          || a.id.localeCompare(b.id),
        );
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
            return doc && chunk ? { id: hit.id, text: chunk.text, doc, chunk, fromDense: hit.ranks.dense !== undefined } : null;
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
        // A remote reranker is another signal, not an oracle. Fuse its ordering with the retrieval
        // ordering so one noisy response cannot erase candidates both first-stage retrievers liked.
        const guarded = reciprocalRankFusion({
          retrieval: { ids: ordered.map((candidate) => candidate.id), weight: 1.25 },
          rerank: { ids: scores.map((score) => score.id) },
        });
        const rank = new Map(guarded.map((hit, i) => [hit.id, i]));
        ordered = [...ordered].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
        reranked = true;
      }
    }

    this.mode = { lexical: true, dense: fusedCandidates.dense, reranked };
    Logger.info(
      `[VectorStore] search "${query.substring(0, 30)}" — lexical${fusedCandidates.dense ? '+dense' : ''}${reranked ? '+rerank' : ''}`,
    );

    // Chunks collapse to documents: several chunks of one note are one result, ranked by its best.
    // With `passages`, each result also keeps the rest of its matching chunks, in rank order.
    const matched = new Map<string, StoredChunk[]>();
    const results: VectorDocument[] = [];
    for (const candidate of ordered) {
      const chunks = matched.get(candidate.doc.id);
      if (chunks && !options.passages) continue;
      if (!chunks && results.length >= limit) {
        if (options.passages) continue;
        break;
      }
      if (!candidate.fromDense && minScore > 0) {
        if (lexicalRelevance(query, candidate.text) < minScore) continue;
      }
      if (chunks) {
        chunks.push(candidate.chunk);
        continue;
      }
      matched.set(candidate.doc.id, [candidate.chunk]);
      results.push(candidate.doc);
    }

    // Retrieval is what "used" means for eviction. Writing the file on EVERY search was the
    // obvious implementation and it was wrong twice: it puts a disk write on the read path of every
    // query, and — because it cannot be awaited without making every search wait on I/O it does not
    // need — it races anything that inspects the store right after a read. So the in-memory value
    // is updated immediately (eviction reads it on the next write, which persists everything
    // anyway), and the disk copy is flushed by a COALESCED background write: the first retrieval
    // arms one 10s timer, every further retrieval inside the window rides on it, and the timer is
    // unref'd so it can never hold the process open. Worst case is unchanged from before — a
    // crash inside the window forgets recency, which is a hint for eviction, not a fact anything
    // depends on.
    if (results.length) {
      const now = Date.now();
      for (const doc of results) {
        const live = this.store.find((d) => d.id === doc.id);
        if (live) live.lastUsedAt = now;
      }
      this.scheduleRecencyFlush();
    }

    return options.passages
      ? results.map((doc) => ({ ...doc, matchedChunks: matched.get(doc.id) }))
      : results;
  }

  private scheduleRecencyFlush(): void {
    this.recencyDirty = true;
    if (this.recencyTimer) return;
    this.recencyTimer = setTimeout(() => {
      this.recencyTimer = null;
      if (!this.recencyDirty) return;
      this.recencyDirty = false;
      this.rwMutex.runExclusive(async () => { await this.saveStore(); }).catch(() => {
        // Keep the dirty bit: the next retrieval or write gets another chance to persist it.
        this.recencyDirty = true;
      });
    }, this.recencyFlushMs);
    this.recencyTimer.unref?.();
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
