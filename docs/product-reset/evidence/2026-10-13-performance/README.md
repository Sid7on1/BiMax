# Record 90 performance evidence

See ../../90_GRAPH_PERFORMANCE.md for guidance, measured scope and remaining Target work.

- `baseline/`: exact starting first-party sources, including prior uncommitted graph-freshness work.
- `profile.json`: exploratory initial operation cost and adjacency-rebuild counts; not repeated qualification.
- `graph-benchmark.json`: final eight-case AB/BA graph operation timings; fixture creation and assertions excluded, four warmups/eleven repetitions/zero discards, exact outcomes checked.
- `graph-benchmark.initial.json` and `graph-benchmark.frontier-reuse.json`: earlier frontier implementations and all their timings; corresponding candidate sources retained.
- `heap-benchmark.json` and `.initial.json`: both rejected monotonic selector versions, sixteen cases each, exact outputs and every timing retained. Production heap unchanged.
- `check-candidate.cjs` / `candidate-checks.json`: 10,800 exact stable-sort prefixes, capacity, snapshot and comparison-bound checks on the rejected candidate.
- `mutations/`: eight assertion-caught correctness/performance/resource faults, exact restoration and a passing six-test baseline.
- `verification.json`: final local commands, exits and boundaries; full logs, builds/typechecks/lint and staged-engine exchanges are adjacent.
- `initial-dirty-hashes.json`, `check-preservation.py`, `dirty-preservation.json`: prior work protected; two intended source changes have exact frozen prior bytes, five document additions reconstruct their originals.
- `research.json`: primary sources and adoption/rejection decisions; no upstream code/dependency imported.
- `owned-paths.json`, `source-hashes.json`, `manifest.json`: scope and final hashes.

Component speedups do not establish installed task latency, startup, peak application RSS, energy,
hosted-model quality, competitive results or release readiness. No app installation or new commit/push.
