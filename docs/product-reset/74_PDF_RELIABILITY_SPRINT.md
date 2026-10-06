# PDF reliability sprint — 2026-10-06, round 4

**Status: Implemented; local qualification recorded below.** The owner requested another code
inspection, repair, advancement and optimization sprint. This repairs existing document production
and reading in the engine-worker monolith governed by 55/64/66. Computer Use remains retired;
Outputs Shelf and record 70's new feature sequence remain Target.

## Reproduced defects and resulting behavior

Ten initial reader regressions and two real-Poppler writer regressions fail behavioral assertions
against original source. The prior rounds' PDF timeout evidence is preserved. This round's unchanged
layout baseline has eleven passes and four timeouts. A separate process trace shows that the
three-page fixture actually becomes four pages: the footer's explicit width engages PDFKit's flow
wrapper below the content margin, despite `lineBreak:false`. The additional footer-only page sends
an otherwise digital report through native OCR. Poppler text/metadata finish in roughly 11–37 ms
in that trace; one native OCR invocation takes 21,369 ms and another 13,528 ms. These are observed
local samples, not performance benchmarks or a general explanation for every OCR failure.

- The writer buffers completed pages, visits all of them and positions the footer using measured
  text width without starting the flow wrapper. One-page reports remain one page; explicit
  three-page reports remain three pages and carry sequential footers on every page. This removes
  the reproduced unnecessary OCR path. Buffering all PDFKit pages is a memory tradeoff, not a
  measured memory optimization; the existing writer already returns a complete Buffer.
- Text splitting removes only an actual trailing form feed. A final page without that delimiter
  survives. Empty fallback output refuses instead of inventing page one; page metadata must be
  a positive safe integer. Actual malformed-file diagnostics survive. Only ENOENT is classified
  as missing tooling; inaccessible executables refuse, while an installed nonzero version flag
  remains distinguishable from absence. Already-aborted signals preserve even a null reason
  through tooling/page-count error classification rather than replacing it with a TypeError.
  Stop takes precedence over I/O codes carried by its reason, so an ENOENT-coded abort cannot
  be misreported as missing tooling or trigger a fallback.
- PDF subprocesses now have an internal 30-second per-child deadline, an optional explicit
  1–300000 ms deadline and an AbortSignal. Tool availability defaults to five seconds per probe.
  Already-aborted operations and invalid ranges/DPI/deadlines refuse before launch. On this Mac,
  deadline/Stop/overflow send SIGKILL to the inherited process group and close caller pipes before
  settling. Normal completion observes process-and-pipe close. Metadata failures caused by a
  deadline, abort or output overflow are not retried as text reads.
- Captured stdout and stderr share a per-child byte cap: 64 MiB for text, 1 MiB for metadata/render
  diagnostics. Chunks stay bytes until final UTF-8 decoding, preserving split characters. These
  caps bound captured output, not total process RSS, raster bytes or whole-document resource use.
- Every raster job owns a fresh child directory, even under a caller-supplied `outDir` parent.
  Unrelated stale images are not reused. Regular, nonempty image files and unique source page
  identities are required; every unreadable selected page must have an image. Missing coverage
  and duplicate/escaped page identities refuse rather than silently dropping scanned pages.
- Mixed documents rasterize only the inclusive envelope of unreadable pages; digital pages keep
  exact text. Separate unreadable pages may still include intervening digital pages in that
  envelope. OCR consumers use only images they need. This removes unnecessary render work in
  the controlled fixture, without claiming measured latency, energy or memory gains.
- Failed/cancelled render and failed coverage validation remove their owned image directory.
  Successful jobs expose an idempotent `dispose`; direct API consumers retain images until they
  call it. Both extraction paths and ReadDocumentTool dispose in `finally`, after OCR consumption,
  including recognizer failure. Stop received during OCR is checked before returning a PDF success
  and propagated; the recognizer itself is not made interruptible by this change.

Existing test assertions/timeouts stay intact. The scanned-document test disposes reader-owned
images after OCR. Two stale test comments accepting the writer's
extra page or describing whole-document rasterization as unavoidable are updated. Void renderer
branches now call their renderer then return, satisfying existing lint rules without changing
render behavior. No dependency, default model, credential, Computer Use route or installed app
changes; no commit or push.

## Qualification and limits

Applicable contracts: C01's dirty-repository preservation, reproducer and executable mutation
proof; R01's bounded failure/cancellation and truthful local observations; V17–V19 owned file
cleanup and independent end-state checks. This is not the full provider/crash/restart journey or
an Outputs Shelf implementation. [Evidence and exact commands](evidence/2026-10-06-pdf-reliability-sprint/README.md)
retain initial failures, diagnostics, final runs, mutation receipts and visual QA.

- Five focused suites / 50 tests pass, including 29 new regressions and positive controls.
  Real executable fixtures produce actual stdout/stderr and disk mutations; no child outputs are
  mocked. Caller cleanup tests isolate the governor wrapper and inject recognizer/layout results
  while inspecting actual disposable image files. Real Poppler checks final PDF pages and text.
- Twenty-six executable production-source mutants fail behavioral assertions, with exact SHA-256
  restoration after each and passing complete focused baselines before/after. Exploratory survivors
  exposed two fixture weaknesses: the short deadline could precede user code, and an empty layout
  conversion entered fallback instead of merge. Final process termination waits for a running
  descendant's readiness; merge fixtures retain one layout page and omit another. Excluded attempts
  and a too-short readiness baseline are retained; they are not counted as mutation kills.
- Full Jest: 426 suites / 3,949 tests pass; the existing one skipped suite / 19 skipped tests remain.
  The existing fifteen-test layout routing suite passes in the focused and broad runs without any
  timeout/assertion change. Bun: 132 tests across fourteen files pass, including actual scanned
  native OCR content/measurement/confidence checks. Their passing result does not qualify general
  OCR reliability. Root/app production builds and typechecks pass; changed-file lint has zero
  errors and eight existing warning-tier findings.
- A fresh scratch engine bundle answers seven real Electron worker/MessagePort exchanges with
  redirected state/config and scrubbed credentials; no model turn or install. A separate fresh
  bundled PDF writer/reader probe independently verifies three pages, sequential footers and
  exact 8.2 mm text on every page, all classified as text-layer with no raster job. All three
  Poppler-rendered QA pages are visually inspected: centered footers, no clipping/overlap or
  extra page. This disposable report is evidence, not a user-requested document deliverable.
- All 247 unrelated starting dirty identities remain intact; five existing research documents
  are intentionally extended. Final mutation source hashes match production source. Existing
  scanned-document tests now dispose their new reader-owned images after OCR; assertions and
  timeouts stay intact. `git diff --check` passes.

**Remaining Target/unmeasured:** general native OCR cold-start/recognition reliability, recognizer
cancellation and a whole-document/OCR deadline; installed app/provider/full R01 and clean-Mac
Poppler/distribution qualification; Windows descendant termination and escaped Unix groups;
large-document raster/page/pixel/disk and aggregate concurrent memory admission; renderer RSS,
PDFKit page-buffer growth, latency and energy measurement; input-file changes during a read and
cross-process path swaps. ReadDocumentTool's existing missing/errored OCR-page reporting semantics
are not generally requalified. Cleanup errors are logged and do not mask a valid read; removal
cannot be guaranteed on filesystem failure. Direct raster API consumers must dispose successful
jobs. There is no broad PDF reliability, Product-ready or competitive Win claim.

Guided by current product-reset README; audit/architecture/split 01/05/06 with 55/64/66 precedence;
applicable gates 08; competitive README/02/04/05/06 and C01/R01; Mac Buddy vision's runtime,
filesystem and closed-loop principles; V17–V19 in research playbook 12; inspected writer, reader,
OCR, extraction/tool consumers and tests. The PDF skill guided real rendering and visual QA.
`competitive/03_CAPABILITY_MATRIX.md` and README's referenced records 32/33/34 remain absent;
no contents were inferred. Current first-party PDFKit and versioned Node documentation, inspected
PDFKit 0.20.2, Node 22.13.1 and local Poppler 26.08.0 are recorded in the source ledger. The general
PDFKit documentation's lineBreak statement does not override the inspected explicit-width branch
or the reproduced final-file result. No competitor source was imported.
