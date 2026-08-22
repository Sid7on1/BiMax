# Computer Use Phase 6 — additional app-owned execution sources

Status: **bounded broker contract Implemented and deterministically Measured, 2026-08-23.** Live
Shortcuts, JXA/application-dictionary, keyboard-navigation and clipboard workers are Target. No new
source is advertised to the model, so this is not Product-ready programmatic Computer Use.

## Result

`app/src/capabilities/mac/app.execution.sources.ts` defines one Desktop-owned broker contract for
four candidate sources: Shortcuts, JXA/application dictionaries, keyboard navigation and clipboard
transactions. It is not a shell adapter and it creates no Terminal or generic-engine capability.

Each operation must be pre-registered in a fixed manifest with source, worker digest, provenance,
deadline, privacy behavior, reversibility and an allow-list of bounded parameter keys. Raw scripts,
JavaScript source, commands, executables, paths and working directories are rejected before the
worker. A call from the logical Mac adapter then requires, in order:

1. authenticated-task admission;
2. trusted-plan authorization of the fixed operation;
3. a fresh exact-target observation and current permission;
4. user/governor approval;
5. execution by a matching isolated app-owned worker under a maximum 10-second deadline;
6. a second observation with unchanged takeover generation/target and a later frame/revision;
7. an independent typed-postcondition verifier.

Failure is never reported as success. A reversible source attempts its registered rollback after
an independently unverified effect only while permission, takeover epoch and target continuity are
still intact, and the rollback itself needs fresh independent proof. If the user took over,
permission disappeared or the target drifted, the broker stops without issuing a compensating
mutation that could fight the user's hands. An irreversible source returns an explicit attempted-
but-unverified refusal.

## Local gate

`npm run cu:phase6:check` inherits Phase 0–5 and exercises deterministic workers for all four source
types. The gate proves fixed provenance/timeout/privacy receipts, plan/approval/permission
stop-before-effect, raw-code rejection, isolated-worker admission, independent false-success
rejection, no rollback after an intervening takeover, and independently verified clipboard rollback
after an ordinary postcondition failure.

## Acceptance-gate verdict

Now Implemented/locally Measured: the source-neutral app broker and its refusal/receipt contract.

Still Target: production worker manifests and signed artifacts, native Shortcuts input-wait
handling, dictionary-derived JXA operations, native keyboard focus grammar, pasteboard change-count
and restoration proof, `mac_control` activation, real-app postconditions, privacy review, packaged
journeys and clean-Mac qualification. Compatibility AppleScript remains frozen; this phase does not
reactivate it.

Governing documents: `README.md`, `05_TARGET_ARCHITECTURE.md`, `07_MIGRATION_ROADMAP.md`,
`08_ACCEPTANCE_GATES.md`, the Mac Buddy vision, the grand-stack plan, Phase 0–5 records, competitive
strategy/gap/eval/source records, and Apple's Shortcuts/App Intents documentation.
