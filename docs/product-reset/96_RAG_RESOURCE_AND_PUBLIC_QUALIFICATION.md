# RAG resource fixes and public qualification — 2026-10-14

Status: resource changes **Implemented and Measured locally**. Public retrieval qualification completed the owner's fixed 200-question subset. NVIDIA gpt-oss-20b timed out; the owner authorized checking another configured model, Nemotron 3.5 Lightning, for answering/judging. Its completed results and limitations are recorded below. This does not qualify a full benchmark, installed journey, Product-ready release or competitive Win.

## Guidance and scope

Read the current product-reset README, current repo audit, target architecture and split history; the Mac Buddy vision and V03/V27B performance/retrieval playbook; competitive status/evaluation definitions, R02 and acceptance gates before this work. The exact guiding files are `README.md`, `01_CURRENT_REPO_AUDIT.md`, `05_TARGET_ARCHITECTURE.md`, `06_REPO_SPLIT_RUNBOOK.md`, `08_ACCEPTANCE_GATES.md`, `vision/BIMAX_MAC_BUDDY_PRODUCT_VISION.md`, `12_ALL_VISION_SECTIONS_RESEARCH_PLAYBOOK.md`, `competitive/README.md`, `competitive/06_HEAD_TO_HEAD_EVALS.md` and `competitive/examples/R02_RETRIEVAL_TRUTH.md`. Current ownership records 55/64/79–84 supersede historical split/CU plans. The change is in shared memory retrieval. No Computer Use, native permissions, UI, installed app, provider settings, credentials, dependencies or release action is changed.

The owner's request was to remove record 95's small dense-search and retained-heap costs and measure the previously unmeasured model/public quality. They explicitly selected the configured NVIDIA gpt-oss-20b for both answering and judging, and a stratified **200 questions** rather than 2,500 full-suite questions. After repeated NVIDIA timeouts, the owner explicitly authorized another configured model after an availability check. The selected alternate is `nvidia/nemotron-3.5-lightning-30b-a3b`; this changes benchmark model settings only. No broader benchmark claim follows from that selection.

All evidence is under [the immutable-attempt evidence directory](evidence/2026-10-14-rag-qualification/). Starting dirty files are hashed in `dirty-before.json`; record-95 source/docs/scripts are frozen in `baseline/`, and pre-95 retrieval source is in `legacy/`. Previous records and raw evidence remain intact. This is an uncommitted working-tree change; no push is implied.

## Production change and preserved behavior

`src/memory/vector.store.ts` stores chunk owners as mixed-radix integer positions into existing arrays instead of allocating a retained `{doc, chunk}` wrapper per chunk. A safe-integer overflow uses a tuple fallback. Position zero, document-count changes and duplicate chunk IDs preserve the old lookup: first matching chunk in the last owning document. Rebuilding the lexical index also rebuilds positional addresses.

Retrieval still constructs the same primary chunk rankings. If that pool already contains enough eligible documents, it avoids building the unused document-diversity pool. Reranking only reorders primary candidates, so the eligible document count and lexical floor are invariant. When backfill is needed, a document's champion already present in global dense top-k is reused; only missing document champions are rescored. Cross-document duplicate IDs disable that reuse to preserve historical owner semantics. Dense candidates capture owner recency while scoring under the existing synchronous store lock, avoiding repeated owner lookups in heap comparisons.

The winning prefix, ranking constants, default recall limit and 1,800-character prompt budget, scope/floor, reranker request size and source provenance remain unchanged. `recall.ts` is byte-identical to record 95. This change reduces work and retained lookup containers; it introduces no new approximate-search algorithm or quality policy.

## Paired local resource measurements

Measured on Apple M3, eight cores, 8 GiB, macOS arm64, Node 22.13.1 and Bun 1.3.14; Python 3.13 uses existing requests/dotenv/pyarrow packages. No dependencies were installed. These local resources do not describe NVIDIA serving hardware.

The final measurement protocol uses 1,000 warmup calls per version and input shape, followed by two alternating ABBA runs with nine groups each. All **36 normalized samples per version/shape** are pooled, with zero qualified discards. The legacy comparison is measured against pre-95 source inside the same run, rather than multiplying ratios from different experiments. Exact ordered IDs, passages and prompt bytes are checked. See `timings-warm-a.json`, `timings-warm-b.json` and `measurements-qualified.json` for every sample and batch p95.

| Warm local fixture | Record 95 ms | Current ms | Time reduction |
| --- | ---: | ---: | ---: |
| Dense control, 50 documents | 0.037078 | 0.029899 | **19.36% (1.24×)** |
| Dense crowding, 50 chunks | 0.051474 | 0.037158 | **27.81% (1.39×)** |
| Dense crowding, 500 chunks | 0.149803 | 0.106878 | **28.65% (1.40×)** |
| Negative vocabulary, 500 documents | 0.028566 | 0.025970 | 9.09% |
| Scoped negative vocabulary, 500 documents | 0.018810 | 0.017400 | 7.49% |
| Long-document search, 100 chunks | 0.025343 | 0.024418 | 3.65% |
| Sparse search, 50 documents | 0.013899 | 0.013526 | 2.68% |
| Sparse search, 500 documents | 0.013707 | 0.013449 | 1.88% |
| Full recall, 500-document vocabulary fixture | 0.054214 | 0.053457 | 1.39% |
| Scoped negative vocabulary, 50 documents | 0.001262 | 0.001191 | 5.60% |
| Negative vocabulary, 50 documents | 0.003609 | 0.005206 | **−44.27%**, +1.60 µs |
| Long-document search, 10,000 chunks | 0.022479 | 0.022836 | **−1.59%**, +0.36 µs |
| Sparse search, 10,000 documents | 0.013110 | 0.013725 | **−4.69%**, +0.62 µs |

The same dense control against pre-95 source measures **0.035988 → 0.029264 ms, 18.68% less time (1.23×)**. This resolves the reported 4.7% dense-control cost on this fixture. Remaining microsecond regressions are retained above; no broad all-input speedup is claimed. In particular, vocabulary logic did not change in this round and its small-control timing regression is not silently discarded as noise.

The heap measurement uses **five fresh production-JavaScript child processes per version**. TypeScript compilation occurs in the parent and is excluded from measured children. Each child warms dependencies with a small corpus, clears its timer/state, forces GC outside production, and loads/searches the same 10,000-chunk fixture before retained-heap observation. All 15 samples, RSS and peak RSS are preserved; this is retained JS heap growth, not installed RSS or energy.

| Version | Median retained heap growth |
| --- | ---: |
| Pre-95 | 3.3691 MiB |
| Record 95 | 3.7222 MiB |
| Current | **3.3326 MiB** |

Current growth is **0.3896 MiB / 10.47% lower than record 95** and 0.0365 MiB below pre-95 in this paired setup. The record-95 retained-container cost is removed. These absolute values use the improved production-JS measurement setup; do not compare them directly to old compiler-loaded absolute values.

Generated quality controls remain identical between record 95 and current: 24 ordinary plus 24 crowding cases per version retain full required-source/prompt-fact coverage, valid budgets/provenance and zero scope violations. These are regression controls, not public answer-quality scores. Record 95's 33.3% → 100% crowding gain is historical; this round preserves it.

## Public qualification protocol

The selection was fixed before model inference by `scripts/prepare-rag-qualification.py`: balanced round-robin strata with SHA-256 ordering and seed `bimax-rag-qualification-2026-10-14-v1`. Selection uses IDs, question types and source families, never answers or retrieval output. Seven LongMemEval strata include abstention separately; six MemoryAgentBench source families are balanced. The resulting distribution deliberately differs from natural dataset proportions, so its overall accuracy estimates this selected qualification set, not the full benchmark population.

- **100/500 classic LongMemEval_S cleaned questions**, HF revision `98d7416c24c778c2fee6e6f3006e7a073259d48f`. Full histories are indexed with dates and roles; answer labels and `has_answer` annotations are removed from ingestion. This is not LongMemEval-V2.
- **100/2,000 MemoryAgentBench Accurate_Retrieval questions**, HF revision `7ea066982b140a19337e17e60d45d4076e042faf`. Whole provided contexts become 4,096-character prose notes and undergo production chunking. Other MemoryAgentBench competencies are out of scope. Oracle evidence-session metadata never enters the index.
- Real preinstalled **Ollama all-minilm:latest**, 384-dimensional embeddings, with digest recorded per corpus; no synthetic vectors. Each batch is probed with truncation disabled; only a context-length error enables explicit provider prefix truncation, recorded with affected-input bounds. Source text remains whole for lexical search and prompts. No reranker. These backend choices differ from published reference systems.
- A real local embedding control has paraphrase cosine **0.8412**, unrelated cosine **0.1563**, margin **0.6849** against a declared 0.05 floor; vectors are finite/nonzero and 384-dimensional. This single semantic control is not broad retrieval or answer-quality proof.
- Production `VectorStore` and `recallForTurn`, default limit three and maximum 1,800 characters. Baseline/current indexes share identical public corpus embeddings and query vectors; ordered source IDs and prompt text must match. They share the reader response for identical input, so no independent accuracy improvement is inferred.
- Initially configured NVIDIA `openai/gpt-oss-20b`, then owner-authorized configured `nvidia/nemotron-3.5-lightning-30b-a3b` for reader and judge. The qualified alternate profile uses temperature zero, thinking enabled with a 1,024-token reasoning budget, and a 2,048-token completion cap. One readonly configured key is bounded to 40 requests/minute. Model/provider differences prevent direct reference-leaderboard comparison.
- The licensed official LongMemEval task-specific prompt function supplies grading semantics, including partial-answer rejection, preference rubrics, temporal off-by-one tolerance and abstention. The wrapper explicitly requires the answer to match the requested entity; an off-target gold string cannot qualify. Strict response checks reject non-200, provider error, empty/truncated/unfinished completions and ambiguous verdicts. Independent exact/paraphrase/wrong/partial/wrong-target/temporal/update/abstention/injection controls must pass before scores are accepted.
- When valid model completions exist, supplementary normalized exact match and token F1 are reported. MemoryAgentBench's judge score is a custom qualification metric, **not its official leaderboard metric**. Same-model self-judging remains a limitation; controls cannot remove correlated model errors.
- Every request attempt, response, usage, latency and failure is retained with credentials redacted. Invalid runs do not become wrong answers or silently disappear from denominators. Dataset file hashes, selection, reader/judge settings and corpus provenance support reproduction. The 277-MB public dataset was downloaded to a temporary cache outside the repository; that cache was cleared by the shutdown. Saved retrieval inputs support the completed reader/judge run.

Public retrieval observations are recorded separately from model answers. NVIDIA gpt-oss-20b preflight timeouts prevented its hosted answer qualification. The alternate-model profile must pass all independent controls before selected-question inference; no score is accepted from an incomplete denominator. The adapter records all provider truncation, and source-span containment allows whitespace changes made by production chunk assembly while retaining exact source IDs/hashes and exactly shown text.

A fresh shape audit found three selected classic histories with repeated session IDs and distinct dated content. They receive unique occurrence IDs, with benchmark session aliases kept outside embeddings for scoring. Array lengths and string messages are checked; all dated passages are retained, and gold labels/`has_answer` never enter ingestion. None of these duplicated IDs is an answer-session label. The first retrieval run remains raw evidence; the corrected run reused only unchanged corpus inputs with identical selection, production/compiled/worker hashes and exact input SHA-256, rerunning the three changed histories. Reuse provenance preserves original observations and timestamps. This fixes input identity rather than tuning retrieval on answers.

## Completed public retrieval observations

`public-retrieval-qualified.json` audits **200/200** valid questions over 121 corpora, 11,290 documents and 90,648 real embedded chunks. All 200 baseline/current prompts and ordered IDs match; all source hashes/shown spans pass provenance checks. Dense search is active on 200/200; reranking is active on 0/200.

For the 85 answerable classic LongMemEval questions (15 abstentions excluded), source Recall@3 is **94.06%**, MRR@3 **0.9333**, precision@3 **50.59%**, and all required sessions are returned in **74/85 (87.06%)**. Per-stratum source recall is 93.33% knowledge update, 91.07% multi-session, 100% assistant/preference/user single-session, and 80% temporal reasoning. These are session-source retrieval metrics, not model-answer correctness. Both production versions have the same observations.

Literal gold text appears in 36/71 eligible classic prompts and 20/98 eligible MemoryAgentBench prompts. Abstentions and preference rubrics are excluded from those denominators. Literal containment misses paraphrases, inference and semantic evidence, especially EventQA, so these counts are diagnostic proxies, never answer accuracy or official benchmark scores. MemoryAgentBench has no session-source Recall@3 here because its whole-context fixture does not supply equivalent gold document IDs.

Observed current recall latency is 6.50 ms median / 18.19 ms p95; query embedding is 402.95 / 1,162.66 ms. These are shared-machine observations without a paired public speed claim. Recall's 1,800-character excerpt budget adds a fixed header: observed full prompt text is 1,912 characters median / 1,914 p95.

Of 1,486 passage embedding batches, 1,467 required explicit provider truncation. This is **not a per-chunk truncation rate**: affected-input bounds are 1,467–90,316; exactly 14 query embeddings required truncation. Whole source text remains available to lexical search and prompt extraction. This small embedding-window limit remains a material qualification constraint.

The corrected run reuses 197 identical input observations with preserved hashes/timestamps and reruns the three ID-repaired histories. Raw run 1 includes an earlier source-recall aggregate containing abstentions; it is retained as diagnostic evidence and superseded by the audited 85-answerable-question denominator above.

## Completed model-answer qualification

The final `public-answer-nemotron-4` run completes **200/200 valid questions**, with no invalid question excluded from the denominator. `public-answer-qualified.json` independently verifies all 200 raw reader prompts/predictions and judge verdicts against the saved records, recalculates answer metrics/counts, and checks every frozen production/evaluator/dependency hash. The selected model is **NVIDIA Nemotron 3.5 Lightning 30B A3B**, for both reader and judge, under the profile above. gpt-oss-20b has no qualified selected-question answer score; its failures remain separate.

| Fixed subset | Judged correct | Judged accuracy | Normalized exact match | Token F1 |
| --- | ---: | ---: | ---: | ---: |
| Classic LongMemEval_S, 100 questions | **40/100** | **40.00%** | 3.00% | 14.76% |
| MemoryAgentBench Accurate_Retrieval, 100 questions | **39/100** | **39.00%** | 22.00% | 35.25% |

LongMemEval uses the preserved official task-specific rubric plus the declared wrapper and alternate judge; exact match/F1 are supplementary diagnostics, particularly unsuitable for preference rubrics or semantically correct abstention. Its nominal Wilson 95% interval is 30.94–49.80%. MemoryAgentBench's 39% judge score is a **custom qualification metric**, with nominal interval 30.02–48.80%. Its EM/F1 above use preserved upstream helpers and family postprocessing; substring exact match is **37.00%**. ROUGE and the complete official evaluator are not run, and none of these numbers is an official leaderboard result. The generic harness F1 is 35.40%; the upstream-function F1 is 35.25%, reflecting the upstream special-answer and parsing rules. Both are retained with their definitions.

| Classic stratum | Correct / selected |
| --- | ---: |
| Abstention | 14/15 |
| Knowledge update | 3/15 |
| Multi-session | 2/14 |
| Single-session assistant | 12/14 |
| Single-session preference | 2/14 |
| Single-session user | 6/14 |
| Temporal reasoning | 1/14 |

Answerable LongMemEval accuracy is **26/85 (30.59%)**, distinct from the overall 40% that includes abstention. The source-session Recall@3 of 94.06% therefore does **not** establish sufficient extracted evidence or strong answers. The limited prompt span and small embedding window are measured constraints, but this run cannot causally separate extraction, ranking, truncation, reader or judge errors. Multi-session, preference, knowledge-update and temporal answers require further qualification. No production policy was tuned on these results. Record-95/current prompts are identical for all 200 cases, so they share the same model response and there is **no measured answer-quality improvement in this round**.

MemoryAgentBench family judged counts are EventQA 131072 **7/17**, EventQA 65536 **9/17**, EventQA full **4/17**, longmemeval_s* **3/17**, RULER QA1 **9/16** and QA2 **7/16**. The upstream all-elements EventQA recall values are 41.18%, 52.94% and 23.53%, respectively. Shared source contexts and balanced families limit population inference.

Accepted reader completions take **11.51 seconds median / 24.88 seconds p95**; accepted judge completions take **8.30 / 19.35 seconds**. These times exclude earlier retries and queue pacing. The final answer/control run takes **1,371.94 seconds (22.87 minutes)**, including 17 initial controls, retries and pacing, and excluding earlier retrieval work and failed pilots. It retains **431 requests: 211 reader and 220 judge attempts**, including **14 invalid completion attempts**, followed by valid completions for every question. Invalid attempts include truncated/ambiguous responses; they are not benchmark wrong answers. Attempt-level distributions remain in the audited JSON.

Reported usage for this final run, including initial controls and failed attempts with reported usage, is **213,082 prompt tokens + 358,757 completion tokens = 571,839 total tokens**. Completion details report **336,480 reasoning tokens**, already included in completion tokens. Currency cost is unavailable from the configured endpoint and is not inferred. Additional independent rubric controls have their own raw requests/results and usage rather than being silently included in these totals. Same-model self-judging remains a material limitation even with passing controls.

After the main workers finish, **five additional rubric controls pass**, using the same frozen model/settings/grading functions: preference positive, preference partial-positive under the official permissive rubric, preference negative, all-elements positive and partial-elements rejection. These independent inputs were declared before main-run completion and contain no selected benchmark examples; no labels or grading functions changed after scoring. Their five requests use 1,274 prompt + 2,919 completion = **4,193 total tokens**, with zero invalid attempts, recorded separately in `public-rubric-controls-1/`. Thus 17 pre-inference plus five additional controls pass, without establishing independent human agreement.

## Power-loss recovery and model qualification

The owner reported a power shutdown. All completed retrieval evidence and production changes survived; the temporary raw dataset cache was cleared. `power-recovery.json` validates all saved contexts and dependency/source hashes. Answering uses saved contexts, so no public download or embedding work needs repeating. The original Python 3.13 runtime is used explicitly after the reboot changed shell defaults to Python 3.14 and Node 24. Historical resource measurements retain Node 22 attribution; they are not rerun or compared across runtimes.

The configured alternate returned complete READY in 959 ms. Its non-thinking pilot failed abbreviation and temporal-tolerance controls. A 512-token thinking pilot passed 16/17: a concrete example in the wrapper reused the control's entity/value text and distracted the judge on a correct-target case. Removing the example exposed a second ambiguity: “exact entity” was interpreted as exact wording, rejecting an abbreviation. The wrapper now explicitly compares meaning while requiring the requested subject/relation. The official task-specific rubric, 17 control inputs and expected labels remain unchanged. A fresh 1,024-token thinking profile passes **17/17** before selected-question inference. All failed pilots remain evidence and do not count as benchmark answers.

Transport/control retries retain every valid verdict, including incorrect verdicts, and reuse only exact request bodies under the same model/grader configuration. Completed-question checkpoints survive interruption; a reader-only or in-flight case may require replay, with its earlier attempt retained. Selected-question resume retains correct **and incorrect** valid answers, verifying raw completions and saved prompts; only invalid or absent results are retried. This prevents choosing a better answer on a repeated request. Output directories and per-request attempt records are create-only.

## Verification and acceptance boundary

Seven new resource/position tests join fourteen record-95 RAG tests. The focused retrieval/context/persistence/code-search set passes **93 tests**; Node fixture grader passes eleven, and Python public response/metric controls initially pass four; the final six-test set also pins repeated-session preservation, label exclusion and reuse of incorrect verdicts rather than cherry-picking passing retries. Root build, app typecheck/build, engine build, lint (zero errors), three script tests, 63 context Bun tests and seven staged engine exchanges pass. These component/bundle checks do not establish an installed end-to-end journey.

`scripts/prove-rag-resources.py` injects **19 real source faults** spanning source backfill, dense/lexical champions, scope/floor/prefix, bounded reranking, rescans/vocabulary/recency, prompt reservation, retained wrappers, champion reuse, duplicate-owner ambiguity, positional width/zero and cached recency. Every final fault fails an assertion, not compilation/crash, exact source bytes are restored after each, and the restored suites exit zero. Raw `mutations-fixed-clock/` results retain restoration hashes.

The full offline gate is **not green**: Jest has 4,390 passing, two failing and 19 skipped tests; Bun has 132 passing and one failing test. Failures are the unchanged desktop raw-pairing-IPC guard, an external desktop-responder authentication-tag integration case, and native scanned-page OCR confidence (0.5 versus required >0.5, despite correct tag/measurement text). No guard or confidence threshold was weakened; no CU/responder source is changed. Frozen record-95 retrieval reproduces both Jest failures (52 other targeted tests pass); exact current source bytes are restored. The new resource suite has two assertion failures/five passes on that baseline and seven passes on current source. The unchanged version-4 context benchmark remains **43/43**.

Exploratory failures remain evidence: downloader resets and exact-range resumptions, underwarmed timing runs, compiler-loaded noisy heap attempts, a duplicate mutation-anchor abort, inferred-array compilation failures, an oversized diagnostic diff exhausting Node heap, and an unfrozen Date.now recency test, provider timeouts, a wrong-target judge false positive, whole-batch embedding context-limit errors and an overly literal whitespace provenance check in the benchmark adapter. These attempts do not count as qualified timings or mutation kills. The final heap excludes the compiler; final timing warms all variants equally; the recency fixture has explicit time and bounded diagnostics. Adapter smoke tests include a real 43-session/590-chunk public history, exact baseline/current prompts and valid source hashes/shown spans; containment permits production chunker whitespace changes. Failed judge preflights produce no public score. A preflight-only run was stopped to correct alternative-reference handling; another was stopped to repair adapter provenance before selected reader inference. All attempts remain evidence.

Model accuracy intervals, when reported, are nominal Wilson binomial intervals for this selected set. Balanced strata, shared contexts and same-model judging prevent treating them as calibrated full-population or cluster-adjusted confidence bounds.

Final preservation checks compare all 789 starting dirty files, permitting only this round's retrieval source and five research-document updates; previous records' internal evidence remains hash-identical. Global configuration and credential hashes are unchanged. `manifest.json` seals this round's raw evidence, scoped source/scripts and documents; `scoped.diff` compares the six updated starting files against frozen record 95. Credential scans report no matches without printing credential values. The source, acceptance boundary and benchmark reality are updated together in the README, gap register, build sequence, source ledger and R02 contract.

## Remaining Targets

Full 500/2,000-question suites, LongMemEval-V2, official/reference-model evaluation, independent judge/human adjudication, oracle/raw-history controls, representative heldout tuning and reranker qualification, installed full R02, sustained RSS/energy, clean-machine packaging, release and competitive head-to-head remain **Target**. Do not turn a local speed ratio or this balanced subset into a general product superiority claim.
