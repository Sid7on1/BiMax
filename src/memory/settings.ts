/**
 * One resolution path for the retrieval models, shared by the container and /retrieval.
 *
 * Before this existed the model ids lived only as constructor defaults, which meant the pipeline
 * was configurable in principle and fixed in fact: no config key, no env var, no way to point the
 * store at a different embedding space without editing source. That is fine until the provider
 * deprecates a model — then it is an outage with no user-side remedy.
 *
 * Precedence: env (headless/benchmark runs) → config key (persists across restarts) → built-in
 * default. Config is read defensively: the container can be constructed before loadConfig() in
 * embedded paths, and a retrieval stack that falls back to defaults beats one that throws at boot.
 */

export interface MemoryModelSettings {
  embeddingModel: string;
  /** Matryoshka truncation; 0 means the built-in default. One of 384/512/768/1024/2048. */
  embeddingDimensions: number;
  rerankModel: string;
  /**
   * Where the EMBEDDINGS calls go, when that is not where the chat calls go.
   *
   * Retrieval used to be pinned to the chat provider's base URL, which made the two questions
   * "who answers my prompts" and "who embeds my private corpus" the same question. They are not:
   * a local embedder is the cheap half to bring in-house, and it is the half that sees every
   * document. Empty means "follow the chat provider", which is the previous behaviour byte for
   * byte.
   *
   * A loopback value also flips `embeddingDialectFor` to the OpenAI body automatically, so
   * Ollama/vLLM/TEI work without the NVIDIA-only fields they reject with a terminal 400.
   */
  embeddingBaseURL: string;
}

/**
 * These are deployable defaults, not a quality claim. Provider availability and retrieval quality
 * must be revalidated with the evidence-producing live journey before a release is called Measured.
 */
/**
 * Measured 2026-09-12 against the live provider, because the previous default had silently died:
 * `nvidia/llama-nemotron-embed-1b-v2` answers **410 Gone** and is absent from the provider's
 * 81-model catalogue entirely. Retrieval does not fail loudly when that happens — the backend
 * latches `unavailable` and every search quietly degrades to BM25 alone, which measured
 * recall@3 0.80 / MRR 0.767 on the labelled set against 1.00 / 0.844 with a live embedder.
 *
 * Of the seven embedding models the catalogue advertises, only this one actually serves (200 OK,
 * 2048 dims); the other probed four answer 404. A default is a claim that it works, so it is now
 * the one that was measured working rather than the one that was shipped first.
 */
export const DEFAULT_EMBEDDING_MODEL = 'nvidia/nemotron-3-embed-1b';
export const DEFAULT_EMBEDDING_DIMENSIONS = 2048;
/**
 * Kept, but known-unavailable on at least one live account: every rerank model returns 404 with
 * the SAME function id ("Function ... not found for account"), i.e. the reranking function is not
 * provisioned rather than the model name being wrong. Reranking already degrades safely —
 * `lastSearchMode().reranked` reports false and fusion's order stands — so this stays a default
 * rather than a hard failure, and `BIMAX_RERANK_MODEL` retargets it.
 */
export const DEFAULT_RERANK_MODEL = 'nvidia/rerank-qa-mistral-4b';

/** NVIDIA's rerankers serve from the retrieval host, not the chat/embeddings host. */
export const NVIDIA_RERANK_URL = 'https://ai.api.nvidia.com/v1/retrieval/nvidia/reranking';

/**
 * The URL a reranker call should hit for a given chat-style baseURL. NVIDIA's integrate host
 * answers 404 page-not-found for /v1/ranking; a custom/self-hosted base keeps the conventional
 * `<base>/ranking` shape.
 */
/**
 * Where this provider's reranker lives.
 *
 * `<base>/ranking` is NVIDIA's path and NOBODY ELSE'S. Assuming it for every provider is why
 * reranking was dead on every local deployment: a sovereign install points at Ollama or vLLM, the
 * request 404s, and `vector.store.ts` swallows the failure and keeps the fused order. Measured on
 * T2-RAGBench that silence costs Recall@5 0.816 -> 0.695 — reranking is the single most impactful
 * stage in the pipeline, and it was the one stage an air-gapped site never got.
 *
 * vLLM (and Infinity, and TEI) serve the Cohere/Jina dialect at `/rerank`, `/v1/rerank` or
 * `/v2/rerank`. `BIMAX_RERANK_URL` overrides everything for an endpoint we cannot guess.
 */
export function rerankURLFor(baseURL: string): string {
  const explicit = (process.env.BIMAX_RERANK_URL || '').trim();
  if (explicit) return explicit;
  const base = baseURL.replace(/\/+$/, '');
  if (baseURL.includes('integrate.api.nvidia.com')) return NVIDIA_RERANK_URL;
  // An OpenAI-compatible local server: the rerank route sits beside the other v1 routes.
  if (/\/v\d+$/.test(base)) return `${base}/rerank`;
  return `${base}/v1/rerank`;
}

/**
 * Which request/response dialect an endpoint speaks. Two exist in the wild and they are not
 * compatible: sending one shape to the other returns a 422 that reads like a model error.
 */
export function rerankDialectFor(url: string): 'nvidia' | 'cohere' {
  return url.includes('nvidia.com') || url.endsWith('/ranking') ? 'nvidia' : 'cohere';
}

/**
 * Which request body an `/embeddings` endpoint will accept.
 *
 * The same bug `rerankURLFor` exists to fix was never fixed on the embeddings half. We send
 * `input_type`, `truncate` and `dimensions` on every call — three fields that are NVIDIA/Cohere
 * extensions and are NOT in the OpenAI embeddings schema. vLLM, Ollama, LM Studio and llama.cpp
 * reject the unknown fields with a 400, and 400 is in this module's terminal list, so the backend
 * latches `unavailable` on the FIRST query and never asks again. A sovereign install therefore ran
 * BM25-only for the rest of the session while reporting nothing worse than "no matches" — the exact
 * silent-degradation failure the embeddings header says it exists to prevent.
 *
 * Locality is the discriminator, not the vendor string: an on-premises server is the case that
 * cannot take the extensions, and `classifyDestination` already resolves that question with the
 * spoofing traps (octal, hex, userinfo) handled. Remote hosts keep the existing body byte for byte,
 * so this is strictly a repair of the broken path.
 */
export function embeddingDialectFor(baseURL: string): 'nvidia' | 'openai' {
  const forced = (process.env.BIMAX_EMBED_DIALECT || '').trim().toLowerCase();
  if (forced === 'openai' || forced === 'nvidia') return forced;
  // Late require: `settings` is imported from the container before boot completes, and sovereign.ts
  // is dependency-free so this can never cycle.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { classifyDestination } = require('../security/sovereign') as typeof import('../security/sovereign');
  const where = classifyDestination(baseURL);
  return where === 'loopback' || where === 'private-lan' ? 'openai' : 'nvidia';
}

/**
 * The instruction prefix an asymmetric local model wants on the QUERY side only.
 *
 * `input_type` is how the hosted providers are told which side they are embedding. Open-weight
 * retrieval models have no such field: Qwen3-Embedding is trained to read `Instruct: <task>\nQuery:`
 * on the query and nothing at all on the passage, which is what keeps the two sides asymmetric
 * without re-indexing when the task text changes. Dropping it is not an error — it is a measured
 * 1-5% recall loss that nothing reports.
 *
 * Set `BIMAX_EMBED_QUERY_INSTRUCTION` to retune it, or to empty to disable it for a symmetric model
 * (BGE-M3 wants no prefix). The value never touches the passage side.
 */
export const DEFAULT_QUERY_INSTRUCTION =
  'Given a web search query, retrieve relevant passages that answer the query';

export function queryInstruction(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BIMAX_EMBED_QUERY_INSTRUCTION;
  // Undefined means "unset, use the default"; an explicitly empty value means "disable".
  return raw === undefined ? DEFAULT_QUERY_INSTRUCTION : raw.trim();
}

const ALLOWED_DIMENSIONS = new Set([384, 512, 768, 1024, 2048]);

/** Overridable so tests can pin config precedence without touching module state. */
export interface SettingsConfigView {
  memoryEmbeddingModel?: string;
  memoryEmbeddingDimensions?: number;
  memoryRerankModel?: string;
  memoryEmbeddingBaseURL?: string;
}

export function resolveMemorySettings(
  configView: SettingsConfigView = readConfigIfLoaded(),
  env: NodeJS.ProcessEnv = process.env,
): MemoryModelSettings {
  const fromEnv = (value: string | undefined): string | undefined => {
    const trimmed = String(value || '').trim();
    return trimmed || undefined;
  };

  const dimsRaw = parseInt(fromEnv(env.BIMAX_EMBED_DIMS) || '', 10)
    || Number(configView.memoryEmbeddingDimensions || 0)
    || DEFAULT_EMBEDDING_DIMENSIONS;

  return {
    embeddingModel: fromEnv(env.BIMAX_EMBED_MODEL) || String(configView.memoryEmbeddingModel || '').trim() || DEFAULT_EMBEDDING_MODEL,
    // A dimension the model does not emit prefixes of is a 400 on every call, so an invalid value
    // resolves to the default rather than disabling embeddings entirely.
    embeddingDimensions: ALLOWED_DIMENSIONS.has(dimsRaw) ? dimsRaw : DEFAULT_EMBEDDING_DIMENSIONS,
    rerankModel: fromEnv(env.BIMAX_RERANK_MODEL) || String(configView.memoryRerankModel || '').trim() || DEFAULT_RERANK_MODEL,
    embeddingBaseURL: fromEnv(env.BIMAX_EMBED_BASE_URL) || String(configView.memoryEmbeddingBaseURL || '').trim() || '',
  };
}

function readConfigIfLoaded(): SettingsConfigView {
  try {
    // Late require: avoids a boot-order dependency on loadConfig() having run.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfig } = require('../cli/config') as typeof import('../cli/config');
    return getConfig();
  } catch {
    return {};
  }
}
