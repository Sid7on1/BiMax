# 56 — Apple platform and performance plan (macOS 27 Golden Gate)

**Status: proposal.** Written 2026-09-19 against `c8f8056`, on the machine that ships it:
macOS 27.0 (26A428), Apple M3, 4 performance + 4 efficiency cores, 8 GB.

Two things this record refuses to do, because this repo has been burned by both before:

- It does not name a performance number that was not measured here. Anything unmeasured is
  labelled **UNMEASURED**, and the first work item is the measurement, not the fix.
- It does not propose a capability without naming the gate that proves it is reachable from the
  shipped artifact. Bimax has shipped a loader that was complete, tested and never called
  (custom slash commands), and a sidecar stub that `exit 1`'d through every green gate
  (v1.1.0). Apple integrations fail in exactly that shape.

---

## 0. Verdict

**Yes — but not "optimisation" in the sense of making the existing code faster.** Measured at
idle, this app is already cheap: the whole Bimax process tree sits at **0.4% of one core** with
six processes resident (`ps aux`, 2026-09-19). There is no idle-burn emergency to fix.

The real opportunity is a different one, and macOS 27 is the reason it exists now:

1. **The adaptive machinery we already built is half-connected.** The CPU half reaches the
   engine. The GPU/rendering half is computed every 30 seconds and thrown away. Finishing that
   wire is cheap and is the only *pure* optimisation worth doing first.
2. **macOS 27 turned two of our hardest problems into system frameworks.** `MLXLanguageModel`
   makes local models a first-class backend instead of our hand-rolled Ollama probing, and
   App Intents App Schemas make Bimax reachable from Siri and Spotlight without us inventing an
   automation surface.
3. **We have no load measurement at all.** Not one Bimax path has a CPU or GPU baseline. That
   is the same gap `bimax-fast-code-stages-0-3` recorded for latency, and MetricKit +
   StateReporting (both new in 26/27) close it without us building a telemetry stack.

Do them in that order. Step 1 is days. Step 3 is what makes steps beyond it honest.

---

## 1. What is true today (facts, with sources)

### Already built, and working

| Thing | Where | State |
|---|---|---|
| Thermal state from the OS, event-driven | `app/src/main/index.ts:1222` — `powerMonitor.on('thermal-state-change')` | Live. This is `NSProcessInfo.thermalState` via Electron, free and push-based. |
| Adaptive background-concurrency policy | `app/src/phase9/adaptive.policy.ts` | Live, canary on by default. Reaches the engine at `app/src/main/index.ts:993` via `engineEnvironment()`. |
| Corrected memory sensor | `app/src/main/supervisor/resources.ts:availableBytes` | Live. Counts file-backed + purgeable, after `os.freemem()` under-read by 26×. |
| Capability ladder (`full`/`conservative`/`minimal`) | `app/src/main/supervisor/resources.ts` | Live. |
| Engine-side power governor | `src/governor/power.monitor.ts` | Live *only* when `BIMAX_POWER_AWARE=1`, which the adaptive canary sets. Consumer: `src/tools/implementations/spawn.tool.ts:123`. |
| On-device dictation, Apple `SpeechAnalyzer` | `app/native/voice/main.swift` (485 lines, macOS 26 `DictationTranscriber`) | Live, shipped as an `extraResource`. **This is the proof that a native Swift helper is a workable pattern here.** |
| Accessibility media queries | `app/src/renderer/src/styles.css` — `prefers-reduced-transparency`, `prefers-contrast`, `prefers-reduced-motion` | Live and thorough (7 blocks). |
| Vibrancy suspended when it cannot pay for itself | `app/src/main/index.ts` `sendChrome()` — `setVibrancy(null)` full-screen/zoomed | Live. Good instinct; generalise it (§2.2). |

### Defects and gaps found while reading

**D1 — The rendering half of the adaptive policy is dead.**
`adaptiveSnapshot()` calls `renderingPolicy(signals, false)` with the canary flag hardcoded to
`false` (`app/src/main/index.ts:820`). `RenderingDecision` is declared in
`app/src/renderer/src/global.d.ts:17` and **no renderer component reads it**. So
`preferredFps: 30` and `nonessentialAnimation: false` are computed every 30 s, broadcast over
IPC, and discarded. The GPU side of our own adaptive design has never run once. This is the
`bimax-custom-slash-commands` shape again.

**D2 — WITHDRAWN 2026-09-19, on inspection. The finding was wrong.**
It read: "three 1-second `setInterval`s re-render React while nothing is happening"
(`CapabilityBanner.tsx:26`, `ThreadSurfaces.tsx:158`, `ThinkingIndicator.tsx:48`). All three are
already gated on real activity, and none of them runs at idle:

- `CapabilityBanner` starts its interval only when `expiring` — a turn-scoped notice is on screen.
- `ThreadSurfaces` starts its elapsed clock only when `busy`.
- `ThinkingIndicator` is mounted only by `{busy && !streaming && …}` (`Transcript.tsx:147`).

So there is no idle timer burn to reclaim, and the 0.4%-at-idle measurement was never in tension
with anything. The two survivors of this finding are narrower and are folded into §2.1:

- The verb rotation (2.6 s) and its 320 ms `requestAnimationFrame` decode scramble are genuinely
  *decorative*, and are the right thing for a `quiet` rendering mode to stop. They already bail
  out under `prefersReducedMotion()`.
- The elapsed counter and the notice-expiry clock are *informational* — they communicate state, so
  by §2.1's own rule they must keep running even in `quiet`.

Recorded rather than quietly deleted because the original claim was used to justify a work package
(57 WP-3), and that package was withdrawn on the strength of this.

**D3 — The engine forks `pmset` twice per 30 s, per engine, to learn what the parent already knows.**
`src/governor/power.monitor.ts:readDarwin()` shells out to `pmset -g batt` and `pmset -g therm`.
The main process already holds both facts, push-based and free. With four live Bimax Threads
(`MAX_LIVE_ENGINES`, the memory budget — not the worker budget; see AGENTS.md) that is 16 forks
per minute.
**MEASURED here: 20 `pmset` forks cost 0.12 s wall / 0.07 s CPU.** So the real cost is about
**0.23% of one core**, amortised. That is small — it is *not* a headline, and this record will
not pretend otherwise. It is listed because the fix is to delete code, not add it: pass the
parent's thermal/power state down the existing spawn env instead.

**D4 — Our glass is ours, so macOS 27's new Liquid Glass slider will not move it.**
macOS 27 ships a user-facing transparency slider (Settings → Appearance → Liquid Glass). Apps
built on system materials follow it with no code change. The main window uses
`vibrancy: 'sidebar'` (which *will* follow it) but the surfaces on top of it are **23
`backdrop-filter` declarations in `styles.css`**, which will not. Result: when a user drags that
slider, Bimax's chrome moves and Bimax's panels do not. `electron-liquid-glass` is attached only
to the ⌘2 bar and the approval popup (`auxiliaryWindow()`), not the main window.
This corroborates `bimax-macos-27-golden-gate`: the system material is the free path.

**D5 — No App Intents, no Shortcuts actions, no Spotlight contribution.**
Confirmed by grep across `app/` and `src/`: the only automation surface is the `bimax://task`
URL scheme (`app/src/main/bimax.link.ts`). Backlog 48 already records this as missing.

**D6 — `minimumSystemVersion: "13.0"`, but the voice helper needs macOS 26.**
`app/electron-builder.yml`. Everything in this plan is 26+/27-only. The floor is not wrong, but
every Apple capability below has to degrade cleanly on a 13–25 Mac, and that has to be tested,
not assumed.

**D7 — Zero CPU/GPU baseline.** No Bimax path has one. `bimax-fast-code-stages-0-3` deliberately
shipped operation counts instead of timings for this reason.

---

## 2. CPU and GPU, in the order worth doing

### 2.0 First: measure, or everything below is a guess

Nothing here gets a threshold constant until it has a number. `bimax-perf-constants-pinned-by-tests`
records two regressions that shipped because a test asserted the bad number, and
`bimax-live-engine-budget` records three of four tasks lost to a *guessed* 512 MB reserve.

Three traces, on this Mac, under a real task (index a repo, run a multi-step agent turn):

- **Instruments → Power** and **CPU Counters**: where the cores actually go, P vs E.
- **Instruments → Metal System Trace**: what the compositor pays per frame with the glass on.
- **`powermetrics --samplers cpu_power,gpu_power`**: package watts idle vs streaming.

Deliverable: a `docs/product-reset/` measurement appendix with real numbers, and a
`scripts/` capture recipe so it is repeatable. **No perf constant is written before this.**

### 2.1 Finish the rendering policy (D1) — the one cheap pure win

Give `renderingPolicy` the same canary treatment `AdaptiveRuntimePolicy` already has, and give
the renderer something to do with it:

- `mode: 'quiet'` → pause the decorative loops: `ThinkingIndicator`'s verb rotation, the talk
  orb, the morph controller's idle frames. Keep every animation that communicates state.
- `preferredFps: 30` → the morph controller (`components/ui/morph/controller.ts`) already owns a
  `requestAnimationFrame` loop; it is the single place to halve the frame budget.
- Fold D2 into it: the three 1-second tickers become one shared clock that the policy can stop.

Guard it the way this repo guards everything else: a test that asserts the *property* ("no
decorative timer fires while the policy says quiet"), never a timing.

### 2.2 Let the system pay for the glass (D4)

The direction is the one `sendChrome()` already took: when the material cannot buy depth, stop
paying for it. Generalise to three rungs, driven by the policy from 2.1 plus the accessibility
queries already in place:

1. **Full** — today's treatment, on AC, nominal thermal.
2. **Lean** — drop the `::before` perimeter pass (`styles.css:511`, a second `backdrop-filter`
   per glass surface, the most expensive thing in the file) and keep the body blur.
3. **Flat** — `backdrop-filter: none` + the veil colours, which the file **already implements**
   for `prefers-reduced-transparency` (`styles.css:1346`) and for no-`backdrop-filter` browsers
   (`styles.css:686`). The flat path exists and is tested; it just needs a second trigger.

Then re-run `npm run check:glass-contrast` — per `bimax-glass-veil-contrast` and
`bimax-contrast-checker-blind-spots`, a veil change is not done until that passes on more than
one page.

**Open question worth answering with 2.0's Metal trace:** whether moving the main window's
panels onto native `NSGlassEffectView` (via `electron-liquid-glass`, already a dependency and
already shipping on the ⌘2 bar) is cheaper than 23 CSS blurs *and* picks up the macOS 27 slider
for free. That would be the ideal outcome — less code, system-native behaviour, one less thing
to hand-tune. It is a measurement, not an assumption.

### 2.3 QoS: tell macOS which work is background

Neither the engine `utilityProcess` nor the child-process transport sets a QoS class
(`app/src/main/engine.ts`). Everything inherits the app's user-interactive class, so a
30-minute unattended indexing run asks for P-cores at the same priority as the keystroke the
user just typed. On a 4+4 M3 that is the difference between a warm laptop and a quiet one.

Electron exposes no QoS API. The reachable path is the one `bimax-voice` already proves: a tiny
Swift/`posix_spawn` shim, or `pthread_set_qos_class_self_np` called inside the engine for its
background pools. **UNMEASURED** — 2.0's CPU Counters trace should show the P/E split first, and
if background work is already landing on E-cores this is not worth building.

### 2.4 Delete the duplicate power sensor (D3)

Pass `thermal` and `powerSource` from main down the spawn env that already exists at
`app/src/main/index.ts:993`, and let `PowerMonitor` prefer them over forking `pmset`. Keep the
`pmset` reader as the fallback for the CLI/headless path, which has no parent to ask. Net: less
code, one sensor, and the two halves of the app can no longer disagree about the thermal state
— the same failure `availableBytes()` was written to end.

---

## 3. What macOS 27 offers that we are not taking

### 3.1 Foundation Models + `MLXLanguageModel` — the MLX answer

This is the headline, and it lands exactly on a problem we already solved badly.

`app/src/main/local.models.ts` (220 lines) exists to answer "what can this Mac serve right now?"
by probing Ollama, LM Studio, llama.cpp and the Hugging Face cache, and it carries a careful
`servable` flag because a downloaded model is not an endpoint. That file is good engineering
against a bad situation.

macOS 27 removes the situation. The Foundation Models framework now sits behind a
`LanguageModel` protocol with conforming backends: the on-device system model, Private Cloud
Compute, Core AI for custom weights, and **`MLXLanguageModel`, which loads any `mlx-community`
Hugging Face model straight onto the Mac's GPU and Neural Engine**. Streaming, tool calling,
structured output and multi-turn sessions are identical across backends.

What that means for Bimax, concretely:

- **MLX-friendly is a backend, not a project.** ~4,800 community models become selectable in the
  existing model picker, with no Ollama server to be running and no `servable` ambiguity —
  the framework either loads the weights or it does not.
- **It fits the harness thesis.** `bimax-weak-model-is-the-strategy` measured a 23.8pp harness
  spread and concluded weak models vary most. A local MLX 3B on the ANE is the cheapest weak
  model we will ever get, and every `mlx-community` quant is a free harness test case.
- **Tool calling comes with it.** `bimax-nameless-tool-call-json` and `bimax-tool-arg-validation`
  are both about weak models mangling the tool-call wrapper. Foundation Models' `@Generable`
  structured output is schema-enforced by the framework, which is a different and stronger
  guarantee than our JSON repair path.
- **Zero token cost, no network.** Straight into `bimax-sovereign-perimeter`: a model that never
  makes an egress call cannot violate the perimeter.

**Route:** a `bimax-fm` Swift helper, built and shipped exactly like `bimax-voice` — same
`scripts/build-voice.sh` shape, same `extraResources` entry, same JSON-lines-over-stdout
protocol the dictation helper already uses. It registers as one more provider behind the
existing model-picker seam. That seam has bitten us before
(`bimax-model-switch-seam`: the picker said "applied" and every request kept the boot model), so
the acceptance test is a live request whose *response* proves which backend answered — not a
config read-back.

**Also worth reading before building:** `Core AI` (custom weights, ahead-of-time compilation,
fine-grained inference memory control, zero-copy). Fine-grained inference memory control is
directly aimed at our recurring problem — `bimax-engine-crash-loop-large-repo`,
`bimax-live-engine-budget`, an 8 GB box that SIGKILLs children. A model runtime that lets us cap
its own memory is better than a governor guessing on its behalf.

### 3.2 App Intents + App Schemas — the Siri answer

**Yes, and it is more interesting for a coding IDE than it first sounds.** macOS 27's Siri is
built into Spotlight and reaches third-party apps through App Intents. Two halves:

- **Intent schemas** — actions phrased naturally, no fixed trigger phrases, understanding that
  improves across languages without us shipping anything. "Ask Bimax to fix the failing test in
  Bimax" becomes a real sentence, not a memorised incantation.
- **Entity schemas** — app content contributed to Spotlight's **semantic index**. This is the
  part worth wanting. Bimax already keeps threads, evidence (`evidence.store.ts`), an undo
  journal (`thread.undo.ts`) and per-model measured turn times. Contributed as entities, "what
  did Bimax change in the parser yesterday?" becomes a Spotlight query. No coding IDE does this.

Plus **View Annotations**, which map on-screen views to entities so Siri can act on what the
user is looking at — and the **AppIntentsTesting** framework, which validates the integration
through real system pathways rather than UI automation.

**The honest risk.** App Intents are discovered from Swift metadata in the app bundle. The
documented failure for a non-Swift host app is that the intents compile into a standalone Swift
library that is never linked, embedded or copied in — so macOS never discovers the action, and
every build stays green. That is `bimax-packaging-guard-is-dead` and
`bimax-packaged-artifact-untested`, third and fourth recurrence.

So the gate comes first: **a packaging test that runs `shortcuts list` (or resolves the intent)
against the built `.app` in `release/`, and fails the build when the action is absent.** Write
the gate before the Swift.

**Ship order:** `bimax://task` already exists, so a Shortcuts *"Open URL"* action works today and
costs an afternoon of documentation. Do that first as the honest stopgap, then the appex.

### 3.3 MetricKit + StateReporting — closes D7 without a telemetry stack

MetricKit was rebuilt for 26/27 with a Swift-first API and daily reports covering launch time,
hangs, CPU, memory, GPU, disk writes, network and display metrics. The new **StateReporting**
API annotates those metrics with *the app's own state*, and the Points of Interest instrument
validates that the reported states match reality before shipping.

For Bimax that means CPU and GPU numbers attributable to `indexing` vs `streaming a turn` vs
`idle with the panel open` — which is precisely the denominator `bimax-cu-baseline` had to build
by hand for computer use, handed to us by the OS.

It also feeds the learning loop. `bimax-learning-substrate-starved` measured 0 claims and 17
errors, with the miner blind to loop-level pathologies. "This model configuration costs 3× the
GPU for the same result" is exactly a loop-level pathology, and StateReporting is the sensor
that can see it.

### 3.4 The Foundation Models Instruments template

Xcode 27's Foundation Models template shows sessions → requests → inferences → instructions →
prompts → responses on a timeline, with tool calls, instruction handoffs, **time to first
token**, **tokens per second** and total latency, and an info column flagging errors, long
durations and large token counts.

Caveat, stated because I checked: that template does **not** report CPU, GPU or ANE utilisation.
For hardware numbers it is Power / CPU Counters / Metal System Trace (§2.0). The FM template is
the *agent-shape* profiler, and it only covers work that goes through Foundation Models — which
is another argument for 3.1, since routing local inference through FM makes our agent loop
visible to Apple's tooling for free.

Note also: **trace files contain prompt text.** Anything captured goes in the scratchpad, never
the repo. `PRIVACY.md` should say so before anyone captures the first trace.

### 3.5 The Evaluations framework

New in 26/27: verifies AI features across dynamic conditions, with a hill-climbing workflow for
prompt improvement. We already have `benchmarks/`, `npm run benchmark:models` and a retrieval
benchmark. Worth an evaluation — but `bimax-cu-baseline` is emphatic that **a benchmark must
never persist a healed model**, and the honest read is that our harness-centric measurement may
already be stronger than a generic eval framework for our case. Read session 298/299 before
adopting; do not adopt reflexively.

### 3.6 Liquid Glass and the transparency slider

Covered as D4/§2.2. One extra: macOS 27 also changed window shadows for hierarchy, and apps on
system materials get all of it with no recompile. Every pixel we hand back to the system is a
pixel we stop maintaining — and `bimax-front-inspo-baseline` already closed R1–R4/B1–B5, so the
custom layer has served its purpose and can start shrinking.

---

## 4. Our unusual approaches — normalise, keep, or make novel

The ask was: make the unusual things standard, and add novelty. These are not the same list.
Some of our oddities are debt. Some are the product.

### Normalise (unusual because we had no better option; macOS 27 or the industry now has one)

| Ours | Standard replacement | Why now |
|---|---|---|
| Probing four local runtimes for `servable` models (`local.models.ts`) | Foundation Models `LanguageModel` / `MLXLanguageModel` | §3.1. The probe exists because there was no protocol. Now there is. |
| `bimax://task` as the whole automation surface | App Intents + Shortcuts | §3.2. Keep the URL scheme as the fallback and for non-Apple callers. |
| Forking `pmset` for battery and thermal | The parent's `NSProcessInfo` state, already held | D3/§2.4. |
| 23 hand-tuned `backdrop-filter` passes | `NSGlassEffectView` / system vibrancy where it measures cheaper | D4/§2.2. |
| No CPU/GPU baseline anywhere | MetricKit + StateReporting + Instruments | §3.3. |
| Two `desktop.runtime.ts` copies with no sync gate (`bimax-runtime-copies-drift`) | One source, one build input | Not an Apple item — it is the plainest debt on the list, and it will sabotage any Apple integration that has to ship in both. |
| `--format=cjs` in `lib-build.sh` producing a non-booting binary (`bimax-cjs-flag-now-breaks-engine`) | What `package.json` already does and works | Same category. Fix before adding a Swift helper to the build. |

### Keep — unusual and correct

These read as odd to an outsider and are load-bearing. Do not let a standardisation pass eat them.

- **The engine inside Electron as a `utilityProcess`** (`bimax-engine-in-electron`). No binary, no
  download, no `engine.lock`. Nearly every competitor ships a sidecar it then has to version,
  sign and repair. This is simply better, and it is why `bimax-engine-lock-points-nowhere`
  stopped being a problem.
- **Move, don't delete** (`bimax-move-dont-delete`). `cmp`-verified archive at a mirrored repo
  path. Unusual, and it has already saved this repo once (`bimax-recovery-resurrected-deletions`).
- **The sovereign egress perimeter** (`bimax-sovereign-perimeter`) — patching `fetch`/`http`/`net`/
  `dns` at boot rather than trusting call sites. The industry writes a policy doc; we wrote an
  interceptor. A local MLX model (§3.1) makes the guarantee complete rather than merely enforced.
- **The design-preview harness** (`bimax-design-preview-harness`) — every theme × window state at
  once, real components, stubbed IPC, no Electron launch. Most teams screenshot the running app.
- **Weak models as the strategy** (`bimax-weak-model-is-the-strategy`). Contrarian, measured at
  23.8pp, and §3.1 makes it cheaper rather than obsolete.
- **Ad-hoc service trust by `cdHash`** (`bimax-adhoc-service-trust`) — seal-verified, consent
  stored per hash, never an env var. Stricter than what most shipping apps do.

### Novelty — things macOS 27 makes possible that nobody has shipped

Ranked by "distinctive *and* reachable from where the code actually is".

1. **A coding agent in Spotlight's semantic index.** Entity schemas over threads, evidence and
   the undo journal, so "what did Bimax change in the parser yesterday?" is a system-wide query
   answered from Bimax's own memory. Every competitor's history is trapped in its own window.
   Builds on §3.2 and on stores that already exist.
2. **Thermal-honest agency.** Not "throttle when hot" — *say so*. The agent tells you it is
   running a 3B MLX model on the ANE right now because you are on battery at 18%, and offers the
   cloud model as a choice. We already compute the decision and already have the reasons array
   (`AdaptiveDecision.reasons`); it is currently only visible in a Machine Health dialog. Making
   the trade-off legible and reversible in the moment is the product, and it is
   `bimax-error-must-name-real-cause` applied to resource policy.
3. **A local model as the always-on second opinion.** A zero-cost, zero-network MLX model that
   watches the cloud model's tool calls and flags the failure shapes we have already catalogued
   — bare-args JSON, a gate proven by the model's own query
   (`bimax-circular-gate-proof`), an unneeded action offered as proof. Cheap because it is local,
   and it feeds the starved learning substrate with the loop-level pathologies the miner cannot
   currently see.
4. **Evidence-backed voice.** `bimax-voice` already does on-device dictation with contextual
   hints. Siri AI plus our own evidence store means "read me what changed" answered from
   receipts, not from a summary the model wrote about itself.
5. **A published resource contract.** Ship the StateReporting-derived numbers: what Bimax costs
   per state, on which chip. No agentic IDE publishes its own energy profile. On an 8 GB laptop
   that is not marketing — it is the deciding factor, and this repo has the measurement culture
   to back the claim.

---

## 5. Sequence

**Now (days) — pure optimisation, no new surface**
1. §2.0 measure: Power, CPU Counters, Metal System Trace, `powermetrics`. Write the appendix.
2. §2.1 connect the rendering policy; fold the three 1-second tickers into one stoppable clock.
3. §2.4 delete the duplicate `pmset` sensor.
4. Fix `bimax-runtime-copies-drift` and the `--format=cjs` flag before anything new enters the build.

**Next (1–2 weeks) — the free platform win**
5. §2.2 glass rungs, driven by the now-live policy; re-run `check:glass-contrast`.
6. Measure native `NSGlassEffectView` on the main window against 23 CSS blurs. Adopt only if it wins.
7. Document Shortcuts-via-`bimax://` as the interim automation story.

**Then (weeks) — the two flagships, gate first**
8. **Write the App Intents packaging gate** — resolve the intent against the built `.app`, fail
   the build when absent. Then the appex, then intent schemas, then entity schemas.
9. **`bimax-fm` helper** on the `bimax-voice` pattern: Foundation Models + `MLXLanguageModel`
   behind the existing provider seam. Acceptance = a live response that proves which backend
   answered.
10. MetricKit + StateReporting once there are states worth naming.

**Ordering note.** Backlog 48 puts the RAG upgrade (record 50) first, then F8, then F1 + Q1–Q4.
Nothing here displaces that. §2.1–§2.4 are small enough to interleave; §3.1 and §3.2 are the
next flagship *after* 48's, and this record does not claim otherwise — that is the owner's call.

---

## Sources

- [What's New — macOS, Apple Developer](https://developer.apple.com/macos/whats-new/)
- [WWDC26 macOS guide](https://developer.apple.com/wwdc26/guides/macos/)
- [WWDC26 Apple Intelligence guide](https://developer.apple.com/wwdc26/guides/apple-intelligence/)
- [Core AI — Apple Developer](https://developer.apple.com/core-ai/)
- [Debug and profile agentic app experiences with Instruments (WWDC26 243)](https://developer.apple.com/videos/play/wwdc2026/243/)
- [Meet the new MetricKit (WWDC26 222)](https://developer.apple.com/videos/play/wwdc2026/222/)
- [Track performance by app state using MetricKit](https://developer.apple.com/documentation/metrickit/track-performance-by-app-state-using-metrickit)
- [App Intents — Apple Developer Documentation](https://developer.apple.com/documentation/appintents)
- [Energy Efficiency Guide for Mac Apps: Respond to Thermal State Changes](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/RespondToThermalStateChanges.html)
- [Electron powerMonitor API](https://www.electronjs.org/docs/latest/api/power-monitor)
- [macOS 27 Golden Gate — MacRumors roundup](https://www.macrumors.com/roundup/macos-27/)
- [How Liquid Glass Is Changing in iOS 27 / macOS 27 — MacRumors](https://www.macrumors.com/2026/06/10/how-liquid-glass-is-changing-in-ios-27/)
- [MLX as a first-class Foundation Models backend](https://medium.com/@nuthalapativarun/mlx-is-now-a-first-class-citizen-in-apples-ai-stack-run-any-hugging-face-model-through-foundation-9dfb8dad2191)
- [Exploring LLMs with MLX and the Neural Accelerators in the M5 GPU — Apple ML Research](https://machinelearning.apple.com/research/exploring-llms-mlx-m5)
