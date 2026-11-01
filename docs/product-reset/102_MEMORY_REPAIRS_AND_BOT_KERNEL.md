# Memory repairs and personal bot kernel — 2026-10-18

Status: **Implemented and locally verified**, with bounded offline kernel outcomes **Measured** by the retained worker fixtures. This record must be read with [the design written first](101_MEMORY_INTEGRITY_AND_PERSONAL_BOTS_PLAN.md) and [audit 100](100_CONTEXT_MEMORY_RAG_AUDIT.md). Final command results, source-fault observations and preservation checks live in `evidence/2026-10-18-memory-integrity-bots/`. Installed bot UX, hosted-model quality, unattended bots and release remain **Target**; the full offline gate has one unrelated external-fixture failure.

## Memory defects repaired

| Audit finding | Final mechanism | Local verification contract |
|---|---|---|
| A01: acknowledged writes lost across instances | Every JSON mutator shares an OS-backed SQLite write reservation across reload/mutate/publish; unique owner-only temporary files; cache invalidation after failed writes | Independent real worker/process writers preserve both notes, canonical directory aliases coordinate, killed holders release ownership, failed writes cannot return as ghost edits, recency cannot resurrect deletions |
| A02: old backfill overwrites updated vectors | Per-write generation plus exact document/chunk bytes and identity; reload under publication authority; active-space recheck | Same-instance and other-instance replacement, deletion, ABA and legacy versionless changes reject stale publication; unchanged legacy data still backfills idempotently |
| A03: worker ignores embedding endpoint | Container and worker use `createMemoryRetrieval`; explicit endpoint precedence and separate reranking credential resolution | Real worker and loopback HTTP fixtures verify local keyless embeddings with/without chat keys; remote reranking remains separate and local fallback stays opt-in |

JSON content remains in the existing file format; no bulk migration, ranking/default prompt-budget change, new package or installed-app change. SQLite's sidecar contains no memories; it supplies a connection lock and is closed after each mutation. A slow live holder is never evicted by a stale-time heuristic. Contention waits asynchronously with a bounded deadline and fails closed. Unsupported/corrupt coordinators never fall back to uncoordinated writes.

Parent directory canonicalization chooses the lock identity, while the caller's original write path is preserved. The first broad run caught an existing rename-interposition regression when the implementation also replaced that public path; it was corrected without changing the assertion. Stable aliases are tested. Hostile filesystem replacement, old/uncooperative writers, network-volume locking and hardware power-loss durability remain outside this qualification.

## Bot foundation implemented

The kernel is a development API, with an actual integration into the existing worker entry. It is not exposed as a renderer IPC handler, a new model tool, a bot creation screen or an automatic background task.

- `BotCatalog` creates and reads user-authored definitions with stable IDs and strict schema validation. Concurrent catalog edits use revision compare-and-swap. Names do not define identities or permissions. Saving creates no worker or model request.
- `BotService` freezes a definition revision and run ID, retains the invoking permission mode, and passes an explicit assignment to the existing SubAgentManager. Desktop's inherited machine ledger takes precedence; the development API uses one catalog-wide fallback across workspaces, never a new pool per profile. Spend/token reservations inherit the invoking run or create one explicit new-run budget.
- `compileBotContext` preserves the exact task and fixed constraints, bounds input with the existing tokenizer, includes complete optional evidence units with source/version metadata, rejects forged evidence identities and reports omissions. The worker still goes through the normal persona/AgentLoop/ContextManager request boundary.
- A bot uses a private memory file derived from its stable ID, shared only by its own runs. The shared retrieval factory, ProjectMemory, MemoryQueryTool and ordinary automatic recall all use this file. Global ProjectMemory construction is lazy so an importing bot worker does not start an unsolicited project-memory read before its scope is selected.
- The actual worker registry is narrowed before constructing its persona. V1 supports bounded file research, approved web research and private memory tools; shell, file mutation, native action, skill installation and nested delegation are refused. File reads/search roots are checked against canonical workspace identity; private catalog and workspace trees cannot overlap. This is a scoped application guard, not a claim of resistance to hostile concurrent filesystem replacement.
- Cancellation before admission starts no worker. Cancellation after dispatch requests the existing manager's termination and waits for its settled result/exit; it preserves the cancellation reason and releases the observed CPU lease in the fixture.

Two real offline workers, representing different saved bots, retrieve different private facts with the same memory document ID. Their facts reach the actual AgentLoop prompt and ContextManager evidence ledger without crossing into the other bot, while both use the same inherited spend buffer. This is a kernel integration fixture with a deterministic reader, not a live saved-model or installed-app journey.

An initial integration test exposed handoff-wrapper vocabulary drowning the task and causing lexical abstention. The final worker retains the exact task as its user request and puts the bounded handoff in its persona system context. The test was repaired through production wiring, retaining the assertion that the private fact reaches the request. A separate assertion was corrected to compare macOS's canonical `/private/var` path rather than its `/var` alias; the outside-path rejection stayed intact.

## What remains Target

| Area | Remaining work |
|---|---|
| RAG quality | Audit A04 semantic abstention and A05 oversized-line evidence loss; independent/equal-budget/embedding-window/reranker and answer qualification; records 97–98's rejected candidates remain unadopted |
| Context | Actual lite-model window/output accounting, provider/image token costs and live long-horizon summary quality |
| Bot product | Create/edit/review/run UI, contextual bot selection, explicit knowledge grants and memory inspection/deletion; this kernel does not expose user-facing creation yet |
| Parallel teams | Nested authority propagation, write-capable worktree teams, durable orchestration, verified integration and full cancellation/recovery lineage; V1 forbids generic child spawning |
| Knowledge | Shared-library/code/document attachment authorization and invalidation; parent-supplied provenance is preserved in a bounded handoff, while automatic private recall is what the current fixture admits to the live evidence ledger |
| Long-lived bots | Schedules, triggers, durable queues, pause/resume and unknown-side-effect reconciliation; saving a bot never enables them |
| Broader actions | Approved connector delivery, shopping checkout, external scans, edits and Mac-owned CU; a bot name or instruction grants none of these |
| Qualification | Physical installed app, live model tiers, sustained RSS/latency/energy, full R01/R02/C04, clean-machine distribution and release |

Bot profiles can describe any topic. Security review and shopping research are example purposes, with capability support explicitly bounded by the current kernel. This change makes no claim that a shopping bot can purchase, that a security bot has audited a real repository, or that autonomous personal bots are Product-ready.

## Verification, failed attempts and preservation

Guiding records: current product-reset README; 01/03/04/05/06/08; Mac Buddy performance/resource vision and V03/V27B; competitive status/model-independent strategy/evaluation rules; C01/C02/C04 and R01/R02; 93–100 and design 101. The referenced capability matrix remains missing. Fresh SQLite, Anthropic and LangGraph sources are recorded in design 101 and the source ledger; no upstream source is copied.

Starting inventory hashes **9,797** files. Exact baseline copies exist for every previously existing file intentionally edited. Source-fault testing copies the current source/tests into a disposable directory, injects one fault there, requires assertion failures rather than compiler errors/timeouts, restores that copy and checks that working-tree source is unchanged. Frozen starting memory source is also replayed against the new assertions in the copy. Historical audit evidence and rejected RAG evidence are preserved.

The first broad Jest invocation is retained as unqualified: it exposed the public-path regression and an incompatible runner setting. Setting `NODE_OPTIONS=--max-old-space-size=1024` overrode the worker heap-limit test's expected resource cap (1,072 MiB observed versus its 448 MiB ceiling). That runner setting was removed; the test and its threshold were not changed. An unrelated external mobile responder authentication integration failure is retained separately and is not masked by new memory tests. Final broad/focused outcomes are recorded in `verification.json` rather than inferred from a command invocation.

The first bot fixture run retained two failures: canonical-path expectation and the real recall-query wiring defect described above. Initial scoped lint retained one missing caught-error cause, subsequently repaired. None is counted as a source-fault kill. All attempts remain evidence.

Final local results:

| Qualification | Result |
|---|---|
| New repair/kernel suites | **36/36** tests pass across three suites |
| Broader focused regression set | **203 passed**, one existing skipped test, thirteen suites pass |
| Deliberate source faults | **14/14 assertion-caught** in disposable copies, exact restoration, restored suites pass, working-tree source unchanged |
| Frozen starting memory source | **10 assertion failures / six controls pass** under the final sixteen integrity tests; no production checkout replacement |
| Broad Jest | **4,433 passed, one failed, nineteen skipped**; 457 suites pass, one fails and one is skipped |
| Bun retrieval/OCR and context | **133/133** retrieval/OCR tests; **63/63** context tests |
| Context benchmark | Valid **context-bench@4, 43/43** graded cases; three separate resource measurements |
| Build/typecheck/script/lint | Root build, app build/typecheck and three release-script tests pass; lint **zero errors / 1,857 warnings** |
| Isolated staged engine | Builds with both WASM assets and answers **7/7 Electron worker/MessagePort exchanges**, 29,470 outbound bytes |
| Preservation | **9,785/9,797 original paths byte-identical**, twelve intended baseline-backed edits, zero missing/unexpected changes |

The broad failure is `app/src/main/responder/__tests__/adapter.test.ts`, whose regression command invokes the external `/Users/vishsiddharth/Desktop/bimax-mobile` repo. Its relay cannot load `better-sqlite3`: native ABI **137** versus this Node runtime's **127**. A minimal native-module load, independent of Bimax source, reproduces the same mismatch. No external dependency rebuild, assertion relaxation or external source edit was attempted. This is an open full-offline/release dependency, not a newly green gate or a memory-test pass.

The first isolated bundle invocation incorrectly used Bun's single-file `--outfile` despite emitted WASM assets. It and the resulting missing-bundle probe remain retained as invalid qualification attempts. The corrected `--outdir` invocation matches the normal engine build shape and passes the actual protocol fixture. The default `app/engine` stage and installed app were not replaced. Final focused/qualification source hashes stay unchanged throughout those checks.

No reset, cleanup of prior work, staging, commit, push, installation, user credential/model change or hosted answer benchmark is part of this work. Builds and local protocol checks qualify source/bundle behavior only. The final preservation receipt must distinguish intended edits from unexpected changes before completion.
