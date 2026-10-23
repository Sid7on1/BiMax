# @CU message routing and exact-window authority

2026-10-10. The owner approved an explicit `@CU` composer entry into the built-in
Bimax CU feature. This extends records 79/80; it does not restore an MCP connector
or the retired legacy driver. All 100 original Arc files, all 34 package modules,
MIT attribution and pinned provenance remain unchanged.

## Implemented behavior

An exact leading `@CU` (case-insensitive, followed by whitespace or end of text)
activates a visible Computer Use chip in both the project composer and the ⌘2
floating bar. `@c` offers completion. Quoted examples, email addresses, paths and
embedded mentions do not activate it. The user chooses a running app and one
window before sending. Listing apps starts only when the picker opens. Reading
window names requests its own contextual consent and Accessibility permission;
that consent is not a task read grant or an input approval.

The main process issues a bounded, ten-minute, single-use target receipt tied to
the renderer and current Bimax Thread or fresh draft generation. The receipt binds
PID, bundle identity, executable path/hash and window ID. Selection changes,
cancellation and asynchronous owner retirement cannot populate a new conversation.
A queued CU message remains a separate turn rather than steering the active task.
At dispatch the host consumes the receipt and reconstructs the trusted route. A
saved route cannot survive app restart as authority: it refuses without falling
back into a coding turn. Routing context goes to the engine; the transcript echoes
the user's words and target, without that internal context.

Only `BimaxCuTool` and clarification are available for this turn. The generic engine
validates required host availability before provider/history changes and enforces
the allowlist at execution as well as schema selection. CU is scope-only: ordinary
coding turns do not advertise it or gain authority by guessing its tool name. The
per-turn protocol is 3.7.0, retaining major-version compatibility. Terminal receives
no native binary, permission owner or native implementation.

The native executor independently enforces the selected app and exact window;
this is not just prompt text. It filters discovery, rejects foreign PID/window,
revalidates executable identity, and refuses app-wide menu commands on this route.
Every task read still asks separately, every input still asks, snapshots remain
short-lived/single-use and Stop/end revoke native authority. Inputs also check the
actual read-only/unattended approval snapshot, not just the displayed mode. Existing
bounded workflows validate all steps before action and verify fresh postconditions.

Targets clear after accepted sends; the next ordinary message does not inherit CU.
Failed sends preserve the draft and show the error. Do/Guide/Teach, saved workflows,
foreground-window shortcuts, Pause/Take Over/Resume and mixed code-to-CU handoff
remain **Target**, outside this first version.
Record 82 subsequently implements Do/Guide/Teach, saved verified instructions and
in-turn Pause/Take over/Resume; foreground shortcuts and mixed code-to-CU handoff
remain separate targets.

## Qualification

Guidance: current product-reset README, interaction 03/04, architecture 05,
migration 07, acceptance 08, Mac Buddy vision sections 19–25, competitive evals 06
and M02/X01 example contracts. Earlier boundary/provenance research in records
79/80 still applies. `competitive/03_CAPABILITY_MATRIX.md` remains missing.

Evidence: `evidence/2026-10-10-at-cu/`. The restored implementation passes 155
focused tests (one historical skip), 346 broader regression tests and six Bun
registry contracts, app typecheck and protocol generation/root TypeScript build.
The actual bundled Composer/useEngine and floating-bar components pass seven
browser end-state checks with no browser errors. These use a fixture preload
bridge, not native desktop/provider execution. Three invalid exploratory fixture
runs are preserved and excluded; their fixture state/timing/focus errors were
corrected. Ten implementation faults are assertion-caught, including execution
scope, ordinary schema exposure, receipt/selection ownership, saved-route downgrade,
actual approval state and exact-window enforcement. A mutation that removed only
one of two redundant window guards survived; it is retained and not counted.

Build/install/native saved-model results are scoped below. No
full M02/X01, model-tier/repeated reliability, clean-Mac/Intel/notarization or
latency/energy claim follows from these local contracts. Status is **Implemented**
with the explicitly scoped local evidence above, not Product-ready or a Win.

The first installed @CU attempt exposed a discarded approval snapshot in the
shared app normalizer; the new fail-closed native gate correctly refused before
read/input. The normalizer now preserves only fully boolean approval settings,
and a regression exercises the actual engine reducer through the authority check.
Removing that normalization is a tenth assertion-caught fault. The failed installed
attempt is retained as `live-invalid-approval-normalization.json`, with unchanged
fixture state. Untitled windows now include their native ID to disambiguate targets
without reading UI content or requesting Screen Recording just for names.

The corrected local arm64 v2 bundle passes deep/strict codesign, packaged engine,
private CU/source inventory and app-action gates. Its installed inventory matches
all 583 staged files/symlinks; all 250 protected profile JSON files match across
replacement. The previous bundle remains recoverable. Local signing is unhardened
and not notarized. Xcode's unaccepted license used the existing CLT fallback for
helpers and legacy .icns; it was not accepted automatically. The first build failed
on an incomplete cached PyInstaller install; a fresh build environment succeeded.
Receipts: `build-v2.log`, `install-v2.json`, `installed-v2-package.log`.

The corrected build's first saved-model request made two actual native inputs and
persisted the requested text with one Save, but is **partial**, not a pass: the
model supplied `expect.value: "Saved"` while the actual label is `Saved: <text>`.
Exact comparison refused verification and did not retry either input. The receipt
is `live-v2-partial-exact-postcondition.json`. The picker and SET_VALUE approval
were directly observed; task-read and Save dialogs were not captured by the agent.
Do not infer those dialog UX checks from the workflow's acknowledgement. A fresh
request with a new value and an explicit full postcondition is a separate test;
reliability on inferred postconditions remains Target.

**Measured: one corrected installed @CU request with an explicit exact
postcondition**, saved gpt-oss-20b on this arm64 Mac, one owned fixture. The actual
composer selected window 697 in PID 10526 and echoed the visible @CU message/target.
The model completed apps → windows → observe → one ordered workflow, with two
verified inputs and a fresh native field/status readback. Independently persisted
fixture state changed from saves=1 to saves=2 with exactly the new requested text;
there was one additional Save, not an automatic replay of the partial attempt.
The task ended idle. `live-v3-model-workflow.json`, `live-v3-before.json` and the
retained `grade-live.py` prove this bounded result; seven corrupted result receipts
are assertion-rejected, including duplicate save, foreign window and coding-tool
execution. The actual installed transcript also visibly reports the verified result.

The exact expected status was supplied in this fresh test. This does **not** qualify
inferred-postcondition reliability, repeated/model-tier reliability or a full
M02/X01 journey. Individual task-read/input dialogs in this final run were not
captured by the agent; the prior picker/SET_VALUE observation and local authority
contracts remain the scoped approval evidence. CUA could not bind the custom
fixture app for a separate AX read: the fresh AX evidence here is the native
workflow's readback, checked against the independent fixture file. Do not upgrade
this to independent external AX inspection or a broader native UI qualification.
All 128 original conversation item/input histories remain unchanged after live tests
(`post-live-integrity.json`). No latency, energy, release or competitive Win claim.
