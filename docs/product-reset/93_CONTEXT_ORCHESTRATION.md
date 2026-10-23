# Context orchestration and management — 2026-10-13

Status: **Implemented** context/request-boundary repairs and **Measured locally** on offline fixtures.
Installed long-task quality, latency, sustained RSS/energy, full R01/R02, Product-ready, release and
competitive Win remain **Target**. No live model, deployment, commit, push or installation in this round.
CU/UI implementation is outside scope.

## Boundary and guidance

This pass follows the current monolith/product ownership in records 55/64/79–84. The coding engine
owns conversation context; Bimax for Mac retains sole native permission and Computer Use ownership.
Only context preparation/recovery in the shared AgentLoop changes; specialized tool admission and
native execution policies are preserved.

Guidance read: product-reset README, 01_CURRENT_REPO_AUDIT, 05_TARGET_ARCHITECTURE,
06_REPO_SPLIT_RUNBOOK, 08_ACCEPTANCE_GATES; Mac Buddy vision; playbook **V03** (critical-path work,
cooperative cancellation) and **V27B** (correctness before measured cost); competitive README,
02/04/05/06/07 and R01/R02 contracts; context records **47/50/51/59**. The referenced competitive
03_CAPABILITY_MATRIX.md is absent. Older audit findings were checked against current source rather
than assumed to remain broken.

Primary research newly read: [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
supports investigating compaction, persistent notes and just-in-time references; [Node 22 AbortSignal](https://nodejs.org/download/release/v22.15.0/docs/api/globals.html)
supports cancellation propagation. Neither establishes Bimax model-answer quality. No competitor
implementation or additional package is imported. Applicability is recorded in the source ledger
and `evidence/2026-10-13-context-orchestration/research.json`.

## Inspected mechanisms and decisions

| Mechanism | Finding and decision |
|---|---|
| Whole-request budget | Keep tokenizer/system/schema/framing accounting and existing margin. Reserve the actual permitted output, including escalation; the old 15% cap could under-reserve a request. |
| Fixed-cost admission | Compute the plan before recall/compaction. An impossible instruction/schema/reply combination spends no auxiliary request. Output settings are not silently reduced. |
| Content token cache | Keep WeakMap caching; compare rendered text so in-place content-part changes cannot reuse stale counts. |
| Tool-call token cache | Compare defined call protocol fields and serialized opaque metadata. Retokenize changed calls; immutable argument strings avoid large serialization on warm hits. |
| History selection | A shared selector retains the full latest human request and a complete leading assistant/call/result batch. Missing, duplicate and unknown leading results are not attached to a guessed owner. |
| Summary serialization | Serialize each message once; compute total length before joining. Reserve the actual omission marker, keep valid JSON, and allow the other end when an oversized message blocks one end. |
| Summary collection | Each attempt has a 180-second deadline and a 32k-character output bound. Propagate Stop, interpret error/truncated events, reject empty output and discard all partial failed-attempt text. One overflow retry remains. |
| Summary publication | Stage restored-file evidence/source changes and continuation updates. Recheck cancellation and epoch after asynchronous file verification before synchronous publication. Reactive/snipping changes invalidate pending summaries. |
| Failed narrative | Carry the previous summary and an explicit unavailable label. Archive the removed conversation when bounded storage admits it; otherwise disclose that only bounded continuation evidence remains. |
| Recall | Use the protected human request, a 30-second caller deadline, owner checks and Stop fences. Cancelled/timed-out reservations can retry; clean abstention remains deduplicated. |
| Evidence residency | A handle is a reference, not shown raw text. File paths alone cannot claim other ranges; unseen dependencies do not become resident merely through a derived block. |
| Recovery progress | Compare request tokens including tool calls before granting a context-overflow retry. Keep bounded recovery tiers and existing output-escalation behavior. |
| Import connections | Baseline context tests exposed a missing importer relationship when that importer ranked first. Show both endpoints from the same bounded edge list, without changing ranking or loosening assertions. |
| Existing context layers | Retain pressure thresholds, code-safe compression, archive limits, freshness hashing, continuation quoting, BM25/retrieval ranking and RepoMap placement. |
| Learned eviction/new retrievers | Defer learned policies, embeddings/ANN changes and new orchestration dependencies: no workload/answer-quality evidence justifies replacing working mechanisms here. |

The active request stays whole in the main window and also reaches the summarizer. Retaining it
does not retain every intervening tool round: older work can still leave through summary and
continuation. A large current request or indivisible tool batch may be refused; trimming must not
manufacture a fit by deleting the task or breaking the provider protocol.

Archives retain their existing redaction, hash verification and size/eviction bounds. A failure
archive is recoverable evidence, not a successful model summary or a guarantee of indefinite storage.
Abort fences prevent late publication; they cannot force arbitrary uncooperative underlying work
or a remote provider to stop consuming resources.

## Baselines, strengthened graders and source faults

Before production edits, the old context benchmark passed **42/42** graded cases (version 3). The
context test command exposed one existing import-connection assertion failure; its log is retained.

R1 previously graded only input and used a 3k-window fake provider with an implicit 4,096-token
output allowance. Version **4** declares a realistic small output limit, retains all old assertions,
and also grades that allowance plus margin. R3 separately requires refusal when the actual output
allowance above 15% makes the fixed request impossible. The same pre-change production code scores
**42/43** under version 4, failing R3. The measured upgraded run scores **43/43** with no family
decline; three resource cases remain ungraded. This is prompt evidence reaching an offline fixture,
not a live model's answer or summary quality.

Fifty new tests grade actual returned history, requests sent/refused, independent tokenizer counts,
archived conversation reads, continuation/evidence state and cancellation outcomes. Existing test
assertions are preserved; the tight-window request fixture now declares its output limit and adds
a stronger total-budget assertion. An initial red run and a later frozen-source regression run are
retained. The latter fails 34/44 then-existing tests; ten controls pass. Later cache/preflight tests
have their own source-fault/red receipts rather than being counted in that earlier run.

`scripts/prove-context-orchestration.py` injects **26** deliberate source faults, requires assertion
failures (not compiler errors/timeouts), restores exact bytes after each, then runs the restored
suite. Earlier source-fault runs and candidate hashes remain separate. `mutations-release/` is the
final production-source qualification; its test stub later gains an empty yield delegation solely
to satisfy lint, without changing grading assertions.

## Local work and timing tradeoffs

`scripts/bench-context-orchestration.cjs` compares the frozen starting ContextManager against
candidate/current code, with warmup, nine alternating paired ABBA groups, 18 samples per version
per shape, no discarded timings, and correctness checks before timing. Machine/runtime and every
sample are retained in the JSON artifacts. These numbers are component costs on generated fixtures.

| Fixture | Starting median ms/call | Adopted field-cache median ms/call |
|---|---:|---:|
| Small summary, five messages | 0.000363 | 0.000673 |
| Oversized summary, 400 messages | 0.580481 | 0.431580 |
| Oversized summary, 2,000 messages | 2.728217 | 2.136863 |
| Warm plain-text token cache, 50 messages | 0.000729 | 0.000742 |
| Warm small-argument call cache, 50 messages | 0.001148 | 0.001727 |
| Warm 4k-argument call cache, 50 messages | 0.001022 | 0.001641 |

The first correct cache candidate reserialized full calls and cost **0.435897 ms** on the last
fixture. It is superseded by protocol-field comparison; both full timing runs remain. Warm caches
still cost slightly more than the unsafe identity-only cache, and small summaries cost more than
direct array JSON serialization. Adoption requires correct mutation accounting and exact input
bounds first, then avoids excessive copying while retaining all tested outcomes. No claim about
installed task acceleration, peak heap, energy, p95 product latency or cross-machine crossover.

## Completion and limits

Final local checks pass: **4,341 Jest tests / 450 suites** (19 existing skips / one suite),
**133 Bun tests**, **63 context Bun tests**, **three script tests**, root/app builds and typechecks,
**zero lint errors** (1,841 warnings), and **seven staged-engine protocol exchanges** (29,470 outbound
bytes). The focused set passes 135 tests with four runtime-specific skips covered under Bun; the
50 new tests all pass. The final version-4 benchmark is valid, **43/43**, with no family decline.
All 26 source faults are assertion-caught and restored. Of 636 initial dirty files, **630 remain
byte-identical**; five additive research updates and the intentional shared AgentLoop context
change have their exact starting bytes frozen. No unexpected/unowned changes or staging.

Final verification and preservation results are in `qualification.json`, `verification.json`,
`dirty-preservation.json` and the artifact hash manifest under
`evidence/2026-10-13-context-orchestration/`. Root/app compilation, lint, offline Jest/Bun/context
tests, script tests and staged MessagePort engine checks are required; benchmark exit status alone
does not grade cases. A final benchmark compares the same version-4 family counts.

The first broad verification attempt is explicitly unqualified: its runner forced one global
state root over tests that intentionally change cwd per fixture, causing 123 Jest and two Bun
failures. The runner is corrected to respect fixture directories/Jest's per-worker secret isolation;
all initial logs remain. One new test stub also had a require-yield lint error, repaired without
weakening any assertion.

Provider-exact token/image costs, model-specific lite-window budgets and long-horizon summary/answer
quality remain Target. The pressure/recall limits are explicit policies, not measured universal
optima. Optional Headroom proxy cancellation, complete installed interrupted/crashed-task recovery,
large real traces, sustained memory/energy and broader native OCR reliability are not qualified by
this pass. Existing CU policy/source, UI design, user configuration and prior dirty work are preserved.
