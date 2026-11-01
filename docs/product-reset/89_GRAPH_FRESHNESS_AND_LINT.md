# Graph freshness, bounded compiler work and lint repair

2026-10-13. **Implemented and locally verified**: exact file replacement, fresh graph-derived
caches, source-identity checks and shared compiler snapshots. This is a bounded continuation of
[record 88](88_ALGORITHM_AUDIT_AND_UPGRADE.md), not completion of the exhaustive algorithm audit.
CU implementation, UI design, the installed app and unrelated unfinished work stay outside scope.

## Findings and changes

| Inspected area | Before | Result |
|---|---|---|
| SQLite source staleness | Same-size edits with restored mtime escaped the stat fast path | Persist ctime, migrate old rows with NULL, hash suspects, rebaseline identical touches; read/status failures do not establish deletion |
| File replacement | Substring IDs could remove `a.ts.extra.ts` while replacing `a.ts`; repeated node removals repeatedly rebuilt adjacency | Match file ownership, prepare replacement separately and publish one graph; preserve foreign incoming edges whose exact targets survive |
| Failed parsing | Missing TS input returned after deleting old nodes; unavailable Python parsing could certify an empty replacement | Failed/unavailable parsing retains the last good graph and hash baseline for retry; Python parsing explicitly reports admission |
| New and renamed paths | Hash comparison only visited previously indexed paths | Discover configured TS/JS and supported Python paths without extracting unchanged ASTs; prune deleted paths and index renamed destinations |
| Source changing during refresh | Hashing after parsing could stamp old graph data with newer source bytes | Capture source identities before the compiler snapshot and compare again before hash publication; raced inputs stay pending |
| Repeated compiler work | Each changed TS file constructed a full Program | One fresh Program per bounded batch; no Program on unchanged refresh; a new snapshot on each changed refresh |
| PageRank/outline memoization | Equal-count republished graph edits escaped shape checks; cache hits still enumerated every node | Store mutation revision plus graph/shape identity; return cached rankings before enumeration |
| Outline cache identity | Comma-joined focus terms and absent/empty headers collided | Structured keys distinguish focus arrays, empty headers and non-finite numeric budgets |
| Persistence failure | Graph COMMIT failure was logged and swallowed before hash publication | Roll back and reject save; publish changed hashes and retire deletion hashes only after graph commit. A failed deletion commit remains retryable after restart |
| Lint | 19 known errors in core/helpers/test fixtures | Remove dead initializers/this alias, correct regex escaping, make typed switches exhaustive and document intentionally empty fixture blocks. No test assertion removed |

The compiler fixture proves one Program for two changed files and no additional Program on an
unchanged refresh. The PageRank fixture proves no node enumeration on a cache hit. These are
operation-count checks, not installed latency, peak-RSS or energy measurements.

`CodeIndex.sync`, source admission and connected-file expansion were also inspected: its existing
manifest/content checks, per-result source read-back and bounded two-hop expansion are retained.
`ImpactEngine` traversal remains unchanged; wide/cyclic graph costs and all-path output limits
need their own workload contract. Unchanged code is not newly qualified by inspection alone.

Raw graph objects remain exposed for compatibility. A caller editing one directly must republish
it with `setGraph`; invisible mutations and mutation of returned cached score Maps are not covered.
The analyzer still holds its most recent type checker; its retention and peak memory are unmeasured.
Cross-file symbol-identity changes requiring caller reanalysis, concurrent refresh/root changes,
full-index partial failures, large directory discovery costs and multi-writer behavior remain
Target investigations. No universal graph consistency or immutable-filesystem-snapshot claim.

## Rejected heap experiment

An entry-reuse/hole-sifting candidate was compared with the current bounded heap and full sorting:
16 input-size/order cases, four warmups, eleven ABC/CBA repetitions, explicit GC, no parallel tests,
zero discarded timings and exact output checks against full stable sorting. At N=100,000/k=64:

| Input order | Current heap p50 ms | Candidate p50 ms | Full sort p50 ms |
|---|---:|---:|---:|
| random | 2.7370 | 2.7762 | 25.6200 |
| ascending | 13.6928 | 13.4689 | 2.0218 |
| descending | 3.9466 | 4.4390 | 1.9694 |
| tied | 1.7130 | 3.1380 | 9.7594 |

The candidate is **rejected**: no convincing ordered-input improvement and regressions elsewhere.
Production `bounded.top.k.ts` remains byte-identical to the round's starting implementation.
The ordered-input regression against full sorting remains Target; bounded retention stays the
existing adoption constraint. The candidate, exact baseline, script and every raw timing remain
in [evidence](evidence/2026-10-13-graph-freshness/). This is one local component experiment, not an
independent repetition of record 88 or a product performance claim.

## Verification and limits

Twenty new focused tests cover the findings, old-schema migration, TypeScript/Python renames,
retry, persisted graph read-back and cache operation counts. Fourteen source faults must fail
actual assertions, with exact restoration and a passing restored baseline. The first reproduction
used colocated `a.ts`/`a.tsx`; TypeScript excludes the latter in that configuration, so that fixture
failed before reaching its target. It was corrected to `a.ts.extra.ts`; the initial log is retained
and that setup failure is not counted as proof. The ten corrected original-source reproductions
all fail assertions in an isolated source tree, with module hashes and baseline commit recorded. An intermediate test-type error and an overbroad
`eslint .` run that exhausted Node's heap are also not passing verification; the repository's
actual `npm run lint` command is the applicable check.

One real Node fixture is killed with SIGKILL after graph COMMIT and before source-hash publication.
A fresh SQLite reader sees the new graph with the old hash still pending; refresh produces exactly
the fresh AST graph with no duplicate edges. Injected edit/deletion COMMIT failures prove rollback
and retention of the old persisted graph and stale/deletion hash. These qualify this graph checkpoint only,
not installed task crash/resume, duplicate external mutations, power-loss/fsync or full C04.

Final local checks pass: 4,250 Jest tests (19 existing skips), 133 Bun tests, three script tests,
root/app typechecks and builds, zero lint errors (1,822 warnings), fourteen assertion-caught source
faults and seven real staged-engine MessagePort exchanges. The initial 476 dirty files are preserved:
471 byte-identical, with four new documentation prefixes and comments in one fixture exactly
reconstructing the other five. No installed app replacement or new commit/push.

Final commands, exits, source hashes, dirty-file preservation and logs are recorded in
`evidence/2026-10-13-graph-freshness/verification.json`. No hosted model or provider was used.
GitHub currently has no run on this feature branch: the inspected CI workflow triggers on pushes
to main and pull requests targeting main. Local passing gates do not establish hosted CI success.

Guidance: product-reset README, current audit 01, architecture 05 and topology 06 (current monolith
records supersede historical split instructions), acceptance 08, Mac Buddy vision, V03/V27B cards,
competitive README/02/04/05/06/07, C01 dirty-repo preservation and R02 retrieval truth. C01 and R02
example files are present in this checkout; the capability-matrix document is still absent.
First-party references and applicability are in `research.json` and the source ledger. No external
implementation or dependency was copied or added. Full installed C01/C04/R02, live-provider quality,
release qualification, exhaustive semantic review and any competitive Win remain Target.
