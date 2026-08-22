# Phase 5 frontend reset record

Status: **Implemented and locally Measured; Phase 5's local exit is complete**, 2026-08-09.

Scope: roadmap Phase 5, the Desktop information architecture in `04_FRONTEND_PLAN.md`, the
contextual-inspector and Trust Center contracts in `05_TARGET_ARCHITECTURE.md`, and the grading
rules in `08_ACCEPTANCE_GATES.md` and `competitive/06_HEAD_TO_HEAD_EVALS.md`. This record does not
upgrade any adaptive-runtime, chipset or distribution claim.

## Research performed before implementation

The product-level references already existed (`03_PRODUCT_EXAMPLES.md`,
`examples/REFERENCE_MATRIX.md`). What was missing was current first-party guidance for the two
shapes this phase actually builds, and for the motion constraint. Four sources were read on
2026-08-09 and are recorded with their retrieval dates and consequences in
`competitive/08_SOURCE_LEDGER.md` and `examples/PHASE5_FRONTEND_REFERENCES.md`:

- **Apple HIG Sidebars** (page dated 2026-06-08) — a sidebar navigates app areas and top-level
  collections, two levels of hierarchy at most, and "avoid putting critical information or actions
  at the bottom of a sidebar. People often relocate a window in a way that hides its bottom edge."
  This is what removed the six implementation tools from the sidebar and what moved Trust Center off
  the bottom edge, where Support and Settings used to be the only way in.
- **Apple HIG Split views** — first-party precedent for an inspector pane (Keynote), declared
  min/max pane sizes, the 1pt divider, and "provide multiple ways to reveal hidden panes".
- **ChatGPT Computer Use** — the shipped competitor names the controlled app, keeps an
  always-allowed list, documents scoped background macOS work, and promises stop/takeover at any
  time. This set the Live Target contract as table stakes and produced an explicit **Target** row
  for always-allowed apps rather than a UI for a capability Bimax does not have.
- **MDN `prefers-reduced-motion`** — `reduce` means tone down vestibular triggers, not delete every
  frame of feedback. The previous CSS nulled all animation and all transitions.

## What changed

### One task workspace

```text
┌ Projects / task threads ┬ Current task ─────────────────┬ Evidence ──────────────┐
│ project + branch        │ one state · plan progress     │ Changes │ Mac │ Browser │
│ New task / Search       │ Stop · Take control           │ Team │ Receipt │ Files   │
│ Trust Center            │ transcript                    │                         │
│ Current task            │ terminal drawer (on request)  │ (a lane exists only     │
│ Earlier tasks           │ composer                      │  once its evidence does)│
└─────────────────────────┴───────────────────────────────┴─────────────────────────┘
```

- `TaskSidebar.tsx` — projects and task threads only, two levels, Current/Earlier groups.
- `TaskHeader.tsx` — the task's single state (`idle | working | needs-you | failed | verified`),
  plan progress, Stop, and the Mac takeover control. The model is `task.state.ts`, whose ranking
  encodes the honesty rules: anything waiting on the human outranks "working", a failed check
  outranks a finished turn, and `verified` is claimed only when the engine's review state says so.
- `Inspector.tsx` — one contextual evidence pane. Availability is decided entirely by
  `inspector.model.ts`; an unavailable lane is shown dimmed with the reason it is empty rather than
  disappearing, and nothing can auto-open one.
- `TerminalDrawer.tsx` — the shell on request. It also **fixed a real defect**: the old dock kept
  `TerminalPanel` mounted behind a `hidden` class, so every project opened a pty whether or not
  anyone wanted a terminal.
- `TrustCenter.tsx` — a sheet with permissions, blockers, build/component identity, action history
  and a support disclosure; on the first Control Mac request it names the waiting task, walks the
  missing Screen Recording/Accessibility settings, re-reads trust, and releases the task only after
  a fresh available report. Code tasks remain independent. `EngineStatusBanner` was restored and
  wired (see below).
- `WorkspaceSheet.tsx` — code map and memory, palette-opened. Their engine producers still exist, so
  they were demoted rather than deleted. The animated "graph observatory" (three infinite CSS
  animations behind a decorative SVG) was not carried over.

### Mac Live Target

`mac.session.model.ts` folds the Desktop provider's own tool results — which already reach the
renderer as ordinary `tool_call` events — into a session: exact app/window, evidence with an age and
a freshness verdict, and a timeline of intents. No second Mac telemetry channel was added.

Two properties are deliberate and tested:

- the freshness budget is not a new number. `EVIDENCE_MAX_AGE_MS` mirrors
  `capabilities/mac/frame.ts` `DEFAULT_FRAME_MAX_AGE_MS`, and a test imports both and fails if they
  drift — otherwise the UI could call an observation fresh that the runtime would already refuse;
- `paused` comes from the app-owned latch verbatim. A refusal in the transcript is evidence the
  latch worked, never the thing that decides it is on.

Executor, mechanism, frame ids and postcondition text live inside a per-action **Details**
disclosure, in both the Live Target and the transcript. Before this, every Mac action printed
`Observation f7-4211-88 · Executor semantic · Focus none` into the conversation.

**2026-08-20 working-tree extension.** The retained ScreenCaptureKit Live Target helper now defaults
on and is staged beside the Desktop-owned Mac provider in the app bundle. It captures the exact
desktop-independent target window into a nonactivating floating panel, so Bimax can remain the
frontmost app while a background-capable semantic action runs. The bundle path, executable bit and
architecture are covered by package checks. This is **Implemented and locally unit-Measured**, not
yet Product-ready: a fresh packaged journey still has to prove continuous exact-window frames,
Bimax remaining frontmost, pause/takeover behavior, and truthful escalation when an action needs
physical foreground input.

### Pause / take over / resume — an ownership change, not a second latch

Phase 2/4 built the latch (`native.input.interlock.ts`) inside the capability provider, which is a
grandchild of Electron main (main → engine → MCP provider) and had no inbound channel. Phase 5 makes
main the authority:

```text
renderer --IPC--> main (UserTakeoverAuthority) <--loopback + token-- mac capability provider
```

- `main/takeover.ts` owns the state and serves it **read-only**: the provider can ask what the user
  decided and can never clear it. A capability process that could clear its own takeover latch would
  make the control decorative, and that is asserted.
- `capabilities/mac/takeover.authority.ts` is the only writer to the interlock in the provider. It
  refreshes inline, once, immediately before a mutating tool — no timer, so an idle app does no work
  — and **fails closed**: an authority it cannot read pauses rather than assuming consent.
- `server.ts` applies the gate to `mac_control` too, which never went through the native
  coordinator, and reports the latch in `mac_control status`. Reads stay available while paused,
  because the Live Target has to keep showing the user what they took control of.
- The credentials ride the **provider's own descriptor environment**, never the generic engine
  environment and never the renderer.
- The main authority exposes a monotonic generation. Compatibility actions bind to it at admission
  and refresh it at each real driver/fallback mutation boundary. A pause+resume that begins and ends
  during preparation therefore invalidates the old action even though both observed booleans are
  “running”; deterministic tests assert zero native transport mutations.

### One composer, two visible lanes

`lane.inference.ts` conservatively defaults to Code and selects Control Mac only for an explicit
Mac surface or an app-control request. The composer always shows the inferred lane as a correctable
chip before execution. Its normal approval surface is now exactly three product-level choices:
Ask before changes, Work automatically in this project, and Custom rules. Engine persona and
executor vocabulary remains behind Custom rules rather than acting as the primary workflow.

### Protocol robustness

`protocol.normalize.ts` normalises `ui_snapshot`, `review_update`, `subagent_update` and
`todo_update` at the boundary. It fills in the **shape**, never the **facts**: a missing model name
becomes an empty string, an unrecognised review state degrades to `idle` rather than to a green one,
and a verification with no stated result is not a pass. `ErrorBoundary.tsx` is the last line of
defence for the unknown case.

This closed a real crash: a `ui_snapshot` that merely omitted `models` reached the composer as a
truthy object and blanked the whole window. The malformed-frame fixture found it.

### Deleted after proving no consumer

| Removed | Consumer at the time of deletion |
|---|---|
| `Dock.tsx` | only `Sidebar.tsx` and `Footer.tsx`, both of which went with it |
| `Sidebar.tsx` | superseded by `TaskSidebar.tsx`; no other importer |
| `Footer.tsx` | already unreferenced at `HEAD` before this phase |
| `UiSnapshotComputer` + `UiSnapshot.computer` | Phase 4 removed the producer; the engine's `ui.snapshot.ts` has no `computer` block, and the last reader was the Dock's posture card |
| `app/scripts/screenshot-ui.mjs` | drove the deleted UI; replaced by `app/scripts/ui/journeys.mjs`, and its two doc references were updated |
| `theme-ink` | it replaced the accent hue, which is what "one accent" exists to prevent; saved selections migrate to dark, and `auto` (match system) was added |

### Visual-system completion (2026-08-10)

The later vision-completion pass supersedes Phase 5's warm palette without changing its task and
evidence information architecture:

- `BrandMark` is exact text `BiMAX`; it contains no SVG, image, glyph, badge or monogram;
- `Moonlight` uses black/graphite/silver and `Starlight` uses white/pearl/silver;
- legacy saved theme names migrate to the two supported themes through `appearance.ts`;
- editor, terminal, markdown, syntax, diff and TUI chrome use neutral intensity instead of
  ornamental hues;
- the Phase 9 Runtime lane remains contextual in the existing inspector rather than permanent
  dashboard chrome;
- the renderer harness falls back to a direct production-bundle URL when a managed environment
  forbids a loopback listener, while retaining the same bridge and mutation grader.

This completion is locally built and typechecked. A fresh visual journey could not be counted on the
managed host because Chrome itself was denied process launch after the loopback fallback succeeded;
the prior Phase 5 screenshot/electron records remain historical evidence, not evidence for this new
palette.

### Trust Center, model catalogue and interaction hardening (2026-08-11)

- `PermissionsDialog.tsx` now has exactly one scrolling body between a fixed header and footer.
  `PermissionsPane.tsx` polls the main process while open, reports `Allowed`, `Off`, `Not added` or
  `Can't read`, names the actual Electron/Bimax host, and counts only Accessibility and Screen
  Recording toward Control Mac readiness. Full Disk and Microphone are visibly optional.
- `permission.coach.ts` now prepares a deterministic, non-empty raw-bitmap icon before advertising
  the drag source and starts Electron's native file drag for the exact responsible bundle. The
  previous empty-image fallback could produce a tile that looked draggable but never began a macOS
  file drag. A later packaged smoke also removed `app.getFileIcon()`: on macOS 26.5.2 with Electron
  43.3.0 that Launch Services lookup trapped in AppKit's `NSImage` worker when Enable was pressed.
  A 2026-08-12 follow-up found Electron also decoded the SVG and PNG data-URL fallbacks as empty in
  the packaged build. The coach now supplies a codec-free 64×64 BGRA bitmap; a native Electron smoke
  measured it as `empty:false`, 64×64. The generated icon keeps icon-cache, codec and signature state
  out of the security-critical drag path;
  the payload and visible coach still identify the exact bundle.
  The hardened coach can drag the exact `BimaxCuService` bundle as well as the dev/packaged host,
  hides the main sheet while System Settings is the destination, and restores Bimax explicitly.
- `manual-alpha.trust.ts` adds a bounded unsigned-development bridge: a native handshake and exact
  Code Directory hash are re-probed at approval time, the local decision can be revoked, and a
  changed hash is rejected. The UI states that this neither identifies the builder nor bypasses
  macOS permissions.
- `ModelDialog.tsx` is a one-scroll catalogue with plain-language job slots, human labels plus exact
  provider IDs, live served/unserved separation and capability summaries. A configuration write is
  still accepted only after the engine reads back the effective slot.
- `provider.credentials.ts` stores provider secrets through main-process `safeStorage` (Keychain-
  backed on macOS), injects them only into a new engine process and keeps them off NDJSON. Catalogue
  discovery now has a bounded failure and a static provider setup route. J12 proves a Control Mac
  instruction waits for a served Work + screenshot-capable Vision route, then resumes exactly once.
- tool details, review diffs and the composer use the same restrained interaction language. Diff
  code no longer word-wraps in the narrow inspector; it scrolls horizontally inside its own code
  surface. Dialog entrances and button presses use brief transform/opacity feedback, with a
  reduced-motion opacity-only path.
- The browser bridge fixture was brought back into parity with the production preload surface
  (`setAppearance`, window chrome and evidence methods), after the first visual run correctly
  exposed fixture drift rather than a Trust Center renderer defect.

Final evidence on 2026-08-11: all 17 renderer/resilience/performance/accessibility rows pass at the
three supported window sizes, all four deliberately broken end states are rejected, 17 targeted
trust/service tests pass, and the production Electron build succeeds. Raw renderer record:
`app/benchmarks/ui/results/phase5/run-2026-08-11T16-02-32-205Z/report.json`. Fresh packaged TCC state
changes, the native drag landing in System Settings and Developer ID/notarization remain Target,
not Product-ready claims.

Packaged smoke on 2026-08-11: a separately identified arm64 `Bimax Latest` dir build loaded its
renderer from packaged `app.asar`, opened Trust Center without crashing, reported live host grants
as 0/2, exposed the host and service `Open & drag…` controls, and displayed the exact local service
Code Directory hash. Three focused trust/model/routing suites passed (9 tests). The user had not yet
performed the System Settings drop, so the actual drag landing and TCC mutation remain Target.

Follow-up on 2026-08-12: the remaining “Settings opens but no tile” symptom had two independent
causes. `PermissionsPane` stopped the newly-created coach during React's null→active effect cleanup,
and both data-URL icon fallbacks produced an empty `NativeImage`. The lifecycle now stops only an
actually active coach on dismiss/unmount, and the icon is raw BGRA pixels. J4 now asserts that
`start(accessibility)` is not followed by a premature `stop`; mutant M5 recreates that regression
and is rejected. Main records bounded `start`/`shown`/`stop`/load/renderer lifecycle markers. The
native image smoke and packaged build pass; an actual user drop/TCC mutation remains Target.

The currently staged native service was re-ad-hoc-signed and its self-test reports an intact
signature, but Accessibility and Screen Recording are both denied. A fresh native rebuild is also
blocked by missing Swift target sources (`BimaxCuBridge`, `BimaxFocusBridge`) and the missing Desktop
helper source. Therefore this record does not call the current CU artifact source-reproducible or a
real provider-backed Calculator run complete.

The repository-wide `npm run typecheck` is not green: it is blocked by existing incomplete native
capability sources (`native.bridge.transport.ts`, `native.operation.contract.ts`,
`native.transaction.compiler.ts`, `session.manager.ts` and related imports). The production build
and this pass's focused tests are green, and none of the edited production UI/trust files appears in
the remaining TypeScript diagnostics; this pass does not silently upgrade the repository-wide type
gate.

### Installed permission coach and app-owned CU loop correction (2026-08-13)

The installed `/Applications/Bimax.app` still reproduced one later regression that the renderer
journey could not see: Enable opened System Settings and hid Bimax, then main threw
`TypeError: electron.app.getSystemVersion is not a function` before creating the coach. Electron's
host-version API is `process.getSystemVersion()`. `permission.coach.ts` now uses that API and the
new main-process regression test drives the complete hide → open Settings → macOS 26 retry →
create/load/show sequence with an app mock that deliberately has no `getSystemVersion` method.

The repaired arm64 app was installed and exercised through the native UI. The exact installed
coach became visible at `#permission-coach`, named BiMAX, rendered the non-empty drag tile, and
recorded `start → shown → drag-started → drag-ended` when its native drag was exercised inside the
coach (not dropped into System Settings). Cancel restored the main app. A later CU-loop build again
displayed the coach after its new ad-hoc identity invalidated prior TCC grants. No permission was
dropped or granted by this verification, so clean deny/grant/revoke/regrant remains Target.

The first app-owned provider run then proved the native boundary reached production: Control Mac
requested `mcp__bimax-mac__mac_control` and opened Calculator. It did **not** prove task completion;
the configured `nvidia/nemotron-3-nano-30b-a3b` controller spent more than a minute narrating
prospective element-index JSON and never changed the old Calculator value. The run was stopped and
is retained as a failed/non-converging attempt, not upgraded into a CU win.

Two corrections now address that failure without returning Computer Use to Terminal:

- Desktop appends a compact, hidden execution contract only after its Control Mac lane, live-model
  and Trust Center gates pass. It names the exact Desktop-owned MCP tool, requires one native action
  per fresh returned frame, forbids prospective-JSON narration, and requires newest-result proof.
  The renderer removes this model-only contract from live echoes and restored transcripts.
- the shared source prompt policy now routes the measured Nemotron 30B controller to the compact
  one-action playbook. The future engine source also gates playbook injection on the exact
  `mcp__bimax-mac__mac_control` descriptor, leaving Terminal's coding-only product boundary intact.

Verification: 24/24 focused tests passed across coach, model preflight, hidden CU prompt,
playbook selection, session routing and takeover; `electron-vite build` passed; strict deep
codesign verification, the arm64 Desktop package gate and the provider stdio/schema probe passed
for the staged and installed bundle. The newly signed local build truthfully returned to 0/2 TCC
and requires a fresh human grant plus exact-build approval before the corrected model loop can be
rerun. Full source `tsc --noEmit` remains blocked by the already-recorded recovered/missing CU
source modules; this change does not treat a bundle build as source-reproducibility proof.

#### Permission handoff and repeated app-owned CU regression (2026-08-13)

The installed app exposed two additional product-shell defects after the earlier provider work.
First, every Desktop-owned `mcp__bimax-mac__mac_control` call still surfaced the engine's generic
`Allow?` question even after the user had deliberately entered the Control Mac lane and passed the
Trust Center gates. Desktop now holds a task-scoped consent token only for that exact app-owned
provider and consumes only that exact tool question. It does not consume taint warnings, another
MCP provider's questions, or any request outside the explicit Control Mac submission. The shared
future-engine source also marks only `bimax-mac/mac_control` as app-approval-owned.

Second, returning from the permission coach depended on a TCC probe that macOS can cache for the
life of the process. The native drag now schedules the same bounded 1.2-second coach teardown after
the file drag returns, independently of the cached green/off reading. The restore path explicitly
restores, shows and focuses Bimax. Accessibility, Screen Recording and Full Disk Access use the
native bundle drag; Microphone uses Electron's native media-authorization request because macOS
does not expose Microphone as an add-by-drag list. The floating row is more translucent, has a
clearer drag handle, and states that Bimax returns automatically.

Live installed verification used ChatGPT Computer Use only to submit/inspect and stopped its input
while Bimax owned the Mac. A Full Disk Access bundle drag returned the complete Bimax window in
about 1.8 seconds without Cancel. Trust Center then reported 2/2 host grants, both native-service
grants and Microphone allowed; Full Disk Access remained optional/off, so the drag itself is not
claimed as a TCC mutation. Two consecutive app-submitted Control Mac tasks reached the installed
provider without a visible `Allow?` modal: the first produced `Opened` (3.1 s) and reported the Full
Disk Access pane visible; the second produced `Switched to` (1.7 s) and reported System Settings
frontmost. Engine logs contain `Veto cleared. Task approved.` for both runs. This is locally Measured
open/focus routing, not an M01 mutation win: the Evidence Studio entries remained `Not confirmed —
not requested`, so stronger end-state work is still governed by the existing acceptance gates.

Focused verification passed 8/8 tests across permission-coach return, app-owned approval matching,
provider credentials and the hidden CU prompt; `electron-vite build`, strict codesign inspection and
the arm64 package gate passed for `/Applications/Bimax.app`. The renderer is now more transparent
(`--glass-veil` reduced in both appearances with an explicit app veil/blur layer). Full app
`tsc --noEmit` is still blocked by the pre-existing recovered/incomplete native capability source
set. Ad-hoc host re-signing also changes the TCC identity after each local rebuild; stable grants
across updates remain a Developer ID/notarization Target, not something the UI can bypass.

Follow-up on the same installed journey found the remaining repeated-Accessibility symptom. The
System Settings list showed `Bimax` switched On while the newly ad-hoc-signed Bimax process still
received `AXIsProcessTrusted = false`: the visible row belonged to an older local-build identity.
In addition, a process that was already running when the switch changed can retain its original AX
answer. The permission coach now distinguishes the existing-row case in its instructions (switch
the current Bimax row Off then On once after a local rebuild) and automatically relaunches Bimax
after a completed host Accessibility or Screen Recording bundle drag. Full Disk and native-service
drags do not relaunch the host. Five focused coach tests cover the host-only relaunch decision and
the closed-coach relaunch call. This is an honest manual-alpha correction; it does not upgrade
permission persistence across ad-hoc rebuilds, which remains a stable-signing gate.

`EngineStatusBanner.tsx` went the other way. It was written during Phase 2 and **never rendered by
anything**, so a crashed engine produced a task surface that had silently stopped responding. Phase 5
restored and wired it, which is why J3 can grade a crash at all.

## Exact reuse versus new code

**Reused as the foundation (unchanged or locally extended):** `ReviewPanel`, `DiffView`,
`FilesPanel`, `EditorPane`, `TerminalPanel`, `Transcript`, `Composer`, `RequestModal`, `SettingsDialog`,
`HomeView`, `ProjectWelcome`, `GalleryView`, `Dashboards`, `BrandMark`, `ui/*`, `markdown.tsx`,
`useEngine` (payload normalization only), `useSupervisor`, `useGit`, `receipt.inspector.ts`,
`trust.center.model.ts` (extended, not replaced), the supervisor's typed recovery actions, the
Desktop capability provider, `chooseMechanism`, `executor.ladder.ts` and `NativeInputInterlock`.
The existing composer gained the lane chip and three-level product vocabulary; its submit and
engine-control plumbing was retained.

**New:** `task.state.ts`, `mac.session.model.ts`, `browser.session.model.ts`, `inspector.model.ts`,
`final.receipt.model.ts`, `protocol.normalize.ts`, `useTakeover.ts`, `main/takeover.ts`,
`capabilities/mac/takeover.authority.ts`, and the components `TaskSidebar`, `TaskHeader`,
`Inspector`, `LiveTarget`, `FinalReceipt`, `TeamPanel`, `TerminalDrawer`, `WorkspaceSheet`,
`ErrorBoundary`, plus the journey harness under `app/scripts/ui/`.

**Not created:** a second task store, a second receipt model, a second permission system, a second
routing brain, or a second Mac telemetry channel. No Computer Use ownership returned to Terminal or
to the generic engine, and no compatibility/legacy path was reactivated.

## Verification

| Check | Result |
|---|---|
| Terminal source boundary scan (`src`, `tui`) | clean — no Computer Use owner label |
| Terminal suite | **188 suites, 1,655 tests passed**, 1 suite / 2 tests skipped (the pre-existing environment-gated `browser.runtime.e2e`) |
| Desktop capability suites | **54 suites, 603 tests passed**, zero ignored |
| App typecheck + production build | pass |
| Protocol mirror | in sync — v3, 19 message tags, byte-identical |
| TUI Go suite | pass |
| macOS provider stdio probe (recompiled with the takeover gate) | `mac_control` discovered, structured status, arm64 |
| Desktop package structural verifier | 5/5 pass on the rebuilt `Bimax.app` |
| Packaged Phase 2/4 conformance on the rebuilt app | **11/11**, including `packagedTakeoverInterlock` and all four executor rungs |
| Renderer journeys + resilience + interaction cost + accessibility | **14/14 pass** at three window sizes |
| Mutation pass | **4/4 mutations rejected as required** |
| Built Electron production boundary | **pass** — main + preload IPC + supervisor + compiled provider stdio; provider refused while paused and only a newly issued safe post-resume action succeeded |

One packaged conformance attempt was **discarded as invalid, not failed**, before the passing run:
`m02ExactState` reported `status: skipped, reason: bystander_not_frontmost` — the fixture's bystander
app never took the foreground on a machine that was mid-build. Under
`competitive/06_HEAD_TO_HEAD_EVALS.md` validity rules that is an unavailable fixture, not a product
failure. Both raw records are preserved under `app/benchmarks/computer-use/results/phase2/`; the
qualified one is `run-2026-08-09T12-47-27.242Z`.

### The eleven core journeys

Latest raw record: `app/benchmarks/ui/results/phase5/run-2026-08-11T13-45-54-024Z/report.json`.

| ID | Journey | What the grader actually checks |
|---|---|---|
| J1 | Start a coding task | the instruction reached the engine exactly once and verbatim; it is in the transcript; no engine vocabulary on the task surface |
| J2 | Review and verify changes | both changed files listed, the verification command and its result shown, the state says verified, the chosen file's diff is readable |
| J3 | Resume after a crash | the crash is STATED with recovery actions; the restored thread carries the request, the answer and the review evidence; the banner clears when the engine returns |
| J4 | Diagnose permissions, keep coding | the denied permission and its blocker are named; coding is shown unaffected; Bimax says it cannot grant the permission itself; the grant path opens the exact macOS pane; a coding instruction still reaches the engine |
| J5 | Pause / take over / resume | app + exact window shown; taking control tells main once; the UI states the user has control and promises no input; an attempted action arrives as refused with "nothing was sent to your Mac"; resume is explicit (`true,false`) and the state clears only after main confirms |
| J6 | Understand the live target | app, exact window, evidence age, the latest action in plain words, the confirmation stated; stale evidence is called stale; no plumbing vocabulary visible at rest |
| J7 | Inspect the final receipt | each claim links to its code and Mac evidence; a fully evidenced task says so; a failed check and an unconfirmed action each make it unproven and are named as gaps |
| J8 | Infer and correct the lane | an explicit Mac request visibly infers Control Mac; correcting it to Code is respected at execution and does not open permission guidance |
| J9 | First Control Mac task | the task is named and held unsent; closing without grants keeps it visible; Code still runs; a fresh granted report releases the original task exactly once |
| J10 | Exact unsigned CU build approval | the full Code Directory hash and provenance/TCC boundaries are visible; approval submits that exact hash once; the resulting local-approved state is explicit and revocable |
| J11 | Model catalogue | plain-language model jobs, human label + exact id, active provider/served count, served-versus-unserved truth and capability summaries are all visible before selection |

Plus `R1` (loading, empty, 11 malformed/unknown frames, protocol mismatch, crash) and `A-*`
(keyboard reachability of every primary surface, accessible names on every control/image/tab, no
horizontal overflow) at 720×480, 1180×800 and 1680×1050.

### Mutations

Each grader was run against a deliberately broken end state and **had to fail**:

| Mutation | Broken end state | Result |
|---|---|---|
| M1 | main never applies the pause — the latch is decorative | rejected |
| M2 | a two-minute-old observation presented as current | rejected |
| M3 | a failed check and an unconfirmed action still produce a complete receipt | rejected |
| M4 | a denied macOS permission reported as blocking coding | rejected |

Unit-level mutants are written out in `src/__tests__/phase5.renderer.models.test.ts`,
`src/__tests__/phase5.takeover.authority.test.ts` and
`app/src/capabilities/mac/__tests__/takeover.guard.test.ts` — including the one that matters most:
a gate that skipped the authority refresh lets the agent act straight through a pause, and the same
call is refused once the authority is restored.

Screenshot regression: `app/benchmarks/ui/screenshots/` — task surface, Live Target, receipt and
Trust Center at each supported size.

Production-boundary record:
`app/benchmarks/ui/results/phase5/electron-2026-08-09T14-34-28-744Z/report.json`, with screenshots
beside it. This launches the built Electron main/preload, uses the real supervisor and the compiled
provider descriptor over stdio, and replaces only the native-world target with an input-free safe
fixture. It is boundary evidence, not a real-app or performance claim. Earlier `electron-*` runs
without `report.json` are unqualified diagnostic attempts; their failure records are preserved.

Re-run everything with `npm run phase5:check`.

## Chipset, network and performance truth

Measured on this host (Apple M3, arm64, 8 GB, macOS 25.5.0):

- **Renderer bundle**, Phase 5 build against the `HEAD` (715dda91) build of the same tree:
  JS 2,771,554 → 2,813,151 bytes (**+1.50%**), CSS 84,422 → 79,664 (**−5.64%**), total gzip
  696,762 → 705,266 (**+1.22%**). This is reported as a measurement, **not** as an optimization: the
  new evidence models and components cost more JS than the removed dock and theme saved.
- **Interaction cost** on a 200-action Mac session: folding all 200 provider results took 865 ms;
  switching evidence lanes measured p50 33.3 ms / p95 33.4 ms / max 33.4 ms; an idle task produced
  **0 DOM mutations in one second** — nothing polls, and no panel animates at rest.
- **Architecture truth** is unchanged and still comes from the Electron/provider boundary: the
  provider refuses an absent or mismatched architecture, and the rebuilt bundle's app executable,
  engine, XPC service and provider were each inspected as Mach-O arm64 in the conformance record.
- **Network**: the takeover broker binds an ephemeral **127.0.0.1** port with a 32-byte token,
  asserted in test. Provider transport remains local stdio. No remote plane was introduced, and the
  renderer never receives the endpoint or the token.
- **Reduce Motion** is honoured per MDN's actual guidance, and the journeys run with
  `--force-prefers-reduced-motion`.

No adaptive batching, thermal scheduling, network-quality routing or broad "chipset-native" claim is
made or implied by this phase. Those remain **Target** under V01/V02/V03/V29B.

## Status separation

**Implemented and locally Measured**

- the task workspace, the contextual inspector and its lane-availability rule;
- Mac Live Target with exact app/window, evidence age and freshness, and a plain-language timeline;
- app-owned pause/takeover/resume, fail-closed in the provider, gating `mac_control` as well;
- visible Code/Control Mac inference and correction, plus contextual first-use permission return;
- the cross-lane final receipt with explicit gaps;
- Trust Center with permissions, blockers, build/component identity, action history and the
  macOS-pane grant path;
- crash, loading, empty, malformed-frame and protocol-mismatch states;
- keyboard and accessibility coverage and screenshot regression at three supported sizes.

**Product-ready:** nothing new. Phase 5's evidence is local development evidence.

**Target (later phases, not unfinished Phase 5 work)**

- always-allowed Mac apps, and editable success criteria / bounded continuation for goals (P1);
- a redacted diagnostics **export** bundle (the in-app surface exists);
- model-backed live native-app journeys — M01, M03, X01, I01, and C04 as a real kill/resume rather
  than a renderer-level crash journey. The safe Electron/real-provider boundary now exists, but it
  is not substituted for those real-app rows;
- adaptive runtime/rendering policy, and any chipset or network-quality claim.

**Phase 7 release qualification, reported separately and explicitly NOT Phase 5 work**

- clean-Mac TCC behaviour, quarantined download and first launch;
- Developer ID signing (this build is unsigned — electron-builder reported no valid identity),
  notarization and stapling;
- DMG distribution verification on a clean machine;
- Intel/x64 hardware measurements.

No local Phase 5 implementation or qualification row remains open.

## 2026-08-20 general Computer Use installation record

The installed `/Applications/Bimax.app` now contains the single Desktop-owned Computer Use
implementation from `app/src/capabilities/mac`; no Terminal-owned or per-application runtime copy
was created. Routing is observation-specific rather than app-specific: bounded AX readiness can
move from `warming` to `ready`, Menu is offered only as a command-intent adapter, and semantic
content absent from AX keeps the visual path eligible even when the app has usable menus.

Both Menu activation and the Search/Find opening step now run through the same serialized acting,
takeover, receipt, post-action evidence and foreground-invariance boundary as other mutations. A
background mutation that moves the user's foreground is not reported as success; Bimax attempts to
restore the previous app and preserves the failure in the receipt. Search is one transaction:
open search, type into a proven editable target, reobserve, ground the requested result, select it,
then verify the requested end state. It stops with structured evidence before ungrounded typing or
selection.

Verification on this host: the complete non-network Mac set passed 93 suites / 1,078 tests and the
isolated takeover loopback passed 1 suite / 25 tests (**94 suites / 1,103 tests total**). The arm64
packaged fixture passed all semantic, physical, visual, takeover, temporal-AX, content-grounding,
search-transaction, foreground-isolation and exact-state assertions; preserved report:
`app/benchmarks/computer-use/results/phase2/run-2026-08-20T13-53-53.109Z/report.json`. A second clean
local package invocation produced
`/private/tmp/bimax-build-cu-general-20260820-final/mac-arm64/Bimax.app`, passed strict nested
signature verification and the bundle-only component gate, and the installed app was observed
running its main process, renderer, engine and native capability provider. Its existing build is
preserved as `/Applications/Bimax.app.backup-20260820-192506`; no source or application backup was
deleted.

This is **Implemented and locally Measured**, not Product-ready. The local build is ad-hoc signed
without hardened runtime so Electron's nested binaries share a coherent local identity; stable
Developer ID signing, hardened runtime, notarization, clean-Mac TCC persistence, and broad live-app
journey evidence remain **Target**. Physical pixel input also remains an explicit
`foreground_required` escalation on macOS; it is not falsely described as universal background
control. Exact-window ScreenCaptureKit Live Target is packaged, but continuous user-visible
mini-window proof in the released UI remains Target.

## 2026-08-12 permission-coach crash correction

The packaged permission journey exposed a native lifetime race after the user completed a real
bundle drag. The crash report
`~/Library/Logs/DiagnosticReports/Bimax Drag Verified-2026-08-12-002835.ips` records a browser-main
`SIGTRAP` while AppKit delivered an application-reopen Apple event; the bounded coach log records
`start → shown → renderer-requested stop → closed` at the same boundary. Main now treats
`webContents.startDrag` as a synchronous native lifetime: a stop hides immediately, but coach
WebContents destruction waits until the native drag has returned and a 1.2-second reopen-settle
window has elapsed. Reopen/second-instance handling no longer queries all BrowserWindows during
that boundary and instead restores the one owned main window after the coach has settled.

The visible source was also reduced to a compact, static, exact-name app row with an explicit drag
handle, short press/hover feedback, a non-drag `+` instruction and Cancel. The continuous dashed
arrow animation was removed. On macOS 26, the fixed Apple privacy deep link is retried once after
System Settings activates because the first event was locally observed landing on General; the
second identical allow-listed event landed on Accessibility.

Local verification: production build passed; J4 and all five mutants passed; the Electron raw-icon
smoke remained non-empty at 64×64; the focused trust/model/routing set passed 3 suites / 9 tests;
the repaired coach close/restore completed without a new crash report. The final installed local
bundle is `/Applications/Bimax.app`, `ai.bimax.app`, strict deep ad-hoc signature valid, with one
process lock. Old generated app bundles/installers were moved to the recoverable dated Trash
folder. This is still local/manual-alpha evidence, not clean-Mac, Developer ID, notarization or
stable-release evidence.
