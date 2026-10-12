# Provider lifecycle evidence — 2026-10-12

Component scope: Bimax coding engine, actual OpenAI-compatible SDK 6.42.0, synthetic keys and
loopback HTTP; no hosted model or installed-app qualification. See [record 87](../../87_PROVIDER_REQUEST_LIFETIME.md).

- `verification.json` records actual command exits and limits; `source-hashes.json` binds final
  source, proof code, product-reset entries, and staged engine bytes.
- `before.log`: original ten regression tests all assertion-fail against round-two source.
  `after.log`: initial fixes and existing hedge/disposal tests pass.
- `http.log`: development fixture compile errors (wrong read-back method names); **not proof**.
  `http-after.log`: corrected fixture and initial tests pass.
- `focused.log`: preserved one failing timeout-classification race. `focused-final.log` passes
  after repair; `final-focused.log` passes all 60 final focused tests with open-handle detection.
- `test-ci.log`: 4,213 Jest / 132 Bun / three Node tests pass; existing skips remain.
- Build/typecheck/staged-engine logs record exit 0. `repo-lint.log` records exit 1;
  `lint-comparison.json` verifies the exact same 19 existing errors as record 86.
  `changed-lint-final.log` records zero errors / 45 warnings.
- `mutations/`: eleven assertion-caught source faults, exact restoration hashes, passing 22-test
  initial/restored baselines. `mutations.log` is the campaign stdout.
- `request-counts.json`: old helper starts A/B and delays an available primary during pending
  key discovery; new helper starts A only and returns while discovery is unresolved. This is a
  controlled operation count, not a wall-clock speedup.
- `hedged.request.before.ts` is this repository's original first-party helper, read from the
  recorded HEAD (it was clean at the start of this round), not competitor source.
  `request-count-probe.cjs` makes that comparison reproducible against the current helper:
  `node docs/product-reset/evidence/2026-10-12-provider-lifecycle/request-count-probe.cjs`.
- `initial-dirty-hashes.json` / `dirty-preservation.json`: 583 initial files, four intentional
  shared edits, 579 protected files byte-identical, zero unexpected changes.

No CU/UI source, installed application, provider credential/default, account or remote service was
changed. No commit, push, publication or broad reliability/performance claim is implied.
