# Security/mobile local receipts — 24 October 2026

Scope, fixes and limits: [record 104](../../104_SECURITY_BOUNDARIES_AND_MOBILE_LINK.md).
Use Node 24 for the linked mobile build; the current Mac uses
`PATH=/opt/homebrew/opt/node@24/bin:$PATH`. No paid provider calls or device pairing.

| Command / fixture | Result | Receipt |
| --- | --- | --- |
| `bash app/scripts/build-project-files.sh` (arm64 and x64; arm64 restored) | Compiles under CLT with warnings as errors; arm64 native behavior exercised | `native-build.log`, `focused.log` |
| `npx jest --runInBand --coverage=false --runTestsByPath` with the twelve paths listed in `focused.log` | 12 suites / 131 tests pass, including 39 new cases | `focused.log` |
| `python3 scripts/prove-security-boundaries.py --output <temporary evidence>` | F01–F07 each caught by a failed test assertion in disposable copied source | `mutants/mutations.json`, per-finding JSON/logs |
| `npx tsc --noEmit` and `npx tsc --noEmit -p app/tsconfig.json` | Both exit 0 | `root-typecheck.log`, `app-typecheck.log` |
| `npm run build` in root and app | Both exit 0; app prepares linked mobile dependencies first | `root-build.log`, `app-build.log` |
| ESLint on changed security/I/O/approval/fetch modules | Exit 0; zero errors, eight existing typing warnings | `lint.log` |
| `npm run test:bun` and `npm run test:scripts` | 133 Bun and three script tests pass | `bun.log`, `script-tests.log` |
| `npm run check` in mobile checkout | Exit 0; full current typecheck/lint/regression matrix | `mobile-check.log` |
| `npm --prefix app run check:mobile` | Exit 0; exact 14-case report and cross-repo signer/adapter fixture | `mobile-link.log`; strengthened final Stop/snapshot fixture in `mobile-adapter.log` |
| `app/node_modules/.bin/electron app/scripts/verify-security-boundaries.cjs` after app build | Trusted sentinel admitted; navigation and foreign IPC denied using actual production preload | `electron-renderer.log` |
| OutputPreview fixture (bundle `outputs.preview.ts` exports into `app/out/main/runtime-probe.module.cjs`; run Electron `app/scripts/ui/output-runtime.cjs` with `BIMAX_EVIDENCE_DIR` pointing to a fresh directory) | 18 assertions; zero unexpected network requests, STUN/TURN effects, or fixture errors | `output-preview.json`, `output-preview.log` |
| `node app/scripts/verify-mobile-host-controls.mjs <fresh evidence directory>` | Bounded actual Electron consent/banner/Stop fixture passes; synthetic host callback | `native-host.log`, `native-host.json` |
| Before/after SHA-256 comparison of existing tracked/nonignored files in both repos | No unrelated existing bytes changed or disappeared; 77 mobile deletions preserved | `preservation.json` |

`broad-jest-attempt.log` is retained as **non-green/nonfinal** evidence: 457 suites / 4423 tests
passed; eight suites failed; one suite / three tests skipped. Seven outside-scope suites concern
Streamdown resolution, Node-24 heap/FTS5 assumptions and presentation-module boundaries. The eighth
metadata-tail test ran alongside a cached pre-tail module while edits were in flight and is green
in the final fresh focused run. The broad process retained handles and was terminated after its
summary. This is not a completed green full-source gate.

`initial-mutations-attempt.log` retains an early mutation harness timeout from open approval timers.
A prior realpath mismatch found no tests. Neither is counted as mutation evidence. The corrected
runner canonicalizes its copy path, forces exit after assertion reporting, rejects timeout/compile/
no-assertion results, and catches all seven faults. `fresh-files.log` is an earlier seven-case
native pass; the additional shared process-budget case is included in final `focused.log`.

`hashes.json` hashes each receipt at finalization. These are local scoped receipts, not a
head-to-head run, a physical-phone/installed-app journey, a performance benchmark or a release.
