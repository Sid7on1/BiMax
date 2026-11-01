# RAG source coverage and less retrieval work — 2026-10-14

Status: **Implemented** memory-retrieval document backfill, prompt source reservation and warm-path
work reductions; **Measured locally** on preserved generated fixtures. Live embedding/reranker
quality, model answer accuracy, independent heldout/public benchmark results, installed latency,
RSS/energy, full R02, Product-ready, release and competitive Win remain **Target/unmeasured**.
No CU/UI implementation, installation, commit or push in this round.

## Guidance, research and scope

Read the product-reset README first; applicable guidance: 01_CURRENT_REPO_AUDIT,
05_TARGET_ARCHITECTURE, 06_REPO_SPLIT_RUNBOOK, 08_ACCEPTANCE_GATES; Mac Buddy vision and research
playbook V03/V27B; competitive README/06 and C01/R01/R02; records 93–94. Current ownership follows
records 55/64/79–84. The coding engine owns context/retrieval; Bimax for Mac retains sole Computer
Use/native permission ownership.

Both user attachments were read. They propose evidence completeness, freshness and scientific
comparisons rather than token compression alone. Their hypothetical results are not Bimax
measurements. Fresh primary research includes [Elastic RRF](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion),
[Anthropic contextual retrieval](https://www.anthropic.com/engineering/contextual-retrieval),
[Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/),
[programmatic context management](https://arxiv.org/abs/2608.21690), and the official
[LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) /
[MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) repositories.
Applicability/defer decisions and attachment hashes are in `evidence/2026-10-14-rag/research.json`.
No upstream code, new dependency, dataset or model is imported. External model evaluation remains
Target; these fixtures cannot substitute for it.

This change concerns the JSON-backed memory RAG shared by memory/recall consumers. SQLite code
search, its own dense floor/indexing, and document numeric/FactStore pipelines retain their separate
contracts and tests. It is not an upgrade or numerical claim for every RAG subsystem.

## Reproduced failure and implementation

A long note can occupy every candidate in a retriever's depth window (`max(limit * 8, 64)`), leaving
only one returned document when three relevant documents exist. Collapsing chunks after truncation
loses other documents. Independently, an oversized first recalled source can consume the prompt
allowance and hide other retrieved evidence.

1. Keep the original chunk candidate pool, RRF parameters, winning prefix and reranker request.
   Retain a bounded document-champion pool from lexical/dense retrieval and fill only empty returned
   document slots. Scope applies before admission; non-dense lexical champions obey the existing
   relevance floor. Backfilled tail sources use document-champion RRF and are not sent through a
   second reranker call. They cannot displace the successful prefix. Live relevance of this tail
   still requires provider/heldout evaluation.
2. Reserve a useful excerpt for later selected sources within the existing prompt character
   allowance. Tiny budgets prioritize the best source. Evidence records exactly shown text, source
   version, document and partial locator; absent/archived text cannot become resident evidence.
3. Cache each chunk alongside its owning document during index construction, replacing repeated
   long-array `find` calls. Replacement/deletion rebuilds this lookup; the duplicate-ID convention
   is retained (first chunk in last owning document).
4. For a warm content-versioned vocabulary, probe the small remaining query-term set instead of
   walking every cached corpus term. Scope, query order and replacement invalidation remain intact.
   Cold tokenization is unchanged.
5. Check the existing full file identity before constructing pending recency copies. A changed
   file still reloads and merges unflushed recency; an unchanged file avoids a document-map copy.
   No staleness/mtime shortcut is introduced.

Record-93 Stop/deadline/epoch safeguards and record-94 serialization/archive behavior remain in
place. Ordinary retrieval is guarded by exact-output timing controls, baseline/current quality
controls, existing memory evaluations and the same-version context benchmark.

## Local evidence quality

Sixteen generated corpora (eight ordinary, eight crowding shapes) are exercised in lexical, dense
and hybrid modes: 24 ordinary and 24 crowding retrieval cases per version. These are deterministic
development fixtures, **not an independent heldout dataset**. Repeating modes/runs does not create
additional independent examples. Controlled unit vectors test pipeline behavior, not embedding
model understanding. Expected-source lists and evaluation annotations stay outside the ingested
documents; the facts themselves are ordinary source text.

| Family | Required-source Recall@3 before → after | All sources before → after | Required facts in prompt before → after | All prompt facts before → after |
|---|---|---|---|---|
| Ordinary controls (8 corpora × 3 modes) | 100% → 100% | 24/24 → 24/24 | 100% → 100% | 24/24 → 24/24 |
| Document crowding (8 corpora × 3 modes) | **33.3% → 100%** | **0/24 → 24/24** | **66.7% → 100%** | **0/24 → 24/24** |

MRR and precision remain 1.0 in these positive controls; they do not measure unrelated-query
ranking quality. Scope violations and invalid provenance are zero. Retrieval uses the topic query;
recall uses a separate compound question through its actual hybrid path, so the columns are
separate measurements. Dense/hybrid recall rows share that path and are not independent recall-mode
evidence. Missing-information abstention and source update/deletion controls pass both versions.
Prompt bodies stay within 900 characters (header excluded, the existing contract).

The independent fixture grader reads observed IDs, prompt text, original corpus bytes and source
hashes. Eleven grader tests include ten deliberately wrong/missing/stale/foreign/duplicate/over-budget
observations that must refuse. Fourteen new Jest tests cover lexical/dense/hybrid crowding,
scopes/floor/prefix/reranker pool, prompt coverage/tiny budgets, bounded lookup/vocabulary/recency
work, replacement and external deletion.

The existing hand-labelled memory evaluation also runs against frozen starting source and current
source: lexical Recall@3/MRR **0.80 / 0.733**, hybrid **1.00 / 0.844**, reranked **1.00 / 0.900**
in both versions (13 baseline evaluation/chunking tests pass). This prevents the generated
crowding cases from replacing the existing relevance controls. Its concept backend and reranker
are simulated, not live-provider quality; the older gap-register figures are corrected explicitly.

## Paired warm performance and resource cost

Apple M3, arm64, eight cores/eight GiB, Node 22.13.1. Baseline is the frozen starting working tree,
not Git HEAD. Two qualified runs, nine alternating ABBA groups each, 36 batch-normalized samples per
version/shape, zero qualified samples discarded. Construction/warmup are outside timing; each shape
first requires identical ordered result IDs/passage text, or prompt text, depending on the shape.
Full recall includes actual local search,
sufficiency, prompt assembly and evidence hashing, with no remote embedding/reranking/model answer.
All samples, hashes, batch sizes and local sample p95s are preserved; these are not installed-app
percentiles or confidence intervals.

| Fixture | Before ms/call | After ms/call | Speedup | Less time (negative = regression) |
|---|---:|---:|---:|---:|
| Warm vocabulary, 50 docs × 200 terms | 0.102232 | 0.002135 | 47.89× | 97.91% |
| Warm scoped vocabulary, 50 docs | 0.052550 | 0.001247 | 42.14× | 97.63% |
| Warm vocabulary, 500 docs × 200 terms | 1.270674 | 0.032106 | **39.58×** | **97.47%** |
| Warm scoped vocabulary, 500 docs | 0.551043 | 0.018703 | 29.46× | 96.61% |
| Warm search, long 100-chunk background | 0.045778 | 0.033597 | 1.36× | 26.61% |
| Warm search, long 10,000-chunk background | 0.963267 | 0.026961 | **35.73×** | **97.20%** |
| Warm sparse search, 50 docs | 0.014145 | 0.014110 | 1.00× | 0.25% |
| Warm sparse search, 500 docs | 0.027962 | 0.014878 | 1.88× | 46.79% |
| Warm sparse search, 10,000 docs | 0.414799 | 0.015171 | **27.34×** | **96.34%** |
| Complete warm recall, 500 docs / vocabulary check | 1.459534 | 0.066930 | **21.81×** | **95.41%** |
| Warm dense control, 50 docs | 0.041343 | 0.043285 | 0.96× | **−4.70%** |

The 10,000-chunk/document cases are explicit stress configurations, not the default 500-document
memory budget. Sparse lookup fixtures contain one rare matching term. Vocabulary cases have 200
distinct terms/document and query terms absent from the corpus, exercising the full negative
vocabulary check. Complete recall has sufficient known subject terms and two absent terms; it
returns actual evidence rather than timing a null shortcut. No cold-ingest/network/model
acceleration follows from warm results. Reproduce with `scripts/bench-rag-work.cjs` and inspect
`evidence/2026-10-14-rag/measurements.json` plus its raw inputs.

The small dense control costs **4.70% more time**, about **1.94 microseconds/call**, for document
diversity. Retained post-GC store/index heap for one generated 10,000-chunk document rises from
**3.160 to 3.544 MiB** (three isolated processes/version; all samples retained), roughly
**0.384 MiB / 12.1%**. Entry wrappers trade extra references/objects for fast resolution; no source
text copy is introduced. This is retained heap growth, not peak RSS or sustained application
memory/energy. The document pool is bounded and transient. Memory/dense cost remain explicit
adoption tradeoffs.

## Failed attempts and mutation qualification

The initial new test stub omitted required reranker metadata and failed compilation before grading;
invalid, not evidence. Correcting the controlled vectors made the intended dense monopoly explicit.
A stale-token fixture shared `SENTINEL` across old/new values: BM25 correctly matched that word. It
was replaced with disjoint identifiers, retaining the no-stale-hit assertion. Final frozen-source
replay fails ten assertions while four controls pass; current source passes all fourteen. Frozen
source was replayed after fixture repair, not represented as a chronological pre-edit run.

An exploratory fixture assumed `private` was globally excluded by recall, although recall's existing
scope excludes code/project-memory instead. The failure remains evidence. The corrected distractor
has the actual excluded `code` tag; direct search explicitly excludes `private`. This does not
introduce or claim a universal private-tag policy.

The first source-fault run catches eleven faults; an untyped empty loop fails TypeScript and is
**invalid**, not a kill. A type-valid empty slice fixes that injection. Final qualification requires
all **12 source faults** to fail real assertions, exact restoration and a passing restored suite.
Faults cover missing lexical/dense pools/backfill, scope/floor, winning order, reranker request
inflation, chunk/vocabulary/recency work and prompt reservation/tiny-budget admission. No existing
assertion is skipped, removed or relaxed.

## Completion checks

Local verification: **86 focused Jest tests**, **11 independent grader tests**, **133 Bun tests**,
**63 context Bun tests**, **three release-script tests**, root/app builds and typechecks, **zero
lint errors** (1,849 warnings), and **seven staged-engine exchanges** (29,470 outbound bytes).
The official context benchmark remains **43/43**, same fixture version with no family decline.

Full Jest is **4,384 passed / one failed**, with 19 existing skipped tests and one skipped suite
(452 passed suites / one failed). The failure is the desktop privileged-channel registration
guard: five raw IPC registrations in the pre-existing `app/src/main/responder/pairing-ui.ts`.
That file matches its starting dirty-file hash. Replaying frozen starting RAG sources reproduces
the same failed assertion (46 other desktop security tests pass). No guard or unrelated pairing
implementation was changed; no security-safety conclusion is inferred from this diagnostic.
The complete offline/release gate remains open. The failure and exact restoration are preserved
under `baseline/desktop-security-reproduction.*`; it is not hidden or called a green full suite.

Verification commands/results are in `verification.json`; all paired measurements are in
`measurements.json`, source faults in `mutations/results.json`, and preservation/hashes in
`dirty-preservation.json`, `qualification.json` and `manifest.json`. Installed/model/public-benchmark,
head-to-head and release claims remain Target. User configuration, prior dirty work and earlier
raw evidence are protected; the two scoped source changes and additive research documents have
exact starting bytes frozen. No staging, commit, push or installation.

Of **744** initially dirty files, **738** remain byte-identical. The six intended changes are
recall source and five research documents, with starting bytes frozen; vector-store source was
clean initially and has its own frozen baseline. The five research updates add record-95 sections
and correct an outdated current-quality sentence without deleting its historical values. All
**112 record-94** and **191 record-93** raw artifacts checked against their manifests remain
unchanged. No unexpected new or changed files and nothing staged.
