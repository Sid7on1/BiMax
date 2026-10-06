# Transaction reliability sprint — 2026-10-06, round 2

**Status: Implemented and locally verified for the transaction fixtures below.** The owner requested
another bug-hunting, advancement and optimization sprint. This extends the existing coding-engine
transaction manager and `/tx` command under records 55/64/66. Outputs Shelf and record 70's new
feature sequence remain Target. Computer Use remains retired.

## Reproduced defects and behavior

The initial eight-test regression run fails all eight behavioral assertions against the original
source. Fixtures use real temporary files, with controlled asynchronous gates to reproduce races
and injected write failures to grade the receipt against the actual filesystem.

- Concurrent tracking of one path captured and registered two baselines. A path-indexed promise
  now coalesces capture while retaining every declared content intent. Repeated lookup uses a Map
  instead of scanning all paths. The fixture observes one capture and one restoration record.
- Commit/rollback could close a transaction while its snapshot was pending; the late continuation
  crashed or joined a newer transaction. Both operations now refuse while tracking is pending,
  leave the original transaction open and report an error through `/tx`. Snapshots retain the
  transaction object they started in. Automatic rollback reports an attempt or refusal, never
  unconditional success.
- A new transaction or recovery could overlap restoration and mutate a newer transaction's files.
  Restoration has one shared lifecycle fence. Begin, track, rollback and recovery respect it;
  recovery also refuses while another transaction is open. Busy tracking throws before the tool's
  write, rather than silently becoming an untracked edit.
- A later successful rollback discarded earlier in-memory recovery records. Records now remain
  indexed by transaction ID, and recovery/status inspect all unresolved transactions. Reusing an
  ID with unresolved records refuses. Recovery repeats the original strict conflict checks; it
  cannot force a human's newer bytes or permissions. The prior comment saying conflicts were never
  retried contradicted the implementation and is corrected explicitly.
- Equal bytes hid a changed mode behind “unchanged.” External permission changes are now conflicts
  unless force is explicit. Every attempted restoration, including forced unreadable-current-state
  restoration, rereads bytes **and** mode. A failed symlink chmod is no longer swallowed. Actual
  mismatches return failed and retain the baseline.
- The per-file 64 MiB ceiling allowed an unlimited collection of baselines and did not constrain a
  file growing after stat. Captured/reserved baseline bytes now share a configurable **64 MiB
  aggregate default**, including unresolved recovery bytes. Reservation occurs before allocation;
  rejected/committed/restored baselines release it. Over-budget paths are explicitly unprotected,
  never silently treated as absent. The default is a safety bound, not a measured optimum.
- Reads now open once, inspect that descriptor, allocate the inspected size, fill short reads and
  recheck size/timestamps/mode and path device/inode. Detected growth/replacement refuses the
  baseline and releases its reservation. A nonblocking open avoids waiting on a substituted FIFO;
  nonregular files remain unprotected. A dangling symlink is unreadable, rather than an absent
  baseline rollback may remove.

`/tx status` now shows captured/protected/unprotected paths, pending tracking operations, the shared
baseline byte budget and every retained recovery. Refused begin/commit/rollback/recover operations
carry error-level receipts. No new tool schema, provider/default/credential change or install occurs.

## Qualification and limits

Applicable contracts: C01's dirty-repository preservation and mutation proof; the local file rollback
and truthful-recovery portion of R01. This does not qualify the full provider outage/crash/resume
journey. Evidence is retained in [the sprint directory](evidence/2026-10-06-transaction-sprint/README.md).

- Forty-four focused tests pass across new lifecycle/command suites and the unchanged original
  22-test rollback suite. That suite exercises real write/edit/delete/multi-edit tool integrations.
- Twenty-one executable behavioral mutants fail assertions; source SHA-256 equality holds after
  every restoration, and the complete focused baseline passes before and after. An initial compiler
  failure and a fixture-gate timeout are invalid mutation attempts, not kills; both are recorded.
- Final full Jest (`--maxWorkers=1`): 421 suites / 3,892 tests pass; the existing one skipped
  suite / 19 skipped tests remain. Bun passes 132 tests across its 14 declared runtime-specific
  files. Root typecheck/build and app typecheck/production build pass; changed-file ESLint has
  zero errors and 33 warnings in the repository's warning tier.
- A fresh scratch bundle answers seven actual Electron worker/MessagePort exchanges, with
  redirected state and scrubbed credential environment; no model turn is requested. A compiled-code
  FIFO fixture returns unprotected, releases its budget and leaves the FIFO intact. These qualify
  the staged code on this Mac, not installation or a latency benchmark.
- All 369 unrelated pre-existing dirty-file identities match their starting hashes, including
  round 1's source/tests/evidence and deleted paths. Five existing dirty research documents are
  intentionally extended. `git diff --check` passes. No commit, push or install occurs.
- The first broad run (`--maxWorkers=2`) has four PDF-layout timeouts; the isolated
  unchanged PDF suite also has twelve timeouts. A focused diagnostic run passes. These failures
  are retained, assertions are unchanged, and this sprint does **not** establish PDF reliability.

**Remaining Target/unmeasured:** installed-app/live-provider qualification, crash-restart loading
of recovery manifests, process-wide RSS/energy/latency improvements, performance-optimal budget
selection and competitive comparisons. The aggregate budget bounds baseline buffers, not metadata,
intent-hashing temporaries, the one-at-a-time rollback read buffer or total engine memory. Current
read/write checks do not lock out external filesystem writers or symlink swaps between observation
and mutation; tracking does not lease an entire tool write. Atomic/durable multi-file rollback,
general compare-and-swap mutation and arbitrary metadata/ownership restoration remain Target.
Recovery persistence remains best effort when its directory cannot be written.

Guided by current product-reset README; audit/architecture/split 01/05/06 with 55/64/66 precedence;
gates 08; competitive README/02/04/05/06/07 and C01/R01; Mac Buddy vision's memory discipline,
filesystem awareness, safe mutation and independent end-state principles; V17–V19 in the research
playbook 12; inspected transaction/tool/command implementations and existing rollback tests.
`competitive/03_CAPABILITY_MATRIX.md` is absent from the current tree, as previously recorded in
gap 46. README's referenced records 32/33/34 are also absent; current source and available gates
were used, and no content is inferred from those missing records. Current Node 22 first-party
filesystem documentation is recorded in the source ledger; no competitor code is reused.
