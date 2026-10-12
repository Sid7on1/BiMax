# Algorithm inventory, research and exact-result upgrades

2026-10-12. **Implemented**: four changes to search traversal, result selection, breaker storage
and file-cache ordering. **Measured**: paired local component microbenchmarks and exact fixture
results below. Full installed task latency, energy, supported-machine coverage, live-model quality,
Product-ready status and any competitive Win remain **Target/unmeasured**.

The owner requested a codebase algorithm audit followed by deep internet research and practical
upgrades. The earlier exclusion of CU implementation and UI design remains in force. Existing
research, user changes and prior reliability rounds are retained.

## Coverage and limits

The baseline structural inventory covers **744 first-party source files, 127,577 lines and 10,494
TypeScript/JavaScript function bodies**, in `src`, `app/src`, `app/native`, `native`, `scripts`,
`app/scripts` and `benchmarks`. Vendor code, dependencies, tests, generated build outputs, evidence,
archive, reference checkouts, assets and configuration are excluded. Native Python/Swift/shell
files are listed and hashed; their functions are not counted by the TypeScript parser.

[Before inventory](evidence/2026-10-12-algorithm-upgrade/inventory-before.json) gives every covered
path, content hash, function location and discovery hints. The reproducible
[inventory script](evidence/2026-10-12-algorithm-upgrade/source-inventory.cjs) adds source locations
for sorts, front removals, splices, filters and slices. The
[after inventory](evidence/2026-10-12-algorithm-upgrade/inventory-after.json) includes the new heap
and mutation runner: 746 files, 127,730 lines, 10,502 function bodies. Its heuristic ownership
labels are navigation aids, not authority boundaries. The initial discovery count of 763 included
case-sensitive `Vendor` paths and a release test; those were removed from the first-party count.

**This is a complete structural inventory within the stated roots, not a claim that all 10,494
function bodies have received exhaustive manual semantic review.** The family decisions below
come from inspected source, existing evaluation contracts and primary-source research. The four
changed implementations receive detailed equivalence, integration, mutation and timing checks.
Unchanged families have not thereby been requalified. A keyword hit never means “audited correct.”

No universal “best algorithm” exists independently of workload, correctness and resource limits.
The adoption rule here is exact outcome preservation first, then measured cost and a stated memory
bound. Algorithm age or a company's name alone is not an adoption criterion. No external source
code, model, package or new dependency was copied or installed.

## Family-by-family decisions

“Retain” below is a scoped change decision, not a new product-reliability claim. “Investigate” is
Target and identifies the next falsifiable experiment. File/function locations are in the inventory.

| # | Family and inspected implementation | Decision and research consequence |
|---|---|---|
| 1 | Unicode/camel-case tokenization and term counts, `memory/bm25.ts` | Retain scripts, digits, whole identifiers, components, stopwords and query-term deduplication. Tokenization changes require multilingual/identifier relevance fixtures. |
| 2 | BM25 scoring and query traversal, `memory/bm25.ts` | **Replace document scans with inverted postings.** Preserve K1=1.2, B=.75, positive IDF, scores, stable ties, empty documents and rebuild semantics. Stanford IR and Lucene support the data structure; they do not prove Bimax relevance. |
| 3 | SQLite FTS5 lexical search, `memory/sqlite.code.store.ts` | Retain FTS5's native inverted index and BM25 ordering. Do not layer a second lexical index over SQLite. FTS5 runtime qualification still matters. |
| 4 | Dense exact scans and int8 dequantization, `memory/{vector.store,sqlite.code.store}.ts` | **Replace full score sorting with bounded stable top-k heaps.** Keep exact dot products, space IDs, quantization and filters. HNSW/DiskANN remain experiments requiring recall, update/delete, filtering, peak-RSS and disk measurements. |
| 5 | Weighted reciprocal rank fusion, `memory/fusion.ts` | Retain rank fusion and existing weights/window. Elastic documents RRF as a current hybrid-search technique. Changing weights requires a relevance ablation, not a CPU benchmark. |
| 6 | Remote and local cross-encoder reranking, `memory/{rerank,local.rerank}.ts` | Retain guarded rerank fusion and independent degradation. Evaluate model choice, ONNX cost and top-k quality separately; installing a larger model is not an algorithm proof. |
| 7 | Symbol/prose chunking and contextual headers, `memory/{chunking,code.index}.ts` | Retain current chunk boundaries and headers. Investigate chunk-size/header ablations with exact-source recall and token cost. |
| 8 | Near-duplicate detection, `memory/vector.store.ts` | Retain cosine plus lexical Jaccard corroboration. Approximate hashing/LSH must first prove no additional destructive merges. |
| 9 | Retrieval sufficiency, stems, fact/corpus selection, `memory/{sufficiency,facts,corpus,recall}.ts` | Retain abstention and exact evidence. Investigate false sufficiency and conflicting memories using independent expected facts; no larger prompt can substitute for this proof. |
| 10 | Visual retrieval and ColQwen sidecar, `memory/{visual.retrieval,colqwen.sidecar}.ts` | Retain component boundary. Neural late interaction, model loading and memory budget need separate document fixtures and provider/model qualification. No CU changes. |
| 11 | Graph adjacency, traversal and blast radius, `graph/{graph.store,impact.engine}.ts` | Retain indexed incoming/outgoing adjacency, visited sets and bounded BFS/DFS. Front-removal queues and all-path enumeration are investigation targets for wide/cyclic graphs; do not substitute shortest-path algorithms for an all-path API. |
| 12 | PageRank repository outlines, `graph/pagerank.ts` | Retain dangling-mass redistribution, graph cache and deterministic budgets. Google’s original paper supports PageRank, not a claim that this outline is optimal. Personalized PageRank and revision-token cache invalidation require retrieval/stale-graph fixtures. |
| 13 | Incremental AST/symbol analysis, `graph/{indexer,static.analyzer}.ts`, `memory/code.index.ts` | Retain TypeScript/Tree-sitter parsing and content-identity-driven updates. Investigate actual unchanged-file reparse/re-embed counts before adopting incremental databases or parallel indexing. |
| 14 | Context planning and admission, `graph/context.planner.ts`, `tools/implementations/composer.tool.ts` | Retain dependencies, relevance priorities and token gates. Knapsack/MMR variants require grounded-answer and citation recall, stable-prefix cost and latency comparisons. Long-context research argues for measuring placement, not increasing the window blindly. |
| 15 | Compaction and continuation, `memory/context.manager.ts`, `context/{continuation,request.budget}.ts` | Retain whole-request accounting, loss ordering, bounded restoration and evidence continuity. Investigate summary-loss fixtures and repeated tokenization work; semantic compaction changes need live-model journeys. |
| 16 | File dedup/restoration LRU, `memory/file-state-cache.ts` | **Replace a separate filtered order array with access-ordered Map storage.** Preserve every eviction/restoration decision. W-TinyLFU is a future trace-replay candidate; no cache hit-rate improvement is claimed. |
| 17 | Other caches, `memory/vector.store.ts`, `graph/pagerank.ts`, provider/catalog modules | Retain explicit identity, expiry and ownership. Investigate stale invalidation, resident budgets and scan pollution per cache. One global TinyLFU policy is not automatically suitable for all caches. |
| 18 | Retry/backoff and classification, `core/circuit-breaker.ts`, `credits/api.key.manager.ts` | Retain existing full jitter where implemented, retry classification and no uncertain write replay. AWS supports bounded jitter/idempotency; it does not establish that every Bimax retry site has the same policy. Per-site retry-budget/load tests remain Target. |
| 19 | Circuit-breaker finite-state policy and sliding samples, `core/circuit-breaker.ts` | **Replace array-front removal with exact circular storage and subtract-on-evict.** Retain Closed/Open/HalfOpen, probe leases, minimum samples, 10,000-sample cap and exact timestamps. Resilience4j's bucketed time window is not copied: rounding would alter Bimax's boundary. |
| 20 | Hedging, absolute deadlines and stream cancellation, `core/{hedged.request,chat.stream.reader,llm.adapter}.ts` | Retain records 85–87's shared deadline, prompt winner, Stop fences and neutral cancellation health. Hedging is for reads with bounded duplication; no blanket backup requests or replay. |
| 21 | Credential selection and load statistics, `credits/api.key.manager.ts` | Retain health/cooldown, headroom and latency estimates. Compare load-aware alternatives using offered/accepted/completed requests and fairness before adding AIMD/Gradient2. |
| 22 | CPU capacity and file ownership, `core/{subagent.capacity,file.claims}.ts` | Retain cross-process leases, exclusive lock, expiry and fail-closed scope. CPU workers and Bimax Thread memory caps remain distinct. Replacing local leases with distributed infrastructure has no demonstrated laptop benefit. |
| 23 | Model-order tool scheduling, `core/tool.schedule.ts` | Retain bounded parallel read batches, exclusive barriers, ordered results and sibling draining. Work stealing must preserve write/read order and cancellation ownership. |
| 24 | Dependency/conflict scheduling, `outcome/adaptive.scheduler.ts` | Retain critical-path priorities and mutation-scope conflicts. Investigate cycle validation, starvation and actual saved wall time. Existing estimated parallel savings are not measured speedup. |
| 25 | Host restart/load policy and memory admission, `app/src/main/supervisor/policy.ts`, `thread.budget.ts` | Retain bounded restart backoff and explicit memory budget. Netflix delay-based concurrency is researched, but no calibrated request-latency feedback exists here to justify replacing resource caps. |
| 26 | Latency statistics, `telemetry/telemetry.ts` | Retain bounded Algorithm-R reservoir and sampled percentile readout. DDSketch is a candidate for mergeable relative-error quantiles; it needs tail-error/overhead/merge tests and an actual requirement. A sampled p95 is not an exact full-stream p95. |
| 27 | Bayesian reliability and confidence, `mind/{stats,self.model,user.model}.ts` | Retain Beta posteriors, incomplete-beta evaluation, Lanczos and Wilson interval primitives. SciPy is a reference for numerical cross-checks, not an added runtime dependency. Extreme-tail numerical tests remain a separate investigation. |
| 28 | Calibration and learning policy, `mind/{stats,epistemic.ledger,trace.miner,policy.arms}.ts` | Retain PAV isotonic calibration, ECE and explicit policy/holdout reporting. PAV's splice-based implementation could become a stack for large inputs; current decile curves provide no measured need. No unsupported bandit/safe-exploration claim. |
| 29 | Local exemplar/habit similarity, `mind/{embedder,exemplar.store,habit.compiler}.ts` | Retain signed feature hashing, n-grams, normalization and honest lexical labeling. Neural embeddings and approximate nearest neighbours need quality/space compatibility tests. Full sorts in other small top-k consumers remain investigation targets. |
| 30 | Append journals, checkpoints and transactions, `core/{execution.ledger,transaction.manager}.ts`, `tools/thread.journal.ts` | Retain explicit operation identity, write-ahead evidence, atomic publication and undo checks. SQLite atomic-commit/WAL docs inform durability; file rename alone does not prove power-loss durability. Crash/fault end states remain required. |
| 31 | Event routing, queued protocol and MCP ownership, `protocol/queued.host.ts`, `mcp/connection.manager.ts` | Retain generation/owner fencing, coalesced discovery and bounded request lifetime from records 85–87. No distributed message broker or consensus protocol is justified for this in-process/local ownership problem. |
| 32 | Stream/output retention and subprocess supervision, `core/shell.tasks.ts`, `context/output.archive.ts`, `mcp/stderr.ts` | Retain bounded bytes, backpressure and owned cancellation. Node's stream thresholds are not hard universal memory limits; measure actual retained output and child cleanup. |
| 33 | Secret detection, hashing and egress, `security/{secret.scan,egress.perimeter}.ts` | Retain pinned rules, entropy corroboration, span merging and approved ownership. SHA-256/HMAC are standard primitives, not candidates for a custom replacement. Multi-pattern automata need regex-compatibility and leak/false-positive fixtures first. |
| 34 | Filesystem/shell/governor policy, `governor/{fs.veto,bash.analyzer,budget.veto}.ts` | Retain canonical paths, parser/policy decisions and truthful spend accounting. Investigate race windows and cross-engine reservations separately. Faster admission must never widen authority. |
| 35 | Document/OCR admission and bounded extraction, `documents/` | Retain content-signature checks, bounded dimensions/pages/children and honest extraction outcomes. GPU/OCR portfolios need real document accuracy and sustained hardware measurements. No native CU implementation touched. |
| 36 | Durable scheduling, tool routing and task classification, `app/src/main/{schedules,schedule.runner}.ts`, `task/`, `tools/` | Retain persisted schedule/task identity, bounded execution and explicit routing. Scheduling semantics and replay truth need fixtures; generic heuristic classification is not a learned optimizer. |
| 37 | Build/package/artifact selection, `scripts/`, `app/scripts/` | Retain deterministic metadata, exact paths/digests and release-artifact checks. More caching requires content identity and invalidation proof; packaging and installed state remain separate. |
| 38 | UI/native-CU/vendor code | Inventory navigation only where first-party; no semantic qualification or implementation/design change. Vendored upstream source is excluded and retained byte-for-byte. |

## Primary research, checked 2026-10-12

The [research index](evidence/2026-10-12-algorithm-upgrade/research.json) records the URLs,
applicability and decision. These are first-party project documentation, original research or
standards; aggregator articles and competitor code were not used as implementation specifications.

- [Stanford: inverted indexes](https://nlp.stanford.edu/IR-book/html/htmledition/an-example-information-retrieval-problem-1.html),
  [Lucene TopScoreDocCollector](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/search/TopScoreDocCollector.html),
  [Lucene PriorityQueue](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/util/PriorityQueue.html),
  [SQLite FTS5](https://sqlite.org/fts5.html).
- [Elastic ranking](https://www.elastic.co/docs/solutions/search/ranking),
  [RRF](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion),
  [HNSW original paper](https://arxiv.org/abs/1603.09320),
  [Microsoft DiskANN](https://github.com/microsoft/DiskANN).
- [Resilience4j windows](https://resilience4j.readme.io/docs/circuitbreaker),
  [Amazon timeouts/retries/jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/),
  [Google overload control](https://sre.google/sre-book/handling-overload/),
  [Netflix concurrency limits](https://github.com/Netflix/concurrency-limits).
- [Caffeine W-TinyLFU and trace evaluation](https://github.com/ben-manes/caffeine/wiki/Efficiency),
  [Oracle access-ordered LinkedHashMap](https://docs.oracle.com/en/java/javase/24/docs/api/java.base/java/util/LinkedHashMap.html),
  [ECMAScript Map contract](https://tc39.es/ecma262/multipage/keyed-collections.html#sec-map-objects),
  [V8 adaptive stable sorting](https://v8.dev/blog/array-sort).
- [Datadog DDSketch](https://www.datadoghq.com/blog/engineering/computing-accurate-percentiles-with-ddsketch/),
  [Google's original search/PageRank paper](https://research.google/pubs/the-anatomy-of-a-large-scale-hypertextual-web-search-engine/),
  [SciPy incomplete beta](https://docs.scipy.org/doc/scipy/reference/generated/scipy.special.betainc.html),
  [scikit-learn isotonic regression](https://scikit-learn.org/stable/modules/isotonic.html).
- [TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API),
  [Tree-sitter](https://tree-sitter.github.io/tree-sitter/),
  [Lost in the Middle](https://arxiv.org/abs/2307.03172),
  [Node stream buffering](https://nodejs.org/api/stream.html#buffering).
- [SQLite atomic commit](https://sqlite.org/atomiccommit.html),
  [SQLite WAL](https://www.sqlite.org/wal.html),
  [HMAC standard](https://www.rfc-editor.org/rfc/rfc2104).

These sources support algorithm mechanics and tradeoffs, not a claim that the new Bimax code is
used by those companies. The Caffeine page's historical patent discussion is not a current legal
conclusion and is not used to decide adoption. Unavailable TypeScript handbook/NIST PDF fetches
were excluded; the TypeScript project's own wiki was inspected instead.

## Four implementation contracts

1. **Inverted BM25.** A posting stores corpus ordinal and term frequency, so duplicate public IDs
   remain distinct. Postings lengths supply document frequency. Query-term order keeps each
   floating-point sum identical to the full scan. A single matching term needs no accumulator;
   multi-term queries use a zeroed Float64Array and only sort matched ordinals. Rebuild removes
   all old postings. Both ranking formula and external API remain unchanged. Index build remains
   O(total tokens); multi-term queries additionally allocate/zero eight bytes per corpus document.
   This is not a claim of sublinear work for a ubiquitous query or of incremental indexing.
2. **Exact dense top-k.** `BoundedTopK` retains the best `depth` candidates in a worst-first binary
   heap with input ordinal as the final stable tie-break. Both stores apply eligibility before
   admission; the JSON store preserves retrieval-recency ties, SQLite preserves ID ties and its
   absolute/relative score floors. Vector-space checks, exact dot products, RRF depth, reranking
   and document collapse are unchanged. Scoring is still O(Nd); selection is O(N log k), followed
   by O(k log k) output sorting and O(k) retained score candidates. Overall store metadata is still
   corpus-sized. Infinity intentionally preserves the pre-existing unbounded-depth API behavior.
3. **Circular breaker.** At most 10,000 exact-timestamp samples, lazy array growth, incrementally
   maintained failures and head/count fields. Dropping one sample is constant work; expiring many
   samples is amortized constant work per sample, with a worst-case O(window size) expiry burst.
   Eviction clears references. Strict `< cutoff` preserves samples exactly on the boundary. Empty
   windows reset the head; half-open success clears the ring. Policy/provenance remain intact.
4. **Access-ordered cache.** Delete/reinsert promotes the existing Map entry. Oldest-key eviction
   and reverse Map traversal replace array filtering/shifting. Age, stat stamp, whole-file hash,
   path/range identity, model release, third-hit stub and five-file restoration order are retained.
   This uses the runtime's Map performance; ECMAScript promises average sublinear access, not a
   universal worst-case constant bound. Cache capacity and hit policy remain the same.

## Measurements and adoption tradeoffs

The [benchmark runner](evidence/2026-10-12-algorithm-upgrade/benchmark.cjs) runs the frozen actual
first-party baseline against the candidate and asserts equal public output before timing. Four
warmups, eleven paired repetitions, alternating AB/BA order, explicit GC before each timed side,
zero discarded timings. Inputs include 100/1k/10k documents; 100/1k/10k/100k scores; random,
ascending, descending and tied score orders; and low-volume/overflow breaker/cache cases. The
[raw final results](evidence/2026-10-12-algorithm-upgrade/benchmark.json) include p50/p95, every
sample, machine/runtime and output checksum. No tests or builds overlapped those timings.

[Initial Map-accumulator results](evidence/2026-10-12-algorithm-upgrade/benchmark.initial.json)
and [intermediate dense-accumulator results](evidence/2026-10-12-algorithm-upgrade/benchmark.accumulator.json)
are retained. Common-term regression prompted the final direct single-term path. None of the
stages is silently presented as an independent repeat of the final implementation.

The generated [measurement table](evidence/2026-10-12-algorithm-upgrade/measurements.md) includes
all final cases and regressions. At 10,000 documents the sparse two-identifier query improves from
0.4662 to 0.1648 ms p50 (2.83×); an absent term improves from 0.5137 to 0.0157 ms. Common terms are
slightly slower (1.4777 to 1.5579 ms), and rebuilding is 23.8782 to 24.6348 ms. The inverted index
is adopted for selective queries with exact ranking, accepting the reported common/build cost.

Heaps reduce retained score candidates from N to 64 in the k=64 fixtures and improve random/tied
large-input selection. They lose to the engine's adaptive full sort on already ascending scores
and some small inputs. Adoption prioritizes bounded retained scores for both stores; it is not a
universal speedup. V8 documents adaptive runs in its stable sort, consistent with the observation.
An adaptive selector may be investigated only if it retains the memory bound and exact ordering.

These are component timings on this development Mac, not installed retrieval/task latency,
provider billing, peak application RSS, energy, thermal, recall improvement or a competitor result.
Sub-millisecond cases are particularly sensitive to runtime/GC noise. There is no model route in
this offline experiment. Hard operation counts and exact-state comparisons carry stronger claims
than tiny timing differences.

## Verification and remaining qualification

See [verification receipt](evidence/2026-10-12-algorithm-upgrade/verification.json), focused/full
logs, source hashes, dirty-file comparison and [mutations](evidence/2026-10-12-algorithm-upgrade/mutations.json).

New tests compare against frozen pre-change public APIs, including Unicode, repetition, empty
corpora, rebuilds, duplicate IDs and exact score bits; stable heap selection and a comparison-count
bound; breaker wraps/expiry/capacity/boundaries; and cache touch/overwrite/invalidation/restoration.
Real JSON and SQLite retrieval fixtures exceed depth and independently assert final ordered IDs,
pre-depth scope, exclusion, recency/ID ties, foreign spaces and the relative dense floor.

Twelve deliberately broken source variants must fail assertions; exact bytes are restored and the
clean focused Jest/Bun baselines rerun. The initial campaign refused to count a head-advance fault
that crashed without an explicit no-throw matcher. The public valid-input/no-throw assertion was
added; both the initial receipt and final assertion-caught campaign are retained. A crash/tool
invocation alone is not promoted to semantic proof.

The required product-reset guidance was README; current repo audit (01); target architecture (05);
repo topology/runbook (06); acceptance (08); Mac Buddy vision and V03/V27B research cards in 12;
competitive README, rival studies (02), model-independent strategy (04), gap register (05),
head-to-head rules (06), source ledger (08), and examples README. Current records 55/64 and 79–84
supersede historical split/CU-retirement statements; no product ownership changed.

`competitive/03_CAPABILITY_MATRIX.md`, `competitive/examples/P01_FAST_CODE_AND_COWORK.md` and
several named coding/retrieval journey files are absent in this checkout. Their references are
not proof of an executable contract. Applicable C01 dirty-repo preservation, C04 recovery, R01
provider truth and R02 retrieval intent remain qualification targets; no full installed journey is
claimed here. Acceptance 08's exact-state/mutant rules govern this local slice. Existing global
lint debt is reported separately; no test was deleted, loosened or skipped to obtain a pass.

Next priorities are exhaustive manual semantic review of the inventory, realistic retrieval/trace
and sustained-memory measurements, filtered ANN recall/RSS trials only if exact scans become the
measured bottleneck, stale graph/cache revision tests, and installed coding/recovery journeys.
CU and UI implementation remain outside the authorized scope.
