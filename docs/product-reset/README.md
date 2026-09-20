# Bimax product reset

## Context, Threads and platform audit — 2026-09-20

[59_CONTEXT_THREADS_AND_PLATFORM_AUDIT.md](59_CONTEXT_THREADS_AND_PLATFORM_AUDIT.md) answers two
symptoms the owner reported from real use, and both were real but not where they looked.

- **"The context window breaks in long runs."** Measured: one identical 150-round session finished
  at the SAME 52,143 tokens on a 32k, 128k, 200k and 1M window — 5.2% of the largest. `snip()`
  fired on a MESSAGE COUNT and ran before every token-driven layer, so `capToolResults` never
  capped, `microCompact` never stubbed and `compact()` — the only pass that carries a task's goal
  and next step across a compaction — was never called once. Fixed; the count now only nominates a
  session and pressure decides. A second defect it exposed: the summarizer prompt was unbounded and
  goes to the *lite* model, so a 200k/32k model pairing would have failed every compaction and
  discarded the narrative in one line.
- **"Responses contain random letters that should be bold/underline."** Not a renderer bug — every
  assistant message already goes through `<Markdown>`. `BashTool` asked no child process to suppress
  colour and stripped no escapes, so ANSI flowed into the context and a weak model echoed it back;
  the ESC byte is invisible in a DOM text node, so `\u001b[1m` shows as the letters `[1m`. Separately,
  the compressor's ANSI pattern had an OPTIONAL escape byte and so matched ordinary text, turning
  `[Read the docs](…)` into `ead the docs](…)` inside tool results above the 70% threshold.

Also: a Bimax Threads eviction defect on the ⌘2 hot path (it evicted the Thread you were just using
and silently destroyed its queued messages), WP-6's capture recipe, and **WP-9 built end to end** —
the packaging gate (three mutants killed), the `bimax://` Shortcuts documentation, and an App
Intents extension giving Siri two actions and five phrases. That last one carries a **new product
fact**: macOS does not register the extension on a self-signed build, so **Developer ID is a
prerequisite for the Siri story, not only for Gatekeeper**. **WP-6 itself is NOT closed** —
`powermetrics` needs root and Instruments needs the Xcode GUI — so **WP-7 stays gated on it**. The
RAG retrieval half was audited and no defect was found (benchmark 42/42; recall@3 0.80 lexical →
1.00 reranked).

## macOS 27, optimisation, and a retirement pass — 2026-09-19

Three records, written in sequence:

- [56_APPLE_PLATFORM_AND_PERFORMANCE_PLAN.md](56_APPLE_PLATFORM_AND_PERFORMANCE_PLAN.md) — what
  macOS 27 Golden Gate offers (Foundation Models + `MLXLanguageModel`, Core AI, App Intents/Siri,
  MetricKit + StateReporting) measured against what this app already does. Two findings in it were
  **withdrawn on inspection** and are marked as such; the idle-CPU measurement (0.4% of one core)
  is why "optimisation" turned out to be the wrong frame.
- [57_OPTIMISATION_AND_APPLE_BUILD_PLAN.md](57_OPTIMISATION_AND_APPLE_BUILD_PLAN.md) — the work
  breakdown. **Built:** the Thread/worker/core glossary and its CI gate (WP-0, also in `AGENTS.md`),
  one machine-wide sub-agent worker budget (WP-1 — the per-Thread ceiling had been multiplying by
  the number of live Bimax Threads), and the rendering half of the adaptive policy, which had never
  executed once (WP-2). WP-3 withdrawn, WP-4 re-scoped, WP-6 blocked on Xcode's GUI.
- [58_RETIREMENT_AND_BACKEND_PLAN.md](58_RETIREMENT_AND_BACKEND_PLAN.md) — ~4,300 lines of
  production code retired across two passes (worktree racing, dream/self-play, Blueprints,
  LLM-training), each condemned by a measurement rather than by taste; plus **W1** usage counters
  (`/usage`) and **W2** change gates (`/gates`), whose escalation half is Target.

Front-end work is parked by the owner. The engine bundle is 1,561 modules / 21.82 MB.

## One codebase, one engine — 2026-09-19

[55_ONE_CODEBASE_ENGINE_RECORD.md](55_ONE_CODEBASE_ENGINE_RECORD.md) records that the pinned
engine artifact and the generated protocol mirror are gone. Electron now hosts the engine itself in a
`utilityProcess`, built from this repository's own source by `bun build` (23 MB, architecture-
independent) instead of downloading a `bun --compile` release that was never published. The app
imports `src/protocol/protocol.ts` and `src/evidence/schema.ts` directly, so a contract change breaks
the typecheck rather than a drift gate. Boot is measured (~424 ms to `ready`, ~330 ms with
`NODE_COMPILE_CACHE`). **This supersedes the "Terminal publishes a versioned engine artifact, the app
pins it" boundary described lower down in this file, in `05_TARGET_ARCHITECTURE.md` and in record 14**
— those remain as historical evidence. Installed-app, live-provider and DMG qualification are
unchanged and still Target.

## What a task's folder limits — 2026-09-14

[54_TASK_FOLDER_SCOPE.md](54_TASK_FOLDER_SCOPE.md) states today's guarantee (backlog F13, record 46 T06):
- a ⌘2 task changes files only in its folder;
- its shell commands can still read any file the user can, and use the network.

The app and `PRIVACY.md` now say so. The record also designs a read limit, which is not built.

## Folder triggers designed and built — 2026-09-14

[53_FOLDER_TRIGGERS_DESIGN.md](53_FOLDER_TRIGGERS_DESIGN.md) designs the first part of backlog FL1 before any code:
- what counts as an arrival;
- how a run is kept from triggering itself;
- the limits;
- the change list.

The first version is built: files that arrive directly in a folder start a ⌘2 task while Bimax is open. It is
unit-tested with mutants and has not been tried against a real folder yet.

## Context Compiler built — 2026-09-14

Record 50's steps 6–8 are built on top of the audit 51 repairs: a continuation state that survives compaction, one
budget at the request boundary, recall that shows the answering lines and abstains when memory does not know the
subject, log summaries, import-following code search, pattern search over archived output, `/evidence`, and continuity
across a rebuilt context manager. The context benchmark (version 3) passes 42 of 42. It is **not Product-ready**: the
R02 deterministic journey fails on this Mac as it did before (FTS5 missing under Node 22), and the live-provider and
model-graded journeys were not run. See [record 50](50_CONTEXT_COMPILER_BUILD_PLAN.md).

## Context audit qualification — 2026-09-14

[51_CONTEXT_UPGRADE_AUDIT.md](51_CONTEXT_UPGRADE_AUDIT.md) qualifies the later C0/C1 implementation
claims in records 48/50: existing tests pass, but adversarial probes and a surviving budget mutant
leave important contracts unresolved. The build-plan introduction below describes the earlier
pre-implementation baseline. [52_NOVEL_FEATURE_RECOMMENDATIONS.md](52_NOVEL_FEATURE_RECOMMENDATIONS.md)
contains ten researched proposals, all Target; it does not change the committed build order.


## Context Compiler build plan — 2026-09-14

`50_CONTEXT_COMPILER_BUILD_PLAN.md` turns record 47 into ordered steps: acceptance tests for the eight reproduced
defects, one-file fixes, shared-flow fixes, a repaired baseline, then the evidence foundation, prompt compiler,
adaptive retrieval and qualification, each with an exit check. The eight probes were rerun against this repository
and all still reproduce. Everything is **Target**.

## Feature backlog — 2026-09-14

`48_FEATURE_BACKLOG_2026_09.md` is the owner's next major build, starting 2026-09-15: foundations for unattended
work (queued messages surviving a restart first), quick fixes found while shipping talk mode, small integrations
(approve from a notification, `bimax://` links and Shortcuts), flagships (folders that act, an editable preview,
"Actually…", Night Shift, muscle memory), later bets and ideas parked until Computer Use returns. Every item is
Target, rated against commit `0dc3a6e`. It also carries the open items from records 46, 47 and 49.

## RAG and context audit and upgrade proposal — 2026-09-14

[Record 47](47_RAG_AND_CONTEXT_COMPILER_UPGRADE.md) inspects retrieval and prompt assembly,
reproduces eight synthetic limitations, and proposes a versioned Context Compiler using the
existing configured models. Six focused suites passed 56 tests. The report includes primary
papers, five pinned upstream repositories, integration stages, and falsifiable evaluation plans.
All proposed runtime upgrades remain **Target**; no live quality or release claim is made.


## Computer Use return strategy and Threads audit — 2026-09-13

`46_COMPUTER_USE_RETURN_AND_THREADS_STRATEGY.md` assesses the owner's request to reconsider Computer
Use as an optional Desktop task capability. It locates the external archive, reviews existing Threads,
records six local defect/limitation probes and proposes an ordered implementation program plus novel
feature experiments. This is **Target strategy**, not runtime activation. Existing tests passed
64/64 across four suites and Desktop typecheck passed; native CU and installed Threads qualification
remain unmeasured. Current code-only gates remain active until an explicit implementation changes them.
The record also identifies the missing competitive capability matrix and current topology-doc conflicts.

## Chat/tool isolation — 2026-09-13

`49_CHAT_TOOL_ISOLATION_RECORD.md` (numbered 45 in the stale `~/Desktop/Bimax` copy, where it was
written) records cancellation-drained chat clearing, truthful history
reset, pending-approval cancellation, interruptible provider backoff and direct document-tool
steering. Deterministic regressions and three rejected mutants are local evidence. Live-provider
tool-count/latency and installed-app qualification remain Target. **The code is not in this repository yet;**
porting it is item F8 in record 48.

## Capability failure visibility — 2026-09-12

`45_CAPABILITY_FAILURE_VISIBILITY_RECORD.md` records proactive retrieval/tool/MCP/storage failures,
a persistent Desktop warning, CLI stderr delivery, bounded recovery and controlled fault/mutation
proof. Local implementation and measured boundaries are explicit; unused capabilities and model
quality are not certified by an empty warning panel.


## Desktop visual refresh — 2026-09-10

`44_DESKTOP_VISUAL_REFRESH_RECORD.md` records the installed Mac app’s refreshed welcome screens,
finite orbital animation, action cards and compact composer layout. Build/typecheck and 26 focused
composer tests pass; installed launch and Files checks are local evidence, not release qualification.

## Workflow input evidence — 2026-09-10

`42_WORKFLOW_EVIDENCE_RECORD.md` extends the read-only workflow dispatcher with actual-byte and
directory evidence, mid-run stale-dependency checks and session-scoped selective refresh. Incomplete
searches are explicit and cannot be reused as current evidence. Locally verified with 224 tests
and six caught behavioral mutants; continuous
watching, durable replay, code/test claim integration and packaged/model qualification remain Target.

## Read-only tool workflows — 2026-09-10

`41_TOOL_WORKFLOW_RECORD.md` adds a deferred dependency-graph dispatcher for file reads and
searches, with result bindings, nested permission checks, bounded results and cancellation draining.
Implemented and locally verified: 195 tests and four caught behavioral mutants. Durable resume,
structured search outputs, packaged/live-model qualification and performance claims remain Target.
The record also lists seven concrete coding-infrastructure follow-ups.

## Engine boot baseline — 2026-09-09

`40_ENGINE_BOOT_BASELINE_RECORD.md` gives the engine its first latency baseline: **400ms warm
spawn→ready, 1,588ms cold**, and a full-module trace showing **56% of it elapses before any Bimax
source module runs**. No speedup is claimed. One change was kept and explicitly credited with zero
(bun had already tree-shaken the dead imports the isolated probes blamed); one was measured and
**reverted** — deferring `gpt-tokenizer` bought 100ms on `--version` but cost 15ms on spawn→ready,
the path Desktop actually waits on. One real win landed: `build:engine` now minifies whitespace and
syntax — 85MB→79MB, **spawn→ready 396→382ms**. Full `--minify` was rejected on measured evidence
that it destroys the egress ledger's function-name attribution. F02 should be re-scoped against this baseline: as written it
targets the 45ms of reported boot phases, not the 222ms that precedes them.

## Policy holdout off — 2026-09-09

`39_POLICY_HOLDOUT_OFF_RECORD.md`: the policy-arm holdout now defaults to 0, so Bimax stops hiding
a mind block from its own prompt ~1 turn in 10. Measured first — this repo's event ledger holds 0
scored episodes and no learner state file exists, so the exploration was being paid for and never
spent. `/arms` now says the holdout is off instead of implying more data is coming. One environment
variable (`BIMAX_POLICY_HOLDOUT=0.1`) reverses it; do that once episodes accrue and something reads
the estimate. The reward being a tool-success proxy rather than verified claims remains Target.

## Attested positive scope — 2026-09-09

`38_ATTESTED_GREEN_SCOPE_RECORD.md` closes record 37's next step: a **passing** background run can
now settle a claim, but only for files the runner's own coverage report proves it executed.
Measured first — under piped capture `node --test` names only test names on success and jest only
aggregate counts, while both name paths on failure — so green stdout cannot scope a claim and LCOV
`SF:`/`LH:` records supply the scope instead. Six fresh real-tool scenarios, four mutants killed
(two only after the proof was strengthened to reach the guard), 93 focused tests across nine
suites. Bimax must never add coverage flags to the model's command to manufacture an attestation.
File-level attestation does not prove the mutated *lines* ran; that remains the next tightening.

## Proposed speed and efficiency program — 2026-09-08

`32_FAST_CODE_AND_COWORK_REFACTOR_PLAN.md` turns the unified workspace direction into ten
source-grounded refactor tracks and a dependency-ordered delivery sequence. It covers boot,
streaming, incremental discovery, durable tasks, safe edits, scheduling, context and verified
work outputs. Unimplemented tracks and all numerical budgets remain **Target**. The evaluation contract is
`competitive/examples/P01_FAST_CODE_AND_COWORK.md`; no runtime speedup is claimed by the plan.
The second-pass audit and major-lab paper references are in `33_REFACTOR_RECHECK_AND_RESEARCH.md`.
It corrects the existing-foundation inventory, reports 91 focused passing tests and two reproduced
rollback defects, and tightens budget/quality experiments.

Delivery began on 2026-09-08 and is recorded in `34_FAST_CODE_AND_COWORK_IMPLEMENTATION_RECORD.md`.
Stages 0–3 are **Implemented and locally verified** within the limits recorded for each slice. Stage 1, the transaction correctness floor,
fixes both reproduced rollback defects along with read-error handling, failed-rollback retention,
binary content and file mode. Stage 0 adds the measurement primitives and the P01 paired runner that
every later performance claim has to pass through — including the gates that stop a fast wrong
answer, a hidden abstention or an unavailable timing from being reported as a speedup. Stage 2 gives
the Desktop git refresh one in-flight read, a coalescing dirty flag and a project-generation fence,
so a burst no longer starts a read per event and a reply about a closed project can no longer be
painted onto the open one. Stage 3's transport slice makes the engine's outbound protocol pipe a
bounded, strictly ordered queue that honours backpressure and reserves capacity for approvals rather
than pretending a later message can overtake queued bytes, and its batching slice coalesces adjacent
streaming deltas into one reducer pass per frame while keeping the transcript byte-identical. Stage 3c isolates the live transcript tail with stable
domain snapshots; text-only batches no longer rerender the workspace. The browser fixture preserves
selection and final output; broader non-stream consumer migration remains Target. Every
other stage, every frozen fixture and every numerical budget in the plan remains **Target** and
unmeasured: no Bimax path has been benchmarked for latency.

## Planned expansion — unified coding and work workspace (2026-09-07)

The owner has directed Bimax Desktop toward a general workspace for individual and organization
work, spanning coding, research, analysis, documents and connected workflows. The phased plan and
first composer slice are in `31_UNIFIED_WORKSPACE_AND_COMPOSER_PLAN.md`. Organization services and
broader workflows remain Target. The runtime boundary below remains enforced: this decision does
not reactivate Computer Use or native permissions. Terminal remains the coding product.

## Current direction — code-only agentic IDE (2026-09-02)

The owner has superseded the app-owned Computer Use plan. Bimax Terminal and Bimax Desktop now
expose one coding-agent boundary: project files, create/edit/delete, shell, tests, git, review,
plans, code search, MCP, browser research, subagents, checkpoints, and task receipts.

Computer Use is disabled in both products. Desktop does not register `bimax-mac`/`mac_control`,
start takeover or focus brokers, request Accessibility, Screen Recording, or Microphone, or package
the XPC service, bridge, helper, preview, or Mac capability provider. Historical CU records remain
evidence, not active requirements. See `30_CODE_ONLY_AGENTIC_IDE_RESET_RECORD.md`.

Status: research and migration design, 2026-08-08. This folder is the source of truth for the
Mac-only product split. Product work should link its issue or pull request to one of the gates in
`08_ACCEPTANCE_GATES.md`; new architectural claims should be added to the source ledger before they
become implementation requirements.

The material below records the superseded Mac automation direction. Use it as historical evidence,
not as authorization to restore a runtime capability.

The repository-level `AGENTS.md` makes consultation of this research mandatory before agents plan,
review, or change Bimax. A change that ignores that rule is incomplete even when local tests pass.

## The decision in normal words

Bimax does not have one bad computer-use function. It has one strong coding agent, one unfinished
Mac app, and several generations of computer-control code living in the same release. The terminal
therefore tries to carry permissions and native services that only a real app can host correctly,
while the app tries to expose every internal feature at once. That makes the terminal heavy, the app
busy, and failures hard to explain.

We will make two serious Mac products:

1. **Bimax Terminal** — the fast coding agent. It reads code, edits, runs commands and tests, uses
   subagents, and reviews changes. It does not control other Mac apps and does not request Screen
   Recording or Accessibility.
2. **Bimax for Mac** — the visual workspace. It contains the coding experience and is the only
   product allowed to observe or operate other apps. It owns the Electron shell, native Swift
   service, XPC bundle, permissions, visual evidence, action history, and computer-use evaluations.

They use the same coding engine, but they do not copy it. Terminal publishes a versioned macOS
engine artifact plus its protocol schema; the Mac app pins and bundles one verified version.
*(Withdrawn 2026-09-19 — Terminal is archived and the app builds the engine from its own source. See
record 55.)*

## What this does and does not solve

| Problem | Effect of the app-only boundary |
|---|---|
| XPC service is not registered from the terminal binary | Solved structurally: the service lives in `Bimax.app/Contents/XPCServices/`. |
| Mac permissions are attributed to a confusing executable | Solved in product design: the app is the visible permission owner; fresh-Mac tests must prove the system agrees. |
| Native physical mouse/keyboard path needed live proof | Locally solved for approved foreground Unicode typing; the bundled arm64 service passed an exact-target end-state check. Clean-machine release qualification remains separate. |
| Model repeats actions or chooses bad fallbacks | Reduced by one app-owned controller and a smaller fallback ladder, but must be measured. |
| Unsigned app shows Gatekeeper friction | Not solved. Internal alpha supports manual override; a smooth public release requires stable signing/notarization. |
| Existing app feels crowded | Addressed by the new information architecture in `04_FRONTEND_PLAN.md`, not by a color/theme pass. |

## Folder map

- `01_CURRENT_REPO_AUDIT.md` — exact local facts and ownership mistakes.
- `02_RESEARCH_LEDGER.md` — primary sources, cross-checks, and conclusions.
- `03_PRODUCT_EXAMPLES.md` — patterns to borrow and traps not to copy.
- `examples/` — local UI audit and compact cross-product pattern matrix used during design review.
- `04_FRONTEND_PLAN.md` — Terminal and Mac app UX.
- `05_TARGET_ARCHITECTURE.md` — processes, contracts, data, and computer-use ladder.
- `06_REPO_SPLIT_RUNBOOK.md` — history-preserving split and path manifest.
- `07_MIGRATION_ROADMAP.md` — reversible delivery phases.
- `08_ACCEPTANCE_GATES.md` — what “done” means; no fake n/n scoreboards.
- `09_PHASE1_FILE_MAP.md` — code-level map for the first non-destructive implementation slice.
- `10_PHASE1_IMPLEMENTATION_RECORD.md` — exact landed boundary, artifact hashes, local qualification,
  and the still-external fresh-Mac gate.
- `11_SECTIONS_28_29_RESEARCH_AND_DELIVERY_PLAN.md` — deep research, architecture, phased delivery,
  and proof contracts for contextual macOS intelligence and the modular chipset-native ecosystem.
- `12_ALL_VISION_SECTIONS_RESEARCH_PLAYBOOK.md` — normalized coverage of all 37 distinct owner-
  vision chapters, with primary leads, candidate algorithms, examples, samples, falsification
  experiments, reusable research prompts, and an explicit remaining-evidence register.
- `13_PHASE2_SLICE_RECORDS.md` — eight Phase 2 slice records: supported Electron/macOS-13 and IPC
  baseline, bundle-only component resolution, app-owned Trust diagnostics, separated native versus
  compatibility baselines, executor-ladder attribution, then the Trust Center/receipt inspector and
  packaged native-only fallback freeze, the M02 fixture, then packaged local qualification. Each
  carries its own evidence and external boundary.
- `14_PHASE3_ENGINE_BOUNDARY_RECORD.md` — research, retained protocol samples, generated schema,
  per-chip engine manifest/pin, current/previous compatibility, mutations and the source-free
  Desktop build that closes the local Phase 3 exit.
- `15_PHASE4_DESKTOP_CAPABILITY_RECORD.md` — current MCP research, retained provider/schema and
  machine/network samples, complete CU ownership extraction, per-chip provider boundary, full local
  ladder results and the explicit adaptive/network and release Targets left for later phases.
- `16_PHASE5_FRONTEND_RECORD.md` — the frontend reset: the task workspace and contextual evidence
  inspector, the Mac Live Target, the app-owned pause/takeover/resume control, the cross-lane
  receipt, the seven graded journeys with their mutation pass, and the measured bundle/interaction
  costs plus the Targets this phase deliberately did not claim.
- `17_PHASE6_REPO_SPLIT_RECORD.md` — the history-preserving local Terminal/Desktop split, retained
  histories, independent pipelines, exact engine pin and the hosted migration/CI rows still Target.
- `18_PHASE7_RELEASE_HARDENING_RECORD.md` — measured release identity/hashes, private diagnostic
  export, manual-alpha manifest/update rollback, the local arm64 artifact and its explicit
  public/stable/clean-Mac blockers.
- `19_PHASE8_CONTEXTUAL_INTELLIGENCE_RECORD.md` — the causal evidence vocabulary shared by both
  products, the deterministic Task Guard floors, receipts across every Bimax-owned subsystem, drift
  detection, reversible correction, the read-only capability/environment inventory, the trusted
  package transaction and the isolated capability broker — with the fourteen gate mutants, the four
  that survived during development and were fixed, and everything sections 28/29 still leave Target.
- `20_PHASE9_MISSION_PACKS_AND_ADAPTIVE_RUNTIME_RECORD.md` — the Desktop-owned process provenance,
  explain-only anomaly ranker, out-of-process capability worker, official simulator adapters,
  optional Computer Use pack, bounded MLX/Core ML contracts, adaptive-concurrency canary and the
  Starlight/Moonlight Runtime inspector, with every real-device/distribution row kept explicit.
- `21_CU_VERIFIED_GRAND_STACK_AND_IMPLEMENTATION_PLAN.md` — the corrected Computer Use stack,
  primary-source verification, stale-claim audit, phased delivery order, and current Phase 0–7
  local-core status.
- `22_CU_PHASE0_RELEASE_ROUTING_RECORD.md` — the executable CU Phase 0 plan, compiled-provider
  fail-closed proof, mutation result, exact acceptance boundary, and Phase 1 handoff.
- `23_CU_PHASE1_NATIVE_LOGICAL_ADAPTER_RECORD.md` — the single native `mac_control` adapter,
  read-only session revival, compiled 10-call/service-restart/provider-restart proof, and explicit
  live-app/physical-delivery boundary.
- `24_CU_PHASE2_DETERMINISTIC_COMPLETION_RECORD.md` — typed postconditions for every accepted
  packaged-native mutation, fresh receipt grading, target/focus binding, false-success mutants,
  and the physical/menu/visual/programmatic adapter work that remains Target.
- `25_CU_PHASE3_PERCEPTION_AND_LATENCY_RECORD.md` — exact-window temporal readiness, full-snapshot
  action authority, poisoned-cache mutants with caching still disabled, and separately budgeted
  deterministic provider/observe/capture/verification timing.
- `26_CU_PHASE4_UNTRUSTED_OBSERVATION_RECORD.md` — the HMAC-authenticated pre-observation task graph,
  untrusted AX/capture typing, branch receipts, six scope-widening mutants and the bounded benign
  bidi control, with broad/live adversarial qualification still Target.
- `27_CU_PHASE5_RECEIPT_BACKED_JOURNEYS_RECORD.md` — bounded Desktop-private journey storage,
  redacted export policy and replay that reobserves/revalidates every step, with adapter activation
  and live speedup still Target.
- `28_CU_PHASE6_APP_OWNED_EXECUTION_SOURCES_RECORD.md` — fixed-manifest app-owned source broker with
  plan/approval/takeover/timeout/postcondition/rollback gates; live source workers remain Target.
- `29_CU_PHASE7_OPTIONAL_LOCAL_AI_RECORD.md` — optional Foundation Models/FastVLM capability and
  evaluation policy, non-authorizing rehearsal, and fine-tune dataset admission; models and device
  measurements remain Research Target.
- `30_CODE_ONLY_AGENTIC_IDE_RESET_RECORD.md` — the current owner decision, enforced code-only
  boundary, local verification, and remaining clean-machine/package release proof.
- `34_FAST_CODE_AND_COWORK_IMPLEMENTATION_RECORD.md` — what the speed and efficiency program has
  actually landed, stage by stage, with the exact verification, mutants and remaining Targets.
  Stages 0–3 have local implementation evidence; numerical performance budgets remain Target.
- `vision/` — the owner's complete Bimax Mac Buddy north-star vision, preserved verbatim and required
  reading for Mac app, adaptive-runtime, performance, environment-intelligence, CU, and Trust work.
- `ownership-manifest.json` — machine-readable starting ownership for the extraction tooling.
- `competitive/` — current rival research, model-independent product strategy, gap register, and
  repeatable head-to-head proof journeys.

## Decisions still needed from the owner

Implementation can begin locally without these, but publishing cannot:

- GitHub owner/organization and final remote names for `bimax-terminal` and `bimax-desktop`.
- Whether the first public app release may be labeled **manual-install alpha**, or whether public
  release waits for Developer ID and notarization.
- Product naming: this plan uses “Bimax Terminal” and “Bimax for Mac” as working names.
