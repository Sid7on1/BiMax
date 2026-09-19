/**
 * Real embeddings, behind an interface that can honestly say "I don't have any".
 *
 * ## What this replaces
 *
 * `mind/embedder.ts` hashes tokens into buckets. That is a keyword signature wearing a vector's
 * clothes: it can tell you two texts share words, and it can never tell you that "the build is
 * failing" and "CI is red" are the same thought. Every consumer that called it "semantic" was
 * making a claim the maths did not support — the vector store's own header says as much, because a
 * previous pass caught it and downgraded the claim rather than fixing the cause. This is the fix.
 *
 * ## Why remote first, and why that is not a cop-out
 *
 * The current implementation uses the configured remote retrieval provider so it adds no local
 * model runtime to the packaged binary. That is an implementation choice, not proof that any
 * particular provider model is currently healthy; the live evidence journey owns that claim.
 *
 * The cost of that choice is that embeddings can be unavailable (offline, no key, provider down).
 * That is handled by being honest about it: `embed()` returns `null`, never a fabricated vector.
 * A caller that receives null falls back to lexical ranking, which is *worse but correct*. Returning
 * hashed pseudo-vectors instead would mean ranking on noise while reporting a semantic score — the
 * exact failure this module exists to end.
 *
 * ## Three details that are not details
 *
 * 1. **Asymmetric models need to be told which side they are embedding.** These retrieval models are
 *    trained with separate query and passage encoders. Embedding a query as a passage produces a
 *    vector in the wrong region of the space: no error, no warning, just quietly worse recall
 *    forever. `role` is therefore required at every call site rather than defaulted.
 * 2. **`truncate` defaults to NONE, which is an error and not a truncation.** A document past the
 *    context length fails the whole batch. We send `END`.
 * 3. **A vector is only comparable to vectors from the same model at the same size.** Every record
 *    is stamped with {@link EmbeddingBackend.id}; a mismatch means re-embed, never compare. Mixing
 *    two spaces produces similarity scores that look plausible and mean nothing.
 */

import { capabilityDeadline, capabilityEndpoint, reportCapability } from '../core/capability.status';
import {
  DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL, embeddingDialectFor, queryInstruction,
} from './settings';

/** Identifies the vector space. Change the model or the dimensions and this must change with it. */
export type EmbeddingSpaceId = string;

export interface EmbeddingBackend {
  /** Stamped onto every stored vector. Vectors whose stamp differs are re-embedded, not compared. */
  readonly id: EmbeddingSpaceId;
  readonly dimensions: number;
  /**
   * Embed a batch. Returns one unit-length vector per input, in order — or `null` when embeddings
   * are unavailable, which the caller must treat as "fall back to lexical", never as "no matches".
   */
  embed(texts: string[], role: 'query' | 'passage'): Promise<number[][] | null>;
}

/** Credentials for the OpenAI-compatible endpoint. Injected so this module owns no key policy. */
export interface EmbeddingCredentials {
  apiKey: string;
  baseURL: string;
}

/** The HTTP call, injected. Tests grade batching, roles and normalization without a network. */
export type EmbeddingTransport = (
  url: string,
  init: { headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface RemoteEmbeddingOptions {
  resolve: () => Promise<EmbeddingCredentials | null>;
  statusId?: string;
  model?: string;
  /**
   * Matryoshka truncation. The model emits 2048 and supports 384/512/768/1024/2048; the smaller
   * sizes are prefixes of the same vector, not a different model, so this trades a little accuracy
   * for a 4x smaller store and 4x faster scoring. 768 is the knee for a store of this size.
   */
  dimensions?: number;
  /** Provider batch ceiling. Oversized batches are split rather than rejected. */
  batchSize?: number;
  timeoutMs?: number;
  transport?: EmbeddingTransport;
}

const DEFAULT_BATCH = 64;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Unit-normalize in place-ish. With unit vectors, cosine similarity IS the dot product, so every
 * downstream comparison drops a square root and two divisions per pair. A zero vector is returned
 * unchanged rather than producing NaN — it scores 0 against everything, which is the right answer
 * for "this text carried no signal".
 */
export function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!norm || !Number.isFinite(norm)) return vector;
  return vector.map((v) => v / norm);
}

/** Dot product. Correct as cosine ONLY for unit vectors — which is why `normalize` is not optional. */
export function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

export class RemoteEmbeddingBackend implements EmbeddingBackend {
  /**
   * The size we ASKED for. Only meaningful on the dialect that accepts `dimensions`; a local
   * OpenAI-compatible server emits whatever its model emits and is never told to truncate.
   */
  private readonly declaredDimensions: number;
  /**
   * The size the server actually returned, learned on the first successful batch.
   *
   * This is not bookkeeping. `id` stamps every stored vector and `vector.store.ts` re-embeds when a
   * chunk's stamp differs, so an id that claims 768 while the model emits 1024 silently mixes two
   * spaces — and `dot()` walks only the shorter of the two, producing similarity scores that look
   * plausible and mean nothing. Whatever the model emitted IS the space, so the observation wins.
   */
  private observedDimensions: number | null = null;

  get dimensions(): number {
    return this.observedDimensions ?? this.declaredDimensions;
  }

  get id(): EmbeddingSpaceId {
    return `${this.model}@${this.dimensions}`;
  }

  private readonly resolve: () => Promise<EmbeddingCredentials | null>;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly transport: EmbeddingTransport;
  /**
   * Set once the provider has refused in a way that will refuse again — no key, or a 404 saying it
   * serves no embeddings. Retrying those on every search would add a network round trip to every
   * query for a capability that is not coming back this session. A 429 or a 5xx is NOT terminal.
   */
  private unavailable: string | null = null;
  private retryAt = 0;
  private readonly statusId: string;
  private fail(reason: string, permanent = false): null {
    this.unavailable = permanent ? reason : null;
    this.retryAt = Date.now() + (permanent ? 30_000 : 0);
    reportCapability({ id: this.statusId, label: 'Semantic retrieval', state: 'degraded', reason,
      impact: 'Search is using keywords only; paraphrase matches may be missed.',
      action: 'Check the embedding service and model settings. A later use retries automatically.' });
    return null;
  }

  constructor(options: RemoteEmbeddingOptions) {
    this.statusId = options.statusId ?? 'embeddings';
    this.resolve = options.resolve;
    this.model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    this.declaredDimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transport = options.transport ?? defaultTransport;
  }

  /** Why embeddings are off, for a UI that would otherwise just show worse results silently. */
  unavailableReason(): string | null {
    return this.unavailable;
  }

  async embed(texts: string[], role: 'query' | 'passage'): Promise<number[][] | null> {
    if (!texts.length) return [];
    if (Date.now() < this.retryAt) return null;

    const credentials = await capabilityDeadline(() => this.resolve(), this.timeoutMs).catch(() => null);
    if (!credentials?.apiKey) {
      // Named, not hedged: this reason is printed by /retrieval when semantic search is off, and
      // "credentials are unavailable" does not tell anyone what to do about it.
      return this.fail('no API key for embeddings — set one for the configured provider.', true);
    }

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = await this.embedBatch(texts.slice(i, i + this.batchSize), role, credentials);
      if (!batch) return null;
      out.push(...batch);
    }
    this.unavailable = null;
    this.retryAt = 0;
    reportCapability({ id: this.statusId, label: 'Semantic retrieval', state: 'ready',
      reason: 'The embedding service returned valid vectors.', impact: 'Subsequent searches can use semantic ranking.', action: '' });
    return out;
  }

  private async embedBatch(
    batch: string[],
    role: 'query' | 'passage',
    credentials: EmbeddingCredentials,
  ): Promise<number[][] | null> {
    try {
      const dialect = embeddingDialectFor(credentials.baseURL);
      // Empty strings are rejected by the provider and would fail the whole batch for one bad
      // record. A single space embeds to something meaningless, which is the correct outcome
      // for an empty document and costs nothing.
      const input = batch.map((t) => (t.trim() ? t : ' '));
      // Two incompatible bodies exist, for the same reason two rerank dialects do. NVIDIA/Cohere
      // take `input_type`/`truncate`/`dimensions`; the OpenAI embeddings schema has none of them,
      // so a local vLLM or Ollama answers 400 — which this module reports and backs off before retrying.
      const body = dialect === 'nvidia'
        ? {
            model: this.model,
            input,
            // The asymmetric half. See the header — getting this wrong is silent.
            input_type: role,
            // Without this, one long document is a 400 for the entire batch.
            truncate: 'END',
            dimensions: this.declaredDimensions,
            encoding_format: 'float',
          }
        : {
            model: this.model,
            // Asymmetry with no `input_type` to carry it: the instruction rides on the query text
            // itself, and the passage side stays bare so the corpus never needs re-indexing when
            // the instruction changes.
            input: role === 'query' ? input.map((t) => withInstruction(t)) : input,
            encoding_format: 'float',
          };

      const response = await capabilityDeadline(async (signal) => {
        const response = await this.transport(`${trimSlash(credentials.baseURL)}/embeddings`, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credentials.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
        return { ok: response.ok, status: response.status, payload: response.ok ? await response.json() : null };
      }, this.timeoutMs);

      if (!response.ok) {
        return this.fail(`Embedding service ${capabilityEndpoint(credentials.baseURL)}/embeddings returned HTTP ${response.status} (${dialect} body).`, [400, 401, 403, 404, 410, 422].includes(response.status));
      }

      const payload = response.payload as { data?: { embedding?: number[]; index?: number }[] };
      const rows = payload?.data;
      if (!Array.isArray(rows) || rows.length !== batch.length) return this.fail('Embedding response has the wrong row count.');
      // A complete permutation is required. Duplicate/missing indices can silently associate
      // a valid vector with the wrong document.
      const indices = new Set<number>();
      let width = this.observedDimensions;
      for (const row of rows) {
        if (!row || !Number.isInteger(row.index) || row.index! < 0 || row.index! >= batch.length || indices.has(row.index!))
          return this.fail('Embedding response has invalid or duplicate indices.');
        indices.add(row.index!);
        const v = row.embedding;
        if (!Array.isArray(v) || !v.length || v.some(n => typeof n !== 'number' || !Number.isFinite(n))
          || !Number.isFinite(v.reduce((sum, n) => sum + n * n, 0)) || !v.some(n => n !== 0))
          return this.fail('Embedding response contains invalid or zero vectors.');
        width ??= v.length;
        if (width !== v.length) return this.fail('Server changed embedding width within the active model space.', true);
      }
      this.observedDimensions = width;
      return [...rows].sort((a, b) => a.index! - b.index!).map(row => normalize(row.embedding!));
    } catch {
      return this.fail('Embedding request failed, timed out, or returned unreadable data.');
    }
  }
}

const defaultTransport: EmbeddingTransport = async (url, init) => {
  const response = await fetch(url, { method: 'POST', ...init });
  return { ok: response.ok, status: response.status, json: () => response.json() };
};

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Wrap a query in the instruction form open-weight retrieval models are trained to read.
 *
 * `Instruct: <task>\nQuery:<text>` is Qwen3-Embedding's documented shape, reproduced exactly —
 * including the absent space after `Query:`, which is how the model card writes it. An empty
 * instruction (BIMAX_EMBED_QUERY_INSTRUCTION="") returns the text untouched, which is what a
 * symmetric model such as BGE-M3 wants.
 */
export function withInstruction(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const task = queryInstruction(env);
  return task ? `Instruct: ${task}\nQuery:${text}` : text;
}
