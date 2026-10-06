# Current-source fault audit — local evidence

Started 2026-10-04; final qualification 2026-10-05 (Asia/Kolkata). This is evidence for
[record 68](../../68_FAULT_AUDIT_AND_REPAIR.md), against the dirty checkout at
`58c5ed72ee2137a8638005597de1e31bd963660f`. Existing owner changes were preserved.
No commit, installation, live model request, billing service or competitive comparison was made.

## Final verification

Commands ran from the repository root, with output redirected to the named logs.
All final checks below use restored production source, with no active mutants.

| Check | Command | Result / retained evidence |
|---|---|---|
| Root typecheck | `npx tsc --noEmit` | exit 0; `typecheck-complete.log` |
| Root Jest | `npx jest --runInBand --no-cache --coverage=false --testTimeout=30000 --json --outputFile=docs/product-reset/evidence/2026-10-04-fault-audit/jest-complete.json` | exit 0; 415 suites / 3841 tests passed, 1 suite / 19 tests skipped, 0 failed; `jest-complete.log`, `jest-complete.json` |
| Bun native/retrieval suites | `npm run test:bun` | exit 0; 132 passed, 0 failed, 14 files, 328 assertions; `bun-delivery.log` |
| App typecheck | `npm --prefix app run typecheck` | exit 0; `app-typecheck-final.log` |
| App production build | `npm --prefix app run build` | exit 0; `app-build-final.log`; app source was unchanged by the last engine lifecycle/cache corrections |
| Final engine bundle | `npm run build:engine` | exit 0; `engine-build-complete.log` |
| Staged engine transport | `npm --prefix app run verify:engine` | exit 0; seven exchanges passed (29,453 bytes); `engine-smoke-complete.log`; real Electron worker/MessagePort, scratch project/config and in-memory key ledger; no `--turn` or provider request |
| Mutation campaign | `python3 scripts/prove-fault-audit.py` | exit 0; 23 executable mutants caught by failed assertions, exact source restored, 74 baseline tests passed before/after; `mutation-delivery.log`, `mutations/receipts.json` |

The final smoke used `BIMAX_BREAKGLASS_DIR` pointing to a temporary directory and
`BIMAX_KEY_LEDGER_PATH=memory`. It grades boot, health, ping, config, catalog, completions and
the project-specific filename returned from a real scratch folder. This proves the staged bundle's
transport/folder behavior, not a live coding outcome or an installed app.

## Defect and mutation proof

The focused baseline exercises real AgentLoop termination/tool exchange integrity, verification
transitions and scope, synthetic secret redaction, file/shell provenance and governor rejection,
real background sandbox writes, cached memory queries/external changes, identifier retrieval,
optional prompt bounds and RepoMap opt-out. Provider fixtures check admission before the wire,
split/cache pricing and usage settlement, cancellation/error cleanup, and the real Node
SubAgentManager worker transport sharing the same atomic run counters. Provider responses are
controlled fixtures, not paid provider behavior.

The background fixture checks the filesystem end state: a disposable home-directory write outside
the Bimax Thread folder must fail, and the in-folder control must succeed. Poisoned Bash file output
cannot authorize a subsequent downloader in either the same tool round or the next round. The cache
fixture replaces/deletes the backing file and races an external replacement immediately after save;
the next query must return the external writer's contents. These assertions test resulting behavior.

Each mutation has a JSON assertion report and log under `mutations/`. The receipt includes failed
assertion names, exit code, original source SHA-256 and restoration status. Compiler/import errors
alone do not count. The runner restores each exact dirty source file in `finally`; do not run it
concurrently with source edits, builds or other qualification runs.

Retained development attempts:

- `mutations/criterion-scope-invalid.*`: an initial mutation failed TypeScript control-flow analysis.
  It was discarded and replaced with an executable scope bypass; the invalid attempt is not a kill.
- `mutations/split-pricing-survived.*`: the initial valid pricing mutation survived because the
  assertion's default two-decimal tolerance exceeded the fractional-cent charge. Precision was
  strengthened to nine decimals, then the rerun caught it. The surviving attempt is not a kill.
- `cache-race-final.log`: a new fixture initially had an incorrectly typed filesystem spy. Its
  type was corrected; subsequent baseline/mutation and full qualification use the corrected fixture.

## Earlier failures, retained

`jest.log` / `jest-results.json` record the first broad run: four failed suites, including fixtures
whose old expectations contradicted stricter verification/approval/provenance behavior. Expectations
were updated without removing those checks. `focused.log`, `approval.log`, `provenance-final.log`
and `lifecycle-final.log` retain focused reruns.

`jest-final.log` / `jest-final-results.json` record two remaining failed suites: document extraction
exceeded Jest's default five-second timeout, and the cached renderer TypeScript environment lacked
the current Window declaration. `isolated-recheck.log` and `extraction-diagnosis.log` retain the
diagnosis: a clean TypeScript cache fixed the renderer test, and the document suite passed with a
30-second test timeout. No production extraction behavior or default test configuration was changed
for this audit. Final broad runs explicitly use `--no-cache --testTimeout=30000`.

`jest-clean.*` and `jest-delivery-*` are earlier green broad runs before the last lifecycle/cache
fixtures. Use `jest-complete.*` and the delivery manifest for the final snapshot. Existing skipped tests remain unqualified; this audit
added no new skips.

`bun-final.log` records **131 passed, one failed**: native macOS Vision OCR returned empty text for
the generated scanned-page fixture. The unchanged OCR fixture passed in isolation in
`ocr-recheck.log` (13 passed), and the full latest Bun run passed in `bun-delivery.log` (132 passed).
That intermittency remains an unresolved reliability qualification; a green retry does not erase
the failure or establish OCR reliability. No OCR runtime change is claimed.

## Artifact identity and limits

`delivery-manifest.json` records SHA-256 hashes of the audit's source/test changes and staged
engine/app artifacts. It excludes unrelated owner edits; the built app does include the existing
dirty checkout's changes. There is no new Git commit or installed-bundle identity claim.

Guiding documents: product-reset README, 01/03/04/05/06/07/08, Mac Buddy vision, competitive
README/02/04/05/06/07, and C01/R01/R02. Records 54/55/63/64/66 govern current sandbox, monolith and
retirement decisions. `competitive/03_CAPABILITY_MATRIX.md` is absent and that conflict remains
explicitly recorded. Gap register, build sequence and source ledger were updated with record 68.

Status is **Implemented and locally verified**, not Product-ready or Win. General semantic/visual
completion evaluation, provider-backed retrieval/task quality, paid accounting, unknown-route and
multimodal/cache-creation pricing, installed journeys, clean-Mac release and rival comparisons remain
Target/unmeasured. Whole-project green checks still depend on the project's checks being meaningful.
Sandbox reads/network/temp access follows record 54; taint is a conservative named-command policy,
not arbitrary-script network confinement. Cost caps use estimated tokens/USD, not invoice accounting.
The memory cache does not resolve cross-process write conflicts. BYOK and saved model choices remain;
the supplied DeepSeek/Qwen/₹200 launch premise was not established. Computer Use remains retired.
