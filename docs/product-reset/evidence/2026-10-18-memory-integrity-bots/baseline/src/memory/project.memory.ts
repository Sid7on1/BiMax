import { VectorStore } from './vector.store';

/**
 * Self-writing project memory. A thin, file-backed layer over the VectorStore that
 * stores durable project knowledge — conventions, decisions, gotchas — and recalls the
 * most relevant entries for a given prompt so they can be injected into context
 * each turn. Retrieval runs the full hybrid pipeline (BM25 + dense + rerank) when the
 * store has an embedding backend, and BM25 alone otherwise — see VectorStore.
 */
export class ProjectMemory {
  constructor(private store: VectorStore = new VectorStore()) {}

  /**
   * Adopt the container-configured store (embeddings + reranker riding the chat key pool).
   * Must happen once at boot, before the first turn. Without it this instance searches
   * lexically only — two stores over the same file also race each other's whole-file writes.
   */
  useStore(store: VectorStore): void {
    this.store = store;
  }

  /** The backing store, so callers that need raw hybrid search (AgentLoop auto-recall) share this index. */
  get backingStore(): VectorStore {
    return this.store;
  }

  async remember(content: string, kind: 'convention' | 'decision' | 'gotcha' | 'note' = 'note', tags: string[] = []): Promise<string> {
    const trimmed = content.trim();
    if (!trimmed) return '';
    // Stable-ish id from kind + content hash so re-remembering the same fact updates it.
    let hash = 0;
    for (let i = 0; i < trimmed.length; i++) { hash = ((hash << 5) - hash + trimmed.charCodeAt(i)) | 0; }
    const id = `pmem-${kind}-${Math.abs(hash).toString(36)}`;
    await this.store.storeDocument(id, trimmed, ['project-memory', kind, ...tags]);
    return id;
  }

  async recall(query: string, limit = 3): Promise<string[]> {
    // Low lexical floor: project memories are short notes, and a strict word-overlap cutoff
    // would suppress genuinely relevant conventions that the dense/rerank stages surfaced.
    // Tag-scoped IN the store (not post-filtered) so `limit` project-memories means the `limit`
    // BEST project-memories, not "whatever survived after untagged documents took the slots".
    const docs = await this.store.semanticSearch(query, limit, 0.08, { tags: ['project-memory'] });
    return docs.map((d) => d.metadata.content);
  }

  /** A compact context block for injection into the system prompt, or '' if nothing relevant. */
  async recallBlock(query: string, limit = 3): Promise<string> {
    const hits = await this.recall(query, limit);
    if (hits.length === 0) return '';
    const bullets = hits.map(h => `- ${h.replace(/\n+/g, ' ').slice(0, 240)}`).join('\n');
    return `### PROJECT MEMORY (learned conventions & decisions — apply them)\n${bullets}`;
  }
}

export const globalProjectMemory = new ProjectMemory();
