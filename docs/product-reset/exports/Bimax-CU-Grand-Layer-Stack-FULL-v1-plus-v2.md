# Computer Use verified grand stack and delivery plan

Status: corrected research and implementation plan, 2026-08-22.

This document supersedes the four Desktop drafts named `Bimax-CU-Grand-*`. It reconciles those
drafts with current source, `20_CU_OPEN_PHASES.md`, the Mac Buddy vision, the two-product boundary,
the acceptance gates, and primary external sources re-opened on 2026-08-22.

It does not turn a paper result, API existence, source string, or green unit test into a Bimax
capability. The binding status vocabulary remains Implemented, Measured, Product-ready, Target,
and Win.

## Executive correction

The useful shape of the drafts survives: trust below perception, semantic actions before physical
input, visual recovery before stop, fresh verification after every mutation, and measured adoption
of optional memory/ML layers. The drafts were not safe to implement verbatim.

The main corrections are:

1. The later Bimax record supersedes the early Spotify sample. Spotify's one-element tree was a
   temporal-readiness observation, not proof of a permanently AX-blind app. No app-specific routing
   or “tree wake fixes Spotify” claim is allowed.
2. `AXManualAccessibility` is the documented Electron attribute. Bimax already attempts it once per
   pid through the packaged helper; a second Swift implementation would duplicate ownership.
   Electron PR #38102 fixed the old false-failure behavior, so “may report failure on success” is
   historical, not the current contract. `AXEnhancedUserInterface` remains an unstandardized,
   separately measured experiment and is not a general fallback requirement.
3. The packaged compatibility freeze was a policy with tests but no production caller. Before this
   plan, `server.ts` always registered the compatibility-backed `mac_control`. That invalidated the
   drafts' `[SHIPPED]` claim. Phase 0 now fails closed in packaged mode while retaining the lab path
   in development.
4. Native service tools are not yet the product's single logical `mac_control`. Publishing the
   low-level tools directly would violate the explicit Control Mac allow-list. A native logical
   adapter is therefore Phase 1, ahead of latency features.
5. P3 is a deterministic contract gap first: the caller must declare or derive a checkable
   postcondition and the runtime must verify it. A language-model “world simulation” is optional
   rehearsal, not a substitute for an independent postcondition.
6. Paper and third-party performance numbers are hypotheses for experiment sizing. Bimax adoption
   uses its frozen denominator and supported-device matrix; it does not inherit reported gains.
7. MacArena has 421 verified tasks across 50 apps and was accepted to the AIWILD workshop at ICML
   2026, not the ICML main track. “BJudge October 2026” was wrong: arXiv:2510.02250 was submitted in
   October 2025 and revised in February 2026.
8. Foundation Models' macOS 27 APIs are beta-era optional accelerators. Bimax supports macOS 13, so
   no core CU admission, safety, or verification path may depend on them.
9. Regex injection screening is evidence, not a security boundary. The security phase needs typed
   untrusted observations, a trusted task/plan boundary, branch auditability, and adversarial
   end-state fixtures.
10. Cua Driver documents background delivery, but its macOS implementation also documents private
    SkyLight/SPI techniques. It is competitive evidence, not a source to copy or a public-release
    architecture to adopt without license, provenance, OS-version, signing, and App Review review.

## Corrected stack

| Plane | Current status | Contract |
|---|---|---|
| 0. Product and trust boundary | Implemented locally; production-routing regression corrected in Phase 0; release proof Target | Bimax for Mac is the only CU owner. One `mac_control`, takeover latch, approvals, receipts, no Terminal CU, no silent compatibility path. |
| 1. Observation identity | Implemented locally, broader real-app measurement Target | Exact app/pid/window, frame generation, screenshot-pixel coordinates, bounded stores, stale-handle refusal. |
| 2. Perception | AX/menu/OCR/window capture Implemented locally; unified scene Target | Prefer fresh semantic evidence. Menu proves commands, never content. Vision is eligible when semantics do not represent requested content. |
| 3. Grounding | Semantic resolution/text folding/menu paths/frame binding Implemented locally; ROI/local grounder Target | Refuse ambiguity. Every pixel target is bound to the full source frame and revalidated before delivery. |
| 4. Execution | Semantic/physical/visual/stop locally exercised; packaged logical-native adapter Target | Descent-only ladder. Physical input requires an explicit foreground lease. Production never activates a compatibility backend. |
| 5. Verification | Receipt machinery Implemented; model-to-postcondition contract incomplete | Performed is not proven. A new observation and independent evaluator must establish the requested end state. |
| 6. Reliability and latency | Settler/bounds Implemented; packaged session/P6 diagnosis and cache experiments Target | Fix process/session correctness before optimizing. Measure cold start, warm action, observe, capture, and verification separately. |
| 7. Adversarial security | Deterministic sensitive floors partly Implemented; observation quarantine Target | Screen text is untrusted data. It cannot grant authority, rewrite the task, or widen the plan. |
| 8. Workflow memory | Target | Store only receipt-backed journeys; replay is a hint; reobserve every step; invalidate on app/window/fingerprint drift. |
| 9. Programmatic/native sources | Target | Shortcuts/JXA/broker work remains inside app-owned `mac_control`, with the same approval and receipt contract. Engine shell is not re-enabled in Control Mac turns. |
| 10. Optional local AI and training | Research Target | Foundation Models, FastVLM/MLX, trajectory export and fine-tuning are capability-detected experiments after the base product passes. |

## Evidence verdict

### Verified platform facts

- Electron documents programmatic `AXManualAccessibility` for third-party macOS assistive tools.
- ScreenCaptureKit supplies a desktop-independent single-window filter and one-shot screenshot APIs.
  Apple documents the API shape, not Bimax's latency or universal occlusion behavior.
- Apple documents the `shortcuts` CLI and warns that shortcuts which request input pause waiting for
  it. Bimax's timeout/refusal policy is a product synthesis.
- Apple documents Foundation Models on macOS 26 and the macOS 27 additions: dynamic profiles,
  model protocol, multimodal prompting, OCR/barcode tools, token accounting, `fm`, and Python.
- Apple publishes FastVLM research and Apple-Silicon-compatible 0.5B, 1.5B and 7B artifacts. Its 85×
  result is against a named research baseline, not a Bimax performance claim.

### Verified research directions, not reproduced Bimax results

- VPI-Bench: 306 cases across five platforms; reported attacks reach 51% for CUAs and 100% for
  browser agents on some platforms.
- CaMeLs Can Use Computers Too: pre-observation branching plans provide control-flow integrity but
  remain vulnerable to branch steering; reported utility is “up to” 57% of frontier performance.
- CoAct-1: programmatic execution can reduce brittle GUI steps, but its open shell/programmer shape
  conflicts with Bimax's current Control Mac authority gate.
- Agent Workflow Memory and OpenCUA support workflow induction and receipt-to-trajectory research;
  neither proves that Bimax replay is safe.
- WebDreamer supports model-based planning as an optional risk/efficiency experiment; its web result
  does not establish macOS action safety.
- Agent JIT Compilation and Scaling Agents for Computer Use support typed invariants, scheduling and
  trajectory judges. Their reported results remain author-reported external baselines.
- MacArena is the right external macOS comparator; Bimax's internal fixtures remain the release
  denominator until a licensed, reproducible adapter exists.

### Downgraded or removed claims

- Removed: inherited “85% prompt-cache,” “40–50% image-token,” “~600 ms production step,” “~12 ms
  capture,” “28× MLX cache,” and “38 actions to 4” as requirements. They may be experiment notes only.
- Removed: a universal claim that pure vision beats AX-augmented grounding. Benchmark/task/model
  context matters; Bimax keeps both and measures the routing policy.
- Removed: “all Tier 0 shipped,” “compat freeze shipped,” “session dies after every action today,”
  and “tree wake is the highest-value feature” as current facts. The first was too broad, the second
  false in source, and the last two require current packaged reproduction.
- Corrected: Agent Workflow Memory is arXiv:2409.07429; the searched primary page does not establish
  the draft's “ICML 2025” label.

## Delivery phases

### Phase 0 — truth and fail-closed release routing (started 2026-08-22)

Scope:

- bind provider registration to the production-routing decision;
- development may retain compatibility/native lab surfaces;
- packaged mode exposes one structured, visible blocked `mac_control` and no low-level acting tools
  until the native logical adapter exists;
- preserve tests that kill deletion of this branch;
- correct the gap register and source ledger.

Exit: a packaged provider can never act through compatibility or widen authority. This deliberately
blocks packaged CU; it is not a Product-ready result.

### Phase 1 — native logical `mac_control` and packaged session reliability

Scope:

- place native observe/action/capture/workspace operations behind the existing `MAC_CONTROL_SCHEMA`
  or a versioned successor without exposing additional acting tools;
- translate every logical verb to the four-rung ladder and existing receipts;
- reproduce P0 over the compiled stdio provider with 10 sequential reads/actions, a native service
  restart, and a provider restart; record failures before changing session ownership;
- make P6 deterministic by removing live environmental assumptions from the release gate and keeping
  live-app qualification as a separate matrix;
- unblock packaged registration only after native availability and adapter conformance pass.

Exit: packaged `tools/list` contains exactly the allowed logical surface, compatibility signatures
are absent, 10-call/restart journeys pass, and deleting the adapter/freeze causes the gate to fail.

### Phase 2 — deterministic completion and safe delivery

Scope:

- require a typed postcondition for every mutating logical action;
- derive only bounded deterministic defaults for verbs with obvious outcomes; otherwise stop and ask;
- extend destructive/sensitive floors across semantic, menu, physical, visual, and programmatic paths;
- verify the end state from a new observation; narration and action acceptance never count;
- measure foreground/background truth per action and keep physical input foreground-only.

Exit: semantic, physical, visual, menu and stop fixtures each kill a false-success mutant; P3 no
longer renders “not requested” for an accepted mutation.

### Phase 3 — perception readiness and measured latency

Scope:

- retain the existing one-attempt-per-pid Electron accessibility request; measure before/after tree
  quality and raw AX errors instead of assuming success;
- classify warming/background-restricted/ready per observation, never per app identity;
- add revision-aware AX caching only after notification-loss and poisoned-cache mutants exist;
- benchmark cold provider start, warm observe, capture and verification separately;
- trial differential frames, batching, prefetch and prompt ordering one at a time.

Exit: each adopted optimization meets a predeclared reliability/latency budget on the frozen corpus;
no optimization changes the action authority or stale-frame rules.

### Phase 4 — untrusted observation boundary

Scope:

- type OCR/AX/page text as untrusted observation data;
- bind the trusted task and allowed branch graph before incorporating untrusted content;
- record branch choices and refuse actions whose authority originates only in screen text;
- add VPI/WASP-inspired local fixtures, benign bidi/localization controls, and exfiltration targets;
- keep model/regex detectors advisory behind deterministic authority checks.

Exit: injection mutants cannot widen tools, recipients, destinations or destructive scope, while
benign application content remains usable within a measured false-positive budget.

### Phase 5 — receipt-backed journeys and trajectory export

Scope:

- store versioned, bounded, private journey records in Desktop-owned application data;
- retrieve by app + normalized intent; replay through the normal ladder;
- reobserve and revalidate every step; invalidate on app version, target window, semantic fingerprint
  or frame drift;
- export redacted trajectories only with explicit retention/export controls.

Exit: replay improves a repeated journey without stale-coordinate action; a poisoned fingerprint,
takeover between steps, revoked permission, or changed app state aborts safely.

### Phase 6 — additional app-owned execution sources

Scope:

- evaluate Shortcuts, JXA/application dictionaries, keyboard navigation, and clipboard transactions;
- keep each behind `mac_control`, broker limits, takeover, approval and independent verification;
- never re-enable Terminal or engine shell/file mutation during an explicit Control Mac turn.

Exit: each source has provenance, timeouts, privacy behavior, exact postcondition proof and rollback
where mutation is reversible.

### Phase 7 — optional local AI, rehearsal and training

Scope:

- capability-detect macOS 26/27 Foundation Models and never make it a base dependency;
- compare deterministic baseline, Foundation Models and candidate FastVLM/MLX workers on quality,
  latency, memory, energy proxy, model size and failure behavior;
- trial rehearsal only as an additional check for high-risk actions; disagreement stops rather than
  authorizing action;
- begin fine-tuning only after dataset consent, redaction, licensing and a sufficient receipted corpus.

Exit: supported-device artifacts pass quality/safety/resource budgets and removing the optional model
leaves the complete base CU product functional.

## First implementation record

Phase 0 source change:

- `app/src/capabilities/mac/server.ts` now consults `production.routing.ts` through the exported
  `buildMacCapabilityTools` seam.
- Development retains the existing compatibility lab surface.
- Packaged mode exposes only a structured blocked `mac_control`: `native_tools_unavailable` when the
  native cutover cannot be proven, or `native_logical_adapter_pending` when native tools exist but
  are not yet behind the logical authority.
- Low-level native tools are not published in packaged mode.
- `computer.production.server.routing.test.ts` kills silent fallback and low-level-tool publication.

Status: Implemented and focused-unit-tested. Not Measured, not Product-ready. Phase 1 is required to
restore packaged Control Mac functionality without violating the product boundary.

## Primary sources re-opened 2026-08-22

- [Electron accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility)
- [Electron PR #38102](https://github.com/electron/electron/pull/38102)
- [Apple ScreenCaptureKit sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
- [Apple SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)
- [Apple Shortcuts command line guide](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac)
- [Apple Foundation Models updates](https://developer.apple.com/documentation/Updates/FoundationModels)
- [Apple macOS 27 overview](https://developer.apple.com/macos/whats-new/)
- [Apple FastVLM research](https://machinelearning.apple.com/research/fastvlm-efficient-vision-encoding)
- [Apple FastVLM repository](https://github.com/apple/ml-fastvlm)
- [VPI-Bench](https://arxiv.org/abs/2506.02456)
- [WASP](https://arxiv.org/abs/2504.18575)
- [CaMeLs Can Use Computers Too](https://arxiv.org/abs/2601.09923)
- [CoAct-1](https://arxiv.org/abs/2508.03923)
- [Agent Workflow Memory](https://arxiv.org/abs/2409.07429)
- [WebDreamer](https://arxiv.org/abs/2411.06559)
- [OpenCUA](https://arxiv.org/abs/2508.09123)
- [Agent JIT Compilation](https://arxiv.org/abs/2605.21470)
- [Scaling Agents for Computer Use](https://arxiv.org/abs/2510.02250)
- [MacArena](https://arxiv.org/abs/2606.06560)
- [Cua Driver contracts](https://github.com/trycua/cua/blob/main/docs/content/docs/reference/cua-driver/contracts.mdx)

## Acceptance-gate mapping

- Product owner: Bimax for Mac only; Terminal inventory remains CU-free.
- Desktop CU: one logical acting authority, packaged compatibility frozen, fresh observation,
  semantic/physical/visual/stop coverage, takeover, receipts, background truth.
- Contextual intelligence: untrusted evidence cannot create an unqualified safe verdict.
- Modular ecosystem: new execution sources remain digest/provenance/authority bounded and outside
  the renderer.
- Release: no Product-ready claim until clean-Mac TCC, signing/notarization channel, update behavior,
  and broad live-app journeys pass.
