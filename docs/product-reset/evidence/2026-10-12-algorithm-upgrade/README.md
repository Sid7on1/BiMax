# Record 88 evidence

Read `../../88_ALGORITHM_AUDIT_AND_UPGRADE.md` for scope, decisions, algorithm contracts and limits.
`verification.json` records actual checks; `dirty-preservation.json` proves 627 of 631 initially dirty
files remain byte-identical and the four intentional index additions retain their original content.

- `inventory-before.json`: frozen first-party structural baseline, 744 files / 10,494 JS/TS function
  bodies. `source-inventory.cjs` reproduces `inventory-after.json` (746 files). Structural hints and
  function locations are not a claim of exhaustive semantic review.
- `research.json`: 27 primary sources checked on 2026-10-12; no source code/model/dependency imported.
- `baseline/`: actual pre-change first-party source. `baseline-provenance.json` records identity.
- `benchmark.cjs`, `benchmark.json`, `measurements.md`: 33 component cases, 11 AB/BA pairs per case,
  exact equal outputs, all timings retained, no discards. Run with tests/builds idle:
  `node --expose-gc docs/product-reset/evidence/2026-10-12-algorithm-upgrade/benchmark.cjs`.
  This prints JSON; redirect to a NEW receipt when repeating. Do not overwrite historical evidence.
- `benchmark.initial.json`, `benchmark.accumulator.json`: prior candidate stages retained, including
  common-term regressions. They are not repeated final-candidate runs.
- `mutations.json`, `mutant-*.log`: twelve assertion-caught source faults and exact restoration.
  Reproduce with `python3 scripts/prove-algorithm-upgrade.py`, only with all other tests/builds idle.
  The runner temporarily edits production files and restores them in `finally`. Copy evidence into
  a new attempt directory before repeating: the current runner writes its fixed record-88 paths.
- `initial-mutation-campaign/`: initial unqualified crash-based mutant result. A valid-input
  no-throw assertion was added before the final campaign; the rejected grader result is preserved.
- Full Jest/Bun/Node, builds, real seven-exchange MessagePort bundle verification, changed-file lint
  and whole-repository lint logs. The 19 global lint errors match the prior round exactly.
- `manifest.json`: SHA-256 identities of final changed source, tests, runners, docs, baseline,
  receipts and staged engine. No installed-app, provider/model, energy/RSS or competitive proof.

The baseline and candidate operate offline on synthetic documents/keys/vectors. The exact score
ranking contract and store end states are tested; timing alone cannot establish correct retrieval.
Heaps have an explicit ordered-input latency tradeoff. Read every case in `measurements.md`.
