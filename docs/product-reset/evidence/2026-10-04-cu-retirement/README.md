# Computer Use retirement and local app replacement — 2026-10-04

Scope: explicit owner withdrawal of Computer Use and installation of the current fixes. Record
[66](../../66_COMPUTER_USE_RETIREMENT_RECORD.md) supersedes record 65. No external evidence or competitor claim
was added. Current code-only gate: [08](../../08_ACCEPTANCE_GATES.md).

## Archive and active boundary

`archive.json` records SHA-256 verification of 55 preserved source originals, including 29 retired active feature
files, at `/Users/vishsiddharth/Developer/bimax-archive/computer-use/2026-10-04-retired-cua-driver/`.
Its `manifest.json` names each original; `driver-dependencies/` preserves @trycua/@ubjs, native code and licenses.
Mixed files were copied before removing their CU integration. Feature-specific positive tests/probes are archived
with the feature, rather than weakened to pass. The current refusal boundary has new behavior tests.

The model registry, prompt, CU settings/flags, native service/menu/permission path and packaged SDK no longer
admit Computer Use. The governor denies COMPUTER_CONTROL before all shortcuts. Legacy host calls immediately
resolve unavailable; forged successful results are ignored. The app denies an old engine's request without a
native service or a card. Wire schemas remain compatible. Known direct GUI shell patterns refuse, while ordinary
commands remain available; this is not confinement of arbitrary scripts. Finder and voice paths remain unrelated.

## Verification

- `focused.log`: 11 suites / 72 checks, including actual preload/renderer/Composer ownership subscriptions, current
  retirement refusals, stale flags, prompt, actual port host, GUI command patterns and coding positive controls.
- `regression.log`: 12 suites / 135 checks — governor, budget, protocol/port fixtures, reducer/store, Thread reaping,
  restore/history, reliability, approvals and desktop runtime safety.
- `registry.log`: 6 real-container tests under Bun with temporary config/secrets/ledger paths; coding tools remain
  available and all four CU tools are absent with all old flags enabled. No provider task is submitted.
- `engine-typecheck.log` and `app-typecheck.log`: both TypeScript checks pass.
- `run-mutants.py` and `mutants.json`: 5 planted behavior faults caught (governor bypass, flag injection, shell
  fallback, host falsely succeeding, app falsely succeeding); each original restored in finally. No compile failure
  counts. Shell execution is mocked so weakening its guard cannot touch a user's app. An earlier shell-fault attempt
  had an unsafe harness and is discarded; it is not end-state evidence.
- Earlier [IPC proof](../2026-10-04-thread-ipc-isolation/README.md): 7 guard/buffer/owner faults caught, nine contract
  checks; current retirement regression rechecks these guards. Installed rapid-switch/reaper/crash qualification
  remains unmeasured.

`build.log` records production renderer/main/preload build, real bundled engine worker exchanges, rebuilt voice,
notch and App Intents, package absence gate, nested local signing and App Intents embedding. The machine's Xcode
license blocks that toolchain; the existing scripts use Command Line Tools. Voice retains its existing Swift
non-Sendable warning. Neither is a claim about release readiness.

Installed artifact receipts and package-fault proof are recorded below. Local signing
uses Bimax Local Code Signing (no hardened runtime, Developer ID or notarization). Full repository lint/test,
clean-Mac/other-chip distribution, live-provider journeys, C04/R01 qualification and fresh-open policy are not
proved by these offline/contract and local-install checks. No Product-ready or Win claim.

Guided by product-reset README, 01 audit, 03 examples, 04 frontend, 05 architecture, 06 split runbook, 07 roadmap,
08 gates, 30 prior reset, Mac Buddy vision, competitive README/06 rules and R01 (C04) journey boundaries. Records
55/64 retain the engine-worker architecture. CU competitive journeys, including X01, are owner-withdrawn scope.

## Installed end state

`install.json`: the old bundle was removed from `/Applications` by moving it to
`/Users/vishsiddharth/Developer/bimax-archive/apps/Bimax.app.before-cu-retirement-20261004`.
The signed staged bundle was moved into `/Applications/Bimax.app` on the same volume, avoiding an unnecessary
371 MB copy on a nearly-full disk. ASAR/engine SHA-256 values match the build; its designated requirement retains
Bimax Local Code Signing. Three old preview settings were removed, and only Accessibility/ScreenCapture approvals
for `ai.bimax.app` were reset (both tccutil exits 0). No Microphone or Finder AppleEvents reset was performed.
CU runtime state and a private pre-install settings/Thread backup are under the external source archive.
118 protected Thread/config/secrets files were hash-identical immediately before launch.

`installed-package.log` and `installed-actions.log`: installed inventory/worker topology and all three embedded
action checks pass. `installed-byte-match.json`: all 12 current `app/out` files match their installed ASAR bytes;
actual installed preload has both owner-forwarding callbacks. `installed-engine.log`: the **installed engine file**
answers all seven worker/MessagePort exchanges (46,973 outbound bytes) in the same-version development Electron
verification host, scratch project, no provider turn. This verifies the installed engine artifact; it is not a model
journey in the running window.

`launch.json`: installed main process is running; native AX inspection saw Bimax's welcome window with its renderer
inside the installed ASAR. All 116 backed-up Thread files remain byte-identical after launch; unrelated settings
match; no CU settings or runtime directory were recreated. No native CU daemon/host process was found.

`package-mutants.py` / `package-mutants.json`: the inventory-only scratch fixture uses copied engine bytes and
hard-linked read-only inventory inputs, never edits signed/installed bytes, passes at baseline, and rejects an
injected CU engine tool marker and driver directory. `package-old-rejected.log` independently rejects the real
pre-replacement installed CU build. Full-bundle signing/App Intents checks are separate from this inventory fixture.

**Implemented and locally verified/installed:** retirement and Thread ownership correction. 23 focused/regression
suites / 207 checks plus 6 real-registry checks pass; 5 retirement behavior mutants and 2 package faults caught;
prior IPC evidence records 7 caught faults. Both typechecks, production build, local signature, staged/installed
inventory/action checks, worker exchanges and launch pass. Live installed rapid-switch/crash/reaper qualification,
full repo lint/tests and public/clean-Mac distribution remain Target/unmeasured.
