# Computer Use Phase 1 — native logical adapter and session reliability

Status: **Implemented and locally Measured for the deterministic provider/native protocol boundary,
2026-08-22.** Live packaged-app and fresh-Mac qualification remain Target; this is not
Product-ready.

This record executes Phase 1 from `21_CU_VERIFIED_GRAND_STACK_AND_IMPLEMENTATION_PLAN.md`. Phase 0
proved packaged mode could fail closed. Phase 1 replaces that blocker only when native discovery,
the live bridge handshake, and adapter conformance all pass.

## Result

Packaged registration now has exactly two outcomes:

1. native discovery/cutover fails → one schema-compatible, visible blocked `mac_control`;
2. native discovery/cutover passes → one native-backed logical `mac_control`.

It never publishes `BimaxWorkspaceTool`, `BimaxObserveTool`, `BimaxActionTool`,
`BimaxTransactionTool`, or `BimaxCaptureTool` to the model. Those capability-filtered tools remain
internal adapter dependencies.

## Adapter contract

`native.logical.adapter.ts` retains full native snapshots per logical task session and translates:

| Logical verb | Native operation | Executor |
|---|---|---|
| `status` | adapter/capability state | semantic |
| `apps`, `windows`, `frontmost` | `BimaxWorkspaceTool` inventory | semantic |
| `open` | verified `launch_app` | semantic |
| `observe` | bounded `BimaxObserveTool`; returned `frameId` is the native snapshot id | semantic |
| `click` | snapshot-bound `invoke` | semantic |
| `type` | snapshot-bound `type_text` | semantic |
| `set_value` | snapshot-bound `set_value` | semantic |
| `screenshot` | exact-window `BimaxCaptureTool` using the retained window generation | visual |
| `arrange`, `close` | verified exact-window workspace operations | semantic |
| `wait` | bounded logical settle | semantic |
| every currently unsupported verb or unverified native enum | structured visible refusal | stop |

Selectors never become native authority by themselves. `elementToken`, `elementIndex`, or an
unambiguous query must resolve inside a retained full snapshot. Provider restart intentionally
forgets those snapshots, so a queued or copied token cannot cross the process boundary.

Physical pointer/keyboard verbs currently descend to stop because the capability-filtered native
MCP surface does not yet represent physical delivery as an internal adapter operation. The service
may advertise physical capability, but a handshake flag is not an executable contract. Adding that
internal operation belongs to later Phase 1 hardening or Phase 2 and must preserve the same logical
surface and receipts.

Update, 2026-08-22 (later same day): foreground-leased **keyboard** delivery now flows through the
adapter — an explicit `delivery:'foreground_lease'` request rides a handshake-verified
`foreground_once`/`foreground_persistent` policy and is graded against lease-and-frontmost proof,
while unverified policies stop with `foreground_policy_unverified`. Full contract, fixture journey,
unit negatives, and scope limits are recorded in
`24_CU_PHASE2_DETERMINISTIC_COMPLETION_RECORD.md`. Raw-HID pointer click remains on the stop rung.

## Session reliability correction

`NativeToolCoordinator` now retries a read exactly once when the native service returns
`session_not_found`:

- discard the retired task session and all snapshot authority;
- create a fresh deterministic task session;
- repeat only the read.

Mutations do not use this retry helper. If a service disappears during delivery, the mutation is
not replayed because its effect may be ambiguous. The next action must begin from a fresh read and
fresh native snapshot.

## Deterministic compiled-provider proof

`verify-mac-provider-phase1.mjs` launches the actual compiled arm64 provider over MCP stdio against
a no-input native-protocol fixture. The fixture passes the same discovery and live-handshake path,
implements real session identity, and retires all sessions when its epoch changes.

The verifier requires:

- exact retained `mac_control` schema and no additional tools;
- `status.route === native_logical_adapter`;
- 10 sequential `apps` reads through internal `BimaxWorkspaceTool`;
- a simulated native-service restart followed by transparent read-session recreation;
- a provider process restart followed by a fresh native session;
- structured content on every MCP result.

The local gate is `npm run cu:phase1:check`. It also reruns the Phase 0 native-unavailable probe so
the new adapter cannot weaken fail-closed behavior.

Recorded result on Apple Silicon/macOS 26.5.2:

- typecheck passed;
- 10 focused suites / 98 tests passed;
- Electron Vite production build passed;
- compiled arm64 provider passed the Phase 0 refusal probe;
- compiled arm64 provider passed the Phase 1 one-tool/10-read/service-restart/provider-restart probe.

Mutation proof: replacing the adapter registration with the old
`native_logical_adapter_pending` blocker caused the compiled Phase 1 verifier to fail at status;
the provider no longer reported `route:native_logical_adapter`. The adapter was restored and the
gate passed again.

Machine-readable evidence: `evidence/cu-phase1-local-2026-08-22.json`.

## Acceptance-gate verdict

The local Phase 1 exit is met for a deterministic provider/native protocol boundary:

- packaged `tools/list` contains exactly the allowed logical surface;
- compatibility and low-level native tools are absent;
- 10 sequential calls and both restart boundaries pass;
- deleting adapter registration fails the compiled gate;
- native unavailability still produces the Phase 0 visible blocker.

Not established:

- live TCC-backed observation/action through a newly rebuilt packaged Bimax.app;
- physical delivery through the logical adapter;
- semantic/physical/visual/stop end-state journeys after this routing change;
- x64, clean-Mac, signing/notarization, update or permission-persistence rows;
- Product-ready status or a competitive Win.

The locally installed service's standalone handshake reported Accessibility and Screen Recording
denied when invoked outside the app-owned route. That is consistent with the responsible-app
boundary and is not counted as a live Phase 1 pass. Live-app qualification remains a separate
matrix, exactly as the Phase 1 plan requires.

## Governing documents

`README.md`, `05_TARGET_ARCHITECTURE.md`, `07_MIGRATION_ROADMAP.md`, `08_ACCEPTANCE_GATES.md`, the
Mac Buddy vision, `competitive/README.md`, `competitive/05_GAP_REGISTER.md`,
`competitive/06_HEAD_TO_HEAD_EVALS.md`, and `competitive/08_SOURCE_LEDGER.md`.
