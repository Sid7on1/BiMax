# Main-window Bimax Thread IPC isolation — 2026-10-04

Status: **Implemented and locally verified**, subsequently packaged and installed with the
[Computer Use retirement](../2026-10-04-cu-retirement/README.md). Installed ASAR byte matching confirms the
current main/preload/renderer build is running. Installed-app race/crash journey qualification remains
**Target/unmeasured**; no Product-ready or competitive Win claim.

## Inspected defect and correction

`ThreadManager.start()` resumes an engine session when a saved Thread's engine has gone away. The engine emits
`session_restore` with the newest **400 entries**, including tool entries. Main's Thread message callback sends
`engine:msg` with the owning Thread ID, but preload discarded that ID. The renderer could therefore consume an
already-queued restore after selecting another Thread and replace its transcript. This scheduling variant is
source-grounded and reproduced with controlled IPC ordering, not an observed installed-app race.

Preload now forwards the ID. `useEngine` reads the store's current owner synchronously before consuming any
message, including config, catalogue and completion replies. It retains ownership on reducer actions and rejects
foreign lifecycle events before flushing text. Main tags its supervisor lifecycle and diagnostic broadcasts.
Thread adoption uses the selection envelope's ID and retires queued text. Attachment responses bind to the
requesting Thread. The composer's separate clear/restore listener also rejects a different owner.

The reducer checks an explicitly scoped action against its state before any reduction, including
`session_restore`. Manager-internal actions omit the envelope because the manager has already selected the record.
An explicit `threadId: undefined` is rejected when a Thread is displayed; unscoped legacy renderer traffic remains
usable before Thread adoption. Restore payload IDs are engine session IDs (including `/branch` IDs), so comparing
them directly with Thread IDs would break legitimate restores. Same-Thread restores still replace history rather
than append duplicate tools.

## End-state proof

`app/src/__tests__/engine.thread.isolation.test.ts` runs the **actual preload and renderer subscriptions** with a
mock IPC emitter and controlled hook scheduling. React is not re-rendered after selection, deliberately testing
messages arriving before the next render. The composer test runs its actual engine subscriber, without unrelated
DOM or voice effects. These are contract tests, not a native-window journey.

The tests assert exact state identity after foreign restore/tool/text/request/ready/clear/review/lifecycle events;
the local user message stays present. Buffered A text followed immediately by B text yields exactly B text.
Matching restores yield exactly three fixture entries, including the saved tool, even when replayed twice. Foreign
request IDs cannot resolve config, catalogue, completion or attachment responses. Foreign restore/clear events
cannot clear the composer's draft. Matching responses and legacy pre-adoption restore are positive controls.

`run-mutants.py` temporarily breaks one guard at a time, runs that suite, restores the original bytes in `finally`,
and records source hashes and return codes in `mutants.json`. Seven behavioural mutants are rejected: dropped
message ID, missing renderer guard, missing reducer guard, retained old stream buffer, missing attachment guard,
dropped lifecycle ID and missing composer guard. Each log records assertion failures, not a compilation failure.
Never run this mutation harness alongside another editor changing those files.

Verification logs in this folder:

- `baseline.log` and the seven mutant logs: nine contract tests; every planted fault rejected.
- `regressions.log`: 14 focused suites / 100 checks covering IPC isolation, reducer/store/coalescing, Thread
  lifecycle/recovery/reaping, approvals, talk transcript, capability replay, module boundaries and protocol fixtures.
- `desktop-typecheck.log`, `engine-typecheck.log`: TypeScript checks.
- `desktop-build.log`: production main/preload/renderer build. No installed bundle was replaced.

No engine protocol payload, engine ownership, model/config setting or Computer Use capability changed.

## Gates, guidance and remaining work

Guided by product-reset `README.md`, `03_PRODUCT_EXAMPLES.md`, `04_FRONTEND_PLAN.md`,
`05_TARGET_ARCHITECTURE.md`, `vision/BIMAX_MAC_BUDDY_PRODUCT_VISION.md`, `08_ACCEPTANCE_GATES.md`,
`competitive/README.md`, `competitive/06_HEAD_TO_HEAD_EVALS.md` and
`competitive/examples/R01_CRASH_AND_PROVIDER_RECOVERY.md` (C04 recovery boundary). The gap register records this
slice. Evidence comes from inspected local code; no new external/platform fact requires a source-ledger entry.

The unit/contract mutation gate, focused offline regression/protocol checks, typechecks and production build pass.
The full repository test/lint suite, installed rapid-switch race, actual idle reaper/relaunch/crash journey,
live-provider recovery and clean-Mac release gates were not run. C04/R01 remains open beyond this contract slice.

Deliberately outside this fix: fresh launch selecting the last Thread, project reopening its existing Thread,
same-Thread history becoming visible on resume, and main rejecting an input stamped with an old Thread ID after
a switch. These are separate lifecycle/product-policy changes. The owner's proposed preload/filter fix prevents
cross-Thread contamination; it does not make all resume-related UI symptoms disappear.
