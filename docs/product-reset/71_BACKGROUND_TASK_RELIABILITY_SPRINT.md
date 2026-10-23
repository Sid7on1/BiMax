# Background task reliability sprint — 2026-10-06

**Status: Implemented and locally verified.** The owner requested code inspection,
bug repairs, useful advancement and optimization. This sprint follows the coding-only boundary
of records 55/64/66 and extends the existing shell task registry and TasksTool. It does not change
the selected Outputs Shelf or start record 70's proposed behavior-tracing feature sequence.

## Findings and delivered behavior

The original focused regression run fails twelve behavioral assertions. An earlier run used a
non-configurable namespace import for a spawn spy; it is preserved as an invalid fixture attempt
and is not counted as defect evidence.

- BashTool advertised TasksTool for background command inspection, but TasksTool searched only
  the sub-agent blackboard. Shell IDs now work with list/get/wait/stop; pause/resume reuse the
  existing real process handles. Get/wait report bounded output, lifecycle state, failures and
  observed exit codes. Reading this output retains shell provenance and taint; it does not mint
  test-verification evidence or treat a captured line as a trusted instruction.
- A pending SIGTERM did not wake a SIGSTOP-paused process. Cancellation now sends SIGTERM then
  SIGCONT, gives cooperative cleanup one second and sends process-group SIGKILL if pipes have not
  closed. The one-second grace is a cancellation bound, not a measured performance optimum.
  Terminal state still waits for close, which follows pipe draining; timers cannot signal a
  closed job. Descendants that deliberately escape the process group remain outside this bound.
- A close racing pause was an illegal registry transition, leaving dead work marked live.
  Paused work now accepts observed completion/failure. Streaming work can enter a real pause.
- Decoding each pipe Buffer separately corrupted a UTF-8 character split between buffers.
  Separate stdout/stderr StringDecoders retain incomplete characters. Display chunks join the
  unfinished line only across consecutive writes from the same channel. Evidence capture keeps
  the full streams separate and retains its existing truncation/refusal rules. The display still
  retains at most 400 lines and clips each at 500 characters plus a marker. It avoids splitting
  and allocating every full line of a large chunk; last-event extraction avoids a split too.
- TasksTool ignored a requested wait target and could return when a different worker finished.
  It also ignored Stop while waiting. Wait now selects the exact task, uses lifecycle subscriptions
  with one deadline and disposes listeners/timers on completion, timeout and abort. It removes
  the recurring 200 ms polling loop. Stop/pause/resume are exclusive tool calls; read actions may
  overlap. No energy, latency or whole-app memory speedup is claimed.
- BashTool discarded explicit background timeouts of 30 seconds or less and reported an immediate
  spawn failure with an OK outcome/exit 0. Explicit clamped timeouts now apply; omitted timeouts
  still allow intentional long-running servers. Synchronous startup refusal throws an error.
  Asynchronous spawn errors remain observable through the returned tracked task ID.

## Qualification contract

Applicable journeys are C01 (dirty repository preservation) and the local shell cancellation and
inspection portions of C04/R01. This is not a full live-provider crash/resume or installed-app
journey. All commands use disposable fixtures and redirected test configuration.

Evidence lives in [the sprint directory](evidence/2026-10-06-background-task-sprint/README.md).
It retains baseline failures, focused output, real-process end-state checks, broad regression
results, mutation attempts and source restoration hashes. Final verification:

- Thirteen executable behavioral mutants are caught by assertions, with source SHA-256 equality
  after every restore. No compiler failure or timeout is counted as a mutation kill. The source
  and tool baselines pass before and after (21 tests in each combined baseline).
- Final full Jest: 419 suites / 3,870 tests pass, with one existing skipped suite / 19 existing
  skipped tests. This includes protocol fixtures, Computer Use retirement, sandbox floors,
  task registry, sub-agent coordination and background epistemic evidence regressions.
- Bun: 132 tests pass across the 14 declared runtime-specific suites.
- Root `tsc --noEmit` and `npm run build`, app typecheck and production build pass. Changed-file
  ESLint has zero errors and 19 warnings (the repo's warning tier for `any`/lazy requires).
- A fresh scratch engine bundle answers seven real Electron worker/MessagePort exchanges,
  including heartbeat, boot, correlation and scratch-folder lookup. Its state and credentials
  are redirected; no model call is requested. This verifies the staged engine, not installation.
- All 316 unrelated pre-existing dirty files retain their initial byte identities; eight
  existing dirty files were intentionally extended by this sprint. Deleted paths remain deleted.
  `git diff --check` passes. No unrelated edit is reset or committed.

The first broad run (alongside Bun) times out on five PDF layout-routing tests. The 15-test PDF
suite passes in isolation; the final full run with no competing Bun workload passes unchanged.
Both runs are retained. This does not prove the PDF latency/reliability issue is resolved.
The first lint pass also catches one new prefer-const error; it is fixed before final checks.

**Remaining Target/unmeasured:** installed-app/provider-backed tasks, full crash/restart recovery,
independent positive build/test attestation via task inspection, escaped process groups, supported
device performance/energy comparisons, notarized distribution and competitive comparisons.
Computer Use remains retired. No commit, push, install or model/credential change is made.

Guided by product-reset README; architecture/audit/split 01/05/06 and current 55/64/66 precedence;
gates 08; competitive README/02/04/05/06/07 and C01/R01/R02 contracts; Mac Buddy vision's responsive
execution, safe process lifecycle and verification principles; records 57/68/69/70; inspected
shell task, registry, blackboard, tool factory, taint and outcome-observer code. The mandatory
competitive/03_CAPABILITY_MATRIX.md is absent, as already recorded by gap 46; no facts are inferred
from that missing document. Current Node first-party sources are in the competitive source ledger.
