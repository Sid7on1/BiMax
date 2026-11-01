# 77 — Complete arc-cua source import and archived Bimax CU source return

Historical import receipt. [Record 80](80_FULL_ARC_SOURCE_AND_BUILT_IN_CU_FEATURE.md)
relocates the entire unchanged Arc snapshot into Bimax CU at
`app/native/computer/vendor/arc-cua/`; records 79/80 supersede runtime retirement.
The table below records the original import locations.


Date: **2026-10-07**, Asia/Calcutta. Owner instruction: copy everything from arc-cua
and bring the archived CU code into the repository, carefully. This supersedes
record 66's external-only source location for these snapshots. It does not wire
Computer Use into the product: tools, permission requests, dependencies and
packaging retain their current retirement boundary.

## Imported files

| Destination | Exact scope |
|---|---|
| `third_party/arc-cua/` | All **100 tracked upstream files**, 1,098,366 bytes, from `74ffae1108b1cb4b1f6b161084af12646f544ba5`, version 0.1.1. Code, tests, fixtures, examples, benchmarks, docs, site, `uv.lock`, original MIT license and ignore files are unchanged. |
| `archive/computer-use/2026-10-04-retired-cua-driver/` | All **55 manifest source files**, original README/manifest, plus **seven package/license notices**: 64 files, 1,362,566 bytes. Original source paths are under `source/`. |

The fresh first-party clone matched the revision inspected in [record 76](76_ARC_CUA_AND_ARCHIVED_BIMAX_COMPARISON.md).
The archived source manifest is based on `58c5ed72ee2137a8638005597de1e31bd963660f`.
No upstream or archived source was rewritten. Git blob/mode/size/SHA-256 details
are in the adjacent import manifests:

- [arc-cua manifest](../../app/native/computer/vendor/arc-cua.BIMAX_IMPORT.json)
- [Bimax archive manifest](../../archive/computer-use/2026-10-04-retired-cua-driver.BIMAX_IMPORT.json)
- [Source and verification receipt](evidence/2026-10-07-cu-source-import/review.json)

Copying used staged directories, refused existing destinations and symlinks, and
checked every staged file's SHA-256 before the directory rename. The original
external archive and fresh clone were left intact. The upstream snapshot has no
nested `.git` database. Only the narrow upstream-site exception was added to the
root ignore file, plus an exception for one archived dependency's package metadata
below `dist/`; Bimax's separate website and build-output exclusions stay.

The external archive contains saved chats/settings, runtime state, compiled
dependency code and native binaries. These are not source code requested for
return and were excluded. Dependency package/license notices were retained for
provenance, including the Node runtime's MPL-2.0 notice; they are not dependency
installation or binary redistribution. The original archive README remains
unchanged and describes the complete external archive; the repository wrapper
explains this copy's narrower scope.

## Product and build boundary

The copied Python driver is available as source but not connected to the Electron
host. No dependencies, locks, TypeScript include scopes, Jest roots, app
entrypoints, MCP registration or Electron packaging were changed. Existing main
and engine CU refusals remain. Archived mixed integration files are snapshots,
not replacements for current files; this preserves the intervening sprint fixes.

The existing `test:bun` script now prefixes its same fourteen test paths with `./`.
An initial Bun check reproduced an import-induced collision: bare paths act as
name filters and also discover the archived registry test, whose historical
container lacks the rest of its former tree. Explicit file paths prevent that
configured discovery without editing the imported tests. The initial failed
check is retained; the full configured Bun suite is rerun after this repair.

No native permission, app-control action, model/API request, provider key,
dependency installation, app installation, Git commit or push was performed.
arc's six previously observed runtime behaviors and limitations remain unchanged;
copying it is not a repair or a compatibility/latency qualification.

## Verification and status

The retained receipt records exact copied-file identities, Git visibility,
Python syntax checks, the in-memory runtime probe, active CU refusal/registry
tests, documentation/diff checks and preservation of pre-existing dirty/runtime
files. Test commands and actual results are listed in the receipt; no upstream
full suite or native benchmark was run. Hash equality qualifies the copy only.

Completed locally: **164/164 copied file hashes/modes match**, **74 Python files
parse**, **26 focused Jest tests pass**, **132 tests across the same 14 configured
Bun files pass**, and **six in-memory arc runtime assertions pass**. Jest discovery
finds 429 active suites and zero imported suites. All 1,680 baselined active source/
config files are unchanged except `package.json`'s fourteen path prefixes; a parsed
comparison confirms all other manifest fields identical. Of 53 pre-existing dirty
files, 48 stay byte-identical and five research documents retain their original
content exactly below new import notices. New local links and `git diff --check`
pass. Earlier sprint and comparison evidence is unchanged.

**Implemented:** complete arc source import and archived Bimax source return.
**Unimplemented/unmeasured:** app wiring, native functionality, provider-backed
completion, permission ownership, installed recovery, M02/X01, distribution,
performance, Product-ready and Win. No revival/release sequence was adopted.

Guidance: product-reset README; 01 audit, 05 architecture, 06 split runbook,
07 roadmap, 08 acceptance gates; Mac Buddy vision's observation/verification and
ownership boundaries; competitive README/02/04/05/06 and M02/X01; records 65/66/76.
The capability matrix remains absent. Runtime ownership stays with the Mac app;
no Terminal permission owner or legacy CU path is reactivated. Current notices,
gap/build-sequence and source ledger record the source-location change without
upgrading capability or qualification status.
