# Round 5 local chat experience evidence

See [record 75](../../75_CHAT_EXPERIENCE_AND_RENDERING_SPRINT.md) for the product scope,
governing research, qualification and remaining Targets. Base: `808644a9c7559d4d2e06d06f73849c89ad54183d`.
The initial checkout was clean. The final check preserves 2,482 unrelated tracked files by Git blob
identity/mode. No install, model turn, config migration, commit or GitHub push is performed.

## Receipts

- `qualification-summary.json`: final 3,977 Jest / 132 Bun passes, 19 existing Jest skips,
  60 focused tests, 28 assertion-caught mutants, browser/build/transport checks and limitations.
- `lifecycle-baseline.json`, `quick-baseline.json`: original assertion failures, eleven and four
  respectively, with three and one positive controls. Quick bootstrap is first extracted without
  changing behavior. The baseline files precede additional independent guard tests.
- `mutations.json`: final deliberate-fault results and exact per-file source restoration hashes.
  `mutation-baseline-before.log` and `mutation-baseline-after.log` confirm 60 passing focused tests;
  browser baseline JSONs independently read rendered end states. Logs are locally retained under
  the repository's existing ignored-log policy; JSONs and reproducible scripts retain the proof.
- `renderer-before-memo.json`, `renderer-fixed.json`: identical fixture SHA-256, actual library
  call counts and browser end states. Only Markdown is reverted to HEAD for the original-count
  run; other lifecycle fixes remain. The final production-browser run verifies the repaired source.
- `renderer-probe.tsx`: actual React/components/hook with a synthetic preload API. Its input
  preservation is a fixture check, not installed Composer draft persistence. Copy verifies bridge
  bytes, not the native clipboard. No complete floating-bar window or provider journey is graded.
- `checks.json`, `lint-baseline.json`, `lint-final.json`, `lint-scope.json`: builds/typechecks and
  scoped lint. Raw lint still exits 1 for five unchanged legacy errors. Changed code introduces zero
  errors; fifteen warnings remain. No lint rule is disabled or assertion weakened.
- `staged-engine.json`: fresh bundled engine, seven actual worker-port exchanges, isolated config/
  state and scrubbed credentials. Transport only; no installed app or model turn.
- `sha256-manifest.json`: source/research and evidence content hashes, excluding itself/cache files.

## Reproduction

From repository root, after dependencies are present:

1. `python3 scripts/prove-chat-experience-sprint.py` runs focused/browser baselines, one deliberate
   fault at a time and restored baselines. It temporarily changes source and restores exact bytes
   in finally; do not run builds or other source tests concurrently with it.
2. `npx jest --coverage=false --maxWorkers=1 --json --outputFile=docs/product-reset/evidence/2026-10-06-chat-experience-sprint/jest-final-results.json`
3. `npm run test:bun` (retain output as `bun-final.log`).
4. `python3 docs/product-reset/evidence/2026-10-06-chat-experience-sprint/run-local-checks.py`
   runs root/app checks, browser proof and `run-staged-engine.py`. Lint scope compares exact
   unchanged HEAD lines, rules and messages, rejecting every introduced error.
5. `python3 docs/product-reset/evidence/2026-10-06-chat-experience-sprint/finish-evidence.py`
   refuses incomplete/failing receipts, mismatched rendering fixtures, unrestored mutations or
   unrelated tracked changes before creating the summary and content manifest.

## Excluded attempts and limits

`renderer-before-memo-attempt2.json` retains an invalid development-JSX runtime failure.
`renderer-before-memo-valid.json` is exploratory: its lexer counter attached to another compiled
module instance and observed zero; it cannot establish lexing performance. Final matched receipts
use the exact imported lexer module and production build. Two initial mutation fixtures failed to
compile; `invalid-mutation-attempt*.json` retain these invalid attempts. They are not behavioral kills.
`mutations-before-lint-cleanup.json` and `jest-before-lint-cleanup.json` retain an earlier valid run;
the final receipts follow import/return-style cleanup and a fresh complete mutation/Jest run.

Measured: library calls on this fixture. Cold-start/installed switching latency, CPU/RSS/energy,
native clipboard, full C01/R01/P01, model/provider behavior and competitive outcomes remain
unmeasured/Target. Referenced capability matrix, P01 example and record 34 are missing; no content
or journey result is inferred. Same-Thread initial-history/stream revision ordering and quick-bar
stale refusal errors remain outside this qualification. Computer Use stays retired.
