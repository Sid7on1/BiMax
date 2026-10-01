# 65 — Computer Use returns: Bimax's own layer on the latest Cua Driver, with small local decision models

**Date: 2026-10-01. Status: stage 1 Measured (§6); stage 2 Implemented and Measured outside the installed app (§6b); stages 3–6 Target.** It is the plan the owner asked for:

> "plan the roll out of the bimax computer use from the archive and slowly integrate this into repo … use laya mlx
> model and … the latest CUA … the new CUA came out is much more efficent and there are mini models to operate it, we
> dont use the CUA but integrate it with our features in it … gradually roll it out, test it, and then integrate it"

It replaces the stage table of record 61 §6 (parked 2026-09-25) and keeps its rules: each stage ends on evidence or the
plan stops there; nothing is waived to reach the next stage. Record 46 remains the strategy (host-owned authority,
Thread-scoped grants). The code-only gate in `08_ACCEPTANCE_GATES.md` stays enforced, and its tests green, until
stage 2 replaces it in one reviewed change that edits the boundary test in the same commit.

## 1. What "use CUA, but as ours" means

Cua is a toolkit, not a product we hand the user to. Bimax takes the **driver** (the hands and eyes: accessibility
tree, window capture, background input) and keeps everything that makes an action **trustworthy** — which is what
Bimax's archived Computer Use already had and the driver does not do:

| Layer | Owner | From |
|---|---|---|
| Who may act, on what, for how long — a grant scoped to one Bimax Thread and one app/window generation | **Bimax** | record 46; archive `takeover.authority.ts`, `adhoc.approval.store.ts` |
| One input authority for every engine; a takeover by the user cancels every prepared action | **Bimax** | record 46 "Host-owned authority"; `native.input.interlock.ts` |
| Approval cards, undo journal, run summary, the ⌘2 bar | **Bimax** | today's app (Threads, `thread.bin.*`, approval cards) |
| Action contract → receipt bound to a fresh observation → end-state verification | **Bimax** | archive `action.contract.ts`, `action.receipt.ts`, `action.evidence.ts`, `verification.ts` |
| Screen/AX/OCR text typed as untrusted, never an instruction | **Bimax** | record 26; source ledger (VPI-Bench, WASP) |
| AX tree, window capture, background delivery, MCP surface | **Cua Driver** (MIT) | `trycua/cua` `libs/cua-driver`, 0.31.0 |
| Its own permission mode and capability manifest | **Cua Driver, configured by Bimax** | `bounded` mode: Bimax writes the manifest, Bimax approves it |
| The authorization prompt | **Bimax** | the driver renders none; an embedding host supplies `DriverAuthorizationHost` |
| macOS permission identity (Accessibility, Screen Recording) | **Bimax.app** | driver "Embedded" mode: `EmbeddedCuaDriverHost` spawns a private daemon in the app's responsibility chain |
| Planning the task | the user's chosen model (any provider) | `competitive/04_MODEL_INDEPENDENT_STRATEGY.md` |
| Fast, bounded second opinions | small local models — **advice only** | §4 below |

**Not taken:** `cua-perception` (its OmniParser icon detector is AGPL-3.0-only — never bundled or offered), Cua Fleets
and cloud sandboxes (sovereign perimeter, record 62), Lume VMs on this machine (8 GB cannot host a macOS guest beside
the app), and Cua's own agent loop. Source is not copied; the driver is a pinned, licensed dependency, as AGENTS.md
requires (license, provenance, exact files).

**Boundary.** Bimax for Mac — the app in this repository — is the only owner of Computer Use and of every macOS
permission. The engine keeps generic tool plumbing and receives Computer Use as a host capability from the app; it
never spawns the driver. Nothing of this reaches any terminal product.

## 2. Measured before planning (2026-10-01)

| | Fact | Consequence |
|---|---|---|
| Cua repository | `trycua/cua` `9545a3d` (2026-09-30), MIT; driver workspace version **0.31.0**, now Rust with a versioned C ABI, UniFFI SDKs for Python and TypeScript, MCP via the `cua-driver` executable | The archive drove **0.12.3** through a daemon + stdio proxy (`cua.compat.backend.ts`, `transport.ts`); **0.18.0 was rejected** (its frontmost check broke our floating PiP). 0.31 is a new codebase: re-measure everything, assume nothing carried over |
| Driver modes | `standard` (promptless), `bounded` (reviewed manifest only), `unrestricted` (needs a dangerous flag). Fixed at launch | Bimax runs `bounded` only, with a manifest it generates per grant |
| Driver identity | "Embedded" mode keeps grants on the host app; a raw `cua-driver serve` has no stable identity for TCC | Ad-hoc signing voided every grant on each rebuild before (record 61, Identity): local builds use the stable "Bimax Local Code Signing" identity; Developer ID for anyone else |
| Driver fixtures/bench | `libs/cua-driver-fixtures`, `libs/cua-bench` | A second harness beside ours — never a replacement for the v1.1.0 denominator |
| CUA-S1 small models | `cua-s1-nano-0.1` ≈ 855K params, Apache-2.0, scores every (element, action) option in one pass, "<100 ms on CPU"; `cua-s1-forms` 706K, MIT; `cua-s1-4b-0.1/0.2` LoRA on Qwen3.5-4B, Apache-2.0 adapters | Upstream says: early research; nano/forms "were not part of the fixture runs" and no chooser runs them; forms scored 12/41 on out-of-catalogue labels; **4B base weights are 9.32 GB — 8 GB hosts cannot load it** |
| laya-mlx | 421M (ModernBERT-large + decision head), Apache-2.0, 62.5 ms and 994 MB here (record 60); stalled this Mac twice with other load (record 61) | Usable only as a sidecar alive while a Computer Use Thread is, counted in the memory budget |
| Archive | `src/computer` 46 files, `app/src/capabilities/mac` 138, `native/BimaxComputerUseKit` (Swift service, bridge, fixture, tests) — about 76k lines | Restore by dependency closure from one entry point, never by folder |
| Last whole-system number | v1.1.0: **3 of 15** fixture tasks (form 2/6, menu 0/3, selection 1/3, transaction 0/3) | The denominator every stage below must beat, on the same harness |
| Machine | 8 GB M3, 9 GB disk free, Rust 1.84, Xcode license not accepted (Command Line Tools work) | Builds run one at a time; the driver build may need a newer Rust — measured in stage 1 |

## 3. Stages

| # | Stage | Work | Exit evidence |
|---|---|---|---|
| 0 | Decide | The owner approves this record. README, 05, 07 and the gap register say: Computer Use returns as an optional capability of a Bimax Thread, owned by Bimax for Mac, built on a pinned Cua Driver | Docs consistent; code-only tests still green; nothing reachable in the app |
| 1 | Bench, outside the product | In `~/Developer/bimax-research/cu`: build driver 0.31 and run its own tests and fixtures on macOS 27. Rebuild the archived `BimaxComputerUseKit` and its conformance (11/11 on 2026-08-17). Run **both** on the same read-only and safe-mutation fixture tasks; re-check the frontmost/PiP behaviour that sank 0.18 | A per-primitive table (tree, capture, press, set value, type, menu, background delivery): who passes, latency, memory, failures. The list of archived TypeScript files our trust layer needs (dependency closure). Decision recorded: driver for the primitives, and which archived native pieces, if any, are kept |
| 2 | Read-only, one Bimax Thread | Embed the driver in Bimax.app (`EmbeddedCuaDriverHost`), `bounded` manifest with observe-only tools, `DriverAuthorizationHost` answered by Bimax's own grant card. One host authority. The code-only gate becomes an admission gate in the same commit. Permissions are asked only when the user starts a Computer Use Thread | Zero input events in a whole observed session, counted by the driver and the host (not claimed by the model); denial and revocation work; a code task still asks for no permission; the Thread's other tools unchanged |
| 3 | One safe mutation | AX press / set value on the fixture app through the driver; Bimax's receipt bound to window + fresh observation; takeover cancels prepared actions; governor floor before the Thread's own approval (record 46's trap); an undo journal entry where the app allows one | Mutants fail: wrong target, no-op, stale frame, duplicate effect, approval skipped. The fixture's end state is graded, not the events |
| 4 | Small models beside the planner | Research first, then one sidecar for the whole app, alive only while a Computer Use Thread is: **CUA-S1 nano/forms** rank the driver's candidate (element, action) options for the planner; **laya-mlx** gives a second opinion on action risk and on screen text that addresses the agent. Both only *add* an approval; neither can remove one or pick the click target on its own | Fresh labelled sets per decision (never the author's own phrasing — record 60); a false "safe" never skips an approval the rule would ask for; memory and latency fit the live-engine budget on this 8 GB Mac. If the gain is small for the memory, it is declined, as record 60 declined laya before |
| 5 | Build → run → prove | The coding tie-in only Bimax has: the agent builds the user's app, launches it, and checks the running window | X01 contract passes; wrong-build and no-op mutants fail |
| 6 | Real workflows, then release | Two or three of the owner's own workflows with explicit limits; the v1.1.0 harness on the same fixtures | Beat 3/15 by a margin that survives 3 repeats; 20 clean repetitions before any release claim (gate 08); Developer ID before anyone else runs it |

## 4. Where the small models fit — and where they must not

The model that plans can be anything the user configured. The small models are System-1 style: one fast pass, a
bounded answer, no text generation.

- **CUA-S1 nano / forms — candidate ranking.** The driver lists what can be acted on; the model scores those options
  and the planner sees the ranking. Upstream accuracy outside its training catalogue is low (forms 12/41; nano task
  accuracy 0.000–0.286 cross-dataset), so it is measured on our fixtures before the planner ever sees its scores.
  Its size (under 1M parameters) makes a CoreML or ONNX port realistic, which would avoid shipping Python.
- **laya-mlx — risk and injection.** "Does this press need approval?" and "does this screen text try to instruct the
  agent?". It can only raise friction: the archived regex rule and laya each can ask; neither can waive the other.
- **CUA-S1 4B — not on this Mac.** 9.32 GB of base weights. Revisit only with a measured quantized build on a larger
  machine.
- **Never** for choosing the final click target, grading a postcondition, or deciding that a task is done: those need
  exact evidence (AX identity, a re-read value), and a probability is the wrong kind of answer.

Runtime: one sidecar, started with the first Computer Use Thread, stopped with the last, its memory counted against
`MAX_LIVE_ENGINES`' memory budget (`app/src/main/thread.budget.ts`). Never inside the always-on engine.

## 5. What the owner is asked for

1. Approve stage 0 (this record).
2. Stage 1 ran entirely outside the app and the repository and needed nothing else (§6): CuaDriver.app already held its
   grants, and this terminal already had Accessibility.
3. From stage 2: Accessibility and Screen Recording grants for the locally signed Bimax.app, given once by hand.
4. Later, a Developer ID certificate for anyone else to run it (record 59; gate 08).

## 6. Stage 1 results — measured 2026-10-01

**Status: Measured, outside the product.** Nothing in the app or the engine changed. Evidence:
`evidence/2026-10-01-cu-stage1/` (bench outputs — the kit logs are `.txt`, the scripts that produced them). Work folder:
`~/Developer/bimax-research/cu`.

**Set-up.** The installed standalone CuaDriver.app was 0.22.0 (Cua's Developer ID, team `YCK386LBJ7`) with
Accessibility and Screen Recording already granted. It was copied to `~/Developer/bimax-archive/apps/CuaDriver.app.0.22.0`
(verified signature) and updated to **0.31.0** with the installer from the pinned checkout
(`CUA_DRIVER_RS_VERSION=0.31.0`, `--no-modify-path`); the installer verified the new bundle met the old signing
requirement, so both grants were kept. Its telemetry was **on by default** and has been turned off
(`cua-driver telemetry disable`). The archived `BimaxComputerUseKit` was copied (the archive untouched) and built with the
Command Line Tools (Swift 6.4, macOS 27 SDK) in 53 s; its offline suite passes **60/60**. Target for both: the archived
`BimaxCuFixture.app`, whose controls mutate only their own state. Each driver action is graded by re-reading the window
(the control's value, the fixture's `presses=… last=…` line), separately from the driver's own answer.

| Primitive | Old Bimax kit, fixture in front | Old kit, fixture behind the user's app | Driver 0.31, fixture behind the user's app (3 runs) |
|---|---|---|---|
| Read the window | p50 **76 ms**, p95 93 ms (80 nodes) | refused: `no_successful_observations` | 220–590 ms (83 elements) |
| Press, toggle, radio select | performed and verified | **refused: `window_not_found`** | performed and verified, 3/3 runs |
| Set a text field, type into a text area | performed and verified | refused | performed and verified, 3/3 |
| Set a slider | performed and verified | refused | performed and verified, 3/3 |
| Increment / decrement a stepper | performed and verified | refused | **no AX increment** (click actions: press, show_menu, pick, confirm, cancel, open); `set_value` on the stepper answered OK and **changed nothing**, 3/3 — a false success caught only by our re-read |
| Whole catalogue | **15 verified, 0 overclaimed** (2 scroll actions unverified, as on 2026-08-17) | **0 verified; 15 declared but unperformed** | 7 of 8 graded actions; 1 false success |
| User's front app and pointer | the fixture is activated | — | **unchanged in every action** |
| With a floating panel like the ⌘2 bar on screen | — | — | background actions unchanged; `bring_to_front` → `bring_to_front_exact_window_verified`, `frontmost_ordinary: true` — **the 0.18 blocker is gone** |
| Time per action | — | — | 1.2–2.9 s; the animated agent cursor adds ~1.45 s; the first action of a session is the slowest |
| Memory | — | — | daemon 160–208 MB RSS, rising across runs |

**Also found:**

- The driver reports a press as `"effect": "unverifiable"` — honest, and the reason Bimax's verification layer is
  not optional. Its `verify_state` predicate was `satisfied` where it could see the value (text field, radio) and
  `unknown` for static text (`observation_unavailable`); it never reported unknown as success.
- Static text is missing from the structured `elements` (it is in `tree_markdown`), and elements carry no AX
  identifier. Bimax's receipts bind to role, label, frame and the snapshot's element token instead.
- The window snapshot includes the menu bar, and with it the user's **recent applications** list. The observation that
  reaches a model must drop that subtree unless the task is about menus.
- Background delivery and exact-window activation go through private Apple interfaces: SkyLight
  (`SLPSSetFrontProcessWithOptions`, `SLPSPostEventRecordTo`, `SLSEventAuthenticationMessage`, `SLSGetWindowOwner`, …)
  and `_AXUIElementGetWindow`, ~60 call sites in `platform-macos`. Usable in a Developer ID app; rules out the Mac App
  Store; can break on any macOS update, so every macOS update re-runs this table.
- The embedding package exists: `@trycua/cua-driver` 0.31.0, MIT, on npm.
- The trust layer to restore is small: `action.contract`, `action.receipt`, `action.evidence`, `verification`,
  `takeover.authority`, `native.input.interlock`, `adhoc.approval.store` — **7 files, ~1,350 lines**. A naive import
  closure pulls 30 files and 13,733 lines only because `action.contract.ts` imports four type names from the
  7,493-line `desktop.runtime.ts`; those types move to their own module in stage 2.

**Decision.** The driver becomes the primitive layer: acting without taking over the user's Mac is the feature, and
the old kit cannot do it at all. The old Swift kit stays archived; its fixture and semantic catalogue become Bimax's
grading harness. The stepper gap is handled by Bimax, not trusted to the driver: no `set_value` on an incrementor
counts unless a re-read confirms it.

**Carried into stage 2:** telemetry off in the embedded host and inside the sovereign perimeter; the menu-bar privacy
filter; the agent cursor off (Bimax draws its own feedback); the `@trycua/cua-driver` package measured inside Electron
(memory, start-up, whether the embedded path is faster than 1.2–2.9 s); the daemon's memory growth watched.

## 6a. Stage 2a — the embedded driver, measured outside the app (2026-10-01)

Evidence: `evidence/2026-10-01-cu-stage2a/` (the probe and its two runs). `@trycua/cua-driver` 0.31.0 (MIT, npm) runs the
driver **in the host process, with no daemon** (`CuaDriver.createConfiguredWithActivityObserver`): a Node add-on plus
`libcua_driver_sdk.dylib` (54 MB package; the CLI binary in it is not needed). The library itself carries no telemetry
endpoint; the probe held **0 network sockets**. Each Bimax Thread grant can be its own **trusted session**
(`createTrustedSession`) with its own capability manifest — version 2 is required to name an app — so one runtime serves
every Thread and the driver enforces each grant's scope itself.

| | Node 22 | Electron 43.3 (Bimax's) |
|---|---|---|
| Runtime start | 37–87 ms | 87 ms |
| Memory | +~45 MB (Node) | +~8 MB RSS (67 → 75 MB) |
| Window read (83 elements, background) | 700–750 ms | 670–700 ms |
| `click`, `type_text`, `press_key` in a look-only session | refused: `permission_denied` (manifest) | same |
| Looking at an app outside the grant (Finder) | refused: `bounded_resource_outside_manifest` | same |
| The fixture after the refused input | `presses=0 events=0 last=none` | same |
| Activity observer | authorized: `list_windows`, `get_window_state` only; refused: the three input tools | same |

A probe mistake on the way, kept for the next person: a fixture launched hidden (`open -g`) has no AX window at all, and
the driver then returns an empty tree on purpose (`ax_window_unresolved`) — launch it visibly and put the user's app back
in front.

## 6b. Stage 2 — look only, in one Bimax Thread (2026-10-01)

**Status: Implemented and Measured outside the installed app; not installed.** Commits `c640ca9` (engine: protocol
3.3.0 `host_call`/`host_result` on the engine's own port, `LookAtAppTool` registered only with `BIMAX_COMPUTER_LOOK=1`,
screen text fenced and tainting), `49893f2` (app: look service, embedded driver, app-raised grant card, menu bar opt-in,
privacy filter, content-free audit log, and the admission gate replacing the code-only gate — `08_ACCEPTANCE_GATES.md`
and `computer.admission.boundary.test.ts`), and the proof commit with this section.

**Exit evidence** (`evidence/2026-10-01-cu-stage2/`, `app/scripts/computer/prove-look.js`): the shipped engine bundle
as a worker over its port, a live model turn (gpt-oss-20b), the app's look service and Cua Driver 0.31 in the same
process, and BimaxCuFixture.app behind the user's terminal. Only the person was played. One run per mode.

| | allow | "Not now" | looking off (a normal task) |
|---|---|---|---|
| Grant card the app raised | yes → Allow | yes → Not now | none |
| Engine tool calls | `LookAtAppTool` ×1 | `LookAtAppTool` ×1 | `ToolSearchTool` ×4 (no such tool exists for it) |
| Host calls | 1 (`look`, app BimaxCuFixture, query `presses=`) | 1 | **0** |
| Driver, authorized for the task (its own observer) | `list_windows` 1, `get_window_state` 1 | none | driver never started |
| **Authorized input tools** | **none** | **none** | **none** |
| Fixture status before → after | `presses=0 events=0 last=none` → same | same → same | — |
| The model's answer | `presses=0 events=0 last=none` (correct) | "I couldn't access BimaxCuFixture." | — |

**Defects the live runs found, fixed before this commit** (each now has a test that fails without its fix):

1. The runtime manifest lacked `expires_after`/`idle_timeout`; the driver refused it and every look failed with
   `DriverError.Configuration` — whose class name was all the error said. Both limits added; the driver's own reason is
   now passed on; a runtime past its lease is replaced once.
2. Listing apps is a "desktop display observation" to the driver: the runtime manifest needs `resources.desktop.display`.
   With `list_apps` the only tool it allows, that grant reaches no screenshot.
3. `LookAtAppTool` was deferred behind ToolSearch: the model answered "I don't have a tool called LookAtAppTool" and never
   searched. It is now in the always-sent set (inert unless registered).

**Also measured:** the app resolves the asked-for app before raising the card (it names the app on the card), so in the
"Not now" run the driver runtime did start — for `list_apps` only. Unit and gate tests: app suite 124 suites / 1,109
tests at commit B; engine registry, host-call, protocol and gate suites green; 16 mutants caught across commits A–C.

**Not yet shown — the next step, and it needs the owner:** the installed app. There the driver attributes Accessibility
to **Bimax.app itself** (the proof ran under the terminal's grant), and the SDK loads from `app.asar.unpacked`. That needs
a build, an install, the menu bar item ticked, and Accessibility granted to Bimax once.

## 6c. Stage 2 continuation — installed, revocation repaired; observation still pending (2026-10-01)

**Status: Implemented and locally verified; installed observation and Bimax-owned Accessibility attribution remain
pending. Stage 2's exit is not yet met; stages 3–6 remain Target.** Continued on
`feat/sovereign-retrieval-and-layout-extraction` from clean HEAD `37b3380`. Evidence:
`evidence/2026-10-01-cu-stage2-installed/`.

The 18:58 build was checked and installed first, preserving the previous installed app in
`~/Developer/bimax-archive/apps/Bimax.app.before-cu-stage2-20261001`. Its package gate, deep strict signature and
ASAR/engine hashes passed. An installed launch showed the main window. No installed look session was run.

Inspection then found a stage-2 revocation defect: the service checked admission only before asynchronous discovery,
approval and observation. Four fresh regressions all failed against that implementation: a late Allow after preview
off could read; a late Allow after Thread stop could recreate the grant; discovery completing after stop could raise
a new card; and a read completing after preview off could return its contents. A stop now increments the Thread's
grant generation; preview off revokes all grants/sessions and increments the preview generation. Each asynchronous
boundary rechecks authority before reading or returning data. An off/on cycle does not revive an old request.

The driver wrapper also binds session creation, renewal and reads to that generation. Ending a grant during SDK
initialization cannot create a later trusted session; ending during window discovery prevents the tree read and
session renewal; a native read already in flight may finish, but its revoked contents are discarded. Six service
regressions cover these boundaries. `app/scripts/computer/prove-look-revocation.cjs` separately runs the actual wrapper
against a **controlled SDK**, testing initialization, discovery, discovery failure and observation. All four checks
pass; a temporary compiled mutant removing the generation validation fails. This is deterministic ordering evidence,
not a native-driver, installed-session or TCC measurement.

The fixed app was rebuilt with `app/scripts/build-local-mac.sh arm64` into
`/private/tmp/bimax-cu-stage2-revoke/release/mac-arm64/Bimax.app`, locally signed with **Bimax Local Code Signing**,
verified and installed at `/Applications/Bimax.app`. The intermediate `37b3380` install is preserved at
`~/Developer/bimax-archive/apps/Bimax.app.before-cu-revocation-20261001`. Installed ASAR, engine, SDK dylib and Node
add-on hashes match the build; `install.json` records their exact hashes and source hashes.

| Verification | Actual result / limit |
|---|---|
| Look service, admission boundary, engine host call, protocol, MessagePort and runtime-env suites | **89 passed in 7 suites** |
| Existing Thread and approval-card suites | **19 passed in 2 suites** |
| Controlled-SDK revocation proof | **4 passed; generation-validation mutant rejected** |
| Desktop TypeScript, production build | passed |
| Rebuilt engine artifact, as a worker in Electron | **7/7 protocol exchanges**; not a new live-provider session |
| Installed package gate / deep strict signature | passed |
| Installed App Actions structural gate | **3/3**; no claim that self-signed App Intents register |
| Installed native launch | main window observed; preview still off |
| Installed coding smoke | **one synthetic read passed**, current route displayed `gpt-oss-20b · Low`; exact `ReadFileTool` target/output, marker bytes unchanged, six grader mutants rejected |
| Installed allow / deny / revoke observation session | **not run; pending owner's Accessibility grant and menu opt-in** |

Two test invocations initially named nonexistent test files; those invocations are not product failures or passes.
The corrected runs above passed; the retained `invalid-test-path.txt` records the later invocation error.
The initial folder-picker automation was not scored because it did not immediately confirm navigation. After restart,
the synthetic folder appeared in recents and was explicitly opened. The installed app then read `stage2-fixture.txt`
and returned its exact marker. `code-smoke.json` preserves the synthetic transcript/tool result and independent byte
check; `grade-code-smoke.py` rejects missing read, wrong target, empty output, duplicate read, stale run and provider-error
variants. Preview was off, no TCC prompt was observed, no host audit file existed, and no Cua SDK mapping appeared in
the **post-task** `lsof` sample. This is one local coding smoke, not a whole-session TCC event count or clean-Mac gate;
the exact provider was not independently captured and its configuration was not changed.
The build used Command Line Tools after the existing Xcode-license refusal, emitted the existing voice Sendable
warning and shipped the legacy icon after the asset-catalog step was unavailable. No new release qualification is
claimed from the local build.

**Next, still stage 2:** the owner ticks “Let Tasks Look at Other Apps (Preview)” and grants Bimax Accessibility
by hand. Stage 2 reads accessibility text only: **no Screen Recording grant is needed**. Then run the installed
fixture allow/deny/revocation sessions with host/driver counts and independent fixture end states. The installed coding
smoke above covers one project task only. Stop there if the evidence fails. Do not begin stage 3 from the outside-app
proof in §6b.

Research mapping: **V20** (Computer-Use Architecture) and **V26** (Security & Trust Engine) in record 12: baseline
four revoked requests wrongly succeeding; candidate generation-bound cancellation; hard constraints no input,
Thread-scoped authority and no returned revoked text; metric reads/deliveries after revocation; baseline regressions
and generation mutant; adoption only on rejection of every revoked result without changing the look-only manifest.
Guided by README, 01, 03, 04, 05, 06, 07, 08, 12, this record, the Mac Buddy vision, competitive README/04/05/06/07
and M02's independent end-state contract. README/architecture/roadmap/frontend/gap/build-sequence notices now describe
the actual admission gate while preserving the old CU architecture as history. M02 mutation/persistence, X01,
small-model advice, real workflows, clean-Mac TCC and release qualification remain Target/unmeasured.

## 7. Risks named now

- **Driver drift.** 0.12 → 0.31 rewrote the codebase; a later release can change behaviour again (0.18 did). The
  driver is pinned by version and checksum, and every upgrade re-runs stage 1's table before it ships.
- **Private Apple interfaces.** The source ledger already records that the driver's background delivery uses private
  SPI and needs its own license, provenance and distribution review. Stage 1 lists which primitives depend on it;
  a primitive that would block Developer ID distribution or notarization does not ship, whatever it scores.
- **Memory.** 8 GB with heavy swap. Every always-on addition is paid out of the Threads budget; stage 4 can be
  declined on that alone.
- **Prompt injection through the screen.** Screen text stays untrusted evidence; laya's flag only quarantines, never
  promotes.
- **Overclaiming.** A tool call, a screenshot or a confident reply is not proof (`competitive/06_HEAD_TO_HEAD_EVALS.md`);
  only graded end states count, and no Win or Product-ready status is claimed from a single run.

Guided by: README, 05, 07, 08, 46, 60, 61, the Mac Buddy vision, competitive README, 04, 05, 06 and the source ledger.
