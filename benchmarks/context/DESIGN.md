# Context benchmark

Step 4 of [record 50](../../docs/product-reset/50_CONTEXT_COMPILER_BUILD_PLAN.md). It measures whether the
evidence a task needs actually reaches the model's prompt, on small fixed fixtures, and records the result as
the baseline that every later stage of the Context Compiler has to beat.

## What it measures, and what it does not

Each case runs the real pipeline stage that feeds the prompt (automatic recall, `CodeSearchTool`, the graph
context pack, compaction and restoration, the read cache, the fact store, log compression) and grades the text
that stage produces.

- **No model is called.** Grades never depend on a model's answer, so a run is free, offline and repeatable.
  This measures evidence reaching the prompt, not whether a model then answers correctly.
- **The dense stage and reranker are off,** which is the local default (R02). Lexical retrieval is SQLite FTS5
  bm25 for code and in-process BM25 for memory. Live-provider retrieval quality has its own runner,
  `scripts/live-retrieval-run.ts`.
- **Fixtures are synthetic and small** (about 35 cases). They establish that a failure exists and whether a
  change fixes it, not how often it happens in real use.
- **The long-session family uses a summarizer that keeps nothing,** so it measures what the pipeline preserves
  structurally across compaction, not the quality of a real model's summary.
- **Timings are recorded, never graded.** This machine's timings are noisy, and no Bimax path has a latency
  baseline; operation counts and token counts are the comparable numbers.

The existing retrieval evals (`src/__tests__/memory.eval.test.ts`, `src/__tests__/code.index.eval.test.ts`)
stay as they are. They grade ranking on labelled sets; this benchmark grades what reaches the prompt.

## Families

| Family | Cases grade |
|---|---|
| `single-hop` | the answering span reaches the recall block: answer at the end of a long note, duplicate headings, a non-Latin query, distractors, and abstention on a question with no answer |
| `multi-hop-code` | every required file or symbol reaches `CodeSearchTool` output or the graph context pack |
| `temporal` | the current value, a historical value, and both sides of a conflict reach the recall block |
| `source-change` | stale text is not served as current after a same-size rewrite, a rename, a delete, an unsynced change, or a read-cache hit |
| `long-session` | a constraint, a tested revision and a failed attempt survive ten compactions |
| `numeric` | exact values with provenance, no inferred units or dates, full-domain rows, and outliers kept by compression |
| `budget` | packs and recall stay within their stated budgets, and an answer survives a tight recall budget; token counts are recorded |
| `scope` | scoped search stays in scope, and an incomplete index says so |

## Validity

A run is **invalid, not failed,** when any of these hold, and the record says why:

- a grader fails its self-check (`graders.ts`);
- SQLite FTS5 is unavailable (run it under Bun: `npm run bench:context`);
- any network call is attempted (the runner replaces `fetch` and counts calls; the count must be 0).

A case that throws is a **failure** with its error recorded, never a pass.

## Run record

`npm run bench:context` writes one create-only JSON record to `benchmarks/context/results/<run-id>.json`:
benchmark and grader versions, a hash of the benchmark source, the product version, the git commit and whether
the tree was dirty, runtime and machine, the retrieval configuration, validity, the grader self-check, a
per-family summary, and every case with its outcome, metrics and a hash plus a short excerpt of the graded text.

## How later stages use it

A later stage counts as better only when the number of passing cases rises and **no family's pass count
falls**. Token counts are reported next to outcomes; a smaller prompt never outranks a more correct one. If a
stage does not beat the baseline, record 50 keeps the simpler code.
