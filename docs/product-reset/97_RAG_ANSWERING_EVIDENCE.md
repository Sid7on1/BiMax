# RAG answering evidence — 2026-10-14

Status: **Measured rejected prototype**. The complete paired qualification improves classic LongMemEval but regresses on MemoryAgentBench, failing the predeclared adoption rule. Production recall is restored to its starting bytes. Benchmark/checkpoint tooling and every result remain retained. This record does not qualify an official leaderboard, installed full R02, independent judging, release or competitive Win.

## Guidance and scope

The current product-reset README, repo audit, target architecture and split history, Mac Buddy vision, V03/V27B research cards, competitive status/model-independent/evaluation definitions, R02 and acceptance gates guide this work. Current ownership records 55/64/79–84 supersede historical split/CU descriptions. The referenced `competitive/03_CAPABILITY_MATRIX.md` remains absent; it cannot supply evidence. This round evaluates a shared-memory recall prototype; no production recall change from it remains after rejection. CU/UI, native permissions, user configuration, model defaults, dependencies, installation and publishing are outside this change.

The owner asked to improve record 96's 40/100 classic LongMemEval and 39/100 custom MemoryAgentBench judged answers. Those historical records remain intact. This round develops on independent constructed fixtures and excludes the old 200 question IDs **and normalized question text** from a new balanced 100+100 paired qualification. No heldout answer or model outcome selects the production algorithm, budget or grading rules. Shared public corpora and repeated question text across MemoryAgentBench families prevent describing the new set as corpus-heldout or independent population sampling.

Evidence is in `evidence/2026-10-14-rag-evidence/`. `protocol.json` and `public-selection.json` fix the method and cases; `dirty-before.json` hashes 2,547 starting dirty files, and `baseline/` freezes this round's starting source/research. This is uncommitted working-tree work, with no push implied.

## Source-inspected bottlenecks and change

The old excerpt picker chooses the best line but takes its **head** when that line exceeds the available room. A query-bearing clause near the end of one long line disappears. The first source can consume almost all 1,800 excerpt characters, leaving roughly 151 characters per later source. Inside one source, the first chunk similarly starves other matching chunks. A date stored in a document header disappears when a later chunk matches, preventing relative-date reasoning from using that source timestamp. These are independent constructed reproductions, not conclusions inferred from gold answer strings.

The rejected prototype, archived at `evidence/2026-10-14-rag-evidence/rejected/src/memory/recall.ts`, implements:

- Uses a linear sliding whole-word window inside an oversized selected line, maximizing rare-query-term coverage and keeping surrounding text. Unicode tokenization and exact source substrings remain intact. No-match head fallback and short-note behavior remain.
- Shares the remaining excerpt allowance across sources, then across up to four distinct matching chunks, returning unused space from short passages. Admission follows retrieval rank; rendering follows source order. Exact duplicate text retains the first ranked chunk locator.
- Quotes an existing bounded leading `Session date:`, `Date:` or `Timestamp:` line as a separate source span when there is room. It never invents a date from `lastUsedAt`, assigns semantic validity from that line, or inserts benchmark labels.
- Raises the default excerpt allowance from **1,800 to 6,000 characters**, retaining caller-specified limits and the three-document limit. The existing request-budget/compaction boundary still applies. This costs more model input; it is not a free speed optimization.

`src/memory/vector.store.ts` and its record-96 dense/heap optimizations stay byte-identical. Ranking constants, dense/BM25 fusion, source scope, embeddings, reranker behavior, recall admission/cancellation/duplicate suppression and the reader/judge prompts remain unchanged. The public comparison asserts equal retrieved document ranking for every pair. The candidate changes both excerpt selection and allowance; its LongMemEval gain and MemoryAgentBench loss cannot be attributed to either in isolation. Production uses the restored starting implementation.

## Qualification method

Pinned classic LongMemEval cleaned and MemoryAgentBench Accurate_Retrieval revisions, file hashes, licenses and the exact source-only ingestion adapter are retained from record 96. Complete public files were recovered to `/tmp/bimax-rag-evidence-20261014`, outside the repository, and their hashes checked. The selection seed is `bimax-rag-evidence-heldout-2026-10-14-v1`; only IDs/types/families/hash order select cases, never answers or retrieval outputs.

Each new question gets baseline and candidate production recall with the same real **Ollama all-minilm, 384-dimensional** corpus/query vectors and identical three-source ranking. Embedding overflow remains explicitly recorded. A benchmark-only SQLite cache stores exact normalized real vectors keyed by model digest, query/passage role and UTF-8 text SHA-256, including conservative original batch-truncation flags. It changes ingestion reuse, not production ranking or the representation; no fabricated vectors or new model are substituted. Its files remain outside the repository. Cached/fresh/truncated observations are reported separately.

Both arms use the owner-authorized **NVIDIA Nemotron 3.5 Lightning 30B A3B**, temperature zero, thinking enabled with a 1,024-token reasoning budget and 2,048-token completion cap. The exact frozen record-96 reader/request/judge functions and official task-specific rubric are reused. The 17+5 passing independent controls are reused only after source/profile/rubric hash checks; their previous failures/raw attempts remain preserved. This round makes no fresh control requests. Same-model judging and unpinned hosted serving weights remain limitations.

Four hosted evaluation workers initially overlap two independent local-ingestion workers. The frozen driver profile records the original 40-request/minute ceiling; subsequent invocations reduce traffic without changing a request body. Repeated NVIDIA HTTP 429 responses lead first to a ten-request/minute, two-HTTP-call benchmark wrapper, then a three-request/minute, one-HTTP-call wrapper. Both apply shared cooldown on 429 and honor a supplied Retry-After. Wrapper hashes, actual traffic settings and separate HTTP/admission observations are retained; this is benchmark transport recovery, not a production provider-policy change. Attempt wall time in wrapped runs includes admission/cooldown, so it cannot be used as pure model latency. The first arm alternates by question-ID hash. Every valid answer—including wrong answers—is retained across resume; absent/invalid arms alone can retry. The final denominator must contain **400 valid answers for 200 paired questions**. Raw reader input/prediction, reconstructed exact judge messages/verdict, returned model identity, exact source hashes/shown spans, budgets, selection disjointness and dependency hashes are audited before any gain is reported. Source recall, literal reference containment, judged accuracy, upstream-function metrics, tokens, resource costs and latency remain distinct.

The adoption rule, fixed before inspecting scores, requires a positive paired net accuracy gain in **both** datasets and zero scope/provenance/budget/required-contract failures. Every gained/lost case and declining stratum stays visible. This is a bounded local adoption rule, not a Product-ready or no-regression-on-every-query claim. A failed candidate is retained as diagnostic evidence without tuning on the qualification set.

## Local verification and retained failures

The initial seven independent evidence tests reproduce **five failures/two passes** on record 96. The final ten cases cover end-of-line facts, Unicode/whole words, multiple sources/chunks, date headers, recency refusal, small/caller budgets, no-match/short controls, first-ranked duplicate identity and complete-chunk admission. The focused set passes **139 tests**; broader context/memory passes **240 with one existing skip**; context Bun passes **63**; unchanged context benchmark version 4 remains **43/43**. Root build and app typecheck pass. Scoped lint has no errors/warnings; the full first lint has zero errors/1,852 warnings, including one new test cast warning subsequently removed. No existing assertion or acceptance threshold is weakened.

Nine executable source faults are assertion-caught: head-only long-line selection, source/chunk starvation, dropped dates, reversed duplicate identity, overclaimed spans, invented recency dates, no-match tail fallback and restored small default allowance. Exact source restoration and a passing restored run are recorded. The first proof attempt fails its baseline before injection because a constructed complete-chunk fixture includes trailing whitespace that production intentionally trims; the fixture input is corrected, the failed attempt retained, and it counts as no mutation kill.

Equal-allowance component CPU observations use Node **24.15.0**, 100 warmups per arm/shape, two nine-group alternating ABBA runs and 36 normalized samples/arm/shape with zero qualified discards. Ordinary short-note assembly measures **0.01890 → 0.02108 ms (+2.19 µs)**; complete matched chunks at the same 6,000-character allowance measure **0.02885 → 0.02978 ms (+0.93 µs)**. Prompts, IDs and source identity/locator/text are identical on those controls. A 51,051-character single-line stress case measures **3.64 → 11.66 ms (+8.01 ms)**; its old output omits the required literal fact and the new output retains it, so this is a quality/cost tradeoff, never a correctness-preserving speedup. These shared-machine component observations are separate from the historical Node-22 dense/heap results. The first sampler accidentally compares real per-observation `observedAt` timestamps and rejects its control; that failed log is retained. The qualified comparison excludes only that timestamp, retaining exact content/identity checks.

An initial simultaneous benchmark SQLite WAL setup races and exits one ingestion worker. A stale copied resume dependency path then aborts before new ingestion. Both attempts remain evidence. The cache is initialized once before restarting the **identical** worker; the parent's broken-pipe cleanup/dependency checks are repaired. Four valid answer-arm checkpoints from the initial attempt are retained under identical production/model/grading hashes. No answer outcome is used to choose the repair or replay a valid answer. The final audit must match those reused raw prompts exactly to the corrected saved retrieval inputs.

During the run the Mac switches to battery power at 20%. A readonly consistent SQLite backup and hash-checked public-input copies are saved under `~/Library/Caches/BimaxBench/rag-evidence-20261014`, outside reboot-cleared `/tmp`. The first vector snapshot is 637.22 MiB, plus the public data copies; this is external benchmark recovery storage, not production retained heap. The live cache, production/config and grading profile are unchanged. Recovery receipts name the exact paths and hashes; another interruption can restore the original temporary paths without choosing new answers.

After a later interruption, no benchmark process remains. `public-answer-6` resumes all **281** valid saved arms; the Mac is observed on AC power and charging. Its ongoing throttling leads to transport-only recovery in `public-answer-7`, preserving **286** valid arms. Every previous attempt remains in its original run, including incomplete calls with unknown usage. Config/source/selection hashes are checked on resume; the intermediate preservation audit finds no changes to starting dirty files outside this round's allowed scope. Configured gpt-oss-20b's availability recheck still times out, so no alternate model is mixed into the score. The snapshot's exact SHA-256 is recorded separately.

The owner reports frequent Mac crashes. After another interruption, **321 valid arms** remain intact and no benchmark process is running. Readonly local diagnostics show a kernel watchdog timeout (no watchdogd check-in for 93 seconds) and userspace watchdog reports; they do not establish the cause or attribute it to this benchmark. Raw personal diagnostics and machine UUIDs are not copied into evidence. `public-answer-8` resumes the same model/source/grading/selection under `nice -n 10`, three requests/minute and one simultaneous HTTP call, with no local embedding, ingestion or broad test/build rerun. One client snapshot is 60,304 KiB RSS and 0% CPU on an eight-GiB Mac; this is not a peak/whole-app resource claim. The Mac is on AC power and charging.

Its separate benchmark-only wrapper publishes complete JSON through a create-only same-directory link after file fsync, then directory fsync. Raw request, result and transport receipts use this writer; the non-authoritative progress file remains best-effort. Five small offline checks include forced child termination before/after publication, exact JSON, refusal to overwrite and failed serialization; a direct-overwrite source fault is assertion-caught. An offline fake-transport preflight checks unchanged original request code and exact request body with zero API calls. Its initial constructed fake namespace failed because `/var` was not resolved to `/private/var`; the corrected fixture matches the frozen setup and passes, with the initial failure retained. These qualify process-level receipt publication, not hardware power-loss durability or installed C04. Wrapper/checkpoint hashes and all raw prior attempts remain preserved. Transport-receipt fsync overhead is part of accepted-attempt wall time, separate from recorded HTTP time. A small hash-verified recovery archive saves current RAG source/receipts outside `/tmp`; it is a same-volume snapshot, not protection from disk failure.

The independent complete retrieval audit checks **200 questions / 400 arms**, **2,896 shown source spans and versions**, equal document ranking in all 200 pairs, real dense retrieval in all 400 arms and zero reranked arms, with **zero errors**. Answerable classic LongMemEval source Recall@3 is **91.53% in both arms**, with all gold source sessions retrieved in **74/85** cases. This different cohort must not be compared as a regression against record 96's 94.06%; source identity is held equal within the current pairs. Source recall alone does not qualify answering quality.

Record 96's three unrelated full-suite failures—desktop raw-pairing IPC guard, external responder authentication integration and native OCR confidence—remain open. This round does not claim a newly green complete offline or release gate.

## Public results

The complete fresh paired qualification has **400/400 valid arms, 200/200 paired questions**, exact raw reader/judge/model/usage audits and zero provenance/scope/budget faults. The same configured NVIDIA Nemotron reader/judge profile is used throughout. **Global adoption is rejected** because MemoryAgentBench regresses. The predeclared rule is not relaxed after scoring. Historical 40/100 and 39/100 use different questions and are not these paired baselines.

| Dataset | Baseline | Rejected candidate | Change | Gained / lost |
|---|---:|---:|---:|---:|
| Classic LongMemEval | 43/100 | 64/100 | +21.00 pp | 23 / 2 |
| LongMemEval answerable | 29/85 | 49/85 | +23.53 pp | 22 / 2 |
| MemoryAgentBench custom judge | 51/100 | 45/100 | -6.00 pp | 9 / 15 |

LongMemEval strata:

| Stratum | Baseline | Candidate | Gained / lost |
|---|---:|---:|---:|
| abstention | 14/15 | 15/15 | 1 / 0 |
| knowledge-update | 4/15 | 12/15 | 8 / 0 |
| multi-session | 1/14 | 3/14 | 2 / 0 |
| single-session-assistant | 10/14 | 11/14 | 2 / 1 |
| single-session-preference | 2/14 | 3/14 | 2 / 1 |
| single-session-user | 8/14 | 12/14 | 4 / 0 |
| temporal-reasoning | 4/14 | 8/14 | 4 / 0 |

MemoryAgentBench families:

| Family | Baseline | Candidate | Gained / lost |
|---|---:|---:|---:|
| eventqa_131072 | 12/17 | 10/17 | 2 / 4 |
| eventqa_65536 | 12/17 | 9/17 | 2 / 5 |
| eventqa_full | 9/17 | 6/17 | 0 / 3 |
| longmemeval_s* | 4/17 | 6/17 | 2 / 0 |
| ruler_qa1_197K | 7/16 | 7/16 | 3 / 3 |
| ruler_qa2_421K | 7/16 | 7/16 | 0 / 0 |

All three EventQA family judge scores decline; the embedded LongMemEval family gains, while both RULER family totals stay equal. Two individual LongMemEval wins are lost despite its positive net gain. No case or declining family is removed.

Literal reference containment increases from **33/71 to 40/71** eligible classic cases and **23/98 to 27/98** eligible MemoryAgentBench cases, yet the latter’s judged accuracy decreases. This diagnostic cannot substitute for answer quality. Required source ranking stays equal in every pair; classic answerable source Recall@3 is 91.53% for both arms, complete in 74/85.

Licensed upstream-function MemoryAgentBench metrics also decline: EM **34% →25%**, token F1 **44.56% →37.70%**, substring EM **50% →47%**. These use the preserved family postprocessing; ROUGE and the full official evaluator/leaderboard remain absent.

Accepted-call usage:

| Dataset / arm | Reader prompt tokens | Reader total tokens | Judge total tokens |
|---|---:|---:|---:|
| LongMemEval / baseline | 57,057 | 150,264 | 108,828 |
| LongMemEval / current | 157,053 | 264,561 | 113,492 |
| MemoryAgentBench / baseline | 67,574 | 163,161 | 107,575 |
| MemoryAgentBench / current | 148,104 | 247,236 | 111,718 |

Combined reader input is **124,631 →305,157 tokens (2.45×)**. Accepted reader+judge usage is 529,828 baseline versus 737,007 candidate tokens. All 800 accepted calls have usage observations. Across all retained recovery runs, **1,195 request attempts** include **334 HTTP 429**, 856 HTTP 200 and five attempts without a recorded HTTP status. Reported usage across retained attempts is **1,413,836 total tokens**; interrupted calls without records have unknown usage. Currency cost is unavailable. Twenty-two earlier passing controls are reused under source/profile hashes, with zero new control requests.

Accepted reader HTTP median/p95 observations: LongMemEval baseline 12.14/28.57s, candidate 14.14/24.58s; MemoryAgentBench baseline 13.10/24.53s, candidate 12.51/23.83s. Wrapper HTTP time is separated from admission/cooldown where instrumented; earlier observations use HTTP/decode wall time. These shared-service observations exclude failed attempts/backoff and establish no speedup. Full wall duration includes user interruptions and Mac/provider recovery.

The 200 cases ingest 121 corpora, 10,943 documents and 88,793 chunks. Real all-minilm observations retain 81,495 fresh and 7,158 cached passage inputs. Fresh provider truncation affects 1,314 batches with input bounds 1,314–81,388; cached vectors retain conservative original batch flags. These are batch bounds, not a fabricated per-chunk rate.

The initial final audit correctly refuses missing `/tmp` corpus inputs after the interruption. It is retained; 121 selected original raw rows (87,819,835 bytes) are restored from their hash-checked persistent recovery copies without embedding or model calls. The full audit passes, returning exit 2 specifically for failed adoption. After source restoration, an explicit `--candidate-source evidence/.../rejected/src/memory/recall.ts` re-audit requires the same recorded hash and produces identical metrics. Five deliberate observation faults (verdict, input, missing answer, returned model and cost) fail assertions, both before and after explicit source archival. Every original result remains unchanged.

The rejected TypeScript and all ten proposed tests/assertions are archived byte-for-byte under `rejected/`; their recorded 139/240/63/43 and nine-source-fault results describe that prototype. Existing tests are not weakened. Production recall is restored to its exact starting SHA-256, as is its generated standalone runtime; the staging engine is rebuilt from restored source in 0.44s at nice 10, without installation or a broad rebuild. **32 existing recall/resource/RAG tests pass** after restoration. The earlier three unrelated full-suite failures remain open.

Reproduce the archived-candidate audit with `scripts/summarize-rag-evidence.py public-answer-8 --candidate-source rejected/src/memory/recall.ts --output <new-create-only-report>`, using the absolute evidence paths. Its source hash must match the original model configuration; compiled snapshots and original attempts stay frozen. Run prototype source faults only in a separate checkout containing the archived source/tests, never by silently replacing current production.


## Remaining Targets

Independent judge/human agreement, oracle/raw-history controls, an equal-budget public ablation, embedding-window and reranker qualification, full public suites/V2, representative installed long-task latency/RSS/energy, full R02 and release remain Target. Gains on a balanced query-heldout subset cannot qualify general superiority or a competitive Win.
