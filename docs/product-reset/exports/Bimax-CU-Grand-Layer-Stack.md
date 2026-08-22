# Bimax Computer Use — Grand Layer Stack (corrected edition)

Corrected 2026-08-22 after repository reconciliation and primary-source verification.

This former v1 draft is retained as the compact stack view. The binding, fully sourced plan is
`docs/product-reset/21_CU_VERIFIED_GRAND_STACK_AND_IMPLEMENTATION_PLAN.md`.

## Corrections to the original

- Spotify's one-element sample was temporal readiness, not a permanent AX limitation.
- The packaged compatibility freeze was not wired into `server.ts`; Phase 0 now fails closed.
- Bimax already attempts Electron's documented `AXManualAccessibility` once per pid. Do not add a
  second native owner or use an app-name special case.
- P3 requires deterministic postconditions before model rehearsal.
- Reported cache, capture, token and step-count gains are experiment leads, not Bimax targets.
- macOS 27 Foundation Models features are optional; the base product remains macOS-13-capable.

## Corrected stack

1. Product/trust: Mac app ownership, one `mac_control`, admission, takeover, receipts, no production
   compatibility fallback.
2. Observation identity: exact app/pid/window/frame, bounded evidence, stale-handle refusal.
3. Perception: AX first when fresh, menus for commands, OCR/vision for absent content, later fusion.
4. Grounding: ambiguity refusal, text folding, menu index paths, frame-bound pixels.
5. Execution: semantic → physical foreground lease → visual recovery → stop.
6. Verification: new observation and independent postcondition; performed never means proven.
7. Reliability/latency: current packaged-session and conformance diagnosis before caches/batching.
8. Adversarial security: untrusted observation types, trusted plan boundary, branch auditability.
9. Memory: receipt-backed journey hints with per-step revalidation and drift invalidation.
10. Additional sources: Shortcuts/JXA/clipboard/keyboard only behind app-owned `mac_control`.
11. Optional AI/training: capability-detected Foundation Models/FastVLM/MLX experiments after the
    deterministic product passes.

## Delivery order

Phase 0 fail-closed routing → Phase 1 native logical adapter/session reliability → Phase 2
postconditions/safe delivery → Phase 3 perception and measured latency → Phase 4 adversarial
boundary → Phase 5 journey memory → Phase 6 new app-owned sources → Phase 7 optional local AI.

Status after this correction: Phase 0 is Implemented with focused unit tests. Packaged CU is
deliberately blocked until Phase 1, so this is not Measured or Product-ready.
