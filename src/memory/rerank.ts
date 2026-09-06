/**
 * Cross-encoder reranking — the fourth stage, and the one that fixes what the first three cannot.
 *
 * ## Why fusion is not enough
 *
 * BM25 and the embedding model are both **bi-encoders** in effect: each scores a document without
 * ever seeing the query alongside it. The document's representation is computed once, in advance,
 * with no knowledge of what will be asked. That is what makes them fast enough to run over a whole
 * corpus, and it is also their ceiling — a bi-encoder cannot notice that a document contains the
 * query's words in an order that reverses the meaning, or that it answers a *neighbouring* question
 * rather than this one.
 *
 * A cross-encoder reads the query and the passage **together** and scores the pair. It is far more
 * accurate and far too slow to run over hundreds of documents, which is exactly why it goes last:
 * retrieve broadly and cheaply, then re-score only the survivors. Retrieval finds candidates;
 * reranking decides the order. That two-stage shape is the whole design.
 *
 * ## Where the quality actually comes from
 *
 * The fused list is already good at getting the right document *somewhere* in the top twenty. It is
 * mediocre at getting it into the top three — and the top three is all that fits in a prompt. So
 * reranking is not a marginal polish on an already-solved problem; it is the stage that converts
 * "the answer is in here somewhere" into "the answer is first", which is the only form the rest of
 * the system can use.
 *
 * ## Degradation, again
 *
 * Same contract as embeddings: `rerank()` returns null when the provider cannot answer, and the
 * caller keeps the fused order. A reranker that silently returned the input unchanged would be
 * indistinguishable from one that worked, which is the failure mode this codebase keeps producing.
 */

import { Logger } from '../utils';
import { DEFAULT_RERANK_MODEL, rerankDialectFor } from './settings';

/** `rerankURL` overrides the endpoint when the reranker lives elsewhere than <base>/ranking —
 * on NVIDIA it does: the retrieval host, not the chat host (see settings.rerankURLFor). */
export interface RerankCredentials {
  rerankURL?: string;
  apiKey: string;
  baseURL: string;
}

export type RerankTransport = (
  url: string,
  init: { headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface RerankOptions {
  resolve: () => Promise<RerankCredentials | null>;
  model?: string;
  /**
   * How many candidates to re-score.
   *
   * The cost is linear in this and the accuracy gain is not — almost all of the benefit is in
   * reordering the top twenty or so, because a document the retrievers ranked 80th is very rarely
   * the right answer. Sending 200 candidates costs ten times as much for a fraction of a percent.
   */
  maxCandidates?: number;
  timeoutMs?: number;
  transport?: RerankTransport;
}

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankedHit {
  id: string;
  /** Raw cross-encoder logit. Comparable WITHIN one response, meaningless across queries. */
  logit: number;
}

const DEFAULT_MAX_CANDIDATES = 24;
const DEFAULT_TIMEOUT_MS = 20_000;

export class RemoteReranker {
  readonly model: string;
  private readonly resolve: () => Promise<RerankCredentials | null>;
  private readonly maxCandidates: number;
  private readonly timeoutMs: number;
  private readonly transport: RerankTransport;
  private unavailable: string | null = null;

  constructor(options: RerankOptions) {
    this.resolve = options.resolve;
    this.model = options.model ?? DEFAULT_RERANK_MODEL;
    this.maxCandidates = Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transport = options.transport ?? defaultTransport;
  }

  unavailableReason(): string | null {
    return this.unavailable;
  }

  /**
   * Re-score candidates against the query, best first.
   *
   * Returns null — never a reordering it did not compute — when the provider cannot answer.
   */
  async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankedHit[] | null> {
    if (!candidates.length) return [];
    if (this.unavailable || !query.trim()) return null;

    const credentials = await this.resolve().catch(() => null);
    if (!credentials?.apiKey) {
      this.unavailable = 'no API key configured';
      return null;
    }

    const window = candidates.slice(0, this.maxCandidates);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = credentials.rerankURL ?? `${trimSlash(credentials.baseURL)}/v1/rerank`;
      const dialect = rerankDialectFor(url);
      // Two incompatible dialects exist. NVIDIA's `/ranking` takes {query:{text}, passages:[{text}]}
      // and answers {rankings:[{index, logit}]}; everyone else (vLLM, Infinity, TEI, Cohere, Jina)
      // takes {query, documents:[string]} and answers {results:[{index, relevance_score}]}. Sending
      // the wrong one returns a 422 that reads like a bad model name, which is how this stayed
      // broken: the error blamed the model rather than the shape.
      const body = dialect === 'nvidia'
        ? {
            model: this.model,
            query: { text: query },
            passages: window.map((c) => ({ text: c.text || ' ' })),
            // Default is NONE, which errors on an over-length passage rather than trimming it —
            // and chunks are exactly the thing most likely to sit near the limit.
            truncate: 'END',
          }
        : {
            model: this.model,
            query,
            documents: window.map((c) => c.text || ' '),
            top_n: window.length,
          };

      const response = await this.transport(url, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credentials.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        if ([400, 401, 403, 404, 422].includes(response.status)) {
          this.unavailable = `${url} returned ${response.status} for ${this.model}`;
          // Named loudly, with the URL. The previous message said only the status and the model,
          // so an operator whose sovereign install was silently running WITHOUT its most impactful
          // retrieval stage had no way to see which endpoint had been tried.
          Logger.warn(
            `[rerank] DISABLED — ${this.unavailable}. Retrieval keeps the fused order, which costs `
            + `roughly Recall@5 0.82 -> 0.70. Set BIMAX_RERANK_URL to a reranking endpoint `
            + `(vLLM/Infinity/TEI serve one at /v1/rerank) or BIMAX_RERANK_MODEL to a served model.`,
          );
        }
        return null;
      }

      const payload = (await response.json()) as {
        rankings?: { index?: number; logit?: number }[];
        results?: { index?: number; relevance_score?: number }[];
      };
      const rows: { index?: number; score?: number }[] = dialect === 'nvidia'
        ? (payload?.rankings ?? []).map((r) => ({ index: r.index, score: r.logit }))
        : (payload?.results ?? []).map((r) => ({ index: r.index, score: r.relevance_score }));
      if (!Array.isArray(rows) || !rows.length) return null;

      const out: RerankedHit[] = [];
      for (const row of rows) {
        // `index` points into the passage array we sent. A row whose index is out of range means we
        // are misreading the response; dropping it silently would reorder by accident.
        const candidate = typeof row.index === 'number' ? window[row.index] : undefined;
        if (!candidate || typeof row.score !== 'number') return null;
        out.push({ id: candidate.id, logit: row.score });
      }
      // Both APIs document descending order, but sorting locally costs nothing and makes this
      // correct even if that ever changes — a silently mis-ordered rerank is worse than none.
      out.sort((a, b) => b.logit - a.logit);
      return out;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

const defaultTransport: RerankTransport = async (url, init) => {
  const response = await fetch(url, { method: 'POST', ...init });
  return { ok: response.ok, status: response.status, json: () => response.json() };
};

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
