# Local MCP ownership evidence — 2026-10-12

Interpretation and limits: [record 86](../../86_MCP_CONNECTION_OWNERSHIP.md).

| Check | Result | Raw receipt |
|---|---|---|
| New reproductions against round-one code | 13 assertion failures | `ownership-before.log` |
| First repair | 13 pass | `ownership-after.log` |
| Expanded ownership/process fixtures | 22 pass, then 23 after watchdog-generation coverage | `ownership-expanded.log`, `mutations/before-faults.log` |
| Development integration regression | One child-close failure, subsequently fixed | `mcp-regression.log`, `transport-close-after.log` |
| Full `npm run test:ci` | Exit 0: 4,191 Jest, 132 Bun, three Node tests pass | `final-tests.log` |
| Final focused Jest with open-handle detection | Exit 0: 79 pass | `final-focused.log` |
| New source faults | Eleven assertion-caught, exact restoration, restored baseline exit 0 | `mutations/results.json` and adjacent logs |
| First-round fault recheck | Seven assertion-caught, exact restoration, restored Jest/script exits 0 | `round-one-regression/results.json` and adjacent logs |
| Root build / app typecheck / app build | Exit 0 each | `build.log`, `app-typecheck.log`, `app-build.log` |
| Staged engine build / verification | Exit 0; seven model-free exchanges | `engine-build.log`, `engine-smoke.log` |
| Changed-file lint | Exit 0: zero errors, 59 warnings | `changed-lint.log` |
| Whole-repository lint | Exit 1: 19 existing errors | `lint.log` |
| Unrelated dirty-file preservation | 523 protected hashes unchanged | `dirty-preservation.json` |

`initial-dirty-hashes.json` is the pre-round snapshot. `source-hashes.json` identifies final source,
tests, proof scripts and product records. `verification.json` records the observed command exits.
The notification fixture checks 102 total catalog reads before / three after, including initial
discovery; no elapsed-time, memory or energy measurement is inferred.

The full test command ran before a behavior-equivalent await/return lint cleanup. Final focused
tests, fault campaigns, builds and lint ran on the resulting source bytes. No installed app,
production account, hosted workflow or release qualification is represented here.
