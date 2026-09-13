import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { mindSingletonRoot } from './self.model';
import { embed, packEmbedding, nearest, Neighbor, embedderInfo } from './embedder';

/**
 * ExemplarStore — episodic memory with VERIFIED outcomes (v2 §9.3).
 *
 * Exemplars are appended by the self-play generators (mutation fix, regeneration,
 * history replay) only after an objective check passed — nothing in here is a vibe.
 * At prompt time the store retrieves the few most similar past wins for the current
 * task and injects them as evidence ("you have solved something like this here
 * before, verified by <check>"), replacing generic instruction text with this repo's
 * own experience. Retrieval is the local hash-kernel embedder — lexical similarity,
 * shown items, honest tier; the vectors are cached in the JSON and recomputed if the
 * embedder version changes.
 */

const RETRIEVE_K = 2;
const MIN_SIM = 0.22;

export interface Exemplar {
  at: string;
  kind: string;               // mutation-fix | regeneration | history-replay
  outcome: string;            // exact | alternative | regenerated | verified
  task?: string;
  file?: string;
  testFile?: string;
  op?: string;
  defect?: string;
  fix?: string;
  evidence?: string;
  embedding?: number[];
  embedderV?: number;
}

function exemplarText(e: Exemplar): string {
  return [e.task, e.file, e.testFile, e.op, e.kind, e.defect, e.fix, e.evidence]
    .filter(Boolean).join('\n');
}

export class ExemplarStore {
  private filePath: string;

  constructor(projectRoot: string = mindSingletonRoot()) {
    this.filePath = path.join(stateDir('.bimax', projectRoot), 'exemplars.json');
  }

  all(): Exemplar[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  /** Backfill/refresh cached embeddings; persists only when something changed. A backend
   * swap (embedderInfo().version bump) re-embeds the whole corpus here automatically —
   * vector spaces never mix. */
  private ensureEmbeddings(items: Exemplar[]): Exemplar[] {
    const version = embedderInfo().version;
    let changed = false;
    for (const e of items) {
      if (!e.embedding || e.embedderV !== version) {
        e.embedding = packEmbedding(embed(exemplarText(e)));
        e.embedderV = version;
        changed = true;
      }
    }
    if (changed) {
      try { fs.writeFileSync(this.filePath, JSON.stringify(items, null, 2), 'utf-8'); }
      catch { /* cache write is best-effort */ }
    }
    return items;
  }

  /** The k most similar verified exemplars for this task context. */
  retrieve(context: string, k = RETRIEVE_K): Neighbor<Exemplar>[] {
    const items = this.all();
    if (items.length === 0 || !context?.trim()) return [];
    return nearest(embed(context), this.ensureEmbeddings(items), k, MIN_SIM);
  }

  /**
   * Prompt section for the current task — only when something genuinely similar
   * exists. Every line names its verification, per the evidence-not-vibes rule.
   */
  getPromptBlock(taskContext: string): string {
    const hits = this.retrieve(taskContext);
    if (hits.length === 0) return '';
    const lines = hits.map(({ item: e, sim }) => {
      const what = e.kind === 'history-replay'
        ? `re-solved "${(e.task || '').slice(0, 90)}" (verified by \`${e.evidence || 'recorded check'}\`)`
        : `${e.outcome === 'exact' ? 'exactly fixed' : 'fixed'} a ${e.op} defect in \`${e.file}\` (verified by \`${e.testFile}\`)`;
      return `- ${what} — ${Math.round(sim * 100)}% similar to this task`;
    });
    return `### VERIFIED EXPERIENCE (this repo — retrieved from past objectively-verified episodes)\nYou have succeeded at similar work here before; prefer the approaches that already verified:\n${lines.join('\n')}`;
  }
}

let _global: ExemplarStore | null = null;
export function getExemplarStore(): ExemplarStore {
  if (!_global) _global = new ExemplarStore(mindSingletonRoot());
  return _global;
}
export function __setExemplarStore(s: ExemplarStore | null): void { _global = s; }
