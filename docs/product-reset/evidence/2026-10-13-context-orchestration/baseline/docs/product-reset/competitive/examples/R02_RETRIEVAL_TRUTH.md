# R02 — Retrieval Truth Across Restart and Provider Boundaries

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
