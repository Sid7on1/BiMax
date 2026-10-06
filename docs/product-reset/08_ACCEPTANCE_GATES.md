# Acceptance gates

## PDF local gate — 2026-10-06, record 74

- Actual completed files retain intended page count and sequential page numbers, with no footer-only
  page accidentally entering OCR. Text extraction preserves a final page without a form feed.
- Empty/invalid page counts refuse; missing executables, permissions, real malformed-file errors,
  aborts, deadlines and captured-output overflow remain distinct. Metadata interruption/overflow
  never triggers another reader as a fallback.
- PDF children have an internal per-child deadline and shared stdout/stderr byte cap; split UTF-8
  survives. Stop terminates inherited process groups on this Mac and closes caller pipes. These
  controls do not qualify escaped groups, Windows descendants or recognizer cancellation.
- Fresh owned render directories exclude caller-owned stale images. Nonregular/empty images,
  duplicate/out-of-range page identities and incomplete unreadable-page coverage refuse. Mixed
  documents render only the unreadable-page envelope and preserve exact embedded text.
- Failed/cancelled jobs clean their own directories. Successful jobs remain available through OCR,
  then extraction/tool consumers dispose them in finally; a Stop during OCR cannot return success.
- Real children/files, rendered pages and executable behavioral mutations qualify local results;
  exact restoration and unrelated dirty identities are checked. Fifty focused tests and
  twenty-six executable faults qualify these checks. Existing assertions/timeouts stay.

Evidence: [record 74](74_PDF_RELIABILITY_SPRINT.md). This repairs the reproduced unnecessary-OCR
cause of earlier PDF-layout timeouts. General native OCR, whole-document resource budgets,
large-document memory/disk, installed/provider/full R01 and clean-Mac tooling remain Target;
no Product-ready/Win/performance claim. Record 66 still governs Computer Use retirement.

## Bimax Thread undo local gate — 2026-10-06, record 73

- Every remaining backup is checked before file mutation. Missing, nonregular, oversized,
  symlinked or detectably changing saved copies refuse; unprotected engine overwrites remain
  explicit in the journal and history reports partial coverage.
- Canonical project/state/backup/Bin containment detects escaped parents and missing-path
  ancestors. Undo cannot move its own journal/backups. Leaf rename links remain supported;
  replacement/Bin targets and saved-copy/journal leaf links refuse.
- Canonical state aliases share one in-process undo lock; undo-back-to retains it for the
  whole batch. Errors release it. Existing app idle-engine checks remain.
- Replacement files are staged and checked before current versions go to the Bin. Final bytes,
  size and mode are independently reread. Creation and move postconditions reflect actual disk
  state; observable Bin files also verify type/bytes/mode/source absence. Observable directories
  verify type/source absence, without claiming recursive content verification.
- Verified indexed step receipts precede the final undo marker. Retry skips completed steps and
  preserves later human edits; history exposes progress. False-success callbacks leave entries
  pending. Malformed operations/step indices and duplicate IDs refuse.
- Sixty-seven focused tests and nineteen executable assertion-caught mutants pass, with exact
  mutation restoration hashes. Initial compiler failure is invalid, not a kill.

Evidence: [record 73](73_THREAD_UNDO_RELIABILITY_SPRINT.md). Native Finder/iCloud/permission,
crash/fsync, cross-process path swaps, historical backup integrity and full R01 remain Target;
no atomic multi-file guarantee. EACCES/EPERM Bin sources have destination-presence-only checking.
Known PDF-layout timeouts remain unresolved and retained. Record 66 still governs retirement.

## Transaction local gate — 2026-10-06, record 72

- Simultaneous tracking of one path takes one baseline, retains every declared intent and restores
  one record. Pending tracking cannot cross commit/rollback into another transaction. Busy operations
  report refusal; automatic rollback never claims an operation completed when it could not start.
- Begin/tracking/recovery cannot overlap restoration. Recovery cannot run inside an open transaction.
  A later rollback keeps earlier unresolved records; status shows every retained transaction.
- Bytes matching the baseline do not certify permissions. External modes are kept as conflicts;
  forced restoration and ordinary restoration independently reread bytes and mode. Failed writes,
  read-back mismatches and symlink chmod failures retain their original baselines.
- Baseline reservations, including unresolved recovery buffers, respect the aggregate byte budget
  under simultaneous reads. Release after refusal/commit/restoration is observable. Short reads
  fill completely; detected growth/path replacement and dangling symlinks remain unprotected.
- `/tx status` reports actual protected/unprotected/pending coverage and held/reserved bytes.
  Refused command operations are errors. Forty-four focused tests and twenty-one executable
  assertion-caught mutants qualify these local paths; mutation restoration hashes match.

Evidence: [record 72](72_TRANSACTION_RELIABILITY_SPRINT.md). Full installed R01, durable crash
recovery, external-writer atomicity and process-wide performance remain Target/unmeasured. Initial
broad and isolated PDF timeouts are retained and unresolved; no assertions are weakened. Record 66
continues to govern Computer Use retirement.

## Background shell local gate — 2026-10-06, record 71

- A BashTool background ID is discoverable and inspectable by TasksTool; list/get/wait expose
  real state, bounded captured output and observed exit/failure, never positive verification by
  invocation alone. Returned output retains untrusted shell provenance and taint.
- Targeted wait ignores unrelated completion, wakes from lifecycle changes and aborts on Stop.
  Completion/timeout/abort dispose both subscriptions and the single deadline. Shell pause/resume/
  stop remain exact-ID controls through existing handles and cannot overlap sibling calls.
- Paused close races reach their real terminal state. Cancellation wakes a paused cooperative
  process; an ignored termination escalates to the inherited process group. Terminal status
  follows pipe close, and no closed task retains a signalling timer. Escaped groups are out of scope.
- Split UTF-8 characters and logical lines remain intact; stdout/stderr fragments do not combine
  into false diagnostic paths. Retention and per-line clipping remain bounded. Explicit short
  background timeouts apply; a synchronous failed start never returns OK/exit 0.
- Real fixtures observe cooperative handler output and absence of a resistant parent/descendant;
  thirteen executable mutants fail assertions. Root/app builds, offline suites, protocol fixtures,
  staged worker exchanges and unrelated dirty-file identity checks pass. Installed/full C04/R01,
  provider quality, performance/energy and distribution remain Target/unmeasured.

Evidence: [record 71](71_BACKGROUND_TASK_RELIABILITY_SPRINT.md). Record 66's Computer Use retirement
remains the product boundary.

## Fresh-chat local gate — 2026-10-05, record 69

- Explicit repository opening creates an empty Bimax Thread; old history appears only after selection.
- **New** creates another empty conversation in the current folder. Credential renewal keeps the
  selected conversation and queued inputs even when another conversation was updated more recently.
- Real recorded replay publishes no old tool calls into live ProtocolHost, appStore, SessionRecorder,
  saved Thread files or the desktop renderer. Concurrent live events still arrive. Replay does not
  consume live steering, settle checks, close metrics or mutate capability/taint state.
- An unchanged file-tool recording replays identically without double provenance fencing.
- Mutations must fail behavioral end-state assertions. Inspect both staged and installed code bytes,
  package inventory, signature and worker exchanges. A disposable packaged-window journey is a bounded
  local qualification; installed live-provider greeting, crash/reaper/R01 and clean-Mac release remain
  unmeasured. Evidence: [record 69](69_FRESH_CHAT_AND_REPLAY_ISOLATION.md).


## Current code-only gate — 2026-10-04, record 66

- No look, press, type, scroll, native app automation service, Computer Use preview menu or Accessibility/Screen
  Recording request path ships. The retired driver (`@trycua`/`@ubjs`) is absent inside and outside ASAR.
- Neither saved preview settings nor inherited or explicitly supplied CU environment flags register tools or alter
  prompts. Both quick and project engines retain their coding tools. The real container is checked with stale flags on.
- Old `host_call` protocol frames refuse immediately without native execution or approval cards; `host_result`
  remains an ignored compatibility frame. The governor refuses COMPUTER_CONTROL before Bimax Thread scope, rules,
  bypass or any other shortcut. Reserved native-control MCP names remain blocked by the existing MCP boundary.
- Known direct GUI shell commands refuse without advertising retired tools. Ordinary coding commands, browser
  research and local-build opening by path remain. This narrow pattern guard is not a sandbox for arbitrary scripts.
- Finder folder selection and explicit on-device dictation retain their AppleEvents/Microphone usage descriptions.
  They confer no general app-control authority. No broad ban on those unrelated permissions is reinstated.
- Thread IPC ownership guards from the 2026-10-04 fix remain enforced. Same-Thread restore remains supported;
  installed race/reaper/crash journey qualification remains unresolved; fresh-open is locally qualified by record 69.
- Grade the staged AND installed app: no CU payload/menu/tool, real engine worker exchanges, App Intents embedding,
  signature, installed artifact hashes and successful launch. Mutations must break the retirement/ownership checks.
  A local self-signed install is not Developer ID, notarization, clean-Mac distribution or a competitive Win.

Enforcement: `src/__tests__/computer.retirement.test.ts`, `app/src/__tests__/computer.retirement.test.ts`,
`src/__tests__/gui.automation.guard.test.ts`, real registry/prompt/port tests and
`scripts/verify-desktop-package.mjs`. Evidence: [retirement](evidence/2026-10-04-cu-retirement/README.md) and
[Thread ownership](evidence/2026-10-04-thread-ipc-isolation/README.md). Feature-specific positive CU tests were
hash-verified into the external archive; stronger refusal tests replace their active admission boundary.


## Historical Computer Use admission gate (2026-10-02 — retired by record 66)

It replaces the code-only gate of 2026-09-02 below, in the same change that let Computer Use back in, look only; stage
3 widened it by exactly one press, in the same change that added the press; stage 6 (§6h, the owner's choice on
2026-10-02) widened it to using any app the person allows — press and type — in the same change that built it.
Enforced by `src/__tests__/computer.admission.boundary.test.ts` and `scripts/verify-desktop-package.mjs`.

- The coding surfaces are unchanged: create/read/edit/multi-edit/delete/mkdir, shell, tests, git, search, LSP, review,
  plans, checkpoints, subagents, browser research and ordinary MCP integrations; `files`, `git` and `security` in the
  app reach for no Accessibility, Screen Recording or Computer Use code.
- No window exposes Control Mac, Live Target, takeover, Computer Use model readiness or a Trust Center journey. The
  entry points are the menu bar items "Let Tasks Look at Other Apps (Preview)" and, usable only while that is ticked,
  "Let Tasks Use Other Apps (Preview)" (a new setting: stage 3's test-app switch is not carried over) — **each off
  until the person ticks it**.
- With it on, a new ⌘2 task's engine gets `LookAtAppTool` (list apps, look at one app's front window) and nothing
  else; project windows do not. Only the app's own decision for that engine sets `BIMAX_COMPUTER_LOOK`; an inherited
  value is dropped.
- The first look at each app in a task raises a card the **app** raises and answers ("Let this task look at …?",
  Allow / Not now; with using on, "Let this task use …?", Allow using / Only look / Not now; an app allowed for looking
  before using was on is asked again before its first step); the answer is remembered for the task; stopping it —
  closing it or any Stop of its turn — ends every grant. Bimax itself, the password and keychain apps and System
  Settings (by bundle id) and password managers, wallets and banking apps (by name) are never looked at or used.
- **Using other apps (stage 6, §6h; replaces stage 3's test-app press).** With both items ticked, a new ⌘2 task also
  gets `PressInAppTool`, `TypeInAppTool` and `ScrollInAppTool`: one AX press of one named, enabled control whose own
  action is a press (not a menu, pop-up or text box), or one item of a pop-up chosen without opening its menu; one line
  set as one text box's whole value (never a password field, never a line break, at most 2,000 characters), then, only
  if asked, that box's own Return (its AX confirm); or a background wheel scroll over one named control, 1–5 pages — in
  an app the person let the task use. Each step is bound to a read of that
  window under two minutes old — a look, or the re-read of the step before — and each read allows one step. Every step
  meets the governor's computer-control floors first (sensitive targets and "not while unattended", **before** the
  Bimax Thread branch — record 46's trap — and plan mode); in a Thread the engine then raises no card of its own and
  **the app decides**: an ordinary step runs; a press whose name holds a commit word (send, pay, buy, delete, confirm,
  OK, allow, … in seven languages), a press inside a sheet or dialog, a name with no Latin letters, and the first press
  after Bimax typed into a box that is not for searching all stop on the app's card, which shows the window, what Bimax
  last opened there and the typed text as the box reads it — never the model's words; a pop-up item is judged the same
  way (and by the pop-up's own name); Return in a box that is not a search box (its role, its name, or a child control
  named Search) asks, showing the box's text; typing over text Bimax did not put there asks, except in a search box;
  every 40 unasked steps the app asks "Keep going?". Names match with invisible marks ignored, and a name over 120
  characters may be given by its start, if exactly one control starts that way. No card can be granted for the task. A Stop,
  either item unticked, or the window changing (the driver re-reads it and must find the control exactly once) cancels
  a step that has not been sent. A step is sent once, by element token, in the background, and never retried; the
  window is read again; "nothing changed" is a failure, and typing counts only if the box reads back exactly the text.
  A use session's manifest allows `click`, `set_value`, `scroll`, `type_text` and `press_key` and still denies every
  other input tool by name — shortcuts, dragging, coordinates, launching or keeping an app in front. Window reads get
  4 s, and a read still cut short is reported as partial.
- **One step with the app brought forward (ability 4, the owner's choice: asked every time).** A press or a typing may
  carry `front`: the app asks first — on the step's own commit, overwrite or Return card, which then says so, or on its
  own card ("Bring … forward for a moment?", naming the step and the app it will put back) — never for the task, never
  for a scroll or a pick. The driver then fronts the window for that one step and puts the previous front app back: a
  press by element token; typing as keystrokes into one box emptied first (read back empty) and read back exactly;
  Return as the one key ever sent (`press_key` with `key: 'return'`, only in front, only into a box). Afterwards the app
  reads which app is in front and says whether the person's app came back; it never moves apps around to fix it.
- **Missing-name recovery (§6h).** A `not_found` control reply may suggest at most five names and roles from the
  granted app's still-fresh observed window, filtered for the requested action and excluding password fields. Names
  are quoted as data; long names supply a bounded copyable prefix under the existing unique-prefix rule. Ranking is
  a hint only: the missing request performs zero input, creates no action approval, renews no observation, and logs
  no screen text. Copying a suggestion still meets every exact-target, freshness, build, grant and approval check.
- **Tool recovery contract (§6h).** Omitted look action may default only to read-only looking at an explicit app;
  missing app or explicit invalid actions refuse. Missing-app names are not proof that an app is closed; suggestions
  use only eligible observed running apps, never auto-authorize an alias. A single literal foreground shell launch
  may return copyable background-launch advice for the same app, without executing it or skipping shell approval/sandbox.
  No constructed retry copies compound shell syntax, arguments or substitutions; driver launch remains denied.
  Copyable target/search retry hints use actual re-read controls and
  leave foreground and commit cards intact. Never suggest replay of an unchanged Return in a non-search box or of
  uncertain input; never execute a suggested retry automatically. Live model compliance requires independent grading.
- **Native session lifecycle (§6h).** Waiting on a card must not reuse an expired native use context: each approved
  step starts a fresh bounded, app-scoped context before re-reading its exact target. Native labels are unique;
  retired contexts, manifests and observer mappings are removed. Read-only renewal happens once, only for a native
  lease/end error, and stays inside the existing Bimax Thread grant and generation. Never replay an input dispatch.
  A pinned explicit unready-window/AX timeout may retry its read once after a brief settle, still generation-bound.
  Generic permission/lease/Accessibility-word errors do not prove missing macOS Accessibility. An admitted failed look
  may query the app's own native trust without prompting; granted trust forbids missing-permission coaching. Hosts
  without that query need explicit denial text. Use the permission's current OS name, and retain only a fixed failure
  enum/optional boolean in the audit. Controlled expiry/denial/revocation and input-count checks catch broken recovery.
- **Which build is running (stage 5).** A look names the running executable and its SHA-256, read by the app from the
  process; a step is refused if that executable changed since the read (a rebuild or relaunch), and its receipt
  records the hash of the build it acted on.
- Turning the preview off closes granted sessions. A stop or off/on cycle invalidates in-flight discovery, grant
  answers and observations: no late approval may recreate a grant and no revoked observation reaches the model.
- The driver runs in-process, `bounded`: a runtime manifest that may list apps only, and per grant a version-2
  manifest naming one app, allowing `list_apps`, `list_windows`, `get_window_state`, `get_screen_size` and denying every
  input tool by name. The menu bar is cut out of every observation and password fields lose their value; the text
  reaches the model fenced as untrusted and taints the session.
- The engine still rejects `bimax-mac` and skips MCP tools named `mac_control`, `computer_control` or `computer`; Desktop
  still strips the old CU environment variables and emits no host capability for them.
- The bundle contains no XPC service, CU bridge/helper/preview or Mac capability provider. The one Computer Use part is
  `@trycua/cua-driver` **0.31.0**, outside the archive, with no driver command-line binary and no perception extension.
  Declared usage descriptions stay exactly AppleEvents and Microphone (voice).
- Launching and completing a code task requests no TCC permission. The driver loads only for an admitted look-capability
  request; app discovery may start the list-only runtime before the per-app card, but window reads require its Allow.
  Widening any of this — another tool, another operation, an input permission, another entry point — must make a test
  fail.

### Code-only product gate (2026-09-02 — replaced by the admission gate above)

- Terminal and Desktop expose create/read/edit/multi-edit/delete/mkdir, shell, tests, git, search,
  LSP, review, plans, checkpoints, subagents, browser research, and ordinary MCP integrations.
- Neither frontend exposes Control Mac, Live Target, takeover, Computer Use model readiness, or a
  permissions/Trust Center journey.
- The engine rejects `bimax-mac` and skips MCP tools named `mac_control`, `computer_control`, or
  `computer`, regardless of the advertising server name.
- Desktop strips inherited CU environment variables and never emits a Mac host capability.
- The app bundle contains no XPC service, CU bridge/helper/preview, Mac capability provider, or
  Accessibility/Screen Recording/Microphone usage description.
- Launching and completing a code task requests no TCC permission. Reintroducing a provider,
  payload, or UI entry must make the boundary test fail.

The target is not a cosmetic `n/n`. A test counts only if it fails when the feature is deliberately
broken and grades the real end state. Provider outages, missing observations, stale fixtures, and
model changes are invalid runs, not product failures or passes.

## Gates for every product change

- work implementing an owner-vision capability names its V-ID and research card from
  `12_ALL_VISION_SECTIONS_RESEARCH_PLAYBOOK.md`, including baseline, candidates, hard constraints,
  metrics, mutants and adoption rule;
- unit/contract tests fail against a deliberately neutered implementation;
- typecheck, lint/build, offline tests, and protocol fixtures pass with zero unexpected failures;
- no test is deleted, skipped, loosened, or changed from end-state evidence to “something happened”
  merely to reach green;
- runtime artifacts do not mutate user model/config or leak across fixtures;
- claims name product, backend, model, build, run count, discarded count, and raw artifact.

## Bimax Terminal release gate

- coding smoke matrix passes: inspect, edit, multi-file change, failing-test repair, review-only,
  interrupt, resume, and dirty-worktree preservation;
- TUI build/vet/test and protocol golden fixtures pass on supported macOS architectures;
- warm start and interaction latency meet recorded budgets;
- archive contains engine/TUI/licenses only—no CU driver/service/helper/PiP;
- no Accessibility or Screen Recording prompt appears on a clean Mac;
- non-interactive JSON/NDJSON output is schema-valid.

## Bimax Desktop coding gate

- Electron is on a currently supported major/minor line and the chosen minimum macOS is enforced by
  app packaging and native targets;
- pinned engine digest matches lock file and release manifest;
- current and previous supported protocol versions pass golden fixtures;
- engine crash, hang, malformed frame, upgrade mismatch, resume and diagnostics are visibly handled;
- project file, PTY and git IPC reject traversal/malformed payloads;
- code task works with zero CU permissions.

## Retired Bimax Desktop computer-use gate (historical; must not ship)

- packaged app, not a dev shell, owns the permission and focus experience;
- a Control Mac task cannot reach the engine until the active provider credential, a currently
  served curated Work row for the configured model id, and a currently served screenshot-capable
  route are confirmed; one unique catalogue row may carry several slot recommendations, and
  `avoidAutoSelect` never vetoes a model the user intentionally selected; a served
  Vision/unknown model with no Work row and provider timeout/error are visible blocked states,
  never implicit fallbacks;
- once admitted, an explicit Control Mac turn is narrowed to the app-owned `mac_control` capability
  as its only acting authority; the engine may expose only its bounded read-only memory/code RAG
  tools beside it, never shell, file mutation or a third-party Computer Use provider, and the turn
  cannot terminate on model narration alone; if the route fails to invoke the tool after the
  bounded activation retries, the task ends with a concrete model-route blocker and an idle UI;
- the authenticated task plan is bound from the explicit user instruction before model execution
  and does not depend on whether the Desktop provider registered before or during that turn; a
  missing/invalid plan fails closed, and the UI labels that result blocked rather than completed;
- provider secrets are stored through macOS Keychain-backed main-process storage and never appear
  in renderer persistence, NDJSON, diagnostics or logs;
- app bundle/XPC/bridge/helper signatures and locations pass structural verification, and the exact
  signed packaged app executable proves Electron → bridge → intact app-bundled XPC service through
  a no-window handshake (a direct service self-test does not satisfy this gate);
- the exact native service permissions, not merely the Electron host permissions, gate readiness;
- add-by-drag permission guidance exposes a real native bundle drag source, keeps System Settings in
  front and names the bundle that must land in the list;
- native semantic, native physical, visual recovery, and stop paths each have a test that forces that
  level and proves the postcondition;
- stale frame/element handles and identical failed-call loops are rejected;
- pause/takeover prevents all agent input until explicit resume;
- action receipts bind target app/window, fresh observation, executor, and postcondition;
- background/foreground classification is measured per action and shown truthfully;
- Messages demo uses a safe test contact/account until the user explicitly approves a real send;
- native arbitrary-task evaluation is reported separately from the narrow exact-state benchmark;
- compatibility/legacy backends cannot silently activate in a production build.

## Contextual macOS intelligence gate — owner section 28

- Code remains fully usable with all optional intelligence/CU permissions denied or revoked;
- every finding binds task intent, observed identity, causal evidence, violated expectation, rule or
  model version, freshness/completeness, confidence and disposition;
- an evidence gap, dropped event or unavailable sensor cannot produce an unqualified safe verdict;
- deterministic hard floors, learned anomaly ranking and model explanation are separate in receipts;
- no model/remote call/UI prompt appears in an Endpoint Security authorization deadline;
- correction proves before state, authority, preview, approval, fresh precondition, exact mutation,
  independent postcondition and rollback;
- dirty project/environment state survives correction except for the approved mutation;
- permission grant, denial, revoke, update, extension crash, event loss and queue overload pass on
  the fresh-Mac matrix;
- benign multi-project corpora meet declared false-positive, notification-volume, CPU, memory,
  energy-proxy and latency budgets;
- a deliberately stale/forged observation or false repair causes the evaluator to fail.

No Endpoint Security or Network Extension gate applies until Apple grants the relevant entitlement
and the feature is actually shipped. Lack of that entitlement cannot block the nonprivileged
contextual-receipt product.

## Modular ecosystem and environment gate — owner section 29

- read-only inventory does not execute project scripts, source untrusted shell profiles, expose
  secrets or mutate the environment;
- every executable capability has immutable digest, signed/fresh metadata, publisher/provenance,
  platform/architecture constraints, declared authority, health state and rollback target;
- expired, downgraded, revoked, dependency-confused, traversal, decompression-bomb, identity-drift
  and overprivileged fixtures fail before activation;
- extensions run outside the renderer and cannot bypass nested approvals, path/network/process
  capability handles, resource limits, cancellation or output limits;
- a skill's instructions and MCP tool metadata are untrusted and cannot self-grant capabilities;
- environment changes show exact project/global, download/disk, script, license/provenance and
  rollback impact, then re-inventory and run a project-relevant postcondition;
- iOS runtimes remain Xcode-managed and Android components use official tooling;
- optional Computer Use remains app-owned and Terminal release inventory stays CU-free;
- extension/package crash, compromised metadata, failed activation and failed upgrade restore the
  exact prior graph without harming dirty work;
- ML optimization compares task quality, behavior, latency, memory, artifact size, device/fallback,
  provenance and reproducibility; a smaller but unacceptable model must lose;
- adaptive runtime/rendering policies publish named signals, thresholds, hysteresis, bounds,
  accessibility rules, override and measured device/workload result;
- Reduce Motion and interaction responsiveness are hard constraints regardless of available GPU.

The complete S28/S29 journey tables and claim ladder live in
`11_SECTIONS_28_29_RESEARCH_AND_DELIVERY_PLAN.md` and are part of this gate by reference.

## Fresh-Mac install matrix

At minimum test the oldest supported macOS and current macOS, arm64 and x64 where shipped:

- first download/install/launch from a quarantined browser download;
- manual Open Anyway alpha flow, if applicable;
- Screen Recording request, restart, Accessibility grant, revoke, re-grant;
- app update with grants already present;
- engine/native-service update compatibility and rollback;
- uninstall leaves user projects untouched and documents retained app data.

## Distribution channels

### Manual-install alpha

- prominent unsigned/unnotarized label;
- SHA-256 manifest over the exact DMG/app and visible verification instructions;
- exact in-app build/service hashes;
- explicit warning that macOS may request permissions again after updates;
- no claim of automatic trusted updates or no-warning install.

### Stable public release

- Developer ID signing of app and every nested executable with consistent identity;
- hardened runtime and minimal entitlements;
- Apple notarization accepted and ticket stapled;
- Gatekeeper passes on a clean quarantined download;
- permission persistence across a real update;
- signed update mechanism with rollback.

Electron documents that macOS update delivery expects signed builds, while Apple requires Developer ID
for notarization. If the owner chooses not to sign, the product can remain a serious alpha, but it
cannot honestly pass the stable distribution gate.

Sources:

- [Electron: Updating applications](https://www.electronjs.org/docs/latest/tutorial/updates)
- [Electron: Code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Apple: Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
