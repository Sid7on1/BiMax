import * as fs from 'fs';
import * as path from 'path';
import { reportCapability } from '../core/capability.status';
import { Logger } from '../utils';
import type { RerankCandidate, RerankedHit, Reranker } from './rerank';
import { loadWordPiece, type WordPiece } from './wordpiece';

/**
 * The on-device reranker: a small cross-encoder run in this process, so reranking needs no key and sends nothing out.
 *
 * ## Why it exists
 *
 * Reranking is the stage that turns "the answer is in the top twenty" into "the answer is first" (see rerank.ts), and
 * until this file it only ever ran remotely. That left two groups with none: every install without a retrieval key,
 * which searched on BM25 alone, and — measured 2026-09-12 — the live account itself, whose rerank function answers
 * 404 for every model, so `lastSearchMode().reranked` was false for everyone. Code search was worse off still: sending
 * source text to a remote reranker needs explicit consent, so it never reranked at all.
 *
 * ## Measured, and why it is off by default (record 61)
 *
 * cross-encoder/ms-marco-MiniLM-L6-v2, int8 ONNX, 23 MB, Apache-2.0, pinned revision 233902d. On the labelled set in
 * eval.ts (15 queries, BM25 alone) it moved recall@3 from 0.80 to 0.93 and MRR from 0.811 to 0.844; through the store's
 * guard (fused with retrieval's order) 0.87 / 0.822. The 300-query SciFact run did not complete on this machine, so
 * that is the whole of the evidence. Loaded, the WebAssembly runtime costs ~240 MB of resident memory (the arena
 * settings change nothing; neither does one thread instead of two). On an 8 GB Mac that is another engine's worth, so
 * `BIMAX_LOCAL_RERANK=1` turns it on and nothing else does. It also scores a passage that merely repeats the query's
 * words highly — a known weakness of MS MARCO rerankers — which the guard fusion limits but does not remove.
 *
 * ## Runtime
 *
 * onnxruntime-web's WebAssembly build: no native addon to sign or unpack, the same shape as the tree-sitter .wasm the
 * engine already ships. Files are found at `BIMAX_LOCAL_RERANK_DIR`, else `models/rerank` beside the engine bundle
 * (prepare-engine.sh stages both the model and the runtime's .wasm there when built with BIMAX_LOCAL_RERANK=1). Missing files make `rerank()` return null —
 * the same contract as the remote reranker — and report why once; they never make search fail.
 */

export const LOCAL_RERANK_MODEL = 'ms-marco-MiniLM-L6-v2 (int8, on-device)';
const MODEL_FILE = 'model_qint8_arm64.onnx';
const TOKENIZER_FILE = 'tokenizer.json';
const DEFAULT_MAX_CANDIDATES = 20;
/**
 * Tokens per query–passage pair. Cost is linear in it; chunks are written to fit well under it (chunking.ts), so it
 * trims only the long tail rather than the answer.
 */
const DEFAULT_MAX_TOKENS = 384;

interface OrtTensorCtor { new (type: 'int64', data: BigInt64Array, dims: number[]): unknown }
interface OrtSession { outputNames: readonly string[]; run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>> }
interface OrtModule {
  env: { wasm: { numThreads?: number; wasmPaths?: string } ; logLevel?: string };
  Tensor: OrtTensorCtor;
  InferenceSession: { create(model: Uint8Array, options?: Record<string, unknown>): Promise<OrtSession> };
}

export interface LocalRerankOptions {
  /** Directory holding the model and tokenizer. */
  dir?: string;
  maxCandidates?: number;
  maxTokens?: number;
  /** WebAssembly threads. Two keeps a search from taking every performance core (see AGENTS.md: a worker budget). */
  threads?: number;
  statusId?: string;
}

/** Where the model is looked for when no directory is given. */
export function defaultLocalRerankDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.BIMAX_LOCAL_RERANK_DIR || '').trim();
  if (explicit) return explicit;
  return path.join(path.dirname(process.argv[1] || __filename), 'models', 'rerank');
}

export class LocalReranker implements Reranker {
  readonly model = LOCAL_RERANK_MODEL;
  private readonly dir: string;
  private readonly maxCandidates: number;
  private readonly maxTokens: number;
  private readonly threads: number;
  private readonly statusId: string;
  private loading: Promise<{ ort: OrtModule; session: OrtSession; tokenizer: WordPiece } | null> | null = null;
  private unavailable: string | null = null;

  constructor(options: LocalRerankOptions = {}) {
    this.dir = options.dir ?? defaultLocalRerankDir();
    this.maxCandidates = Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
    this.maxTokens = Math.max(16, options.maxTokens ?? DEFAULT_MAX_TOKENS);
    this.threads = Math.max(1, options.threads ?? 2);
    this.statusId = options.statusId ?? 'reranking-local';
  }

  unavailableReason(): string | null {
    return this.unavailable;
  }

  /** Whether the model files are on disk. Cheap; does not load anything. */
  installed(): boolean {
    return fs.existsSync(path.join(this.dir, MODEL_FILE)) && fs.existsSync(path.join(this.dir, TOKENIZER_FILE));
  }

  private load() {
    this.loading ??= (async () => {
      if (!this.installed()) {
        this.unavailable = `on-device reranker not installed (no ${MODEL_FILE} in ${this.dir})`;
        return null;
      }
      try {
        // Late import: the runtime is only paid for by a process that actually reranks.
        const ort = (await import('onnxruntime-web')) as unknown as OrtModule;
        ort.env.wasm.numThreads = this.threads;
        ort.env.logLevel = 'error';
        // In the packaged engine the runtime's .wasm sits beside the model, not in node_modules.
        const staged = fs.readdirSync(this.dir).some((name) => name.startsWith('ort-wasm') && name.endsWith('.wasm'));
        if (staged) ort.env.wasm.wasmPaths = this.dir + path.sep;
        const session = await ort.InferenceSession.create(fs.readFileSync(path.join(this.dir, MODEL_FILE)), { executionProviders: ['wasm'] });
        return { ort, session, tokenizer: loadWordPiece(path.join(this.dir, TOKENIZER_FILE)) };
      } catch (error) {
        this.unavailable = `on-device reranker failed to load: ${error instanceof Error ? error.message : String(error)}`;
        Logger.warn(`[LocalReranker] ${this.unavailable}`);
        return null;
      }
    })();
    return this.loading;
  }

  /** Re-score candidates against the query, best first; null when the model cannot run. */
  async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankedHit[] | null> {
    if (!candidates.length) return [];
    if (!query.trim()) return null;
    const loaded = await this.load();
    if (!loaded) {
      reportCapability({ id: this.statusId, label: 'On-device reranking', state: 'degraded', reason: this.unavailable ?? 'not available',
        impact: 'Results keep the first-stage order unless a remote reranker answers.', action: 'Reinstall Bimax to restore the model files.' });
      return null;
    }
    const { ort, session, tokenizer } = loaded;
    const window = candidates.slice(0, this.maxCandidates);
    try {
      const encoded = window.map((candidate) => tokenizer.encodePair(query, candidate.text || ' ', this.maxTokens));
      const width = Math.max(...encoded.map((pair) => pair.ids.length));
      const size = window.length * width;
      const ids = new BigInt64Array(size);
      const mask = new BigInt64Array(size);
      const types = new BigInt64Array(size);
      encoded.forEach((pair, row) => {
        pair.ids.forEach((token, column) => {
          ids[row * width + column] = BigInt(token);
          mask[row * width + column] = 1n;
          types[row * width + column] = BigInt(pair.types[column]);
        });
      });
      const dims = [window.length, width];
      const output = await session.run({
        input_ids: new ort.Tensor('int64', ids, dims),
        attention_mask: new ort.Tensor('int64', mask, dims),
        token_type_ids: new ort.Tensor('int64', types, dims),
      });
      const logits = output[session.outputNames[0]].data;
      if (logits.length !== window.length) throw new Error(`expected ${window.length} scores, got ${logits.length}`);
      const hits = window.map((candidate, row) => ({ id: candidate.id, logit: Number(logits[row]) }));
      if (hits.some((hit) => !Number.isFinite(hit.logit))) throw new Error('non-finite score');
      this.unavailable = null;
      return hits.sort((a, b) => b.logit - a.logit);
    } catch (error) {
      this.unavailable = `on-device reranking failed: ${error instanceof Error ? error.message : String(error)}`;
      Logger.warn(`[LocalReranker] ${this.unavailable}`);
      return null;
    }
  }
}
