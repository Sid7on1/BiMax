# Computer Use Phase 0 — truthful release routing

Status: **Implemented and locally Measured for the routing invariant, 2026-08-22.** Packaged
Computer Use remains deliberately blocked and is not Product-ready.

This is the execution record for Phase 0 of
`21_CU_VERIFIED_GRAND_STACK_AND_IMPLEMENTATION_PLAN.md`. It is narrower than Phase 0 in the older
repository migration roadmap: this record addresses the newly found model-facing provider-routing
gap only.

## Objective

A packaged Bimax provider must never:

- register the compatibility runtime as a production fallback;
- publish low-level native acting tools beside the task's one allowed `mac_control` authority; or
- hide native-route unavailability behind an empty tool list or a narration-only failure.

Until Phase 1 supplies a native logical adapter, packaged mode must list exactly one
schema-compatible `mac_control` and return a structured, visible refusal. Development may retain
the compatibility/native lab surfaces for qualification.

## Delivery plan and state

| Slice | Result | State |
|---|---|---|
| 0A. Reconcile source and claims | Found that `production.routing.ts` had policy tests but no provider-registration caller; the compiled provider still always added compatibility `mac_control` | Completed |
| 0B. Bind release identity to registration | Electron child-environment construction stamps `packaged` or `development` inside the provider descriptor; the generic engine does not receive the product flag | Completed |
| 0C. Fail closed behind one logical schema | `buildMacCapabilityTools` returns only blocked `mac_control` in packaged mode; missing native tools use `native_tools_unavailable`, and an available low-level native surface uses `native_logical_adapter_pending` | Completed |
| 0D. Pin both branch outcomes | Unit tests cover development compatibility, packaged native-unavailable refusal, packaged native-present refusal, and absence of low-level tool publication | Completed |
| 0E. Prove the compiled stdio boundary | The real architecture-specific provider is probed twice: development structured status and packaged structured mutation refusal | Completed |
| 0F. Make the proof repeatable | `npm run cu:phase0:check` owns the focused tests, typecheck, production renderer/main build, provider compilation and stdio probes | Completed |

## Landed surface

- `app/src/capabilities/mac/server.ts`
  - uses `decideDesktopProductionRouting` at provider registration;
  - exports `buildMacCapabilityTools` for deterministic branch injection;
  - preserves `MAC_CONTROL_SCHEMA` in the visible blocker;
  - never publishes low-level native tools in packaged mode before the logical adapter exists.
- `app/src/main/runtime.paths.ts`
  - already derived provider mode from Electron's package identity while stripping the flag from
    the generic engine environment;
  - is now covered by an explicit hostile-parent-environment regression assertion.
- `app/scripts/verify-mac-provider.mjs`
  - checks the retained schema over MCP stdio in both development and packaged modes;
  - calls a mutating packaged action and requires `ok:false`, `blocked:true`, `visible:true`, and
    `code:native_tools_unavailable`.
- `scripts/cu-phase0-local-gate.sh` and the root `cu:phase0:check` script
  - make this boundary a one-command local gate.

## Verification

`npm run cu:phase0:check` passed locally on Apple Silicon/macOS 26.5.2:

- Desktop TypeScript typecheck passed;
- seven focused suites passed with 74 tests;
- Electron Vite production build passed;
- an arm64 Mach-O provider compiled from `provider.entry.ts`;
- development stdio probe listed only `mac_control` and returned structured status;
- packaged stdio probe listed only `mac_control` and returned the structured
  `native_tools_unavailable` refusal for `click`;
- the generic engine/provider environment test rejected a hostile inherited release-mode value and
  derived the provider's mode from the injected Electron package identity.

Mutation proof: changing the provider registration branch from `if (packaged)` to an unreachable
condition made the compiled packaged probe fail because its actual tool list was empty instead of
the required visible `mac_control`. The source was restored, its SHA-256 returned to
`dbc9b0775c4219c505bfe34da05ecf13a2768e1f208bddad91c64bbed8aa19b2`, and the compiled probe passed
again. The retained machine-readable record is `evidence/cu-phase0-local-2026-08-22.json`.

## Acceptance-gate verdict

The local Phase 0 exit is met: with packaged identity supplied, the compiled provider cannot act
through compatibility, cannot widen authority by listing low-level native tools, and cannot conceal
the missing native route.

This result does **not** establish any of the following:

- a working packaged native `mac_control`;
- a packaged-app semantic/physical/visual action journey after this routing change;
- ten-call or restart reliability across the provider/native-service boundary;
- fresh-Mac TCC behavior, x64 qualification, signing, notarization or update persistence;
- Product-ready status or a competitive Win.

Follow-up, 2026-08-22: Phase 1 replaced the visible blocker when native cutover passes and retained
the blocker when it does not. The deterministic compiled-provider result is recorded in
`23_CU_PHASE1_NATIVE_LOGICAL_ADAPTER_RECORD.md`; live packaged-app/release rows remain Target.

## Source-of-truth inputs

The implementation was governed by `README.md`, `05_TARGET_ARCHITECTURE.md`,
`07_MIGRATION_ROADMAP.md`, `08_ACCEPTANCE_GATES.md`, the Mac Buddy vision,
`competitive/README.md`, `competitive/05_GAP_REGISTER.md`,
`competitive/06_HEAD_TO_HEAD_EVALS.md`, and the verified external-source ledger in
`competitive/08_SOURCE_LEDGER.md`.
