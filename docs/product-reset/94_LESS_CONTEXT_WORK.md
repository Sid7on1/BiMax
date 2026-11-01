# Less context preparation work — 2026-10-13

Status: **Implemented** copying/work reductions and **Measured locally** on exact-output fixtures.
Installed app/model latency, answer quality, peak/sustained RSS, energy, full R01/R02, Product-ready,
release and competitive Win remain **Target**. No commit, push, installation, live model, CU or UI
implementation change in this round.

## Guidance and inspected boundaries

Read the product-reset README before planning; current ownership follows records 55/64/79–84.
Further guidance: 01_CURRENT_REPO_AUDIT, 05_TARGET_ARCHITECTURE, 06_REPO_SPLIT_RUNBOOK,
08_ACCEPTANCE_GATES; Mac Buddy performance vision; research playbook **V03** and **V27B**;
competitive README/06 and C01/R01/R02; current context record **93**. The coding engine retains
conversation management; Bimax for Mac retains sole Computer Use/native permission ownership.

Inspected request accounting, history selection, continuation, evidence and archive source. Retain
record-93 budget, Stop, epoch, atomic-tool, residency and retry policies. The archive already reused
hash-verified existing files, so the initially suspected repeated-write problem was absent and no
archive shortcut was added. An additional evidence index was deferred: its memory/admission cost
was not justified for this bounded ledger. No ranking, model choice or pressure threshold changes.

Fresh primary sources: [ECMAScript JSON serialization](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.stringify)
(living draft) and [Node 22 proxy detection](https://nodejs.org/download/release/v22.15.0/docs/api/util.html#utiltypesisproxyvalue).
They support mechanism constraints, not performance claims. No competitor code or package is copied.

## Changes and hard constraints

1. **Skip provably unselectable JSON copies.** A plain record with an own enumerable primitive
   content string longer than the entire input allowance cannot fit: JSON quoting cannot shorten
   it. A sentinel blocks that end of the selection just as its serialized form did. Hooks,
   accessors, proxies, non-enumerable content, nested values and possible serialization errors
   retain native JSON behavior. Both ends, the marker, exact under-limit bytes and all returned
   selection bytes remain identical to the frozen record-93 function.
2. **Construct continuation archive payloads only at publication.** Size trials use the same
   placeholder handle but no longer construct the complete evicted-message list on each trial.
   The actual archive gets exactly the same list once at the end. Trimming priority, quoted goal,
   omission counts, archive failures and non-destructive small rendering remain unchanged.
3. **Maintain retained-character totals incrementally.** Add/subtract lengths on eviction and
   adoption instead of reducing the whole retained list for every user instruction. The 64-KiB
   cap, ordering, grouped adopted history and dropped-count wording remain identical.

Adoption is lexicographic: exact output/archive and cancellation contracts first, bounded work and
resources next, measured cost last. Large-message benefits outweigh a measured tiny-input guard
cost of roughly 0.11 microseconds for five small messages. No faster incorrect candidate is accepted.

## Local paired measurements

Machine: Apple M3, arm64, eight cores, eight GiB RAM; Node 22.13.1. Backend: coding engine source
functions/classes; no remote provider, embedding or reranker. Full-compaction fixtures use a
deterministic local summarizer. Frozen **starting working-tree** sources are the baseline, not HEAD.

Two qualified runs each use warmup and nine alternating ABBA groups. Every row below pools all
36 batch-normalized per-call samples per version; **zero qualified samples discarded**. All raw
samples, batch repetitions, source hashes and local sample p95s are preserved. An earlier exploratory
run with eleven rather than twelve shapes remains separately recorded; these are not installed-app
tail percentiles or confidence intervals.

| Generated fixture | Before ms/call | After ms/call | Speedup | Less time |
|---|---:|---:|---:|---:|
| Summary input, oversized 100-KiB read | 0.214739 | 0.006417 | **33.46×** | **97.01%** |
| Summary input, oversized one-MiB read | 2.195196 | 0.006669 | **329.18×** | **99.70%** |
| Summary input, oversized eight-MiB stress read | 17.369146 | 0.010198 | **1,703.23×** | **99.94%** |
| Complete compaction, one-MiB read and fixture summarizer | 2.414300 | 0.099150 | **24.35×** | **95.89%** |
| Continuation render, 500 instructions / 1,200-character allowance | 0.193343 | 0.037110 | **5.21×** | **80.81%** |
| Continuation render, 500 instructions / unlimited allowance | 0.022838 | 0.013029 | **1.75×** | **42.95%** |
| Continuation ingest/render, 1,000 instructions | 1.506421 | 1.359565 | **1.11×** | **9.75%** |
| Continuation ingest/render, 10,000-instruction stress batch | 15.803229 | 14.301594 | **1.10×** | **9.50%** |
| Summary input, five small messages | 0.000716 | 0.000828 | 0.86× | **15.64% regression** |
| Summary input, 400 ordinary messages | 0.535045 | 0.538009 | 0.99× | **0.55% regression** |
| Continuation render, five instructions / unlimited allowance | 0.003072 | 0.003076 | ~1.00× | **0.14% regression** |
| Continuation ingest/render, ten instructions | 0.060547 | 0.060710 | ~1.00× | **0.27% regression** |

The huge serialization ratios apply to eliminating one avoidable copy of an already unselectable
message. They do not apply to tokenization, model execution, file reads or the whole app. The
one-MiB complete-compaction row includes the actual compaction method, summary collection deadline,
continuation handling and returned context, but uses an offline provider and empty file cache.
Both versions share unchanged dependencies; this fixture has no removed continuation claims or
commands, isolating summary-copy work. The standard full-file reader caps normal reads at 100 KiB;
larger inputs represent ranged reads or stress histories, not a typical default full-file read.

Before timing, every shape requires **identical output**; continuation cases also compare exact
archive payload bytes. Data construction is outside timed regions. Source hashes identify both
variants. `scripts/bench-context-work.cjs` reproduces these measurements; raw files and aggregate
method are under `evidence/2026-10-13-context-work/`.

## Correctness and failure qualification

The pre-change context command passes 63 tests and the official version-4 benchmark passes 43/43.
Twenty-three new tests compare frozen/current outputs and archive content across mixed sizes,
Unicode, tiny budgets, JSON hooks/proxies/getters/errors, adopted grouped history, every subsequent
retention boundary and failed archives. Work assertions require zero serialization of a provably
unselectable message, one final archive-list construction and no per-instruction list reduction.

The first baseline loader attempt failed before grading because native module loading bypassed
Jest's TypeScript resolver; its log is retained as **invalid**, not a mutation kill. After fixing
the loader, the frozen implementation fails three work assertions while eighteen controls pass.
Two later semantic/boundary controls bring the final suite to twenty-three tests.

The first source-fault attempt exposed two surviving tests: the own toJSON test did not exercise
an inherited hook, and a grouped-history test sampled batches without hitting the critical cap
boundary. Tests were strengthened with inherited-hook and per-instruction boundary cases; no
assertion was removed or loosened. All initial attempts remain evidence. The final twelve new
source faults and twenty-six rechecked record-93 faults must fail assertions, restore exact bytes
and pass their restored suites. The old proof script's serialization insertion marker is updated
for the new helper; its grading assertions and fault behavior are unchanged.

## Verification and preservation

Final local checks pass: **4,364 Jest tests / 451 suites** (19 existing skipped tests / one suite),
**133 Bun tests**, **63 context Bun tests**, **three script tests**, root/app builds and typechecks,
**zero lint errors** (1,847 warnings), and **seven staged-engine exchanges** (29,460 outbound bytes).
The focused set passes 158 tests with four runtime-specific skips covered under Bun. All 23 new
work/equivalence tests and all 38 source faults qualify. The final official context benchmark
remains valid at **43/43**, with identical fixture version and no family decline.

Of **695** initial dirty files, **688** remain byte-identical. Five additive research updates and
the intentional context-source/proof-hook updates have exact starting bytes frozen. All **191**
record-93 raw artifacts checked against its manifest remain unchanged. No unexpected/unowned
changes, staging, commit, push or installation.

Final check details and exact preservation/hashes are recorded in `verification.json`,
`qualification.json`, `dirty-preservation.json` and `manifest.json`. Required checks: targeted
Jest, full Jest, Bun retrieval/OCR suites, context Bun tests, script tests, root/app builds and
typechecks, lint, staged-engine MessagePort exchanges and a same-version context-benchmark run
with no family decline. No test invocation or benchmark exit code alone is treated as proof.

Starting source and every earlier dirty file are frozen or hash-protected. Record-93 raw evidence
remains unchanged. CU/UI and the installed app are untouched. Config/model state is isolated through
the existing test-fixture/Jest mechanisms. Installed long-task traces, live model-summary/answer
quality, tokenizer dominance, sustained allocation/RSS/energy and cross-machine crossover remain
Target; these component fixtures do not establish release or a competitive Win.
