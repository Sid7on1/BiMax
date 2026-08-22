# Bimax CU — Grand Implementation Tour (corrected)

Corrected 2026-08-22. This is the execution view of
`docs/product-reset/21_CU_VERIFIED_GRAND_STACK_AND_IMPLEMENTATION_PLAN.md`.

## Phase 0 — release truth (started)

- Wire provider registration to `production.routing.ts`.
- Keep compatibility only in development.
- In packaged mode publish one structured blocked `mac_control`; never publish compatibility or
  low-level acting tools until the logical adapter exists.
- Tests: delete the packaged branch or publish `BimaxActionTool` and the focused suite must fail.
- State: Implemented; 11 focused tests passed. Packaged CU is intentionally unavailable.

## Phase 1 — native logical adapter and session reliability

- Add a versioned adapter mapping logical `mac_control` verbs to native observe/action/capture/
  workspace operations without widening the engine tool allow-list.
- Reproduce P0 through the compiled stdio provider before changing ownership: 10 sequential calls,
  native-service restart, provider restart.
- Split deterministic package conformance from the live-app/TCC matrix; repair P6 flakiness.
- Unblock packaged registration only when adapter + native cutover + restart tests pass.

## Phase 2 — completion and safety

- Require or deterministically derive typed postconditions for every mutation.
- Apply sensitive/destructive floors to every executor and later programmatic source.
- Reobserve and independently verify; narration/tool acceptance is never completion.
- Preserve foreground/background truth and physical-input foreground leases.

## Phase 3 — perception and latency

- Keep the existing once-per-pid Electron AX request; record raw status and before/after tree quality.
- Treat readiness as observation-specific, never app-specific.
- Add revision caching only after notification-loss and poisoned-cache mutants.
- Benchmark cold start, warm observe, capture and verification separately; canary one optimization.

## Phase 4 — adversarial observation boundary

- Make AX/OCR/page text typed untrusted data.
- Bind trusted task/allowed branch graph before consuming it.
- Add VPI/WASP-inspired fixtures plus benign bidi/localization controls.
- Refuse any action whose authority/destination/tool widening originates only in screen text.

## Phase 5 — journeys and trajectories

- Store only receipt-backed journeys in Desktop application data.
- Replay as hints through the normal ladder, reobserving every step.
- Invalidate on app version, window, permission, frame or semantic drift.
- Add explicit retention/redaction/export controls before trajectory export.

## Phase 6 — additional app-owned sources

- Evaluate Shortcuts, JXA/application dictionaries, keyboard grammar and clipboard transactions.
- Route all through `mac_control`, broker limits, takeover, approval and fresh postconditions.
- Do not expose Terminal/engine shell or file mutation during Control Mac turns.

## Phase 7 — optional AI and training

- Capability-detect Foundation Models; base product must work without it.
- Compare deterministic baseline vs Foundation Models/FastVLM/MLX on quality, latency, memory,
  energy proxy, artifact size and failure behavior.
- Rehearsal is an extra stop signal, never action authority.
- Fine-tuning waits for consent, redaction, licensing and a sufficiently large receipted corpus.

## Definition of done for every phase

The real product path passes; the corresponding mutant fails; receipts and authority remain intact;
raw failures are retained; docs/gap/source ledger update in the same change; claims stay at their
earned level; and `08_ACCEPTANCE_GATES.md` is checked before completion.
