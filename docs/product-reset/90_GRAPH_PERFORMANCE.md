# Measured graph performance improvements

2026-10-13. **Implemented**: batch graph-node removal and an indexed FIFO for impact traversal.
**Measured**: paired local graph-operation timings below. Installed task latency, startup, application
peak RSS, energy, sustained thermals, live-model quality, full journeys and competitive Win remain
**Target/unmeasured**. No CU implementation, UI design, provider, dependency or install change.

## Baseline and changes

The exploratory baseline found 1,000 adjacency rebuilds when removing 1,000 file-owned symbols,
and repeated `Array.shift` while traversing a 50,000-node wide graph. Baselines are frozen from the
starting working tree, including record 89's freshness fixes; they are not falsely labelled as
committed HEAD. `initial-dirty-hashes.json` records all 517 already dirty files before this pass.

1. `GraphStore.removeNodes` makes one removal set, deletes nodes, filters touching edges once and
   rebuilds both adjacency directions once. `SqliteGraphStore.removeFileNodes` uses that batch;
   single-node removal delegates to the same primitive. Exact ownership, edge/node order, surviving
   metadata, revision invalidation and deferred deletion-hash publication remain intact.
2. `ImpactEngine.traverse` reads FIFO IDs by cursor, tracks depth through layer boundaries, clears
   each consumed ID, and compacts after 1,024 consumed slots only when at least half the array was
   consumed. Copied retained IDs are amortized linear; queue slots remain O(live frontier + 1,024).
   It allocates no separate depth object for each discovered node. Forward/reverse order, cycles,
   unknown nodes and negative/fractional/non-finite depth behavior match the frozen implementation.

The chain-memory fixture observes cleared consumed IDs, at most 1,025 queue slots for a one-node
frontier and linear copies over 10,000 nodes. This is a retained-reference/slot bound, not a measured
application peak-RSS claim. The batch fixture independently verifies both adjacency directions,
PageRank invalidation and the exact sequential-removal end state.

## Paired timings

Apple M3 / 8 cores / 8 GiB / arm64 / Node v22.13.1. Four warmups, eleven paired AB/BA repetitions,
explicit GC before each timed operation, zero discarded timings within each run, no parallel tests
or builds. Fixture creation and result assertions are outside timed intervals. Every result matches
the frozen baseline; hashes and all raw p50/p95 samples are in `graph-benchmark.json`. Removal uses
an in-memory SQLite graph, including its hash-row delete; disk persistence is not timed.

| Operation / shape | Nodes | Removed symbols | Before p50 / p95 ms | After p50 / p95 ms | p50 ratio |
|---|---:|---:|---:|---:|---:|
| bfs / wide | 1,000 | 0 | 0.2931 / 0.4151 | 0.2098 / 0.4184 | 1.40× |
| bfs / wide | 10,000 | 0 | 4.5284 / 4.7645 | 1.7895 / 1.8453 | 2.53× |
| bfs / wide | 50,000 | 0 | 168.8571 / 170.4983 | 7.7473 / 8.3294 | 21.80× |
| bfs / chain | 1,000 | 0 | 0.2256 / 0.4368 | 0.2101 / 0.3892 | 1.07× |
| bfs / chain | 10,000 | 0 | 2.0008 / 2.1228 | 1.7818 / 2.1328 | 1.12× |
| bfs / cycle | 10,000 | 0 | 2.0974 / 2.2213 | 2.0904 / 2.2914 | 1.00× |
| remove / cycle | 1,000 | 100 | 10.9745 / 13.0638 | 0.3788 / 0.6010 | 28.97× |
| remove / cycle | 4,000 | 1,000 | 480.7732 / 486.1043 | 1.3914 / 1.5325 | 345.53× |

The 50k wide traversal is 168.8571 → 7.7473 ms p50 (21.80×). The 4k-node/1k-symbol deletion is
480.7732 → 1.3914 ms p50 (345.53×), with 1,000 → one adjacency rebuild. Small cases and chain/cycle
results are all reported; tiny differences are sensitive to JIT, scheduling and GC. These component
ratios do not imply equivalent installed-app or total-task acceleration.

Two preliminary frontier-array implementations are retained with their timings. They improved wide
graphs but regressed narrow/cyclic cases, prompting the final compacting FIFO. They are development
stages, not independent repetitions of the final version; no earlier stage is silently discarded.

## Heap investigation rejected

A monotonic-prefix/ring selector retained at most k entries and fell back to the original heap at
an order break. It passed 10,800 prefix comparisons against stable full sorting, capacity checks,
snapshot independence and monotonic comparison bounds. Both trial versions' full sixteen-case
ABC/CBA timing artifacts and sources remain in this evidence directory. The actual script
uses alternating ABC/CBA for heap/candidate/full-sort, four warmups and eleven repetitions.

The second version improved N=100k ascending scores from 13.3054 to 4.4866 ms, but random input
regressed 3.1594 → 4.3883 ms and tied input 3.6515 → 4.4951 ms. It is **rejected**. Production
`bounded.top.k.ts` stays byte-identical to the starting source. A faster ordered-input path without
material general-input regressions remains Target; correctness alone is insufficient for adoption.

## Verification and remaining work

Six new tests qualify graph results, batch rebuild count, cache invalidation, FIFO order/depth,
cycles and queue-retention bounds. Eight deliberate source faults must fail assertions and restore
exact bytes; the restored baseline must pass. Prior graph freshness/deletion/real-SIGKILL fixtures
remain in the full suite. No assertions are weakened and no tests are skipped to reach green.

Final checks pass: 4,256 Jest tests (19 existing skips), 133 Bun tests, three script tests,
root/app typechecks and builds, zero lint errors (1,823 warnings), eight assertion-caught source
faults and seven real staged-engine MessagePort exchanges. The initial 517 dirty files are preserved:
510 byte-identical; five added documentation sections and frozen baselines for two intentionally
optimized sources preserve the other seven.

Final local validation, command exits and hashes are in `verification.json`, `source-hashes.json`
and `manifest.json`; dirty preservation is checked separately. Work remains local and uncommitted.
No hosted CI, installed app upgrade, live model, network quality or competitive qualification is
claimed. Full-repository indexing/refresh traces, startup, actual task latency, peak memory/energy,
concurrent refresh, single-symbol removal cost and large multi-file publication remain Target. This is a scoped continuation
of the unfinished algorithm inventory, not an exhaustive review.

Guidance: product-reset README; current audit 01, architecture 05 and topology 06 (current monolith
records supersede historical split passages); acceptance 08; Mac Buddy vision and V03/V27B cards;
competitive README/02/04/05/06/07, C01 dirty-repo preservation and R02 retrieval truth. The capability
matrix file remains absent. Fresh primary references and decisions are in `research.json` and the
source ledger. No upstream implementation or library was imported.
