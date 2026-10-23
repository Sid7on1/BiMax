# CU modes, interruption and verification recovery — 2026-10-11

Status: **Implemented**. Verification receipts and installed scope are recorded below.
This extends record 81; Mac owns native authority through the private host channel.
Terminal receives no native binary, permissions or CU ownership.

## Behavior

Both the project composer and ⌘2 bar offer Do, Guide and Teach for each @CU message.
The mode accompanies the main-owned target receipt through queued dispatch.

- **Do** runs the approved ordered workflow and checks actual app state.
- **Guide** presents each step, lets the person act, and checks the result when they
  choose Check step. The host refuses all native input operations in this mode,
  including direct tool calls. A button click is not evidence of completion.
- **Teach** explains the currently approved step and offers to save the workflow
  only after every step is verified. Saved instructions contain literal values and
  exact selectors/postconditions, without process IDs, snapshots or grants. They
  persist in the Mac profile. Reuse loads an editable @CU message; the person must
  choose a fresh target and approve reads/inputs. This is an explained, reusable
  workflow, not background keystroke recording or generalized demonstration learning.

Task read/input approvals are revision-bound cards in the CU panel. This keeps
Pause and Take over reachable during approval, unlike an app-modal dialog. Picker
consent remains separate. Every read grant and every input still require explicit
consent; project auto-approval is not inherited.

Pause/Take over abort pending approval, revoke snapshots/read grants/commands and
latch future native work. Resume requires an explicit current control, reobserves
and revalidates process/build/window identity, and asks again. An already dispatched
input may finish; its result is checked after resume and never replayed. Unknown
input completion stops with a partial receipt. Stop/engine end cancels waits and
closes native authority. Guide and verification waits do not hold the global native
queue. Concurrent model operations cannot bypass a waiting workflow.

These are in-turn controls, bounded by the existing ten-minute host-call deadline.
Crash/relaunch never restores authority or resumes input automatically.

## Earlier incorrect expected status

Record 81's model asked for exact `Saved`, while the fixture actually displayed
`Saved: <text>`. Exact comparison remains strict. The controller now performs up to
three independent readbacks for delayed state, without repeating input. A changed,
unique StaticText status can be presented for explicit human correction. The host
checks the chosen exact value again against fresh state and verifies previously
established fields. Missing, unchanged, ambiguous or stale results fail.

Correcting a check never repeats the action. Successful receipts identify
`user-corrected-expectation`; they do not claim fully autonomous inference. The
same correction is available after a human-performed Guide click. A no-op driver
`done` cannot become verified success. Failure includes completed/attempted steps
and the last observed state.

## Verification and scope

Guiding contracts: product-reset README, records 79–81, architecture 05, roadmap
07, acceptance 08, product examples 03, frontend 04, Mac Buddy vision, competitive
README/model-independent strategy/evaluation rules and M02/X01 example contracts.
The referenced competitive capability matrix is still absent; the existing gap
register already records that documentation conflict. No competitor fact or source
was added. All 100 pinned Arc source files and MIT attribution remain unchanged.

Evidence lives in `evidence/2026-10-11-cu-modes/`:

- `focused.log`: 174 tests across 11 suites passed, including native authority,
  workflow, saved instructions, transferred host channel, route and chat lifecycle.
- `regression.log`: 346 tests across 48 suites passed.
- `renderer.json`: eight production-component end-state checks using a fixture
  bridge, zero browser errors. Includes both mode routes, held Guide mode, current
  approval/control revisions, explicit correction, Teach save/review and foreign
  conversation events. This is not native execution qualification.
- `faults.json`: nine assertion-caught implementation faults; source restored,
  then the focused baseline rerun. `faults-invalid-typecheck.json` preserves the
  excluded first probe with three compile failures. They are not assertion proof.
  An independent-read probe initially timed out, and a narrower probe survived
  because retry observation still ran. Those exploratory logs are retained and
  excluded. Removing all post-input readbacks fails a result assertion; the
  restored 74-test workflow/route/recipe baseline passes.
- Twenty distinct values passed exact ordered verification against the deterministic
  fixture's separately maintained text/save count. This is host regression coverage,
  not twenty live provider runs or model-tier qualification.
- App typecheck and build/package qualification are recorded separately below.

The first renderer probe used an incorrectly global fixture state response across
Bimax Threads; that run is invalid and preserved as `renderer-invalid-fixture-state.json`.
The fixture now keys state by conversation, matching the real host.

Full M02 bystander typing/focus/reopen, X01, repeated live model-tier resilience,
clean-Mac/Intel/notarization and performance/energy claims remain separate gates.

## Installed native checks and retained failures

The first signed arm64 build was installed at `/Applications/Bimax.app`, matching
all 583 staged files/symlinks. Its app.asar SHA-256 is
`c9d269bce3f4e2e6fbea19139dd81a681752ce366fe3423f196c9f1e04f847dd`.
`build-v1.log`, `installed-package.log` and `install.json` retain engine exchanges,
package/source/private-protocol checks, signing and replacement evidence. All 274
protected JSON files matched across the replacement itself. Before replacement,
the key-use counter had changed during validation; that difference is retained in
`preinstall-profile-delta.json` rather than described as an immutable profile.

- **Teach, one saved gpt-oss-20b run:** the intentionally incorrect exact `Saved`
  postcondition reached the correction panel. Pause/Resume and Take over/Resume
  were exercised there; correcting the status required a fresh read approval.
  Pausing that approval removed it, and resuming required a new approval. Fresh
  readback verified the exact corrected status and earlier field. Persisted Saves
  changed 2 → 3, with exactly the requested text, two input attempts and no replay.
  The receipt labels human assistance. The verified literal workflow was named
  and saved; a new app session showed it in the picker and loaded it into an
  editable composer without granting a target or sending it. See `live-teach.json`
  and `live-saved-workflow.json`.
- **Guide, repeated after interruption:** the initial run was interrupted by an
  app/session restart before its final Check step. Its native authority was not
  restored; `guide-interrupted.json` is excluded from success qualification. A new
  owned fixture and fresh selection then completed both steps. A separate
  `cua_repl` fixture binding performed SET_VALUE and exactly one Save; Bimax only
  read and checked. Persisted Saves changed 0 → 1, with exact field/status readback,
  zero native attempts and `input:false` for both completed steps. This is a
  separate control channel acting in the human lane, not physical-human or
  bystander typing qualification. See `live-guide.json`.
- **Rejected Do plan:** saved-workflow reuse with the old instruction wording
  produced redundant model questions, followed by a CLICK-only plan that skipped
  the field edit. The operator denied the native approval; the fixture stayed
  unchanged with no additional Save. The model's final prose incorrectly called
  that denial a system permission problem. The authoritative panel/receipt said
  input denied. This attempt is retained in `do-invalid-plan.json` and excluded
  from successful qualification. It demonstrates that broad model interpretation
  and prose reliability are still Target.

The resulting polish makes newly saved instructions request one complete ordered
workflow, explains that Bimax supplies the approval cards, and states that an
approval/clarification answer never means an action executed. The trusted turn
instructions repeat that requirement. Transcript activity now says **workflow
steps**, including Guide, rather than implying those steps were native inputs.
`polish-focused.log` records 74 passing workflow/route/recipe checks;
`polish-typecheck.log` and `renderer-v2.json` record the typecheck and eight
production-component checks with zero browser errors. Prompt wording is a model
aid, not an execution authority or a guarantee of model compliance.

`profile-after-live.json` independently compares all 131 original conversation
payloads (items and saved inputs) and provider-credential bytes: all unchanged
after installation, live tests and restart. Normal runtime summaries, selected
folder/settings, usage/spend counters and the intentionally created test chats
and saved workflow can change during app use.

## Final installed build and narrow measurement

The polished arm64 v2 app is installed at `/Applications/Bimax.app`. Its app.asar
SHA-256 is `f813f967c2acc3ca03a694ab970b6becf7c1f00626973cfaefa976c5fb3a88cc`.
`install-v2.json` matches all 583 staged files/symlinks and all 275 protected JSON
files across replacement; `installed-v2-package.log` passes the exact installed
engine/native/source/private-protocol gate. `build-v2.log` passes seven bundled
engine exchanges and all three app-action checks. Local signing remains Bimax
Local Code Signing, unhardened and not notarized. Existing Xcode license refusal
used the documented Command Line Tools fallback; no license was accepted.

Rollback copies are retained outside the repository:

- Before this task: `~/Developer/bimax-archive/apps/2026-10-11-before-cu-modes/Bimax.app`.
- Before the wording/label polish: `~/Developer/bimax-archive/apps/2026-10-11-before-cu-modes-polish/Bimax.app`.

**Do, one final saved gpt-oss-20b run on v2:** the revised complete-workflow wording
produced one two-step workflow and no redundant clarification call. The actual
read, SET_VALUE and CLICK approval cards were separately observed and allowed.
Independent CUA AX and persisted state showed the requested literal text and
`Saved: <text>`, with Saves 1 → 2, two verified input attempts and no replay.
See `live-do.json`. This one result does not establish repeated reliability or
causally prove the prompt wording fixes every model failure.

`grade-live.py` checks the retained native Teach, Guide and Do receipts against
independent persisted effects, fresh exact AX state, exact targets, terminal task
state, input counts and assisted/exact classification. All three narrow runs pass;
33 assertion-caught receipt mutants reject missing/unchanged/wrong state, duplicate
Saves, stale/foreign observations, foreign tools, hidden assistance and Guide input.
See `live-grades.json`. Original conversation payloads and credentials were checked
again after v2 and the final Do run. The owned fixture was closed after evidence
capture; a follow-up CUA observation relaunched this disposable fixture and reset
its on-launch counter, then it was closed again. Grading uses the saved before/after
receipts captured at completion, not that post-cleanup reset state.

**Status:** Do/Guide/Teach and the in-turn controls are Implemented. The individual
fixture outcomes above are Measured within their stated scope. Broader saved-model
planning/prose reliability, repeated model tiers, full M02/X01 and distribution
remain Target; there is no Product-ready, Win or numerical performance claim.
