# Phone Settings and Desktop recovery evidence — 24 October 2026

Scope and product meaning: [record 105](../../105_PHONE_PAIRING_AND_DESKTOP_TESTS.md).
The continuation keeps new logs/receipts in `final-checks/`. Original screenshots and concise
source/packaged reports above that directory are retained as historical evidence. Earlier temporary
raw logs, build and initial record-105 preservation snapshot were unavailable at continuation,
so their claimed historical retention/preservation cannot be independently reconstructed here.
Record 104 has its own separately retained preservation receipt.

## Final checks

| Receipt | What actually passed |
| --- | --- |
| `desktop-tests-complete.log` | Node 24 Jest, coverage disabled, maxWorkers=2: 478 suites / 4,634 tests; one prior conditional suite / three tests skipped |
| `bun-complete.log` | Original 14-file parity set: 133 tests / 333 assertions |
| `script-tests-complete.log` | All three release-script tests |
| `mobile-check-final.log` | Full linked mobile check: typecheck, lint, crypto/mobile/gateway, fourteen responder cases, adversarial and actual Workers/Durable Object runtime |
| `cross-repo.log` | Desktop check:mobile: structured fourteen-case result, eight actual signed-approval/adapter/ThreadManager checks, two engine replies |
| `concurrent-integration.log`, `concurrent-port-regression.json` | Concurrent second fourteen-case run; both use distinct OS-assigned sockets from their own child IPC |
| `root-build.log`, `app-typecheck-final.log`, `desktop-build-final.log` | Root compilation, app typecheck and full Desktop build |
| `engine-build.log`, `engine-runtime-final.log` | Current staged engine and seven real Electron worker exchanges |
| `phone-lint.log`, `ram-test-lint.log` | Phone/public-protocol modules: zero errors/five existing warnings; RAM test: zero errors/one inherited unused-disable warning |
| `mutants/mutations.json` plus per-fault JSON/logs | Eleven assertion-caught source faults F01–F07/P01–P04; compile errors/timeouts excluded |
| `source-phone-final.log`, `pairing.json`, PNGs | Actual Settings component/production preload with actual mobile RelayClient and real Noise/local sockets: eleven checks |
| `packaged-phone.log`, `packaged-pairing.json`, packaged PNGs | Same eleven checks against packaged controller/responder and production preload |
| `package.log`, `sign.log`, `package-gate.log`, `actions-gate.log` | Local arm64 bundle, stable local signature, native-network purpose, artifact inventory, all three action checks |
| `install.json`, `installed/package-gate.log`, `installed/phone.log` and installed PNGs/JSON | Actual installed app.asar/preload, eleven pairing checks; same signing requirement; backup retained; 900 app-data files unchanged during replacement |
| `ios-export.log` | SDK-57 real iOS Hermes export, 3.8-MB bundle; artifact outside repo in local build state |
| `expo-server.json`, `expo-load.gif` | Earlier LAN Metro manifest/status, SDK 57, actual en0 URL; independent CoreImage decoder confirms loading QR |
| `preservation.json`, `*-resume-baseline.json` | Exact continuation-only modifications; no pre-existing file removed, all 77 mobile deletions retained |
| `diff-check.log`, `mobile-diff-check.log` | Both repository diff whitespace checks |

The source and installed verification/paired screenshots were visually inspected. Independent
CoreImage decodes the Settings QR data and actual screenshot back to the same advertisement.
Synthetic identities/tokens only. Engine callbacks are inert in the pairing fixture; separate
adapter checks use real ThreadManager reply validation. No receipt claims physical-iPhone execution,
OS permission grants, real provider effects, Face ID, notarization or full recovery journeys.
The fixture uses scratch data and injected encrypted storage, not the owner's production profile.

## Failed attempts retained

- `desktop-tests.log`: 4,633 tests pass, spreadsheet extraction exceeds unchanged five-second
  timeout while builds/mobile/mutation checks overlap. No assertion/timeout was relaxed.
- `mobile-check.log`: fixed-port collision with the Desktop-triggered responder suite; runner
  now receives its own dynamically assigned socket, and concurrent regression passes.
- `source-phone.log`: new delayed-Enable fixture read encrypted preferences before persistence
  completed; fixture now waits for completed operation, rather than treating socket-online as saved.
- `desktop-tests-final.log`: comparative heap assertion used transient allocations without forced
  collection. Test now forces GC on both runtimes, requires a valid baseline, retains the original
  75% bound and never silently skips it. Focused `ram-ledger-fixed.log`/`ram-ledger-bun.log` pass,
  followed by the complete final suite. No production memory claim is inferred.
- `engine-runtime.log`: mistakenly invoked an Electron-only probe with Node; corrected Electron
  run is `engine-runtime-final.log`.
- `lint.log`: broader touched-file lint remains non-green with two inherited `main/index.ts`
  errors and 36 warnings. That file is byte-identical to the continuation baseline. Targeted
  phone modules pass. These unrelated expressions/assignments are preserved.
- `package.log`: Xcode-license-gated icon catalog compilation skips and retains the legacy icon;
  packaging/signature/gates pass. No license acceptance or TCC reset was performed.

## Use and rollback

Installed `/Applications/Bimax.app` is a local certificate-signed manual build, not a notarized
release. Previous bundle: `~/.local/state/bimax/phone-20261024/previous/Bimax.app`. The complete
source bundle and exported iOS bundle are kept under that state directory. Do not move the old
bundle back while Bimax is running. The installer neither launched production Bimax nor enabled
phone networking. Metro is left available on the URL in `expo-server.json`; restarting the machine
or stopping that process requires restarting Metro with the documented command.

The owner scanned the initial project and observed an SDK-58 mismatch. The project is now upgraded
to SDK 58; [current upgrade evidence](sdk58/README.md) supersedes the SDK-57 export/server receipts.
Account sign-in, successful app execution, camera and local-network consent still need physical observation. Expo's loading QR is
separate from the Mac pairing QR. See record 105 and the mobile Expo Go guide.

## Current phone runtime

Use `sdk58/expo-load.gif` and `sdk58/expo-server.json`. Expo Doctor passes 20/20, full SDK-58 mobile
checks, final iOS export, actual development bundle, cross-repo and installed pairing fixtures pass.
The SDK-57 server was stopped before restart; the current server uses SDK 58 on the same LAN URL.
