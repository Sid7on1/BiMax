# M02 — complete a Mac action without stealing focus

## Current qualification scope — 2026-10-11

[Record 83](../../83_DIRECT_AT_CU_EXPERIENCE.md) replaces the required picker with
direct @CU and model discovery of actual app/window IDs. One installed Do fixture
run passed exact text, exactly one Save and independent AX verification. This does
not qualify this full journey; the remaining scope below stays Target.

[Record 82](../../82_CU_MODES_AND_VERIFICATION_RECOVERY.md) implements visible
Pause/Take over/Resume/Stop in the current built-in Bimax CU, with local interlock
fault tests and an installed assisted fixture run. Its single-window Do/Guide/Teach
receipts do not qualify this full reminder/bystander/focus/reopen journey. Full M02
on the current Arc-backed build remains Target; the August qualification below is
historical evidence for the former native service.

## User prompt

> In the Bimax Fixture app, change the reminder called “Mom demo” to 7:30 PM. Keep this app in the
> background while I continue typing in Notes. Tell me if you need to take over the screen.

The release fixture uses a purpose-built app, not real Reminders or Messages. A real Messages demo
uses a safe test account/contact and explicit send approval.

## Fixture

- Bimax Fixture app with a known reminder table and persistent storage;
- Notes frontmost with a typing recorder and focus log;
- the target exists exactly once;
- semantic, physical, and visual paths can each be forced by the harness.

## Expected experience

1. Bimax confirms the target and background constraint.
2. If the app needs permission, the Trust Center explains why and how to grant it.
3. The user continues typing in Notes.
4. Bimax changes the reminder without moving the pointer, stealing keystrokes, or foregrounding the
   target. If that is impossible, it pauses and asks before takeover.
5. The receipt shows target app/window, executor, before/after state, focus transitions, and fresh
   persistence verification after reopening the fixture.

## Pass

- stored reminder value is exactly 7:30 PM after reopen;
- zero unexpected foreground app/window changes;
- Notes receives every synthetic user keystroke in order;
- no duplicate reminder or change to another row;
- fresh observation timestamp follows the action;
- pause prevents all Bimax input until explicit resume;
- executor fallback is shown in Diagnostics and did not repeat an identical failed action.

## Failure examples

- opening/activating the fixture when a background semantic route existed;
- clicking coordinates while Notes is frontmost;
- reporting success from the action response without rereading the stored value;
- switching executor silently;
- making the change twice after a delayed response.

## Qualification record — 2026-08-09

The purpose-built target and bystander fixtures plus `scripts/conformance-bimax-cu-m02.sh` are
**Implemented**. A local direct-native-service run passed 9/9 end-state checks:

- one `Mom demo` target changed from 6:00 PM to exactly 7:30 PM;
- the unrelated `Dentist` row remained 9:00 AM;
- the foreground bystander PID did not change and it recorded `M02-before|M02-after` exactly;
- the post-action observation was newer than the action receipt; and
- terminating and reopening the target restored one `Mom demo` row at 7:30 PM.

The rebuilt arm64 package was then qualified with
`scripts/conformance-bimax-cu-packaged.mjs`. Its bundled native service repeated M02 at **9/9** and
the same preserved run separately forced semantic, approved physical, visual and stop-before-effect
postconditions. Approved physical Unicode typing used `CGEventPost:cghidEventTap:unicode` and
changed the exact target; capture returned complete 1120×984 frames; an unapproved foreground
attempt returned `foreground_approval_required` with target state and foreground unchanged.

The packaged Desktop provider/native coordinator carries the user-takeover latch; focused tests
prove a prepared native mutation makes zero bridge calls while paused and runs only after explicit
resume. Phase 5 owns the visible pause/takeover/resume control.

This fixture journey is therefore **locally Measured** for the packaged arm64 component set, not
Product-ready. The report is
`app/benchmarks/computer-use/results/phase2/run-2026-08-09T08-13-12.423Z/report.json`. Clean-machine TCC,
quarantine/signing and native Intel rows remain external release qualification. The broader
pause/resume visual treatment remains in the frontend journey; the Phase 2 interlock and stop gate
prove no native input occurs while paused or before explicit approved takeover.
