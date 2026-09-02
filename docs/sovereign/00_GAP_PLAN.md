# Sovereign On-Premise Agentic Workbench — Gap Plan

Target: SIH PS **26117** (MRPL) — *Sovereign On-Premise Agentic AI Workbench using Open-Weight
Multimodal LLMs for Confidential Industrial Work*.

This plan is written against the repository as it actually stands, not against the pitch. Every
"already built" row below names the file that backs it; every gap names the file that must change.

## 1. What the PS demands, and where we stand

| PS requirement | Backing code | State |
|---|---|---|
| Model-agnostic backend, many open-weight models at once | `src/core/llm.adapter.ts`, `src/core/capabilities.ts` | **Built.** One OpenAI-compatible seam; capability flags with a conservative FLOOR |
| Auto model selection per task type | `src/cli/model.router.ts`, `src/protocol/catalog.wire.ts`, `docs/ROUTING_DECISION.md` | **Partial.** Two tiers (Quick/Work) + a catalog carrying `recommendedFor` slots |
| New models addable without redesign | `src/core/capabilities.ts` (curated table + `BGW_CAP_*` overrides) | **Built** |
| Agentic multi-step planning, iteration | `src/core/agent.loop.ts`, `plan.manager.ts`, `subagent.manager.ts`, `failure.memory.ts`, `loop-detector.ts` | **Built** |
| Local tools (file r/w, search, git, LSP) | `src/tools/implementations/*` (43 tools) | **Built** |
| Code execution in a sandbox | `src/sandbox/exec.sandbox.ts` (seatbelt/bwrap, `--unshare-net` at the autonomous floor), `verify.loop.ts`, `test.healer.ts` | **Built** |
| Real deliverables (Word/Excel/PPT/PDF) | `src/documents/{docx,pptx,xlsx,pdf}.writer.ts`, `src/tools/implementations/document.tool.ts` | **Built** (untracked at time of writing) |
| Local knowledge base / grounding | `src/memory/{bm25,chunking,fusion,rerank,vector.store}.ts` | **Plumbing built, corpus + backends wrong** |
| Multimodal: scanned PDF, drawings, handwriting | `src/core/multimodal.ts` | **Input only** — raster images to a vision model; no PDF, no OCR |
| Runs entirely on-premises, nothing leaves | `src/security/network.consent.ts`, `src/evidence/ledger.ts` | **Consent-gated, not proven, and not true today** |

The last row is the load-bearing one. Today every model call defaults to
`https://integrate.api.nvidia.com/v1` (`src/core/llm.adapter.ts:250`, `src/core/container.ts:219`).
The product is a *cloud* client with excellent local tooling. That is the gap that makes the
sovereign claim false, and it is fixed first.

## 2. Phases

Ordered so each phase is demonstrable on its own and unblocks the next.

### Phase S1 — Sovereign mode and egress proof  *(start here)*

The PS states the proof is the deliverable: *"show, through logs or a visible network monitor, that
no external calls are made at any point."* A per-host consent prompt is not proof.

Build:

1. `src/security/sovereign.ts`
   - Mode resolution: env `BIMAX_SOVEREIGN` → config `sovereign` → default off.
   - `classifyDestination(url)` → `loopback | private-lan | allowlisted | external`, covering
     IPv4 loopback/RFC1918/CGNAT, IPv6 loopback/RFC4193/link-local, `.local`/`.internal`, and
     bracketed-IPv6 and userinfo-bearing URL forms.
   - `assertEgressAllowed(url, context)` → throws in sovereign mode for `external`.
2. `src/security/egress.ledger.ts` — append-only NDJSON at
   `~/.bimax/egress.ledger` recording **every** outbound attempt: timestamp, host, port,
   classification, verdict, caller (tool or subsystem), session id. Allowed *and* refused, because
   a ledger that only records refusals proves nothing about what was allowed.
3. Wiring — one choke point per egress surface:
   - `providerFetch` in `src/core/llm.adapter.ts` (all model traffic)
   - `RemoteEmbeddingBackend` / `RemoteReranker` (`src/core/container.ts`)
   - `WebFetchTool`, `WebSearchTool`, `BrowserTool`, `self.update.ts`, `netprobe.ts`
   - `src/security/network.consent.ts` delegates to `assertEgressAllowed` before it ever prompts.
4. Surfacing — `/sovereign` CLI command and `bimax sovereign report` printing mode, the
   destination classification of every configured endpoint, and a ledger summary
   (`N calls, all loopback, 0 external`).

Acceptance gate: with `BIMAX_SOVEREIGN=1`, an attempt to reach any non-local host fails **closed**
with a refusal naming the host, the ledger records it, and a full agentic task (S3's demo) runs to
completion with `external: 0` in the report. Verified with the machine's network interface down.

### Phase S2 — Local inference

Make the OpenAI-compatible seam point at a local server, and make the rest of the stack agree.

1. `src/core/local.provider.ts` — a provider profile resolving base URL from
   env `BIMAX_LOCAL_BASE_URL` → config → probe order (`:11434/v1` Ollama, `:1234/v1` LM Studio,
   `:8000/v1` vLLM), with a placeholder API key (the OpenAI SDK rejects an empty one).
2. Key-path integration: `apiKeyManager` returns the local profile when sovereign mode is on, so
   `container.ts` embeddings/rerank and `llm.adapter.ts` chat all follow without call-site edits.
3. Capability rows in `src/core/capabilities.ts` for the open-weight ids we will serve
   (`qwen3-coder`, `qwen2.5-vl`, `gpt-oss-20b`, `llama3.x`, `gemma3`), all resolving to the
   conservative FLOOR unless measured otherwise.
4. Promote the desktop's `app/src/main/local.models.ts` runtime detector (servable vs merely
   downloaded — the right distinction, already made) into the engine so the CLI shares it.
5. Preflight: refuse to start in sovereign mode when no local runtime answers, naming the runtime
   and the command that would start it. Never fall back to a cloud endpoint silently.

Acceptance gate: `BIMAX_SOVEREIGN=1` + Ollama serving → a full chat turn, a tool-calling turn, and
a document-writing turn complete with `external: 0`.

### Phase S3 — Document ingestion (scanned PDF, drawings, handwriting)

The flagship demo (*scanned inspection report → approval note*) cannot run today: nothing in the
tree reads a PDF. We can only write them.

1. `src/ingest/pdf.ts` — text-layer extraction; page rasterisation via a bundled `pdftoppm`/pdfium,
   resolved offline, never downloaded at runtime.
2. `src/ingest/ocr.ts` — local OCR behind an interface with the same honesty contract as
   `embeddings.ts`: returns null when unavailable rather than fabricating text. Backends: macOS
   Vision (already used by the computer-use stack), Tesseract, PaddleOCR/docTR on the Linux server.
3. `src/ingest/document.ts` — one entry point: path → `{ pages[], text, tables[], images[],
   provenance }`, where provenance carries page number and bounding box so a citation can name
   *"SOP-14 §3.2, p.7"* and a reader can find it.
4. `IngestTool` — exposes it to the agent; extends `src/core/multimodal.ts` beyond
   png/jpg/gif/webp to PDF and TIFF by rasterising first.
5. Route drawings/P&IDs to the vision slot; route text-layer PDFs to the cheap path. No VLM call
   for a PDF that already has selectable text.

Acceptance gate: a scanned inspection report (open sample) → extracted findings with page
citations → a `.docx` approval note produced by the existing `DocumentTool`, end to end, offline.

### Phase S4 — Local embeddings and rerank

`src/memory/embeddings.ts` is explicit: remote-first, `null` when unavailable, callers degrade to
lexical. Air-gapped, the "semantic" KB silently becomes BM25 and nothing says so at the point of
use.

1. Local embedding backend (bge-m3 / e5 via the local runtime's `/v1/embeddings` or TEI),
   preserving `EmbeddingSpaceId` stamping so vectors from two spaces are never compared.
2. Local cross-encoder rerank; `RemoteReranker` becomes one implementation of an interface.
3. Re-embed migration when the space id changes, and a visible degraded-mode banner when the
   backend is unavailable — the existing `lastSearchMode()` reported honestly to the user, not just
   to the log.

Acceptance gate: retrieval quality measured against `src/memory/eval.ts` on a fixture corpus, local
vs remote backend, both reported. Degraded mode is impossible to enter unnoticed.

### Phase S5 — Organisational knowledge base connector

The vector store is code-oriented (`sqlite.code.store.ts`, `code.index.ts`). An org corpus is a
different shape: manuals, SOPs, correspondence, with access rules.

1. Corpus ingester over a watched directory (SMB/NFS mount), incremental, resumable, using the
   existing `chunking.ts` and hybrid `fusion.ts` + `rerank.ts`.
2. Per-document classification tags and ACL enforced **at retrieval**, not at render.
3. Citations that survive into the deliverable — an approval note cites the SOP clause it relied on.

### Phase S6 — Registry-driven multi-model routing

Two slots do not satisfy *"picks the right model for a given task"* across coding / vision /
long-context / drafting. Keep the measured rule from `docs/ROUTING_DECISION.md`: routing stays
local, deterministic, ~0ms — no LLM classifier in the turn path (it cost 1.17s/turn and was removed
on evidence).

1. A declarative model manifest: id, endpoint, modalities, context window, capability flags, VRAM,
   measured tok/s. Adding a model is a manifest entry.
2. A scorer matching task requirements (detected locally, as today) against manifest capabilities.
3. A GPU-aware resident-model scheduler: N resident, LRU eviction, queued admission — the real
   constraint on a single mid-range GPU.
4. A visible routing receipt in the transcript: *"routed to qwen3-coder — code fences + repo paths
   detected; vision not required."*

### Phase S7 — Server deployment

Single-user macOS today. On-premises means: headless server mode (`src/api`, `src/auth` are the
seams), multi-user workspaces, RBAC by classification, per-user audit, browser client,
docker-compose with GPU passthrough, and an offline install bundle (`install.sh` currently fetches
from the network).

### Phase S8 — Domain deliverables

Approval-note template with reference/signature blocks, engineering calculation transcripts with
units and shown steps verified in the sandbox, inspection-report summary format. `src/documents/design.ts`
already owns the house style; these are templates on top of it, not new writers.

## 3. Demo checklist (what a judge will ask to see)

| Demo | Needs | Status |
|---|---|---|
| Model auto-selection across ≥2 task types | S2, S6 | Blocked on S2 |
| Agentic end-to-end: scanned report → approval note `.docx` | S3 | Blocked on S3 |
| Coding task run and verified in a sandbox | — | **Runs today** |
| Multimodal image / scanned document understanding | S2, S3 | Blocked |
| Proof of zero external calls | S1 | **In progress** |

## 4. Sequencing

S1 → S2 → S3 → S4 → S6 → S5 → S8 → S7.

S1 before S2 deliberately: the egress ledger is what proves S2 actually moved the traffic
on-premises, and building the proof after the claim is how the claim goes unverified.
