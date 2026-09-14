# Context upgrade audit

## Verdict and scope

Steps 1–5 improve the eight original fixtures, but **C0/C1 should not be treated as fully qualified**. The current tests pass while important freshness, dependency, archive and budget contracts can still fail. The most urgent repairs are the legacy index migration, version binding during concurrent search/sync, dependency identity/lifetime, and independent budget grading.

Audited checkout: `/Users/vishsiddharth/Bimax`, branch `feat/sovereign-retrieval-and-layout-extraction`, commit `333329ffbbc550c8ff7e5a9fbafb3173b6e106e7`. The initial working tree was clean. Scope covers `711b222`, `eea9785`, `41568ac`, `e724750`, `610145a`, `3cc9dde`, and `333329f`. Product source was not edited; no commit or push was made. Synthetic inputs, runtime mutants and benchmark records live under `/tmp/bimax-audit-333329f/`. No stale Desktop checkout was accessed.

**Reproduced** below means a controlled probe exercised the current implementation and observed the defect. It does not mean an installed-app or live-model failure rate was measured. **Suspected** means source establishes a risk but its resource cost or production trigger was not reproduced. Severity reflects the stated contract and plausible consequence, not measured prevalence. No critical finding was established.

## Verification results

| Run | Result | Evidence |
|---|---|---|
| `BIMAX_STATE_DIR=/tmp/bimax-audit-333329f/test-state npm run test:context` | 25 pass, 0 fail; Bun 1.3.14, 87 assertions | `/tmp/bimax-audit-333329f/tests.log` |
| `BIMAX_CONTEXT_BENCH_OUT=/tmp/bimax-audit-333329f/benchmark npm run bench:context` | Valid under its existing validator; 26/33 graded pass, 3 measurements; FTS5 available, 0 intercepted fetch calls | `benchmark/2026-09-14T07-20-21-749Z_333329f.json` under the scratch directory |
| `bun /tmp/bimax-audit-333329f/probe.ts` | Reproduced migration, race, invalidation, encoding, archive, numeric and recall observations | `probe-results.json`, `probe.log` |
| `bun /tmp/bimax-audit-333329f/probe-extra.ts` | Reproduced identity collision, archive-directory escape, excluded-file coverage and pre-archive compression | `extra-results.json`, `extra.log` |
| Runtime mutants, described below | Budget mutant survives both supplied suites; benchmark has false-positive grades | `mutants.ts`, `preload-lying-budget.ts`, `mutant-*.json`, `mutant-tests.log` |

All commands ran serially. No model, paid provider, new dependency installation, application build or full Jest suite was run. The known 25 Jest failures, hybrid-MRR deficit, product-boundary failure and flaky slice timer are not reported as new regressions. Existing committed historical mutant claims were inspected in record 50, not rerun wholesale.

The benchmark's seven failures remain S5, M1, M2, L1, L2, L3 and B5. Its unchanged 26/33 score is reproducible, but the score is not a sufficient qualification gate: U09 demonstrates that a broken candidate can keep that score.

## Reproduced findings

### U01 — High: migration stamps old index rows with a new file's hash

**Location:** `src/memory/code.index.ts:271` (hash adoption at 272–274); admission at `:446`.

When a legacy manifest has only mtime and size, `performSync()` reads today's source and installs its hash without rebuilding the stored chunks. If the source changed with the same size and mtime before upgrade, old rows receive a new provenance stamp. Subsequent admission sees matching metadata and returns old text carrying the current file's version. This defeats the central A01/C1 guarantee.

**Reproduction:** index `export const marker = "oldsentinel";`; remove `h` and `c` from its manifest to represent the pre-upgrade format; rewrite to `newsentinel` with unchanged length and restore mtime; reopen the index and sync. The probe sets the legacy manifest's mtime to the observed restored value to avoid timestamp-rounding ambiguity. Sync reports `{indexed:0, removed:0, pending:0}`. Searching `oldsentinel` returns it with the SHA-256 of the `newsentinel` file. See `probe-results.json → legacy`.

**Fix:** legacy/unverifiable rows must be re-chunked locally, or compared to retained source bytes before adopting a version. Avoiding remote re-embedding is a separate optimization; it cannot justify inventing the version of old text. Store source version with each committed chunk generation.

**Attribution:** `git blame -L 268,277 src/memory/code.index.ts` identifies `41568ac` for adoption. Step 5's admission in `3cc9dde` makes the false new-version label observable. Old stale-index behavior predates the change; the unsafe migration is new.

### U02 — High: concurrent sync can attach a new version to an old search result

**Location:** `src/memory/code.index.ts:413`, `:422`, `:446`; rows and manifest are published separately in `performSync()`.

Search retrieves text, then consults the mutable manifest to decide which version that text represents. There is no row-bound version or shared snapshot. A sync between these operations changes the manifest independently of the already-returned rows.

**Reproduction:** wrap an index instance's backing `semanticSearch` in memory. Let the real search capture old documents; before returning them, rewrite the fixture to `newsentinel` and await the real `index.sync()`. Return the captured documents. `index.search('oldsentinel', …, 'lexical')` returns old text carrying the new file hash. This is a deterministic scheduling seam, not a claim that this exact interleaving occurs on every search. See `probe-results.json → race`.

**Fix:** persist version/generation with each row and compare that immutable version with the bounded current read. Publish replacement rows and their version atomically; either fence retrieval against sync generations or retry when generations disagree. Test both old-rows/new-manifest and new-rows/old-manifest schedules.

**Attribution:** `git blame` identifies `3cc9dde` for the new admission and evidence attachment. Concurrent store operations existed earlier; the purported version guarantee does not survive them.

### U03 — High: dependency identity and eviction can silently lose invalidation

**Location:** `src/context/evidence.ts:79`, `:118`, `:138`, `:142`, `:193`.

Three related defects break the promise that every dependent item becomes stale:

1. IDs omit dependencies, scope and kind. Two derived items with the same label/text but different parents have the same ID. `admit()` returns the second object but retains the first object's dependencies.
2. Eviction deletes a source and its stale marker without invalidating retained descendants. Descendants refer only to `span:<id>`, so the original file dependency becomes undiscoverable.
3. A child admitted after its parent is stale starts non-stale. Repeating `sourceChanged()` does not repair it, because propagation only runs when this call marks something new.

**Reproduction:** `ContextEvidence(2)` admits source A, child-of-A, then independent B; A is evicted. Change A: no IDs are marked and the child remains non-stale. Separately admit A, mark it stale, then admit its child: the child remains non-stale even after another source-change call. Finally create identical derived label/text from A and B; IDs match, stored dependency stays A, and changing B leaves the derived item current. See `probe-results.json → eviction/late` and `extra-results.json → identity`.

**Fix:** include canonical dependency identities, transformation version and authority-relevant scope in identity; reject conflicting duplicate IDs. Retain dependency tombstones or mark/evict descendants when an ancestor is evicted. Validate dependencies at admission and model missing/unknown dependencies as unverified. Test the default 2,000-entry boundary as well as the small fixture.

**Attribution:** all affected code is from `3cc9dde`. Current prompt consumers are limited, but fixing this before C2 is necessary; otherwise C2 would rely on unsound state.

### U04 — Medium: file versions are decoded-text hashes, not actual-byte identities

**Location:** `src/context/evidence.ts:34`; related `src/memory/file-state-cache.ts:39` and `src/memory/code.index.ts:452`.

`fileVersion()` uses the bounded byte reader, then decodes to UTF-8 before hashing. Invalid byte sequences can decode to the same replacement character. The byte-reader guarantee is lost at the adapter. The helper documents UTF-8 text hashing, but the surrounding current-byte claims are stronger.

**Reproduction:** write bytes `[0x61,0xff]`, call `fileVersion`, rewrite `[0x61,0xfe]`, call again. Both produce `sha256:51d277510ba4bf97b25f12d38513c1b620a2a33fc83b3beeeb0dd971bf429e6d`. The bytes differ. See `probe-results.json → encoding`.

**Fix:** hash the original Buffer for file identity, separately record encoding/decoding status and rendered-text identity. Reject unsupported encoding or label the representation as lossy. Change cache/index/adapters together so their version schemes remain compatible.

**Attribution:** `3cc9dde` introduces `fileVersion`; `41568ac` introduced text hashes in the cache/index. This is not a cryptographic collision.

### U05 — Medium: archive containment relies on the filesystem layout, not just handle syntax

**Location:** `src/context/output.archive.ts:43`, `:46`, `:61`; `src/tools/implementations/context-archive.tool.ts:8`; `app/src/main/thread.undo.ts:16`.

The handle regex correctly prevents direct `../` traversal. It does not prevent following symlinks. Archive files are read with `readFileSync`; archive directories and their ancestors are not validated against symlink replacement. A hash checks content identity after reading, not authority to read it.

**Reproduction:** create a synthetic file outside the archive; compute its 32-hex digest prefix; place a symlink named `<prefix>.txt` inside the archive. With `BIMAX_THREAD_ROOT` set to a different synthetic folder, `ContextArchiveTool` returns the outside file. Separately make the archive directory a symlink to a synthetic sibling directory: `archiveOutput()` creates its `.txt` there. See `probe-results.json → archiveSymlink` and `extra-results.json → directorySymlink`.

**Threat boundary:** these probes require control of the archive path and a matching digest for returned content. They do **not** establish arbitrary unknown-file exfiltration from a handle alone. A mismatched file is read but not returned. An attacker-controlled oversized target could still consume resources before rejection. No real private file was used.

**Task boundary:** `threadStateRoot()` hashes the folder path, not the task ID; same-folder tasks share state. The archive itself has no ownership manifest. A known handle from another task in that folder is readable. Normal quick tasks in different folders receive different state directories; this is not a demonstrated default cross-folder archive leak. `context.cwd` also does not select the archive: process state does.

**Fix:** define whether archives are folder-shared or task-private and state that accurately. For task-private promises, bind handles to an owning task/grant. Use a trusted private directory, no-follow regular-file opens, bounded descriptor reads, and protection against ancestor replacement; check authority independently of the digest. Do not claim that taking a handle alone guarantees scope.

**Attribution:** archive and tool are new in `3cc9dde`; folder-based state predates this work.

### U06 — Medium: the archive's 64 MiB cap is not a hard bound

**Location:** `src/context/output.archive.ts:38`, `:61`, `:83`.

A newly written file is exempt from pruning even when it alone exceeds the entire byte budget. Reads load the whole file synchronously before optional line slicing. A small requested range does not bound I/O, allocation or event-loop blocking.

**Reproduction:** `archiveOutput('x'.repeat(64*1024*1024+1))` succeeds and retains 67,108,865 bytes. See `probe-results.json → archiveCap`. This is a one-byte-over-limit proof, not a stress test against the laptop's memory limit.

**Fix:** reject or chunk outputs above the per-item limit before allocation/write; make total retention enforceable even for the newest item. Stream bounded reads with hash verification and cancellation, then return a bounded range. Preserve an explicit unavailable/oversized outcome instead of an unusable promise. Avoid synchronous filesystem work on the turn path.

**Related low-severity reproduction:** archive text, corrupt its file, then archive identical text again. The writer returns the same handle without repairing/verifying the existing file; its next read is `corrupt` (`probe-results.json → corruptExisting`). Validate existing blobs before reuse and use atomic writes. The reader correctly refuses the corrupted content.

**Attribution:** `3cc9dde`.

### U07 — Medium: the evidence record includes text never sent to the model

**Location:** `src/memory/recall.ts:137`, `:141`, `:191`; `src/core/agent.loop.ts:251`.

Recall truncates a selected passage to the character budget, then records the entire selected chunk as injected evidence. The store's stated meaning is what the model was shown. Its actual meaning here is what retrieval selected before rendering. C2 cannot safely use these spans as a residency or evidence-coverage ledger.

**Reproduction:** store a note containing `'orchid '.repeat(100) + ' HIDDEN-SENTINEL'`; call `recallForTurn(store,'orchid',{maxChars:100})`. The returned prompt excludes the sentinel while its evidence span contains it. See `probe-results.json → recallEvidence`.

**Fix:** distinguish source/candidate spans from rendered resident spans. Create the latter from the exact final slice, retain offsets/partial flags, and derive the prompt block from those slices. Do not claim whole-chunk residency merely because the source is known.

**Attribution:** the slice predates this series; recording the uncut evidence is new in `3cc9dde`.

### U08 — Medium: recall is removed before the very request that needs it

**Location:** `src/core/agent.loop.ts:261`; test at `src/__tests__/context.audit.acceptance.test.ts:188`.

`prepareContext()` injects recall and then compacts. If that compact removes the block, the current model request proceeds without it. Clearing `recalled` permits another lookup only on a later round; an answer-only round may finish immediately. The acceptance test counts searches, not resident evidence at the request boundary.

**Reproduction:** use the same forced-compaction ContextManager subclass as the acceptance fixture, 20 ordinary history messages and a substantial final question with a matching note. After `prepareContext('smart')`, no `[Recalled memory]` block remains, although the manager records two admitted spans. See `probe-results.json → recallAtBoundary`. This forces pressure handling; it does not assert normal low-pressure rounds lose recall.

**Fix:** allocate/compact before final recall admission, or rebuild essential recall after compaction within the final budget. Grade the actual next `llm.chat` input, including the case where the model produces a final answer and never takes another round. Keep the no-duplicate control.

**Attribution:** ordering/clearing code is from `41568ac`; the general residency compiler remains C2 Target. A04's durable-stale-block half is fixed, but its refresh claim needs this qualification.

### U09 — High: budget graders accept a materially broken implementation

**Location:** `benchmarks/context/cases.ts:514–518`; `src/__tests__/context.audit.acceptance.test.ts:230`.

Both suites trust the component's reported `tokenEstimate`. They do not independently measure returned pack text. B1 also treats every returned `{error}` as a successful overflow avoidance, including budgets where its fixture can fit.

**Reproduction and mutants:** all mutations were runtime replacements; repository source remained untouched.

| Mutant | Changed behavior | Observed result |
|---|---|---|
| `lying-budget` | Append `' oversized '.repeat(10000)` to every successful pack; set `tokenEstimate:1` | All 25 supplied tests still pass. B1 and M3 pass. Benchmark outcome vector remains the original 26/33 plus 3 measurements. |
| `error-pack` | `planContext()` always returns `{error:'mutant: disabled pack'}` | B1 still passes with four `error` sizes. M3 fails, so the whole benchmark does notice some damage. |
| `empty-search` | `CodeIndex.prototype.search` always returns `[]` | C3, C4, SC2 and SC4 still pass. Positive-hit cases fail; this mutant does not pass the complete benchmark. |

Commands: `bun /tmp/bimax-audit-333329f/mutants.ts <name>`; supplied suites with `BIMAX_STATE_DIR=/tmp/bimax-audit-333329f/mutant-test-state bun test --preload /tmp/bimax-audit-333329f/preload-lying-budget.ts ./src/__tests__/context.audit.acceptance.test.ts ./src/__tests__/context.evidence.test.ts`. Results are retained beside the scripts.

**Fix:** independently measure `pack.text` under a declared estimator/tokenizer, require useful output for feasible budgets, and assert the expected overflow reason for infeasible ones. Pair negative-source/scope cases with retained current/in-scope positives and distinguish unavailable retrieval from deliberate abstention. Add error/empty fixtures to each case grader, not only generic `hasAll` self-checks. Re-version the benchmark and rerun repaired baseline/candidate on identical fixtures before comparing scores.

**Attribution:** B1 is from `e724750`; current A05 assertions were authored in this series. Negative-only cases are not inherently wrong as narrow safety checks, but they cannot establish retrieval usefulness. The C4 improvement alone is evidence of stale suppression, not general freshness/retrieval quality.

### U10 — Medium: numeric compression still drops large values and invents unsigned ranges

**Location:** `src/memory/headroom.compress.ts:79–101`.

`numbersIn()` treats 7–40-digit decimal integers as hash-like IDs and removes them before range extraction. It also discards signs. The new range annotation can therefore report values not observed, or omit an outlier entirely. The maximum's original line is not preserved, despite the written step-2 plan asking for it.

**Reproduction:** compress 40 `temperature -100 C` lines, changing line 24 to `temperature -900 C`. Output says `numbers ranged 100–900`, though every temperature is negative. Compress 40 `payload 1000000 bytes` lines, changing line 24 to `payload 9000000 bytes`: the 9,000,000 outlier disappears and no range is emitted. See `probe-results.json → numeric`.

**Fix:** parse signed decimal/scientific numbers with contextual unit/column identity, distinguish identifiers from numeric fields, and preserve the actual extremum line. If semantics are uncertain, retain the lines or explicitly mark statistics unavailable. Add negative, seven-digit, decimal, exponent, timestamp and multiple-column fixtures.

**Attribution:** range extraction is new in `eea9785`; collapsing the large outlier predates it and remains an unresolved A08 edge case. The false positive range is introduced by the new annotation.

### U11 — Medium: “raw output archive” does not cover the normal lossy compression path

**Location:** `src/memory/context.manager.ts:222`, `:236`, `:366`.

`checkAndCompact()` compresses logs before `capToolResults()` or `microCompact()` archives them. Original ordering, individual numeric samples and ANSI content can disappear before any archive handle exists. A long output compressed below 512 characters can then be cleared without any archive at all. The micro-compaction unit test calls `reactiveDrain()` and does not exercise this preceding pass.

**Reproduction:** run the actual `checkAndCompact()` path with a 1,000-token manager, ten tool exchanges and a first output of 500 numeric samples with an outlier at sample 77. The evidence archive holds only later filler results, never the raw first result's SHA-256. See `extra-results.json → compressionArchive`. The probe is deterministic and uses a fixture summarizer.

**Fix:** archive once at raw result admission, before any lossy transformation, and retain the original handle through subsequent summaries/stubs. Otherwise document the narrower promise: recovery of the text seen by the cap/micro-compact stage. C3 cannot reconstruct percentiles or order from min/max alone.

**Attribution:** earlier compression is pre-existing; step 5 adds archiving too late to satisfy a general raw-output promise. Record 50 already reserves additional log work for step 6; that limitation needs to accompany the C1 completion claim.

## Production wiring and claim limits

| Path | Actual production connection | Limit |
|---|---|---|
| `ContextArchiveTool` | Imported and registered in `src/core/container.ts:82,385`; registry full-mode schemas include it, and smart-mode ToolSearch can discover it; ordinary tool factory checks still execute | No task ownership check in the archive; `enforceThreadScope` checks path-named arguments, not `handle`. |
| Archive writer | `ContextManager.capToolResults`, `microCompact` call `archive()` | Synchronous disk effects during compaction; not every lossy path is archived. |
| `ContextEvidence` | Owned by session ContextManager; AgentLoop admits recall; restoration and archiving admit spans | In-memory, not durable; count cap is not byte cap. There is no production caller of `refreshFileSources()` in the inspected tree. |
| Code-hit adapter | `CodeIndex.search()` constructs `CodeHit.evidence` | `CodeSearchTool` formats text and drops the structured evidence. AgentLoop does not admit those spans to the session store. It is a production-executed adapter with no downstream structured consumer yet. |
| Recall changes | `VectorStore.semanticSearch(...passages:true)` → `recallForTurn` → `AgentLoop.prepareContext` | Candidate evidence can exceed rendered evidence; same-query retry after failed retrieval and edited-memory refresh remain unresolved. |
| Read-cache/restoration | ReadFileTool stamps cache; ContextManager rechecks restoration hashes | Bounded file-version read, but decoded-text identity; restoration does not enforce a new task-root grant itself. |
| Code sync | `container.indexFor()` already awaits `sync(budget)` before normal CodeSearchTool searches | Step 5's stale-hit retry adds at most one extra sync per search, not an unlimited retry loop. Full discovery/hashing/backfill costs are not bounded solely by `budgetFiles`. |

No new module is wholly test-only. However, “every piece of evidence shown to the model” is not an implemented universal contract: ordinary reads, code-tool rendering, graph packs, FactStore/corpus adapters and final prompt residency do not all flow through one ledger. Record 50 explicitly defers some consumers/adapters to step 6. That is acceptable staging if C1 is called a partial foundation rather than a complete provenance system.

Archive handles are 128-bit prefixes of SHA-256. Every read verifies that prefix, not a stored full 256-bit expected digest. This is substantial integrity checking, but comments saying the full hash is checked should be precise. Normal same-text deduplication, malformed-handle rejection and corruption refusal work in the tested cases.

## Suspected risks and bounded observations

### S01 — Medium: resource bounds are weaker than their names suggest

**Locations:** `src/memory/code.index.ts:416,452`; `src/memory/sqlite.code.store.ts:290`; `src/context/evidence.ts:134,208`.

A scoped lexical search materializes all FTS matches with `.all()` before applying the scope. This fixes starvation but adds an allocation proportional to all matches. Admission can read an entire grown file with `fs.readFile`, even though source discovery normally excludes files over 200,000 bytes. Hash adoption scans eligible files beyond the indexing batch; dense backfill can make configured remote requests. No search-wide cancellation/deadline/byte budget binds this sequence. The 2,000-span store limits count, not text or dependency bytes; refreshing it allows up to 16 MiB per distinct source without an aggregate byte limit.

**How to measure:** generate a separate synthetic repository with many out-of-scope FTS matches, then grow one indexed file beyond the source limit before search. Count bytes read, rows materialized, peak RSS, event-loop delay, cancellation latency and configured provider calls. This scale experiment was not run; no p95 or memory-exhaustion claim is made.

**Fix:** scope in SQL or use bounded iterative candidates; enforce regular-file and byte limits in admission; coalesce targeted refresh with generation fencing; add aggregate budgets and abort propagation. Use an adjacency queue and bounded metadata for invalidation rather than repeated full scans. `eea9785` introduced scoped `.all()` and `3cc9dde` introduced admission reads; broader scans predate them.

### S02 — Low: graph cache still assumes callers do not mutate graph identity in place

**Location:** `src/graph/pagerank.ts:35`.

Replacing the graph/edge array or changing counts invalidates the cache, and the supplied rewiring tests prove that path. Mutating an edge's target in place through `getGraph()` can preserve the key. The comment acknowledges this. The graph interface exposes mutable objects, but an ordinary production edge-rewire trigger was not demonstrated.

**Reproduction to add:** rank A→B, change that edge object to A→C while keeping counts and array identity, rebuild adjacency consistently, then rank again; compare against a fresh store. **Fix:** generation bump on every graph mutation or an immutable graph API. Do not treat the current cache as a structural fingerprint. No newly caused production failure is attributed.

## Original defects and regressions

| Defect | Current conclusion |
|---|---|
| A01 | Same-size/mtime rewrite fixtures now pass for normal cache, sync and restoration. Legacy migration and concurrent generation binding remain broken (U01/U02); non-UTF-8 byte identity is unsound (U04). |
| A02 | Whole-segment scope and deep in-scope candidate retrieval pass under Bun. Cost tradeoff is S01. One-file support follows the same boundary predicate. |
| A03 | Answering chunk reaches ordinary recall in the fixture. Tight-budget answer loss remains B5, explicitly C2 Target; residency metadata also needs U07. |
| A04 | Stale recall is no longer retained as durable system text through real compaction; suppression resets. The immediate next request can still lose its fresh recall (U08). Memory edits are not live-invalidated, as record 50 discloses. |
| A05 | Rendered pack meets the declared four-characters-per-token estimate on existing fixtures and marks cuts. The grader is unsound (U09). This is not a tokenizer-independent hard final-request cap. |
| A06 | Graph replacement rewiring and dangling mass pass. Mutable-graph caveat remains S02. |
| A07 | Hindi letters/marks survive and the English control is unchanged. This is Unicode token retention, not language-specific segmentation or normalization qualification. |
| A08 | Positive small-integer outlier fixture passes. Signed/large numeric data remains unsafe (U10). |

The new 1,500-token default cut for large target functions is deliberate and documented in record 50. It now says `TARGET (source cut to fit the token budget)` and gives a way to read the remainder. This avoids silent over-budget packs, but callers must not interpret the prefix as a complete function; the top-of-file “full body” comments and entry-type comment are stale. No end-to-end editing regression rate was measured.

An empty index returns `[]` without crashing. Initial symlink sources and >200,000-byte files are skipped. A synthetic index containing only those files reports pending zero; after adding one normal file, CodeSearchTool renders `(lexical)` without “index incomplete.” That means completeness of the **eligible scanned index**, not all project files. Exclusion/coverage wording largely predates this series and is not counted as a new regression. “No matching code found … may still be syncing” is cautious but does not distinguish an empty complete index from failed or incomplete retrieval.

## Documentation and acceptance disposition

Guidance used: product-reset README; records 01, 03, 04, 05, 06, 08, 46, 47, 48 and 50; Mac Buddy vision; competitive README, 02, 04, 05 and 06; R02 retrieval contract and benchmark DESIGN. Current code-only scope supersedes historical CU architecture. `competitive/03_CAPABILITY_MATRIX.md` remains missing. At audit start, product-reset README said all eight defects reproduce/Everything Target, while records 48/50 said C0/C1 done; the gap-register RAG section was also historical. Dated qualification notes now link this audit from README and the gap register, preserving the historical claims rather than silently upgrading them. The source ledger records the new evidence and recommendation research.

Against acceptance gate 08 and competitive evaluator rule 06, U09 means the current “mutant-qualified” budget claim is not sufficient. Against R02, this audit supplies local source/fixture observations only. Live retrieval, representative local-model quality, crash/restart, packaged Desktop and clean-Mac qualification remain **Target/unmeasured**. No Product-ready or competitive Win claim follows.

Suggested order: repair U01/U02/U03 and U09; harden archive scope/bounds; align rendered evidence and raw-output handling; then resume F8 and C2. Keep the configured models unchanged when comparing the repaired baseline. These are recommendations, not code changes made by this audit.

## What was checked and found fine

- The requested branch/commit and initial clean state were verified; audited commit attribution used Git history/blame.
- All 25 existing Bun tests pass; the published 26/33 benchmark result reproduces.
- Scope filtering reaches deep in-scope hits and excludes sibling-prefix paths on the supplied fixtures.
- Normal same-size/mtime source edits are caught; deleted/renamed source fixtures pass after sync.
- Graph replacement invalidates rank/map caches; dangling-node mass sums to one on the fixture.
- Hindi token retention and the English-token control pass.
- Archive handles reject direct traversal; valid text round-trips; corrupted text is refused.
- Ordinary separate-folder quick tasks receive distinct state roots; the archive is not a single global folder in that launch path.
- Container registration and ContextManager/AgentLoop execution paths are real; remote code embedding/reranking consent remains in the container.
- The benchmark redirects state before dynamic engine imports and writes this run to scratch; no product source, commit or push was changed.
