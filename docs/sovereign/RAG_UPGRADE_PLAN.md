# RAG upgrade plan — what we take from the research, and in what order

Written 2026-09-06 for PS 26117 (MRPL sovereign workbench). Every item below is traceable to a
measured result in a paper or a measurement taken on this repo. Items with neither are not in the
plan.

## The one-line finding

**The retrieval science here is already the benchmark-winning configuration. The losses are in the
plumbing.** So this plan is repairs first, one new capability second, and no architecture change at
all.

---

## 1. What the evidence says

### 1.1 Our architecture is the winner on exactly our document type

T2-RAGBench — 23,088 queries over 7,318 mixed text-and-table documents (financial, but structurally
identical to inspection reports: prose wrapped around numeric tables).

| Strategy | Recall@5 | MRR@3 |
|---|---|---|
| Dense only (text-embedding-3-large) | 0.587 | 0.351 |
| BM25 only | **0.644** | 0.411 |
| Hybrid RRF | 0.695 | 0.433 |
| **Hybrid RRF + rerank** | **0.816** | **0.605** |

Two things we take from this:

1. **BM25 beats dense retrieval on tabular/numeric documents.** Our lexical stage is not a fallback
   for when embeddings are missing — for this domain it is the stronger single signal. Nothing that
   weakens it may ship.
2. **Reranking is "the single most impactful component"** at +17.4% over unreranked hybrid. We
   already have the winning pipeline shape; see §2.1 for why we are not currently getting it.

### 1.2 Where the residual failures actually are

Error analysis of 100 sampled failures where the gold document missed hybrid-RRF top-5:

| Failure mode | Share |
|---|---|
| **Table structure mismatch** | **73%** |
| Numerical reasoning | 20% |
| Vocabulary mismatch | 5% |
| Ambiguous query / long document | 2% |

93% of what still breaks is tables and numbers. That is the entire justification for Phase 2, and it
is why chunking or embedding-model changes are not in this plan — they address the 5%.

The mechanism, stated plainly: **numbers remain tokens rather than ordered quantities.** No embedding
model ranks "7.8 mm" as *less than* "8.0 mm". A question like *"which vessels are below minimum
allowable thickness"* is not a retrieval question at all, and no amount of retrieval tuning will
answer it.

Embeddings additionally fail on out-of-vocabulary identifiers — contract references, part numbers,
`SKU-B4920` — treating them as opaque sequences that cannot be ranked semantically. Equipment tags
(`E-204`, `P-310A`) are the primary key of a refinery, so this is a first-class failure for us.

### 1.3 Contextual Retrieval

Prepending 50–100 tokens of chunk-specific context before embedding **and** before BM25 indexing:

| Configuration | Top-20 retrieval failure rate |
|---|---|
| Baseline | 5.7% |
| Contextual embeddings | 3.7% (−35%) |
| \+ contextual BM25 | 2.9% (**−49%**) |
| \+ reranking | 1.9% (**−67%**) |

We already have BM25 and a reranker, so we are on the −67% path, not the −35% one. We also already
ship a primitive version of this: every stored chunk carries a `[file · page N]` header. The upgrade
is to make that header carry *document-derived context* rather than only a location.

### 1.4 Rejected, with reasons

| Idea | Why not |
|---|---|
| RAPTOR summary nodes | Real (+20% QuALITY), but needs an LLM pass over every cluster. On an 8 GB offline box the cost lands badly. Revisit after Phase 2. |
| GraphRAG | LLM entity extraction across the whole corpus. Same objection, larger. |
| Document-level "index of index" routing | A single vector per multi-thematic document is a representation bottleneck that dilutes granular detail behind dominant themes. It adds a recall cliff stage-2 cannot recover from, at a scale where flat search is already 2 ms. |
| ANN / HNSW | Exact brute-force is fine below a few million vectors; we measured 2 ms at 1,400 chunks. Not our bottleneck. |
| Fine-tuning the embedding model | No labelled MRPL query/document pairs exist. Nothing to train on. |
| Agentic multi-hop retrieval | Multiplies calls to the local model, already the slowest component. |

---

## 2. Phase 1 — the fixes (repairs to things already built)

### 2.1 The reranker is silently dead offline — **highest measured payoff**

`rerankURLFor()` maps a base URL to `<base>/ranking`. For a local Ollama that is
`http://127.0.0.1:11434/v1/ranking`, **an endpoint Ollama does not have**. The request fails,
`vector.store.ts` swallows it with `.catch(() => null)`, and retrieval keeps the fused order.

In the sovereign configuration MRPL requires, we lose the single most impactful component and the
only symptom is `lastSearchMode().reranked === false`, which nothing surfaces.

The reranker also speaks exactly one dialect — NVIDIA's `/ranking`
(`{query:{text}, passages:[{text}]}` → `{rankings:[{index, logit}]}`). Local servers speak the
Cohere/Jina dialect instead (`{query, documents[], top_n}` → `{results:[{index, relevance_score}]}`).
vLLM serves `/rerank`, `/v1/rerank` and `/v2/rerank` in that dialect and runs BGE rerankers locally.

**Work:** speak both dialects; resolve the endpoint per provider instead of assuming one path;
degrade **loudly** (a warning naming the endpoint tried, and the state visible in `/retrieval`).

**Acceptance:** with a local rerank endpoint configured, `lastSearchMode().reranked === true`. With
none, the degradation is reported rather than silent. Both covered by tests using an injected
transport — no network in the suite.

### 2.2 Contextual Retrieval, deterministic tier — **no model cost**

A chunk reading *"Measured minimum 7.8 mm. Condition requires engineering assessment."* does not say
which vessel; the heading was three chunks earlier. That is the 5.7% → 2.9% failure class.

**Work:** carry document-derived context into every chunk before embedding and BM25 indexing —
document title, the section/sheet/slide it came from, and for tables the header row the values
belong to. Deterministic, zero model calls, so it runs on an air-gapped box at ingest speed.

A local-LLM tier (generate per-chunk context with a small model) is deliberately **out of scope**
for now: it is the expensive half of the technique and the cheap half captures the structural
failure we actually have.

**Acceptance:** a value chunk retrieves on a query naming only the equipment whose heading sits in a
different chunk. Failing that test against the old header proves it was the header that fixed it.

### 2.3 Identifier lane for equipment tags — cheap, high value

Embeddings cannot rank `E-204` semantically. BM25 partially covers this, but a tag in the query
should be a **hard filter**, not one signal among many.

**Work:** extract identifiers at ingest (pattern + glossary), index them exactly, and when a query
contains a tag, restrict candidates to chunks carrying it before ranking.

**Acceptance:** a query naming `E-204` never returns a `P-310A` passage above an `E-204` one.

---

## 3. Phase 2 — fact extraction (the new capability)

This is the 73% + 20%. Retrieval cannot answer a numeric-constraint question, so we stop trying to
make it.

**Work:** at ingest, extract typed rows alongside the prose into a table in the SQLite store we
already have:

```
(equipment_tag, property, value, unit, measured_on, source_file, locator, entry_id)
```

Then expose a `FactQueryTool` over it — gated by **the same named-template mechanism already built
for the Open Socket**, so the model selects a declared query and passes typed parameters rather than
authoring SQL. The safety design is done; this points it inward at local facts.

This turns *"which exchangers are projected below minimum before the next turnaround"* from
impossible into a `SELECT`. Every returned fact keeps `source_file` + `locator`, so a computed answer
is as citable as a quoted one.

**Acceptance:** a numeric-constraint question that flat retrieval cannot answer is answered
correctly, with citations, from a spreadsheet ingested through the Composer.

**Explicitly not in scope:** inferring units the document does not state, or computing a corrosion
rate the source does not support. A fact we did not read is not a fact.

---

## 4. Order and rationale

1. **2.1 reranker** — largest measured payoff (+17.4%), smallest change, and it repairs something
   already paid for.
2. **2.2 contextual chunks** — −49% failures on our exact failure class, zero model cost.
3. **2.3 identifier lane** — cheap, and tags are how engineers actually ask.
4. **3 fact extraction** — the differentiator, and the only item that needs new concepts.

Fixes before features, because the features are measured *on top of* a working baseline: the
Contextual Retrieval numbers assume a live reranker, so shipping 2.2 while 2.1 is broken would
measure the wrong thing.

---

## Sources

- [From BM25 to Corrective RAG: Benchmarking Retrieval Strategies for Text-and-Table Documents](https://arxiv.org/html/2604.01733v1)
- [Introducing Contextual Retrieval — Anthropic](https://www.anthropic.com/engineering/contextual-retrieval)
- [Taxonomy of the Retrieval System Framework: Pitfalls and Paradigms](https://arxiv.org/pdf/2601.20131)
- [Embeddings Aren't Magic: The Predictable Failure Modes of RAG Retrieval](https://towardsdatascience.com/embeddings-arent-magic-the-predictable-failure-modes-of-rag-retrieval-enterprise-document-intelligence-vol-1-2/)
- [RAPTOR: Recursive Abstractive Processing (ICLR 2024)](https://arxiv.org/pdf/2401.18059)
- [vLLM OpenAI-compatible server — rerank endpoints](https://docs.vllm.ai/en/v0.7.0/serving/openai_compatible_server.html)
