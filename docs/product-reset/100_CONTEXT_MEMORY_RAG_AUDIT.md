# Context, durable memory and RAG audit — 2026-10-18

## Repair follow-through — 2026-10-18

[Record 102](102_MEMORY_REPAIRS_AND_BOT_KERNEL.md), designed first in [record 101](101_MEMORY_INTEGRITY_AND_PERSONAL_BOTS_PLAN.md), implements repairs for **A01, A02 and A03** with local end-state and source-fault qualification. A01 now coordinates reload/mutation/publication across workers/processes; A02 fences delayed vectors by generation and exact source identity; A03 shares endpoint/reranker construction between parent and workers. The original findings and raw reproductions below remain the historical audit, not current claims that these three repairs are absent. Final verification details and remaining installed/release limits are in record 102.

**A04 and A05 remain open.** Broader live context/model-summary quality, independent RAG answering, embedding/reranker qualification and installed recovery/resource gates also remain Target. The bot kernel adds versioned definitions, scoped private retrieval and bounded worker context; creation UI, shared knowledge grants, unrestricted nested delegation, schedules and action-capable personal bots remain Target. No rejected RAG candidate is activated.

Original audit status, before record 102: scoped source audit with **locally reproduced defects**, passing existing regression checks and an offline context benchmark. Repairs were **Target** at audit time. The original audit changed no production source, provider configuration, installed application or previous benchmark result. Current repair status is in the follow-through above; live quality, installed qualification and Product-ready remain **Target**.

## Original audit verdict

Context orchestration has a substantial implemented correctness foundation. Durable memory still has data-integrity and worker-configuration defects. Memory RAG has a working retrieval pipeline, but strong answer quality is not established. This is more than release polish, and the evidence does not support a credible percentage-complete or delivery-date estimate.

The remaining work is six packages: memory write/version correctness; worker retrieval configuration parity; evidence selection and abstention; model-aware context qualification; semantic retrieval/answer qualification; and installed recovery/resource/release qualification. These are delivery slices, not equal units of effort. The first two are bounded engineering repairs; later slices require fresh experiments and can reject candidates again.

## Scope and guidance

Audited working-tree source at HEAD `7d1346dd9f428ce780871a652ce2f3a27b5388f6`; the checkout already contained extensive uncommitted work (92 modified and 142 untracked entries at initial inspection). Findings concern those current working-tree bytes, not HEAD alone. Source hashes and raw audit outputs are retained in `evidence/2026-10-18-context-memory-audit/`.

Guidance: product-reset README; records 01/05/06 for ownership history; 08 acceptance gates; competitive README, rival studies, model-independent strategy, gap register and evaluation rules; R01/R02 contracts; records 50/51, 93–98 and current build sequence. The Mac Buddy vision's performance, memory-copy and hardware/resource requirements guide resource limitations. Records 55/64 and later current ownership notices supersede the historical split diagrams. `competitive/03_CAPABILITY_MATRIX.md` is still missing and supplies no audit evidence.

Source inspection covered request accounting and AgentLoop admission/recall wiring, history retention, ContextManager compaction, evidence identities/dependencies, continuation/archive bounds, memory settings/embedding contracts, vector-store mutation/search/backfill, parent/sub-agent worker construction, code-search admission and state ownership. This is not an exhaustive function-by-function audit, an installed journey or a whole-app security/release certification.

## Prioritized findings

### A01 — P1: separate memory writers can acknowledge writes and lose a note

`src/memory/vector.store.ts:216`, `:452` and `:358`: the mutex belongs to one VectorStore instance. Reload, mutate and whole-file rename do not share a transaction with another instance. Atomic rename prevents partial JSON; it does not merge another writer's update.

**Reproduced:** pause writer A at its existing asynchronous save boundary after its read/mutation. Writer B writes a different note and returns successfully. Resume A; it also returns successfully. Disk contains only A. The probe checks that B was independently present before A resumed. Two acknowledged writes retain one note.

This matters beyond a hypothetical second constructor: `src/engine/worker.entry.ts:189` constructs a distinct store in a sub-agent worker, while `src/core/container.ts:281` constructs the parent's. The comment claiming the worker shares the parent's store describes shared configuration/file identity, not a shared JavaScript mutex. The app's same-folder task scheduling guard limits simultaneous foreground Bimax Thread dispatch; it is not a memory-file transaction across parent/sub-agent isolates or delayed recency writes. No installed data-loss frequency was measured.

**Required repair:** serialize the full reload/mutate/publish transaction by canonical store identity across isolates/processes, or use a transactional store/service. Preserve deduplication, deletion, recency, failed-write and restart semantics. Add deterministic concurrent writer and process-boundary tests before calling this fixed.

### A02 — P1: delayed backfill overwrites a newer chunk's correct vector

`src/memory/vector.store.ts:767` snapshots chunk IDs/text, releases its mutex for embeddings, then `:788` publishes by chunk ID without comparing the selected text/version. Chunk IDs reuse document ID plus ordinal.

**Reproduced:** an old unembedded note starts backfill. While its embedding waits, replace the same note and persist its correct new vector `[0,1]`. The old result `[1,0]` returns; backfill overwrites the new vector while retaining the new text and active-space stamp. This is reproducible inside a single store instance; a cross-process collision is unnecessary.

**Required repair:** bind publication to the selected document/chunk generation, exact content and embedding-space identity; revalidate after the await. Reject or requeue changed/deleted/replaced selections. For other store instances, reconcile disk state under the shared mutation authority from A01.

### A03 — P1: sub-agent embeddings ignore the configured endpoint

The parent honors `memorySettings.embeddingBaseURL` before accessing the chat key pool (`src/core/container.ts:249`). The worker resolves the same settings but supplies only the chat-key resolver to its embedder (`src/engine/worker.entry.ts:183`). It also does not compose the parent's optional local-reranker fallback.

**Reproduced at the resolver seam:** execute the exact current worker resolver body with a configured loopback embedding URL and a fake hosted chat route. It reads the chat key and returns the hosted route. Synthetic credentials and a reserved `.invalid` hostname ensure no provider call. This is an extracted-resolver check, not a complete worker/HTTP journey.

An ordinary worker can therefore use a different embedding destination from the configured parent, fail to find a local model remotely, or attempt to send memory text to the chat endpoint. Sovereign egress policy may separately refuse that request. This audit did not observe personal data leaving the machine or claim such a refusal was bypassed.

**Required repair:** share the retrieval-construction policy across parent and workers, preserving endpoint precedence, keyless local operation, chosen models/dimensions and local reranker configuration. Verify actual worker requests with an isolated local HTTP fixture and no hosted credentials.

### A04 — P2: dense retrieval can inject unrelated evidence without abstaining

`src/memory/vector.store.ts:594` admits every eligible same-space dense score into top-k without an absolute relevance floor. `src/memory/recall.ts:139` disables its unknown-subject abstention whenever dense candidates exist.

**Reproduced:** a query about neutrino oscillations has no lexical matches against an orchard-pruning note; controlled unit vectors have cosine zero. Lexical search returns nothing; automatic hybrid recall injects the orchard note and reports dense active.

This demonstrates an admission-policy gap, not a real-model false-positive rate. Code search uses a different SQLite/dense-floor contract; this finding must not be applied to it indiscriminately.

**Required repair:** qualify semantic sufficiency/abstention with independent no-answer, unrelated, multilingual and paraphrase cases. Calibrate any admission rule on the actual embedding space; an arbitrary universal cosine threshold could delete legitimate paraphrases.

### A05 — P2: a matched oversized line loses the answering clause

`src/memory/recall.ts:228` finds a matching line, then takes its head when it is longer than the allowance. Production still defaults to 1,800 excerpt characters and three returned documents (`:111`), after reserving later-source room.

**Reproduced:** a single 804-character source line ends with a query-matching launch code. A 120-character excerpt contains only background and omits the code. A short-line control retains the code. Records 97–98 already diagnosed this family; the audit confirms it remains in production after their rejected candidates.

**Required repair:** develop independent long-line/whole-relation/multi-source/date cases, then compare excerpt selection at equal budgets. The archived 6,000-character candidates cannot be promoted on their LongMemEval gains alone; their adoption rule failed.

## What is already implemented and locally checked

- Main-request budgeting counts system instructions, schemas, history, actual reply allowance and a margin, and refuses impossible fixed costs before auxiliary work.
- Recent-history selection protects the active human request and complete leading tool exchanges. Continuation state, bounded archives, versioned evidence and actual text-residency accounting preserve inspectable context through local compaction cases.
- Stop/deadline/epoch fences prevent tested late summary/recall publication; failed summaries retain an explicit unavailable state and bounded recovery evidence.
- Memory has real-backend interfaces, chunking, BM25/dense rank fusion, scoped candidate admission, source-diversity backfill, configured reranking/degradation reporting and embedding-space checks.
- Code retrieval has a distinct SQLite/FTS5 path with source read-back admission, scope, restart and embedding-space regression coverage. Bun is the declared runner for runtime-dependent retrieval tests.

These mechanisms have local regression evidence. They do not establish that a live summarizer retains every constraint, that a recalled note answers the question, or that installed long tasks survive every interruption.

## Existing answer-quality evidence

The source SHA-256 of production `recall.ts` remains `a849be001290b83ef3cc59945232634dd628001780120121d7d9759d9a6ff7ef`, matching record 98's unchanged baseline.

| Preserved experiment | Baseline → candidate | Decision / limits |
|---|---|---|
| Record 96, fixed 100 classic + 100 MAB subset | 40/100 classic; 39/100 custom-judged MAB | First subset measurement, no answer-quality gain comparison; answerable classic accuracy 26/85 despite 94.06% source Recall@3 |
| Record 97, fresh paired 100+100 | Classic 43→64/100; MAB 51→45/100 | Rejected; reader input 2.45× |
| Record 98, fresh paired 25+25 | Classic 6→13/25; MAB 15→15/25 with three gains/three losses | Rejected; reader input 2.51× |

Different cohorts cannot be combined into a trend or an overall production accuracy. These runs use configured Nemotron as both reader and judge, real local all-minilm embeddings and no active reranker. They are not an official leaderboard or representative full-population score. Source recall and answer accuracy have different denominators and meanings.

The quality gap is real enough to prioritize, but these experiments do not causally separate extraction, reader reasoning, ranking, embedding truncation and judge errors. Record 98 reports query and passage truncation, plus a possible judge/format disagreement. Independent judging, oracle/raw-history controls and equal-budget comparisons remain necessary.

## Remaining delivery order

Current follow-through: rows **1–2 are implemented and locally qualified in record 102**; rows **3–6 remain open**. The original contract below is retained to show what the repairs had to prove. Bot product UI, broader authority and installed qualification are separate remaining work in records 101–102.

| Order | Work package | Completion evidence still required |
|---|---|---|
| 1 | Memory integrity: A01/A02 | Concurrent parent/worker writes preserve all acknowledged notes; stale backfills cannot overwrite replacements; failure/restart and mutation-qualified assertions |
| 2 | Worker configuration: A03 | Parent and real worker use the configured local/remote retrieval policy; local keyless mode and reranker fallback verified with loopback requests |
| 3 | Evidence selection and abstention: A04/A05 | Independent positive/no-answer/long-line/multi-source/update/date fixtures, equal-budget ablations and a new frozen candidate meeting its adoption rule |
| 4 | Model-aware context management | Auxiliary input uses the actual lite-model window/output reserve rather than only a fixed 96k-character allowance; provider tokenizer/image-cost cases and live long-horizon summary/constraint checks across declared model tiers |
| 5 | Retrieval and answer qualification | Embedding-window/truncation and reranker tests; oracle/raw-history controls; independent judge/human agreement; fresh representative qualification and preserved live-code R02 artifact |
| 6 | Installed reliability and resources | R01/R02 and C04 interruption/crash/resume end states, no replayed side effects, sustained RSS/latency/energy measurements on the supported workload/device matrix, then full applicable offline/build/protocol/install/release gates |

Performance remains a separate open qualification: the memory store caps document count (500 by default), not aggregate content/vector bytes; code fences can remain oversized chunks. Existing retained-heap/component improvements are useful, but they do not bound installed peak RSS, total allocation, energy or pressure under simultaneous real workloads. No leak or Mac-crash cause is established by this audit.

## Verification performed in this audit

| Command / check | Observed result |
|---|---|
| `npm run test:context` | 63 passed, 0 failed; eight files |
| Focused Jest over context orchestration/work, memory recall/wiring/features/vector/lexical and RAG/resource suites, `--coverage=false --runInBand` | 9 suites passed; 138 tests passed, 1 existing runtime-specific skip |
| `npm run test:bun` | 133 passed, 0 failed; fourteen files, including native scanned-page OCR in this invocation |
| `npm run bench:context` | Valid context-bench@4; 43/43 graded cases, three resource measurements; no family failure |
| Corrected desktop runtime security Jest command | 47 tests passed, 0 failed; one suite, including the privileged-registration guard |
| Isolated `probe.ts` | Five current gaps reproduced; assertions check synthetic disk/vector/prompt/resolver outcomes; no production source mutation or hosted call |

Runtime: Node 22.13.1, Bun 1.3.14. Raw outputs and the benchmark JSON are retained beside the probe. The probe's scheduling controls and unit vectors are explicit; they are not installed/model-frequency measurements. No production-source mutation run was performed during this audit. Prior records contain their own scoped source-fault qualification; the newly discovered gaps require new repair-specific mutation checks.

One attempted security-check command selected a nonexistent test filename and reported no tests; it is retained as an invalid invocation, not a pass. The corrected command/result is recorded in `verification.json`.

The entire Jest suite, build/typecheck/lint, staged engine, installed app, live provider and full journey gates were not rerun. This audit adds research and synthetic probes, with no runtime fix to qualify. Earlier full-suite failures must be read chronologically: record 99 addresses the raw pairing-IPC guard within a focused slice; OCR passes this audit's Bun invocation. Neither fact establishes a newly green complete offline gate. External responder integration is not requalified here.

No Product-ready, release, general memory-safety or competitive Win claim follows. The priority is to repair integrity/configuration first, then prove improved answer outcomes and installed recovery under explicit resource budgets.
