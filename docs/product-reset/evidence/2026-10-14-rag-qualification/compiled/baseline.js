"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.VectorStore = void 0;
exports.lexicalRelevance = lexicalRelevance;
const state_dir_1 = require("../utils/state.dir");
const capability_status_1 = require("../core/capability.status");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const utils_1 = require("../utils");
const async_mutex_1 = require("async-mutex");
const bm25_1 = require("./bm25");
const bounded_top_k_1 = require("../utils/bounded.top.k");
const sufficiency_1 = require("./sufficiency");
const fusion_1 = require("./fusion");
const chunking_1 = require("./chunking");
const embeddings_1 = require("./embeddings");
/** Kept exported: callers outside this module score ad-hoc text against a query with it. */
function lexicalRelevance(query, text) {
    const q = new Set((0, bm25_1.tokenize)(query));
    const d = (0, bm25_1.tokenize)(text);
    if (!q.size || !d.length)
        return 0;
    let hits = 0;
    for (const term of d)
        if (q.has(term))
            hits++;
    return hits / d.length;
}
/**
 * Jaccard over content tokens — the dedup floor when embeddings are off. Word order and length do
 * not matter, which is the point: "the fix asks a freshly spawned child" and "a freshly spawned
 * child is what the fix asks for" are the same memory.
 */
function tokenJaccard(a, b) {
    const sa = new Set((0, bm25_1.tokenize)(a));
    const sb = new Set((0, bm25_1.tokenize)(b));
    if (!sa.size || !sb.size)
        return 0;
    let shared = 0;
    for (const t of sa)
        if (sb.has(t))
            shared++;
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
function centroidOf(chunks, spaceId) {
    if (!spaceId)
        return null;
    let sum = null;
    for (const chunk of chunks) {
        if (!chunk.embedding || chunk.space !== spaceId)
            continue;
        if (!sum)
            sum = new Array(chunk.embedding.length).fill(0);
        chunk.embedding.forEach((v, i) => { sum[i] += v; });
    }
    if (!sum)
        return null;
    const norm = Math.sqrt(sum.reduce((acc, v) => acc + v * v, 0));
    if (!norm || !Number.isFinite(norm))
        return null;
    return sum.map((v) => v / norm);
}
class VectorStore {
    store = [];
    diskIdentity = null;
    STORE_PATH;
    rwMutex = new async_mutex_1.Mutex();
    MAX_VECTORS;
    embeddings;
    reranker;
    chunk;
    dedup;
    /** Indexed over CHUNKS, not documents — the unit retrieval scores. */
    index = new bm25_1.Bm25Index();
    indexDirty = true;
    chunkOwner = new Map();
    mode = { lexical: true, dense: false, reranked: false };
    /** Recency changed on the read path and is waiting for the coalesced flush (see semanticSearch). */
    recencyDirty = false;
    recencyTimer = null;
    /** Tunable for tests and tight loops; 10s is the production default. */
    recencyFlushMs = Math.max(1, Number(process.env.BIMAX_RECENCY_FLUSH_MS ?? 10_000));
    constructor(embeddings = null, reranker = null, options = {}) {
        this.embeddings = embeddings;
        this.reranker = reranker;
        this.STORE_PATH = options.storePath ?? path.join((0, state_dir_1.stateDir)('.breakglass'), 'memory', 'vectors.json');
        this.MAX_VECTORS = Math.max(1, options.maxVectors ?? 500);
        this.chunk = options.chunker ?? ((id, text) => (0, chunking_1.chunkDocument)(id, text));
        this.dedup = options.dedup ?? true;
        this.loadStore().catch(() => { });
    }
    lastSearchMode() {
        return this.mode;
    }
    stemCache = new WeakMap();
    /**
     * Which of these stemmed content words appear in no document a search with `scope` could return (see
     * `memory/sufficiency.ts`). Reads the store as the last search left it.
     */
    unknownTerms(stems, scope = {}) {
        const remaining = new Set(stems);
        for (const doc of this.store) {
            if (!remaining.size)
                break;
            const tags = doc.metadata?.tags ?? [];
            if (scope.tags?.length && !tags.some((t) => scope.tags.includes(t)))
                continue;
            if (scope.excludeTags?.length && tags.some((t) => scope.excludeTags.includes(t)))
                continue;
            if (scope.where && !scope.where(tags))
                continue;
            const content = doc.metadata?.content ?? '';
            let cached = this.stemCache.get(doc);
            if (!cached || cached.content !== content) {
                cached = { content, stems: new Set((0, sufficiency_1.contentStems)(content)) };
                this.stemCache.set(doc, cached);
            }
            for (const term of remaining)
                if (cached.stems.has(term))
                    remaining.delete(term);
        }
        return [...remaining];
    }
    /** A snapshot for readouts (/retrieval) — counts, not contents. */
    stats() {
        let chunks = 0;
        let embedded = 0;
        const space = this.embeddings?.id;
        for (const doc of this.store) {
            for (const chunk of doc.chunks ?? []) {
                chunks++;
                if (space && chunk.embedding && chunk.space === space)
                    embedded++;
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
    async loadStore(alreadyLocked = false) {
        const load = async () => {
            try {
                // A retrieval may have updated recency in memory while its coalesced disk flush is still
                // pending. Reloading the file for the next search must not erase that newer timestamp.
                const stat = await fs.stat(this.STORE_PATH, { bigint: true });
                const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
                if (identity === this.diskIdentity)
                    return;
                const pendingRecency = this.recencyDirty
                    ? new Map(this.store.map((doc) => [doc.id, doc.lastUsedAt ?? 0]))
                    : null;
                const data = await fs.readFile(this.STORE_PATH, 'utf-8');
                const parsed = JSON.parse(data);
                if (!Array.isArray(parsed))
                    throw new Error('Invalid memory store');
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
                this.diskIdentity = identity;
                this.indexDirty = true;
                utils_1.Logger.info(`[VectorStore] Loaded ${this.store.length} memories from disk.`);
                (0, capability_status_1.reportCapability)({ id: 'memory-storage-read', label: 'Memory storage', state: 'ready',
                    reason: 'Stored memories were read successfully.', impact: '', action: '' });
            }
            catch (error) {
                if (error?.code === 'ENOENT') {
                    this.store = [];
                    this.diskIdentity = null;
                    this.indexDirty = true;
                    return;
                }
                (0, capability_status_1.reportCapability)({ id: 'memory-storage-read', label: 'Memory storage', state: 'unavailable',
                    reason: 'Stored memories could not be read.', impact: 'Memory results cannot be trusted as complete.',
                    action: 'Check the memory file and disk access before retrying.' });
                throw error;
            }
        };
        if (alreadyLocked)
            await load();
        else
            await this.rwMutex.runExclusive(load);
    }
    async saveStore() {
        try {
            await fs.mkdir(path.dirname(this.STORE_PATH), { recursive: true });
            const tmp = `${this.STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
            try {
                await fs.writeFile(tmp, JSON.stringify(this.store, null, 2), 'utf-8');
                const written = await fs.stat(tmp, { bigint: true });
                await fs.rename(tmp, this.STORE_PATH);
                const stat = await fs.stat(this.STORE_PATH, { bigint: true });
                // Cache only the bytes we wrote. Another writer may replace/overwrite the destination
                // between rename and stat; its identity must never be attached to our in-memory data.
                const stillOurs = stat.dev === written.dev && stat.ino === written.ino
                    && stat.size === written.size && stat.mtimeNs === written.mtimeNs;
                this.diskIdentity = stillOurs ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : null;
            }
            finally {
                await fs.rm(tmp, { force: true }).catch(() => { });
            }
            (0, capability_status_1.reportCapability)({ id: 'memory-storage-write', label: 'Memory persistence', state: 'ready',
                reason: 'Stored memories were saved successfully.', impact: '', action: '' });
        }
        catch (error) {
            (0, capability_status_1.reportCapability)({ id: 'memory-storage-write', label: 'Memory persistence', state: 'unavailable',
                reason: 'Memories could not be saved.', impact: 'The update is not durable.',
                action: 'Check free disk space and memory-directory permissions, then retry.' });
            throw error;
        }
    }
    rebuildIndex() {
        if (!this.indexDirty)
            return;
        const documents = [];
        this.chunkOwner = new Map();
        for (const doc of this.store) {
            for (const chunk of doc.chunks ?? []) {
                documents.push({ id: chunk.id, text: chunk.text });
                // Preserve the original lookup's first chunk within the last owning document.
                if (this.chunkOwner.get(chunk.id)?.doc !== doc)
                    this.chunkOwner.set(chunk.id, { doc, chunk });
            }
        }
        this.index.build(documents);
        this.indexDirty = false;
    }
    async storeDocument(id, text, tags) {
        return this.storeDocuments([{ id, text, tags }]);
    }
    /**
     * Store many documents with ONE embedding pass over all their chunks. A code index syncing a
     * directory is hundreds of documents; per-document embed calls would turn that into hundreds of
     * HTTP round trips carrying one vector each, when the backend exists to batch 64 to a call.
     */
    async storeDocuments(inputs) {
        if (!inputs.length)
            return;
        const prepared = inputs.map((input) => ({
            ...input,
            chunks: this.chunk(input.id, input.text).map((c) => ({ id: c.id, text: c.text })),
        }));
        // Embed OUTSIDE the mutex: network call, and the store lock must not serialize behind it.
        const flatText = prepared.flatMap((d) => d.chunks.map((c) => c.text));
        let vectors = null;
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
                        chunk.space = this.embeddings.id;
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
                const doc = {
                    id: targetId,
                    metadata: { tags: mergedTags, content: input.text },
                    chunks: input.chunks,
                    lastUsedAt: Date.now(),
                };
                const existingIdx = this.store.findIndex((d) => d.id === targetId);
                if (existingIdx >= 0)
                    this.store[existingIdx] = doc;
                else
                    this.store.push(doc);
                if (duplicateId) {
                    utils_1.Logger.info(`[VectorStore] Merged near-duplicate of '${duplicateId}' (${input.chunks.length} chunk(s)).`);
                }
            }
            const memorized = prepared.filter((p) => this.store.some((d) => d.id === p.id));
            if (memorized.length) {
                utils_1.Logger.info(`[VectorStore] Memorized ${memorized.length} document(s) (${prepared.reduce((n, p) => n + p.chunks.length, 0)} chunk(s)).`);
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
    findNearDuplicate(incomingId, incomingText, incomingCentroid) {
        let best = null;
        for (const doc of this.store) {
            if (doc.id === incomingId)
                continue; // exact re-store is an update, not a merge
            const jaccard = tokenJaccard(incomingText, doc.metadata?.content || '');
            let cosine = 0;
            if (incomingCentroid) {
                const c = centroidOf(doc.chunks ?? [], this.embeddings?.id ?? null);
                if (c)
                    cosine = (0, embeddings_1.dot)(incomingCentroid, c);
            }
            if (jaccard >= DEDUP_JACCARD
                || (cosine >= DEDUP_COSINE && jaccard >= DEDUP_CORROBORATION)) {
                if (!best || cosine + jaccard > best.cosine + best.jaccard)
                    best = { id: doc.id, cosine, jaccard };
            }
        }
        return best?.id ?? null;
    }
    /** Remove documents matching the predicate. Returns how many were removed. Persists immediately. */
    async deleteWhere(predicate) {
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
    async semanticSearch(query, limit = 3, minScore = 0.25, options = {}) {
        if (!query.trim())
            return [];
        const mode = options.mode ?? 'hybrid';
        const queryVector = this.embeddings && mode !== 'lexical'
            ? (await this.embeddings.embed([query], 'query').catch(() => null))?.[0] ?? null
            : null;
        // Stages 1–3 under the lock; stage 4 is another network call and must not hold it.
        const fusedCandidates = await this.rwMutex.runExclusive(async () => {
            await this.loadStore(true);
            if (!this.store.length)
                return null;
            this.rebuildIndex();
            // Tag scoping happens BEFORE depth is consumed (see SearchOptions) — filtering after
            // truncation quietly returns fewer results than asked for whenever unscoped documents rank
            // higher, which reads to the caller as "the memory doesn't exist".
            const tagSet = options.tags?.length ? new Set(options.tags) : null;
            const exclSet = options.excludeTags?.length ? new Set(options.excludeTags) : null;
            const docAllowed = (doc) => {
                if (!doc)
                    return false;
                const tags = doc.metadata?.tags ?? [];
                if (tagSet && !tags.some((t) => tagSet.has(t)))
                    return false;
                if (exclSet && tags.some((t) => exclSet.has(t)))
                    return false;
                if (options.where && !options.where(tags))
                    return false;
                return true;
            };
            const allowed = (chunkId) => docAllowed(this.chunkOwner.get(chunkId)?.doc);
            // Deeper than `limit` on purpose: fusion can only promote a candidate that appears in a list,
            // and the reranker can only reorder what it is given. Truncating early throws away the
            // agreement RRF exists to find and the recovery reranking exists to perform. The floor scales
            // with corpus reality: 32 was tuned on a memory store of hundreds of chunks; a code index
            // runs to thousands, where a 32-deep window is a sample, not a ranking.
            const depth = Math.max(limit * 8, 64);
            const lexicalHits = mode === 'dense' ? [] : this.index.search(query).filter(h => allowed(h.id));
            const lexical = lexicalHits.slice(0, depth).map(h => h.id);
            // Keep the original chunk pool/ranks. A bounded document pool fills only otherwise empty
            // result places, so a long note cannot monopolize all candidate slots.
            const lexicalDocuments = [];
            const seenDocuments = new Set();
            for (const hit of lexicalHits) {
                const entry = this.chunkOwner.get(hit.id);
                if (seenDocuments.has(entry.doc.id))
                    continue;
                if (minScore > 0 && lexicalRelevance(query, entry.chunk.text) < minScore)
                    continue;
                seenDocuments.add(entry.doc.id);
                lexicalDocuments.push(hit.id);
                if (lexicalDocuments.length >= limit)
                    break;
            }
            let dense = [];
            let denseDocuments = [];
            if (queryVector) {
                const compare = (a, b) => b.score - a.score
                    || (this.chunkOwner.get(b.id)?.doc.lastUsedAt ?? 0) - (this.chunkOwner.get(a.id)?.doc.lastUsedAt ?? 0)
                    || a.id.localeCompare(b.id);
                const scored = new bounded_top_k_1.BoundedTopK(depth, compare);
                const documents = new bounded_top_k_1.BoundedTopK(limit, compare);
                for (const doc of this.store) {
                    if (!docAllowed(doc))
                        continue;
                    let best;
                    for (const chunk of doc.chunks ?? []) {
                        if (!chunk.embedding || chunk.space !== this.embeddings?.id)
                            continue;
                        const candidate = { id: chunk.id, score: (0, embeddings_1.dot)(queryVector, chunk.embedding) };
                        scored.add(candidate);
                        if (!best || compare(candidate, best) < 0)
                            best = candidate;
                    }
                    if (best)
                        documents.add(best);
                }
                denseDocuments = documents.sorted().map(s => s.id);
                dense = scored.sorted().map((s) => s.id);
            }
            const fused = (0, fusion_1.reciprocalRankFusion)({ lexical: { ids: lexical }, dense: { ids: dense } });
            const backfill = (0, fusion_1.reciprocalRankFusion)({ lexical: { ids: lexicalDocuments }, dense: { ids: denseDocuments } });
            const candidates = (hits) => hits.map(hit => {
                const entry = this.chunkOwner.get(hit.id);
                return entry ? { id: hit.id, text: entry.chunk.text, doc: entry.doc, chunk: entry.chunk, fromDense: hit.ranks.dense !== undefined } : null;
            }).filter((candidate) => candidate !== null);
            return { dense: dense.length > 0, candidates: candidates(fused), backfill: candidates(backfill) };
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
                const guarded = (0, fusion_1.reciprocalRankFusion)({
                    retrieval: { ids: ordered.map((candidate) => candidate.id), weight: 1.25 },
                    rerank: { ids: scores.map((score) => score.id) },
                });
                const rank = new Map(guarded.map((hit, i) => [hit.id, i]));
                ordered = [...ordered].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
                reranked = true;
            }
        }
        this.mode = { lexical: true, dense: fusedCandidates.dense, reranked };
        utils_1.Logger.info(`[VectorStore] search "${query.substring(0, 30)}" — lexical${fusedCandidates.dense ? '+dense' : ''}${reranked ? '+rerank' : ''}`);
        // Chunks collapse to documents: several chunks of one note are one result, ranked by its best.
        // With `passages`, each result also keeps the rest of its matching chunks, in rank order.
        const matched = new Map();
        const results = [];
        for (const candidate of ordered) {
            const chunks = matched.get(candidate.doc.id);
            if (chunks && !options.passages)
                continue;
            if (!chunks && results.length >= limit) {
                if (options.passages)
                    continue;
                break;
            }
            if (!candidate.fromDense && minScore > 0) {
                if (lexicalRelevance(query, candidate.text) < minScore)
                    continue;
            }
            if (chunks) {
                chunks.push(candidate.chunk);
                continue;
            }
            matched.set(candidate.doc.id, [candidate.chunk]);
            results.push(candidate.doc);
        }
        // This pool is document-diverse, at most one champion per document from each retriever.
        // It neither reorders the successful prefix nor adds another remote reranking request.
        if (results.length < limit) {
            for (const candidate of fusedCandidates.backfill) {
                if (matched.has(candidate.doc.id))
                    continue;
                if (!candidate.fromDense && minScore > 0 && lexicalRelevance(query, candidate.text) < minScore)
                    continue;
                matched.set(candidate.doc.id, [candidate.chunk]);
                results.push(candidate.doc);
                if (results.length >= limit)
                    break;
            }
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
                if (live)
                    live.lastUsedAt = now;
            }
            this.scheduleRecencyFlush();
        }
        return options.passages
            ? results.map((doc) => ({ ...doc, matchedChunks: matched.get(doc.id) }))
            : results;
    }
    scheduleRecencyFlush() {
        this.recencyDirty = true;
        if (this.recencyTimer)
            return;
        this.recencyTimer = setTimeout(() => {
            this.recencyTimer = null;
            if (!this.recencyDirty)
                return;
            this.rwMutex.runExclusive(async () => {
                await this.loadStore(true);
                await this.saveStore();
                this.recencyDirty = false;
            }).catch(() => {
                // Keep the dirty bit: the next retrieval or write gets another chance to persist it.
                this.recencyDirty = true;
            });
        }, this.recencyFlushMs);
        this.recencyTimer.unref?.();
    }
    /** Embed every chunk that has no usable vector. Idempotent; safe to call repeatedly. */
    async backfillEmbeddings(batch = 32) {
        if (!this.embeddings)
            return { embedded: 0, pending: 0 };
        const stale = await this.rwMutex.runExclusive(async () => {
            await this.loadStore(true);
            const out = [];
            for (const doc of this.store) {
                for (const chunk of doc.chunks ?? []) {
                    if (!chunk.embedding || chunk.space !== this.embeddings.id)
                        out.push({ id: chunk.id, text: chunk.text });
                    if (out.length >= batch)
                        return out;
                }
            }
            return out;
        });
        if (!stale.length)
            return { embedded: 0, pending: 0 };
        const vectors = await this.embeddings.embed(stale.map((s) => s.text), 'passage').catch(() => null);
        if (!vectors)
            return { embedded: 0, pending: stale.length };
        return this.rwMutex.runExclusive(async () => {
            const byId = new Map();
            for (const doc of this.store)
                for (const chunk of doc.chunks ?? [])
                    byId.set(chunk.id, chunk);
            let embedded = 0;
            stale.forEach((item, i) => {
                const chunk = byId.get(item.id);
                if (!chunk || !vectors[i])
                    return;
                chunk.embedding = vectors[i];
                chunk.space = this.embeddings.id;
                embedded++;
            });
            if (embedded) {
                this.indexDirty = true;
                await this.saveStore();
            }
            let pending = 0;
            for (const doc of this.store) {
                for (const chunk of doc.chunks ?? []) {
                    if (!chunk.embedding || chunk.space !== this.embeddings.id)
                        pending++;
                }
            }
            return { embedded, pending };
        });
    }
}
exports.VectorStore = VectorStore;
