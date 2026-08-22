# Bimax two-product reset

Status: research and migration design, 2026-08-08. This folder is the source of truth for the
Mac-only product split. Product work should link its issue or pull request to one of the gates in
`08_ACCEPTANCE_GATES.md`; new architectural claims should be added to the source ledger before they
become implementation requirements.

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
- `21_CU_VERIFIED_GRAND_STACK_AND_IMPLEMENTATION_PLAN.md` — the corrected 2026-08-22 Computer Use
  stack, primary-source verification, stale-claim audit, phased delivery order, and Phase 0
  fail-closed provider-routing implementation record.
- `22_CU_PHASE0_RELEASE_ROUTING_RECORD.md` — the executable CU Phase 0 plan, compiled-provider
  fail-closed proof, mutation result, exact acceptance boundary, and Phase 1 handoff.
- `23_CU_PHASE1_NATIVE_LOGICAL_ADAPTER_RECORD.md` — the single native `mac_control` adapter,
  read-only session revival, compiled 10-call/service-restart/provider-restart proof, and explicit
  live-app/physical-delivery boundary.
- `24_CU_PHASE2_DETERMINISTIC_COMPLETION_RECORD.md` — typed postconditions for every accepted
  packaged-native mutation, fresh receipt grading, target/focus binding, false-success mutants,
  and the physical/menu/visual/programmatic adapter work that remains Target.
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
