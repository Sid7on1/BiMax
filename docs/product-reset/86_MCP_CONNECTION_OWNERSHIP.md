# Non-CU round two: MCP connection ownership — 2026-10-12

**Status: Implemented and locally verified.** This continues the owner's six-area engineering
request and record 85. Computer Use implementation and UI design remain excluded. No app install,
real provider request, hosted-server login, dependency upgrade, commit, push or publication ran.

## Reproductions and changes

Thirteen new deterministic tests failed against the round-one source with assertion failures,
without increasing any existing timeout or removing any assertion. The final additions comprise
23 tests, including two real SDK/process fixtures.

| Observed failure | Change and independently checked result |
|---|---|
| Disconnect during a pending handshake returned false and the connection later appeared | Per-server attempt identity and cancellation retire the pending work; disconnect awaits its cleanup. A real hung-catalog process is absent when disconnect returns |
| Older same-name connection completion overwrote a newer intent, or cleared its pending marker | New intent cancels the old attempt. Only the current attempt may publish manager state or clear its pending entry |
| Disconnect while a replacement awaited old-client cleanup left replacement tools behind | Publish new ownership before awaiting old close, then retire exactly the connection being removed |
| A delayed watchdog probe could relaunch a disconnected server; a stopped sweep could run under a restarted timer | Connection identity and watchdog generation fence probe results and automatic healing |
| Retained tool references and old catalog responses remained live after deliberate disconnect | Owned disposal revokes the connection before asynchronous close. Retired references refuse; late replies cannot publish tools |
| Every catalog-change notification started another parallel tools/list request | One active read and one dirty bit coalesce notifications, with a follow-up read for changes during initial discovery |
| Old catalog cleanup could erase newer objects with the same name | `McpToolCatalog` removes only the exact tool objects its connection owns. A rejected duplicate-name catalog preserves the prior tool objects |
| Ordinary tools named read_resource were kept after removal; resource-only servers called unsupported tools/list | Synthetic resource adapters are tracked explicitly and discovery follows advertised capabilities. A real resource-only server returns the exact expected text |
| Resource reads ignored Stop, and optional template discovery extended the operation beyond its budget | Resource adapters now share one enclosing deadline, pass signal/remaining timeout to the SDK, and cannot swallow Stop as an optional-template failure. The fixture independently records remote cancellation receipt |

Concurrent read-only failures share one heal; an automatic heal cannot replace an ongoing manual
connection attempt or restore a disconnected owner. Record 85's no-uncertain-write-replay rule and
the existing external-tool governor remain unchanged. A server's read-only hint remains untrusted
metadata; cancellation receipt does not prove that a remote side effect was undone.

The SDK starts transport close asynchronously after initialize failure. Passing cancellation into
initialize exposed concurrent close callers returning before the original close completed. A shared
transport close promise fixes that regression; the existing real-process assertion caught its
deliberate removal. This qualifies the cooperative fixture, not every resistant launcher/descendant.

The resource adapters and registry ownership helper are contained extractions from the MCP client.
The existing curated server catalog at `src/mcp/catalog.ts` is byte-identical to its starting state;
a development filename collision was corrected before qualification.

## Local evidence

Raw receipts and final source hashes: [evidence directory](evidence/2026-10-12-mcp-ownership/README.md).

- `npm run test:ci`: **441 Jest suites / 4,191 tests pass**, **132 Bun tests pass**, **three Node
  script tests pass**, exit 0. The existing 19 Jest skips and one skipped suite remain unchanged.
- Final focused run with `--detectOpenHandles`: **79 tests across seven suites pass**, exit 0,
  with no reported open handles. This ran after the final await/return lint cleanup; the full
  command preceded that behavior-equivalent cleanup.
- Eleven new source faults are assertion-caught; restored 23-test baselines pass. The seven
  first-round source faults are rechecked separately and their restored baselines pass. Exact
  source bytes are restored after every fault. Timeout/compiler failures do not count as kills.
- Root TypeScript build, app typecheck, app production build, staged engine build and all seven
  model-free staged-engine MessagePort exchanges pass. Nothing was installed.
- Changed TypeScript lint: **zero errors, 59 warnings**. Whole-repository lint still fails with
  the same **19 pre-existing errors in untouched files**; the repository-wide lint gate stays open.
- Of 529 initially dirty/untracked files, **523 protected files retain exact hashes**. The six
  intentional shared-file edits are the MCP client/manager, first-round proof script, and three
  product-reset indexes. Existing native/CU/renderer work and prior evidence are preserved.

For the declared catalog fixture, 101 notifications previously started 101 refresh reads. They now
produce **two refresh reads**, with one active at a time; including initial discovery the checked
totals are 102 before / three after. These are deterministic operation counts, not app latency,
RSS, energy, network throughput or a competitive performance claim.

Proof commands (run sequentially with other builds/tests idle):

```sh
python3 scripts/prove-mcp-ownership.py
python3 scripts/prove-non-cu-engineering.py --output docs/product-reset/evidence/2026-10-12-mcp-ownership/round-one-regression
```

The first-round proof's startup fault now removes shared-close ownership because the SDK's own
signal-driven close makes the former missing-cleanup fault redundant. Its original record 85
receipts remain historical and unchanged; the new output option preserves them during rechecks.

## Acceptance boundary and remaining work

Guided by product-reset README, 01/05/06 ownership, 08 acceptance gates, Mac Buddy vision,
competitive README/02/04/05/06 and C01/R01 contracts. V03's cooperative cancellation/coalescing and
V04's deadline propagation/no duplicate mutation cards guide this slice. Adoption required exact
connection/tool/process/resource end states, caught source faults, restored baselines and protected
dirty bytes. README records 55/64 and 79–84 govern the current monolith/CU topology; this change
neither changes nor requalifies CU. The capability matrix and historical P01/record-34 references
remain absent and supply no qualification evidence. No new external platform or competitor fact
was used; SDK behavior was inspected in the installed dependency and exercised locally.

Installed C01/C04/R01, provider/model tiers, real hosted OAuth/refresh, SSE reconnection compatibility,
hostile servers, resistant process trees, cross-process durability, general indexing/startup/RSS/
energy performance, Intel packaging, signing/notarization and clean-Mac release remain
**Target/unmeasured**. No Product-ready or Win status is assigned.
