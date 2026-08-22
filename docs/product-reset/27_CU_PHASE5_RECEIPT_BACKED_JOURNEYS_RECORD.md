# Computer Use Phase 5 — receipt-backed journeys

Status: **privacy and replay-safety core Implemented and deterministically Measured, 2026-08-23.**
Production recording/retrieval UI, adapter activation, live repeated-app speedup, trajectory export
UX, and packaged-app qualification remain Target. This is not Product-ready workflow memory.

## Result

`app/src/capabilities/mac/journey.memory.ts` adds a versioned, bounded journey store whose root is
supplied only to the app-owned Mac provider from the `Desktop` subdirectory of Electron's private
`userData` directory. The
generic engine receives neither that directory nor a Computer Use storage API.

The persisted form contains app bundle id/version, normalized-intent digest, action names,
window/semantic/postcondition digests, and action-receipt digests. It deliberately rejects or omits
coordinates, element tokens, visible labels, screenshots, normalized instructions, typed text, and
field values. The store is capped at 64 journeys, 32 steps per journey and 512 KiB, prunes by an
explicit retention policy, uses a private directory/file mode and an atomic replacement, and will
not export unless export is independently enabled.

Replay treats a record as guidance rather than authority. Immediately before every step it requires
a new observation and checks permission, takeover generation, app version, exact target-window
fingerprint, semantic fingerprint, unique frame id and non-regressing revision. The injected
executor is explicitly the ordinary `mac_control` ladder; its result must prove the action, source
frame and a later event revision. Any mismatch stops the remaining journey.

## Local gate and mutation cases

`npm run cu:phase5:check` inherits the complete Phase 0–4 gate, then runs the journey and Desktop
provider-environment suites. Focused deterministic coverage proves:

- no raw instruction, label, value, token, or coordinate reaches the stored/exported JSON;
- lookup binds app version plus normalized-intent digest;
- observe and ordinary-ladder execution alternate for every step;
- poisoned semantic fingerprints, changed windows, app-version drift and revoked permission stop
  before effect;
- takeover between steps stops before the next effect;
- export is refused without an explicit export policy.

## Acceptance-gate verdict

Now Implemented/locally Measured: bounded private record format, Desktop-only data-root handoff,
retention/export enforcement and the fail-closed replay coordinator.

Still Target: wiring verified adapter receipts into recording, model-visible retrieval/replay,
user-facing retention/export controls, a live repeated journey demonstrating improvement, native
app-version/window fingerprints, packaged bundle execution, mutation against live takeover/TCC,
and clean-Mac evidence. Until those exist, Bimax must not claim that journey replay is available to
users.

## Independent verification and hardening (2026-08-23, second reviewer)

The replay takeover guard was proven load-bearing by mutation: disabling the epoch-change refusal
let replay continue after user takeover; the focused suite killed it immediately, and restoring
returned green with byte-identical source. The privacy contract was re-read line-by-line —
coordinates, tokens, labels, values, screenshots and normalized instructions are absent from both
the stored and exported shapes, and export without an explicit policy rejects with
`journey_export_not_export_authorized` semantics as tested (`journey_export_not_authorized`).

Governing documents: `README.md`, `05_TARGET_ARCHITECTURE.md`, `07_MIGRATION_ROADMAP.md`,
`08_ACCEPTANCE_GATES.md`, the Mac Buddy vision, the grand-stack plan, Phase 0–4 records, competitive
gap/eval/source records, and Apple platform evidence in `competitive/08_SOURCE_LEDGER.md`.
