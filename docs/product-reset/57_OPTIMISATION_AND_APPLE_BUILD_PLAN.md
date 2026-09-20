# 57 — Optimisation and Apple platform: build plan

**Status: approved to build, 2026-09-19.** Companion to
[56](56_APPLE_PLATFORM_AND_PERFORMANCE_PLAN.md), which holds the research and the measurements.
This record is the work breakdown: what changes, where, and the gate that proves it.

Every work package below states an **acceptance gate**. A package is not done when its code is
written; it is done when its gate runs against the thing that ships. This repo has shipped a
loader that was complete, tested and never called, and a sidecar that `exit 1`'d through every
green gate. The gate is the deliverable.

---

## WP-0 — Name the three things (blocking, do first)

The word "thread" currently means three different things in this repository, and two of them are
resource caps that were never reconciled *because* the word hid the difference. WP-3 exists only
because of this.

### The glossary

| Term | What it is | Where | Cap |
|---|---|---|---|
| **Bimax Thread** | **The product feature.** A folder-bound conversation that runs instantly in the ⌘2 floating bar, with its own engine process, history, approval namespace and undo journal. Also how a project window runs (`origin: 'project'`). | `app/src/main/thread.manager.ts`, `app/src/shared/threads.ts` | `MAX_LIVE_ENGINES = 4`, derived from measured free memory by `maxLiveEngines(freeBytes)` — a **memory** budget |
| **sub-agent worker** | A real Node `worker_threads` `Worker`, i.e. an actual OS thread. | `src/core/subagent.manager.ts:132` | `MAX_CONCURRENT_SUBAGENTS = 4` (`src/core/subagent.capacity.ts:6`) — a **CPU** budget |
| **core** | Hardware. `os.cpus().length` → `RuntimeSignals.cpuCount`. This Mac: 8 (4 performance + 4 efficiency). Apple Silicon has no SMT, so a logical core is a physical core. | `app/src/phase9/adaptive.policy.ts` | — |

### The rule

- **"Thread", unqualified, in prose, UI copy, comments and commit messages, means the product
  feature.** It is capitalised as *Bimax Thread* on first use in a document.
- CPU concurrency is **never** called a thread. It is a **worker** (ours) or a **core** (the
  machine's).
- A cap must name its resource in its own identifier or its doc comment: `MAX_LIVE_ENGINES` is a
  memory budget over Bimax Threads; `MAX_CONCURRENT_SUBAGENTS` is a CPU budget over workers.

### Changes

1. Add the glossary to `AGENTS.md` as a short section, so it binds every future change.
2. Correct the doc comments on both caps to name their resource and to cross-reference each other.
3. Correct record 56's D3, which says "the 4-thread cap" where it means four live Bimax Threads.

**Acceptance gate:** a grep check in CI — no new occurrence of `thread` within three tokens of
`cpu`, `core`, `worker`, `pool` or `concurren*` outside the glossary itself. Cheap, and it is the
only thing that stops the collision coming back.

---

## WP-1 — The two caps multiply (new; found via WP-0)

**Defect D8.** The two caps are both the number 4 and govern different resources, and nothing
reconciles them.

- `AdaptiveRuntimePolicy.decide()` computes `desired = floor(cpuCount / 2)` — **3** on this
  8-core M3 — and emits it as `BIMAX_MAX_CONCURRENT_SUBAGENTS`
  (`app/src/phase9/adaptive.policy.ts:147`).
- That env is spread into **each engine spawn**, per Bimax Thread
  (`app/src/main/index.ts:993`).
- `runtimeConcurrentSubagentLimit(env)` reads it **per engine process**.
- The capacity ledger it is enforced against defaults to
  `stateDir('.bimax', cwd)/subagent-capacity.json` — **per folder**
  (`src/core/subagent.capacity.ts:52`). The desktop never sets `BIMAX_AGENT_CAPACITY_PATH`
  (verified by grep). Bimax Threads are folder-exclusive, so every live Thread has a different
  cwd and therefore its own independent ledger.

So the ceiling is per-Thread, not global. Worst case on this machine: **4 live Bimax Threads × 3
workers = 12 concurrent worker threads on 8 cores**, and without the canary, 4 × 4 = 16. The
policy that exists to protect an 8 GB laptop is computing a per-machine number and applying it
per-Thread.

**Fix.** One machine-wide worker budget, divided across live Bimax Threads rather than handed to
each of them:

- Point every engine at a **single shared capacity ledger** under the app's userData, by setting
  `BIMAX_AGENT_CAPACITY_PATH` in the spawn env at `app/src/main/index.ts:993`. The ledger is
  already a cross-process, fail-closed, O_EXCL-locked counting semaphore with expiring leases —
  it was built for exactly this and is simply not being pointed at a shared path.
- Keep the per-folder default for the CLI and headless paths, which have no app to coordinate them.

**Acceptance gate:** a test that starts two Bimax Threads in different folders and asserts the
*total* live worker leases never exceed the machine budget. Assert the property, not the number
(`bimax-perf-constants-pinned-by-tests`).

**Risk:** a shared ledger is a shared failure point. It is fail-closed by design, so the
degradation is refused sub-agents rather than over-subscription — the safe direction — but the
refusal message must name the real cause (`bimax-error-must-name-real-cause`), not just say "at
capacity".

---

## WP-2 — Connect the rendering policy (D1)

`adaptiveSnapshot()` hardcodes the canary off (`app/src/main/index.ts:820`) and no renderer
component reads `RenderingDecision` (declared, unused, `global.d.ts:17`). The GPU half of the
adaptive design has never executed.

1. Give `renderingPolicy` the same canary flag `AdaptiveRuntimePolicy` already takes, defaulting
   on, with `BIMAX_ADAPTIVE_RENDERING=off` as the override — mirroring
   `BIMAX_ADAPTIVE_CONCURRENCY`.
2. Renderer consumes it: `mode: 'quiet'` stops decorative motion only (`ThinkingIndicator`'s verb
   rotation, the talk orb, the morph controller's idle frames). Every animation that communicates
   state survives.
3. `preferredFps: 30` applies at the one place that owns a frame loop —
   `components/ui/morph/controller.ts:152`.

**Acceptance gate:** a property test — no decorative timer or frame callback fires while the
policy reports `quiet`. Never a timing assertion.

**Constraint:** Reduce Motion stays a hard accessibility constraint and is unaffected by the
canary, as `renderingPolicy` already implements.

---

## WP-3 — WITHDRAWN (its premise, D2, was wrong)

WP-3 proposed consolidating three 1-second `setInterval`s into one stoppable clock. On inspection
all three are already gated on real activity and none runs at idle: `CapabilityBanner` only while a
turn-scoped notice is on screen, `ThreadSurfaces` only while `busy`, and `ThinkingIndicator` only
while `{busy && !streaming}` (`Transcript.tsx:147`). See record 56, D2, now marked withdrawn.

Consolidating them would add a subscription mechanism, shared across three components with three
different lifetimes and three different conditions, to save nothing that was measured. **Not built,
deliberately.**

The one useful piece survives inside WP-2: the verb rotation and its decode scramble are decorative
and are a correct target for `quiet`. The elapsed counter and the expiry clock are informational and
must keep running.

---

## WP-4 — The duplicate power sensor (D3) — re-scoped, not built

`src/governor/power.monitor.ts:readDarwin()` forks `pmset -g batt` and `pmset -g therm` every
30 s **per engine**, to learn what the main process already holds push-based and free from
`NSProcessInfo` (`app/src/main/index.ts:1222`).

**Measured: 20 `pmset` forks cost 0.12 s wall / 0.07 s CPU — about 0.23% of one core** across
four engines. Small. This package is justified by *one sensor, one truth*, not by the saving:
today the two halves of the app can disagree about the thermal state, which is the failure
`availableBytes()` was written to end.

**RE-SCOPED 2026-09-19, on design inspection. Not implemented, and deliberately so.**

The proposed fix was to pass `thermal` and `powerSource` down the spawn env that already exists.
That does not work, and the reason is worth writing down because it is the interesting part:

**Environment is a snapshot; thermal state is not.** An engine can live for an hour. Main learns
about a thermal transition the moment it happens and would have no way to tell a running engine,
so the engine would act on the state the machine was in when its Bimax Thread started. That is
strictly worse than the `pmset` poll it would replace.

Inspecting further, the duplication is deeper than a sensor:

- The two halves measure **different things**. Main reads `NSProcessInfo.thermalState` — the OS's
  own four-level pressure signal. The engine reads `pmset -g therm` CPU_Speed_Limit, which is
  *speed limiting*, a different phenomenon that can be absent while pressure is real.
- They also duplicate the **decision**, not just the reading. `AdaptiveRuntimePolicy` already
  derives a worker ceiling from thermal, memory and battery; `PowerMonitor.advice()` derives its
  own from battery and speed limit. Two policies, two sensors, one resource.
- And main's better-informed decision reaches the engine **only at spawn**, via
  `engineEnvironment()`. Which is precisely why the engine grew its own live poll in the first
  place. The duplication is a symptom, not the disease.

So the real work is a **live power channel** from main to a running engine — main owns the good
sensors and the event, the engine owns the loop that has to react — after which the engine's
`pmset` reader stays only as the CLI/headless fallback, where there is no parent to ask.

That is a protocol change, not a cleanup, and it is not worth doing on the strength of the
measurement: **0.23% of one core**. Filed here at its true size rather than shipped as a
same-day fix that would have made the staleness worse. It should be picked up with WP-6's numbers
in hand, and only if they justify it.

**What WAS done:** both caps now carry doc comments naming their resource and pointing at each
other (WP-0), so the next person to read `PowerMonitor.advice()` can see that it governs workers,
not Bimax Threads, and that a second policy governs the same workers from a different sensor.

---

## WP-5 — Glass rungs and the macOS 27 slider (D4)

macOS 27 ships a user transparency slider. `vibrancy: 'sidebar'` follows it; the 23
`backdrop-filter` declarations in `styles.css` do not. Panels and chrome will disagree when a
user drags it.

Three rungs, driven by WP-2's policy plus the accessibility queries already in place:

1. **Full** — today's treatment.
2. **Lean** — drop the `::before` perimeter pass (`styles.css:511`), a second `backdrop-filter`
   per glass surface and the most expensive thing in the file. Keep the body blur.
3. **Flat** — `backdrop-filter: none` plus the veils. **This path already exists and is tested**
   for `prefers-reduced-transparency` (`styles.css:1346`) and for no-`backdrop-filter`
   (`styles.css:686`). It needs a second trigger, not an implementation.

**Acceptance gate:** `npm run check:glass-contrast` passes at every rung, on more than one page
(`bimax-contrast-checker-blind-spots`: it once measured one page with a probe 12px below the
text and missed 4 defects in both directions). Plus a design-preview pass across all theme ×
window states (`bimax-design-preview-harness`), not an Electron launch.

**Open, decided by WP-6, not by opinion:** whether moving the main window's panels to native
`NSGlassEffectView` via `electron-liquid-glass` — already a dependency, already shipping on the
⌘2 bar — is cheaper than 23 CSS blurs *and* picks up the macOS 27 slider for free. Adopt only if
the Metal trace says it wins.

---

## WP-6 — The measurement appendix (unblocks every claim)

No Bimax path has a CPU or GPU baseline. Capture on this M3, under a real Bimax Thread doing real
work (index a repo, run a multi-step turn):

- Instruments **Power** and **CPU Counters** — where the cores go, and the P/E split.
- Instruments **Metal System Trace** — compositor cost per frame with the glass on.
- `powermetrics --samplers cpu_power,gpu_power` — package watts, idle vs streaming.

Deliverable: a measurement appendix to record 56, plus a repeatable capture recipe in `scripts/`.

**NOT CLOSED 2026-09-20 (record 59).** `scripts/capture-cpu-baseline.sh` is the repeatable half.
It splits by privilege: tier 1 (per-process CPU%, CPU-seconds, peak RSS) runs with no root; tier 2
is printed as exact commands and not run, because `powermetrics` answers *"powermetrics must be
invoked as the superuser"* and Instruments needs the Xcode GUI. So the measurement appendix still
does not exist and **WP-7 remains gated**. Machine for the appendix: Apple M3, 8 cores = 4
performance + 4 efficiency, 8 GB, macOS 27.0 (26A428).

**Rule:** no perf constant is written anywhere in WP-1..WP-5 before this lands
(`bimax-live-engine-budget`: a guessed 512 MB-vs-1 GB reserve cost 3 of 4 Bimax Threads).

**Privacy:** traces capture prompt text. They go to the scratchpad, never the repo. `PRIVACY.md`
gets a line before the first capture.

---

## WP-7 — Sub-agent worker QoS (gated on WP-6)

Neither engine transport sets a QoS class (`app/src/main/engine.ts`), so a 30-minute unattended
index asks for performance cores at the same priority as the keystroke just typed.

**Do not build this until WP-6's CPU Counters trace shows the P/E split.** If background workers
already land on efficiency cores, there is nothing to win. If they do not, the path is the one
`bimax-voice` proves: a small native shim, or `pthread_set_qos_class_self_np` inside the engine's
background pools.

---

## WP-8 — Build hygiene, before any Swift enters the build

Two known defects will sabotage a native helper if they are still there when one is added:

- `bimax-runtime-copies-drift` — `desktop.runtime.ts` exists twice with no sync gate, and both
  are prebuilt binaries that must be recompiled.
- `bimax-cjs-flag-now-breaks-engine` — `lib-build.sh` passes `--format=cjs`, which on bun 1.3.14
  produces a non-booting binary; `package.json` omits it and works.

Also: `packaging.sidecar.test.ts` has thrown ENOENT since the archive separation
(`bimax-packaging-guard-is-dead`, third recurrence). **Repair it here**, because WP-9 and WP-10
both depend on a packaging gate that actually runs against the built artifact.

---

## WP-9 — Siri, via App Intents (gate first)

macOS 27's Siri reaches third-party apps through App Intents. Two halves:

- **Intent schemas** — natural-language actions with no fixed trigger phrase.
- **Entity schemas** — app content contributed to Spotlight's semantic index. Bimax already keeps
  Threads, an evidence store (`evidence.store.ts`) and an undo journal (`thread.undo.ts`).
  Contributed as entities, "what did Bimax change in the parser yesterday?" becomes a Spotlight
  query. No coding IDE does this.

**PARTLY BUILT 2026-09-20 (record 59).** Steps 1 and 2 are done; step 3 is still Target.

- Step 1 — `docs/SHORTCUTS_AND_AUTOMATION.md` documents `bimax://task` for Shortcuts, Raycast,
  Stream Deck, Folder Actions and cron, explicitly as the interim story. Every safety claim was
  checked against the code: the confirmation's `defaultId` and `cancelId` both point at Cancel, and
  the folder is re-refused after `realpath`.
- Step 2 — `app/scripts/check-app-actions.mjs`. It inspects a real `.app`, asserts the `bimax`
  scheme, any embedded `.appex`'s `Metadata.appintents`, and the bundled engine, and **fails rather
  than skipping** when there is no bundle. Passes on `/Applications/Bimax.app`; three mutants
  killed, including an `.appex` with its metadata missing — the exact failure this gate was ordered
  to catch. Wired into all three `dist:mac*` scripts and declared in `.bimax/gates.json`.
- Step 3 — the extension, intent schemas and entity schemas remain **Target**; they need Swift.

**Order, and it is not negotiable:**

1. **Document Shortcuts via `bimax://task`** — already implemented (`app/src/main/bimax.link.ts`),
   already registered in `electron-builder.yml`. An afternoon, and it is the honest interim story.
2. **Write the packaging gate**: resolve the intent against the built `.app` in `release/` and
   fail the build when the action is absent.
3. Then the App Intents extension, then intent schemas, then entity schemas.

**Why the gate first:** the documented failure for a non-Swift host app is that the intents
compile into a Swift library that is never linked, embedded or copied into the bundle — macOS
never discovers the action and every build stays green. That is this repository's most-repeated
failure shape.

---

## WP-10 — MLX and Foundation Models (gated on WP-8)

macOS 27 puts Foundation Models behind a `LanguageModel` protocol with conforming backends,
including **`MLXLanguageModel`**, which loads any `mlx-community` Hugging Face model onto the GPU
and Neural Engine. Streaming, tool calling and `@Generable` structured output are identical
across backends.

This replaces the 220-line runtime probe in `app/src/main/local.models.ts`, which exists to
distinguish *downloaded* from *servable* — a distinction the framework makes moot.

**Route:** a `bimax-fm` Swift helper built and shipped exactly like `bimax-voice` — same
`scripts/build-voice.sh` shape, same `extraResources` entry, same JSON-lines-over-stdout
protocol. It registers as one more provider behind the existing model-picker seam.

**Acceptance gate:** a **live request whose response proves which backend answered** — not a
config read-back. `bimax-model-switch-seam`: the picker saved the file, read it back, said
"applied", and every request kept using the boot model.

**Keep** `local.models.ts` for Macs below the framework floor, and for Ollama/LM Studio users who
already have a server running. Degrade, do not drop (`minimumSystemVersion: "13.0"`, D6).

---

## Order

```
WP-0  glossary + grep gate          ── blocking, hours
WP-6  measurement appendix          ── blocking for any constant, days
WP-1  reconcile the two caps        ── the real CPU defect
WP-2  connect the rendering policy  ── the real GPU defect
WP-3  WITHDRAWN                     ── premise (D2) did not survive inspection
WP-4  RE-SCOPED                     ── needs a live channel, not an env var; wait for WP-6
WP-8  build hygiene                 ── before any Swift
WP-5  glass rungs                   ── after WP-6 decides native vs CSS
WP-7  worker QoS                    ── only if WP-6 justifies it
WP-9  Siri: gate, then intents      ── flagship
WP-10 MLX via Foundation Models     ── flagship
```

**Against backlog 48.** 48 puts the RAG upgrade (record 50) first, then F8, then F1 + Q1–Q4.
WP-0..WP-4 are small and interleave. WP-9 and WP-10 are the *next* flagships after 48's, not
instead of them. Reordering that is the owner's call and this record does not assume it.
