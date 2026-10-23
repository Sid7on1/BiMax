# Complete retrieval passages — 2026-10-14

Status: **Measured rejected prototype**. The owner-authorized fresh 25+25 pilot completes all 100 valid answer arms. LongMemEval improves, but MemoryAgentBench ties with three losses, failing the predeclared positive-gain-in-both rule. Production recall and the generated staging engine remain unchanged. No installed qualification, Product-ready status, release or Win is claimed.

## Guidance and decision

The product-reset README, repo/architecture boundary, full Mac Buddy vision, V03/V27B research cards, competitive status/model-independent strategy, head-to-head rules, R02 and acceptance gates guide this work. Current ownership records 55/64/79–84 supersede historical split/CU text. The referenced capability matrix remains absent. There is no CU/UI/native permission, OS setting, dependency, installed-app or global provider change.

Record 97’s complete fresh 100+100 qualification improved classic LongMemEval 43→64/100, but regressed MemoryAgentBench 51→45/100. Its positive-gain-in-both rule rejected the candidate. Source, proposed tests, all 400 valid answer arms, raw attempts and losses remain preserved; production and generated staging runtime were restored. The owner then authorized **50 fresh questions, 25 per dataset**, with care for the unstable eight-GiB Mac.

This experiment keeps its source in `evidence/2026-10-14-rag-passage/candidate/recall.ts`, outside production. The model runner checks that production still matches the frozen baseline at startup and completion. Only a qualifying result can justify adoption. Earlier scored questions are never reused to tune or qualify this revision.

## Independent source reproduction

Uniform fragment shares can clip a high-ranked passage even when it fits inside the source allowance. A constructed eligibility heading plus background and a final relational restriction demonstrates the failure: the heading survives, while the complete qualifying rule disappears. It uses invented initiatives and no public benchmark content. Two whole-passage cases fail against the archived record 97 implementation; ten existing local controls pass.

The revision retains a complete ranked passage when it fits **after reserving a useful minimum for later matches**. Oversized passages still use bounded fair excerpts. The existing long-line word window, actual source-date quotation, duplicate identity, scope, cancellation and three-source ranking remain. Default excerpt allowance is still 6000 versus baseline 1800 characters; this is a combined policy comparison, not an equal-budget public ablation or proof that one mechanism alone caused an answer gain.

Fourteen independent fixture cases pass. Eleven real source faults fail assertions: long-line head, source starvation, chunk starvation, uniform fragments, omitted later-match reservation, date omission, reversed duplicate identity, overclaimed spans, invented recency dates, unmatched tail and small default allowance. Each restores exact candidate bytes; production is never mutated by these faults.

Newly checked primary references: [LlamaIndex node parsers](https://developers.llamaindex.ai/python/framework/module_guides/loading/node_parsers/modules/) distinguish sentence boundaries, surrounding reader context and hierarchical context expansion. This supports investigating retained complete context; Bimax imports none of these implementations and does not claim to implement sentence-window embeddings or auto-merging retrieval. The production chunker and ranking remain unchanged. References describe mechanisms, not Bimax accuracy.

## Low-load preparation and execution

Pinned original datasets/revisions/licenses remain those of records 96–97. Their persistent full-file hashes are checked through one-MiB reads. Classic JSON is streamed one record at a time; Parquet uses one row per batch with threads disabled. Metadata/hash-only round-robin selection chooses 25 questions per dataset, excluding the union of **400 earlier IDs and 400 normalized question texts**. An independent audit confirms 50 distinct normalized fresh questions and exact hashes for all 41 selected raw corpora. Answers and retrieval outcomes do not select cases.

The real preparation observation is 6.02 s wall, 184,041,472 bytes maximum RSS, 157,582,056 bytes peak memory footprint and zero process swaps. Its maximum JSON text buffer is 835,218 characters. These are process observations on this pinned workload, not whole-app or all-input memory guarantees. Boundary/Unicode/scalar-prefix and malformed-input parser checks pass.

One local embedding worker runs sequentially at nice 10. Fresh all-minilm requests use batches 16 with `num_gpu:0`, `num_thread:1` and 30-second keep-alive. An independent real control returns 384 finite dimensions with the same model digest; immediate `/api/ps` reports zero VRAM. This changes per-request benchmark execution only. [Ollama embed API](https://docs.ollama.com/api/embed), [FAQ](https://docs.ollama.com/faq) and [official option types](https://github.com/ollama/ollama/blob/main/api/types.go) support these controls; installed API version is 0.40.4. No server environment or OS settings are changed.

The original 637-MiB vector checkpoint is opened read-only. Exact normalized real vectors are reused by model digest, query/passage role and UTF-8 text hash; conservative original truncation flags remain. Fresh CPU vectors go to a separate persistent overlay, in one transaction per provider batch rather than one per vector. Two in-memory cache tests prove exact row/duplicate ownership and rollback after a later insert fails; a partial-commit source fault is assertion-caught. Synthetic test rows never enter the real benchmark cache or count as embeddings. Cached original execution and fresh CPU execution are declared separately; both comparison arms share the same vectors.

Real worker preflights have equal ordinary-control prompts/source ranking and valid exact provenance. The final worker control observes 55.30 MiB worker RSS; it excludes the separate Ollama service and is not a peak/whole-workload memory claim. Fresh batch truncation, cached flags, ingestion/query timings and residency are retained individually.

One hosted evaluation worker uses configured NVIDIA Nemotron 3.5 Lightning 30B A3B for both reading and judging, temperature 0, thinking 1024, completion cap 2048. It reuses the same frozen record 96 functions/rubric and 22 passing controls under exact hashes, making no new control requests. The transport wrapper admits at most 3 requests/minute and one HTTP call, applies declared 429 cooldown and publishes create-only atomic file/directory-fsynced receipts. Parent retrieval receipts use the same writer. Five earlier focused writer/process-death checks and its direct-overwrite source fault remain supporting evidence; hardware power-loss and installed C 04 remain unqualified.

All raw inputs, overlay vectors and evidence use persistent paths. A complete paired denominator requires **100 valid arms for 50 questions**; all valid wrong answers survive resume, and only absent/invalid evaluations may retry. `evaluation-freeze.json` fixes source/compiled/selection/model dependencies before selected-question inference. No source/model/grading/selection adjustment may follow pilot outcomes.

## Completed public pilot and decision

[The full audit](evidence/2026-10-14-rag-passage/public-answer-qualified.json) verifies all 100 answers against raw reader/judge requests, returned model identity, exact predictions/verdicts, usage, original source versions and shown text. All 19 pre-inference dependency hashes and 41 raw corpus hashes match. Both arms retrieve identical sources on all 50 questions; 722 shown spans pass containment/version checks, with zero scope/budget/provenance faults. [Five altered observations](evidence/2026-10-14-rag-passage/auditor-faults/results.json) fail assertions: verdict, reader input, missing answer, returned model and cost. Original answer rows remain unchanged. The auditor exits 2 to report **adoption rejection**, not failed integrity.

These are new paired denominators, not a continuation or direct comparison to records 96–97’s different subsets. All 25 classic questions in this fresh selection are answerable; earlier exclusions leave no fresh abstention cases in this pilot. Same configured NVIDIA `nvidia/nemotron-3.5-lightning-30b-a3b` answers and judges both arms under the frozen profile.

| Dataset / frozen metric | Baseline | Candidate | Paired change | Gains / losses |
|---|---:|---:|---:|---:|
| Classic LongMemEval judged answers | 6/25 (24%) | 13/25 (52%) | +28 percentage points | 7 / 0 |
| MemoryAgentBench custom judged answers | 15/25 (60%) | 15/25 (60%) | 0 percentage points | 3 / 3 |

| Family | Baseline | Candidate |
|---|---:|---:|
| Classic knowledge update | 0/5 | 3/5 |
| Classic multi-session | 1/5 | 1/5 |
| Classic assistant facts | 4/5 | 4/5 |
| Classic preferences | 0/2 | 0/2 |
| Classic user facts | 1/4 | 3/4 |
| Classic temporal reasoning | 0/4 | 2/4 |
| MAB EventQA 131072 | 4/5 | 2/5 |
| MAB EventQA 65536 | 2/4 | 4/4 |
| MAB EventQA full | 3/4 | 2/4 |
| MAB embedded LongMemEval | 3/4 | 3/4 |
| MAB RULER QA1 | 3/4 | 4/4 |
| MAB RULER QA2 | 0/4 | 0/4 |

Every changed verdict is listed in [paired changes](evidence/2026-10-14-rag-passage/paired-changes.json). The three losses are `mab-14-77`, `mab-16-57` and `mab-3-80`. Post-completion inspection flags a possible judging/format disagreement: the first candidate response ends with the reference event after long analysis containing other options, yet the frozen judge marks it false. The other two choose different events. No verdict, parser, profile, rule or candidate is changed to improve this score. Independent human/judge agreement remains unqualified; faithfully auditing a verdict is not proof of its semantic correctness.

Preserved upstream MAB functions produce EM 36→40%, token F1 45.77→49.48%, and substring EM 52→56%. These differ from the custom judge metric and do not override its predeclared adoption rule. ROUGE/full official evaluation is absent. Classic source Recall@3 stays 84.67% in both arms, with all required sessions present on 19/25 questions. Literal-reference containment changes 15/23→17/23 classic and 5/24→8/24 MAB; it is diagnostic text containment, not answer correctness.

[The adoption decision](evidence/2026-10-14-rag-passage/adoption-decision.json) rejects the prototype because **both datasets must improve**. No benchmark-label routing, selective adoption, post-hoc rescoring or retuning on these questions follows. The candidate and all assertions remain isolated and preserved. Production recall retains SHA-256 `a849be001290b83ef3cc59945232634dd628001780120121d7d9759d9a6ff7ef`; vector store and generated staging engine also match their starting bytes. The installed app is untouched.

## Costs, failures and actual verification

Accepted reader prompt tokens rise **31,179→78,279 (2.51×)**. Reader total tokens rise 78,843→130,045; accepted reader-plus-judge totals rise 134,047→185,460. All 259 retained provider attempts include 217 HTTP 200, 39 HTTP 429 and three connection failures without HTTP status. Seventeen HTTP-200 responses fail completion/verdict validation and remain recorded. Reported usage across every retained attempt is **360,145 total tokens**; currency cost is unavailable. The run takes about 116.6 minutes, including pacing, retries and cooldowns. No new judge-control requests were made. HTTP service time and admission waits are separate in the audit; no hosted latency speedup is claimed.

Local retrieval completes 41 corpora, 5,657 documents and 36,099 indexed chunks. Recorded passage embedding inputs include 21,000 cached and 15,067 fresh; 20,995 cached inputs retain conservative potential-truncation flags. Fresh truncation occurs in 895 passage batches, bounding affected inputs at 895–14,202 rather than asserting a per-chunk rate. All 50 query embeddings are fresh; six single-query batches require truncation. Both arms share the same vectors. This small embedding window remains a quality limitation and is not repaired by supplying longer reader passages.

Fourteen isolated candidate fixtures, eleven assertion-caught source faults, parser boundary/malformed-input checks, two cache ownership/rollback cases and its partial-commit source fault pass. The earlier five atomic writer/process-death checks support the unchanged checkpoint library. Full result auditing and its five altered-observation checks pass. Existing production recall/resource/RAG suites pass **32 tests in three suites** with one worker. The first extra run aborts at the deliberately imposed 256-MiB JavaScript heap limit; its raw log is retained. One identical-assertion retry with a 512-MiB heap cap passes in 2.98s wall, observes 626,491,392 bytes maximum RSS and zero process swaps. Heap cap is not RSS, and this is a process observation rather than an installed memory guarantee. No broader suite/build, installation or local answer-model run is performed.

Earlier retained snapshots show AC power; the closing check shows battery power at 78%, with all benchmark workers already finished. One hosted-client snapshot is 8,304 KiB RSS and 0% CPU at nice 10, excluding other services and peaks. No new Mac crash is observed during this pilot, but the cause of the earlier watchdog reports remains unestablished. Successful benchmark completion does not demonstrate a crash fix.

## Remaining Targets

Independent judge/human agreement, reader final-answer formatting, oracle/equal-budget ablations, larger representative unseen workloads, embedding-window/reranker qualification, sustained installed latency/RSS/energy, the cause of the Mac watchdog failures, full R02 and release remain Target. The completed 50-question scope is exhausted; no further hosted qualification is started. Future candidates must use independent constructed development cases and new questions, rather than tuning on these results. A small balanced same-model self-judged pilot cannot establish population accuracy, a reference-model leaderboard or a competitive Win. Three earlier unrelated complete-suite failures remain open.

## Evidence closure

[Preservation receipt](evidence/2026-10-14-rag-passage/preservation-final.json) verifies all 6,631 starting paths, with only the five declared research indexes changed. Earlier record-97 artifacts/scripts, production source, generated staging engine, configuration and existing assertions remain unchanged. The scoped source/document diff and content-hash manifest retain this prototype, low-load tooling, raw attempts, all valid wrong answers, audit faults and the failed test-heap attempt. Credential scanning finds zero known-key matches. No installation, commit or push occurs in this pilot.
