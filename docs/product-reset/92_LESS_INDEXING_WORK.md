# Less indexing work without changing graph results

2026-10-13. **Implemented**: set-based new-path membership, first-segment-only signatures and
bounded UTF-16 copies for signatures of large declarations. **Measured**: owned offline indexing
phases and post-GC retained heap on Apple M3 / 8 cores / 8 GiB / arm64 / Node v22.13.1 / TS 5.9.3.
Installed application latency/RSS/energy, startup, sustained resource budgets, complete journeys
and competitive Win remain **Target/unmeasured**. No CU/UI, dependency, provider or install change.

## Findings and preserved behavior

1. Discovery appended new paths to `changed` and used `changed.includes` for each candidate. The
   array therefore became a growing linear lookup before the full-index threshold could even be
   checked. An ephemeral Set now supplies membership, alongside the same ordered array. Existing
   changed entries (including duplicates), known-path filtering, new-path order, parser calls,
   failure/hash fences, threshold and full-index behavior remain unchanged. The Set costs
   O(changed paths) extra temporary membership storage; it is not a new retained cache.
2. `locOf` split every line of a function/class body to keep its first line. `split('\n', 1)` now
   requests only that segment from the same node text. LF-only splitting, whitespace trimming,
   inclusive 1-based positions and the 200 UTF-16-unit cap remain exact, including CR-only,
   CRLF, Unicode line separators, minified code, lone surrogates and a truncated surrogate pair.
3. A short sliced signature kept an eight-MiB source body alive even after compiler objects were
   collectible. For declarations larger than 4,096 UTF-16 units, the final <=200-unit signature
   is copied through UTF-16LE (at most 400 payload bytes). This avoids retaining that large body
   through this signature. It adds bounded CPU/allocation cost; it is not a claim that all graph
   strings are detached. Shorter declarations and other graph strings remain further work.

The baseline is the actual starting working tree, including record 91's compiler lifetime/deadline
fixes and records 89–90's graph results. Six starting sources are frozen; `initial-dirty-hashes.json`
covers 583 pre-existing dirty/untracked files. Prior successful behavior is tested against this
baseline instead of reverting to committed HEAD. No graph-publication/batch ownership change.

## Paired phase costs

Three warmups and eleven AB/BA paired repetitions per case, explicit GC before operations, zero
discarded samples, no parallel builds/tests. Creation, assertions and module loading are excluded.
Discovery runs the real `refreshStale` control flow with owned candidates and isolated parser/disk
work; full-index dispatch is graded separately. Project cases run real TypeScript Program creation
and graph extraction on generated files, without disk persistence. Signature cases repeat the same
real parsed symbol 200 times. Exact before/after graph/path hashes match in all cases.

| Case | Before p50 ms | After p50 ms | Ratio |
|---|---:|---:|---:|
| Discovery 100 paths / new + duplicates | 0.2745 | 0.0867 | 3.17× |
| Discovery 1,000 paths / new + duplicates | 6.3318 | 0.6865 | 9.22× |
| Discovery 10,000 paths / new + duplicates | 573.0603 | 6.5328 | 87.72× |
| Discovery 10,000 paths / unchanged | 6.2218 | 6.2212 | 1.00× |
| 200 signatures / 10-line body | 0.1210 | 0.1530 | 0.79× |
| 200 signatures / 1,000-line body | 2.2911 | 0.2568 | 8.92× |
| 200 signatures / 10,000-line body | 22.6603 | 0.1860 | 121.80× |
| Project 20 file(s) / 10 body lines each | 3.8121 | 3.6178 | 1.05× |
| Project 1 file(s) / 10,000 body lines each | 51.3143 | 50.3314 | 1.02× |
| Project 20 file(s) / 1,000 body lines each | 89.4555 | 89.5151 | 1.00× |

`benchmark.json` retains p95 and every raw sample. Discovery at 10k paths drops roughly 573 → 6.53 ms
(87.72×). The long-symbol component drops 22.66 → 0.186 ms for 200 signatures (121.80×). The small
signature component regresses 0.121 → 0.153 ms per 200 calls; that bounded-copy/check tradeoff is
reported, not hidden. Full project cases improve slightly or remain effectively unchanged. These
ratios do not describe installed-app or whole-task acceleration.

## Retained heap and earlier candidates

Five paired AB/BA repetitions per case in independent Node processes, no warmups or discarded
samples, and four event-loop jobs each forcing GC after extraction. Graph/analyzer stay alive.
A one-function source contains 1 / 8 MiB of comment padding, producing only a small graph. The
post-GC heap growth over the pre-index baseline is:

| Source padding | Before MiB p50 | After MiB p50 |
| 1 MiB | 1.089 | 0.086 |
| 8 MiB | 8.089 | 0.086 |

`signature-retention.json` contains every sample and exact graph hashes. A real-process assertion
requires the eight-MiB fixture to retain less than two MiB while its graph/analyzer remain usable;
removing the bounded copy fails that assertion. The ordinary 200-file full/shared-batch cases are
also rechecked against the starting record-91 implementation in `compiler-memory-recheck.json`:
full: 11.243 → 11.237 MiB; batch: 3.271 → 3.276 MiB; differences are small. None of these is peak RSS, total installed RAM or energy.

An unbounded whole-source newline-search candidate was rejected by inspection before timing.
A bounded source-view candidate preserved results and ordinary memory, but both it and the original
retained the large padded source. All intermediate sources/timings are retained in the named
`candidate.*`, `benchmark.initial.json`, `benchmark.bounded-view.json` and `*.bounded-view.json`
artifacts. The initial small-project +0.29ms regression prompted further inspection. The adopted
limited split is simpler and additionally frees the large body's text via a bounded copy.

## OCR investigation, without changing recognition evidence

An instrumented frozen native helper ran against the owned report fixture. Accurate recognition
returned all eight lines at mean confidence 1.0; fast recognition returned eight lines at 0.5 with
character errors. Record 91 retains the two earlier failures when the fallback won. The current
read is an observed positive attempt, not a repaired recognizer or repeated reliability result.
No OCR source, selection policy or confidence assertion is changed. Raw per-pass text/geometry/
confidence, fixture bytes and final output are under `ocr-profile.*` / `ocr-fixture/`; no private
user document or live provider is involved. General native OCR reliability remains Target.

## Qualification

Twenty-one new tests grade exact source spans/text, bounded splitting and file ownership, discovery
ordering/duplicates/threshold, one parse per new file, persisted restart and large-body release.
Ten new source faults fail assertions, restore exact bytes and leave the restored baseline passing;
eight prior compiler-lifetime faults are rechecked against the final source. Existing graph
freshness, SIGKILL, traversal/removal, caches, deadlines and compiler-sharing tests remain intact.

Exploratory evidence is explicitly unqualified where appropriate: one new array assertion included
its own spy property; it now compares all ordered elements and separately asserts call count.
An early mutation attempt hit a typed String.split test-helper compilation error. Those are invalid
mutation kills; logs/source restoration and the later valid assertion-based proof are retained.
No existing assertion is loosened, skipped or deleted.

Final local validation passes: 4,291 Jest tests / 449 passing suites (19 existing skipped tests /
one skipped suite), all 133 Bun tests, three script tests, root TypeScript build, app typecheck/build,
zero lint errors (1,825 warnings), staged engine build and seven real MessagePort exchanges
(46,637 bytes outbound). `verification.json` records all ten final command exits. The unchanged
native OCR assertion passes in this full Bun attempt; earlier failures in record 91 remain valid
and general recognizer reliability is still Target. A single later pass does not repair or erase them.

Ten final new source faults and eight final prior-lifetime rechecks are assertion-caught with exact
restoration; both restored baselines pass. `mutations-final/results.json` and
`compiler-mutant-recheck-final/results.json` qualify those eighteen checks. Other intermediate and
invalid proof directories are separately named and are not substituted for this final evidence.

Dirty preservation and final source/artifact hashes are recorded in `dirty-preservation.json`,
`owned-paths.json`, `source-hashes.json` and `manifest.json`. Six starting source snapshots preserve
exact prior behavior; unrelated dirty files, CU/UI, prior evidence and git staging are preserved.
The production changes do not edit model/config. This is local implementation/measurement qualification, not Product-ready/release or Win.

Guidance: product-reset README; audit 01, current architecture 05 and topology 06 (records 55/64/79
supersede historical split/retirement passages); acceptance 08 and PDF record 74; Mac Buddy vision,
V03/V27B research cards; competitive README/02/04/05/06/07 and C01/R02 contracts. The referenced
capability matrix is still absent. `research.json` and the source ledger record ECMAScript Set/split,
Microsoft Compiler API, Node Buffer encodings and inspected Apple Vision SDK/API evidence. No
upstream implementation, dependency, compiler/runtime version upgrade or competitive claim.

Large multi-file publication, full discovery/persistence traces on the user's repository, dependent
caller reanalysis, simultaneous refresh/root changes, smaller-declaration/string retention, native
OCR reliability, installed performance, Intel, sustained RSS/energy and release remain Target.
Work stays local and uncommitted; no push or installed app replacement.
