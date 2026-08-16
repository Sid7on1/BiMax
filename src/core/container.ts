/**
 * Dependency Injection container for Bimax.
 * Creates and wires the core dependency graph for the TUI — tools, graph, LLM, governor.
 *
 * Ghost services removed (2026-06-19):
 *   - Express.js WebhookReceiver (booted port 8080 on every CLI start, never used by TUI)
 *   - CognitiveLoop / Orchestrator (event-driven daemon loop, bypassed by AgentLoop)
 *   - Bootloader (only wired the above two + SQLite that TUI never reads)
 *   - ActionRouter / WorkerAgent / Coordinator (only fed the CognitiveLoop)
 *   - ContextEngine / ShortTermMemory / LongTermMemory (only needed by above workers)
 */

import { EventBus } from './event.bus';
import { Logger } from '../utils/logger';
import { cliEvents } from '../cli/events';
import { GraphStore } from '../graph/graph.store';
import { CodebaseIndexer } from '../graph/indexer';
import { StaticAnalyzer } from '../graph/static.analyzer';
import { SemanticAugmenter } from '../graph/semantic.augmenter';
import { TaskPipeline } from '../task';
import * as path from 'path';

import { YoloClassifier } from '../security/yolo.classifier';
import { ApiKeyManager } from '../credits/api.key.manager';
import { LlmAdapter } from '../core/llm.adapter';

import { ToolRegistry } from '../tools/tool.registry';
import { createBashTool } from '../tools/implementations/bash.tool';
import { createCdTool } from '../tools/implementations/cd.tool';
import { createReadFileTool, createWriteFileTool, createDeleteTool, createMakeDirTool } from '../tools/implementations/file.tool';
import { createEditFileTool } from '../tools/implementations/edit.tool';
import { createMultiEditTool } from '../tools/implementations/multiedit.tool';
import { createSymbolEditTool } from '../tools/implementations/symboledit.tool';
import { createRelatedTestsTool } from '../tools/implementations/relatedtests.tool';
import { createGrepTool, createGlobTool } from '../tools/implementations/search.tool';
import { createTodoWriteTool } from '../tools/implementations/todo.tool';
import { createWebFetchTool } from '../tools/implementations/webfetch.tool';
import { createGraphQueryTool, createGraphContextTool } from '../tools/implementations/graph.tool';
import { globalCodemem } from '../graph/codemem/backend';
import { globalMcpManager } from '../mcp/manager';
import { createMcpManageTool } from '../tools/implementations/mcp.tool';
import { createToolSearchTool } from '../tools/implementations/toolsearch.tool';
import { createWebSearchTool } from '../tools/implementations/websearch.tool';
import { createBrowserTool } from '../tools/implementations/browser.tool';
import { globalBrowserRuntime } from '../browser/browser.runtime';
import { shutdownTracer } from '../telemetry/trace';
import { createSkillTool } from '../tools/implementations/skill.tool';
import { createSkillInstallTool } from '../tools/implementations/skill.install.tool';
import { createSkillAuthorTool } from '../tools/implementations/skill.author.tool';
import { createModelManageTool } from '../tools/implementations/model.tool';
import { globalSkillService } from '../skills/skill.service';
import { loadHooksConfig } from '../tools/hooks.loader';
import { createMemoryQueryTool } from '../tools/implementations/memory.tool';
import { createRememberTool } from '../tools/implementations/remember.tool';
import { globalProjectMemory } from '../memory/project.memory';
import { VectorStore } from '../memory';
import { RemoteEmbeddingBackend } from '../memory/embeddings';
import { createSpawnSubagentTool } from '../tools/implementations/spawn.tool';
import { createTasksTool } from '../tools/implementations/tasks.tool';
import { createNotebookEditTool } from '../tools/implementations/notebook.tool';
import { createRegisterAgentTool } from '../tools/implementations/register.tool';
import { createAskUserTool } from '../tools/implementations/ask_user.tool';
import { createBlueprintTool } from '../tools/implementations/blueprint.tool';
import { createTrainMonitorTool } from '../tools/implementations/train_monitor.tool';
import { createTrainLaunchTool } from '../tools/implementations/train_launch.tool';
import { createModeTool } from '../tools/implementations/mode.tool';
import { createGitTool } from '../tools/implementations/git.tool';
import { createLspQueryTool } from '../tools/implementations/lsp.tool';
import { createFreeContextTool } from '../tools/implementations/free-context.tool';
import { createGoalsTool } from '../tools/implementations/goals.tool';
import { createWorkspaceTool } from '../tools/implementations/workspace.tool';
import { initGoalManager } from '../memory/goal.manager';
import { initWorkspace } from './workspace.manager';
import { initPlanManager } from '../memory/plan.manager';
import { createPlanTool } from '../tools/implementations/plan.tool';
import { createScoutTool } from '../tools/implementations/scout.tool';
import { createOutcomeTool } from '../tools/implementations/outcome.tool';

import { Governor } from '../governor/governor';
import { CliConfig } from '../cli/config';
import { buildKeyPool } from '../cli/provider';

let browserShutdownWired = false;

export async function createContainer(config?: Partial<CliConfig>): Promise<{
  governor: Governor;
  toolRegistry: ToolRegistry;
  graphStore: GraphStore;
  llmAdapter: LlmAdapter;
  codebaseIndexer: CodebaseIndexer;
  taskPipeline: TaskPipeline;
}> {
  const cfg = config || {};

  // Goal Manager — persistent cross-session goals. Init first so system prompt can include them.
  const goalManager = initGoalManager(process.cwd());
  await goalManager.init();

  // Plan Manager — VCS-backed structured plans in .bimax/plans/.
  initPlanManager(process.cwd());

  // Multi-repo workspace — manifest refresh + sibling-clone scan on session start (PR1,
  // docs/UPGRADE_2026_RESEARCH.md). Best-effort: a broken manifest must not block boot.
  try { initWorkspace(process.cwd()); } catch (e: any) { Logger.warn(`[Workspace] init failed: ${e?.message ?? e}`); }

  // Core Events
  const eventBus = new EventBus();
  Logger.setEventBus(eventBus);

  // API Manager & LLM
  const apiKeyManager = new ApiKeyManager(buildKeyPool());
  const llmAdapter = new LlmAdapter(apiKeyManager);
  llmAdapter.applyConfig({
    model: cfg.model,
    timeout: cfg.timeout,
    temperature: cfg.temperature,
    topP: cfg.topP,
    maxTokens: cfg.maxTokens,
    reasoningEffort: cfg.reasoningEffort,
    parallelToolCalls: cfg.parallelToolCalls,
    liteModel: cfg.liteModel,
    visionModel: cfg.visionModel,
  });

  // Governor — YoloClassifier only fires in 'auto' mode (never in default interactive mode).
  const yolo = new YoloClassifier(llmAdapter);
  const governor = new Governor(eventBus, yolo);
  llmAdapter.setBudgetVeto(governor.budget);

  // Phase 3a — start background power-awareness (battery/thermal → advisory sub-agent backoff).
  // Never in tests; the unref'd poll timer never holds the process open.
  {
    const { powerMonitor, powerAwarenessEnabled } = await import('../governor/power.monitor');
    if (process.env.NODE_ENV !== 'test' && powerAwarenessEnabled()) powerMonitor.start();
  }

  // NOTE: the Grok-ported startup update check was removed. Normal startup performs NO network
  // call and NO repository-local write; the on-demand `/update` command is the only path that
  // fetches the update manifest, and its cache lives in the user cache directory.

  // Graph Engine — operates on the directory the CLI was launched from.
  const projectRoot = process.cwd();
  // SQLite-backed when node:sqlite exists (atomic saves, per-file staleness → incremental
  // reindex); legacy JSON store otherwise. Same IGraphStore either way (v2 §3.9).
  const { createGraphStore } = await import('../graph/sqlite.graph.store');
  const { reportBootPhase } = await import('../protocol/boot.status');
  reportBootPhase('loading_graph');
  const graphStore = createGraphStore(projectRoot);
  const { isCodebase } = await import('../graph/graph.summary');
  if (isCodebase(projectRoot)) {
    const loadGraph = graphStore.loadFromDisk().then(() => {
      // A deferred provider load becomes visible as soon as it settles. The initial snapshot either
      // sees the populated graph or this event schedules the next one; no polling is required.
      cliEvents.emit('graph_changed');
    }).catch((err: any) => {
      Logger.warn(`[Graph] persisted graph load failed; continuing with an empty graph: ${err?.message || err}`);
    });
    // Desktop must become interactive before an iCloud-hosted SQLite graph finishes paging in.
    // CLI/TUI retain the historical eager behavior unless their launcher opts in explicitly.
    if (process.env.BIMAX_DEFER_GRAPH_LOAD === '1') void loadGraph;
    else await loadGraph;
  }

  // Tools
  reportBootPhase('loading_tools');
  const toolRegistry = new ToolRegistry();
  // Index-gated tools (GraphQueryTool/GraphContextTool) stay disabled until the repo is indexed, then
  // are promoted + preferred. The check is lazy so it reflects a graph built mid-session (after /index)
  // OR the baked-in codebase-memory engine coming online (its own 158-language index + semantic search).
  toolRegistry.setGraphReadyCheck(() => graphStore.getGraph().nodes.size > 0 || globalCodemem.isReady());
  // Bring the codebase-memory engine up in the background — it fronts the graph tools when ready and
  // never blocks boot. Skipped for non-codebase dirs (nothing to index), and skippable by a
  // supervising front-end on memory-constrained machines (BIMAX_DISABLE_CODEMEM=1); the SQLite
  // graph tools keep working without it.
  if (isCodebase(projectRoot) && process.env.BIMAX_DISABLE_CODEMEM !== '1') {
    globalCodemem.init(projectRoot).catch(() => {});
  }
  // NOTE: the Headroom Kompress proxy is NO LONGER started here. Provisioning a Python venv + spawning
  // a localhost sidecar at boot meant a trivial "hi" paid for ML-compression startup it never used
  // (and two engines raced for :8788). It is now brought up LAZILY on the first turn that is actually
  // under token pressure — see context.manager.ts (guarded by a cross-process singleton lock). Opt out
  // entirely with BIMAX_DISABLE_HEADROOM=1 / BIMAX_DISABLE_COMPRESSION=1.
  toolRegistry.register(createReadFileTool(governor));
  toolRegistry.register(createWriteFileTool(governor));
  toolRegistry.register(createEditFileTool(governor));
  toolRegistry.register(createMultiEditTool(governor));
  // Surgical precision pair: AST-addressed edits + minimal-scope test verification.
  toolRegistry.register(createSymbolEditTool(governor));
  toolRegistry.register(createRelatedTestsTool(governor));
  toolRegistry.register(createDeleteTool(governor));
  toolRegistry.register(createMakeDirTool(governor));
  toolRegistry.register(createBashTool(governor));
  toolRegistry.register(createGrepTool(governor));
  toolRegistry.register(createGlobTool(governor));
  toolRegistry.register(createTodoWriteTool(governor));
  // Engine-owned acceptance/evidence contract. Core infrastructure: substantial tasks use this
  // before implementation and the runtime—not model prose—decides whether verified completion is legal.
  toolRegistry.register(createOutcomeTool(governor));
  toolRegistry.register(createWebFetchTool(governor));
  toolRegistry.register(createCdTool(governor));
  toolRegistry.register(createGraphQueryTool(governor, graphStore));
  toolRegistry.register(createGraphContextTool(governor, graphStore));
  /**
   * Memory retrieval is hybrid: BM25 for exact tokens, dense embeddings for paraphrase, fused by
   * rank. The embedding backend rides the SAME provider and key pool as every chat call, so this
   * costs no new dependency and no new configuration — and when there is no key it returns null,
   * the store falls back to BM25 alone, and `lastSearchMode()` says which happened. It is never
   * given hashed pseudo-vectors to rank on.
   */
  const embeddings = new RemoteEmbeddingBackend({
    resolve: async () => {
      const key = await apiKeyManager.getNextKey();
      if (!key.keyStr) return null;
      return { apiKey: key.keyStr, baseURL: key.baseURL || 'https://integrate.api.nvidia.com/v1' };
    },
  });
  const vectorStore = new VectorStore(embeddings);
  toolRegistry.register(createMemoryQueryTool(governor, vectorStore));
  toolRegistry.register(createRememberTool(governor, globalProjectMemory));
  toolRegistry.register(createSpawnSubagentTool(governor, toolRegistry, llmAdapter));
  toolRegistry.register(createTasksTool(governor));
  toolRegistry.register(createNotebookEditTool(governor));
  toolRegistry.register(createRegisterAgentTool(governor, toolRegistry));
  toolRegistry.register(createAskUserTool(governor, llmAdapter));
  toolRegistry.register(createGitTool(governor));
  toolRegistry.register(createLspQueryTool(governor, graphStore));
  toolRegistry.register(createFreeContextTool(governor));
  toolRegistry.register(createGoalsTool(governor));
  toolRegistry.register(createWorkspaceTool(governor));
  toolRegistry.register(createPlanTool(governor));
  toolRegistry.register(createScoutTool(governor));
  // Sketch Mode: the level-by-level Blueprint builder + LLM-training monitoring.
  toolRegistry.register(createBlueprintTool(governor, toolRegistry));
  toolRegistry.register(createTrainMonitorTool(governor));
  toolRegistry.register(createTrainLaunchTool(governor));
  // Agent switches its OWN mode (the same modes the user cycles with Shift+Tab) → self-driving loop.
  toolRegistry.register(createModeTool(governor));
  // Agent Skills: model-invoked capability packs (progressive disclosure via the system prompt).
  // Discovery may touch cloud-backed home/project files. It is optional and must never hold the
  // protocol handshake: register the tools immediately, then populate the shared service after the
  // headless host has had a chance to emit `ready` (Promise continuations run before this timer).
  // In a compiled Bun desktop engine, an npx-based MCP transport can occasionally do blocking
  // compatibility work while it starts. Give the protocol host + first heartbeat a head start so
  // optional integration boot can never masquerade as an engine that never became interactive.
  const backgroundDelayMs = Number(process.env.BIMAX_MCP_BOOT_DELAY_MS ?? (process.env.BIMAX_HEADLESS === '1' ? 30_000 : 0));
  setTimeout(() => {
    try {
      globalSkillService.load(projectRoot);
      cliEvents.emit('skills_changed');
    } catch (e: any) {
      Logger.warn(`[Skills] background discovery failed: ${e?.message ?? e}`);
    }
  }, Math.max(0, backgroundDelayMs)).unref?.();
  toolRegistry.register(createSkillTool(governor, globalSkillService));
  toolRegistry.register(createSkillInstallTool(governor, globalSkillService));
  toolRegistry.register(createSkillAuthorTool(governor, globalSkillService));
  // Shell-command hooks: PreToolUse can block a tool, PostToolUse runs for side effects.
  loadHooksConfig(projectRoot);
  // Agent-driven MCP setup: gated by the Governor (the tool is destructive → user confirms).
  toolRegistry.register(createMcpManageTool(governor, toolRegistry, globalMcpManager));
  // Agent self-service over its own model API: list/switch coding & lite models and provider live.
  toolRegistry.register(createModelManageTool(governor, llmAdapter));
  // Smart context mode: loader for deferred tool schemas (kept off the wire until needed).
  toolRegistry.register(createToolSearchTool(governor, toolRegistry));
  toolRegistry.register(createWebSearchTool(governor));
  toolRegistry.register(createBrowserTool(governor));
  if (!browserShutdownWired) {
    browserShutdownWired = true;
    cliEvents.once('shutdown', () => {
      void globalBrowserRuntime.close();
      void shutdownTracer();
    });
  }

  // External MCP servers — best-effort, never blocks boot. Once the initial (parallel) connect
  // settles, the watchdog takes over: a 60s background sweep that probes each live connector and
  // auto-reconnects dead ones (bounded attempts; BIMAX_MCP_WATCHDOG=0 disables).
  // Defer the CALL itself, not only its returned promise. Some packaged runtimes do substantial
  // synchronous transport discovery before connectAll reaches its first await; invoking it here
  // can therefore hold the container open and prevent the headless host from ever emitting ready.
  // The next event-loop turn runs after createContainer resolves and the protocol host is attached.
  setTimeout(() => {
    globalMcpManager
      .connectAll(toolRegistry, governor, projectRoot)
      .then(() => globalMcpManager.startWatchdog(toolRegistry, governor))
      .catch(e => Logger.warn(`[MCP] background connect failed: ${e?.message || e}`));
    // Keep optional dynamic module evaluation behind the same ready-path boundary. Bun's compiled
    // runtime may evaluate an import synchronously even when its promise is not awaited.
    import('../telemetry/metrics.export').then(m => m.startMetricsExporter()).catch(() => {});

    // Crash recovery: if a previous session died mid-swarm, its agent-tree checkpoint names the
    // sub-agents that were still running. Surface them; '/subagents resume' respawns the tree.
    import('./agent.checkpoint').then(m => {
      const n = m.detectCrashedTree();
      if (n > 0) {
        cliEvents.emit('status', `${n} interrupted assignment(s) found — checking safe recovery…`);
        cliEvents.emit('agent_recovery_available', { count: n });
      }
    }).catch(() => {});
  }, Math.max(0, backgroundDelayMs));
  reportBootPhase('loading_tools', 'background services scheduled');

  const semanticAugmenter = new SemanticAugmenter(graphStore, llmAdapter, projectRoot);
  reportBootPhase('loading_tools', 'semantic layer wired');
  if (cfg.skipSemanticMetadata) semanticAugmenter.enabled = false;

  const staticAnalyzer = new StaticAnalyzer(projectRoot, graphStore, cfg.excludeFromIndex);
  reportBootPhase('loading_tools', 'analyzers wired');
  const codebaseIndexer = new CodebaseIndexer(projectRoot, graphStore, staticAnalyzer, semanticAugmenter);
  if (cfg.autoIndex === false) codebaseIndexer.enabled = false;

  // Task Pipeline — used by /watch watchers.
  const taskPipeline = new TaskPipeline(eventBus, llmAdapter);
  reportBootPhase('loading_tools', 'container ready');

  return { governor, toolRegistry, graphStore, llmAdapter, codebaseIndexer, taskPipeline };
}
