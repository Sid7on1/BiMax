# Phase 4 Desktop capability extraction record

Status: **Implemented and locally Measured; Phase 4 local exit complete**, 2026-08-09.

Scope: roadmap Phase 4, Mac app ownership gates in `05_TARGET_ARCHITECTURE.md` and
`08_ACCEPTANCE_GATES.md`, and the bounded MCP-service seam in research card **V29B**. This record
does not upgrade the complete V29B ecosystem or the adaptive chipset/network vision from Target.

## Research performed before the extraction

The implementation was checked against current first-party MCP material rather than an old local
assumption:

- the 2026-07-28 MCP tools specification: a provider declares tools, accepts `tools/list` and
  `tools/call`, uses JSON Schema for input, may return structured content, and can notify clients
  when its list changes;
- the MCP architecture document: a local stdio server is a separate process and the client owns
  the connection lifecycle;
- the TypeScript SDK client documentation: clients discover tools dynamically instead of binding
  engine code to provider-specific implementations.

These findings produced a deliberately narrow design: Electron main supplies one local provider
descriptor, the generic engine lists/calls it through the existing MCP manager, and the Desktop
provider owns macOS policy and execution. Tool results retain text for compatibility and structured
content for typed consumers. Tool order is stable and paginated client discovery is tested.

## Landed boundary

```text
Electron main
  -> BIMAX_HOST_CAPABILITIES_JSON (local stdio descriptor only)
  -> generic Bimax engine MCP client
  -> bimax-mac-capability (Desktop-owned provider)
  -> existing semantic / physical / visual / stop runtime
  -> bundled bridge and XPC service
```

- `src/computer/`, ComputerTool, Terminal CU commands/config/posture, native CU registrations and
  CU scripts/benchmarks no longer exist under Terminal ownership.
- The engine knows only a generic host-capability JSON contract and dynamic tool events. It does
  not receive a Desktop host profile or macOS machine profile.
- The provider exposes `mac_control` plus eligible native specialist tools, reusing the existing
  runtime router and mapping its recorded mechanism onto the four product ladder names. No second
  routing brain was added.
- Electron main is the authority root. The inner Desktop governor requires both Electron-main
  authority and the engine-governor consent channel, and applies a sensitive-target hard floor.
- Packaged component resolution, Trust diagnostics and conformance use the same resolver paths as
  launch. Package overrides are refused and reported; missing bundled components fail closed.
- Four unreferenced Terminal-compatibility modules and their broken imports were removed. All nine
  previously ignored migrated suites were replaced by current Desktop boundary contracts; no Mac
  capability test path is ignored.

## Chipset, capacity and network truth

This slice “hugs” the actual host only where Phase 4 has evidence:

- Electron declares `arm64` or `x64`; the provider refuses an absent/mismatched architecture.
- release preparation compiles provider artifacts for the selected Darwin architecture and stages
  matching Swift executables; the local arm64 provider and native binaries were inspected as
  Mach-O arm64.
- the native `bimax.cu.v1` handshake advertises bounded capacity (2,000 AX elements, four concurrent
  read sessions, two capture streams), and callers clamp work to those limits.
- provider transport is local stdio. No socket listener, remote MCP URL, or network credential is
  passed into the provider contract. Outward actions such as opening a URL remain action-policy
  inputs, not a hidden provider network plane.

The retained Phase 2 machine/network sample is
`app/benchmarks/computer-use/results/phase2/run-2026-08-09T08-13-12.423Z/report.json`. It records an
Apple M3/arm64 host, memory/CPU facts, available network interfaces and native service capacity.
It deliberately records path status, expensive/constrained state and endpoint RTT as `unknown`.
Therefore adaptive batching, connection reuse, thermal/memory pressure policy and network-quality
routing remain **Target** under V01/V02/V03/V29B. A broad “chipset-native application” claim remains
forbidden until the device/workload/network matrix in the research plan shows a named measured win.

## Retained samples and examples

- `app/benchmarks/computer-use/contracts/mac-provider-tools.sample.json` — deterministic minimum
  `tools/list` schema with native discovery disabled.
- `app/scripts/verify-mac-provider.mjs` — real stdio client that compares the live provider to the
  sample and requires structured `mac_control status` output.
- `app/benchmarks/computer-use/results/phase2/` — raw packaged-component and machine/network
  reports, including the qualified Phase 2 run above.
- `app/src/capabilities/mac/__tests__/` — the migrated runtime, policy, resolver, ladder, native,
  prompt and provider contract corpus.

## Verification

The final one-run gate is `npm run phase4:check`. It verifies the Terminal source boundary, builds
and runs the complete Terminal suite, checks the generated protocol mirror, typechecks/builds the
app, runs every Desktop capability suite, runs the TUI suite, executes the native Swift harness,
compiles the architecture-specific provider and probes it over stdio against the retained sample.

Recorded local results:

- Desktop capability tests: **52/52 suites, 590/590 tests**, zero ignored suites;
- native executable harness: **60/60 checks**;
- provider probe: `mac_control` discovered over stdio with structured status;
- Terminal and TUI suites: green in the final Phase 4 gate;
- architecture: local provider, bridge, helper and XPC executable inspected as arm64.
- rebuilt `app/release/mac-arm64/Bimax.app`: structural verifier passed for the arm64 app, pinned
  engine, provider, XPC service, bridge, helper, generic descriptor injection and bundle-only
  fail-closed resolution;
- packaged conformance: all 11 assertions passed against that rebuilt app—structure, bundle-only
  component, protocol, host architecture, capacity, provider-owned takeover latch, semantic,
  physical, visual, stop-before-effect and M02 9/9. Raw report:
  `app/benchmarks/computer-use/results/phase2/run-2026-08-09T11-40-39.888Z/report.json`.

DMG creation could not run in the managed environment because `hdiutil` returned
`Device not configured`; signing/notarization/DMG remain Phase 7 release rows.

Mutation-sensitive coverage includes the source-boundary scan, provider architecture mismatch,
missing Electron authority/consent, sensitive target, packaged override, schema drift and missing
structured output. This is local development evidence, not fresh-Mac distribution evidence.

### 2026-08-18 reconstruction re-verification

The reconstructed native service was re-qualified after closing the remaining 33 failures in the
60-check executable harness. The fixes cover bounded snapshot/image/capture retention, exact
window postconditions and identity, focus-lease honesty, semantic postcondition comparison,
file/URL policy, bounded image analysis, and stable OCR backing storage. The current local results
are:

- native executable harness: **60/60 checks**, with a clean rebuild after the final changes;
- Desktop macOS capability suites: **85/85 suites, 1,018/1,018 tests**;
- Desktop TypeScript gate: `npm run typecheck` passed;
- arm64 desktop package structure/signature verification passed for the rebuilt local app;
- packaged conformance: **11/11 assertions**, including 15 live-verified semantic actions,
  `physical_cgevent` Unicode typing with independent effect read-back, visual capture,
  stop-before-effect, and M02 **9/9** through background `ax_attribute` delivery. Raw report:
  `app/benchmarks/computer-use/results/phase2/run-2026-08-17T19-11-15.905Z/report.json` (UTC
  timestamp; run completed 2026-08-18 in the local timezone).

The rebuilt local app is ad-hoc signed. On 2026-08-18, macOS Settings visibly showed Bimax enabled
for Accessibility and Screen & System Audio Recording; the rebuilt app's fresh helper reported both
`true`, its native-service handshake reported both `granted`, and the packaged Trust Center rendered
host **2/2** plus both service permissions **Allowed**. The renderer now carries the helper-versus-
fallback provenance, shows a checking state before the first answer, and offers restart only when
the helper is actually unavailable. Exact service-hash approval remains pending for each new local
build and was not silently granted during this read-only verification. Fresh-Mac signing,
notarization, deny/grant/revoke/regrant and update persistence therefore remain **Target**, unchanged
from Phase 7.

## Phase status and remaining Targets

- **Phase 1:** local implementation complete. Native x64 archive inventory and clean-Mac TCC remain
  release qualification, not Phase 1 code work.
- **Phase 2:** local implementation and rebuilt packaged-app conformance complete. The historical
  `/computer` Terminal control no longer owns the latch; the provider/native coordinator does.
  Phase 5 must expose the user-facing pause/takeover/resume control. Fresh-Mac signing/TCC remains
  Phase 7 qualification.
- **Phase 3:** local implementation and source-free Desktop build exit complete; external artifact
  tag/publication remains a release event.
- **Phase 4:** local exit complete. No CU coordination, policy, tests or benchmarks remain owned by
  Terminal.
- **Phase 5 Target:** Live Target/PiP UI, action timeline, and user pause/takeover/resume controls.
- **Phase 7 Target:** quarantined clean-Mac, Intel where shipped, signing/notarization and update
  persistence.
- **Phases 8–9 Target:** capability ecosystem and measured adaptive chipset/network behavior.
