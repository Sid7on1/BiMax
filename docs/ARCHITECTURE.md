# BiMax — Complete Architecture & Subsystem Reference

This is the exhaustive reference: **every subsystem, every tool, every command**, what it
is, how it works, and why it matters. For the highlight reel see [FEATURES.md](./FEATURES.md).

Source layout (`src/`): `core` `cli` `tools` `governor` `memory` `graph` `genome`
`evolution` `sandbox` `task` `actions` `api` `auth` `plugins` `credits` `providers`
`telemetry` `terminal` `storage` `state` `security` `config` `utils`.

---

## 1. Runtime & entry

- **`src/index.ts` / `src/cli/index.ts`** — CLI entry. Parses flags (`-p/--print`,
  `--print-with-tools`, `--dangerously-skip-permissions`, agent, model), loads env
  (`src/cli/env.loader.ts`, which reads `~/.breakglass/.env`), boots the DI container, and
  either drives the engine over the NDJSON stdio protocol for the Go/Bubble Tea TUI (the sole
  interactive front-end; see §13) or runs one-shot print mode.
- **`src/core/container.ts`** — the **dependency-injection container**. Wires the entire
  graph in one factory: event bus, telemetry, DB, governor, LLM adapter, tool registry,
  graph store, memory, coordinator/worker, task pipeline. One place to understand how
  everything connects.
- **`src/core/bootloader.ts`** — ordered startup (validate env → telemetry → DB → API →
  auth → ready). **`src/core/shutdown.coordinator.ts`** — idempotent graceful shutdown
  (teardown hooks run once on SIGINT/SIGTERM).
- **`src/core/event.bus.ts`** — internal pub/sub used across subsystems; has an error
  handler so a bad listener can't crash the process.
- **`src/core/correlation.ts`** — attaches a correlation id to async work for traceable
  logs. **`src/core/errors.ts`** — typed errors (`AppError`, `GovernorVetoError`).

## 2. The agent loop & LLM layer (`src/core`)

- **`agent.loop.ts` — `AgentLoop`**: the heart. Streams a turn, surfaces tokens/thinking,
  executes tool calls (parallel for concurrency-safe tools, sequential for destructive),
  feeds results back, and iterates to a configurable max. Includes the output-contract
  sanitizer, regenerate-on-empty guard, and text-tool-call recovery.
- **`llm.adapter.ts` — `LlmAdapter`** (implements `LLMProvider`): the OpenAI-compatible
  client used for every provider. Streaming `chat()` with tool calls + usage; helpers
  `generateTinyPlans` (JSON plans), `generateChatResponse`, `chatCompletion`,
  `generateSemanticMetadata`. Contains:
  - **`ThinkTagFilter` / `stripThink`** — separate `<think>…</think>` reasoning from the
    visible reply (reasoning-model support), plus the `reasoning_content` channel.
  - **`extractJson`** — pull balanced JSON out of fenced/prose model output.
  - **Budget hooks** — reserve/record/release spend around every call.
  - **Stream-read watchdog** (`BGW_STREAM_TIMEOUT_MS`) and request timeout (`BGW_TIMEOUT`).
  - Optional **`reasoning_effort`** (`BGW_REASONING_EFFORT`), `temperature`, `maxTokens`.
- **`response.sanitizer.ts` — `ResponseSanitizer`**: strips leaked tool-meta filler ("No
  function call is needed…") and reports when a turn was *only* filler so the loop can
  regenerate. **`tool.call.parser.ts`** — recovers tool calls a model wrote as plain JSON.
- **`llm.provider.ts`** — the `LLMProvider`/`Message`/`ChatOptions`/`ChatEvent` contract.

## 3. Tools (`src/tools`)

`tool.registry.ts` (`ToolRegistry`) holds tools; `tool.factory.ts` builds them with
governor gating, destructive/concurrency flags, and schema. The full surface (41 tools across
`src/tools/implementations/`, grouped by domain — this is the WS6 inventory):

**Editing & files** — **ReadFileTool**, **WriteFileTool** (auto-backed-up), **EditFileTool** (exact
search/replace), **MultiEditTool** (atomic multi-file batch), **SymbolEditTool** (AST-addressed edit
by symbol name), **DeleteTool** (`FILE_DELETE`), **CreateDirectoryTool**, **NotebookEditTool** (edit
`.ipynb` cells).

**Search & navigation** — **GrepTool** (content), **GlobTool** (filename), **ChangeDirectoryTool**,
**GraphQueryTool** / **GraphContextTool** (live code graph; index-gated), **LspQueryTool** (built-in
LSP subset), **ScoutTool** (fast read-only recon), **ToolSearchTool** (fuzzy tool discovery).

**Execution & VCS** — **BashTool** (risk-classified shell), **GitTool** (status/diff/log/add/commit,
no push), **RelatedTestsTool** (jest/vitest/go related-tests).

**Web** — **WebFetchTool** (URL→text, SSRF-guarded, 30s), **WebSearchTool**.

**Memory & context** — **RememberTool** (durable project memory), **MemoryQueryTool** (semantic
recall), **FreeContextTool** (drop stale context under pressure), **GoalsTool** (session goals).

**Sub-agents & planning** — **SpawnSubagentTool** (worker for a sub-task), **TasksTool** (manage/kill
live sub-agents), **PlanTool** (structured plan), **AskUserTool** (real decision when blocked).

**Tasks & extensions** — **TodoWriteTool** (live checklist), **SkillTool** / **SkillInstallTool** /
**SkillAuthorTool** (use/install/author skills), **McpManageTool** (discover/add MCP servers),
**RegisterAgentTool** (register a CLI as a persona), **ModeTool**, **ModelManageTool**,
**WorkspaceTool** (multi-repo).

**Blueprints & training** — **BlueprintTool**, **TrainLaunchTool**, **TrainMonitorTool**.

### 3.1 WS6 tool-quality assessment (2026-07-11)

Audited for schema quality, description quality, error behavior, and streaming. **Verdict: the
surface is solid** — the founder's "some tools improperly built / used below capability" predated
the hardening + surgical-precision-tools work that has since landed.

- **Schemas**: typed JSON schema with per-parameter `description` and `required` arrays throughout.
- **Descriptions**: the model-facing tools (Bash, Edit family, Git, Graph, Spawn) carry rich
  multi-line usage docs (actions, addressing, when-to-use). No thin one-liners on load-bearing tools.
- **Error behavior**: mutating/executing tools whose outcomes the mind layer *attributes* (Bash,
  Write, Edit, MultiEdit, SymbolEdit) all return **typed outcomes** (`outcomeOk`/`outcomeError` with
  a class). Meta/read tools (mode, model, goals, memory, search, git-read) return plain strings by
  design — the typed-outcome contract is intentionally scoped to attributed actions, not universal.
- **No worst-first emergencies** were found; the earlier `SymbolEdit` permission gap (see §4.4) was
  the one real defect and is fixed. Remaining polish (e.g. broaden typed outcomes to more tools) is
  optional, tracked in `ROADMAP.md`, not blocking.

## 4. Governor & security — the guard pipeline (`src/governor`, `src/security`, `src/tools`)

There is **one ordered guard pipeline**, not a scattering of ad-hoc checks. Every tool the model
calls is wrapped by `tool.factory.ts` `buildTool`, so the sequence below is fixed and centralized;
the write-path tools add a few integrity guards *inside* their own `execute`. This is the WS5 audit
(the count the founder asked for): **enumerated, ordered, and classified.**

### 4.1 Per-LLM-request guards (before a model call)

| # | Guard | File | Purpose | Class |
|---|---|---|---|---|
| R1 | **Capability shaping** | `core/capabilities.ts` → `llm.adapter.ts` | Strip params the target provider/model doesn't serve (`reasoning_effort`, `parallel_tool_calls`, fixed-sampling `temperature`) before send, instead of 400ing. | load-bearing (WS1) |
| R2 | **BudgetVeto** | `governor/budget.veto.ts` (held by the adapter via `setBudgetVeto`) | Hard daily spend cap (`MAX_DAILY_SPEND`, default $5), mutex reserve→record→release, persisted, per-day reset. Lifted with `bypass`. | load-bearing |
| R3 | **Headroom compression** | `memory/headroom.compress.ts` | Gated under token pressure only; code-guarded (`looksLikeCode` restores code verbatim). | load-bearing (optional) |

### 4.2 Per-tool-call guards (every tool, via `buildTool`)

Fixed order. `governor.approveTaskExecution` is itself a layered engine (`governor.ts`):

| # | Guard / layer | File:sym | Applies to | Class |
|---|---|---|---|---|
| T1 | **bypass short-circuit** | `governor.ts` | all (mode=`bypass`) | load-bearing |
| T2 | **plan-mode block** | `governor.ts` | mutating tasks when mode=`plan` | load-bearing |
| T3 | **taint restriction** | `mind/taint.ts` `taintRestriction` | `OS_COMMAND` after untrusted content entered context | load-bearing |
| T4 | **persistent rules** | `governor.ts` `rules[]` | allow/deny by taskType (taint can't waive) | load-bearing |
| T5 | **fs veto** | `governor/fs.veto.ts` | `FILE_WRITE`/`FILE_DELETE` — workspace confinement, forbidden paths/exts | load-bearing |
| T6 | **bash static analysis** | `governor/bash.analyzer.ts` | `OS_COMMAND` — tree-sitter risk classify; read-safe auto-approves | load-bearing |
| T7 | **ML classifier** | `security/yolo.classifier.ts` | `OS_COMMAND`, mode=`auto`, ambiguous | load-bearing — **but wired only in the main session** (see 4.4) |
| T8 | **interactive prompt** | `governor.ts` → `GlobalPrompter` | destructive tasks / mode=`strict` | load-bearing |
| T9 | **PreToolUse hooks** | `tools/hooks.ts` | all — user hooks may block | load-bearing |
| … | *(tool executes)* | | | |
| T10 | **PostToolUse hooks** | `tools/hooks.ts` | all — may append (e.g. verify-loop typecheck feedback) | load-bearing |

### 4.3 Write-path integrity guards (inside `file`/`edit`/`multiedit`/`symboledit` tools)

These run *after* T1–T9, in each write tool's `execute`. Purposes are distinct (permission ≠
integrity ≠ approval ≠ rollback), so none is redundant with the governor:

| # | Guard | File:sym | Purpose |
|---|---|---|---|
| W1 | **blast-radius gate** | `cli/blastGate.ts` `checkBlastRadius` | Confirm before overwriting a graph-critical symbol. **Opt-in** (`enabled=false` default). |
| W2 | **diff approval** | `requestDiffApproval` | Inline diff confirm; no-op unless enabled + approver registered. |
| W3 | **corrupt-write guard** | `tools/write-guard.ts` `detectCorruptWrite` | Refuse a flattened/newline-stripped full-file overwrite. |
| W4 | **Edit Shield** | `tools/syntax.check.ts` `shieldEdit` | Refuse a write that adds NEW syntax errors vs. disk. |
| W5 | **transaction + backup** | `sandbox` rollback / `backupFile` | Snapshot pre-write state for `/undo`, `/diff-file`, `/tx` rollback. |

Also cross-cutting: **`policy.engine.ts` `SafetyPolicy.allowedWorkspace`** (narrowed for floored
sub-agents), **`ask-guard.ts` `detectDegenerateAsk`** (AskUser quality gate, wired in `ask_user.tool.ts`),
**`sandbox/exec.sandbox.ts`** (kernel sandbox for Bash under a floor), **`plugins/plugin.sandbox.ts`**.

### 4.4 Findings (WS5 step 2 — classify: load-bearing / redundant / dead)

- **All guards above are load-bearing** — none dead, none a duplicate of another's purpose. The
  founder's "hell of guards, idk how many" resolves to **one ordered pipeline of ~13 checks + 5
  write-path integrity guards**, most short-circuiting for read-only work.
- **✅ Fixed (WS5 step 3): SymbolEdit permission gap.** `SymbolEditTool` wrote files but called the
  governor nowhere (it relied on its own `workspaceWriteBlock` + opt-in diff approval), so in
  interactive mode it wrote WITHOUT the permission prompt `EditFileTool` gets. It's now mapped to
  `FILE_WRITE` in `tool.factory.ts` `TASK_TYPE_MAP`, so `buildTool` runs T5+T8 on it like any write.
- **✅ Done (WS5 step 3): per-guard timing.** `tools/guard.timing.ts` accumulates wall-time for
  `governor:approve` / `hooks:pre` / `hooks:post` per session; `/perf` renders it so a slow guard is
  visible before it's blamed. (In-memory, best-effort, off the LLM hot path.)
- **Decision (kept as-is): sub-agents have no `YoloClassifier`.** Workers build `new Governor(eventBus)`
  without it (`worker.entry.ts`), so T7 is a no-op for them. Left unchanged deliberately — the ML
  classifier is LLM-backed (adds a token-costing call per ambiguous bash command), so arming it in
  every worker would tax autonomous swarms; workers run in worktrees under the parent's mode. Now
  documented rather than accidental.
- **Deferred (low value): W3+W4 factoring.** `detectCorruptWrite` (W3, write-only) + `shieldEdit`
  (W4) are called inline per write tool, but the real logic already lives in one place each
  (`write-guard.ts`, `syntax.check.ts`); the call sites only format tool-specific error text. A
  `guardWrite()` wrapper would unify ~3 lines apiece at the cost of flattening those messages — not
  worth the churn now. `MultiEditTool` stays out of `TASK_TYPE_MAP` by design (multi-file; gates
  per-file internally) — now commented in the map.

## 5. Memory stack (`src/memory`)

- **`short.term.ts` — `ShortTermMemory`**: working message buffer with pruning that
  preserves system messages.
- **`vector.store.ts` — `VectorStore`** + **`embeddings.ts` — `EmbeddingsGenerator`** +
  **`long.term.ts` — `LongTermMemory`**: semantic long-term memory (offline embedding +
  similarity search).
- **`project.memory.ts` — `ProjectMemory`** (`globalProjectMemory`): durable per-project
  conventions/decisions/gotchas; `recallBlock()` injects relevant memories into each turn's
  system prompt. Backed by `/remember` and `RememberTool`.
- **`context.engine.ts` — `ContextEngine`**: blends short + long term for the working set.
- **`context.manager.ts` — `ContextManager`**: token accounting and **auto-compaction**
  (summarize older turns at ~70% capacity) without splitting tool-call/result pairs;
  reactive compaction on context-length errors.

## 6. Code graph & genome (`src/graph`, `src/genome`)

- **`graph.store.ts` — `GraphStore`** (`models.ts`: `GraphNode`/`GraphEdge`): persistent
  graph of the codebase (`.breakglass/graph/`).
- **`static.analyzer.ts` — `StaticAnalyzer`** + **`indexer.ts` — `CodebaseIndexer`**: parse
  source into nodes/edges (AST structure) — `/index`.
- **`semantic.augmenter.ts` — `SemanticAugmenter`**: LLM-derived metadata per node
  (purpose, criticality, risk score) — `/index-ai`.
- **`graph.observer.ts` — `GraphObserver`**: keeps the graph fresh as files change.
- **`impact.engine.ts` — `ImpactEngine`** (`BlastRadiusReport`): **blast-radius** analysis —
  what depends on a symbol/file — powers `/impact`.
- **`cognitive.graph.ts` — `CognitiveGraph`**: higher-level reasoning over the graph;
  powers `/ask` (answer architecture questions from the graph).
- **`genome/genome.repository.ts`**: the **architecture genome** — `components.json`,
  `contracts.json`, `permissions.json` describing BiMax's own components and the contracts
  they must honor.
- **`genome/guardian.ts` — `ArchitectureGuardian`**: validates a candidate change against
  its component contract (e.g. required emitted events) — the hard gate for `/evolve`.

## 7. Multi-agent orchestration (`src/evolution`, `src/core`)

All run in **isolated git worktrees** so your branch is never touched until you merge.
- **`worktree.manager.ts` — `WorktreeManager`**: create/commit/merge/remove worktrees via
  `execFile` (no shell — injection-safe). Shared by all four features below.
- **`subagent.manager.ts` — `SubAgentManager`**: spawns sub-agents as **worker threads**
  (`src/cli/worker.entry.ts`), with a **watchdog timeout** (`BGW_WORKER_TIMEOUT_MS`) so a
  hung worker can't block the parent.
- **`swarm.orchestrator.ts` — `SwarmOrchestrator`** (`/swarm`): decompose → topological
  "waves" → parallel workers → merge to an integration branch.
- **`speculative.solver.ts` — `SpeculativeSolver`** (`/speculate`): propose N distinct
  approaches → implement each in parallel → test → recommend the best.
- **`council.orchestrator.ts` — `CouncilOrchestrator`** (`/council`): run rival external AI
  CLIs (claude/gemini/opencode/bimax), judge by your test suite, keep the winner.
- **`genome.evolver.ts` — `GenomeEvolver`** (`/evolve`): edit BiMax's own source under the
  Architecture Guardian; type-check + test; keep on a branch only if the guardian passes.
- **`core/coordinator.ts` / `worker.agent.ts`**: the event-driven dispatcher + worker used
  for autonomous parallel sub-task execution (retries failed sub-tasks up to 3×).

## 8. Sandbox & safety (`src/sandbox`)

- **`checkpoint.manager.ts` — `CheckpointManager`** (`globalCheckpointManager`): the **Time
  Machine** — snapshot (`/checkpoint`) and restore (`/rewind`) the working tree; manual ★
  and auto checkpoints.
- **`test.healer.ts` — `TestHealer`** (`/heal`): run tests; if red, a fix agent iterates in
  a worktree until green, then surfaces the patch on a branch.
- **`verify.loop.ts`**: the verify-after-edit loop used by the flows above.

`/undo`, `/backups` and `/diff-file` are served by **`cli/fileEditor.ts`** (`undoLast`,
`getBackups`, `previewDiff`), not by the sandbox.

## 9. Autonomous mode (`src/task`, `src/core`, `src/api`, `src/actions`, `src/auth`)

BiMax can run as a long-lived autonomous service, not just an interactive chat:
- **`task/index.ts` — `TaskPipeline.process()`**: turns an incoming request into structured
  work via **`classifier.ts`** (TaskClassifier) → **`decomposer.ts`** (TaskDecomposer, DAG)
  → **`mapper.ts`** (TaskMapper). `types.ts` defines the Zod schemas.
- **`core/cognitive.loop.ts` — `CognitiveLoop`**: the always-on brain — `start()`,
  `processTask()`, `stop()`.
- **`core/orchestrator.ts` — `Orchestrator`** + **`coordinator.ts`/`worker.agent.ts`**:
  dispatch decomposed sub-tasks to workers concurrently and aggregate results.
- ~~`api/webhook.receiver.ts`~~ — unbooted since 2026-06-19 and moved to `~/Developer/bimax-archive`
  on 2026-09-29; the engine opens no inbound HTTP port.
- **`actions/action.router.ts` — `ActionRouter.route()`** with executors:
  **`executor.cron.ts`** (scheduled), **`executor.trigger.ts`** (event), **`executor.webhook.ts`**
  (HTTP), **`executor.graph.ts`** (graph-driven). Powers `/watch` (wake the agent on a file
  change or schedule).
- **`auth/cli.login.ts` — `AuthAutomator`**: automates CLI login flows for integrated tools.

## 10. Plugin system (`src/plugins`)

Install and integrate third-party capabilities **directly from GitHub**:
- **`index.ts` — `PluginManager.installFromGithub(url)`**: the entry point.
- **`github.api.ts` / `github.reader.ts` / `github.analyzer.ts`**: fetch and **analyze a
  repo's codebase** (capabilities, risk, license).
- **`plugin.evaluator.ts` — `PluginEvaluator.evaluate()`**: score a plugin by risk level,
  capabilities, and license before trusting it.
- **`plugin.sandbox.ts` / `plugin.integrator.ts` — `PluginIntegrator.integrate()`**: run and
  wire an approved plugin in a sandbox.
- **`registry.ts` — `PluginRegistry`** (`PluginManifest`): tracks installed plugins.
**Benefit:** extend BiMax with community tools, vetted for risk/license first.

## 11. Providers & credits (`src/cli/provider.ts`, `src/credits`)

- **`provider.ts`**: six built-in providers (NVIDIA, OpenAI, Anthropic, OpenRouter,
  DeepSeek, Google); `buildKeyPool()` reads comma-separated keys and per-key model overrides
  (`<ENV>_MODEL_<n>`). `/provider`, `/model`, `/keys`.
- **`credits/api.key.manager.ts` — `ApiKeyManager`**: **round-robin key pool** with
  per-key cooldowns and 429/403/401/timeout backoff; mutex-guarded; skips exhausted keys.
- **`credits/credits.free.ts` — `FreeCreditsTracker`** and **`session.tracker.ts` —
  `SessionTracker`**: track free credits and per-session usage; power `/cost`.

## 12. Persistence & state (`src/mind`, `src/state`)

- **`mind/event.ledger.ts` — `EventLedger`** (`getEventLedger()`): the durable event store,
  SQLite at `~/.bimax/ledger.db`. This is the only event store; a second, unused JSONL
  implementation under `src/storage/` was removed in the dead-code sweep.
- **`state/app.state.ts` / `store.ts`**: the UI's reactive store (`MessageEntry`,
  `LogEntry`, `ToolCallEntry`); bridges `cliEvents` → UI. Session save/resume (`/sessions`,
  `/resume`) and transcript replay (`/replay`) persist to `.breakglass/`.

## 13. Terminal & UI (`tui/`, `src/protocol`)

The interactive front-end is a **Go / Bubble Tea TUI** in `tui/` (the earlier React/Ink UI
was retired). The engine speaks to it out-of-process over an NDJSON stdio protocol
(`src/protocol/`), so the front-end can be swapped without touching engine logic.

- **`tui/model.go`**: the Bubble Tea model — inline mode (committed lines flushed to the
  terminal's native scrollback via `tea.Println`; only the live region re-renders), streaming
  area, resize/hardwrap guards, footer.
- **`tui/`** render units: `diff.go` (colorized diff cards), `tools.go` (fixed-slot tool
  cards), `markdown.go`, `panels.go`, `mindhud.go` (Ctrl+X second-mind HUD), `styles.go`
  (Graphite & Phosphor tokens), `search.go`, `welcome.go`.
- **`src/protocol/ui.snapshot.ts`**: engine-side footer/HUD state snapshotted for the
  out-of-process front-end to read.
- **Themes** (`cli/themes.ts` + `themes/*.json`): dark, light, ANSI, daltonized, bimax,
  dracula, catppuccin, gruvbox, nord. Switchable via `/config`.
- **`terminal/multiplexer.ts` — `TerminalMultiplexer`** + **`queue.ts` — `CommandQueue`**:
  manage multiple terminal sessions and a serialized command queue.

## 14. Telemetry & health (`src/telemetry`)

- **`metrics.ts` — `TelemetryEngine`**: metrics collection.
- **`memory.monitor.ts` — `MemoryMonitor`**: watches process memory and warns on pressure.
- **`watchdog.ts` — `Watchdog`**: liveness watchdog for long-running/autonomous runs.

## 15. Skills (`skills/*.json`, `src/cli/personas`)

Personas are agents with a role + allowed tools. Built-ins: **BiMax** (orchestrator),
**Hermes** (read/search/exec), **OpenCode** (deep coding), **OpenClaw** (OS execution).
JSON **skills** add specialized personas without code:
- **DreamSkill** — *memory distillation*: compress long logs/events into dense memory so
  long-term context isn't lost.
- **EvolutionSkill** — *autonomous self-evolution*: find weak components and rewrite them,
  strictly obeying the Architecture Guardian.
`RegisterAgentTool` registers any installed CLI as a new persona at runtime; `/routes` sends
matching prompts to the right specialist.

---

## 16. Full command reference

**Core/session:** `/help` `/clear` `/context` `/cost` `/config` `/sessions` `/resume` `/replay`
**Model/provider:** `/model` `/provider` `/keys`
**Files & VCS:** `/edit` `/write` `/diff` `/diff-file` `/undo` `/backups` `/git` `/log`
**Quality:** `/lint` (tsc) `/check` (eslint) `/self-critic`
**Code intelligence:** `/index` `/index-ai` `/ask` `/impact`
**Multi-agent:** `/swarm` `/speculate` `/council` `/evolve` `/heal`
**Time machine:** `/checkpoint` `/rewind`
**Memory:** `/remember`
**Agents/routing:** `/agents` `/skills` `/routes`
**Safety/modes:** `/governor` `/plan` `/diff-approval` `/agent-decisions`
**Automation:** `/watch`

## 17. Environment variables

| Var | Default | Purpose |
|---|---|---|
| `NVIDIA_API_KEY` (and other `*_API_KEY`) | — | Comma-separated key pool per provider |
| `<ENV>_MODEL_<n>` | provider default | Per-key model override |
| `BGW_PROVIDER` | `nvidia` | Active provider |
| `BGW_MODEL` | `meta/llama-3.1-70b-instruct` | Active model |
| `BGW_TIMEOUT` | `120000` | Request timeout (ms) |
| `BGW_STREAM_TIMEOUT_MS` | `60000` | Per-chunk stream stall guard |
| `BGW_WORKER_TIMEOUT_MS` | `600000` | Sub-agent worker watchdog |
| `BGW_TEMPERATURE` | `0.1` | Sampling temperature |
| `BGW_MAX_TOKENS` | `4096` | Max completion tokens |
| `BGW_REASONING_EFFORT` | unset | `low`/`medium`/`high` for thinking models |
| `MAX_DAILY_SPEND` | `5.00` | Hard daily budget cap (USD) |
| `WORKSPACE_ROOT` | cwd | Allowed edit scope |

Config also persists in `.breakglass/config.json`; per-project data lives under `.breakglass/`.
