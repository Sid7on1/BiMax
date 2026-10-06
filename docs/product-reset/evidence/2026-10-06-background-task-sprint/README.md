# Background-task sprint evidence

Local source and real-process qualification on 2026-10-06. Record:
[71](../../71_BACKGROUND_TASK_RELIABILITY_SPRINT.md).

- `dirty-before.json`: SHA-256 identity of every pre-existing dirty file (324 entries, including
  files under pre-existing untracked evidence directories); missing/deleted files use null.
- `baseline.log`: discarded namespace-spy fixture failure; not a behavioral baseline.
- `baseline-valid.log`: twelve assertions fail against the initial source, with the fixture repaired.
- `focused.log`: first four focused suites pass 35 tests.
- `focused-real.log`: five focused suites pass 42 tests including three real-process end states.
- `mutation-campaign.log`, `mutations.json`, `mutation-*.log`: thirteen executable mutants caught
  by end-state assertions, exact source restoration, 21 baseline tests before and after. Reproduce
  with `python3 scripts/prove-background-task-sprint.py`; do not run other source consumers while
  the mutation campaign is active.
- `jest.log` / `jest-results.json`: initial broad attempt, five PDF layout-routing timeouts while
  Bun was running too. `layout-isolated.log`: all 15 tests pass without changes. These failures
  are retained and do not count as a clean broad pass.
- `jest-final.log` / `jest-final-results.json`: final `npx jest --coverage=false --maxWorkers=2`
  (with JSON output), 419 passed suites / 3,870 passed tests, one existing skipped suite and 19
  existing skipped tests. No failed suites or tests. `bun.log`: `npm run test:bun`, 132 passed.
- `typecheck.log`, `build-final.log`, `app-typecheck.log`, `app-build.log`: root/app typechecks
  and production builds pass. `lint.log` retains the first error; `lint-final.log` has zero
  errors and 19 warnings for the nine changed/new TypeScript files.
- `engine-build.log`: `bun build src/index.ts --target=node --outdir /tmp/bimax-sprint-engine-2026-10-06`.
  `engine-smoke.log`: `app/scripts/verify-engine.js` run through Electron against that scratch
  bundle with redirected credential/state paths; all seven worker exchanges pass, no model turn.
- `dirty-preservation.json`: 316 unrelated existing dirty-file identities unchanged; eight
  intentional edits identified. `artifact-hashes.json` binds final source/scripts and log bytes.

Check `git diff --check`. Full installed C04/R01, provider-backed coding, escaped descendants,
performance/energy, clean-Mac release and competitive qualification remain unmeasured/Target.

The real process checks observe output produced by a resumed SIGTERM handler, absence of both
the resistant process and its descendant via signal-0, and actual non-zero command results through
BashTool → TasksTool. No final model prose is used as the grader. No user command/transcript,
credential, paid provider attempt, installed product change or competitive result is captured.
