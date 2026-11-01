# Seven security repairs and the Desktop/mobile source link — 24 October 2026

**Implemented; bounded local end states Measured. Installed/release and physical-phone qualification remain Target.**

The owner requested all seven findings from the 24 October audit be repaired without replacing
unfinished work, plus verification of the existing link to `/Users/vishsiddharth/Desktop/bimax-mobile`.
The original report is retained locally at
`/Users/vishsiddharth/.codex/reviews/bimax-security-20261024-1qxsx32b/REVIEW.md`.
This record supersedes those seven defects within the execution paths below, not the wider security backlog.

Guidance: product-reset README, 01 current audit, 05 architecture, 06 split runbook, 07 roadmap,
08 acceptance gates, Mac Buddy vision, competitive README/06 evaluation contract, C01 dirty-repo
repair and R01/C04 recovery. Records 99 and 103 supplied the existing mobile and preview contracts.
No new Computer Use owner, native automation permission, provider configuration or installed app change.

## Repairs and regression contracts

| Finding | Implemented change | Independent assertion / remaining scope |
| --- | --- | --- |
| F01 High: foreign local document inherits preload authority | Main grants navigation and IPC only to exact app-owned renderer documents, or parsed exact dev origin/document. Disable drag/drop navigation; gate redirects. | Exact foreign file refused with the right WebContents ID. Actual Electron 43.3.0 with production preload admits trusted sentinel, blocks renderer navigation and refuses foreign-document IPC even after privileged fixture loading. |
| F02 High: project files follow outside symlinks | Main pins an open directory descriptor at selection. App-owned POSIX helper uses descriptor-relative `openat` with `O_NOFOLLOW` for each ancestor and leaf; rejects special files and observed hardlinks before truncation. No path-based fallback. Retirement drains active operations before closing authority. | Real native reads/writes/list/search, ancestor/leaf links, root replacement, traversal, hardlink and FIFO refusal; outside sentinel bytes unchanged. Read 512 KiB, write 8 MiB, list/response 1 MiB, eight children and ten-second operation budgets. Search has a five-second admission budget. |
| F03 Medium: category-wide saved tool allows | Fallback Governor rules bind remembered allows to concrete tool identity (including MCP server/tool); legacy unscoped allows fail closed. Explicit denies precede allows. | A may reuse its grant; B still asks/refuses. This repairs the fallback path; current folder-bound Desktop requests enter the separate Thread policy first. It is not evidence that every Desktop tool previously inherited this defect. |
| F04 High: numeric request-ID collision across engines | Bridge by ThreadManager's fresh approval token, snapshot cards and args, refuse duplicate pending capabilities. Recheck expiry/cancellation/session generation at actual execution. Mobile gate snapshots requests and rejects conflicting/consumed capabilities. | Two real ThreadManager engines both issue request 1; actual mobile signing code, linked responder verification, Desktop adapter and manager deliver A=Yes and B=No with the original tokens exactly once. Tampering, overwrite, replay and signed-approval-before-Stop are graded. Engine bodies are inert fixtures. |
| F05 High: WebFetch SSRF | Validate normalized literal URLs, all DNS answers and every redirect. Reject mapped/private/special IPs, credentials, internal names and HTTPS downgrade. Pin one validated DNS address into Node HTTP(S) lookup while preserving the original TLS host. | Mock transports execute the actual lookup callback and grade selected address, mixed public/private DNS, redirect policy and Stop during delayed DNS. No real internal service is contacted. Public-only policy deliberately refuses some special-address and transition networks. |
| F06 Medium: unbounded fetch body | Enforce declared and streamed byte budgets before decoding/parsing, refuse compressed bodies, destroy streams, apply a 30-second request-chain deadline and five-redirect limit; retain 100k-character output cap. | Declared/chunked overflow, compressed response refusal, split UTF-8 and stream teardown. Body maximum 1 MiB; this is a transport bound, not a universal CPU/resource claim for all tools or arbitrary HTML. |
| F07 Medium: first-host consent auto-approved | NETWORK_ACCESS admission runs before routine/non-destructive Thread shortcuts. Interactive mode requires Yes for the exact URL host; unattended cannot mint consent. Existing per-session/host grant/denial caching and sovereign egress policy remain. | Real Governor + consent helper under both Thread and fallback paths; denied host cannot proceed, a new host asks, unattended refuses and sovereign policy wins. Explicit bypass mode retains its documented meaning. |

Session metadata now reads the most recent 512 KiB through the same file authority, discarding an
incomplete JSONL record. It is bounded recent metadata, not full all-time history/statistics.
Project saves remain direct, fsynced writes; crash-atomic saving is not claimed. Descriptor authority
prevents symlink traversal, not arbitrary same-user process interference, mount manipulation, or
hardlink creation after the file's link-count check. These remain separate threat-model qualifications.

The helper is staged by dev/build/distribution scripts and included as an Electron resource. The
package gate requires an executable of the requested architecture. Native compilation succeeded
for arm64 and x86_64; execution was arm64 on this Mac. Root npm test hooks stage the helper;
POSIX Linux compilation is supported for CI but was not executed here. Packaging/signing/notarization,
new installed helper execution, clean-machine toolchain setup and Linux CI remain unqualified.

The MCP App bridge remains available: its registration now uses the common checked IPC wrapper
with the current guest's exact sender/top-frame policy. No extra raw ipcMain registration is added.
The 18 actual Electron preview checks still pass, including one governed MCP tool call and zero
STUN/TURN network effects. This is source-build fixture evidence, not newly installed evidence.

## Both repositories and protocol 2

Desktop resolves its installed `desktop-responder` and `@bimax/protocol` package links, verifies they
come from the same mobile checkout and that package versions agree, and builds core/relay/responder
before app dev/build/distribution. `BIMAX_MOBILE_REPO`, if supplied, must agree with the installed link;
it cannot silently redirect the integration. Existing package links resolve to the requested mobile repo.
Use Node 24 as required by that repo; Node 22's native SQLite ABI is incompatible with the installed
mobile test dependencies. No ABI rebuild or dependency update was used to hide that mismatch.

`npm --prefix app run check:mobile` builds the linked code, executes all **14** responder cases,
validates a versioned JSON end-state report with exact case IDs 1–14, and runs the actual mobile
signer → responder gate → Desktop adapter → ThreadManager fixture. The old hardcoded path/13-case
console-banner expectation is removed. Case assertions are retained and case reporting cannot
silently omit or duplicate a case. The mobile gate's immutable request/collision guards are exercised
by the cross-repo fixture. Full mobile `npm run check` passes independently.

This is a **local source/build/contract connection**, not a paired physical phone. Responder remains
explicit opt-in (`BIMAX_RESPONDER=1`); native consent/banner/local Stop remain mandatory. Pairing
handlers exist in main, but the normal renderer still lacks a complete pairing/settings/account flow.
No credentials, identity stores, deployed relay/gateway, device builds or `/Applications/Bimax.app`
were changed. Physical iOS/Android pairing, reconnect/biometrics, account UI, coordinated cloud rollout,
installed real-provider/tool cancellation and unknown-effect recovery remain **Target**. Absolute
`file:` dependency paths and current CI checkout/Node assumptions also need portable coordinated setup.
See the mobile repo's `docs/DESKTOP-INTEGRATION-2026-10-24.md` for local commands.

## Verification receipts

Raw results: [evidence directory](evidence/2026-10-24-security-mobile/README.md).

- Final fresh focused Jest: **12 suites, 131 tests pass**, including **39 new regression cases**.
- Seven deliberately reintroduced source faults, one per finding, each fail an assertion in a
  disposable checkout; all original working sources remain untouched by mutation execution.
- Root/app typechecks and builds pass. Changed-module lint: zero errors, eight existing typing warnings.
- Bun: **133 tests pass**; release-artifact script checks: **3 pass**.
- Mobile full check: typecheck, lint, crypto/Noise, gateway/mobile, LAN/cloud security,
  14 responder cases and actual platform-runtime regressions pass.
- Cross-repo signer/adapter fixture: eight contract checks, exactly two intended engine replies;
  actual ThreadManager Stop disposes A without approving its late request or disposing B.
- Actual Electron renderer identity probe, all 18 output-preview checks, and bounded native
  host consent/banner/Stop fixture pass. The expected blocked Node import is a negative preview
  test, and the late-denial delivery log after Stop is not an action replay.

The broad Jest attempt is **not green**: 457 suites/4423 tests passed, eight suites failed, one
suite/three tests skipped. Seven failure suites are outside these repairs: three cannot resolve
Streamdown in Jest, two assume old Node worker heap overhead, one flags presentation-type boundary
crossings, and the FTS5 self-retirement guard detects that Node 24 now supports FTS5. Their unchanged
source/test hashes remain in the preservation receipt. The eighth was the new metadata-tail case
loaded alongside an earlier cached files module while that long run was in progress; the complete
fresh 12-suite run, including it, passes. Do not treat the broad attempt as final-source qualification.
The broad runner retained open handles after its result; its known test process was terminated.
A fresh complete suite, runner migration, full C01/C04/R01/X01/I01, installed/release,
model-tier quality and sustained performance remain **Target**. No test assertions were weakened
or unrelated product fixes bundled to make this record green.

The initial mock callback typing/error emission, fixture cleanup name and mutation-runner realpath/
open-timer problems were corrected before final qualification. An initial mutation attempt timed
out and is retained as failed tooling evidence; only assertion results in `mutants/mutations.json`
count as caught faults. Neither a timeout nor compilation failure is accepted as a caught mutation.

Before edits, both repos' existing tracked and nonignored files were hashed and source snapshots
retained outside the repos. Afterward, every unrelated pre-existing file remains byte-identical,
no pre-existing file disappeared, and the mobile user's existing deletions remain deleted. Changes
to overlapping dirty files are additive/scoped; no reset, checkout, stash, commit or push occurred.
The preservation receipt enumerates exactly which existing paths changed. Prior product-reset
records/evidence remain historical; new qualification is recorded here instead of upgrading them.

## Next priorities

1. Complete mobile pairing/settings/account flow and exercise signed physical-phone decisions,
   Stop/reconnect and unknown-effect reconciliation against a newly packaged installed app.
2. Qualify the packaged descriptor helper, signed resource inventory, concurrent filesystem
   interference/crash-save semantics and bounded-history UI on clean supported Macs.
3. Repair the broad runner/dependency/architecture contracts and coordinate portable two-repo CI;
   then run the full installed recovery/security/model-tier gates before any release claim.

## Subsequent phone settings delivery — 24 October 2026

The local pairing/settings UI and the runnable Desktop failures are superseded by [record 105](105_PHONE_PAIRING_AND_DESKTOP_TESTS.md). Physical-phone/native-network/biometric and cloud-account/release gates remain Target; this older attempt and its failures remain evidence.
