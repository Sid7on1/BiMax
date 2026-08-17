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

import { Logger } from '../utils';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from './settings';

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
  readonly id: EmbeddingSpaceId;
  readonly dimensions: number;

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

  constructor(options: RemoteEmbeddingOptions) {
    this.resolve = options.resolve;
    this.model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    this.dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transport = options.transport ?? defaultTransport;
    this.id = `${this.model}@${this.dimensions}`;
  }

  /** Why embeddings are off, for a UI that would otherwise just show worse results silently. */
  unavailableReason(): string | null {
    return this.unavailable;
  }

  async embed(texts: string[], role: 'query' | 'passage'): Promise<number[][] | null> {
    if (!texts.length) return [];
    if (this.unavailable) return null;

    const credentials = await this.resolve().catch(() => null);
    if (!credentials?.apiKey) {
      this.unavailable = 'no API key configured';
      return null;
    }

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = await this.embedBatch(texts.slice(i, i + this.batchSize), role, credentials);
      if (!batch) return null;
      out.push(...batch);
    }
    return out;
  }

  private async embedBatch(
    batch: string[],
    role: 'query' | 'passage',
    credentials: EmbeddingCredentials,
  ): Promise<number[][] | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.transport(`${trimSlash(credentials.baseURL)}/embeddings`, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credentials.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          // Empty strings are rejected by the provider and would fail the whole batch for one bad
          // record. A single space embeds to something meaningless, which is the correct outcome
          // for an empty document and costs nothing.
          input: batch.map((t) => (t.trim() ? t : ' ')),
          // The asymmetric half. See the header — getting this wrong is silent.
          input_type: role,
          // Without this, one long document is a 400 for the entire batch.
          truncate: 'END',
          dimensions: this.dimensions,
          encoding_format: 'float',
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 404 = this provider serves no embeddings; 401/403 = the key cannot; 410 = the model is
        // END-OF-LIFE (a live run caught exactly this: the previous default model began answering
        // 410 Gone and, absent from this list, masqueraded as a transient failure forever).
        // 400 is a permanent request/model mismatch. None improve by being asked again.
        // Everything else (429, 5xx, network) is transient: stay available so the next search
        // tries again.
        if ([400, 401, 403, 404, 410].includes(response.status)) {
          this.unavailable = `provider returned ${response.status} for ${this.model}`;
          Logger.warn(`[embeddings] disabled: ${this.unavailable}`);
        }
        return null;
      }

      const payload = (await response.json()) as { data?: { embedding?: number[]; index?: number }[] };
      const rows = payload?.data;
      if (!Array.isArray(rows) || rows.length !== batch.length) return null;

      // Order by `index` rather than trusting arrival order. The spec allows any order, and a
      // mis-ordered batch attaches every vector to the wrong document — which produces a store
      // that returns confident, completely unrelated results.
      const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const vectors: number[][] = [];
      for (const row of ordered) {
        if (!Array.isArray(row.embedding) || row.embedding.length === 0) return null;
        vectors.push(normalize(row.embedding));
      }
      return vectors;
    } catch {
      // Timeout, abort, malformed JSON. Transient by assumption — do not latch.
      return null;
    } finally {
      clearTimeout(timer);
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
