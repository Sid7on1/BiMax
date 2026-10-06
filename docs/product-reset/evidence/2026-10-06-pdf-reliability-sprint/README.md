# PDF reliability sprint evidence — 2026-10-06, round 4

[Record 74](../../74_PDF_RELIABILITY_SPRINT.md) explains the reproduced defects, resulting behavior,
research guides and qualification limits. Fixtures use disposable files/executables, redirected
config/state and no provider turn. Existing test assertions and timeouts remain intact.

| Evidence | Actual observation |
|---|---|
| `baseline-results.json`, `baseline.log`; `writer-baseline-results.json`, `writer-baseline.log` | Ten reader and two real-Poppler writer regressions fail assertions against original source. |
| `pdf-baseline-results.json`, `pdf-baseline.log` | Unchanged existing layout suite: eleven passes, four timeouts. Prior rounds' failing evidence is preserved. |
| `layout-process-trace.json`, `layout-process-trace.log`, `trace-poppler.cjs` | Actual lifecycle trace: quick Poppler text/metadata, unintended fourth footer page, native OCR calls taking 21,369 ms / 13,528 ms. Diagnostic attribution only, not a speedup benchmark. |
| `poppler-diagnostic.json`, `poppler-diagnostic-final.log`, `poppler-diagnostic.test.ts`, `execfile-diagnostic.log` | Callback/promisified child completion works; no promisify defect is claimed. |
| `baseline-invalid-path-fixture-results.json`, `baseline-invalid-path-fixture.log`, `poppler-diagnostic.log` | Excluded exploration: Jest's virtual PATH was not explicitly forwarded to the original execFile fixture, and a diagnostic initially tried redefining a namespace getter. Neither qualifies a regression/mutation kill. |
| `focused-results.json`, `focused.log` | Five suites / 50 tests pass, including 29 new tests. Final focused JSON is filtered from the final broad run; its log is the direct final restored focused baseline. Earlier 49-test JSON/log are retained as focused-before-null files. Real subprocesses/files cover reader behavior; caller lifetime tests inject layout/OCR results and inspect actual image-job removal. |
| `mutations.json`, `mutation-run.log`, `mutation-*.log`, `post-mutation-source-hashes.json` | Twenty-six executable source faults fail behavioral assertions; exact SHA-256 restoration after each; full focused baselines pass before and after. Final source hashes match every final mutation receipt. |
| `mutation-fixture-attempts.json`, `mutation-initial-attempts.json`, `fixture-readiness-baseline.log` | Exploratory survivors exposed a deadline-before-launch fixture and an empty layout result entering fallback. Excluded from final kills. Final process checks wait for a running descendant; final merge fixtures retain another layout page and assert branch selection. A one-second readiness baseline was also invalid on this host; final waits allow three seconds without changing any existing timeout. |
| `jest-final-results.json`, `jest-final.log`, `qualification-summary.json` | Full Jest: 426 passed suites / 3,949 passed tests; one existing skipped suite / 19 skipped tests. Existing layout suite passes without weakened assertions/timeouts. |
| `bun.log` | 132 passed tests across fourteen files, including actual scanned native OCR tag/measurement/confidence. General OCR reliability remains Target. |
| `root-typecheck.log`, `root-build.log`, `app-typecheck.log`, `app-build.log`, `lint.log` | Production typechecks/builds pass; changed-file lint has zero errors and eight existing warning-tier findings. |
| `engine-build.log`, `engine-smoke.log`, `staged-engine.json`, `run-staged-probes.py` | Fresh scratch bundle answers seven real Electron worker/MessagePort exchanges with scrubbed credential variables and redirected state/config. No live model turn or install. |
| `pdf-probe-source.ts`, `pdf-probe-source-hash.json`, `pdf-probe-build.log`, `pdf-probe.json`, `pdf-probe.log` | Fresh separate bundled writer/reader verifies exactly three pages, sequential footers, exact 8.2 mm text on every page, all text-layer and no raster job. The retained source is byte-identical to the entry actually built. |
| `pdf-artifact-marker.log`, `pdf-render.log`, `pdf-render-files.json`, `visual-qa.json`, `qa/` | One disposable QA PDF authored; all three real Poppler-rendered pages visually inspected. Centered 1/2/3 footers, no clipping/overlap or extra page. These are QA evidence, not a requested PDF deliverable. |
| `dirty-before.json`, `dirty-preservation.json` | 252 starting dirty identities; all 247 unrelated identities preserved, five research documents intentionally extended. |
| `artifact-hashes.json` | Final source/test/script/research and retained evidence identities, including on-disk ignored logs. `git diff --check` passes. |

Commands actually run:

- `npx jest --coverage=false --runInBand <five focused PDF/cleanup/layout files> --json --outputFile=<focused-results.json>`
- `python3 scripts/prove-pdf-reliability-sprint.py` (exploratory fixture receipts excluded; final full before/after baselines pass)
- `npx jest --coverage=false --maxWorkers=1 --json --outputFile=<jest-final-results.json>`
- `npm run test:bun`
- `npx tsc --noEmit`; `npm run build`; `npm --prefix app run typecheck`; `npm --prefix app run build`
- `npx eslint <nine changed source/test files>`
- `python3 docs/product-reset/evidence/2026-10-06-pdf-reliability-sprint/run-staged-probes.py`: fresh `bun build src/index.ts --target=node`, Electron `verify-engine.js`, fresh bundled PDF entry, actual Node writer/reader and `pdftoppm -r 100 -png`.
- Visual inspection of every rendered QA page with `view_image`; actual hashes verified after retaining intermediates under `qa/`.
- `git diff --check`; SHA-256 checks of every initial dirty identity and every mutant restoration.

A final read-only fresh bundled reader additionally verifies null and ENOENT-coded abort reasons through tooling
and metadata, rereads all three exact text pages and proves the existing QA PDF was unmodified.
`pdf-reader-probe-source.ts`, `pdf-reader-probe-build.log`, `pdf-reader-probe.log` and
`pdf-reader-probe.json` retain that probe. Engine transport is also rebuilt and rechecked after
the nullable-abort fix; no second PDF is authored.

The retained staged-probe helper now builds from the retained PDF entry and writes QA directly
under the evidence directory; its original invocation used a fresh scratch entry and
`tmp/pdfs/round4-qa`, then those exact files were moved into `qa/`. No additional PDF was authored.
An intermediate production attempt used execFile with detached and failed TypeScript; spawn is
the supported final implementation. That compile failure is not a mutation kill or qualification.

Per-child bounds are not a whole-document/OCR deadline or a process memory/disk sandbox.
Recognizers themselves are not made cancellable. Windows descendants, escaped process groups,
large-document resources, native OCR cold start/reliability, cross-process file changes,
installed/provider/full R01 and distribution/performance remain Target/unmeasured. Failed cleanup
logs a warning; successful direct API consumers must dispose retained images themselves. Outputs
Shelf and record 70's new features remain Target. Computer Use remains retired. No dependency,
model/default, credential, commit, push or installed app change is made.
