# Non-CU engineering reliability — 2026-10-12

**Status: Implemented and locally verified.** The owner authorized bug fixing, engine reliability,
performance investigation, backend integrations, contained refactoring and build/release tooling.
Computer Use code and visual design were explicitly excluded. No app installation, provider-backed
run, native control, dependency upgrade, publication, commit or push was performed.

## What changed

| Work area | Reproduced problem | Result |
|---|---|---|
| Bug reproduction | A six-byte TIFF attachment entered native OCR discovery/compilation and exceeded the existing five-second test budget | TIFF endian/magic admission rejects malformed headers before calling OCR. Four plausible classic/BigTIFF headers still reach the existing backend. This is not full image validation or OCR qualification |
| Engine reliability | Returning from `LlmAdapter.chat()` after a yielded event left the provider stream and iterator open | An unfinished stream is aborted and its iterator disposed from `finally`; normal exhaustion retains existing usage/budget behavior |
| Performance investigation | MCP startup did not drain stderr until after initialize; lifetime stderr accumulated without a bound | Drain before connect, preserve split UTF-8 for logs, retain at most 64 KiB of diagnostic bytes and bound each log contribution. A backpressured 2 MiB startup fixture completes |
| Backend integrations | MCP task requests could exceed their declared budget; Stop did not reach polling; a lost tool response could replay a committed operation | One deadline covers dispatch, an eligible read reconnect, task polling and result fetching. SDK calls receive the remaining budget and cancellation signal. Stop wakes backoff and best-effort cancels the known remote task. Unannotated/destructive tools do not replay after a lost connection |
| Contained refactoring | Release checks had separate artifact-selection code with the same silent fallback defect | Shared `release-artifact.mjs` honors an explicit app/output path and refuses ambiguous architecture discovery. Shared deadline and bounded stderr helpers isolate lifecycle ownership |
| Build/release tooling | `--app missing.app` checked the installed app and reported success; CI installed only one dependency tree although it builds/tests shared source | Release scripts name the exact arm64/x64 output and quote output paths. Both CI jobs install root and app dependencies. Artifact-selector tests run through both default and CI test commands |

Read-only retry uses server annotations as a compatibility hint, not as approval or proof of
idempotency. Every external tool still goes through its existing governor. Remote cancellation is
best effort: a stopped local wait cannot establish that a remote side effect was undone. A task
reference supplies an existing task ID, not permission to dispatch the original tool again.

The protocol baseline's other failure was an outdated assertion: a plain input callback now
receives text plus two absent optional metadata arguments. The test explicitly checks all three;
the production protocol and CU metadata/routing were not changed.

## Evidence and verification

Raw logs, source hashes and mutation receipts are retained under
[`evidence/2026-10-12-non-cu-engineering/`](evidence/2026-10-12-non-cu-engineering/).

- Initial full Jest run: 433 suites / 4,150 tests passed, two failed (protocol argument assertion
  and malformed TIFF timeout); 19 tests and one suite already skipped. No timeout was extended.
- Five new MCP deadline cases failed before repair. Early compiler/fixture experiments were
  excluded from proof; timeouts are not mutation kills. The corrected stream reproduction failed
  because abort was never called. The artifact before-record names `/Applications/Bimax.app`
  despite the explicitly missing path.
- `npm run test:ci`: 439 Jest suites / **4,168 tests pass**, then **132 Bun tests pass**, then
  **three artifact-selection tests pass**. Existing 19 Jest skips and one skipped suite remain;
  none was added, deleted, weakened or hidden by this change.
- Root TypeScript build, app typecheck, app production build and staged engine build pass.
  Electron executes the newly built engine and answers all seven model-free MessagePort exchanges,
  including workspace identity, boot and heartbeat. This is staged-engine evidence, not a newly
  installed app or a full C04/R01 product journey.
- Seven executable source faults fail assertions: stream disposal removed, write replay enabled,
  startup cleanup removed, stderr limit widened, remote Stop disconnected, TIFF admission removed,
  and missing-artifact fallback enabled. Exact source bytes are restored and the 16 focused Jest
  cases plus three script tests then pass. Run `python3 scripts/prove-non-cu-engineering.py` only
  when other builds/tests are idle because it temporarily changes these non-CU sources.
- Diagnostic retention fixture: **8,388,608 input bytes → 8,388,608 retained text bytes before /
  65,536 retained bytes after**. These are retained payload counts, not RSS, allocation, elapsed
  time, energy or installed-app responsiveness measurements.
- A copied-source dependency probe fails with only app dependencies and passes with both dependency
  trees available. No hosted GitHub workflow or clean network install was run.
- Changed TypeScript files lint with **zero errors** (89 warnings). Whole-repository lint retains
  **19 pre-existing errors** in untouched files. This does not close the all-repository lint gate.
- The initial 475 dirty/untracked file hashes are checked again. Only the deliberately edited
  shared manifests, generic MCP client and documentation may differ; native CU, CU implementation,
  renderer design and unrelated user work retain their original hashes.

## Gates and remaining work

Guided by product-reset README; 01/05/06 ownership; 07 migration; 08 gates; Mac Buddy vision;
competitive README/02/04/05/06; and C01/R01 example contracts. Research cards **V03** (bounded
resources/cooperative cancellation) and **V04** (deadline propagation and avoiding mutation replay)
guide the hypotheses. The hard constraints were unchanged approval behavior, no uncertain write
replay, one deadline, exact dirty-file preservation and no CU edits. The admission rule is passing
actual fixture end states plus assertion-caught source faults, not a broad reliability percentage.

`competitive/03_CAPABILITY_MATRIX.md`, example `P01_FAST_CODE_AND_COWORK.md` and record 34 remain
absent despite historical pointers. They were not invented or used as qualification evidence.
README's records 55/64 and latest records 79–84 supersede the historical split/retirement topology;
this work changes neither that topology nor CU capability admission.

Live provider behavior, OAuth against a hosted server, dishonest read-only annotations, general
MCP reconnection/catalog races, other image decoders, full installed C01/C04/R01, cold startup,
indexing/renderer/RSS/energy performance, Intel packaging, Developer ID/notarization and clean-Mac
distribution remain **Target/unmeasured**. The installed app is unchanged. No Product-ready or Win
status is assigned, and no claim is made that all bugs in these six engineering areas are solved.
