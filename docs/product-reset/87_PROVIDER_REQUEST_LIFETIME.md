# Non-CU round three: provider request lifetime — 2026-10-12

**Status: Implemented and locally verified.** This continues records 85–86 and the owner's
engineering request. This slice changes only the coding engine's provider request lifecycle.
Computer Use implementation and UI design remain excluded. No app installation, hosted-provider
completion, account sign-in, dependency upgrade, commit, push or publication ran.

## Reproductions and changes

Ten initial deterministic tests all failed against the round-two source with assertions. The final
addition is 22 tests: 17 deterministic lifecycle cases and five real SDK/local HTTP cases.

| Reproduced failure | Change and independently checked result |
|---|---|
| A slow backup-key lookup held an already available primary response and could launch an unnecessary backup | Header handlers are subscribed immediately. Primary success settles without awaiting key discovery; late keys cannot launch after success, Stop or expiry |
| The documented overall header budget depended entirely on SDK cooperation and could expire during backup lookup | One owner timer bounds all launched requests and key discovery, even with hedging disabled. Backup requests receive only the original remaining budget |
| A synchronous backup setup failure discarded a still viable primary | Each leg has its own failure state; the first successful leg wins, and all-leg failure preserves the primary error |
| Stop could leave an uncooperative header/chunk promise pending | Caller cancellation races both header and chunk reads; every launched losing/abandoned leg is aborted, and the unfinished iterator is disposed |
| Stop during rate-limit waiting could sleep for the remaining API window and then acquire/send again | Signal-aware acquisition interrupts the wait, checks before and after picking, and cannot repick after Stop. An already stopped chat reserves no API slot |
| Buffered tool events could continue after Stop, including between final tool calls | Cancellation is checked at event emission and finalization boundaries; remaining executable calls and done are suppressed |
| User interruption was counted as key failure and advertised a transient retry | Cancellation produces a non-recoverable cancelled event and updates neither key health nor the provider breaker's outcome samples |

The original ten assertions were kept. Additional checks cover timer/listener release across repeated
chunk reads, late rejections, reentrant Stop during setup, and cleanup/telemetry callbacks that throw.
No automatic tool execution or uncertain side-effect replay is added. Existing loopback and active
run-budget hedge suppression remain intact. An asynchronous key lookup that cannot itself be
cancelled may finish later, but its result cannot publish a new HTTP request after retirement.

A broader focused run exposed a deadline-boundary classification race: an SDK connection error at
the absolute header deadline could escape as a generic connection error instead of a stall. The
failure handler now checks the owner deadline before classifying a leg failure. A deterministic
clock test rejects deliberately removing that check. The initial failed focused receipt is retained.

## Verification and evidence

Raw commands, fault receipts, source hashes and protected-file hashes are retained in
[evidence/2026-10-12-provider-lifecycle/README.md](evidence/2026-10-12-provider-lifecycle/README.md).

The local HTTP fixture uses the actual installed OpenAI-compatible SDK **6.42.0**, a synthetic key
and a loopback server. It independently observes response closure after header Stop, response
closure after mid-stream Stop, one exact successful reply/done, exactly two requests for a forced
hedge with its held loser closed, and deadline closure with a stall error. Configuration read-back
and key health are unchanged on header cancellation. These are component checks, not hosted-model
or installed-app qualification. The forced hedge calls the helper directly; production loopback
hedging remains disabled.

Eleven deliberate source faults are assertion-caught, with exact bytes restored after each and
passing 22-test baselines before/after. Compiler errors, test-run timeouts and missing modules do
not count as kills. Run sequentially while other builds/tests are idle:

```sh
python3 scripts/prove-provider-lifecycle.py
```

- `npm run test:ci`: **443 Jest suites / 4,213 tests pass**, **132 Bun tests pass**,
  **three Node script tests pass**, exit 0. Existing 19 Jest skips and one skipped suite remain.
- Final focused `--detectOpenHandles` run: **60 tests across six suites pass**, exit 0, with no
  reported open handles. All source faults restore exactly; before/after 22-test baselines pass.
- Root TypeScript build, app typecheck, app production build, staged engine build, and all seven
  model-free staged-engine MessagePort exchanges pass (46,637 outbound bytes). Nothing installed.
- Changed TypeScript lint: **zero errors, 45 warnings**. Repository lint retains the exact same
  **19 existing errors**, compared by path/line/rule with record 86; its 1,816 warnings are not
  presented as clean. The repository-wide lint gate stays open.
- Of 583 initially dirty/untracked files, **579 protected files remain byte-identical**. Four
  intentional shared-file edits are the LLM adapter and three product-reset indexes. Existing CU,
  renderer, native, MCP and previous evidence files are preserved. `git diff --check` passes.

The declared late-key fixture now sends one request instead of two and makes a primary result
available while backup lookup is still unresolved. No app startup, wall-clock speedup, RSS, energy,
provider latency or competitive performance claim follows from these deterministic operation counts.

## Product-reset boundary

Guided by README; 01/05/06 product/ownership documents; 08 acceptance gates; Mac Buddy vision;
competitive README/02/04/05/06; and C01/R01 contracts. V03 cooperative cancellation and V04 deadline
propagation guide the implementation. Adoption required actual event/request/connection end states,
assertion-caught source faults, restored baselines and protected dirty bytes. Current monolith
records 55/64 and Mac-owned CU records 79–84 remain authoritative; historical split/retirement text
is not reactivated. No new external platform or competitor fact was introduced, so no source-ledger
claim changed. The absent capability matrix/P01/record-34 references provide no qualification.

Full installed C01/C04/R01, real provider/model tiers, hosted retries/billing, remote cancellation
semantics, cancellation undoing server work, resistant transports, cross-process recovery and
fresh-Mac distribution remain **Target/unmeasured**. This does not qualify a model's tool quality or
make the product Product-ready. Cancellation before key acquisition still propagates its abort
reason; cancellation during streaming emits a cancelled error and no done. The same user Stop
cannot be inferred to undo provider-side work already accepted.
