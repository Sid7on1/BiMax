# RAG/context audit evidence — 2026-09-14

Supports [record 47](../../../47_RAG_AND_CONTEXT_COMPILER_UPGRADE.md).

## What ran

- `bun docs/product-reset/competitive/evidence/2026-09-14-context-audit/probe.ts`: eight synthetic limitations reproduced against actual local modules; `results.json` and `probe.log`. Bun version: 1.3.14. The JSON runtime field comes from `process.version` and is Bun's Node compatibility value, not the Bun version.
- Six existing Jest suites: 56 tests passed; `existing-tests.log`.
- Initial `tsx`/Node probe: FTS5 unavailable, invalidating two SQLite-dependent probes; preserved as `node-results.json` and `node-probe.log`. Do not combine that run with Bun's results or treat unavailable FTS as a retrieval score.
- Primary paper methods and selected upstream implementation files were read. `upstream-index.json` records pinned commits, licenses, fetched paths and hashes. Temporary inspection paths are not durable artifacts; pinned URLs and hashes identify the files. No upstream code was executed or incorporated.

Run existing checks from the workspace root:

```sh
./node_modules/.bin/jest --runInBand --coverage=false src/__tests__/memory.retrieval.test.ts src/__tests__/memory.recall.test.ts src/__tests__/context.layers.test.ts src/__tests__/context.planner.test.ts src/__tests__/context.longrun.test.ts src/__tests__/code.search.tool.test.ts
```

The harness asserts current defects and will need conversion when they are fixed. A reproduced status is not an acceptance pass. It uses temporary synthetic files, local stores, and a fake summary model; provider calls were zero. Source hashes in `results.json` identify ten runtime modules. The harness cleans its temporary fixtures.

## Limits

No implementation was changed. No representative quality, latency, cost, memory, live-provider, or packaged-product evaluation ran. There are no mutation-qualified acceptance claims from this audit. The report specifies positive controls and mutants for the implementation phase. Existing tests passing does not invalidate the newly reproduced cases.
