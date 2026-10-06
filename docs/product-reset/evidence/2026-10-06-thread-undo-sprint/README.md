# Bimax Thread undo sprint evidence — 2026-10-06, round 3

[Record 73](../../73_THREAD_UNDO_RELIABILITY_SPRINT.md) explains scope, behavior and limits.
All file/Bin fixtures are disposable; the person's Bin is never used. Tests redirect global
configuration through `jest.setup.ts`; journal fixtures restore their environment after each case.

| Evidence | Observed result |
|---|---|
| `baseline-results.json`, `baseline.log` | Eleven initial regressions fail behavioral assertions against original source; zero compiler failures. |
| `focused-results.json`, `focused.log` | Eight suites / 67 tests pass, including 28 new tests and strengthened existing Bin fixtures. |
| `mutations.json`, `mutation-final.log`, `mutation-*.log` | Nineteen executable faults caught by assertions; exact source restoration, focused baselines pass before/after. Final source includes lint/error-cause fixes. |
| `mutation-fixture-attempts.json`, `invalid-mutation-note.md` | One initial compiler-invalid mutation is explicitly excluded; original diagnostic transcribed, raw log replaced by the valid rerun. |
| `jest-initial-results.json`, `jest-initial.log` | Initial broad run: 422 passed suites / 3,908 passed tests; 12 failures in unchanged PDF-layout routing, one existing skipped suite / 19 skipped tests. |
| `pdf-isolated-results.json`, `pdf-isolated.log` | Unchanged PDF-layout suite: three pass, twelve time out. This remains unresolved; assertions and timeouts are intact. |
| `jest-final-results.json`, `jest-final.log`, `qualification-summary.json` | Final broad run on lint-corrected source: 423 suites / 3,920 tests pass; one existing skipped suite / 19 skipped tests remain. This passing rerun does not establish PDF reliability. |
| `bun.log` | 132 pass, zero failures, across 14 declared runtime-specific files. |
| `root-typecheck.log`, `root-build.log`, `app-typecheck.log`, `app-build.log` | Final root/app typechecks and builds pass. |
| `lint.log` | Changed-file lint: zero errors, four warnings in the repository's warning tier. |
| `engine-build.log`, `engine-smoke.log`, `staged-engine.json` | Fresh scratch engine bundle passes seven real Electron worker/MessagePort exchanges; temporary config/state, credential variables scrubbed, no model turn or install. This is engine transport proof, not native Bin qualification. |
| `dirty-before.json`, `dirty-preservation.json` | Starting 231 dirty identities; all 226 unrelated identities preserved, five existing research documents intentionally extended. |
| `artifact-hashes.json` | Final edited source/test/script/research and retained evidence identities. Mutation source hashes agree with final source. |

Commands actually run:

- `npx jest --coverage=false --runInBand <eight focused undo/history/organize/recovery/journal files> --json --outputFile=<focused-results.json>`
- `python3 scripts/prove-thread-undo-sprint.py` (including repeat after error-cause lint fixes)
- `npx jest --coverage=false --maxWorkers=1 --json --outputFile=<broad-results.json>`
- `npx jest --coverage=false --runInBand src/__tests__/extract.layout.routing.test.ts --json --outputFile=<pdf-isolated-results.json>`
- `npm run test:bun`
- `npx tsc --noEmit`; `npm run build`; `npm --prefix app run typecheck`; `npm --prefix app run build`
- `npx eslint <five changed source/test files>`
- `bun build src/index.ts --target=node --outdir=<fresh scratch>/bundle`, then
  `app/node_modules/.bin/electron app/scripts/verify-engine.js <bundle>/index.js`
- `git diff --check`; SHA-256 comparison of every starting dirty identity and each mutant restoration.

Native Finder/iCloud/permission journeys, cross-process path swaps, fsync/crash durability,
backup capture/provenance, directory-content verification, installed/provider/full R01 qualification
and measured latency/RSS/energy remain Target/unmeasured. Step receipts do not make multi-file undo
atomic. No credentials/defaults, dependency, Computer Use path, commit, push or installed app changed.
