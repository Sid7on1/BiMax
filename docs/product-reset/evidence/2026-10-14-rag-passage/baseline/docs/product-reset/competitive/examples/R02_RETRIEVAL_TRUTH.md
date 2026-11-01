# R02 — Retrieval Truth Across Restart and Provider Boundaries

## Answer-evidence qualification — 2026-10-14, record 97

[Record 97](../../97_RAG_ANSWERING_EVIDENCE.md) measures a rejected excerpt prototype: classic LongMemEval 43→64/100, MemoryAgentBench custom judge 51→45/100 on fresh paired 100+100 questions. All 400 arms/raw messages/verdicts/model identity/usage and 2,896 source spans are audited. The global adoption rule fails; the production source is restored, with 32 existing recall/RAG tests passing. Ten proposed tests and nine source-fault receipts remain with the archived candidate; do not weaken their assertions or present prototype checks as active product qualification. Explicit archived-source re-audit must match the original model configuration hash; five altered observations must fail assertions. Benchmark atomic receipts require five focused end-state/process-death checks and a direct-overwrite fault. Preserve every wrong valid answer, declining family and token/CPU cost. This does not qualify installed live-code/reranker R02, independent judging, release or Win.

## Resource and public-memory qualification — 2026-10-14, record 96

[Record 96](../../96_RAG_RESOURCE_AND_PUBLIC_QUALIFICATION.md) requires enough primary documents to avoid a second ranking pool, cached dense champion reuse, primitive positional ownership with zero/rebuild/duplicate compatibility, and unchanged ordered IDs/prompts/provenance. Run the seven resource tests beside fourteen RAG tests; `scripts/prove-rag-resources.py` must catch all 19 source faults and restore exact bytes. Qualified ABBA/fresh-process heap fixtures remove record 95's small dense/heap costs, while all shapes/regressions remain evidence. The fixed public-memory subset completes 200/200 equal prompts, valid provenance and model answers with real local embeddings. Owner-authorized configured Nemotron 3.5 Lightning follows preserved gpt-oss-20b failures and a power shutdown: 40/100 classic judged answers and 39/100 MemoryAgentBench custom judged answers. Classic source Recall@3 94.06% is not answer accuracy; answerable accuracy is 26/85. Audit every raw prediction/verdict, frozen hash, per-family denominator, truncation and retry; retain wrong valid answers and retry only invalid observations. No accuracy-gain claim follows from shared identical prompts. This bounded memory component does not qualify the live-code embedding/reranker journey below, installed full R02, rival comparison or release.

## Memory document coverage and prompt evidence — 2026-10-14

[Record 95](../../95_RAG_EVIDENCE_AND_RETRIEVAL_WORK.md) requires long documents not to consume every returned source slot, while preserving scope/floor, successful prefix and bounded reranker requests. Later sources receive useful prompt room; tiny budgets keep the best source. Replacement/external deletion must invalidate chunk lookup; vocabulary scopes and coalesced recency still hold. Run `src/__tests__/rag.sprint.test.ts`, `node --test scripts/rag-fixture-grader.test.cjs`, `scripts/prove-rag-work.py`, existing retrieval suites and the unchanged version-4 context benchmark. Generated Recall@3/prompt completeness and warm timings qualify local memory-RAG behavior only. Public benchmarks, independent heldout queries, real semantic stages, model answers and installed full R02 remain Target. The pre-existing desktop pairing-IPC security-test failure is recorded separately and must not be hidden by weakening its guard.

## Context work equivalence — 2026-10-13

[Record 94](../../94_LESS_CONTEXT_WORK.md) adds exact prompt/archive equivalence against frozen record-93 source, including custom JSON behavior, Unicode, retention boundaries and non-destructive small rendering. The twelve optimization source faults and rechecked twenty-six context-boundary faults must fail assertions and restore exact bytes. Performance can improve only while record-93 residency, budget, Stop and atomic history contracts remain intact. Official context benchmark version 4 stays at 43/43 with no family decline; provider answers and installed latency remain Target.

## Context boundary qualification — 2026-10-13

[Record 93](../../93_CONTEXT_ORCHESTRATION.md) requires real prompt text before reporting an evidence span as resident: an archive handle or a matching file path alone is insufficient, and a derived block cannot make an absent dependency resident. Stale spans remain excluded. Code-search import relationships show both endpoints even when ranking returns the importer first. Run the new context orchestration suite, `npm run test:context`, benchmark version 4 and the source-fault runner. These offline end states do not qualify live semantic quality, installed journeys or model answers.

## User-language contract

> “Find the code that implements this behavior even if I do not know the identifier. Do not send
> my source to a remote provider unless I explicitly enabled that, and do not tell me semantic
> search is healthy unless the provider-backed stages actually retrieved the expected code.”

## Product boundary

- Bimax Terminal owns repository indexing and retrieval.
- Local FTS5/BM25 indexing is enabled by default.
- Remote code embeddings and reranking are disabled by default. They require
  `codeIndexRemoteEmbeddings: true` or `BIMAX_CODE_INDEX_REMOTE=1`.
- This journey does not add Computer Use ownership to Terminal.

## Deterministic local acceptance

The focused Jest journey must prove:

1. a first launch creates the nested SQLite parent and stores searchable chunks;
2. a restart reloads the same chunks without re-indexing unchanged files;
3. a refused capacity write remains pending and does not advance the manifest;
4. changing embedding space makes old vectors pending and backfills the active space;
5. an exact identifier in a long source chunk is returned keyless;
6. dense-only retrieval abstains below its cosine floor;
7. a session `cwd` change resolves a different project index;
8. multiple recency updates inside one coalescing window all persist.

Command:

```sh
npx jest --coverage=false --runInBand \
  src/__tests__/sqlite.persistence.test.ts \
  src/__tests__/code.search.tool.test.ts \
  src/__tests__/memory.store.features.test.ts
npm run test:bun
```

Mutation obligations: removing parent-directory creation, removing `iterate()` from the Bun
adapter, making pending-space SQL ignore `space`, advancing the manifest after a refused write,
restoring length-divided lexical filtering, removing the dense floor, ignoring `context.cwd`, or
discarding unflushed recency must fail at least one test above. The corpus benchmark also excludes
its own labelled questions and stand-in implementation to prevent target leakage, bounds the dense
tail before fusion, and fuses reranker order with first-stage order instead of treating it as an
oracle.

## Graph freshness qualification — 2026-10-13

[Record 89](../../89_GRAPH_FRESHNESS_AND_LINT.md) adds a local graph contract: exact per-file
replacement, surviving incoming references, same-size/restored-mtime detection, source-race and
failed-parser retry, TS/Python rename discovery, old-schema migration, revision-safe cache identity
and bounded compiler construction. Run `src/__tests__/graph.freshness.sprint.test.ts` under Jest;
`scripts/prove-graph-freshness.py` must catch all fourteen source faults and restore exact bytes.
A real SIGKILL fixture proves graph-checkpoint recovery only. Live semantic quality, installed
journeys, large-directory cost and full task crash/resume remain Target.

## Graph operation performance — 2026-10-13

[Record 90](../../90_GRAPH_PERFORMANCE.md) adds exact-output and operation/queue-retention gates
for batch file invalidation and impact traversal. `src/__tests__/performance.sprint.test.ts` runs
under Jest; `scripts/prove-performance.py` must catch eight source faults and restore exact bytes.
Paired component timings preserve all input shapes and rejected strategies. Installed retrieval
latency, startup, sustained RSS/energy and live semantic quality remain Target.

## Compiler lifetime contract — 2026-10-13

[Record 91](../../91_COMPILER_STATE_LIFETIME.md) adds real compiler-object collection contracts
for full/single/shared/repeated extraction and errors, with exact semantic graph, consumer,
SQLite read-back and retry checks. Run `src/__tests__/compiler.lifetime.sprint.test.ts` under Jest;
`scripts/prove-compiler-lifetime.py` must reject eight source faults and restore exact bytes.
Paired generated-project measurements qualify retained heap growth only; installed memory/latency,
large publication, live semantic quality and full R02 remain Target.

## Indexing work and signature-retention contract — 2026-10-13

[Record 92](../../92_LESS_INDEXING_WORK.md) preserves the exact ordered discovery/threshold result
and all source-span/signature text, including UTF-16 edge cases, while bounding first-segment work
and releasing large declaration bodies. Run `src/__tests__/indexing.work.sprint.test.ts`; the
real-process eight-MiB fixture must release the source text with its graph/analyzer still usable.
`scripts/prove-indexing-work.py` must reject ten source faults and restore exact bytes; prior
compiler-lifetime faults are rechecked. Phase timings/heap growth do not qualify installed latency,
RSS/energy, general native OCR, live semantic quality or full R02.

## Live-provider acceptance

Live-provider quality remains **Target** until an assertion-based artifact passes. Run:

```sh
BIMAX_RETRIEVAL_EVIDENCE_DIR=/absolute/immutable/run-directory \
NVIDIA_API_KEY=... \
npx tsx scripts/live-retrieval-run.ts
```

The runner exits non-zero unless all of these are true:

- every controlled intent query contains its expected source file in top-3;
- every query reports dense and reranked stages as actually active;
- all fixture chunks have vectors in the active model space;
- the paraphrase/unrelated cosine margin is at least `0.05`;
- the reranker control ranks the paraphrase first;
- a create-only JSON artifact records timestamps, source/script hashes, model-space IDs, timings,
  actual hit paths, stage modes, margins, and failures without recording keys or source text.

A console transcript, HTTP 200, one successful query, or an artifact with `status: fail` does not
upgrade this journey to Measured or Product-ready.

## Current status

- Local implementation and regression journey: **Implemented**; locally verified on 2026-08-17.
- RAM ledger and hand-labelled stand-in corpus: useful engineering measurements, not live quality
  or rival-comparison proof.
- Live-provider journey: **Target** until a preserved passing artifact is reviewed.
- Rival head-to-head retrieval comparison: **Target**.
