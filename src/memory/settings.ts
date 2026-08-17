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
}

/**
 * These are deployable defaults, not a quality claim. Provider availability and retrieval quality
 * must be revalidated with the evidence-producing live journey before a release is called Measured.
 */
export const DEFAULT_EMBEDDING_MODEL = 'nvidia/llama-nemotron-embed-1b-v2';
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_RERANK_MODEL = 'nvidia/rerank-qa-mistral-4b';

/** NVIDIA's rerankers serve from the retrieval host, not the chat/embeddings host. */
export const NVIDIA_RERANK_URL = 'https://ai.api.nvidia.com/v1/retrieval/nvidia/reranking';

/**
 * The URL a reranker call should hit for a given chat-style baseURL. NVIDIA's integrate host
 * answers 404 page-not-found for /v1/ranking; a custom/self-hosted base keeps the conventional
 * `<base>/ranking` shape.
 */
export function rerankURLFor(baseURL: string): string {
  return baseURL.includes('integrate.api.nvidia.com')
    ? NVIDIA_RERANK_URL
    : `${baseURL.replace(/\/+$/, '')}/ranking`;
}

const ALLOWED_DIMENSIONS = new Set([384, 512, 768, 1024, 2048]);

/** Overridable so tests can pin config precedence without touching module state. */
export interface SettingsConfigView {
  memoryEmbeddingModel?: string;
  memoryEmbeddingDimensions?: number;
  memoryRerankModel?: string;
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
