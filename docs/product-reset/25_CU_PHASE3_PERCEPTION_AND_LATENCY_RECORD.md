# Computer Use Phase 3 — perception readiness and measured latency

Status: **deterministic packaged-provider core Implemented and locally Measured, 2026-08-22.**
Live packaged-app/TCC measurements, broad app readiness, notification-loss reproduction, and any
cache or frame-diff optimization remain Target. This is not Product-ready latency evidence.

This record extends the user-modified Phase 0–2 baseline without changing its one-tool release
route, typed postconditions, fresh-frame invalidation, background invariant, or explicit
`foreground_lease` delivery.

## Result

The native logical adapter now treats perception as temporal evidence:

- readiness is classified for each `pid:windowId:windowGeneration` observation as `warming`,
  `background_restricted`, `ready`, or `visual_only_stable`; a new window generation inherits no
  app-wide verdict;
- only a complete, event-tracked, revisioned, exact-window full snapshot can become action
  authority;
- diff, query-filtered, truncated, partial, mid-capture, unrevisioned, or non-event-tracked
  snapshots stop before action delivery;
- semantic action from a retained `warming`, `background_restricted`, or `visual_only_stable`
  snapshot stops with `native_perception_not_ready`;
- AX authority caching is explicitly `disabled_pending_mutation_proof`. No optimization was adopted,
  so Phase 2 stale-frame rules did not change.

The existing one-attempt-per-pid `AXManualAccessibility`/`AXEnhancedUserInterface` helper remains
unchanged and still emits the raw AX error codes. Phase 3 does not infer success from that request;
the subsequent observation quality is the authority input.

## Frozen local latency result

`npm run cu:phase3:check` compiled the arm64 stdio provider and ran the Phase 0, 1, and 2 verifiers
before the new Phase 3 probe. On `deterministic-native-provider-fixture-v1`, 10/10 observations had
unique snapshot ids and remained full-snapshot authority.

| Bucket | Frozen budget | Measured p95/result |
|---|---:|---:|
| cold provider connection | 2,000 ms | 109.726 ms |
| warm observe | 250 ms | 0.874 ms p95 |
| exact-window capture | 250 ms | 0.329 ms p95 |
| delivery + fresh verification | 500 ms | 0.815 ms p95 |

These are same-process deterministic protocol-fixture timings, not Electron launch, real AX tree,
ScreenCaptureKit, TCC, model, or human-visible end-to-end timings.

## Mutation/end-state proof

The focused suite kills poisoned diff, filtered, truncated, partial, changed-during-capture,
event-tracking-loss, and missing-revision inputs. It also proves sparse→ready recovery on the same
exact window and a reset on generation change. The compiled verifier rejects any snapshot reuse and
requires Phase 2 fresh verification after every mutation.

Machine-readable contracts/evidence:

- `app/benchmarks/computer-use/contracts/cu-phase3-latency-budget.json`
- `evidence/cu-phase3-local-2026-08-22.json`

Independent re-execution (2026-08-22, later same day): the full gate was re-run by a second
reviewer and every budget held (cold connect 126.7 ms, warm observe p95 0.834 ms, capture p95
0.324 ms, delivery+verification p95 0.880 ms against the frozen budgets above).

## Acceptance-gate verdict

Now Implemented and locally Measured: exact-window temporal readiness, full-snapshot authority,
poisoned-cache refusal while cache remains off, separate timing buckets, and the complete Phase
0→3 deterministic compiled chain.

Still Target: live before/after Electron tree-quality samples, notification-loss mutation against a
real observer, any revision-aware cache/diff/batch/prefetch adoption, frozen multi-app corpus, x64
execution beyond the existing parity probe, and clean-Mac packaged qualification.

Governing documents: `README.md`, `05_TARGET_ARCHITECTURE.md`, `07_MIGRATION_ROADMAP.md`,
`08_ACCEPTANCE_GATES.md`, the Mac Buddy vision, the grand-stack plan, competitive gap/eval/source
records, and the user-modified Phase 0–2 records.
