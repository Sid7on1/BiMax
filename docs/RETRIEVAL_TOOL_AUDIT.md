# Retrieval & Tool Audit

Measured 2026-09-12 against Bimax v1.1.0 (arm64), on the running build.
Every figure below was produced by executing code, not by inspection. 105 live model calls.

Machine: 8 GB RAM, ~2 GB free disk, macOS 25.5. Desktop is iCloud-synced.

---

## 1. Headline: dense retrieval was dead, and nothing said so

`DEFAULT_EMBEDDING_MODEL` was hardcoded to `nvidia/llama-nemotron-embed-1b-v2`.
That model answers **HTTP 410 Gone** and is absent from the provider catalogue entirely
(81 models advertised; it is not one of them).

The embeddings backend treats 410 as terminal, latches `unavailable`, and every subsequent
search silently degrades to BM25 alone. No error surfaces. The only symptom is slightly
worse answers.

Measured cost: **recall@3 1.00 -> 0.80**, MRR 0.844 -> 0.767. All three lost cases are
paraphrase queries, i.e. exactly the class embeddings exist to catch.

## 2. Retrieval quality

Labelled set: 15 documents, 4,092 chars, 15 chunks, 15 cases, k=3.
(k=3 not 5: with a 15-doc corpus, recall@5 gives a random retriever 0.33 and stops measuring.)
Same corpus, same fusion; only the embedder changes.

| Configuration | dims | recall@3 | MRR | p50/query | cold | ms/doc | chars/s | margin |
|---|---|---|---|---|---|---|---|---|
| BM25 only (state before this audit) | - | 0.80 | 0.767 | 0 ms | - | - | - | - |
| all-minilm, local **(now default)** | 384 | 0.93 | 0.811 | 12 ms | 136 ms | 15 | 17906 | +0.1277 |
| nomic-embed-text, local | 768 | 0.87 | 0.789 | 23 ms | 15804 ms | 25 | 10842 | -0.0143 |
| nemotron-3-embed-1b, remote | 2048 | 1.00 | 0.844 | 313 ms | 446 ms | 57 | 4790 | +0.1171 |

**margin** is the control: cosine(paraphrase) - cosine(unrelated) on a fixed probe pair.
A negative margin means the model ranked the UNRELATED passage as the better match.

`nomic-embed-text` scores -0.0143 because it is asymmetric and expects `search_query:` /
`search_document:` prefixes it never received. Not a capacity problem. `queryInstruction()`
in src/memory/settings.ts is the existing hook for this, currently tuned for Qwen's format.

BM25-only misses these three, all paraphrases:
  - "I enabled the permission but it still shows as disabled"
  - "the dialog just appears instead of animating in"
  - "why do I need to grant access again after every update"

## 3. Provider surface (probed with real calls)

| Probe | Result | Detail |
|---|---|---|
| `nvidia/llama-nemotron-embed-1b-v2` (was the default) | 410 | Gone; absent from catalogue |
| `nvidia/nemotron-3-embed-1b` | 200 | 2048 dims; the ONLY advertised embedder that serves |
| 4 other advertised embedders | 404 | Listed by /v1/models, not servable |
| Rerank endpoint, 3 model names | 404 | Identical function id each time -> the reranking function is not provisioned for this account |

Reranking degrades honestly: `lastSearchMode().reranked` reports false and fusion order
stands. It lifts MRR, not recall, so its absence costs ranking polish rather than found documents.

## 4. Tool surface

- registered: **50**
- sent in smart mode: **23** | sent in full mode: **47** | deferred: **25**
- destructive: 8 | concurrency-safe: 28
- index-gated and DISABLED during this run (graph not built): GraphQueryTool, GraphContextTool

Schema payload per turn:

| Mode | Tools | Bytes | ~Tokens |
|---|---|---|---|
| smart | 23 | 32,629 | 8,157 |
| full | 47 | 78,464 | 19,616 |

**Deferral saves 45,835 bytes (~11,458 tokens), 58.4%, on every turn** with no capability removed.

## 5. Tool execution latency (real calls through the built registry)

| Tool | Wall | Assertion | Note |
|---|---|---|---|
| CreateDirectoryTool | 0 ms | n/a | Successfully created directory /var/folders/_m/bbwv6 |
| TodoWriteTool | 0 ms | n/a | Tasks (0/1 done): [~] measure the tools |
| ReadFileTool | 1 ms | pass | export function alpha() {   return "needle"; }  |
| GrepTool | 1 ms | pass | Found 3 match(es) in the current directory [auto-exp |
| RelatedTestsTool | 1 ms | n/a | No test runner detected for /var/folders/_m/bbwv6gw1 |
| GlobTool | 2 ms | n/a | 1 file(s) matched **/*.ts under the current director |
| CodeSearchTool | 4 ms | n/a | alpha.ts:1-4 · alpha ``` alpha.ts :: alpha (lines 1- |
| ToolSearchTool | 7 ms | n/a | Loaded 8 tool(s) — now callable directly: <functions |
| GitTool | 9 ms | n/a | Error: not a git repository (run `git init` first). |
| BashTool | 18 ms | pass | {   "stdout": "measured",   "stderr": "" } |

Nine of ten land under 10 ms. Tool execution is not where a turn's time goes:
a single model round trip (median 2.6 s, below) costs ~250x all ten combined.

## 6. Tool selection fidelity

15 tasks with a known-correct tool, 3 passes, `nvidia/nemotron-3.5-lightning-30b-a3b`, real smart-mode schemas attached.
Graded on the first tool called.

- per-pass accuracy: **86.7% / 86.7% / 86.7%** -> spread **0 pp**
- always right: **13/15** | flaky: **0/15** | always wrong: **2/15**
- called a tool at all: **44/45**
- latency: median **2604 ms**, mean 4791 ms, worst 37499 ms
- prompt tokens per call: ~9,544 (consistent with the 8,157-token smart payload plus the task)

Deterministic failures (wrong on all 3 passes):

  - "In config.ts, change the word "foo" to "bar"." -> picked ReadFileTool
  - "Produce a Word document summarising our findin" -> picked BashTool, None, GlobTool

The config.ts one is arguably a grading artifact: reading a file before editing it is correct
agent behaviour; it was instructed to call exactly one tool.

The DocumentTool one is a genuine failure and a pointed one. `tool.registry.ts` records a
prior measurement: with DocumentTool deferred, the model reached for WriteFileTool and wrote
543 bytes of markdown into a file named `.docx`. It was promoted into the always-sent working
set to fix that. It is now fully visible and the model still does not pick it -- so visibility
was not the binding constraint, and promoting the tool cannot solve this.

## 7. Findings, by severity

### CRITICAL - Dead default, silent fallback
Shipped embedding model is 410 Gone; retrieval degrades to BM25 with nothing surfaced.
FIXED in this session: default repointed to the measured-working model.

### CRITICAL - Containment asymmetry
Against the same out-of-workspace path:
  - `WriteFileTool` -> `GOVERNOR_VETO: Path outside workspace boundary.`
  - `CreateDirectoryTool` -> `Successfully created directory /var/folders/...`
Observed once, real container, real Governor. Directory creation alone is low harm, but two
tools disagreeing about where the boundary IS means the boundary is per-tool rather than a
property of the system. NOT fixed. Wants a test in both directions.

### DEGRADED - Reranker unprovisioned
Every rerank model 404s with an identical function id. Account-level, not model-name.
Degrades honestly. Costs MRR, not recall.

### DEGRADED - First index sync is now expensive
With embeddings dead the initial CodeIndex sync was cheap because it did almost nothing.
Working embeddings make it real: **200 files indexed in ~3.5 min with 580 still pending**
on this repo. Not a regression -- it is the cost that was previously being skipped.

### HEALTHY - Deferred tools, Governor, execution latency
58.4% payload saved per turn with no capability lost; destructive tools vetoed outside the
workspace; 9/10 tools execute under 10 ms.

## 8. Changes made during this audit

- `src/memory/settings.ts` - added `embeddingBaseURL` (env `BIMAX_EMBED_BASE_URL` -> config
  `memoryEmbeddingBaseURL` -> empty). Retrieval was pinned to the chat provider's endpoint,
  forcing "who answers my prompts" and "who embeds my private corpus" to be one vendor.
- `src/memory/settings.ts` - `DEFAULT_EMBEDDING_MODEL` moved off the 410-Gone model onto
  `nvidia/nemotron-3-embed-1b` @ 2048 dims, with the measurement recorded in the comment.
- `src/core/container.ts` - a configured embeddings endpoint now outranks the chat provider
  AND does not require an API key (a loopback Ollama has no credential).
- User config - `all-minilm` @ 384 via `http://localhost:11434/v1`, previous file backed up.

No code change was needed for the dialect: `embeddingDialectFor()` already detects loopback
and drops the NVIDIA-only fields a local server rejects with a terminal 400. That path
existed with nothing pointing at it.

## 9. Method, and what these numbers are NOT

- The corpus is 15 documents. One case moves recall by 0.067. Treat small gaps as noise.
- Two harness bugs were caught mid-run, both after producing wrong numbers first:
  three vector stores sharing one persistence directory (the third measured the second's
  warm cache), and `getSchemas('smart')` called with a bare string where the API takes
  `{ mode }` -- which silently returned the full set and made deferred tools look broken.
- Tool-selection accuracy is PROVIDER-level: the model was called directly with the real
  schemas, bypassing the engine's text-tool-call recovery path. End-to-end should be >= this.
- Latency measured on a loaded machine (8 GB RAM, desktop app + Ollama + benchmarks resident).
  Ratios are sound; absolute milliseconds are an upper bound.
- An earlier single selection pass measured 66.7% with three silent turns. Within a session
  the model is stable (0 pp across 3 passes); across sessions it is not. One pass is a sample.

