# 118 — Persistence and duplicate-dispatch repair

Date: 2026-10-31. **Implemented, with bounded local verification.** First repair slice from
[audit 117](117_PRODUCT_DEPTH_AND_UX_AUDIT.md): A01 snapshot publication, A02 admission before dispatch,
and latent A06 remote creation. This does not complete the entire audit backlog or qualify the
installed app.

## Behavior and design

- An older coalesced snapshot cannot replace a newer acknowledged snapshot through an in-flight
  async rename. The final generation check, metadata replacement and generation update share one
  event-loop turn. Preparing and writing coalesced snapshot bytes remain asynchronous.
- Failed queued/sent-state saves prevent dispatch. Failed steering is not sent. Unexecuted inputs
  stay queued, a warning explains that unsaved work may not survive quitting, and activity reports
  saving failure. The already-running request continues after failed steering.
- Background write recovery and idle events cannot execute a held queue. A new explicit user
  message retries it only after immediate saving succeeds. Stop can discard it.
- Urgent saving always attempts publication, even when an identical projection was previously
  handed to the coalesced writer. An in-memory cache hit is not admission evidence.
- Failed immediate writes/renames clean their owned temporary snapshot.
- Optional first remote instructions create an empty Bimax Thread, then submit once. Normal
  responder startup still supplies no default-workspace option, so this is a latent-branch repair.

`ThreadStorage.saveNow` is a synchronous API. Making only the coalesced writer's final metadata
replacement synchronous closes A01 without converting the manager and every IPC/approval caller
to async APIs. Whole-history serialization, synchronous urgent writes and installed input latency
remain performance work. No speedup is claimed.

`ThreadManager.persist` returns whether urgent publication succeeded. Submit, pump and steer check
that result before calling the engine. A deferred save cannot authorize immediate execution.
Failed steering becomes queued input while the running request retains its sent state.

This establishes local process-exit/restart behavior, not storage-device power-loss durability,
cross-process writer coordination or full installed C04/R01. No new fsync guarantee is assigned.
No provider/model/config default, user profile, installed app, native permission or product
boundary is changed. Mac capability ownership remains with the app.

## Regressions and counterfactuals

`app/src/__tests__/thread.persistence.sprint.test.ts` is in normal CI discovery:

1. Suspend an old async commit after its generation check; save and independently reload a newer
   accepted input; release the old commit and verify the newest bytes remain. An indivisible old
   commit may instead finish before the newer publication.
2. Inject queued-state and sent-state write failures separately. Verify zero input dispatch,
   retained queued text, visible saving failure, no idle/background-triggered dispatch, then
   ordered single dispatch after an explicit retry and repaired storage.
3. Fail steering persistence during a running request. Verify the original input stays sent,
   the follow-up stays queued and no unrecorded steering reaches the engine.
4. Exit a real child process immediately after failed sent-state publication, bypassing deferred
   writes and normal Quit. The production manager/storage use a synthetic disk-effect engine
   port. Independently observe zero effects, then exactly one after restart, then no duplicate
   after another restart. This is not a packaged-engine or live-model journey.
5. Send one remote instruction through the real adapter and real manager; independently observe
   one queued input and one dispatch. The former mock missed create-with-prompt submission.

The first five tests failed assertions on the original source; the remote test independently
failed before its repair. Existing tests were not deleted, skipped or loosened.

`scripts/prove-thread-persistence.py` reintroduces six defects in disposable source copies: async
commit, ignored acceptance failure, ignored dispatch failure, ignored steering failure, automatic
retry without user interaction, and duplicate remote submission. All six cause assertion failures.
Production source is never mutated. A first invalid attempt found no tests because `/var` and
`/private/var` disagreed on macOS; its receipts remain under `invalid-mutation-discovery/` and do
not count as caught mutants. The script now canonicalizes its temporary root and requires Node 24
on PATH, or `BIMAX_TEST_NODE` pointing to it.

## Verification and preservation

Raw receipts and final totals: [`evidence/2026-10-31-persistence-repair/`](evidence/2026-10-31-persistence-repair/),
especially `verification.json`. Focused queue/recovery/steering/archive/Bin/responder checks pass
58 tests across nine suites. A later focused admission/cache/activity check passes 20 tests.
The full existing Jest suite plus six new tests passes 4,647 tests with three existing skips;
the final-source repeat has its own receipt. Declared Bun parity passes 133 tests.
Both typechecks and production Electron main/preload/renderer bundling pass. Scoped Desktop lint
checks all four changed modules and the new test with zero errors; existing warnings remain.
Explicit void returns also remove three existing consistent-return errors in the touched methods
and avoid adding a fourth in the new failure branch. Six source faults are assertion-caught.

Before changes, 10,165 existing nonignored files were hashed and the four runtime modules copied
into evidence. Preservation compares against that starting dirty checkout, not HEAD: existing
uncommitted work is part of the protected baseline. Only the four declared runtime modules and
research index/gate updates may change existing files; none may disappear. No reset/stash or
installation occurred. The final receipt records all changed and missing baseline paths.

No hosted-provider, fresh-Mac, installed binary, physical-phone, native GUI or power-loss journey
was run. Historical audit raw results remain unchanged. Green component checks do not close those
Targets or establish Product-ready, stable release or Win.

## Remaining order and guiding contracts

**Next is A03**, bounded and reloadable retained history; then A04 stable queued-message identity.
Memory quality, portable dependencies, installed recovery/resources and model-tier qualification
retain audit 117's order. Ordinary-send acknowledgement/draft recovery and standalone Retry UI
are not silently included in this repair.

Guiding documents: product-reset README, audit 117, 05 architecture interpreted against current
worker ownership, 08 acceptance gates, competitive README/05/06 and the R01/C04 recovery contract.
The frontend/Mac Buddy vision still requires truthful visible failure and responsive interaction.
