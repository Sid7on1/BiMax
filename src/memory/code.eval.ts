/**
 * Code-retrieval evaluation — the same discipline the memory eval applies, pointed at source.
 *
 * The corpus is THIS repository's own `src/` tree, indexed for real (walker, chunker, store) with
 * a deterministic stand-in embedding backend; the cases are intent-phrased questions whose
 * answers are files a developer would accept. Three positions are measured:
 *
 *   1. lexical only (embeddings off) — the grep-equivalent baseline;
 *   2. hybrid — dense stage on, the full pipeline as it runs with a key;
 *   3. hybrid without contextual headers — isolates what the `path :: symbol` prefix buys.
 *
 * As with the memory eval: the stand-in proves the PIPELINE converts a semantic signal into
 * retrieval, not that any particular provider model is good. Numbers here are comparable across
 * the three positions and across future code-retrieval changes — nothing else.
 */
import type { CodeIndex, CodeHit } from './code.index';

export interface CodeEvalCase {
  query: string;
  /** The file a developer would accept as the answer, relative to the index root. */
  file: string;
}

export const CODE_EVAL_CASES: CodeEvalCase[] = [
  { query: 'where do provider credentials get rotated across the key pool', file: 'credits/api.key.manager.ts' },
  { query: 'combine the ranked lists coming out of two retrievers', file: 'memory/fusion.ts' },
  { query: 'rescore candidate passages against the query with a cross encoder', file: 'memory/rerank.ts' },
  { query: 'make vectors unit length so cosine becomes a dot product', file: 'memory/embeddings.ts' },
  { query: 'pull memories into the context window automatically on a user turn', file: 'memory/recall.ts' },
  { query: 'split long notes into pieces without breaking code fences', file: 'memory/chunking.ts' },
  { query: 'persist and reload the vector documents from a json file', file: 'memory/vector.store.ts' },
  { query: 'parse python files into graph symbols with tree sitter', file: 'graph/treesitter.analyzer.ts' },
  { query: 'the sqlite backed store for the code graph', file: 'graph/sqlite.graph.store.ts' },
  { query: 'assemble the persona system prompt with a cacheable static prefix', file: 'engine/personas/base.persona.ts' },
  { query: 'the composition root where every tool gets registered', file: 'core/container.ts' },
  { query: 'the main loop that runs tool calls until the model stops asking', file: 'core/agent.loop.ts' },
  { query: 'resolve which memory settings win between env and config', file: 'memory/settings.ts' },
  { query: 'keep two copies of the same fact from filling the store', file: 'memory/vector.store.ts' },
  { query: 'pick which model answers quick auxiliary questions', file: 'engine/models.ts' },
  { query: 'stream provider responses token by token into the session', file: 'core/llm.adapter.ts' },
  { query: 'run shell commands behind approval and a timeout', file: 'tools/implementations/bash.tool.ts' },
  { query: 'find files whose contents match a regular expression', file: 'tools/implementations/search.tool.ts' },
  { query: 'modify a file by swapping an exact stretch of text', file: 'tools/implementations/edit.tool.ts' },
  { query: 'expose git operations to the agent safely', file: 'tools/implementations/git.tool.ts' },
  { query: 'run user hooks around tool invocations', file: 'tools/hooks.ts' },
  { query: 'record and replay events across the cli', file: 'engine/events.ts' },
  { query: 'hash strings into stable buckets for similarity', file: 'mind/embedder.ts' },
  { query: 'grade retrieval quality against labelled cases', file: 'memory/eval.ts' },
  { query: 'the probe command proving embeddings are live', file: 'engine/commands/retrieval.ts' },
  { query: 'compare app names ignoring case and suffixes', file: 'computer/desktop.runtime.ts' },
  { query: 'spawn and track child agents doing delegated work', file: 'core/subagent.manager.ts' },
  { query: 'give a task its own checkout so edits stay isolated', file: 'core/worktree.manager.ts' },
];

export interface CodeEvalResult {
  cases: number;
  recallAtK: number;
  mrr: number;
  k: number;
  detail: { query: string; foundAt: number | null }[];
}

export async function evaluateCodeRetrieval(
  index: CodeIndex,
  cases: CodeEvalCase[],
  k: number = 3,
): Promise<CodeEvalResult> {
  const detail: { query: string; foundAt: number | null }[] = [];
  let found = 0;
  let reciprocalSum = 0;

  for (const testCase of cases) {
    // k+2 overfetch keeps a tie at the boundary from reading as a miss; slice enforces k.
    const hits: CodeHit[] = await index.search(testCase.query, k + 2);
    const top = hits.slice(0, k);
    const position = top.findIndex((h) => h.path === testCase.file);

    if (position >= 0) {
      found++;
      reciprocalSum += 1 / (position + 1);
      detail.push({ query: testCase.query, foundAt: position + 1 });
    } else {
      detail.push({ query: testCase.query, foundAt: null });
    }
  }

  return {
    cases: cases.length,
    recallAtK: cases.length ? found / cases.length : 0,
    mrr: cases.length ? reciprocalSum / cases.length : 0,
    k,
    detail,
  };
}
