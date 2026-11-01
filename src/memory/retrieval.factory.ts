import { RemoteEmbeddingBackend, type EmbeddingCredentials } from './embeddings';
import { ChainedReranker, RemoteReranker } from './rerank';
import { LocalReranker } from './local.rerank';
import { resolveMemorySettings, rerankURLFor, type MemoryModelSettings } from './settings';
import { VectorStore, type VectorStoreOptions } from './vector.store';

export interface MemoryRetrievalOptions {
  /** Embedding and reranking destinations are separate policies, shared by host and workers. */
  resolveChat: () => Promise<EmbeddingCredentials | null>;
  settings?: MemoryModelSettings;
  localRerank?: boolean;
  store?: VectorStoreOptions;
}

/** No provider request or local model load occurs during construction. */
export function createMemoryRetrieval(options: MemoryRetrievalOptions) {
  const settings = options.settings ?? resolveMemorySettings();
  const embeddings = new RemoteEmbeddingBackend({
    resolve: async () => settings.embeddingBaseURL
      ? { apiKey: 'local', baseURL: settings.embeddingBaseURL }
      : options.resolveChat(),
    model: settings.embeddingModel,
    dimensions: settings.embeddingDimensions,
  });
  const remoteReranker = new RemoteReranker({
    statusId: 'reranking',
    resolve: async () => {
      const credentials = await options.resolveChat();
      return credentials ? { ...credentials, rerankURL: rerankURLFor(credentials.baseURL) } : null;
    },
    model: settings.rerankModel,
  });
  const localReranker = (options.localRerank ?? process.env.BIMAX_LOCAL_RERANK === '1') ? new LocalReranker() : null;
  const reranker = localReranker ? new ChainedReranker(remoteReranker, localReranker) : remoteReranker;
  return { embeddings, reranker, localReranker, store: new VectorStore(embeddings, reranker, options.store) };
}
