# Competitive build sequence

This sequence extends `../07_MIGRATION_ROADMAP.md`. It prioritizes the smallest set that can make
Bimax meaningfully better, not the largest feature inventory.

## Workstream A — truthful product boundary (now)

1. ~~Add an explicit host boundary.~~ **Implemented, locally Measured 2026-08-09** as a generic
   dynamic provider descriptor; the engine no longer carries a Desktop profile.
2. ~~Make Electron supply Desktop capabilities.~~ **Implemented, locally Measured 2026-08-09** —
   Electron launches the architecture-bound local stdio provider and supplies its descriptor.
3. ~~Remove Computer Use binaries, commands, permission posture, and packaging from Terminal.~~
   **Implemented, locally Measured 2026-08-09** — the Phase 4 source scan and full suites pass.
4. Make packaged Bimax.app the only production Computer Use host. **Implemented, locally Measured
   2026-08-09** for *component ownership*: a packaged run resolves engine, XPC service, bridge and
   helper from its own bundle only, refuses and strips the four environment overrides, and fails
   visibly rather than falling back to a development engine. The existing router's four-level
   attribution and structured inspector are now **Implemented, locally Measured 2026-08-09**. The
   rebuilt arm64 package/provider route has also passed semantic, physical, visual and
   stop-before-effect postconditions plus M02 9/9 and the provider takeover assertion;
   fresh-machine release rows remain external.
5. ~~Freeze the compatibility backend; it cannot silently activate in production.~~ **Corrected and
   locally Measured at the compiled provider boundary 2026-08-22.** The 2026-08-09 policy existed,
   but a later source audit found provider registration did not call it and always added
   compatibility `mac_control`. CU Phase 0 now derives provider mode from Electron package identity,
   lists one visible blocked `mac_control` in packaged mode, publishes no low-level acting tools,
   and kills an unreachable-packaged-branch mutant over compiled MCP stdio. Development retains the
   compatibility lab. At the end of Phase 0, a working native logical `mac_control` was the next
   Target.
   **Phase 1 follow-up, 2026-08-22:** the native logical adapter and read-only session revival are
   now Implemented and locally Measured across the compiled provider using the deterministic
   10-read/service-restart/provider-restart gate. Unsupported native verbs stop visibly and no
   mutation is replayed after session retirement. Live packaged-app and physical adapter journeys
   remain Target.
   **Phase 2 follow-up, 2026-08-22:** every mutation this adapter accepts now requires a typed
   postcondition and succeeds only after exact target/window binding plus fresh native read-back.
   Performed-only false success and shared stop-result mutants fail the local gate. Physical, menu,
   visual-recovery and programmatic adapter mutations remain Target rather than silently widening.
   **Phase 3 follow-up, 2026-08-22:** the native logical adapter now authorizes actions only from
   complete event-tracked exact-window full snapshots, classifies readiness per observation/window
   generation, and measures cold provider, observe, capture and verification separately. The
   deterministic 10-sample corpus met its frozen budgets. Cache/diff optimization remains off until
   live notification-loss/poisoned-cache evidence exists.
   **Phase 4 follow-up, 2026-08-22:** Electron main now provisions a launch-scoped plan-authentication
   key; the engine signs the original human instruction/action graph before observation and attaches
   it only to app-owned `mac_control`; the provider blocks screen-origin scope widening before native
   delivery. A narrow 6-adversarial/1-benign corpus met its zero/zero budget. Broad/live adversarial
   qualification remains Target.
   **Phase 5–7 follow-up, 2026-08-23:** Desktop now has locally measured policy cores for bounded
   private receipt-backed journeys, fixed-manifest app-owned execution sources, and optional local-
   AI evaluation/rehearsal/training admission. These preserve the modified Phase 3 full-snapshot
   authority and Phase 4 authenticated task isolation: replay reobserves every step; source workers
   require plan/approval/takeover continuity and independent proof; optional models cannot authorize
   a deterministic refusal. Product activation, real workers, device corpora and live/package
   qualification remain Target.
6. Split product ownership without copying the engine. **Implemented and locally Measured
   2026-08-09 for the local migration:** filtered Terminal and Desktop histories build and test
   independently, Desktop is pinned to the exact split Terminal manifest, and both source-boundary
   scans pass. Hosted migration branches/CI and default-branch cutover remain Target pending the
   owner's organization and final-name decision.

Exit: Terminal is a clean coding product; Desktop is the sole Mac-control permission owner.

## Workstream B — model conformance and task truth

1. Implement the provider capability profile and probe suite.
2. Persist a task contract separate from conversation summaries.
3. Add canonical tool-call signatures and typed failure classification.
4. Make provider failover task-local and prove config hashes do not change.
5. Route text-only models through explicit auxiliary vision.
6. Add content-addressed prompt fragments and cache metrics.

Exit: every selectable autonomous model route has a current conformance result; failures cannot
silently degrade capability.

## Workstream C — coding table stakes

1. Revalidate local edit/run/review/resume/interrupt/dirty-tree behavior.
2. Unify checkpoint, worktree, subagent, and task lineage in the protocol.
3. Add last-turn/uncommitted/staged/branch review scopes.
4. Add visible subagent inspect/steer/interrupt.
5. Add local ↔ worktree handoff.
6. Make Agent Skills and MCP capability-scoped and cache-safe.
7. Add ACP after the versioned engine artifact boundary is stable.

Exit: Bimax Terminal is credible beside Claude Code, Codex, and OpenCode even without Desktop.

## Workstream D — Mac reliability moat

1. ~~Upgrade Electron and close renderer/main IPC security gaps.~~ **Implemented, locally Measured
   2026-08-08** — Electron 43 on a supported line, macOS 13 floor enforced by packaging and the
   native target, and one Electron-free policy module gating sender, navigation, permissions and
   every renderer payload. Two path-containment escapes (empty project root; `git diff --no-index`)
   were found and fixed here. Fresh-Mac rows remain Target.
2. Finish forced native semantic, physical, visual recovery, and stop tests in the packaged app.
   **Component implementation and bundled-service matrix are locally Measured 2026-08-09** — all
   four postconditions and M02 9/9 passed with raw hashes/results preserved. The rebuilt package's
   generic engine-to-provider boundary, provider-owned latch and bundled native route are qualified;
   clean-machine signing/TCC is a later release gate.
3. ~~Add fresh action receipts with app/window/executor/evidence/postcondition.~~ **Implemented,
   locally Measured 2026-08-09** for native actions and the basic transcript inspector; packaged
   arm64 M02 evidence is stored and fresh-Mac evidence remains Target.
4. Add background/foreground classification and focus restoration. **Implemented and
   deterministically Measured for accepted packaged-native semantic/launch/window actions in CU
   Phase 2:** each receipt exposes requested/actual delivery and measured focus change, rejects a
   background focus lease or changed foreground, and keeps physical input unsupported until it can
   be foreground-lease-only. Live accepted physical proof remains Target.
5. The Desktop provider/native coordinator owns the immediate input latch and rechecks it before
   the bridge. **Implemented, locally Measured 2026-08-09** at the capability layer, and the
   **visible pause/takeover/resume control is now Implemented and locally Measured** (Phase 5):
   Electron main owns the latch, the provider mirrors it read-only over loopback and fails closed,
   and every mutating tool — including `mac_control`, which does not go through the coordinator —
   is refused before the bridge. Main's monotonic takeover generation is bound at admission and
   checked again at the actual driver/fallback delivery boundary, so an intervening pause+resume
   invalidates already-prepared input. A built-Electron/real-provider safe-boundary journey stores
   the refusal and the newly-issued post-resume success. The deleted Terminal `/computer` command
   is no longer described as a shared owner.
6. Add stale frame/element rejection and identical-call recovery hints.
7. Add a local fixture app suite for tables, dialogs, menus, forms, lists, drag/drop, and multiple
   windows; keep real Messages tests on a safe account/contact.

Exit: M01–M03 pass on the packaged app with preserved raw records and no legacy fallback.

## Workstream E — frontend reset

### Terminal

- Keep the default surface to transcript, composer, plan/progress, tool evidence, and final receipt.
- Make start/resume/review/print obvious.
- Collapse cost/model/context/subagent internals into contextual status.
- Let users attach a command-output evidence block to the next prompt.

### Desktop

**Implemented and locally Measured; hardened 2026-08-11.** Evidence:
`../16_PHASE5_FRONTEND_RECORD.md` and
`app/benchmarks/ui/results/phase5/run-2026-08-11T13-45-54-024Z/report.json`.

- ~~Left: projects and task threads only.~~ `TaskSidebar.tsx`; the six implementation tools left it.
- ~~Center: one task transcript and composer with goal controls.~~ `TaskHeader.tsx` carries the one
  task state, plan progress, Stop and the Mac takeover control.
- ~~Right: contextual Code, Mac Target, Browser, or Receipt inspector.~~ `Inspector.tsx`, with lane
  availability decided by `inspector.model.ts`; a lane appears only once its evidence exists.
- ~~Bottom/overlay: persistent terminal when requested, not permanent product chrome.~~
  `TerminalDrawer.tsx` — and the pty is no longer spawned for users who never open it.
- Trust Center owns Mac permissions, action history, service/build hashes and a diagnostics copy.
  The 2026-08-11 hardening pass makes the permission view live, names the responsible host and
  native service separately, removes nested scrolling, uses a real Electron native bundle drag,
  adds Keychain-backed provider setup plus a fail-closed Work/Vision preflight, and bounds unsigned
  manual-alpha CU approval to the service's exact re-probed Code Directory hash. **Always-allowed apps and a
  clean-Mac packaged drag/TCC run remain Target**: neither is implied by the renderer journeys.

Exit: **met locally for twelve core journeys** — start a coding task, review/verify changes, resume
after a crash, diagnose permissions while coding stays usable, pause/take over/resume a Mac task,
understand the live target, inspect a final receipt, infer/correct the lane, and complete the first
Control Mac permission return, approve an exact unsigned local CU build, inspect the live model
catalogue, and block/resume Control Mac around a compatible model route. All are graded on end state at 720×480, 1180×800 and 1680×1050; four deliberately broken
end states are rejected. A separate built-Electron/compiled-provider safe boundary also passes.
Model-backed native-app journeys (M01/M03/X01/I01) remain Target.

2026-08-13 correction: the installed coach is now additionally graded against the main-process
Electron API path (`process.getSystemVersion`, not the nonexistent `app.getSystemVersion`). A live
Control Mac attempt reached the app-owned provider and opened Calculator but did not converge, so
it is not an M01 pass. Desktop now injects a compact hidden one-action/fresh-frame/proven-end-state
contract after its permission/model gates; the fresh granted rerun remains part of the Target exit.

Later 2026-08-13 installed regression: the permission coach now restores Bimax automatically after
the native drag returns instead of waiting on a process-cached TCC probe; Accessibility, Screen
Recording and Full Disk Access use bundle drag while Microphone uses the native media request. The
explicit Control Mac submission also owns the exact `bimax-mac/mac_control` approval for that task
only. Two consecutive provider-backed open/focus runs completed without a visible repeated Allow
modal. This advances the app-owned routing and permission-return journey to locally Measured, but
does not close M01/M03/X01/I01 because the receipts did not independently confirm a target mutation.

The follow-up repeated-Accessibility report was traced to manual-alpha identity, not another
renderer refresh bug: System Settings showed an older ad-hoc Bimax row On while the current process
received `AXIsProcessTrusted = false`. The coach now names the required one-time Off→On refresh for
an existing row and relaunches after completed host AX/Screen Recording drags to clear the process-
lifetime TCC cache. Stable permission persistence remains gated on Developer ID signing.

2026-08-23 correction: the repository now has access to a valid `Bimax Local Code Signing`
identity. The local build path prefers it with hardened runtime disabled, yielding a stable
certificate-root-and-identifier designated requirement for the Bimax host while preserving the
native CU service's separate ad-hoc exact-hash trust gate. This removes identity churn for repeated
local host rebuilds but does not satisfy the Developer ID, notarization, Gatekeeper, clean-Mac or
public-update gates. The first installed certificate-signed build immediately recovered host 2/2
without a regrant on this Mac; persistence after the next changed local rebuild remains to be
measured before claiming the update journey.

## Workstream F — proof and release

1. Implement the immutable run schema and artifact store.
2. Mutation-test every grader.
3. Run same-model Bimax/Hermes/OpenCode coding comparisons.
4. Run product-native Codex/Claude/Cursor comparisons separately.
5. Run Bimax model-tier resilience on every release candidate.
6. Run the fresh-Mac install/update/revoke/regrant matrix.
7. Publish only task-specific results with denominators and discarded attempts.

Exit: a claim can be reproduced from public task definitions and raw, redacted artifacts.

## Workstream G — expansion only after the moat works

- browser workflow recording/replay;
- optional remote workers;
- a small curated plugin catalog;
- scheduled verified tasks;
- team policies and shared skills;
- connectors demanded by real users.

Do not start messaging-channel, voice, image-generation, or memory-marketplace breadth merely to
fill cells in the competitor matrix.

## Workstream H — contextual intelligence and correction (owner section 28)

1. Reuse the versioned task/action/evidence protocol to capture Bimax-owned intent and receipts.
2. Add deterministic project/task mismatch findings before privileged sensors or learned scoring.
3. Add project/environment drift with FSEvents-backed invalidation and exact rescans.
4. Add reversible correction transactions with dirty-state preservation and mutation-tested
   postconditions.
5. Prototype Bimax-launched process provenance; measure queue loss, overhead and false positives.
6. Treat Endpoint Security and network filtering as optional Desktop-only, entitlement-gated later
   slices. Keep models and UI prompts off authorization deadlines.
7. Add learned anomaly ranking only after a labeled corpus exists; it cannot be the sole block or
   repair reason.

Exit: S28 journeys pass by capability tier, and findings explain causal expected-versus-actual
behavior without claiming to replace Gatekeeper, XProtect, SIP, SSV or TCC.

Progress, 2026-08-10: steps 1–5 are Implemented and locally graded
(`19_PHASE8_CONTEXTUAL_INTELLIGENCE_RECORD.md`). Step 3's FSEvents *stream* is not wired — the drift
detector consumes change batches and handles coalescing, overflow and sequence gaps, but nothing
produces those batches from macOS yet. Bimax-launched process provenance and an explain-only ranker
now exist; privileged system-wide sensors, a labeled corpus and measured false-positive budgets
remain Target (`20_PHASE9_MISSION_PACKS_AND_ADAPTIVE_RUNTIME_RECORD.md`).

Two findings worth carrying forward. Modelling "we read this from the command text" as an *evidence
gap* made every ordinary shell command raise a finding: incompleteness and evidence basis are
separate axes, and a declaration may refuse an operation but may never certify an end state. And a
drift sensor must never name an actor — an FSEvent cannot identify one, so attribution has to come
from the causal graph, joined afterwards.

## Workstream I — verified chipset-native ecosystem (owner section 29)

1. Define capability kinds, manifest/graph, authority handles, signed metadata and rollback.
2. Ship non-mutating environment inventory, Agent Skills discovery and MCP capability review.
3. Add out-of-process broker execution and staged package activation before an executable catalog.
4. Compose the integrated Bimax IDE from existing editor/diff/terminal/git/task/evidence surfaces.
5. Add Xcode/Android simulator adapters and optional app-owned Computer Use only after broker gates.
6. Ship bounded ML Alchemist workflows with artifact isolation and quality/performance evidence.
7. Instrument, replay and canary adaptive scheduling/rendering one decision class at a time.

Exit: S29 journeys pass; each package, environment class, ML transform and runtime adaptation is a
named Measured result rather than a blanket ecosystem or “chipset-native” claim.

Progress, 2026-08-10: steps 1–7 are Implemented as local contracts and mutation-graded. Signed-metadata verification,
bounded staging, the unskippable install transaction with byte-exact rollback, and the isolated
broker now include the out-of-process digest-bound worker. The existing IDE surfaces compose a
Runtime lane; official simulator adapters, optional Computer Use activation, isolated ML workflows
and the one-class adaptive scheduler exist. Real signing/catalog operation, simulator/device runs,
MLX/Core ML measurements and the adaptive energy/frame matrix remain Target.

The design decision worth carrying forward: a capability is never handed a path. It gets an opaque
handle, and the broker re-checks containment at use time rather than at mint time — which is what
lets a partial revoke in the Trust Center reach handles that are already outstanding.

## 12-month product checkpoints

### Checkpoint 1 — clean alpha

- Terminal has zero Computer Use ownership.
- Desktop owns one packaged native route.
- Conformance probes gate models.
- C01, C03, M02, and install matrix have valid baselines;
- app is explicitly a manual-install alpha if unsigned.

### Checkpoint 2 — credible daily driver

- review/worktree/subagent/checkpoint flows revalidated;
- crash recovery and goal controls ship;
- M01–M03 and X01 are stable;
- no unsupported Electron runtime;
- Trust Center and diagnostics are usable by non-engineers.

### Checkpoint 3 — stable product

- two repos and pinned engine release boundary;
- stable signing/notarization/update path;
- ACP and skills/MCP ecosystem;
- multi-model release gates;
- public, reproducible head-to-head pack;
- support telemetry is opt-in and locally inspectable.

Boundary prerequisite, 2026-08-09: the versioned engine artifact seam is **Implemented and locally
Measured**. Current/v2 protocol goldens, per-chip manifests, pinned Desktop consumption, digest
mutations and a Desktop-only source-free build passed. A real tag/public promotion and update
rollback stay in Workstream F/release qualification.

## Stop conditions

Pause feature expansion when any of these is true:

- false success or wrong-target action appears in the release suite;
- a fallback changes user config;
- a background action steals focus without declaring it;
- a grader passes while receiving no end-state evidence;
- a product capability works only in dev shell, not the staged app;
- a new tool/schema is added without a concrete journey;
- the app UI needs users to understand executor internals to complete normal work.
