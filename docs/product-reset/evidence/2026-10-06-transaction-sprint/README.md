# Round 2 transaction sprint evidence — 2026-10-06

Qualification scope and limits: [record 72](../../72_TRANSACTION_RELIABILITY_SPRINT.md).
All fixtures are disposable; test configuration is redirected by `jest.setup.ts`.

| Evidence | Result |
| --- | --- |
| `baseline.log`, `baseline-results.json` | Original implementation fails all eight initial regressions; exit 1. |
| `mutation-baseline-before.log`, `mutation-baseline-after.log` | Final focused baseline: 44 tests pass before and after the final campaign. |
| `mutation-campaign-final.log`, `mutations.json` | 21 executable mutants caught by assertions; each source hash restored. |
| `mutation-fixture-attempts.json`, `mutation-invalid-recovery-first-attempt.log` | Initial compiler-only and fixture-gate timeout attempts are invalid and excluded. Compiler attempt details are recorded; its raw log was superseded on rerun. |
| `jest.log`, `jest-results.json` | First broad run, two workers: 420 suites pass, four PDF-layout tests time out; exit 1. |
| `pdf-isolated.log`, `pdf-isolated-results.json` | Unchanged isolated PDF suite: 12 timeout failures / three passes; exit 1. |
| `pdf-handle-probe.log` | One healthy-page test passes with diagnostic open-handle instrumentation; deliberately focused, 14 tests not selected. It does not resolve the PDF flake. |
| `jest-final.log`, `jest-final-results.json` | Final complete suite, one worker: 421 suites / 3,892 tests pass; one pre-existing skipped suite / 19 skipped tests; exit 0. |
| `bun.log` | 132 tests / 14 runtime-specific files pass; exit 0. |
| `typecheck-final.log`, `build.log`, `app-typecheck.log`, `app-build.log` | Root/app typechecks and builds pass; all exit 0. |
| `lint-final.log` | Changed-file lint: zero errors / 33 warnings; exit 0. |
| `engine-build.log`, `engine-smoke.log`, `artifact-hashes.json` | Fresh scratch bundle, seven real Electron worker exchanges pass; exit 0. State/config are temporary, credential variables scrubbed, no model turn. |
| `fifo-probe.log`, `fifo-probe.json` | Real FIFO against compiled TransactionManager: capture refuses as unprotected, budget released, FIFO still exists; exit 0. Observed milliseconds are diagnostic, not a performance claim. |
| `dirty-before.json`, `dirty-preservation.json` | 374 starting dirty identities; five research documents intentionally extended, all 369 unrelated identities unchanged. |

Earlier focused/intermediate logs are retained as development history. `focused-results.json`
predates the final automatic-rollback receipt test (43 tests); final mutation baselines and the
full final Jest JSON contain that additional test. `post-mutation-source-hashes.json` records the
first 20-mutant checkpoint; `artifact-hashes.json` and final `mutations.json` identify final source.

Commands used:

```text
npx jest --coverage=false --runInBand src/__tests__/transaction.sprint.test.ts
python3 scripts/prove-transaction-sprint.py
npx jest --coverage=false --maxWorkers=2 --json --outputFile=<first-results>
npx jest --coverage=false --runInBand src/__tests__/extract.layout.routing.test.ts
npx jest --coverage=false --runInBand src/__tests__/extract.layout.routing.test.ts --testNamePattern='every page the converter' --detectOpenHandles
npx jest --coverage=false --maxWorkers=1 --json --outputFile=<final-results>
npm run test:bun
npx tsc --noEmit
npm run build
npm --prefix app run typecheck
npm --prefix app run build
npx eslint src/core/transaction.manager.ts src/engine/commands/tx.ts src/__tests__/transaction.sprint.test.ts src/__tests__/transaction.command.sprint.test.ts
bun build src/index.ts --target=node --outdir=<fresh-temporary-engine>
app/node_modules/.bin/electron app/scripts/verify-engine.js <fresh-temporary-engine>/index.js
git diff --check
```

The mutation runner does not count compiler failures or timeouts as kills. No original tests are
removed, skipped, weakened or given longer timeouts. Passing final qualification is not proof that
the intermittent PDF issue, full R01 recovery, installed distribution or resource performance is
resolved. No competitor code copied, commit/push/install, provider/default/credential mutation or
positive competitive claim.
