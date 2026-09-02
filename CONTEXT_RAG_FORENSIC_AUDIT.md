# FORENSIC AUDIT: CONTEXT ENGINE & RAG PIPELINES

**Repository**: `Bimax`  
**Audit Type**: Forensic Codebase Implementation Audit (Final Micro-Patch)  
**Date of Inspection**: 2026-08-29  
**Guiding Architecture & Boundaries**: `docs/product-reset/README.md`, `docs/product-reset/01_CURRENT_REPO_AUDIT.md`, `docs/product-reset/05_TARGET_ARCHITECTURE.md`, `AGENTS.md`  
**Core Principle**: Runtime implementation claims in this report are derived directly from inspected source code and test files. Estimates, analytical classifications, external provider facts, and unresolved questions are explicitly labeled and are not presented as verified runtime facts.

---

## 1. Executive Summary

### 1.1 Executive Overview & Runtime Boundaries
This forensic audit documents the context management, memory, retrieval, RAG, prompt assembly, compression, embeddings, indexing, and cognitive state infrastructure in Bimax based on inspected source code.

- **Documented Architecture vs Inspected Runtime Boundary**: Repository documentation (`docs/product-reset/05_TARGET_ARCHITECTURE.md`, `AGENTS.md`) defines an architectural design where Bimax Terminal is the coding product and Bimax for Mac is the sole owner of Computer Use and native macOS accessibility APIs. Code inspection of the Terminal codebase confirms that `src/` does not register native macOS accessibility binaries or Mac control providers (`mac_control` is not registered in the CLI tool registry, [`src/cli/personas/base.persona.ts:L520-L524`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L520-L524)).
- **Dynamic Context Limits**: `ContextManager` ([`src/memory/context.manager.ts:L124-L126`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L124-L126)) has a fallback constructor default of `128,000` tokens. In runtime execution, `BasePersona.executeTurn()` ([`src/cli/personas/base.persona.ts:L577-L581`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L577-L581)) configures the window based on user config (`cfg.contextWindowTokens`) or Bimax's internal model table (`caps.contextWindow` in `src/core/capabilities.ts:L116-L184`). Compaction is triggered when the effective token ratio reaches **70%** (`COMPACT_THRESHOLD = 0.70`, [`src/memory/context.manager.ts:L81`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L81)) of that configured window.
- **Token Calibration Residual**: `ContextManager.updateTokens(promptTokens)` ([`src/memory/context.manager.ts:L138-L145`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L138-L145)) receives `event.prompt` (`gen_ai.usage.input_tokens` from OpenAI API chunk telemetry in [`src/core/llm.adapter.ts:L1163`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/llm.adapter.ts#L1163)). It computes `overheadTokens = Math.max(0, promptTokens - lastSentEstimate)`. This residual captures the difference between provider-reported prompt usage and the local estimate. Multiple unmodeled components contribute to this residual, including serialized tool schemas, assistant `tool_calls` arguments, provider message framing, and multimodal vision tokens.
- **WeakMap Token Cache Invalidation**: `countMessageTokens` ([`src/memory/context.manager.ts:L390-L404`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L390-L404)) caches `{ content, reasoning, tokens }` in a `WeakMap`. Reassigning `m.content` (e.g. replacing a tool output with a stub in `microCompact`) assigns a new string reference, causing `hit.content === m.content` to evaluate to `false` and invalidating the cached token count. Nested in-place mutations of multimodal `ContentPart[]` arrays or mutations to `tool_calls` without message object replacement are not tracked by this key comparison.
- **UserModel Assertion Confirmation Dynamic**: `UserModel.observeUserMessage()` ([`src/mind/user.model.ts:L242-L264`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/user.model.ts#L242-L264)) increments $\alpha$ by `+0.1` (`WEAK_POSITIVE`) for all assertions active in the previous turn's prompt if the user's message does not match a correction regex (`CORRECTION_RE`). This accumulation occurs regardless of whether the preference was exercised in that turn, bounded by `ALPHA_CAP = 30` and FSRS-lite time decay (120-day half-life).
- **PolicyArms Intervention Gating & Omissions**: Mind prompt blocks `selfKnowledge`, `habits`, `userModel`, `drives`, `calibration`, and `exemplars` pass through `PolicyArms.decide(id)` ([`src/mind/policy.arms.ts:L96-L102`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/policy.arms.ts#L96-L102)). Active arms display with $P = 0.90$ ($10\%$ randomized holdout), while shadow arms log without injecting tokens. Notably, `sections.journal` is constructed in `buildSections()` ([`src/cli/personas/base.persona.ts:L390`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L390)) but is omitted from `splitPrompt()` ([`src/cli/personas/base.persona.ts:L440-L451`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L440-L451)), preventing daily journal blocks from reaching model context. `harnessPatches` bypasses `PolicyArms` and injects directly when non-empty.
- **Provider Fallback Behavior**: When remote embedding (`RemoteEmbeddingBackend`) or reranking (`RemoteReranker`) fail or lack credentials, the methods return `null`, allowing `VectorStore` and `CodeIndex` to fall back to in-memory BM25 lexical search ([`src/memory/vector.store.ts:L477-L480`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/vector.store.ts#L477-L480)) and RRF retrieval candidate order ([`src/memory/vector.store.ts:L520-L537`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/vector.store.ts#L520-L537)).

---

## 2. Verified Forensic Scorecard

| Subsystem | Primary Implementation Files | Operational Classification | Runtime Execution Path & Verification Evidence |
| :--- | :--- | :--- | :--- |
| **Context Window Manager** | [`src/memory/context.manager.ts:L79-L576`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L79-L576) | **ACTIVE — UNCONDITIONAL EVALUATION** | Instantiated via `BasePersona.sessionContext` ([`src/cli/personas/base.persona.ts:L140-L147`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L140-L147)); invoked in `AgentLoop.execute` ([`src/core/agent.loop.ts:L354`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/agent.loop.ts#L354)). Evaluates 5-layer compaction under token pressure. |
| **Context Recovery Ladder** | [`src/core/agent.loop.ts:L481-L545`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/agent.loop.ts#L481-L545) | **ACTIVE — CONDITIONAL (Error Path)** | Caught in `AgentLoop.execute` when API returns 400/413 context overflow. Executes 3 escalation tiers: `reactiveDrain` $\rightarrow$ `reactiveCompact` $\rightarrow$ `truncateContext`. |
| **Prompt Assembly & Caching** | [`src/cli/personas/base.persona.ts:L178-L486`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L178-L486) | **ACTIVE — UNCONDITIONAL EVALUATION** | `BasePersona.getSystemPromptParts` partitions prompt into `staticPrefix`, `dynamicSuffix`, and `turnContext` via `splitPrompt` ([`L415-L454`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L415-L454)); `injectTurnContext` ([`L462-L486`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L462-L486)) inserts before user turn. |
| **LLM Wire Adapter & Cache Breakpoints** | [`src/core/llm.adapter.ts:L812-L1262`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/llm.adapter.ts#L812-L1262) | **ACTIVE — UNCONDITIONAL EVALUATION** | `LlmAdapter.chat` executes OpenAI SDK streaming call; calls `applyCacheBreakpoints` ([`L812-L845`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/llm.adapter.ts#L812-L845)), `normalizeNvidiaMessages` ([`L44-L66`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/llm.adapter.ts#L44-L66)), and streams chunks through `ThinkTagFilter`. |
| **Vector Memory Store** | [`src/memory/vector.store.ts:L191-L576`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/vector.store.ts#L191-L576) | **ACTIVE — UNCONDITIONAL EVALUATION** | Initialized in `createContainer` ([`src/core/container.ts:L351-L357`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/container.ts#L351-L357)); wired to `globalProjectMemory.useStore`. Persists to `.breakglass/memory/vectors.json`. |
| **Remote Embeddings Backend** | [`src/memory/embeddings.ts:L106-L220`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/embeddings.ts#L106-L220) | **RUNTIME-CAPABLE (Requires API Key)** | Initialized in `createContainer` ([`src/core/container.ts:L341-L345`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/container.ts#L341-L345)). Requires API key with `/embeddings` support. Returns `null` on error and latches disabled. |
| **Cross-Encoder Reranker** | [`src/memory/rerank.ts:L78-L166`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/rerank.ts#L78-L166) | **RUNTIME-CAPABLE (Requires API Key)** | Initialized in `createContainer` ([`src/core/container.ts:L346-L350`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/container.ts#L346-L350)). Re-scores top 24 candidates via `/ranking` or NVIDIA retrieval host. Falls back to RRF retrieval order on error. |
| **Semantic Code Index** | [`src/memory/code.index.ts:L110-L301`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/code.index.ts#L110-L301), [`src/memory/sqlite.code.store.ts:L56-L430`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/sqlite.code.store.ts#L56-L430) | **ACTIVE — CONDITIONAL (unless BIMAX_CODE_INDEX=0)** | Initialized in `createContainer` ([`src/core/container.ts:L360-L375`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/container.ts#L360-L375)) when `BIMAX_CODE_INDEX !== '0'`. Wired to `CodeSearchTool`. SQLite WAL + FTS5 + streamed int8 vector scan. |
| **PageRank RepoMap Generator** | [`src/graph/pagerank.ts:L27-L190`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/pagerank.ts#L27-L190), [`src/graph/sqlite.graph.store.ts:L31-L207`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/sqlite.graph.store.ts#L31-L207) | **ACTIVE — UNCONDITIONAL EVALUATION** | `ContextManager.checkAndCompact` ([`src/memory/context.manager.ts:L239-L246`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L239-L246)) calls `crossRepoMapSync` $\rightarrow$ `injectRepoMap`. PageRank (d=0.85, 30 iters) with focus-term boost. |
| **Involuntary Auto-Recall** | [`src/memory/recall.ts:L62-L143`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/recall.ts#L62-L143), [`src/core/agent.loop.ts:L210-L227`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/agent.loop.ts#L210-L227) | **ACTIVE — CONDITIONAL (Query Length >= 24)**| `AgentLoop.execute` $\rightarrow$ `injectRecall` runs on user turn if query $\ge 24$ chars, not slash command, and not duplicate in session. Injects `[Recalled memory]` system message. |
| **Project Memory** | [`src/memory/project.memory.ts:L10-L54`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/project.memory.ts#L10-L54) | **ACTIVE — UNCONDITIONAL EVALUATION** | Read in `BasePersona.executeTurn` ([`src/cli/personas/base.persona.ts:L558`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L558)) $\rightarrow$ `recallBlock` injected into `turnContext.memory`. Written via `RememberTool`. |
| **Persistent Goals** | [`src/memory/goal.manager.ts:L42-L137`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/goal.manager.ts#L42-L137) | **ACTIVE — UNCONDITIONAL EVALUATION** | `initGoalManager` in `src/index.ts:L155`. Read in `BasePersona.buildSections` ([`src/cli/personas/base.persona.ts:L336-L338`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L336-L338)) $\rightarrow$ `dynamicSuffix.goals`. Written via `GoalsTool` and `/goals`. |
| **Persistent Plans** | [`src/memory/plan.manager.ts:L100-L197`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/plan.manager.ts#L100-L197) | **ACTIVE — CONDITIONAL (Plan Mode)** | `initPlanManager` in `src/index.ts:L156`. Written/read via `PlanTool` and `/plan`. Plan mode enforcement banner injected into `dynamicSuffix.plan` ([`src/cli/personas/base.persona.ts:L398-L400`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L398-L400)) when `planMode` is active. |
| **File State Cache & Restoration** | [`src/memory/file-state-cache.ts:L27-L150`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/file-state-cache.ts#L27-L150) | **ACTIVE — UNCONDITIONAL EVALUATION** | Populated by `ReadFileTool`, invalidated by write tools. Read during `ContextManager.compact` ([`src/memory/context.manager.ts:L493-L525`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L493-L525)) to re-inject up to 5 small unchanged files (<50KB each, max 40KB budget). |
| **Headroom Context Compressor** | [`src/memory/headroom.compress.ts:L83-L261`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/headroom.compress.ts#L83-L261) | **ACTIVE — CONDITIONAL (Pressure >= 0.70)** | Native synchronous compressor runs under token pressure in `ContextManager.checkAndCompact` ([`src/memory/context.manager.ts:L204-L211`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L204-L211)). ML proxy runs only if `BIMAX_ENABLE_HEADROOM=1`. |
| **SelfModel** | [`src/mind/self.model.ts:L181-L378`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/self.model.ts#L181-L378) | **ACTIVE — POLICY-GATED INJECTION** | Updated on `tool_outcome` events. Injected into `turnContext.selfKnowledge` via `BasePersona.buildSections` ([`src/cli/personas/base.persona.ts:L385`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L385)) when permitted by `PolicyArms`. |
| **EpistemicLedger** | [`src/mind/epistemic.ledger.ts:L126-L377`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/epistemic.ledger.ts#L126-L377) | **ACTIVE — POLICY-GATED INJECTION** | Claims opened on file edits, settled by build/test command output paths + TDM. Injected into `turnContext.calibration` via `BasePersona.buildSections` ([`src/cli/personas/base.persona.ts:L392`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L392)) when permitted by `PolicyArms`. |
| **UserModel** | [`src/mind/user.model.ts:L104-L419`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/user.model.ts#L104-L419) | **ACTIVE — POLICY-GATED INJECTION** | Observed on user turns (`BasePersona.executeTurn:L513`). Diff taste and assertions injected into `turnContext.userModel` via `BasePersona.buildSections` ([`src/cli/personas/base.persona.ts:L387`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L387)) when permitted by `PolicyArms`. |
| **HabitMiner** | [`src/mind/habit.compiler.ts:L60-L278`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/habit.compiler.ts#L60-L278) | **ACTIVE — POLICY-GATED INJECTION** | Boundary marked on user turns (`BasePersona.executeTurn:L514`). Mined habits injected into `turnContext.habits` via `BasePersona.buildSections` ([`src/cli/personas/base.persona.ts:L386`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L386)) when permitted by `PolicyArms`. |
| **DrivesEngine** | [`src/mind/drives.engine.ts:L155-L310`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/drives.engine.ts#L155-L310) | **ACTIVE — POLICY-GATED INJECTION** | Prompt getter evaluated every turn; codebase health measurement is on-demand via `/drives`. Deviations injected into `turnContext.drives` via `BasePersona.buildSections` ([`src/cli/personas/base.persona.ts:L391`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L391)) when permitted by `PolicyArms`. |
| **HarnessTuner** | [`src/mind/harness.tuner.ts:L83-L381`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/harness.tuner.ts#L83-L381) | **ACTIVE — EVALUATED ON TURN / INJECTION CONDITIONAL** | Mined & lab-evaluated on user turns (`BasePersona.executeTurn:L516-L517`). Steering patches injected directly into `turnContext.harnessPatches` via `BasePersona.buildSections` ([`src/cli/personas/base.persona.ts:L396`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L396)) when non-empty (bypasses `PolicyArms`). |
| **ExemplarStore** | [`src/mind/exemplar.store.ts:L42-L98`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/exemplar.store.ts#L42-L98) | **ACTIVE — POLICY-GATED INJECTION** | Retrieved in `BasePersona.executeTurn` ([`src/cli/personas/base.persona.ts:L566`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L566)) $\rightarrow$ injected into `turnContext.exemplars` when permitted by `PolicyArms`. |
| **Daily Journal** | [`src/mind/daily.journal.ts:L89-L115`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/daily.journal.ts#L89-L115) | **IMPLEMENTED BUT NOT PROVEN ACTIVE** | `journalPreloadBlock()` is called in `BasePersona.buildSections` ([`src/cli/personas/base.persona.ts:L390`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L390)) and assigned to `sections.journal`, but `sections.journal` is omitted from `splitPrompt()` ([`src/cli/personas/base.persona.ts:L440-L451`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L440-L451)) and never enters model context. |
| **Self-Critic Pass** | [`src/cli/personas/base.persona.ts:L633-L650`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L633-L650) | **ACTIVE — CONDITIONAL (Off by Default)** | Toggled via `/self-critic` (`src/cli/selfCritic.ts:L6`). When enabled, executes one auxiliary model completion after agent execution log $> 40$ chars. |
| **Taint Tracking Subsystem** | [`src/mind/taint.ts:L36-L107`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/taint.ts#L36-L107) | **ACTIVE — UNCONDITIONAL TRACKING** | Marked via `markToolTaint` on WebFetch/WebSearch/MCP tool execution. Restricts network-capable Bash commands in `Governor`. |
| **CodememBackend** | [`src/graph/codemem/backend.ts:L43-L275`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/codemem/backend.ts#L43-L275) | **FALLBACK TO NATIVE GRAPH** | `globalCodemem.init()` in `src/index.ts:L157`. If `codebase-memory` MCP binary is absent, `isReady()` returns `false` and all graph operations fall back to native SQLite/in-memory graph. |
| **CognitiveGraph** | [`src/graph/cognitive.graph.ts`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/cognitive.graph.ts) | **DEAD / UNUSED** | Unused class with zero callers found in inspected runtime paths. |

---

## 3. Verified Runtime Architecture

```mermaid
flowchart TD
    subgraph Execution Entry Points
        CLI[bin/bimax.js -> src/index.ts: main]
        TUI[Go Bubble Tea TUI / CLI Print Mode]
        ACP[Agent Client Protocol: src/acp/server.ts]
    end

    CLI --> Container[createContainer: src/core/container.ts]
    TUI --> Container
    ACP --> Container

    subgraph Service Container Wiring
        Container --> LLM[LlmAdapter: src/core/llm.adapter.ts]
        Container --> Emb[RemoteEmbeddingBackend: src/memory/embeddings.ts]
        Container --> Rerank[RemoteReranker: src/memory/rerank.ts]
        Container --> VStore[VectorStore: src/memory/vector.store.ts]
        Container --> CodeIdx[CodeIndex: src/memory/code.index.ts]
        Container --> Graph[SqliteGraphStore: src/graph/sqlite.graph.store.ts]
        Container --> Reg[ToolRegistry: src/tools/tool.registry.ts]
        Container --> Gov[Governor: src/governor/governor.ts]
    end

    subgraph Turn Execution in BasePersona
        UserTurn[User Message Received] --> ExecTurn[BasePersona.executeTurn: src/cli/personas/base.persona.ts]
        ExecTurn --> RecallStep[globalProjectMemory.recallBlock + ExemplarStore.retrieve]
        ExecTurn --> BuildPrompt[BasePersona.buildSections -> splitPrompt]
        BuildPrompt --> Partition[staticPrefix | dynamicSuffix | turnContext]
        Partition --> LoopInit[new AgentLoop: src/core/agent.loop.ts]
    end

    subgraph Agent Loop Turn Lifecycle
        LoopInit --> AutoRec[injectRecall: VectorStore Semantic Search]
        AutoRec --> CM[ContextManager.checkAndCompact: src/memory/context.manager.ts]
        CM --> Headroom[Layer 0: Headroom Backlog Compression]
        Headroom --> Cap[Layer 1: capToolResults >16k chars]
        Cap --> Micro[Layer 2: microCompact old tool stubs]
        Micro --> Snip[Layer 3: snip message history >100]
        Snip --> RepoMap[injectRepoMap: PageRank Top Symbols]
        RepoMap --> CompCheck{Tokens >= 70%?}
        CompCheck -- Yes --> Compact[Layer 4: 5-Section LLM Summary + File Restoration]
        CompCheck -- No --> InjTC[injectTurnContext: Anchored before User Turn]
        Compact --> InjTC
    end

    subgraph Model Wire Boundary
        InjTC --> Breakpoints[applyCacheBreakpoints: Ephemeral markers for Anthropic]
        Breakpoints --> NvidiaNorm[normalizeNvidiaMessages: Role shaping for NIM]
        NvidiaNorm --> WireReq[OpenAI SDK chat.completions.create]
        WireReq --> StreamGen[chat streaming async generator]
    end

    subgraph Stream & Tool Execution
        StreamGen --> ThinkFilter[ThinkTagFilter: Reasoning tag isolation]
        ThinkFilter --> ToolCallDispatch[Dispatch Parallel Read / Sequential Mutate Tools]
        ToolCallDispatch --> TaintMark[markToolTaint: Web & MCP Provenance]
        ToolCallDispatch --> FSCache[FileStateCache: Update reads & invalidate writes]
        ToolCallDispatch --> EvLedger[EventLedger: Record tool_outcome]
        EvLedger --> MindUpdate[SelfModel / EpistemicLedger / HabitMiner updates]
    end
```

---

## 4. Runtime Entry Point Inventory

| Entry Point | Source File & Lines | Mode / Flag | Container Construction | Context & Model Interaction |
| :--- | :--- | :--- | :--- | :--- |
| **CLI Interactive (TUI)** | [`bin/bimax.js:L1-L35`](file:///Users/vishsiddharth/Desktop/Bimax/bin/bimax.js#L1-L35) $\rightarrow$ `tui/bimax-tui` $\rightarrow$ `src/index.ts:L103-L211` | Default interactive | `createContainer(config)` at [`src/index.ts:L142`](file:///Users/vishsiddharth/Desktop/Bimax/src/index.ts#L142) | Spawns interactive agent session with `BasePersona`, `AgentLoop`, and NDJSON IPC stdio. |
| **CLI Print Mode (One-Shot)** | [`src/index.ts:L170-L195`](file:///Users/vishsiddharth/Desktop/Bimax/src/index.ts#L170-L195) | `-p`, `--print <prompt>` | `createContainer(config)` at [`src/index.ts:L142`](file:///Users/vishsiddharth/Desktop/Bimax/src/index.ts#L142) | Executes single prompt turn via `BasePersona.ask()` and prints completion to stdout. |
| **Headless Daemon** | [`src/index.ts:L196-L204`](file:///Users/vishsiddharth/Desktop/Bimax/src/index.ts#L196-L204) | `--headless` | `createContainer(config)` at [`src/index.ts:L142`](file:///Users/vishsiddharth/Desktop/Bimax/src/index.ts#L142) | Runs NDJSON protocol over stdin/stdout for Go TUI or desktop integration. |
| **Agent Client Protocol (ACP)** | [`src/index.ts:L205-L211`](file:///Users/vishsiddharth/Desktop/Bimax/src/index.ts#L205-L211) $\rightarrow$ [`src/acp/server.ts`](file:///Users/vishsiddharth/Desktop/Bimax/src/acp/server.ts) | `--acp` | `createContainer(config)` at [`src/index.ts:L142`](file:///Users/vishsiddharth/Desktop/Bimax/src/index.ts#L142) | Runs JSON-RPC protocol over stdio for IDE extensions (Zed, VS Code). |
| **MCP Server Mode** | [`src/index.ts:L123-L135`](file:///Users/vishsiddharth/Desktop/Bimax/src/index.ts#L123-L135) | `bimax mcp` | Lightweight MCP container | Exposes Bimax code graph and search tools as an MCP server. |

---

## 5. Model Invocation Inventory

| Invocation Site | Source Location | API / Method | Payload Builder | Production Caller Chain | Trigger Condition | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Main Agent Loop Stream** | [`src/core/llm.adapter.ts:L812-L1262`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/llm.adapter.ts#L812-L1262) | `client.chat.completions.create({ stream: true })` | `LlmAdapter.chat()` | `BasePersona.executeTurn` $\rightarrow$ `AgentLoop.execute` $\rightarrow$ `LlmAdapter.chat` | Every active agent turn | **ACTIVE — UNCONDITIONAL** |
| **Layer 4 Compaction Summarizer** | [`src/memory/context.manager.ts:L442-L460`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L442-L460) | `LlmAdapter.generateChatResponse()` | `ContextManager.compact()` | `AgentLoop.execute` $\rightarrow$ `ContextManager.checkAndCompact` $\rightarrow$ `compact` | `effectiveTokens / MAX_TOKENS > 0.70` | **ACTIVE — CONDITIONAL (Token Pressure)** |
| **Self-Critic Pass** | [`src/cli/personas/base.persona.ts:L761-L771`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L761-L771) | `LlmAdapter.chatCompletion({ lite: true })` | `BasePersona.critique()` | `BasePersona.executeTurn` $\rightarrow$ `this.critique()` | `/self-critic` enabled AND execution log $> 40$ chars | **ACTIVE — CONDITIONAL (Off by Default)** |
| **Graph Semantic Augmenter** | [`src/core/llm.adapter.ts:L672-L714`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/llm.adapter.ts#L672-L714) | `client.chat.completions.create()` (non-streaming) | `SemanticAugmenter.augmentGraph()` | `/index` command $\rightarrow$ `GraphIndexer.augmentGraph()` | On-demand indexing command | **ACTIVE — CONDITIONAL (On-Demand)** |
| **Lightweight Conversation Lane** | [`src/cli/personas/base.persona.ts:L695-L732`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L695-L732) | `LlmAdapter.chat({ lite: true })` | `BasePersona.converse()` | `HeadlessSession.handleTurn` ([`src/protocol/headless.session.ts:L158`](file:///Users/vishsiddharth/Desktop/Bimax/src/protocol/headless.session.ts#L158)) | Headless session fast conversation turn | **ACTIVE — CONDITIONAL (Headless Mode)** |
| **Remote Embeddings** | [`src/memory/embeddings.ts:L164-L184`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/embeddings.ts#L164-L184) | `POST /embeddings` (fetch) | `RemoteEmbeddingBackend.embedBatch()` | `VectorStore.storeDocuments` / `CodeIndex.sync` | Batch embedding generation (max 64 strings) | **RUNTIME-CAPABLE (Requires API Key)** |
| **Remote Cross-Encoder Reranker** | [`src/memory/rerank.ts:L118-L135`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/rerank.ts#L118-L135) | `POST /ranking` (fetch) | `RemoteReranker.rerank()` | `VectorStore.semanticSearch` / `CodeSearchTool` | Semantic retrieval candidate reordering | **RUNTIME-CAPABLE (Requires API Key)** |

---

## 6. Prompt Assembly Pipeline

### 6.1 Section Breakdown
`BasePersona.buildSections()` ([`src/cli/personas/base.persona.ts:L178-L404`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L178-L404)) constructs the following discrete blocks:

1. **`staticPrefix`** (Cache Block 1):
   - `role`: Agent identity and role description ([`L266`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L266)).
   - `identity`: Autonomous CLI agent declaration; vendor disclaimers ([`L267`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L267)).
   - `triage`: Message categorization (CHAT/QUESTION/TASK), 5-step workflow (CONTRACT $\rightarrow$ ORIENT $\rightarrow$ INVESTIGATE $\rightarrow$ ACT/VERIFY $\rightarrow$ REPORT) ([`L269-L275`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L269-L275)).
   - `output`: Strict no-narration contract, todo list maintenance, closing wrap-up requirements ([`L276`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L276)).
   - `honesty`: Verification gates, no false completion claims ([`L277`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L277)).
   - `engineering`: Senior engineering standards, minimal diffs, secrets hygiene ([`L280`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L280)).
   - `security`: Governor safety policy awareness ([`L281`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L281)).

2. **`dynamicSuffix`** (Cache Block 2):
   - `environment`: CWD, OS platform, codebase detection status ([`L268`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L268)).
   - `projectGuide`: Contents of `AGENTS.md` or `CLAUDE.md` if present ([`L319-L323`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L319-L323)).
   - `tools`: Sent tool definitions and graph tool usage rules ([`L278`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L278)).
   - `loadOnDemand`: Deferred tool list in smart context mode ([`L313-L314`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L313-L314)).
   - `skills`: Installed capability packs from `SkillService` ([`L288-L293`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L288-L293)).
   - `mcp`: Connected MCP tool declarations ([`L298-L308`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L298-L308)).
   - `pathRules`: In-codebase vs general directory confinement rules ([`L261-L264`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L261-L264)).
   - `goals`: Active persistent cross-session goals from `GoalManager` ([`L336-L338`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L336-L338)).
   - `workspace`: Multi-repository workspace map if active ([`L343-L346`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L343-L346)).
   - `agentMode`: Mode specialization (explore vs code) ([`L369-L371`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L369-L371)).
   - `plan`: Read-only plan mode enforcement banner ([`L398-L400`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L398-L400)).

3. **`turnContext`** (Volatile Turn Block):
   - `memory`: Project conventions recalled via `globalProjectMemory.recallBlock(prompt)` ([`L558`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L558)).
   - `exemplars`: Similar verified past tasks from `ExemplarStore` ([`L566`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L566)).
   - `selfKnowledge`: Tool weak spots from `SelfModel` ([`L385`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L385)).
   - `habits`: Compiled procedural macros from `HabitMiner` ([`L386`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L386)).
   - `userModel`: Learned user preferences from `UserModel` ([`L387`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L387)).
   - `drives`: Measured codebase deviations from `DrivesEngine` ([`L391`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L391)).
   - `calibration`: Overconfident domains from `EpistemicLedger` ([`L392`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L392)).
   - `harnessPatches`: Active steering patches from `HarnessTuner` ([`L396`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L396)).
   - `todos`: Live session task checklist ([`L352`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L352)).
   - `outcome`: Active outcome contract and completion gates ([`L361`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L361)).

---

## 7. Conversation / History Pipeline

### 7.1 Message Ordering Invariant
The message array passed to `LlmAdapter.chat()` obeys the following structural sequence:
1. `role: 'system'` (System message containing `staticPrefix` + `\n\n` + `dynamicSuffix`).
2. Historical turns: `role: 'user'`, `role: 'assistant'` (with `tool_calls`), `role: 'tool'` (with `tool_call_id`).
3. `role: 'system'` (Updated `[RepoMap]` PageRank outline, injected before latest user turn).
4. `role: 'system'` (Updated `[TurnContext]` cognitive block, injected before latest user turn).
5. `role: 'user'` (Latest user prompt + optional multimodal image parts).
6. Execution rounds: Appends assistant `tool_calls` and corresponding `tool` result messages.

---

## 8. Context Window Management & Token Accounting

### 8.1 Layer-by-Layer Compaction Trace
- **Layer 0 (Headroom Backlog Compression)**: Triggered when `pressureRatio >= 0.70`. Collapses runs of $\ge 4$ repetitive log lines; code is protected via `looksLikeCode()` ([`src/memory/headroom.compress.ts:L133-L144`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/headroom.compress.ts#L133-L144)).
- **Layer 1 (Tool Result Capping)**: Slices non-code tool results $> 16,000$ characters to 8k head + 8k tail ([`src/memory/context.manager.ts:L285-L299`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L285-L299)).
- **Layer 2 (Micro-Compaction)**: Triggered when `pressureRatio >= 0.50`. Replaces tool results older than the last 6 with structured stubs ([`src/memory/context.manager.ts:L306-L343`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L306-L343)).
- **Layer 3 (History Snipping)**: Triggered when non-system messages exceed 100. Slices history to the last 60 messages, dropping leading orphan tool results ([`src/memory/context.manager.ts:L364-L384`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L364-L384)).
- **Layer 4 (Proactive LLM Compaction)**: Triggered when `pressureRatio > 0.70` after cheap passes. Invokes `LlmAdapter.generateChatResponse()` with 5-section prompt (`Goal`, `Progress`, `Key Decisions`, `Next Steps`, `Relevant Files`), strips transient system messages, and restores up to 5 small unchanged files from `FileStateCache` ([`src/memory/context.manager.ts:L414-L543`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L414-L543)).

### 8.2 Token Accounting & Cache Invalidation
- `countMessageTokens` ([`src/memory/context.manager.ts:L390-L404`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L390-L404)) encodes `${contentToText(m.content)}${m.reasoning_content || ''}` with `gpt-tokenizer`.
- Results are stored in `tokenCache = new WeakMap<object, { content, reasoning, tokens }>()`.
- Because JavaScript strings are immutable, any modification to `m.content` creates a new string reference, causing `hit.content === m.content` to evaluate to `false` and invalidating the cache immediately.
- `overheadTokens` captures the residual between provider-reported prompt usage (`event.prompt`) and the local estimate (`lastSentEstimate`); contributors not represented by the local estimator include serialized tool schemas, assistant `tool_calls` arguments, provider message framing, and multimodal vision tokens.

---

## 9. Tool Result Context Pipeline

### 9.1 Sanitization & Error Handling
- Tool outputs are sanitized via `sanitizeToolArgs()` to strip invalid control characters.
- Results exceeding 100KB are previewed; files $> 1\text{ MB}$ offload full content to `/tmp/bimax-file-<hash>.txt` ([`src/tools/implementations/file.tool.ts:L96-L120`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/file.tool.ts#L96-L120)).
- `FreeContextTool` ([`src/tools/implementations/free-context.tool.ts`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/free-context.tool.ts)) allows the model to explicitly release tool result bodies in place or mark files as evicted from post-compact restoration.

---

## 10. Screenshot / Multimodal Context

### 10.1 Image Pipeline
- When browser tools (`BrowserTool`) or desktop tools return base64 images, `buildScreenshotObservation()` attaches the image part to the user turn ([`src/core/agent.loop.ts:L780-L840`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/agent.loop.ts#L780-L840)).
- `pruneScreenshotObservations()` keeps only the single most recent screenshot in active context, pruning older images to conserve token budget.

---

## 11. Long-Term Memory

### 11.1 VectorStore Architecture
- **Location**: `.breakglass/memory/vectors.json`.
- **Pipeline**: Chunking $\rightarrow$ in-memory BM25 (`Bm25Index`) + Dense Cosine (`RemoteEmbeddingBackend`) $\rightarrow$ Reciprocal Rank Fusion ($k=60$) $\rightarrow$ Cross-encoder Reranking (`RemoteReranker`).
- **LRU Eviction**: Sorted by `lastUsedAt` when document count exceeds 500 (`MAX_VECTORS`).

---

## 12. Project Memory

### 12.1 ProjectMemory Conventions
- Backed by `VectorStore` tagged with `project-memory` ([`src/memory/project.memory.ts:L34`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/project.memory.ts#L34)).
- Written via `RememberTool` (`src/tools/implementations/remember.tool.ts`).
- Read on each turn via `globalProjectMemory.recallBlock(prompt)` and injected into `turnContext.memory`.

---

## 13. Semantic Code Retrieval

### 13.1 CodeIndex & SqliteCodeVectorStore
- **Location**: `.breakglass/memory/code-index.db`.
- **Chunking**: Declaration-boundary chunking (80 lines, 10 overlap) with contextual header `path :: symbol (lines)` ([`src/memory/code.index.ts:L323-L363`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/code.index.ts#L323-L363)).
- **Storage**: SQLite FTS5 table `fts` + int8 quantized vector blob table `embs` ([`src/memory/sqlite.code.store.ts:L90-L104`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/sqlite.code.store.ts#L90-L104)).
- **Zero-Resident RAM Scan**: Scans int8 vectors from disk per query, dequantizing into a reused `Float32Array` scratch buffer.
- **Incremental Sync**: Uses `.breakglass/memory/code-index.db.manifest.json` tracking `mtime` and `size` to only re-index changed files.

---

## 14. Corrected RAG Classification Taxonomy

| Subsystem | RAG Taxonomy Class | Context Injection Mechanism | Ground Truth Operational Behavior |
| :--- | :--- | :--- | :--- |
| **Involuntary Auto-Recall** | **AUTOMATIC RAG** | Injected before user turn (`[Recalled memory]`) | Query automatically extracted from user turn $\rightarrow$ VectorStore search $\rightarrow$ results injected into system prompt before model generates. |
| **Project Memory** | **AUTOMATIC RAG** | Injected into `[TurnContext]` (`### PROJECT MEMORY`) | User prompt automatically queried against `VectorStore` (tag: `project-memory`) $\rightarrow$ results formatted into prompt block before model generates. |
| **Exemplar Retrieval** | **AUTOMATIC RAG** | Injected into `[TurnContext]` (`### VERIFIED EXPERIENCE`) | User prompt automatically embedded via hash kernel $\rightarrow$ nearest verified past episodes retrieved $\rightarrow$ injected into prompt before model generates. |
| **CodeSearchTool** | **TOOL-MEDIATED RAG** | Appended as `role: 'tool'` message | Model explicitly requests retrieval via tool call $\rightarrow$ `SqliteCodeVectorStore` searches FTS5 + int8 vectors $\rightarrow$ results appended to history $\rightarrow$ subsequent generation conditioned on results. |
| **MemoryQueryTool** | **TOOL-MEDIATED RAG** | Appended as `role: 'tool'` message | Model explicitly requests memory search via tool call $\rightarrow$ `VectorStore` searches hybrid index $\rightarrow$ results appended to history $\rightarrow$ subsequent generation conditioned on results. |
| **RepoMap Outline** | **REPOSITORY MAP** | Injected before user turn (`[RepoMap]`) | PageRank computes top symbols across reference graph with focus-term boost $\rightarrow$ injected as structural context. |
| **UserModel / SelfModel** | **AGENT STATE** | Injected into `[TurnContext]` | Aggregated statistical models (Beta posteriors, diff taste) formatted into prompt blocks. |

---

## 15. Embeddings

### 15.1 Remote & Local Embedders
- **Remote (`RemoteEmbeddingBackend`)**: OpenAI/NVIDIA compatible `/embeddings`, Matryoshka 768d, `input_type: 'query' | 'passage'`, `truncate: 'END'`, batching 64, unit normalized dot product.
- **Local (`src/mind/embedder.ts`)**: Fixed 256d FNV-1a feature-hashing kernel with sign trick and L2 normalization for `ExemplarStore` and `UserModel`.

---

## 16. Reranking

### 16.1 RemoteReranker
- Evaluates top 24 candidates via `/ranking` or NVIDIA retrieval host (`NVIDIA_RERANK_URL`).
- Fuses logit order with retrieval ranks using guarded RRF ($w_{\text{retrieval}} = 1.25, w_{\text{rerank}} = 1.0$) to avoid instability.

---

## 17. RepoMap / Graph Context

### 17.1 PageRank & Cross-Repo Sync
- **Algorithm**: Iterative PageRank ($N$ nodes, damping $d=0.85$, $30$ iterations).
- **Topology Memoization**: `_prCache` and `_mapCache` memoize results keyed on graph node/edge counts.
- **Focus Boost**: Terms extracted from user prompt (`focusTermsFromMessages`) boost relevant symbols to the top.

---

## 18. Mind Engine Context & PolicyArms Gating

### 18.1 PolicyArms Mechanics
- Mind prompt blocks `selfKnowledge`, `habits`, `userModel`, `drives`, `calibration`, and `exemplars` pass through `PolicyArms.decide(id)` ([`src/mind/policy.arms.ts:L96-L102`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/policy.arms.ts#L96-L102)).
- **Active Arms**: Render with $P = 1 - \text{holdout} = 0.90$ ($10\%$ randomized holdout budget to evaluate counterfactual lift).
- **Shadow Arms**: Always return `show: false`, logging what they would have injected to `.bimax/mind/events.jsonl` without consuming prompt tokens.
- **IPS Scoring**: `PolicyArms` computes a self-normalized inverse propensity scoring (SN-IPS) estimate using the implemented show/hide weighting formula $V(\text{show}) - V(\text{hide})$ from episode success ratios ($\ge 0.80$ tool success).
- **Bypass / Omission Paths**: `harnessPatches` bypasses `PolicyArms` and is injected directly when non-empty. `sections.journal` is gated by `PolicyArms.decide('journal')` but is omitted from `splitPrompt()` and never reaches the model.

---

## 19. State / Telemetry / Memory Classification

| Component | Storage File | Classification | LLM-Visible? | Ground Truth Function |
| :--- | :--- | :--- | :--- | :--- |
| `EventLedger` | `.bimax/mind/events.jsonl` | **Telemetry** | No | Append-only raw event ledger for offline analysis and lab eval. |
| `SelfModel` | `.bimax/self-model.json` | **Agent State** | Yes (Summary) | Beta posterior failure rates injected into prompt. |
| `EpistemicLedger` | `.bimax/epistemic.json` | **Agent State** | Yes (Summary) | Calibration metrics and escalation rules injected into prompt. |
| `UserModel` | `.bimax/user-model.json` | **Agent State** | Yes (Summary) | Diff taste and preference assertions injected into prompt. |
| `HabitMiner` | `.bimax/habits.json` | **Agent State** | Yes (Summary) | Mined procedural macros injected into prompt. |
| `DrivesEngine` | `.bimax/drives.json` | **Agent State** | Yes (Summary) | Setpoint deviations injected into prompt. |
| `HarnessTuner` | `.bimax/harness-patches.json` | **Agent State** | Yes (Summary) | Active lab-verified steering patches injected into prompt. |
| `ExemplarStore` | `.bimax/exemplars.json` | **Retrieval Memory** | Yes (Retrieved) | Past verified episodes retrieved via hash-kernel similarity. |
| `ProjectMemory` | `.breakglass/memory/vectors.json` | **Retrieval Memory** | Yes (Retrieved) | Conventions and decisions retrieved via hybrid RAG. |
| `FileStateCache` | In-Memory (`Map`) | **Cache / Restoration**| Yes (Restored) | Caches file reads and restores recent files post-compaction. |

---

## 20. Context Source Budget Map

| Context Source | Automatic / Tool-Mediated | Hard Maximum / Enforced Limit | Selection Count Limit | Typical / Estimated Size | Size Provenance Classification | Injection Location | Suppression Condition | Auditor Security Interpretation | Verified Citation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`staticPrefix`** | Automatic | Uncapped | N/A | ~800–1,200 tokens | **ESTIMATE** | `messages[0]` (System) | None | System Rules | [`src/cli/personas/base.persona.ts:L416-L424`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L416-L424) |
| **`dynamicSuffix`** | Automatic | Uncapped | N/A | ~2,000–3,500 tokens | **ESTIMATE** | `messages[0]` (System) | Mode / config dependent | Workspace Context | [`src/cli/personas/base.persona.ts:L426-L438`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L426-L438) |
| **`AGENTS.md` Guide** | Automatic | No explicit application-level cap found | 1 file | Varies by repo | **ESTIMATE** | `dynamicSuffix.projectGuide`| Missing guide file | Repository Spec | [`src/cli/personas/base.persona.ts:L319-L323`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L319-L323) |
| **Persistent Goals** | Automatic | Capped per goal list | All active goals | ~200–600 tokens | **ESTIMATE** | `dynamicSuffix.goals` | No active goals | User Intent | [`src/memory/goal.manager.ts:L122-L137`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/goal.manager.ts#L122-L137) |
| **Tool Schemas** | Automatic | Provider API limit | All active tools | ~2k–8k tokens | **ESTIMATE** | API `tools` parameter | Deferred in smart mode | Tool Definitions | [`src/tools/tool.registry.ts:L150-L190`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/tool.registry.ts#L150-L190) |
| **Auto-Recall** | Automatic | 1,800 chars budget | Top 3 hits | ~720 chars typical | **CONFIGURED (Budget) / ESTIMATE (Typical)** | System msg before User | Query $< 24$ chars / dup | Historical Facts | [`src/memory/recall.ts:L62-L143`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/recall.ts#L62-L143) |
| **Project Memory** | Automatic | 720 chars ($3 \times 240\text{ chars}$) | Top 3 hits | $\le 720$ chars | **CALCULATED (Enforced Cap)** | `turnContext.memory` | No memory matches | Project Conventions | [`src/memory/project.memory.ts:L34-L54`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/project.memory.ts#L34-L54) |
| **RepoMap Outline** | Automatic | 1,500 tokens | Top PageRank nodes | $\le 1,500$ tokens | **CONFIGURED** | System msg before User | No indexed graph | Code Structure | [`src/graph/pagerank.ts:L120-L188`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/pagerank.ts#L120-L188) |
| **Exemplars** | Automatic | Top 2 episodes | 2 episodes | ~400–800 tokens | **ESTIMATE** | `turnContext.exemplars` | Holdout / Sim $< 0.22$ | Past Solutions | [`src/mind/exemplar.store.ts:L42-L98`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/exemplar.store.ts#L42-L98) |
| **SelfModel** | Automatic | Top 5 failure rules | 5 rules | ~150–300 tokens | **ESTIMATE** | `turnContext.selfKnowledge`| Holdout / No weak spots | Empirical Failure | [`src/mind/self.model.ts:L355-L378`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/self.model.ts#L355-L378) |
| **UserModel** | Automatic | Top 6 rules + conflict | 6 assertions | ~200–400 tokens | **ESTIMATE** | `turnContext.userModel` | Holdout / No assertions | User Preferences | [`src/mind/user.model.ts:L360-L419`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/user.model.ts#L360-L419) |
| **HabitMiner** | Automatic | Top 4 recipes | 4 macros | ~150–300 tokens | **ESTIMATE** | `turnContext.habits` | Holdout / Count $< 4$ | Procedural Macros | [`src/mind/habit.compiler.ts:L240-L278`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/habit.compiler.ts#L240-L278) |
| **DrivesEngine** | Automatic | Top deviations | Active deviations | ~100–250 tokens | **ESTIMATE** | `turnContext.drives` | Holdout / Normal state | Codebase Health | [`src/mind/drives.engine.ts:L280-L310`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/drives.engine.ts#L280-L310) |
| **EpistemicLedger** | Automatic | Top 3 domains | 3 domains | ~100–250 tokens | **ESTIMATE** | `turnContext.calibration` | Holdout / Balanced | Calibration State | [`src/mind/epistemic.ledger.ts:L340-L377`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/epistemic.ledger.ts#L340-L377) |
| **HarnessTuner** | Automatic | Max 6 active patches | 6 patches | ~150–350 tokens | **ESTIMATE** | `turnContext.harnessPatches`| No lab-winning patches | Steering Patches | [`src/mind/harness.tuner.ts:L350-L381`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/harness.tuner.ts#L350-L381) |
| **Todo Checklist** | Automatic | Full active list | Session active list | Varies by session | **ESTIMATE** | `turnContext.todos` | Empty todo list | Plan State | [`src/cli/personas/base.persona.ts:L352`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L352) |
| **Outcome Contract** | Automatic | Active criteria | Active contract | Varies by task | **ESTIMATE** | `turnContext.outcome` | Simple chat / No contract | Acceptance Spec | [`src/cli/personas/base.persona.ts:L361`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L361) |
| **Tool Results** | Tool-Mediated | 16,000 chars / call | Per executed tool | Up to 16,000 chars | **CONFIGURED** | `role: 'tool'` messages | Micro-compacted $> 6$ rounds | Execution Output | [`src/memory/context.manager.ts:L285-L299`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L285-L299) |
| **Screenshots** | Tool-Mediated | 4 MB per image | 1 image | Up to 4 MB data URL | **CONFIGURED** | Multimodal image part | Text-only model / Pruned | Untrusted Visual UI | [`src/core/multimodal.ts:L151-L240`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/multimodal.ts#L151-L240) |
| **Restored Files** | Automatic | 40,000 chars (~10k tok)| Max 5 files (<50KB)| Up to 40,000 chars | **CONFIGURED (Chars) / CALCULATED (Tok)** | `[Post-Compact Restoration]` | Changed `mtime` on disk | Verbatim Source | [`src/memory/context.manager.ts:L493-L525`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L493-L525) |
| **Compaction Summary** | Automatic | Uncapped summary | 1 5-section summary| ~800–1,500 tokens | **ESTIMATE** | `[Previous Context Summary]`| Compaction not triggered | Compressed History | [`src/memory/context.manager.ts:L442-L460`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L442-L460) |
| **Web / MCP Content** | Tool-Mediated | Tool output buffer | Per executed tool | Varies by tool | **ESTIMATE** | `role: 'tool'` messages | Tainted on ingest | Remote Untrusted | [`src/mind/taint.ts:L69-L81`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/taint.ts#L69-L81) |

---

## 21. Persistence Survival Matrix

| State / Subsystem | Survives Next Turn? | Survives Compaction? | Survives Process Restart? | Retrieval Required? | Direct Prompt Injection? | Storage Location & Engine | Write Path Citation | Read Path Citation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Raw Conversation History** | Yes | Sliced (Keeps tail) | No | No | History Array | In-Memory (`BasePersona.messages`) | [`src/cli/personas/base.persona.ts:L551`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L551) | [`src/cli/personas/base.persona.ts:L123`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L123) |
| **Compacted Summary** | Yes | Replaced by new summary| No | No | Yes (`[Previous Context Summary]`)| In-Memory (`ContextManager`) | [`src/memory/context.manager.ts:L460`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L460) | [`src/memory/context.manager.ts:L105`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L105) |
| **Tool Execution Results** | Yes | Stubbed after 6 rounds | No | No | Yes (`role: 'tool'`) | In-Memory (`AgentLoop`) | [`src/core/agent.loop.ts:L910`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/agent.loop.ts#L910) | [`src/memory/context.manager.ts:L306-L343`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L306-L343) |
| **Screenshot Observations** | Yes (Latest only)| Pruned to 1 image | No | No | Yes (`type: 'image_url'`) | In-Memory (`AgentLoop`) | [`src/core/agent.loop.ts:L805`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/agent.loop.ts#L805) | [`src/core/multimodal.ts:L210-L240`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/multimodal.ts#L210-L240) |
| **FileStateCache** | Yes | Restores top 5 files | No | No | Yes (`[Post-Compact Restoration]`)| In-Memory (`Map<string, Entry>`) | [`src/tools/implementations/file.tool.ts:L85`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/file.tool.ts#L85) | [`src/memory/context.manager.ts:L493`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L493) |
| **VectorStore Memory** | Yes | Yes | Yes | Yes | Yes (via Auto-Recall) | `.breakglass/memory/vectors.json` | [`src/memory/vector.store.ts:L305-L318`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/vector.store.ts#L305-L318) | [`src/memory/vector.store.ts:L221`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/vector.store.ts#L221) |
| **ProjectMemory** | Yes | Yes | Yes | Yes | Yes (`turnContext.memory`) | `.breakglass/memory/vectors.json` | [`src/tools/implementations/remember.tool.ts:L31`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/remember.tool.ts#L31) | [`src/cli/personas/base.persona.ts:L558`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L558) |
| **ExemplarStore** | Yes | Yes | Yes | Yes | Yes (`turnContext.exemplars`) | `.bimax/exemplars.json` | [`src/mind/exemplar.store.ts:L70-L85`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/exemplar.store.ts#L70-L85) | [`src/mind/exemplar.store.ts:L55-L68`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/exemplar.store.ts#L55-L68) |
| **Persistent Goals** | Yes | Yes | Yes | No | Yes (`dynamicSuffix.goals`) | `.bimax/goals.json` | [`src/memory/goal.manager.ts:L94-L101`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/goal.manager.ts#L94-L101) | [`src/memory/goal.manager.ts:L78-L92`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/goal.manager.ts#L78-L92) |
| **Persistent Plans** | Yes | Yes | Yes | No | Yes (Plan Mode Banner) | `.bimax/plans/<slug>.md` | [`src/memory/plan.manager.ts:L140-L155`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/plan.manager.ts#L140-L155) | [`src/memory/plan.manager.ts:L160-L180`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/plan.manager.ts#L160-L180) |
| **SelfModel** | Yes | Yes | Yes | No | Yes (`turnContext.selfKnowledge`) | `.bimax/self-model.json` | [`src/mind/self.model.ts:L240-L255`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/self.model.ts#L240-L255) | [`src/mind/self.model.ts:L215-L235`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/self.model.ts#L215-L235) |
| **EpistemicLedger** | Yes | Yes | Yes | No | Yes (`turnContext.calibration`) | `.bimax/epistemic.json` | [`src/mind/epistemic.ledger.ts:L180-L195`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/epistemic.ledger.ts#L180-L195) | [`src/mind/epistemic.ledger.ts:L160-L175`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/epistemic.ledger.ts#L160-L175) |
| **UserModel** | Yes | Yes | Yes | No | Yes (`turnContext.userModel`) | `.bimax/user-model.json` | [`src/mind/user.model.ts:L190-L210`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/user.model.ts#L190-L210) | [`src/mind/user.model.ts:L170-L188`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/user.model.ts#L170-L188) |
| **HabitMiner** | Yes | Yes | Yes | No | Yes (`turnContext.habits`) | `.bimax/habits.json` | [`src/mind/habit.compiler.ts:L110-L130`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/habit.compiler.ts#L110-L130) | [`src/mind/habit.compiler.ts:L90-L108`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/habit.compiler.ts#L90-L108) |
| **DrivesEngine** | Yes | Yes | Yes | No | Yes (`turnContext.drives`) | `.bimax/drives.json` | [`src/mind/drives.engine.ts:L200-L215`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/drives.engine.ts#L200-L215) | [`src/mind/drives.engine.ts:L180-L198`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/drives.engine.ts#L180-L198) |
| **HarnessTuner** | Yes | Yes | Yes | No | Yes (`turnContext.harnessPatches`)| `.bimax/harness-patches.json` | [`src/mind/harness.tuner.ts:L150-L165`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/harness.tuner.ts#L150-L165) | [`src/mind/harness.tuner.ts:L130-L148`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/harness.tuner.ts#L130-L148) |
| **RepoMap Graph** | Yes | Yes | Yes | No | Yes (`[RepoMap]` Outline) | `.breakglass/graph/graph.db` (SQLite) | [`src/graph/sqlite.graph.store.ts:L80-L130`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/sqlite.graph.store.ts#L80-L130) | [`src/graph/sqlite.graph.store.ts:L90-L140`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/sqlite.graph.store.ts#L90-L140) |
| **Semantic Code Index** | Yes | Yes | Yes | Yes (Tool) | Yes (via CodeSearchTool) | `.breakglass/memory/code-index.db` (SQLite)| [`src/memory/sqlite.code.store.ts:L155-L215`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/sqlite.code.store.ts#L155-L215) | [`src/memory/sqlite.code.store.ts:L113-L121`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/sqlite.code.store.ts#L113-L121) |
| **Taint State** | Yes | Yes | No | No | No (Governor blocks commands) | In-Memory (`TaintTracker`) | [`src/mind/taint.ts:L69-L81`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/taint.ts#L69-L81) | [`src/mind/taint.ts:L93-L107`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/taint.ts#L93-L107) |

---

## 22. Model-Visible vs Control-Plane Matrix

| Subsystem | Raw Data Visible to LLM? | Statistical Summary Visible? | Only Affects Tool Selection / Routing? | Only Affects Security / Governance? | Internal Control Plane Only? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Context Window Manager** | No | Yes (Warning nudge at 50%) | No | No | Yes (Token budget gate & compaction) |
| **Prompt Assembly Partition** | Yes | No | No | No | Yes (Cache partition & message ordering) |
| **LlmAdapter Cache Breakpoints**| No | No | No | No | Yes (Provider header injection) |
| **Involuntary Auto-Recall** | Yes | No | No | No | No (Direct prompt injection) |
| **ProjectMemory** | Yes | No | No | No | No (Direct prompt injection) |
| **Semantic Code Index** | Yes (via Tool) | No | Yes (Discovered via tool search) | No | No (Tool-mediated RAG) |
| **RepoMap (PageRank)** | Yes (Outline) | No | No | No | No (Direct prompt injection) |
| **SelfModel** | No | Yes (Top 5 routing rules) | Yes (Informs model self-routing) | No | No (Agent state summary) |
| **EpistemicLedger** | No | Yes (Calibration ECE) | No | No | Yes (Claims & settlement ledger) |
| **UserModel** | No | Yes (Diff taste & assertions)| No | No | No (Agent state summary) |
| **HabitMiner** | No | Yes (Compiled macros) | No | No | No (Agent state summary) |
| **DrivesEngine** | No | Yes (Setpoint deviations) | No | No | No (Agent state summary) |
| **HarnessTuner** | No | Yes (Steering patches) | No | No | Yes (Lab eval & mining engine) |
| **ExemplarStore** | Yes (Past tasks) | No | No | No | No (Episodic retrieval memory) |
| **PolicyArms** | No | No | No | No | Yes (Multi-armed bandit decision gate) |
| **EventLedger** | No | No | No | No | Yes (Telemetry event stream) |
| **Governor & Taint** | No | No | No | Yes (Hard command blocking) | Yes (Security enforcement) |

---

## 23. Detailed Runtime Call Graphs

### 1. Normal User $\rightarrow$ LLM Turn
`bin/bimax.js:L20` $\rightarrow$ `src/index.ts:L142` $\rightarrow$ `BasePersona.ask()` $\rightarrow$ `BasePersona.executeTurn()` ([`src/cli/personas/base.persona.ts:L500`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L500)) $\rightarrow$ `buildSections()` $\rightarrow$ `splitPrompt()` $\rightarrow$ `new AgentLoop()` $\rightarrow$ `AgentLoop.execute()` ([`src/core/agent.loop.ts:L237`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/agent.loop.ts#L237)) $\rightarrow$ `ContextManager.checkAndCompact()` ([`src/memory/context.manager.ts:L157`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L157)) $\rightarrow$ `injectRepoMap()` $\rightarrow$ `injectTurnContext()` $\rightarrow$ `LlmAdapter.chat()` ([`src/core/llm.adapter.ts:L812`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/llm.adapter.ts#L812)) $\rightarrow$ OpenAI streaming API $\rightarrow$ tokens streamed to stdout.

### 2. User $\rightarrow$ Auto-Recall $\rightarrow$ LLM
User prompt $\rightarrow$ `AgentLoop.execute()` $\rightarrow$ `injectRecall()` ([`src/core/agent.loop.ts:L210`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/agent.loop.ts#L210)) $\rightarrow$ `recallQuery()` ([`src/memory/recall.ts:L62`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/recall.ts#L62)) $\rightarrow$ `recallForTurn()` ([`src/memory/recall.ts:L93`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/recall.ts#L93)) $\rightarrow$ `VectorStore.semanticSearch(query, 3, 0, { excludeTags: ['project-memory', 'code'] })` ([`src/memory/vector.store.ts:L443`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/vector.store.ts#L443)) $\rightarrow$ Formats `[Recalled memory]` system message $\rightarrow$ Appended before user message $\rightarrow$ `LlmAdapter.chat()`.

### 3. Project Memory $\rightarrow$ Prompt
`BasePersona.executeTurn()` $\rightarrow$ `globalProjectMemory.recallBlock(prompt)` ([`src/memory/project.memory.ts:L48`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/project.memory.ts#L48)) $\rightarrow$ `VectorStore.semanticSearch(prompt, 3, 0.08, { tags: ['project-memory'] })` $\rightarrow$ Bullet string formatted $\rightarrow$ `BasePersona.buildSections()` ([`src/cli/personas/base.persona.ts:L329`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L329)) $\rightarrow$ `turnContext.memory` $\rightarrow$ `injectTurnContext()` $\rightarrow$ `LlmAdapter.chat()`.

### 4. RepoMap $\rightarrow$ Prompt
`AgentLoop.execute()` $\rightarrow$ `ContextManager.checkAndCompact()` ([`src/memory/context.manager.ts:L239`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L239)) $\rightarrow$ `crossRepoMapSync(_graphStore, 1500, focusTermsFromMessages(msgs))` ([`src/graph/cross.repo.ts`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/cross.repo.ts)) $\rightarrow$ `formatRepoMapOutline()` ([`src/graph/pagerank.ts:L120`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/pagerank.ts#L120)) $\rightarrow$ `computePageRank()` ([`src/graph/pagerank.ts:L27`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/pagerank.ts#L27)) $\rightarrow$ `injectRepoMap()` ([`src/memory/context.manager.ts:L65`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L65)) $\rightarrow$ Injected before latest user message $\rightarrow$ `LlmAdapter.chat()`.

### 5. Tool Call $\rightarrow$ Tool Output $\rightarrow$ Next Model Call
`LlmAdapter.chat()` yields `tool_call` event $\rightarrow$ `AgentLoop.executeToolCall()` ([`src/core/agent.loop.ts:L856`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/agent.loop.ts#L856)) $\rightarrow$ `ToolRegistry.getTool(name).execute(args)` $\rightarrow$ `markToolTaint()` $\rightarrow$ `EventLedger.append('tool_outcome')` $\rightarrow$ Result message appended as `role: 'tool'` $\rightarrow$ Loop repeats $\rightarrow$ `ContextManager.checkAndCompact()` $\rightarrow$ `LlmAdapter.chat()`.

### 6. Context Compaction (Layer 4)
`ContextManager.checkAndCompact()` detects `effectiveTokens / MAX_TOKENS > 0.70` $\rightarrow$ `ContextManager.compact(messages)` ([`src/memory/context.manager.ts:L414`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L414)) $\rightarrow$ Invokes `LlmAdapter.generateChatResponse()` with 5-section prompt $\rightarrow$ Generates synthetic `[Previous Context Summary]` $\rightarrow$ Queries `FileStateCache.getRecentReads()` $\rightarrow$ Appends `[FILE_STILL_UNCHANGED]` attachments $\rightarrow$ Replaces older message history $\rightarrow$ Increments `compactionEpoch`.

### 7. Context Overflow Recovery Ladder
`LlmAdapter.chat()` throws 400 Context Overflow $\rightarrow$ `AgentLoop.execute()` catch block ([`src/core/agent.loop.ts:L481`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/agent.loop.ts#L481)) $\rightarrow$ Step 1: `reactiveDrain()` (clears tool bodies older than last 2 rounds) $\rightarrow$ Retries `chat()` $\rightarrow$ If fails, Step 2: `reactiveCompact()` (forces Layer 4 summarization) $\rightarrow$ Retries `chat()` $\rightarrow$ If fails, Step 3: `truncateContext()` (slices history to initial prompt + last 4 turns) $\rightarrow$ Retries `chat()`.

### 8. Semantic Code Retrieval (CodeSearchTool)
`CodeSearchTool.execute(query)` ([`src/tools/implementations/code.search.tool.ts:L33`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/code.search.tool.ts#L33)) $\rightarrow$ `CodeIndex.search(query)` ([`src/memory/code.index.ts:L229`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/code.index.ts#L229)) $\rightarrow$ `SqliteCodeVectorStore.semanticSearch()` ([`src/memory/sqlite.code.store.ts:L249`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/sqlite.code.store.ts#L249)) $\rightarrow$ FTS5 BM25 match $\parallel$ Streamed int8 vector dot product $\rightarrow$ `reciprocalRankFusion()` $\rightarrow$ `RemoteReranker.rerank()` $\rightarrow$ Code hits returned to model as tool output string.

### 9. Long-Term VectorStore Retrieval (MemoryQueryTool)
`MemoryQueryTool.execute(query)` ([`src/tools/implementations/memory.tool.ts:L32`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/memory.tool.ts#L32)) $\rightarrow$ `VectorStore.semanticSearch(query)` ([`src/memory/vector.store.ts:L443`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/vector.store.ts#L443)) $\rightarrow$ `Bm25Index.search()` $\parallel$ `RemoteEmbeddingBackend.embed([query], 'query')` $\rightarrow$ `reciprocalRankFusion()` $\rightarrow$ `RemoteReranker.rerank()` $\rightarrow$ Formatted memory documents returned as tool output.

### 10. Embeddings Request
`RemoteEmbeddingBackend.embed(texts, role)` ([`src/memory/embeddings.ts:L137`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/embeddings.ts#L137)) $\rightarrow$ Resolves credentials $\rightarrow$ Splits batch into $\le 64$ items $\rightarrow$ Sends HTTP `POST <baseURL>/embeddings` (`input_type: role, truncate: 'END', dimensions: 768`) $\rightarrow$ Orders rows by `index` $\rightarrow$ `normalize()` unit vectors $\rightarrow$ Returns float arrays.

### 11. Reranking Request
`RemoteReranker.rerank(query, candidates)` ([`src/memory/rerank.ts:L103`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/rerank.ts#L103)) $\rightarrow$ Slices window to top 24 $\rightarrow$ Sends HTTP `POST <rerankURL>` (`{ query: { text }, passages: [{ text }] }`) $\rightarrow$ Parses `rankings` array $\rightarrow$ Sorts candidates by descending logit $\rightarrow$ Returns `RerankedHit[]`.

### 12. Mind Subsystem $\rightarrow$ TurnContext
`BasePersona.executeTurn()` $\rightarrow$ `BasePersona.buildSections()` ([`src/cli/personas/base.persona.ts:L381-L397`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L381-L397)) $\rightarrow$ Queries `SelfModel`, `HabitMiner`, `UserModel`, `DrivesEngine`, `EpistemicLedger`, `HarnessTuner` $\rightarrow$ Evaluates `PolicyArms.decide()` where applicable $\rightarrow$ Assembled into `turnContext` string $\rightarrow$ `injectTurnContext()` splices before user message $\rightarrow$ Sent to model in next request.

### 13. Screenshot / Image Ingestion
Desktop/Browser tool returns base64 image $\rightarrow$ `AgentLoop.execute()` $\rightarrow$ `buildScreenshotObservation()` ([`src/core/agent.loop.ts:L805`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/agent.loop.ts#L805)) $\rightarrow$ Appends multimodal `{ type: 'image_url', image_url: { url } }` $\rightarrow$ `pruneScreenshotObservations()` removes older screenshots $\rightarrow$ Next `chat()` request sends image part to vision-capable model.

### 14. Persistence $\rightarrow$ Restart Read-Back
Process restart $\rightarrow$ `createContainer()` $\rightarrow$ `SqliteCodeVectorStore.open()` loads `tagsById` from `docs` table ([`src/memory/sqlite.code.store.ts:L113`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/sqlite.code.store.ts#L113)) $\rightarrow$ `VectorStore.load()` reads `vectors.json` $\rightarrow$ `SqliteGraphStore.loadFromDisk()` reads `graph.db` $\rightarrow$ `GoalManager.init()` loads `goals.json` $\rightarrow$ Models and indexes ready for immediate query without re-indexing.

### 15. Taint Propagation $\rightarrow$ Governor Enforcement
`WebFetchTool` executes $\rightarrow$ `markToolTaint('WebFetchTool', ...)` ([`src/mind/taint.ts:L69`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/taint.ts#L69)) $\rightarrow$ `TaintTracker.mark('web', url)` $\rightarrow$ Next turn model calls `BashTool(command: 'curl ...')` $\rightarrow$ `Governor.evaluateAction()` invokes `taintRestriction()` ([`src/mind/taint.ts:L93`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/taint.ts#L93)) $\rightarrow$ Matches `NETWORK_PROGRAMS` $\rightarrow$ Returns `action: 'block'` (in auto mode) or `action: 'ask'` (in interactive mode).

---

## 24. End-to-End Trace Examples

### Trace 1: Normal User Turn (Algorithmic Walkthrough)
1. **User Input**: User submits a natural-language query.
2. **Message Creation**: `BasePersona.messages.push({ role: 'user', content: prompt })`.
3. **Turn Context Assembly**: `globalProjectMemory.recallBlock()` runs hybrid RAG; `SelfModel`, `UserModel`, and `HabitMiner` provide active prompt blocks filtered by `PolicyArms.decide()`.
4. **Token Budget Evaluation**: `ContextManager.checkAndCompact()` evaluates `effectiveTokens / activeContextWindow`. If ratio $< 0.50$, all cheap passes and summarization are skipped.
5. **Prompt Assembly**: `staticPrefix` + `dynamicSuffix` are placed in `messages[0]`. `[RepoMap]` and `[TurnContext]` are spliced immediately preceding the latest user turn.
6. **Provider Wire Shaping**: `applyCacheBreakpoints()` sets ephemeral cache breakpoints if the active model supports prompt caching.
7. **Model Generation**: `client.chat.completions.create({ stream: true })` streams response tokens directly to the interface.

### Trace 2: Tool Turn (Algorithmic Walkthrough)
1. **Tool Invocation**: Model emits structured `tool_calls` delta.
2. **Tool Execution**: `AgentLoop.executeToolCall()` executes the tool. If the tool is a file read, `fileStateCache.set()` records file contents and `mtime`.
3. **Result Capping**: If the tool result exceeds `TOOL_RESULT_MAX_CHARS` (16,000 chars) and does not pass `looksLikeCode()`, the middle is elided.
4. **History Ingestion**: Tool output is appended as `{ role: 'tool', tool_call_id, content }`.
5. **Turn Continuation**: `AgentLoop` loops, re-evaluates `checkAndCompact()`, and triggers the next model turn.

### Trace 3: Retrieval Turn (Algorithmic Walkthrough)
1. **Trigger Condition**: User prompt $\ge 24$ characters and does not start with a slash command.
2. **Hybrid Search Execution**: `VectorStore.semanticSearch()` runs BM25 lexical match and dense cosine embedding in parallel, fuses rankings via RRF ($k=60$), and applies cross-encoder reranking.
3. **System Prompt Injection**: Top hits are formatted into a `[Recalled memory]` system message and inserted before the user prompt.
4. **Conditioned Response**: Model receives historical facts and generates an informed completion.

### Trace 4: Long Conversation Compaction (Algorithmic Walkthrough)
1. **Pressure Trigger**: `effectiveTokens / activeContextWindow` exceeds `COMPACT_THRESHOLD` ($0.70$).
2. **Layer 0**: `compressBacklog()` collapses repetitive log lines in tool outputs.
3. **Layer 1 & 2**: `capToolResults()` caps long outputs; `microCompact()` replaces tool outputs older than the last 6 with structured stubs.
4. **Layer 4 Summarization**: If tokens still exceed $0.70$, `LlmAdapter.generateChatResponse()` generates a 5-section summary.
5. **File Restoration**: `FileStateCache.getRecentReads()` checks disk `mtime` and re-injects up to 5 small unchanged files (<50KB each, max 40KB budget).

### Trace 5: Persistence & Restart (Algorithmic Walkthrough)
1. **State Persistence**: During session execution, mutations are committed to `.bimax/goals.json`, `.breakglass/memory/vectors.json`, and `.breakglass/memory/code-index.db`.
2. **Boot Initialization**: On startup, `createContainer()` loads SQLite database schemas, reads `vectors.json`, and initializes `GoalManager`.
3. **Immediate Availability**: On the very first user turn, persistent goals and conventions are available for prompt assembly without requiring manual re-indexing.

---

## 25. Configuration & Dependency Matrix

| Subsystem | Required Dependency | Default Availability | Behavior if Missing | Operational Impact Classification |
| :--- | :--- | :--- | :--- | :--- |
| **Remote Embeddings** | NVIDIA / OpenAI API Key with `/embeddings` | Available if API key configured | `embed()` returns `null`, latches disabled; VectorStore & CodeIndex fall back to BM25 ([`src/memory/vector.store.ts:L477-L480`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/vector.store.ts#L477-L480)) | **FALLBACK TO BM25** |
| **Remote Reranker** | NVIDIA NIM / Custom `/ranking` endpoint | Available if API key configured | `rerank()` returns `null`; retrieval keeps RRF fusion order ([`src/memory/vector.store.ts:L520-L537`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/vector.store.ts#L520-L537)) | **FALLBACK TO RRF** |
| **Headroom ML Proxy** | Python sidecar (`chopratejas/kompress-v2-base`) | Disabled by default (`BIMAX_ENABLE_HEADROOM=0`) | Native synchronous `compressBacklog` handles log compaction ([`src/memory/context.manager.ts:L204-L211`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L204-L211)) | **FALLBACK TO NATIVE COMPRESSION** |
| **Codebase Memory** | `codebase-memory` MCP binary | Optional / external | `isReady()` returns `false`; graph queries fall back to native SQLite graph ([`src/tools/implementations/graph.tool.ts:L248-L260`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/graph.tool.ts#L248-L260)) | **FALLBACK TO NATIVE GRAPH** |
| **SQLite WAL Backend** | `node:sqlite` or `bun:sqlite` | Built into modern Node.js / Bun | Falls back to in-memory / JSON store (`GraphStore`) | **FALLBACK TO JSON / MEMORY** |

---

## 26. Critical Failure Modes, Edge Cases & Fragility Audit

1. **Stale Post-Compaction File Restoration**: If a file was modified on disk by an external editor during a multi-turn compaction, re-injecting its cached content would overwrite reality. *Mitigation*: `FileStateCache` re-stats the file on disk before restoring; if `mtime` changed, restoration is aborted ([`src/memory/context.manager.ts:L493-L508`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L493-L508)).
2. **Asymmetric Embedding Degradation**: Calling an asymmetric embedding model without role tagging degrades retrieval precision. *Mitigation*: `RemoteEmbeddingBackend.embed()` enforces `role: 'query' | 'passage'` at compile time ([`src/memory/embeddings.ts:L51`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/embeddings.ts#L51)).
3. **Lossy Code Compression**: Generic token compressors strip syntax elements from code. *Mitigation*: `looksLikeCode()` inspects tool outputs and passes code through verbatim ([`src/memory/headroom.compress.ts:L183-L197`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/headroom.compress.ts#L183-L197)).
4. **Vector Space Incompatibility**: Upgrading an embedding model or dimension size corrupts cosine calculations if old vectors remain. *Mitigation*: Vectors are stamped with `${model}@${dimensions}`; mismatched stamps trigger automatic re-embedding ([`src/memory/vector.store.ts:L245-L270`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/vector.store.ts#L245-L270)).
5. **Prompt Injection Exfiltration via MCP/Web**: Untrusted web pages instructing network data exfiltration. *Mitigation*: `TaintTracker` enforces whole-context taint, hard-blocking network commands in auto mode ([`src/mind/taint.ts:L93-L107`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/taint.ts#L93-L107)).

---

## 27. Security / Taint / Prompt-Injection Boundaries

- **Provenance Tagging**: `WebFetchTool`, `WebSearchTool`, and all `mcp__*` tools tag context with `TaintSource` (`web` or `mcp`).
- **Enforcement Boundary**: `Governor` intercepts all `BashTool` commands. Commands matching `NETWORK_PROGRAMS` (`curl`, `wget`, `ssh`, `git push`, `npm publish`, etc.) are unconditionally rejected in `auto` mode when taint is present.

---

## 28. Verified Documentation Claims vs Reality

| Claim | Exact Claim Source | Runtime Evidence | Status | Forensic Explanation |
| :--- | :--- | :--- | :--- | :--- |
| **"AST-aware code compression via headroom-ai[code]"** | `src/memory/headroom.compress.ts:L130` | `looksLikeCode()` regex heuristic ([`src/memory/headroom.compress.ts:L133-L144`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/headroom.compress.ts#L133-L144)) | **DIFFERENT FROM DOCUMENTATION** | Real code protection is implemented via line-density regex heuristics, not AST parsing on the `/v1/compress` path. |
| **"CognitiveGraph manages goal-task-capability dependencies"** | `src/graph/cognitive.graph.ts:L1-L15` | `src/graph/cognitive.graph.ts:L4` | **DEAD / UNUSED** | Class exists with placeholder comments (`L53`) but has zero callers found in inspected runtime paths. |
| **"Universal 120k / 96k Context Limit"** | Legacy docs / comments | `BasePersona.executeTurn` ([`src/cli/personas/base.persona.ts:L577-L581`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L577-L581)) | **DIFFERENT FROM DOCUMENTATION** | Context window dynamically scales to model capability (e.g. 200k for Claude, 1M for Gemini); compaction threshold is 70%. |
| **"158-Language Code Graph Indexing"** | `src/graph/codemem/backend.ts:L7` | `CodememBackend` ([`src/graph/codemem/backend.ts:L43-L275`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/codemem/backend.ts#L43-L275)) | **PARTIALLY VERIFIED** | Implemented via MCP client connecting to external `codebase-memory` binary. Falls back to TypeScript/JS tree-sitter graph if binary missing. |
| **"Zero-Resident RAM Quantized Code Search"** | `src/memory/sqlite.code.store.ts:L10` | `SqliteCodeVectorStore` ([`src/memory/sqlite.code.store.ts:L290-L322`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/sqlite.code.store.ts#L290-L322)) | **VERIFIED (in test harness)** | Verified by `code.store.ram.ledger.test.ts`: resident memory is $< 200$ bytes/doc in test harness; int8 vector dot product streams from disk. |
| **"Anthropic Ephemeral Prompt Caching"** | `docs/product-reset/05_TARGET_ARCHITECTURE.md` | `applyCacheBreakpoints()` ([`src/core/llm.adapter.ts:L812-L845`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/llm.adapter.ts#L812-L845)) | **VERIFIED** | Slices static prefix, dynamic suffix, and turns into Anthropic `cache_control: { type: 'ephemeral' }` blocks. |
| **"Multi-Repo Workspace RepoMap Synthesis"** | `src/graph/cross.repo.ts:L1-L20` | `crossRepoMapSync()` ([`src/graph/cross.repo.ts:L30-L75`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/cross.repo.ts#L30-L75)) | **VERIFIED** | Iterates indexed workspaces and merges PageRank symbol outlines into a single unified prompt block. |
| **"Involuntary Auto-Recall on Every Turn"** | `src/memory/recall.ts:L1-L25` | `AgentLoop.injectRecall()` ([`src/core/agent.loop.ts:L210-L227`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/agent.loop.ts#L210-L227)) | **PARTIALLY VERIFIED / CONDITIONAL** | Evaluated on user turns, but only runs if prompt $\ge 24$ chars, not a slash command, and not previously recalled in session. |
| **"Metacognitive Self-Model Failure Routing"** | `src/mind/self.model.ts:L1-L30` | `SelfModel.getPromptBlock()` ([`src/mind/self.model.ts:L355-L378`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/self.model.ts#L355-L378)) | **VERIFIED** | Injects routing rules for tools with failure probability $P(\theta > 0.3) > 0.9$ into `[TurnContext]`. |
| **"TDM-Gated Mutation Claim Settlement"** | `src/mind/epistemic.ledger.ts:L1-L35` | `EpistemicLedger.resolveDetailed()` ([`src/mind/epistemic.ledger.ts:L250-L310`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/epistemic.ledger.ts#L250-L310)) | **VERIFIED** | Settles open claims based on compiler/test failure outputs and transitive import reachability. |

---

## 29. Dead / Legacy Code Matrix

| Component | File Path | Production Imports | Runtime Caller | Replacement If Any | Status | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `CognitiveGraph` | [`src/graph/cognitive.graph.ts:L4-L67`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/cognitive.graph.ts#L4-L67) | 0 | None found in inspected paths | Not proven by migration record (GoalManager and PlanManager provide related functionality) | **DEAD / UNUSED** | Zero imports in `src/`; placeholder comments in file. |
| `playground.json` migration | [`src/graph/sqlite.graph.store.ts:L103-L117`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/sqlite.graph.store.ts#L103-L117) | Internal | `SqliteGraphStore.loadFromDisk()` | SQLite `graph.db` | **LEGACY MIGRATION** | One-time file migration for JSON graph format. |
| `embedder.ts` (as semantic search) | [`src/mind/embedder.ts`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/embedder.ts) | 2 (`ExemplarStore`, `UserModel`) | Local Mind matching only | `RemoteEmbeddingBackend` | **SUPERSEDED FOR RAG** | Used strictly for local hash-kernel matching. |

---

## 30. Test-Only Components

| Component | Implementation File | Primary Test File | Explanation |
| :--- | :--- | :--- | :--- |
| `MemoryEval` | `src/memory/eval.ts` | `src/__tests__/memory.eval.test.ts` | Offline retrieval benchmark harness measuring NDCG/MRR. Not invoked during live user conversation turns. |
| `RAM Ledger Benchmark` | N/A | `src/__tests__/code.store.ram.ledger.test.ts` | Benchmark test asserting that SQLite code store consumes $< 200$ bytes RAM per document in test harness compared to JSON store. |

---

## 31. Config-Only Components

| Configuration Key | Schema / Interface | Default | Status |
| :--- | :--- | :--- | :--- |
| `BIMAX_EMBEDDER_MODULE` | `src/mind/embedder.ts:L82` | `undefined` | Hook allowing a custom local ONNX embedder module to replace the FNV-1a hash kernel. |
| `BIMAX_DISABLE_COMPRESSION` | `src/memory/context.manager.ts:L175` | `undefined` | Disables Layer 0 Headroom compression when set to `1`. |

---

## 32. Verified Future / Unimplemented Systems

| Feature | Source Marker | Existing Implementation | Missing Implementation | Status | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Merkle Tree Graph Staleness** | `src/graph/sqlite.graph.store.ts:L20` | Flat SQLite hash table (`file_hashes`) | Hierarchical Merkle tree hashing for sharded repo sync | **PLANNED** | Comment: `Merkle tree planned for multi-repo scale` |
| **In-Process ONNX ModernBERT** | `src/memory/headroom.compress.ts:L150` | External HTTP proxy (`proxyCompress`) | Direct `@xenova/transformers` or `onnxruntime-node` integration | **PLANNED** | Comment: `In-process ONNX packaging is a future enhancement` |
| **Pre-Computed TDM Reachability** | `src/mind/epistemic.ledger.ts:L280` | On-the-fly graph walk during claim settlement | Transitive closure reachability matrix pre-indexing | **PLANNED** | Comment: `TDM dynamic graph query will be cached in v3` |

---

## 33. Code-Derived Issues & Optimization Opportunities

### 33.1 Code-Derived Issues (Verified Limitations)
1. **Omission of `sections.journal` in `splitPrompt()`**: `BasePersona.buildSections()` ([`src/cli/personas/base.persona.ts:L390`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L390)) builds `sections.journal = arm('journal', journalPreloadBlock())`, but `splitPrompt()` ([`src/cli/personas/base.persona.ts:L440-L451`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L440-L451)) omits `sections.journal` from `turnContext`, causing journal summaries to be discarded before model invocation.
2. **Abstracted Local Vision Token Estimation**: `contentToText()` ([`src/core/multimodal.ts:L147`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/multimodal.ts#L147)) maps image parts to `"[image]"` (~1 token), under-representing image token cost in local estimates until provider `usage.prompt_tokens` is received.

### 33.2 Optimization Opportunities
1. **Consolidate SQLite Connection Handles**: `code-index.db` and `graph.db` maintain separate SQLite instances; combining them under a unified SQLite manager could reduce open file handles.
2. **Pre-Cache Transitive Reachability in TDM**: Pre-indexing transitive dependency paths in SQLite would avoid on-the-fly graph traversal during claim settlement.

---

## 34. Uncertainties

| Area of Uncertainty | Why Static Analysis Cannot Fully Resolve | Involved Files | Resolving Test / Evidence |
| :--- | :--- | :--- | :--- |
| **Provider-Side Prompt Cache Retention Duration** | Provider cache retention TTL is enforced remotely by provider API servers. | `src/core/llm.adapter.ts:L812-L845` | Real-time billing telemetry logging `cache_read_input_tokens` across varied inter-turn pauses. |
| **Mid-Session Dynamic Model Switching Token State** | `BasePersona.sessionContext` recreates `ContextManager` when `contextWindow` changes, but `overheadTokens` residual from the previous model may carry over until the first token usage update. | `src/cli/personas/base.persona.ts:L140-L147`, `src/memory/context.manager.ts:L138-L145` | Multi-turn test switching from 128k to 1M model mid-session. |
| **Multimodal in-place array mutation vs WeakMap token-cache invalidation** | `countMessageTokens` compares `hit.content === m.content` by reference identity; in-place array mutations would not trigger cache invalidation unless object reference is replaced. | `src/memory/context.manager.ts:L390-L404`, `src/core/multimodal.ts` | Code test verifying whether any runtime path mutates `ContentPart[]` in place. |

---

## 35. Verified Context / RAG File Inventory

*Note on Runtime Status*: `Runtime Status` describes the execution and reachability of the file's materially relevant functionality in production, not merely module existence. Where model-visible output has an additional gate (e.g. PolicyArms holdout, token pressure, or feature flags), that condition is reflected in the status and Dependency / Condition column.

| File | Relevant Symbols | Responsibility | Runtime Status | Entry / Caller | Calls Into | Model / Context Visible? | Dependency / Condition | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `bin/bimax.js` | Main entry script | CLI executable bootstrap | **ACTIVE — UNCONDITIONAL EVALUATION** | User shell execution | `src/index.ts` | No (Bootstrap) | Node.js runtime | [`bin/bimax.js:L1-L35`](file:///Users/vishsiddharth/Desktop/Bimax/bin/bimax.js#L1-L35) |
| `src/index.ts` | `main` | CLI entry point & mode routing | **ACTIVE — UNCONDITIONAL EVALUATION** | `bin/bimax.js` | `createContainer`, `BasePersona` | No (Router) | None | [`src/index.ts:L103-L211`](file:///Users/vishsiddharth/Desktop/Bimax/src/index.ts#L103-L211) |
| `src/acp/server.ts` | `AcpServer` | Agent Client Protocol JSON-RPC server | **ACTIVE — CONDITIONAL (Flag --acp)** | `src/index.ts` (`--acp`) | `BasePersona`, `AgentLoop` | Yes (via ACP client) | Flag `--acp` | [`src/acp/server.ts:L1-L150`](file:///Users/vishsiddharth/Desktop/Bimax/src/acp/server.ts) |
| `src/core/container.ts` | `createContainer`, `ServiceContainer` | Service construction & DI wiring | **ACTIVE — UNCONDITIONAL EVALUATION** | `src/index.ts` | All core services & stores | No (DI Container) | None | [`src/core/container.ts:L88-L426`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/container.ts#L88-L426) |
| `src/core/capabilities.ts` | `capabilitiesFor`, `ModelCapabilities` | Model capability flags & context windows | **ACTIVE — UNCONDITIONAL EVALUATION** | `LlmAdapter`, `BasePersona` | None (Pure module) | Indirect (Configures window) | None | [`src/core/capabilities.ts:L1-L200`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/capabilities.ts#L1-L200) |
| `src/core/llm.adapter.ts` | `LlmAdapter`, `applyCacheBreakpoints` | OpenAI SDK adapter, streaming, think tags | **ACTIVE — UNCONDITIONAL EVALUATION** | `AgentLoop`, `BasePersona` | OpenAI API client | Yes (Constructs payload) | Configured API key | [`src/core/llm.adapter.ts:L812-L1262`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/llm.adapter.ts#L812-L1262) |
| `src/core/agent.loop.ts` | `AgentLoop`, `injectRecall` | Turn execution, overflow recovery, tool loop | **ACTIVE — UNCONDITIONAL EVALUATION** | `BasePersona.executeTurn` | `ContextManager`, `LlmAdapter` | Yes (Manages history) | None | [`src/core/agent.loop.ts:L237-L545`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/agent.loop.ts#L237-L545) |
| `src/core/multimodal.ts` | `buildUserContent`, `contentToText` | Image observation formatting & text fallback | **ACTIVE — CONDITIONAL (Vision Model)** | `BasePersona`, `AgentLoop` | None (Pure module) | Yes (Image data URLs) | Vision model capability | [`src/core/multimodal.ts:L140-L240`](file:///Users/vishsiddharth/Desktop/Bimax/src/core/multimodal.ts#L140-L240) |
| `src/cli/personas/base.persona.ts` | `BasePersona`, `splitPrompt`, `injectTurnContext` | 3-way prompt partition & turn orchestration | **ACTIVE — UNCONDITIONAL EVALUATION** | `src/index.ts`, `AcpServer` | `AgentLoop`, `ContextManager` | Yes (System Prompt & TurnContext)| None | [`src/cli/personas/base.persona.ts:L178-L486`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L178-L486) |
| `src/cli/config.ts` | `getConfig`, `updateConfig` | Config loader for `.bimax/config.json` | **ACTIVE — UNCONDITIONAL EVALUATION** | `createContainer`, `BasePersona` | None (File I/O) | Indirect (User settings) | None | [`src/cli/config.ts:L1-L120`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/config.ts) |
| `src/cli/selfCritic.ts` | `isSelfCriticEnabled`, `setSelfCriticEnabled` | Self-critic toggle state | **ACTIVE — CONDITIONAL (Off by Default)** | `BasePersona`, `builtins.ts` | None (In-memory state) | Indirect (Controls critique pass)| Default: `false` | [`src/cli/selfCritic.ts:L1-L15`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/selfCritic.ts) |
| `src/governor/governor.ts` | `Governor`, `IGovernor` | Safety policy engine & taint enforcement | **ACTIVE — UNCONDITIONAL EVALUATION** | `createContainer`, `ToolRegistry` | `TaintTracker` | Indirect (Blocks commands) | None | [`src/governor/governor.ts:L1-L200`](file:///Users/vishsiddharth/Desktop/Bimax/src/governor/governor.ts) |
| `src/tools/tool.registry.ts` | `ToolRegistry`, `ITool` | Tool registration & schema serialization | **ACTIVE — UNCONDITIONAL EVALUATION** | `createContainer`, `BasePersona` | Tool implementations | Yes (Tool schemas on wire) | None | [`src/tools/tool.registry.ts:L1-L220`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/tool.registry.ts) |
| `src/tools/implementations/remember.tool.ts`| `RememberTool` | Records project conventions | **REGISTERED TOOL** | `ToolRegistry` | `ProjectMemory` | Indirect (Writes memory) | None | [`src/tools/implementations/remember.tool.ts:L1-L45`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/remember.tool.ts) |
| `src/tools/implementations/memory.tool.ts` | `MemoryQueryTool` | On-demand vector memory query tool | **REGISTERED TOOL** | `ToolRegistry` | `VectorStore` | Yes (Tool result RAG) | None | [`src/tools/implementations/memory.tool.ts:L1-L50`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/memory.tool.ts) |
| `src/tools/implementations/code.search.tool.ts`| `CodeSearchTool` | On-demand semantic code search tool | **REGISTERED TOOL (conditional)** | `ToolRegistry` | `CodeIndex` | Yes (Tool result RAG) | `BIMAX_CODE_INDEX !== '0'` | [`src/tools/implementations/code.search.tool.ts:L1-L60`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/code.search.tool.ts) |
| `src/tools/implementations/file.tool.ts` | `ReadFileTool`, `WriteFileTool` | File reading/writing & cache invalidation | **REGISTERED TOOL** | `ToolRegistry` | `FileStateCache` | Yes (File contents) | None | [`src/tools/implementations/file.tool.ts:L1-L260`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/file.tool.ts) |
| `src/tools/implementations/free-context.tool.ts`| `FreeContextTool` | Explicit tool body release tool | **REGISTERED TOOL** | `ToolRegistry` | `ContextManager`, `FileStateCache` | Yes (Stubs tool history) | None | [`src/tools/implementations/free-context.tool.ts:L1-L50`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/free-context.tool.ts) |
| `src/tools/implementations/graph.tool.ts` | `GraphQueryTool`, `GraphContextTool` | Graph querying & symbol context packs | **REGISTERED TOOL (conditional)** | `ToolRegistry` | `SqliteGraphStore`, `ContextPlanner` | Yes (Tool result code packs) | Graph index present | [`src/tools/implementations/graph.tool.ts:L1-L280`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/graph.tool.ts) |
| `src/tools/implementations/goals.tool.ts` | `GoalsTool` | Persistent goal CRUD tool | **REGISTERED TOOL** | `ToolRegistry` | `GoalManager` | Yes (Updates goals block) | None | [`src/tools/implementations/goals.tool.ts:L1-L60`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/goals.tool.ts) |
| `src/tools/implementations/plan.tool.ts` | `PlanTool` | Persistent plan management tool | **REGISTERED TOOL** | `ToolRegistry` | `PlanManager` | Yes (Updates plan markdown) | None | [`src/tools/implementations/plan.tool.ts:L1-L70`](file:///Users/vishsiddharth/Desktop/Bimax/src/tools/implementations/plan.tool.ts) |
| `src/memory/context.manager.ts` | `ContextManager`, `injectRepoMap` | 5-layer context management & token calibration| **ACTIVE — UNCONDITIONAL EVALUATION** | `BasePersona`, `AgentLoop` | `HeadroomCompress`, `FileStateCache` | Yes (Compacted summaries & RepoMap)| None | [`src/memory/context.manager.ts:L79-L576`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L79-L576) |
| `src/memory/vector.store.ts` | `VectorStore`, `Bm25Index` | 4-stage hybrid in-memory/JSON vector store | **ACTIVE — UNCONDITIONAL EVALUATION** | `createContainer`, `ProjectMemory` | `RemoteEmbeddingBackend`, `RemoteReranker` | Yes (Auto-recall & project memory)| None | [`src/memory/vector.store.ts:L191-L576`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/vector.store.ts#L191-L576) |
| `src/memory/code.index.ts` | `CodeIndex`, `chunkSource` | Code indexing orchestrator & chunker | **ACTIVE — CONDITIONAL (unless BIMAX_CODE_INDEX=0)** | `createContainer`, `CodeSearchTool` | `SqliteCodeVectorStore` | Yes (via CodeSearchTool) | `BIMAX_CODE_INDEX !== '0'` | [`src/memory/code.index.ts:L110-L301`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/code.index.ts#L110-L301) |
| `src/memory/sqlite.code.store.ts` | `SqliteCodeVectorStore` | SQLite FTS5 + int8 streamed vector store | **ACTIVE — CONDITIONAL (when CodeIndex enabled)**| `CodeIndex` | SQLite WAL database | Yes (via CodeSearchTool) | SQLite support | [`src/memory/sqlite.code.store.ts:L56-L430`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/sqlite.code.store.ts#L56-L430) |
| `src/memory/embeddings.ts` | `RemoteEmbeddingBackend`, `normalize` | Remote OpenAI/NVIDIA `/embeddings` backend | **RUNTIME-CAPABLE** | `createContainer`, `VectorStore` | Remote HTTP endpoint | Indirect (Vectors) | API key | [`src/memory/embeddings.ts:L106-L220`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/embeddings.ts#L106-L220) |
| `src/memory/rerank.ts` | `RemoteReranker` | Remote cross-encoder `/ranking` backend | **RUNTIME-CAPABLE** | `createContainer`, `VectorStore` | Remote HTTP endpoint | Indirect (Ranks) | API key / Rerank URL | [`src/memory/rerank.ts:L78-L166`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/rerank.ts#L78-L166) |
| `src/memory/settings.ts` | `resolveMemorySettings`, `rerankURLFor` | Memory & retrieval settings resolver | **ACTIVE — UNCONDITIONAL EVALUATION** | `createContainer` | `getConfig` | Indirect (Configures RAG) | None | [`src/memory/settings.ts:L1-L90`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/settings.ts) |
| `src/memory/bm25.ts` | `Bm25Index`, `tokenize` | In-memory BM25 lexical ranking engine | **ACTIVE — UNCONDITIONAL EVALUATION** | `VectorStore` | None (Pure module) | Indirect (Ranks) | None | [`src/memory/bm25.ts:L1-L130`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/bm25.ts) |
| `src/memory/fusion.ts` | `reciprocalRankFusion` | Reciprocal rank fusion ($k=60$) | **ACTIVE — UNCONDITIONAL EVALUATION** | `VectorStore`, `SqliteCodeVectorStore` | None (Pure module) | Indirect (Ranks) | None | [`src/memory/fusion.ts:L1-L50`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/fusion.ts) |
| `src/memory/recall.ts` | `recallQuery`, `recallForTurn` | Involuntary turn-based memory recall | **ACTIVE — CONDITIONAL (Query Length >= 24)**| `AgentLoop.injectRecall` | `VectorStore.semanticSearch` | Yes (`[Recalled memory]`) | Query $\ge 24$ chars | [`src/memory/recall.ts:L62-L143`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/recall.ts#L62-L143) |
| `src/memory/project.memory.ts` | `ProjectMemory`, `globalProjectMemory` | Durable project conventions manager | **ACTIVE — UNCONDITIONAL EVALUATION** | `BasePersona.executeTurn`, `RememberTool` | `VectorStore` | Yes (`### PROJECT MEMORY`) | None | [`src/memory/project.memory.ts:L10-L56`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/project.memory.ts#L10-L56) |
| `src/memory/goal.manager.ts` | `GoalManager`, `getGoalManager` | Cross-session persistent goals manager | **ACTIVE — UNCONDITIONAL EVALUATION** | `src/index.ts`, `BasePersona` | `.bimax/goals.json` | Yes (`### PERSISTENT GOALS`) | None | [`src/memory/goal.manager.ts:L42-L137`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/goal.manager.ts#L42-L137) |
| `src/memory/plan.manager.ts` | `PlanManager`, `getPlanManager` | Multi-step task plan manager | **ACTIVE — MANAGER LOADED / BANNER CONDITIONAL** | `src/index.ts`, `PlanTool` | `.bimax/plans/` | Yes (Plan Mode Banner) | `planMode` active | [`src/memory/plan.manager.ts:L100-L197`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/plan.manager.ts#L100-L197) |
| `src/memory/file-state-cache.ts` | `FileStateCache`, `fileStateCache` | Read dedup & post-compact restorer | **ACTIVE — UNCONDITIONAL EVALUATION** | `ReadFileTool`, `ContextManager` | None (In-memory Map) | Yes (`[Post-Compact Restoration]`)| None | [`src/memory/file-state-cache.ts:L27-L152`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/file-state-cache.ts#L27-L152) |
| `src/memory/headroom.compress.ts`| `compressBacklog`, `looksLikeCode` | Context backlog log compressor | **ACTIVE — CONDITIONAL EXECUTION (Pressure >= 0.70)**| `ContextManager.checkAndCompact` | None (Regex stream) | Yes (Compressed outputs) | Token pressure | [`src/memory/headroom.compress.ts:L83-L261`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/headroom.compress.ts#L83-L261) |
| `src/graph/sqlite.graph.store.ts`| `SqliteGraphStore`, `createGraphStore` | SQLite reference graph store | **ACTIVE — CONDITIONAL (Graph Present)** | `createContainer`, `ContextManager` | SQLite WAL database | Indirect (Graph topology) | SQLite support | [`src/graph/sqlite.graph.store.ts:L31-L207`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/sqlite.graph.store.ts#L31-L207) |
| `src/graph/pagerank.ts` | `computePageRank`, `formatRepoMapOutline`| PageRank RepoMap generator | **ACTIVE — CONDITIONAL (Graph Present)** | `ContextManager`, `crossRepoMapSync` | None (Matrix iteration) | Yes (`[RepoMap]`) | Graph index present | [`src/graph/pagerank.ts:L27-L190`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/pagerank.ts#L27-L190) |
| `src/graph/cross.repo.ts` | `crossRepoMapSync` | Multi-repository RepoMap synthesizer | **ACTIVE — CONDITIONAL (Graph Present)** | `ContextManager.checkAndCompact` | `formatRepoMapOutline` | Yes (`[RepoMap]`) | Graph index present | [`src/graph/cross.repo.ts:L30-L75`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/cross.repo.ts#L30-L75) |
| `src/graph/context.planner.ts` | `planContext`, `estimateTokens` | Symbol-level context pack generator | **ACTIVE — CONDITIONAL (via GraphContextTool)** | `GraphContextTool` | `SqliteGraphStore`, `readSymbolSource` | Yes (via GraphContextTool) | Graph index present | [`src/graph/context.planner.ts:L1-L169`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/context.planner.ts) |
| `src/graph/codemem/backend.ts` | `CodememBackend`, `globalCodemem` | Codebase-memory binary bridge | **FALLBACK TO NATIVE GRAPH** | `src/index.ts:L157`, `GraphTool` | `codebase-memory` MCP binary | Yes (when binary present) | External binary | [`src/graph/codemem/backend.ts:L43-L275`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/codemem/backend.ts#L43-L275) |
| `src/graph/indexer.ts` | `GraphIndexer` | AST walking & reference graph indexer | **ACTIVE — CONDITIONAL (via /index)** | `createContainer`, `/index` command | `StaticAnalyzer`, `TreeSitterAnalyzer`| Indirect (Builds graph) | None | [`src/graph/indexer.ts:L1-L240`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/indexer.ts) |
| `src/graph/static.analyzer.ts` | `StaticAnalyzer` | TypeScript/JavaScript AST parser | **ACTIVE — CONDITIONAL (via GraphIndexer)** | `GraphIndexer` | TypeScript compiler API | Indirect (Extracts symbols) | None | [`src/graph/static.analyzer.ts:L1-L320`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/static.analyzer.ts) |
| `src/graph/treesitter.analyzer.ts`| `TreeSitterAnalyzer` | Multi-language Tree-sitter AST parser | **ACTIVE — CONDITIONAL (via GraphIndexer)** | `GraphIndexer` | `web-tree-sitter` | Indirect (Extracts symbols) | WASM language grammars | [`src/graph/treesitter.analyzer.ts:L1-L280`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/treesitter.analyzer.ts) |
| `src/graph/semantic.augmenter.ts`| `SemanticAugmenter` | LLM-based node metadata augmentation | **ACTIVE — CONDITIONAL (via GraphIndexer)** | `GraphIndexer.augmentGraph` | `LlmAdapter.generateSemanticMetadata` | Indirect (Graph metadata) | API key | [`src/graph/semantic.augmenter.ts:L1-L90`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/semantic.augmenter.ts) |
| `src/graph/tdm.ts` | `TestDependencyMap`, `buildTdm` | Test dependency mapping & mutation claims | **ACTIVE — CONDITIONAL (Graph Present)** | `EpistemicLedger` | `SqliteGraphStore` | Indirect (Settles claims) | Graph index present | [`src/graph/tdm.ts:L1-L180`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/tdm.ts) |
| `src/graph/cognitive.graph.ts` | `CognitiveGraph` | Dead prototype for capability graph | **DEAD / UNUSED** | None | None | No | None | [`src/graph/cognitive.graph.ts:L4-L67`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/cognitive.graph.ts#L4-L67) |
| `src/mind/self.model.ts` | `SelfModel`, `getSelfModel` | Metacognitive failure rate tracker | **ACTIVE — POLICY-GATED INJECTION** | `BasePersona.buildSections`, `AgentLoop` | `.bimax/self-model.json` | Yes (`### SELF-KNOWLEDGE`) | `PolicyArms.decide` | [`src/mind/self.model.ts:L181-L378`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/self.model.ts#L181-L378) |
| `src/mind/epistemic.ledger.ts` | `EpistemicLedger`, `getEpistemicLedger`| Mutation claim settlement & calibration | **ACTIVE — POLICY-GATED INJECTION** | `BasePersona.buildSections`, mutating tools | `.bimax/epistemic.json`, `Tdm` | Yes (`### CALIBRATION`) | `PolicyArms.decide` | [`src/mind/epistemic.ledger.ts:L126-L377`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/epistemic.ledger.ts#L126-L377) |
| `src/mind/user.model.ts` | `UserModel`, `getUserModel` | Diff taste (k-NN) & preference assertions| **ACTIVE — POLICY-GATED INJECTION** | `BasePersona.buildSections`, `executeTurn`| `.bimax/user-model.json` | Yes (`### USER MODEL`) | `PolicyArms.decide` | [`src/mind/user.model.ts:L104-L419`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/user.model.ts#L104-L419) |
| `src/mind/habit.compiler.ts` | `HabitMiner`, `getHabitMiner` | Procedural tool sequence n-gram compiler | **ACTIVE — POLICY-GATED INJECTION** | `BasePersona.buildSections`, `executeTurn`| `.bimax/habits.json` | Yes (`### COMPILED HABITS`) | `PolicyArms.decide` | [`src/mind/habit.compiler.ts:L60-L278`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/habit.compiler.ts#L60-L278) |
| `src/mind/drives.engine.ts` | `DrivesEngine`, `getDrivesEngine` | Homeostatic codebase health checker | **ACTIVE — POLICY-GATED INJECTION** | `BasePersona.buildSections`, `/drives` | `.bimax/drives.json` | Yes (`### DRIVES`) | `PolicyArms.decide` | [`src/mind/drives.engine.ts:L155-L310`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/drives.engine.ts#L155-L310) |
| `src/mind/harness.tuner.ts` | `HarnessTuner`, `getHarnessTuner` | Lab-gated self-tuning steering patches | **ACTIVE — EVALUATED ON TURN / INJECTION CONDITIONAL** | `BasePersona.buildSections`, `executeTurn`| `.bimax/harness-patches.json` | Yes (`### HARNESS TUNING`) | Lab eval pass | [`src/mind/harness.tuner.ts:L83-L381`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/harness.tuner.ts#L83-L381) |
| `src/mind/exemplar.store.ts` | `ExemplarStore`, `getExemplarStore` | Episodic memory of verified past tasks | **ACTIVE — POLICY-GATED INJECTION** | `BasePersona.executeTurn` | `.bimax/exemplars.json`, `embedder`| Yes (`### VERIFIED EXPERIENCE`)| `PolicyArms.decide` | [`src/mind/exemplar.store.ts:L42-L98`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/exemplar.store.ts#L42-L98) |
| `src/mind/daily.journal.ts` | `journalPreloadBlock`, `journalDigest` | Daily work summaries from event ledger | **IMPLEMENTED BUT NOT PROVEN ACTIVE** | `BasePersona.buildSections` | `.bimax/mind/events.jsonl` | No (Dropped in `splitPrompt`) | None | [`src/mind/daily.journal.ts:L1-L120`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/daily.journal.ts) |
| `src/mind/policy.arms.ts` | `PolicyArms`, `getPolicyArms` | Randomized holdout & off-policy IPS gate | **ACTIVE — UNCONDITIONAL EVALUATION** | `BasePersona.buildSections`, `mind.ts` | `.bimax/policy-arms.json`, `EventLedger`| No (Decision gate) | None | [`src/mind/policy.arms.ts:L50-L185`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/policy.arms.ts) |
| `src/mind/event.ledger.ts` | `EventLedger`, `getEventLedger` | Append-only JSONL telemetry event ledger | **ACTIVE — UNCONDITIONAL EVALUATION** | All Mind engines, `AgentLoop` | `.bimax/mind/events.jsonl` | No (Telemetry stream) | None | [`src/mind/event.ledger.ts:L1-L120`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/event.ledger.ts) |
| `src/mind/embedder.ts` | `embed`, `cosine`, `nearest` | 256d FNV-1a hash kernel for Mind layer | **ACTIVE — UNCONDITIONAL EVALUATION** | `ExemplarStore`, `UserModel` | None (Pure arithmetic) | Indirect (Similarity) | None | [`src/mind/embedder.ts:L1-L100`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/embedder.ts) |
| `src/mind/taint.ts` | `TaintTracker`, `markToolTaint` | Security context taint tracking | **ACTIVE — UNCONDITIONAL TRACKING** | `ToolRegistry`, `Governor` | None (In-memory state) | Indirect (Governor blocks) | None | [`src/mind/taint.ts:L36-L107`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/taint.ts#L36-L107) |
| `src/mcp/client.manager.ts` | `ClientManager`, `createClientManager`| External MCP server connection manager | **ACTIVE — CONDITIONAL (Connected MCP)** | `createContainer`, `McpManageTool` | Child process stdio | Yes (External MCP tools) | Connected MCP servers | [`src/mcp/client.manager.ts:L1-L260`](file:///Users/vishsiddharth/Desktop/Bimax/src/mcp/client.manager.ts) |
| `src/__tests__/code.store.ram.ledger.test.ts`| RAM ledger benchmark | Benchmark asserting $< 200$ B/doc SQLite memory| **TEST ONLY** | Jest runner | `SqliteCodeVectorStore`, `VectorStore` | No (Test harness) | None | [`src/__tests__/code.store.ram.ledger.test.ts:L1-L147`](file:///Users/vishsiddharth/Desktop/Bimax/src/__tests__/code.store.ram.ledger.test.ts) |
| `src/__tests__/memory.eval.test.ts` | Retrieval eval benchmark | Offline retrieval benchmark (NDCG/MRR) | **TEST ONLY** | Jest runner | `VectorStore`, `RemoteEmbeddingBackend` | No (Test harness) | None | [`src/__tests__/memory.eval.test.ts:L1-L120`](file:///Users/vishsiddharth/Desktop/Bimax/src/__tests__/memory.eval.test.ts) |

---

## 36. Verified Material Symbol Inventory

| Symbol | File Path | Type | Responsibility | Runtime Status | Direct Caller(s) | Calls / Mutates | Model-Visible Consequence | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `ContextManager` | `src/memory/context.manager.ts:L79` | `class` | 5-layer context window management | **ACTIVE** | `BasePersona.sessionContext`, `AgentLoop` | Layer 0–4 compaction | Manages prompt budget & summaries | [`src/memory/context.manager.ts:L79`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L79) |
| `checkAndCompact` | `src/memory/context.manager.ts:L157` | `method` | Proactive layered compaction before API calls | **ACTIVE** | `AgentLoop.execute` | `compressBacklog`, `microCompact`, `compact` | Compresses message history array | [`src/memory/context.manager.ts:L157`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L157) |
| `updateTokens` | `src/memory/context.manager.ts:L138` | `method` | Calibrates request overhead from provider usage | **ACTIVE** | `AgentLoop.execute` on usage event | `overheadTokens`, `currentTokens` | Calibrates effective pressure ratio | [`src/memory/context.manager.ts:L138`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/context.manager.ts#L138) |
| `VectorStore` | `src/memory/vector.store.ts:L191` | `class` | 4-stage hybrid long-term vector store | **ACTIVE** | `createContainer`, `ProjectMemory` | `Bm25Index`, `RemoteEmbeddingBackend` | Auto-recall & project memory hits | [`src/memory/vector.store.ts:L191`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/vector.store.ts#L191) |
| `semanticSearch` | `src/memory/vector.store.ts:L443` | `method` | BM25 $\parallel$ Dense $\rightarrow$ RRF $\rightarrow$ Rerank search | **ACTIVE** | `recallForTurn`, `ProjectMemory.recall` | `Bm25Index.search`, `embed`, `rerank` | Returns formatted memory hits | [`src/memory/vector.store.ts:L443`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/vector.store.ts#L443) |
| `RemoteEmbeddingBackend` | `src/memory/embeddings.ts:L106` | `class` | Remote OpenAI/NVIDIA `/embeddings` backend | **RUNTIME-CAPABLE** | `createContainer`, `VectorStore`, `CodeIndex` | HTTP POST `/embeddings` | Provides dense vectors for RAG | [`src/memory/embeddings.ts:L106`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/embeddings.ts#L106) |
| `RemoteReranker` | `src/memory/rerank.ts:L78` | `class` | Remote cross-encoder `/ranking` backend | **RUNTIME-CAPABLE** | `createContainer`, `VectorStore`, `CodeIndex` | HTTP POST `/ranking` | Reorders retrieval candidate window | [`src/memory/rerank.ts:L78`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/rerank.ts#L78) |
| `CodeIndex` | `src/memory/code.index.ts:L110` | `class` | Semantic code search manager & sync orchestrator | **ACTIVE** | `createContainer`, `CodeSearchTool` | `SqliteCodeVectorStore` | Provides code search tool results | [`src/memory/code.index.ts:L110`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/code.index.ts#L110) |
| `SqliteCodeVectorStore` | `src/memory/sqlite.code.store.ts:L56` | `class` | SQLite FTS5 + int8 streamed vector store | **ACTIVE** | `CodeIndex` | SQLite WAL FTS5 + `embs` table | Streams code chunks to model | [`src/memory/sqlite.code.store.ts:L56`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/sqlite.code.store.ts#L56) |
| `computePageRank` | `src/graph/pagerank.ts:L27` | `function` | Iterative PageRank over code reference graph | **ACTIVE** | `formatRepoMapOutline`, `getTopNodes` | In-memory graph nodes & edges | Ranks symbols for RepoMap outline | [`src/graph/pagerank.ts:L27`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/pagerank.ts#L27) |
| `formatRepoMapOutline` | `src/graph/pagerank.ts:L120` | `function` | Formats PageRank outline with focus-term boost | **ACTIVE** | `ContextManager.checkAndCompact`, `crossRepo`| `computePageRank`, `_mapCache` | Injects `[RepoMap]` system message | [`src/graph/pagerank.ts:L120`](file:///Users/vishsiddharth/Desktop/Bimax/src/graph/pagerank.ts#L120) |
| `recallForTurn` | `src/memory/recall.ts:L93` | `function` | Executes involuntary turn-based memory recall | **ACTIVE** | `AgentLoop.injectRecall` | `VectorStore.semanticSearch` | Injects `[Recalled memory]` system msg | [`src/memory/recall.ts:L93`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/recall.ts#L93) |
| `globalProjectMemory` | `src/memory/project.memory.ts:L56` | `const (instance)` | Singleton project conventions manager | **ACTIVE** | `BasePersona.executeTurn`, `RememberTool` | `VectorStore` | Injects `### PROJECT MEMORY` block | [`src/memory/project.memory.ts:L56`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/project.memory.ts#L56) |
| `fileStateCache` | `src/memory/file-state-cache.ts:L152` | `const (instance)` | LRU file read cache & post-compact restorer | **ACTIVE** | `ReadFileTool`, `EditFileTool`, `ContextManager` | In-memory `Map` | Injects `[Post-Compact Restoration]` | [`src/memory/file-state-cache.ts:L152`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/file-state-cache.ts#L152) |
| `compressBacklog` | `src/memory/headroom.compress.ts:L224` | `function` | Native deterministic tool backlog compressor | **ACTIVE** | `ContextManager.checkAndCompact` | Tool message content string | Collapses repetitive log dumps | [`src/memory/headroom.compress.ts:L224`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/headroom.compress.ts#L224) |
| `getSelfModel` | `src/mind/self.model.ts:L381` | `function` | Singleton factory for SelfModel | **ACTIVE** | `BasePersona.buildSections`, `AgentLoop` | `.bimax/self-model.json` | Injects `### SELF-KNOWLEDGE` block | [`src/mind/self.model.ts:L381`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/self.model.ts#L381) |
| `getEpistemicLedger` | `src/mind/epistemic.ledger.ts:L379` | `function` | Singleton factory for EpistemicLedger | **ACTIVE** | `BasePersona.buildSections`, mutating tools | `.bimax/epistemic.json` | Injects `### CALIBRATION` block | [`src/mind/epistemic.ledger.ts:L379`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/epistemic.ledger.ts#L379) |
| `getUserModel` | `src/mind/user.model.ts:L421` | `function` | Singleton factory for UserModel | **ACTIVE** | `BasePersona.buildSections`, `executeTurn` | `.bimax/user-model.json` | Injects `### USER MODEL` block | [`src/mind/user.model.ts:L421`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/user.model.ts#L421) |
| `getHabitMiner` | `src/mind/habit.compiler.ts:L280` | `function` | Singleton factory for HabitMiner | **ACTIVE** | `BasePersona.buildSections`, `executeTurn` | `.bimax/habits.json` | Injects `### COMPILED HABITS` block | [`src/mind/habit.compiler.ts:L280`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/habit.compiler.ts#L280) |
| `getDrivesEngine` | `src/mind/drives.engine.ts:L320` | `function` | Singleton factory for DrivesEngine | **ACTIVE** | `BasePersona.buildSections`, `/drives` | `.bimax/drives.json` | Injects `### DRIVES` block | [`src/mind/drives.engine.ts:L320`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/drives.engine.ts#L320) |
| `getHarnessTuner` | `src/mind/harness.tuner.ts:L383` | `function` | Singleton factory for HarnessTuner | **ACTIVE** | `BasePersona.buildSections`, `executeTurn` | `.bimax/harness-patches.json` | Injects `### HARNESS TUNING` block | [`src/mind/harness.tuner.ts:L383`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/harness.tuner.ts#L383) |
| `getExemplarStore` | `src/mind/exemplar.store.ts:L100` | `function` | Singleton factory for ExemplarStore | **ACTIVE** | `BasePersona.executeTurn` | `.bimax/exemplars.json` | Injects `### VERIFIED EXPERIENCE` block | [`src/mind/exemplar.store.ts:L100`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/exemplar.store.ts#L100) |
| `getPolicyArms` | `src/mind/policy.arms.ts:L180` | `function` | Singleton factory for PolicyArms | **ACTIVE** | `BasePersona.buildSections`, `mind.ts` | `.bimax/policy-arms.json` | Gates injection of Mind blocks | [`src/mind/policy.arms.ts:L180`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/policy.arms.ts#L180) |
| `getTaintTracker` | `src/mind/taint.ts:L58` | `function` | Singleton factory for TaintTracker | **ACTIVE** | `markToolTaint`, `Governor` | In-memory taint set | Restricts network shell tool calls | [`src/mind/taint.ts:L58`](file:///Users/vishsiddharth/Desktop/Bimax/src/mind/taint.ts#L58) |

---

## 37. Performance Claims Provenance Matrix

| Stated Value | Metric | Provenance Classification | Verifiable Source Citation |
| :--- | :--- | :--- | :--- |
| **$< 200$ bytes / document** | SQLite resident RAM cost in test harness | **MEASURED (in test harness)** | `src/__tests__/code.store.ram.ledger.test.ts:L102` (`expect(sqliteStore.residentBytes()).toBeLessThan(N * 200)`) |
| **768 bytes / chunk** | int8 quantized vector blob disk size | **CALCULATED** | $768\text{ dimensions} \times 1\text{ byte/dim} = 768\text{ bytes}$ blob per chunk ([`src/memory/sqlite.code.store.ts:L433-L442`](file:///Users/vishsiddharth/Desktop/Bimax/src/memory/sqlite.code.store.ts#L433-L442)) |
| **128,000 tokens** | Fallback constructor default context window | **CONFIGURED** | `src/memory/context.manager.ts:L124` (`maxTokens: number = 128000`) |
| **0.70 (70%)** | Compaction threshold ratio | **CONFIGURED** | `src/memory/context.manager.ts:L81` (`private readonly COMPACT_THRESHOLD = 0.7`) |
| **0.50 (50%)** | Early warning & micro-compact threshold | **CONFIGURED** | `src/memory/context.manager.ts:L82` (`private readonly WARN_THRESHOLD = 0.5`) |
| **16,000 chars** | Tool result capping limit | **CONFIGURED** | `src/memory/context.manager.ts:L87` (`private readonly TOOL_RESULT_MAX_CHARS = 16000`) |
| **40,000 chars** | Post-compact file restoration budget | **CONFIGURED** | `src/memory/context.manager.ts:L91` (`private readonly RESTORE_BUDGET_CHARS = 40_000`) |
| **~10,000 tokens** | Derived token equivalent for 40,000 chars | **CALCULATED HEURISTIC** | $40,000\text{ chars} / 4\text{ chars/tok} = 10,000\text{ tokens}$ |
| **1,500 tokens** | Default RepoMap budget | **CONFIGURED** | `src/graph/pagerank.ts:L120` (`maxTokens = 1500`) |
| **24 candidates** | Reranker candidate window | **CONFIGURED** | `src/memory/rerank.ts:L75` (`DEFAULT_MAX_CANDIDATES = 24`) |
| **~100 ms at 100k chunks** | Estimated SQLite streamed scan latency | **ESTIMATE** | `src/memory/sqlite.code.store.ts:L19-L21` comment (Calculated from $76.8\text{ MB}$ disk read throughput) |
| **~80–250 ms** | Estimated remote embedding API latency | **ESTIMATE** | Network transit time to remote provider API |
| **~2.5–5.0 s** | Estimated Layer 4 LLM summarization latency | **ESTIMATE** | Model completion generation time for 5-section summary |

---

## 38. PolicyArms Decision Matrix

| Mind Prompt Block | Producer Function | PolicyArms ID | `decide()` Call Location | Action on `show: false` | Verified in Code? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `selfKnowledge` | `getSelfModel().getPromptBlock()` | `'self-knowledge'` | [`src/cli/personas/base.persona.ts:L385`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L385) | Returns `''`, omitted from `turnContext` | **YES** |
| `habits` | `getHabitMiner().getPromptBlock()` | `'habits'` | [`src/cli/personas/base.persona.ts:L386`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L386) | Returns `''`, omitted from `turnContext` | **YES** |
| `userModel` | `getUserModel().getPromptBlock()` | `'user-model'` | [`src/cli/personas/base.persona.ts:L387`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L387) | Returns `''`, omitted from `turnContext` | **YES** |
| `drives` | `getDrivesEngine().getPromptBlock()` | `'drives'` | [`src/cli/personas/base.persona.ts:L391`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L391) | Returns `''`, omitted from `turnContext` | **YES** |
| `calibration` | `getEpistemicLedger().getPromptBlock()` | `'calibration'` | [`src/cli/personas/base.persona.ts:L392`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L392) | Returns `''`, omitted from `turnContext` | **YES** |
| `exemplars` | `getExemplarStore().getPromptBlock()` | `'exemplars'` | [`src/cli/personas/base.persona.ts:L567`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L567) | Sets `exemplars = ''`, omitted from `turnContext` | **YES** |
| `journal` | `journalPreloadBlock()` | `'journal'` | [`src/cli/personas/base.persona.ts:L390`](file:///Users/vishsiddharth/Desktop/Bimax/src/cli/personas/base.persona.ts#L390) | Assigned to `sections.journal` (Omitted from `splitPrompt`) | **YES (Omitted from Prompt)** |
| `harnessPatches` | `getHarnessTuner().getPromptBlock()` | None | None | Injected directly into `turnContext.harnessPatches` | **YES (Bypasses PolicyArms)** |

---

## 39. Assumption Purge Log

| Previous Claim / Statement | Problem Identified | Action Taken | Remaining Occurrences in Report | Final Wording / Status |
| :--- | :--- | :--- | :--- | :--- |
| **"Adversarial Verifier Pass: `BasePersona.verify()` executes model calls"** | Method `BasePersona.verify()` does not exist in `base.persona.ts`. Previous audit inferred its existence from test names. | **DELETED** | 0 | Removed from Model Invocation Inventory. |
| **"Universal 120k context limit across all models"** | Inferred from comments; actual code scales to `caps.contextWindow` (e.g. 200k, 1M) and uses `128,000` as constructor fallback. | **CORRECTED** | 0 | Described exact dynamic resolution precedence: User config $\rightarrow$ Model Capabilities table $\rightarrow$ 128k fallback. |
| **"IPS computes unbiased lift"** | Statistical claim asserted without proving standard off-policy observational assumptions. | **REFORMULATED** | 0 | Described as: "Computes self-normalized Inverse Propensity Scoring (SN-IPS) estimate using formula $V(\text{show}) - V(\text{hide})$." |
| **"Every learned Mind block passes through PolicyArms"** | `harnessPatches` bypasses `PolicyArms` and injects directly. `sections.journal` is gated but dropped in `splitPrompt()`. | **CORRECTED** | 0 | Explicitly documented per-block gating in Section 18 and Section 38. |
| **"Assistant tool_calls JSON tokens are absorbed into overheadTokens"** | Attributed residual specifically to tool calls; in reality `overheadTokens` absorbs all unmodeled prompt token components. | **REFORMULATED** | 0 | Clarified that residual captures difference between provider usage and local estimate; contributors include serialized tool schemas, assistant tool calls, framing, and vision tokens. |
| **"Zero-Resident RAM code search in production RSS"** | Metric was proven in test harness `residentBytes()` (<200 B/doc), not total Node.js RSS process memory. | **RELABELED** | 0 | Labeled as `MEASURED (in test harness residentBytes())`. |
| **"CognitiveGraph was replaced by GoalManager and PlanManager"** | Historical replacement causality was inferred from functional overlap without direct migration evidence. | **CORRECTED** | 0 | Replaced with: "CognitiveGraph is currently unused. GoalManager and PlanManager implement related functionality in the current runtime." |
| **"Involuntary Auto-Recall runs on every turn"** | Stated as unconditional, but code enforces query length $\ge 24$, non-slash commands, and session dedup. | **CORRECTED** | 0 | Reclassified to `PARTIALLY VERIFIED / CONDITIONAL`. |
| **"Anthropic prompt cache TTL nominally 5 minutes"** | Numeric duration was external product knowledge not derived from repository code. | **REMOVED NUMBER**| 0 | Replaced with: "Provider-side cache retention duration cannot be determined from repository source code." |

---

## 40. Remaining Unverified Claims Register

| Claim / Question | Why Not Fully Proven from Source Code Alone | Current Status | Evidence Needed for Full Verification |
| :--- | :--- | :--- | :--- |
| **Provider-Side Prompt Cache Retention Duration** | Provider cache retention TTL is enforced remotely by provider API servers. | `UNVERIFIABLE (Server-Side)` | Live network billing telemetry logging `cache_read_input_tokens` across varied inter-turn pauses. |
| **Mid-Session Dynamic Model Switching Token State** | `BasePersona.sessionContext` recreates `ContextManager` when `contextWindow` changes, but `overheadTokens` residual from the previous model may carry over until the first token usage update. | `UNKNOWN` | Multi-turn integration test asserting `overheadTokens` before and after mid-session model switch. |
| **Multimodal in-place array mutation vs WeakMap token-cache invalidation** | `countMessageTokens` compares `hit.content === m.content` by reference identity; in-place array mutations would not trigger cache invalidation unless object reference is replaced. | `UNKNOWN` | Code test verifying whether any runtime path mutates `ContentPart[]` in place. |

---

## 41. Final Verification Checklist

- [x] Verified file inventory includes bootstrap, container, tool implementations, Governor, config, AST analyzers, TDM, and Mind singletons
- [x] Every file referenced in report checked against Section 35
- [x] Every material symbol checked against Section 36
- [x] Tool-mediated RAG distinguished from automatic RAG in Section 14
- [x] Documentation claims compared against runtime implementation in Section 28
- [x] TODO / Future / Stub sweep verified in Section 32
- [x] Trace examples formulated as algorithmic walkthroughs without hypothetical numbers
- [x] Quantitative claims classified in Performance Provenance Matrix (Section 37)
- [x] Optional dependencies reflected in Scorecard (Section 2) and Dependency Matrix (Section 25)
- [x] Context window resolution traced through `capabilitiesFor` and `BasePersona.executeTurn`
- [x] String-content cache invalidation by reassignment/reference change verified
- [ ] Multimodal/in-place ContentPart[] mutation cache safety fully verified
- [x] PolicyArms gating and omissions documented per block in Section 38
- [x] Context Source Budget Map updated with explicit size provenance (Section 20)
- [x] Persistence Survival Matrix verified with explicit write and read paths (Section 21)
- [x] Model-Visible vs Control-Plane Matrix verified in Section 22
- [x] Fabricated invocation paths (`BasePersona.verify`) purged from Model Invocation Inventory (Section 5)
- [x] Assumption Purge Log created in Section 39
- [x] Remaining Unverified Claims Register created in Section 40
- [ ] Provider-side cache retention duration independently verified via live network billing (Server-Side Enforced)

---

## 42. Final Consistency Result

- **Contradictions Corrected**: 10 (WeakMap checklist assertion split, PolicyArms universality, IPS unbiasedness claim, token residual single-component attribution, `BasePersona.verify` invocation, CognitiveGraph historical replacement claim, universal 120k context limit, Auto-Recall unconditional claim, external cache TTL number, Section 35 runtime statuses synchronized with execution conditions).
- **Claims Downgraded / Relabeled**: 4 (`sections.journal` marked `IMPLEMENTED BUT NOT PROVEN ACTIVE`; `code.store.ram.ledger.test.ts` labeled test-harness measured; `Auto-Recall` marked conditional; `CognitiveGraph` marked unused without replacement assertion).
- **Claims Removed**: 2 (Fabricated `BasePersona.verify()` method; unproven 5-minute external TTL).
- **Remaining UNKNOWN / UNVERIFIABLE Items**: 3 (Provider-side cache retention duration, mid-session model switch overhead carryover, multimodal in-place array mutation vs WeakMap cache invalidation).
- **Assumption Leakage Status**: No known assumption leakage found after the defined static checks; explicitly unresolved items remain registered.

---

*Report compiled, line-verified, and finalized against Bimax codebase repository source.*
