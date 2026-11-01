# Direct @CU experience — 2026-10-11

Status: **Implemented**. This replaces the required picker in records 81–82 at the
owner’s request. Historical receipts stay intact. No competitor source changed.

## Behavior

Type `@CU <task>` and send. Do is the default. A compact CU chip identifies the
message; Guide, Teach and saved workflows sit behind optional controls. The task
model receives only CU and clarification, discovers actual running apps, requests
windows for an actual PID and observes the intended exact window. The task and
observed context guide selection; genuine ambiguity can still need clarification.
There is no app/window dropdown or native discovery while typing.

The main process issues an ephemeral, single-use, ten-minute admission ticket at
Send, scoped to that Bimax Thread. Only main can issue/consume it. Queue dispatch
consumes it before provider calls; restart, reuse, foreign ownership or expiry
refuses without silently falling back to coding. Saved messages contain no durable
native authority. Existing manual receipts remain an internal compatibility path,
not a required UI. Native ownership remains Mac-only over the private transferred
host channel, without an MCP connection.

Automatic runs enforce actual discovered app/window IDs, refuse protected apps,
and bind read grants to process/build identity before/after consent. Every input
still requires a fresh exact-window observation, an observed action, unchanged
executable and separate approval. Foreign native snapshots and app-wide menu
input refuse. Pause revokes grants/snapshots; Resume refreshes and asks again;
Stop/end remove admission and close the native session. Workflows retain exact
postconditions, independent readback and no replay.

Running controls use readable status, compact Pause/Stop and optional takeover.
Permission cards show the task step; raw arguments/build details remain reviewable
in Action details. Teach saves only verified literal steps and actual discovered
app identity; reuse is an editable new @CU task with fresh discovery and grants.

## Verification

Guiding documents: product-reset README; frontend 03/04; architecture 05; roadmap
07; acceptance 08; Mac Buddy vision sections 19–25; competitive status/evaluation
rules and M02/X01 example contracts. The pre-existing missing capability-matrix
reference remains unresolved. No external competitor or platform claim was added.

Evidence is in `evidence/2026-10-11-cu-direct/`. Receipts:

- `typecheck.log`: app typecheck passed. `focused-restored.log`: 183 tests across
  11 suites; the later `final-focused.log` passes 105 tests across four CU suites,
  including the added automatic Teach identity and separate-app grant cases.
- `regression.log`: 392 tests across 49 suites passed. The earlier ENOSPC run is
  preserved as `regression-invalid-enospc.log` and is not qualification.
- `renderer.json`: ten production-component checks, zero browser errors. Covers
  default Do without opening options, optional modes, both composers, held/rejected
  messages, ownership, revision-bound controls and zero picker IPC calls. Dark and
  light screenshots use actual production CSS and were visually inspected.
  The initial floating-bar click-readiness failure is retained and excluded.
- `faults.json`: seven assertion-caught implementation faults, then restored source
  baselines. The first admission probe survived because it tested an already-ended
  run; that excluded attempt is retained. A new ordinary-turn discovery assertion
  catches removal of admission. No timeout/compile failure is counted as proof.
- `build.log`: seven real engine exchanges and native 100-file/34-module gates
  passed. Standard electron-builder packaging then failed with ENOSPC. The final
  app uses an APFS clone of the installed Electron 43.3.0 runtime plus independently
  verified fresh compiled app output and fresh engine/CU/voice/notch/Intents extras.
  `package-low-space.py` and `packaging.json` retain this fallback. ASAR integrity
  metadata is regenerated. Final deep strict signing, package and app-action gates
  pass in `signing.log`, `package-gates.log` and `actions.log`. A low-space signing
  attempt is preserved separately and excluded.
- To finish signing, three rollback framework files were consolidated with APFS
  clones plus their original differing blocks. `rollback-storage.json` proves
  each original SHA-256, bytes and xattrs remained unchanged; those rollback apps
  were not removed. Failed/redundant staging and a disposable download cache were
  cleared. The installed app and source were preserved throughout.
- `install.json`: signed local arm64 app installed at `/Applications/Bimax.app`,
  all 583 staged files/symlinks matched, all 276 protected JSON files unchanged at
  replacement. Rollback: `~/Developer/bimax-archive/apps/2026-10-11-before-direct-cu/Bimax.app`.
  ASAR SHA-256: `3cb114f0e2054bfec5d61c3163b19b4ebe9d533c15d8ab59069e2ae92e1d1642`.
- `live-direct.json`: **Measured** on one installed saved gpt-oss-20b Do task. The
  operator typed @CU and sent without opening options or any app/window picker.
  Bimax discovered apps → windows → exact observation → one two-step workflow.
  One app-read and two normal input cards were approved. No clarification,
  correction or manual target selection was needed. The explicit requested full
  postcondition matched: text `bimax-direct-cu-20261011`, persisted saves 0 → 1,
  fresh exact field/status readback, and independent CUA AX confirmation.
- `live-grades.json`: exact native end state passes and all 16 receipt faults fail,
  including duplicate saves, manual-target filtering, missing discovery, wrong
  IDs, stale readback, false done and partial/replayed input. An initial grader
  incorrectly expected dispatched inputs to remain queued; that invalid grader
  and its correction are retained and excluded from proof.
- `profile-after-live.json`: all 137 pre-existing history payloads and four
  credential/configuration files unchanged. The normal provider key-usage ledger
  changed during inference. Native helper ended; the owned fixture was closed.

Component fixtures are not native/model
qualification. Broader model planning/prose reliability, repeated model tiers,
full M02/X01, background/bystander journeys, Intel and notarized distribution
remain **Target**. Local signing is not a release qualification.
