# Migration roadmap

The split is a sequence of reversible slices. “All tests green” at each slice means the tests that
can actually detect the requested outcome, not deleting or weakening a failing test.

Every owner-vision implementation slice names its stable V-ID from
`12_ALL_VISION_SECTIONS_RESEARCH_PLAYBOOK.md`, selects a bounded hypothesis/algorithm portfolio,
defines the falsification fixture and records what evidence would justify changing Target status.
This research mapping does not reorder the two-product reset or make later adaptive/security work a
prerequisite for the clean Terminal/Desktop boundary.

## Phase 0 — freeze evidence and product contracts

- Keep section 21's frozen CU records and exact boundaries.
- Record current Terminal coding smoke tasks and app coding smoke tasks.
- Add a machine-readable ownership manifest and engine/Desktop compatibility fixture.
- Stop adding new CU code to TUI paths.

Exit: baseline artifacts are immutable; current release can be rebuilt from the tag.

## Phase 1 — Terminal stops being a Mac-control host

- Remove CU binaries from `tui/embed_prod.go`, build scripts, release archives, and TUI extraction.
- Hide/remove `/computer` and CU posture in the Terminal product.
- Keep a temporary Desktop-only engine build flag if needed so the app still reaches the current
  coordinator.
- Prove coding, TUI, protocol, review, resume, interrupts, and release archives are unchanged.

Exit: installed Terminal cannot request Screen Recording/Accessibility or operate another app.

Implementation status, 2026-08-08, updated after Phase 4 on 2026-08-09: **implementation and local
qualification complete**. Terminal omits CU tools/commands/posture/presentation, embeds only the
coding engine, and exposes a schema-checked NDJSON mode. Phase 4 subsequently removed the temporary
host-profile vocabulary entirely: Terminal has no Desktop profile and Electron supplies a generic
dynamic provider descriptor. Both arm64/x64 release archives pass
inventory and protocol gates; native arm64 latency passes locally, while native Intel timing stays
in the external matrix because Rosetta first-translation time is not an Intel product measurement.
Both packaged app
architectures contain the engine, XPC service, bridge and helper in their required locations. The
phase still needs the external fresh-Mac/quarantined-download rows before a release claim can use
the unqualified word “complete.” Exact evidence is in `10_PHASE1_IMPLEMENTATION_RECORD.md`.

## Phase 2 — Desktop becomes the only working CU route

- Upgrade Electron 33 to the latest supported stable patch in a standalone commit, choose macOS 13+
  as the launch floor, and verify `@lydell/node-pty`, Electron Vite, packaging and native helpers.
- Add Trust Center and app-owned permission diagnostics.
- Require CU service, bridge, helper, and engine to resolve from the app bundle in packaged runs.
- Consolidate production execution to semantic → physical → visual → stop.
- Render typed action receipts and focus/background state in a basic inspector.
- Run native and compatibility baselines separately; never combine their numbers.

Exit: a fresh packaged app performs the agreed Messages/settings/fixture demos through Bimax's own
app-owned route, with no terminal or external CU fallback, and reports each foreground transition.

Implementation status, 2026-08-08. Slice 1 of this phase — *establish the supported Desktop runtime
and IPC security baseline* (V02, V30, V32) — is **Implemented** and locally **Measured**:

- Electron `^43.3.0` (installed 43.3.0 / Node 24.18.1 / Chromium 150), `electron-builder ^26.15.3`,
  `electron-vite ^5.0.0`, `vite ^6.4.3`; `@lydell/node-pty` unchanged and still resolving.
- macOS 13 floor declared by `mac.minimumSystemVersion` and the native `Package.swift` platform.
- `app/src/main/security.ts` owns the window contract (`sandbox`, context isolation, no renderer
  Node, no webview, `webSecurity`), the response-header CSP, sender/navigation/permission policy and
  every renderer payload validator. All 22 privileged channels go through `secureHandle`/`secureOn`.
- Two real containment escapes were found and fixed while reconciling: an empty project root made the
  file IPC guard accept any absolute path, and `git diff --no-index` accepted an uncontained path.

Slice 2 — *packaged runs resolve engine and native components from the app bundle only* — is
**Implemented** and locally **Measured**:

- `app/src/main/runtime.paths.ts` (Electron-free, injected inputs) decides every executable location.
  A packaged run resolves the engine, XPC service, bridge and helper from `Bimax.app` and nowhere
  else; `BIMAX_ENGINE_CMD`, `BIMAX_CU_SERVICE_BINARY`, `BIMAX_CU_BRIDGE_BINARY` and
  `BIMAX_DESKTOP_HELPER` are refused there and honoured only in development.
- A packaged app whose bundled engine is missing now fails visibly instead of falling through to
  `dist/index.js` or `npx tsx` from a walked-up repo root — the "walk to `../src`" that
  `05_TARGET_ARCHITECTURE.md` forbids. The supervisor turns that into a bounded retry ending in a
  reported `failed` state, not a crash and not an endless loop.
- A refused override is also *stripped from the child environment*. The engine reads these variables
  itself, so refusing them in the main process alone still let an unresolved component inherit the
  hostile value — the same defect Phase 1 fixed on the Terminal side in `tui/engine.go`.
- `scripts/verify-desktop-package.mjs` now checks this from the shipped artifact. It was confirmed
  to FAIL against the pre-slice bundle before passing against the rebuilt one.

Slice 3 — *app-owned permission and component diagnostics* — is **Implemented** and locally
**Measured**: `app/src/main/trust.ts` reports build identity, non-prompting macOS permission
dispositions, the resolved component inventory (sharing the launcher's own resolution path), coding
availability, Computer Use blockers, and an explicit list of what the build cannot establish. Two
invariants are mutation-tested: coding availability never depends on a permission, and an unknown is
never reported as fine. Measured on Electron 43 that the query-only permission APIs do not prompt.
The **Trust Center view** is deliberately not in this slice — Phase 5 owns the recomposition — so it
stays **Target**, as do always-allowed apps, action history, diagnostics export, and real
signature/notarization reporting (Phase 7).

Slice 4 — *native and compatibility baselines are reported separately and never combined* (bullet 6)
— is **Implemented** and locally **Measured**. `buildReport` now keys rows by executor before task
class, disqualifies a suite that mixed executors, and refuses to fold a run with no recorded backend
into a known one. Replaying the committed `frozen-v1.1.0.json` showed the pre-change report pooled
one unattributed run into the form class and still printed "Frozen baseline"; the corrected
compatibility figure is 2/5, and `docs/BIMAX_CU_BASELINE_v1.1.0.md` is corrected accordingly. The
raw record was not modified.

Slice 5 — *name and attribute the existing executor ladder without duplicating its router* — is
**Implemented** and locally **Measured**. `src/computer/executor.ladder.ts` maps the runtime's existing
`AutomationMechanism` choices onto the one product vocabulary (`semantic | physical | visual |
stop`), and `BimaxComputerRuntime.run()` stamps the final attribution once after every early return
or AX reroute. Screenshot/OCR grounding is reported as visual even when delivery used AX or a native
event; a refusal is stop; an uninstrumented compatibility action remains unattributed rather than
being relabelled after the fact. The existing `chooseMechanism` function remains the only router.

This is the attribution foundation for bullet 4, not completion of the production consolidation.
The forced packaged-app semantic/physical/visual/stop paths and the compatibility-backend freeze
remain blocked together because `DefaultBackendFactory` still constructs `CuaCompatibilityBackend`
as the only backend.

After Slice 5, the remaining Phase 2 items were the Trust Center surface (bullet 2), forced
packaged-app ladder paths and compatibility freeze (the rest of bullet 4), and the typed receipt
inspector (bullet 5). None of the first five slices added any Terminal capability; slice 5 named and
exposed the route the runtime already chose but did not add a second routing path.

Implementation status, 2026-08-09, Slice 6: the Trust Center view, typed native/compatibility receipt
inspector and packaged compatibility freeze are **Implemented** and locally **Measured**. Packaged
Electron identity now forces full native cutover and omits `ComputerTool`; a failed signed gate makes
Computer Use unavailable instead of silently constructing the compatibility backend. Phase 2 is
still not an unqualified complete phase: the staged fixture’s four forced-path postconditions, M02
focus/persistence record and the fresh-Mac permission matrix remain external qualification.

Implementation status, 2026-08-09, Slice 7: the M02 background semantic fixture and end-state grader
are **Implemented** and locally **Measured**. The existing AppKit fixture now owns the persistent
`Mom demo` and control rows; the same executable, under a separate inert bundle identity, provides
the foreground typing recorder. One live run passed 9/9 checks: exact `7:30 PM` state after reopen,
one matching target, unrelated row unchanged, fresh post-action observation, stable foreground PID,
and every synthetic bystander keystroke in order. This is native-service evidence, not packaged-app
evidence, and it does not qualify pause/resume or the forced physical/visual rungs.

The same run found and removed a real overclaim: `CGEvent.postToPid` returned a performed receipt
while both its read-back and independent AX observation showed no text change. Catalog verification
now requires non-false receipt and postcondition evidence; `type_text` and `targetedEvents` are no
longer advertised as verified. The live catalog then passed with no overclaim. ScreenCaptureKit
capture remains red on this machine (`SCFrameStatusSuspended`, zero complete frames), so the visual
row is also not qualified. Phase 2 therefore remains **incomplete** until packaged semantic,
physical, visual and stop rows pass, M02 pause/takeover is graded through that route, and the
fresh-Mac permission/distribution matrix is complete.

Implementation status, 2026-08-09, Slice 8: **Phase 2 implementation is complete and local
packaged-component qualification passed; the phase exit is not yet unqualified.** The arm64
`Bimax.app` was rebuilt, and a single preserved package-component run forced
all four rungs through the native service shipped inside that bundle: semantic AX mutation,
approved foreground physical click/Unicode typing, exact-window ScreenCaptureKit capture, and an
unapproved foreground request that stopped before focus or target state changed. The same run
repeated M02 through that bundled service and passed all 9 persistence/focus/keystroke checks.

The physical correction does not revive the disproven background `CGEvent.postToPid` claim. The
implemented physical rung is a WindowServer/HID event guarded by an exact-PID focus lease, explicit
approval, quiet-period check, exact live AX-element click and independent value read-back. Visual
qualification now targets the actual visible fixture window (not a 33-pixel auxiliary window) and
received four complete frames at 1120×984; macOS 14+ also has the first-party one-shot screenshot
fallback for a suspended stream.

Raw evidence is preserved in
`app/benchmarks/computer-use/results/phase2/run-2026-08-09T08-13-12.423Z/report.json`. It binds hashes
for the app executable, ASAR, bridge and XPC service, records the Apple M3/arm64 host, asserts
`bimax.cu.v1` and positive advertised capacity, and records available network interfaces while
leaving path cost, constrained state and endpoint RTT explicitly unknown. No local Phase 2
component implementation/qualification row remains open. After Phase 4, the Desktop
provider/native coordinator—not the generic engine—contains the takeover latch: it blocks every
native mutation immediately before the bridge until explicit resume, and the focused test proved no
action transport call was made while paused. Phase 5 owns the visible pause/takeover/resume control.
The rebuilt Phase 4 package later passed the provider-owned takeover assertion and all packaged
semantic/physical/visual/stop + M02 rows; see
`app/benchmarks/computer-use/results/phase2/run-2026-08-09T11-40-39.888Z/report.json`. Phase 2 local
implementation/package qualification is complete. Clean-machine TCC/quarantine, native Intel where
shipped, Developer ID signing and notarization are Phase 7 release qualification and cannot be
manufactured on this development Mac.

Repair audit, 2026-08-27: the packaged ownership statement above had regressed at two connection
seams and is now **Implemented and locally package-Measured again**. The production bridge was
constructing `BimaxCuServiceCore` in-process, so the staged `.xpc` existed without owning the live
route; it now uses the app-bundled named XPC service and permits the embedded core only behind the
explicit untrusted-development switch. The XPC listener derives the exact bridge designated
requirement from the sealed bundle, validates the immediate peer with Security.framework, and also
requires an exact signed Bimax app ancestor so an unrelated process cannot launch the bridge as a
confused deputy. Trust Center now performs the same bridge → XPC handshake as the provider and gates
readiness on the reached service's intact signature, identifier, exact approved Code Directory hash,
and its own Accessibility/Screen Recording states. The generic engine still owns no native CU code;
Desktop connects its generic `bimax-mac` provider before engine readiness instead of discovering it
on the old delayed optional-MCP sweep.

The local build now restages the engine manifest and rebuilds service, bridge, helpers and provider
as one generation. `scripts/verify-desktop-package.mjs` launches that exact signed `Bimax.app`
executable with `--self-test-native-route`, bypasses only the normal single-window lock, and requires
Electron → bridge → intact `ai.bimax.cu.service` before the package passes. The 2026-08-27 arm64
bundle at `/private/tmp/bimax-cu-repair.NUAo1x/release3/mac-arm64/Bimax.app` passed strict nested
signature verification and this live topology gate. That exact app was packaged as a local arm64
DMG, whose filesystem checksum passed; its read-only mounted copy passed the same live topology
gate. The distributable local artifact is `app/release/Bimax-1.1.0-arm64-local-2026-08-27.dmg`
(SHA-256 `7eddb4ac1e19dcfc29a407c087ee8d87f701e511b3bbde16ebd3dde9af4aa5be`). The
same bundle then passed every packaged conformance assertion, including topology, semantic,
physical, visual, stop, takeover, content,
search, foreground-invariance and M02; raw evidence is preserved in
`app/benchmarks/computer-use/results/phase2/run-2026-08-26T20-25-23.833Z/report.json`. Native tests
passed 60/60, Desktop tests passed 1160/1160, and the engine suite accounted for 2469 tests (2458 passed plus 8 skipped in the full
run; the 3 sandbox-denied loopback/home-install cases then passed 19/19 with their required local
authority). This repairs a local package claim only: Developer ID/notarization, a clean-Mac TCC
matrix, native Intel timing and a model-backed broad real-app journey remain **Target**.

Authenticated-plan race repair, 2026-08-27: a live installed-app Messages request exposed that a
Computer Use turn was signed only when `mac_control` was already registered at persona entry. On
the old delayed MCP path, the provider could appear during the same turn and receive a call with no
plan; the native authority correctly stopped it as `untrusted_observation_authority`, while the
renderer incorrectly described the attempted `open` as completed. Plan binding now follows the
explicit user instruction and the Desktop-only launch secret rather than ToolRegistry timing, so a
late registration/reconnection inherits the authenticated turn. Blocked provider results now render
as errors such as `Blocked: open Messages`, retain the refusal reason, and never advance the live
target. The exact reported sentence is pinned in engine and renderer regression tests. Full local
qualification passed 2462 engine tests (8 intentional skips) and 1161 Desktop tests. A freshly
rebuilt engine was packaged with the app as
`app/release/Bimax-1.1.0-arm64-local-planfix-2026-08-27.dmg` (SHA-256
`a479c70dc54a760acce8d3950203c6c3617fed0056c0485971152d70d2665c4e`); `hdiutil verify`, strict
nested signature validation and the read-only mounted Electron → bridge → exact XPC topology gate
all passed. No real message was typed or sent. Safe-contact send completion and clean-Mac release
qualification remain **Target**.

## Phase 3 — publish the engine boundary

- Promote the current NDJSON interface to a generated, versioned client protocol.
- Publish macOS engine artifacts and manifest from Terminal CI.
- Make Desktop dev and release resolve a pinned artifact; keep an explicit local override for
  contributors.
- Add compatibility tests across current Desktop × current/previous supported engine.

Exit: Desktop builds in a checkout that contains no Terminal engine source.

Implementation status, 2026-08-09: **Implemented and locally Measured; Phase 3's local exit is
complete.** The additive `hello`/legacy `ready` handshake, generated TypeScript compatibility
module, JSON Schema/client package, current/v2 golden journeys, per-architecture raw engine assets,
manifest/checksums, pinned Desktop resolver and release-only override refusal are landed. The gate
compiled both architecture artifacts, rejected mutated engine/manifest inputs, and built Desktop in
a temporary checkout with no Terminal `src/`. A real external tag/promotion is still required to
prove remote publication; it is a release event, not an unimplemented Phase 3 code path. Evidence:
`14_PHASE3_ENGINE_BOUNDARY_RECORD.md`.

## Phase 4 — move CU coordination into Desktop

- Move `src/computer`, native computer tools, prompts, installed-app detection, CU commands/config,
  posture and CU benchmarks to Desktop in small thematic commits.
- Replace engine-specific imports with the Desktop capability provider/MCP seam.
- Terminal only sees dynamically supplied tool schemas and generic tool events.

Exit: Terminal source contains no Mac app names, AX/capture/input policy, CU driver labels, or CU
benchmarks; Desktop still passes the same qualified end-state tests.

Implementation status, 2026-08-09: **Implemented and locally Measured; Phase 4's local exit is
complete.** Terminal now consumes only a generic `BIMAX_HOST_CAPABILITIES_JSON` MCP descriptor;
Desktop owns the provider, runtime, native tools, policy, prompts, fixtures, scripts and benchmarks.
The provider reuses the existing mechanism router, binds to Electron's declared arm64/x64
architecture, and is probed over local stdio against a stored schema sample. All 52 Desktop
capability suites (590 tests), the native 60-check harness, Terminal/TUI suites and the provider
probe pass in the single `phase4:check` ladder. Full evidence and bounded chipset/network claims are
in `15_PHASE4_DESKTOP_CAPABILITY_RECORD.md`.

The rebuilt arm64 app then passed the packaged conformance matrix with 11/11 assertions, including
the provider-owned takeover latch and all four executor levels. Raw evidence:
`app/benchmarks/computer-use/results/phase2/run-2026-08-09T11-40-39.888Z/report.json`.

## Phase 5 — frontend reset

- Recompose the existing React components into tasks / current task / contextual evidence.
- Implement Code inspector first using existing diff/files/terminal components.
- Implement Mac Live Target/action timeline from typed receipts.
- Reduce modes/themes/status chrome; add keyboard and accessibility coverage.
- Use screenshot regression at the supported window sizes plus real interaction tests.

Exit: five core journeys pass without opening Diagnostics: start coding task, review/verify changes,
resume task, grant CU permissions when requested, pause/take over/resume a Mac task.

Implementation status, 2026-08-09: **Implemented and locally Measured; Phase 5's local exit is
complete.** The shell is one task workspace — projects/task threads on the left, the current task
with its single state and plan progress in the centre, and one contextual evidence inspector on the
right whose Code / Mac / Browser / Team / Receipt / Files lanes appear only once that evidence
exists. Terminal became an on-request drawer that no longer spawns a pty unless opened; Trust Center
and the code-map/memory surfaces became sheets. `Dock.tsx`, `Sidebar.tsx` and `Footer.tsx` were
removed after their last consumers, and `UiSnapshotComputer` went with the producer Phase 4 deleted.

The user-facing pause/takeover/resume control that Phase 2/4 deferred here is landed as an
**ownership change, not a second latch**: Electron main holds the authority, the mac capability
provider mirrors it read-only over a loopback token channel and **fails closed** when it cannot read
it, and the existing `NativeInputInterlock` stays the single thing every native mutation consults.
`mac_control` — which never went through the native coordinator — is now gated too. Admission is
bound to main's monotonic takeover generation and refreshed again at the real driver/fallback
delivery boundary, so a pause-and-resume that happens entirely while an action is being prepared
still discards that old action.

Nine core journeys plus resilience, interaction-cost and three accessibility/size runs pass on the
built renderer (**14/14**) at 720×480, 1180×800 and 1680×1050. The first Control Mac task is held
behind contextual permission guidance while Code remains usable, and the visible lane chip can be
corrected before execution. Four deliberately broken end states are rejected. Raw record:
`app/benchmarks/ui/results/phase5/run-2026-08-09T14-33-20-612Z/report.json`. A separate production
boundary journey also passes through built Electron main, preload IPC, the supervisor and the
compiled `bimax-mac` provider over stdio, with only the native-world target replaced by a safe
input-free fixture. Its qualified record is
`app/benchmarks/ui/results/phase5/electron-2026-08-09T14-34-28-744Z/report.json`. The rebuilt arm64
package then passed the Phase 2/4 conformance matrix 11/11, including the provider-owned takeover
latch, so the new authority did not break packaged Computer Use. Full evidence, the measured bundle
and interaction costs, and the explicit remaining Targets are in
`16_PHASE5_FRONTEND_RECORD.md`.

## Phase 6 — history-preserving repo split

- Execute `06_REPO_SPLIT_RUNBOOK.md` in fresh clones.
- Run both complete pipelines locally and in CI.
- Publish migration branches, inspect history/licenses, then make new mains default.

Exit: two independently buildable repos and no copied coding engine.

Implementation status, 2026-08-09: **Implemented and locally Measured; the local materialization
exit is complete.** A fresh snapshot preserved all uncommitted Phase 1–5 product work, and
`git-filter-repo` produced a 208-commit Terminal repository and a 34-commit Desktop repository with
`app/` promoted to root. Terminal contains no app/native/CU implementation; Desktop contains no
Terminal agent-loop/TUI source. Both independent installs, builds and suites pass, both Terminal
architectures pass release inventory, the native service/provider build in Desktop, and Desktop
accepts the exact split Terminal manifest digest. Evidence: `17_PHASE6_REPO_SPLIT_RECORD.md`.

This is not the unqualified Phase 6 exit: GitHub organization/final names, non-default migration
branches, hosted CI, history/license inspection and default-branch cutover remain external owner/
publication work. The runbook forbids creating or pushing those repositories before owner
confirmation.

## Phase 7 — release hardening

- Manual-install alpha: checksums, exact-hash display, fresh-Mac override instructions, permission
  regrant warning, rollback-capable updater or manual update.
- Stable: Developer ID, consistent nested signing, hardened runtime, notarization/stapling, signed
  update feed, clean-Mac Gatekeeper and TCC persistence tests.
- Add local-first diagnostic export, crash recovery, update rollback, and privacy disclosure.

Exit: the chosen channel meets every applicable gate in `08_ACCEPTANCE_GATES.md`.

## Phase 8 — contextual intelligence and trusted capability foundation

This phase begins only after the product boundary, versioned protocol and stable Desktop broker are
real. It deliberately starts without privileged observation or automatic installation.

- Land the shared TaskIntent, OperationIntent, Observation, Decision, Approval, ActionReceipt,
  Verification and Rollback schemas.
- Make Bimax-owned engine, MCP, package, browser, Computer Use and environment operations emit
  causal receipts.
- Add read-only environment inventory, capability manifests/graph, Agent Skills discovery and MCP
  capability display.
- Add deterministic task/project boundary findings and Trust Center evidence/retention controls.
- Build signed/fresh capability metadata, isolated broker execution, staged activation, revocation
  and exact rollback before growing an executable catalog.
- Add project/environment drift and correction only after the inventory and rollback contracts pass.

Exit: S28-A/S29-A and trusted package transactions pass the journeys in
`11_SECTIONS_28_29_RESEARCH_AND_DELIVERY_PLAN.md`; no new macOS permission is required.

Implementation status, 2026-08-09: **every bullet above is Implemented and locally graded; the phase
exit is met.** The shared TaskIntent/OperationIntent/Observation/Decision/Approval/ActionReceipt/
Verification/Rollback vocabulary is landed in the engine and mirrored byte-identically into Desktop
behind a drift gate. Every Bimax-owned subsystem — engine tools, MCP, package, browser, environment
and Computer Use — emits causal receipts through a per-task guard that refuses only Bimax-owned
operations at a deterministic hard floor. Layers A/B/C run over a macOS path classifier, with the
silence journeys graded as hard as the detections.

S29-A ships the capability manifest, the one-rung-at-a-time capability graph, a read-only inventory
that can only execute a frozen probe table, Skills discovery that surfaces shadowing and grants
nothing from frontmatter, and MCP display that withholds newly-appeared tools pending reapproval.
S29-B ships TUF-shaped metadata verification, bounded staging that judges an archive before writing
anything, and an unskippable install transaction with byte-exact rollback. S29-C step 1 ships the
isolated broker: opaque path handles, signed-digest identity, budgets, cancellation, taint
propagation, crash backoff to quarantine, and a partial-revoke that reaches handles already
outstanding. S28-B ships drift detection whose sensor tolerates coalescing, rescans after overflow
and never infers an actor from an FSEvent. S28-C ships the correction transaction, where a
postcondition that cannot be established on fresh evidence rolls back. The Trust Center has its
evidence timeline, its retention summary and delete controls whose blast radius is shown first.

9 engine suites / 316 tests and 1 Desktop suite / 39 tests pass; 14 neutered-implementation mutants
are killed by `npm run phase8:check`. Four mutants survived during development and all four were
real gaps that were fixed.

This is an Implemented claim, not a Measured or Product-ready one. There is no labeled corpus and
therefore no measured false-positive, notification-volume or overhead budget; no signing key or
catalog operator exists, so every metadata test uses an injected verifier; the broker's
out-of-process worker and the FSEvents stream that feeds drift detection are interfaces rather than
implementations; and nothing was run on a fresh Mac. S28-D/E and S29-D/E/F belong to Phase 9. Full
evidence and the complete Target list are in `19_PHASE8_CONTEXTUAL_INTELLIGENCE_RECORD.md`.

## Phase 9 — mission packs, ML Alchemist and optional broader sensors

- Integrate Xcode-managed and Android official simulator tooling through adapters.
- Make optional Computer Use a Desktop-owned capability pack without reintroducing Terminal CU.
- Ship one bounded, measured MLX research and one Core ML deployment workflow in ML Alchemist.
- Instrument runtime workload, memory, thermal, power, network, interaction and rendering budgets;
  canary one adaptive decision class at a time.
- Prototype Bimax-launched process provenance before system-wide observation.
- Request Endpoint Security or Network Extension entitlements only after feature purpose, privacy,
  queue/deadline/overhead tests and clean-Mac permission UX exist. Missing entitlement remains a
  supported configuration.
- Learned anomaly detection remains explain/rank-only until a labeled corpus and false-positive
  budget justify any narrower action.

Exit: each named capability, detection class and hardware policy passes its own device/fresh-Mac,
mutation, false-positive, latency, resource, privacy and rollback gate. The phase does not authorize
a broad “repairs macOS” or “chipset-native everywhere” claim.

Progress, 2026-08-10: the locally implementable S28-D/E and S29-C/D/E/F contracts are
**Implemented** and mutation-tested. Desktop now owns bounded child-process provenance, an
out-of-process digest-bound worker, official iOS/Android adapter contracts, optional Computer Use
activation, MLX/Core ML evaluation contracts and a one-class adaptive concurrency canary. The
Runtime inspector composes those facts into the Phase 5 workspace. This is not a Measured or
Product-ready Phase 9 exit: the corpus, entitlement, signing/catalog operator, real simulator/device,
real model, fresh-Mac and release matrices remain Target. Evidence is in
`20_PHASE9_MISSION_PACKS_AND_ADAPTIVE_RUNTIME_RECORD.md`.

## First reversible implementation slice

Start with Phase 1, not the visual redesign and not the repository deletion. Specifically:

1. add a `desktopCapabilities` launch profile to the headless engine;
2. make the Electron supervisor opt into it;
3. build the TUI without CU embeds/env/config/commands;
4. prove Terminal coding tasks and Desktop's existing CU fixture path;
5. only then remove dead TUI CU files.

This immediately makes the product promise truthful while keeping every current source file and Git
history available for the deeper extraction.
