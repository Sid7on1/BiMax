# Compiler state lifetime and idle indexing memory

2026-10-13. **Implemented**: TypeScript compiler state belongs to the current extraction call,
not the long-lived `StaticAnalyzer`. **Measured**: post-GC heap growth in owned local compiler
fixtures. Installed Bimax application RSS, peak memory, energy, startup, task latency, full journeys
and competitive Win remain **Target/unmeasured**. CU/UI, dependencies and installation are untouched.

## Finding and change

`StaticAnalyzer.typeChecker` retained the latest checker after project indexing, single-file parsing,
shared-snapshot refresh and failed source lookup. This kept compiler source/semantic state alive
between operations even though subsequent refreshes always construct a new Program. The baseline
profile's 200-file project freed about 53 MiB after deleting that otherwise unused field.

The field is removed. Full and single-file extraction pass their local checker directly to
`extractEdges`, including the temporary replacement analyzer. Semantic resolution still uses the
same fresh Program/checker; the indexer still shares one caller-owned Program across its bounded
changed-file batch. No production forced GC, compiler cache, parse-policy or graph-publication change. A separate
deadline settlement correction found during full regression validation is described below.
Normal stack unwinding releases compiler ownership on success and errors without extra cleanup hooks.

The starting working tree, including records 89–90, is frozen for the analyzer, graph store and
file publication. `initial-dirty-hashes.json` covers 551 pre-existing dirty/untracked files. This
baseline is not committed HEAD.

## Measurements

Apple M3 / 8 cores / 8 GiB / arm64 / Node v22.13.1 / TypeScript 5.9.3. Each generated file defines
12 functions, local variables and cross-file calls; normal ES2022 library declarations are loaded,
ambient `types` are disabled. Full fixtures publish 1,239 / 12,399 graph nodes and 1,977 / 19,797
edges. A batch extracts the first 20 files with one shared snapshot; a single-file case extracts
one, and missing-source cases publish nothing.

Five paired AB/BA repetitions per case, each in an independent fresh Node process; 80 samples,
zero discarded, no parallel tests/builds and no warmups. Module loading and fixture creation are
excluded. After extraction, four event-loop jobs each perform explicit GC, with the graph/analyzer
kept live and exercised afterward. Values below are **heapUsed growth over the pre-index baseline**,
not total process memory, peak RSS or installed-app measurements. Raw heap/RSS/external figures,
all timing samples, exact graph hashes and environment are in `benchmark.json`.

| Files / operation | Before retained heap MiB p50 | After MiB p50 | Before extraction ms p50 | After ms p50 |
|---|---:|---:|---:|---:|
| 20 / full | 45.94 | 3.03 | 175.32 | 181.04 |
| 20 / single | 44.55 | 1.69 | 161.49 | 161.15 |
| 20 / shared batch | 45.93 | 3.03 | 183.44 | 185.26 |
| 20 / missing source | 44.38 | 1.55 | 163.98 | 163.64 |
| 200 / full | 65.40 | 11.24 | 280.54 | 284.61 |
| 200 / single | 55.72 | 1.96 | 204.02 | 209.53 |
| 200 / shared batch | 57.12 | 3.28 | 226.18 | 232.21 |
| 200 / missing source | 55.57 | 1.81 | 205.96 | 201.15 |

The 200-file full index retains 54.16 MiB less heap (about 83% less growth). Extraction timings
are roughly unchanged, with small regressions and improvements all retained; this is a memory
adoption, not a speed claim. Timers exclude GC and disk persistence. All before/after graph hashes
match for each case. No provider/model is involved.

`benchmark.initial.json` preserves the first complete run and `compiler-memory.initial.cjs` its
sampler. That sampler ran four GCs in one job after a single yield; a small full-index case retained
transient compiler state until the next job. Direct follow-up collection, without a production
change, identified the sampling limitation. The final sampler yields before every GC. Both runs,
the exploratory profile and every sample remain evidence; they are separate measurement stages.

## Contracts and qualification

Ten new tests cover collection after full/single/shared/repeated extraction, missing source,
checker failure, publication failure and project extraction failure. Real isolated Node processes
observe weak references to Programs, checkers and source ASTs becoming empty while the graph/analyzer
remain alive. Shared-snapshot checks also prove caller ownership persists between files, then ends
when the caller releases it. GC is enabled only for these test processes.

Exact graph comparison against the frozen analyzer covers methods, calls, imports, variable uses,
shared events and reversed file-refresh order. Graph traversal, ranking, SQLite read-back and fresh
retry after failed publication remain correct. Eight deliberate source faults retain compiler
objects or remove semantic/publication results; every fault must fail an assertion, restore exact
source bytes and leave the restored ten-test baseline passing. `scripts/prove-compiler-lifetime.py`
records that proof. Prior freshness/SIGKILL and graph-operation fixtures remain in regression checks.

## Deadline failure found during regression checks

The initial full Jest run passed 4,265 tests and failed one existing MCP timeout assertion: the SDK
returned its generic timeout instead of the named Bimax deadline error. Its isolated 15-test suite
passed unchanged. No MCP implementation or existing assertion is modified.

A deterministic fake-clock check independently reproduced an overdue operation settling before its
delayed deadline timer, both with a late success and a late SDK error. The new check failed twice
against the starting source (`deadline-red.log`). `withRequestDeadline` now checks its remaining
budget when the operation resolves or rejects, preserving early error identity and Stop reason.
This closes an absolute-deadline gap under an event-loop stall; it does not establish that every
possible SDK timing race is eliminated. Four new tests and three assertion-caught/restored source
faults qualify this addition. Focused MCP/deadline tests pass (`deadline-green.log`).

Final local checks: 4,270 Jest tests pass (19 existing skips / one skipped suite), three script
tests pass, root TypeScript build, app typecheck/build, staged engine build and seven actual
MessagePort exchanges pass (46,636 bytes outbound). Lint has zero errors and 1,824 warnings.
Fourteen added tests and eleven source faults are qualified. Command exits, including failed
attempts, are retained in `verification.initial.json`, `verification.json` and the named logs.

**The complete offline gate is not green:** Bun passes 132/133 tests. The unchanged native Vision
OCR fixture recovers both required text facts but returns mean confidence 0.5 against its existing
`> 0.5` assertion. It fails identically in an isolated rerun (12/13 tests pass); no assertion or OCR
source is changed. This is an unresolved document-OCR qualification failure outside the changed
compiler/deadline paths, not a discarded run. Neither this performance pass nor the app is declared
release-qualified. `full-bun.log` and `ocr-isolated.log` retain both failures.

Dirty preservation: 545 of the initial 551 files are byte-identical. Five documentation additions
reconstruct their exact starting bytes; the intentionally changed analyzer is frozen exactly.
The previously clean deadline source is frozen too. `dirty-preservation.json`, `owned-paths.json`,
`source-hashes.json` and `manifest.json` record this boundary; unrelated CU/UI and prior evidence
bytes are preserved. No user model/config mutation is part of these fixtures.

Guidance: product-reset README, audit 01, architecture 05, topology 06 (current monolith records
supersede historical split passages), acceptance 08; Mac Buddy vision performance/hardware sections;
V03 and V27B cards; competitive README/02/04/05/06/07, C01 dirty preservation and R02 retrieval truth.
`competitive/03_CAPABILITY_MATRIX.md` remains absent. Current first-party Compiler API, Node memory/timers
and V8 GC references/decisions are in `research.json` and the source ledger.

Large multi-file graph publication still copies/rebuilds the graph per file; this pass does not
change those ordering/failure semantics. Full persistence/discovery traces, caller reanalysis,
concurrent refresh/root changes, installed latency, peak/sustained RSS, energy and Intel qualification
remain Target. A generated compiler fixture does not qualify C01/C04/R02 end to end or Product-ready.
Work is local and uncommitted; no push, hosted CI or release claim.
