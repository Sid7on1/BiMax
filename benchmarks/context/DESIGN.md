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

## Version 2 (2026-09-14)

Audit 51 (U09) showed version 1 passing broken code: B1 trusted each pack's own `tokenEstimate` and counted
an error as staying within budget, and C3, C4, SC2 and SC4 checked only that stale or out-of-scope text was
absent, which a search returning nothing satisfies. In `context-bench@2` with `context-graders@2`:

- B1 measures every pack from its text under the planner's declared estimator (four characters per token),
  requires a pack holding the target at each feasible budget, and requires a worded refusal at 10 tokens.
- C3, C4 and SC2 pair the negative check with a positive one from the same index: the live file, the new text,
  and the sibling found without the scope. SC4 needs some term of the partial index to be found.
- Three mutants now fail cases that passed them before: a pack that lies about its size (B1), a planner that
  always errors (B1, M3), and a search that always returns nothing (C3, C4, SC2, SC4 among others).

Scores from version 1 and version 2 are not compared with each other. Version 2's baseline is re-run on the
same code before any fix is measured against it.

## Version 3 (2026-09-14)

Nine cases for the rest of record 50, added before any of that work so each starts from a measured baseline. Version 2
and version 3 scores are not compared with each other.

- **Held out for step 7 (H1–H4).** Written before step 7 and never tuned against: a question no note answers (H1), a
  control that a note which does answer is still injected (H2), and two repositories shaped differently from M1 and
  M2 (H3 billing, H4 upload limit). A step 7 change that passes S5, M1 and M2 but not these has fitted the fixtures.
- **The request boundary (R1, R2).** One turn runs through the real `AgentLoop` with a model that records each request.
  R1 measures the request as sent (system prompt, tool schemas and every message) with a real tokenizer against the
  window. R2 gives a system prompt larger than the window: nothing may be sent, and the turn must say why.
- **Logs (N6).** A 400-line log with three failures is compacted; what stands in its place must give the line count,
  the failures and a handle to the raw output.
- **Workspace (A1).** A question about a 2,000-line archived output must be answered by searching it, with line numbers,
  in under 1,000 characters.
- **Continuity (L5).** A context manager rebuilt mid-task, as on a model switch, must still carry the user's constraint.

## How later stages use it

A later stage counts as better only when the number of passing cases rises and **no family's pass count
falls**. Token counts are reported next to outcomes; a smaller prompt never outranks a more correct one. If a
stage does not beat the baseline, record 50 keeps the simpler code.
