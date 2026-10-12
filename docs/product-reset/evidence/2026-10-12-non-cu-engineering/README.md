# Local non-CU engineering evidence — 2026-10-12

Scope and interpretation: [record 85](../../85_NON_CU_ENGINEERING_RELIABILITY.md).
These are local fixture/build receipts, not installed-product or live-provider qualification.

| Command / probe | Result | Receipt |
|---|---|---|
| Initial `npm run test:ci` | Two Jest failures; command stopped before Bun | `baseline-tests.log` |
| Final `npm run test:ci` | 4,168 Jest, 132 Bun, three Node tests pass | `final-tests.log` |
| `npm run build` | Exit 0 | `build.log` |
| `npm --prefix app run typecheck` | Exit 0 | `app-typecheck.log` |
| `npm --prefix app run build` | Exit 0 | `app-build.log` |
| `npm run build:engine` | Exit 0 | `engine-build.log` |
| `npm --prefix app run verify:engine` | Seven model-free exchanges pass | `engine-smoke.log` |
| `npm run lint` | Exit 1: 19 existing errors in untouched files | `lint.log` |
| ESLint on changed TypeScript files | Exit 0: 89 warnings, zero errors | `changed-lint.log` |
| Copied-source app typecheck, app dependencies only | Missing root dependency errors | `clean-app-only.log` |
| Same probe with both dependency trees | Exit 0, no output | `clean-both-packages.log` |
| `python3 scripts/prove-non-cu-engineering.py` | Seven assertion-caught source faults; exact restoration; restored tests pass | `mutations/results.json` and adjacent logs |
| Final focused Jest / Node tests after source comment cleanup | 16 Jest / three Node tests pass | `final-focused.log`, `final-scripts.log` |
| Bounded stderr fixture | 8 MiB input, 64 KiB retained | `stderr-retention.json` |
| Preservation of initial unrelated dirty files | 469 protected files unchanged | `dirty-preservation.json` |

Before-repair reproduction logs are named `*-before.log`. `initial-dirty-hashes.json` records the
initial dirty/untracked file snapshot; `source-hashes.json` records final files for this change.
The mutation receipt hashes predate a comment/indentation cleanup in `src/mcp/client.ts`; the
final focused tests and source manifest cover the resulting bytes. No behavioral change followed
the full test command or mutation campaign.

CI YAML was changed but no hosted workflow or clean network install ran. Whole-repository lint
remains failing. Existing Jest skips remain. CU/native implementation and renderer design were
excluded; no app installation or publication was performed.
