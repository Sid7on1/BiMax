// The egress perimeter must go up before any module here opens a socket — see
// security/egress.perimeter.ts for why the guard lives beneath the code rather than beside it.
import { installEgressPerimeter } from '../security/egress.perimeter';
installEgressPerimeter();
import { workerData, parentPort } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';
import { EventBus } from '../core/event.bus';
import { buildKeyPool } from './provider';
import { SubAgentConfig, SUB_RESULT, SUB_ERROR, SUB_EVENT, SUB_READY, MAX_SUBAGENT_DEPTH } from '../core/subagent.manager';
import { loadConfig } from './config';
import { SkillLoader } from './skills.loader';
import { DynamicPersona } from './personas/dynamic.persona';
import { ToolRegistry } from '../tools/tool.registry';
import { LlmAdapter } from '../core/llm.adapter';
import { ApiKeyManager } from '../credits/api.key.manager';
import { Governor } from '../governor/governor';
import { HermesPersona, OpenCodePersona, OpenClawPersona, BiMaxPersona } from './personas/implementations';
import { AgentPersona } from './personas/base.persona';
import { createBashTool } from '../tools/implementations/bash.tool';
import { createReadFileTool, createWriteFileTool, createDeleteTool, createMakeDirTool } from '../tools/implementations/file.tool';
import { createEditFileTool } from '../tools/implementations/edit.tool';
import { createMultiEditTool } from '../tools/implementations/multiedit.tool';
import { createSymbolEditTool } from '../tools/implementations/symboledit.tool';
import { createRelatedTestsTool } from '../tools/implementations/relatedtests.tool';
import { createGrepTool, createGlobTool } from '../tools/implementations/search.tool';
import { createTodoWriteTool } from '../tools/implementations/todo.tool';
import { createWebFetchTool } from '../tools/implementations/webfetch.tool';
import { createCdTool } from '../tools/implementations/cd.tool';
import { createGraphQueryTool, createGraphContextTool } from '../tools/implementations/graph.tool';
import { createGitTool } from '../tools/implementations/git.tool';
import { createRememberTool } from '../tools/implementations/remember.tool';
import { createSkillTool } from '../tools/implementations/skill.tool';
import { createSkillInstallTool } from '../tools/implementations/skill.install.tool';
import { createToolSearchTool } from '../tools/implementations/toolsearch.tool';
import { createWebSearchTool } from '../tools/implementations/websearch.tool';
import { globalSkillService } from '../skills/skill.service';
import { loadHooksConfig } from '../tools/hooks.loader';
import { globalProjectMemory } from '../memory/project.memory';
// LspQueryTool is excluded: it initialises TreeSitter WASM on import, adding ~100 MB per worker
// thread and a cold-start penalty of 1-2s. Sub-agents use the shared graph store for code context.
// McpManageTool is excluded: MCP connections belong to the parent process; re-connecting in every
// worker thread would race against the parent's connections and create duplicate sessions.
import { GraphStore } from '../graph/graph.store';
import { engineEvents } from './events';
import { floorRoot } from '../sandbox/exec.sandbox';
import { SafetyPolicy } from '../governor/policy.engine';
import { OutcomeManager, __setOutcomeManager } from '../outcome/outcome.manager';
import { createOutcomeTool } from '../tools/implementations/outcome.tool';
import { createTasksTool } from '../tools/implementations/tasks.tool';
import {
  CAPACITY_LEASE_ENV,
  CAPACITY_PATH_ENV,
  CAPACITY_RUN_ENV,
  SubAgentCapacityCoordinator,
} from '../core/subagent.capacity';

// Core sub-agent run, transport-agnostic: build the isolated agent + tools and execute the task,
// relaying each tool event through `emitEvent`. Shared by BOTH the worker_thread path (runWorker,
// Node dev/dist) and the subprocess path (runAsSubprocess, the bun-compiled binary). Throws on
// failure so each caller reports it its own way.
async function runSubAgentCore(
  config: SubAgentConfig,
  emitEvent: (subtype: 'tool_call' | 'tool_call_result', call: any) => void,
  signalReady?: () => void,
): Promise<string> {
  // Sandbox floor (BiMax v2): this worker is an isolated autonomous episode. Bash enforcement
  // lives in bash.tool.ts (kernel sandbox via the thread-local FLOOR_ENV), but the Node-side
  // file tools must be confined too — narrow the governor's workspace boundary to the episode
  // root so Write/Edit/Delete outside the worktree are vetoed in-process.
  const episodeFloor = floorRoot();
  if (episodeFloor) SafetyPolicy.allowedWorkspace = episodeFloor;

  // Nesting: record this worker's depth in its own (thread/process-local) env so the spawn tool
  // inside this agent knows where in the tree it sits. Worker threads get a COPY of process.env,
  // so this never leaks to the parent or siblings.
  const depth = Math.max(1, Number(config.depth ?? 1));
  process.env.BIMAX_SUBAGENT_DEPTH = String(depth);
  let capacity: SubAgentCapacityCoordinator | null = null;
  let capacityHeartbeat: ReturnType<typeof setInterval> | null = null;
  if (config.capacityPath && config.capacityRunId) {
    process.env[CAPACITY_PATH_ENV] = config.capacityPath;
    process.env[CAPACITY_RUN_ENV] = config.capacityRunId;
    if (config.capacityLeaseId) process.env[CAPACITY_LEASE_ENV] = config.capacityLeaseId;
    capacity = new SubAgentCapacityCoordinator(config.capacityPath);
    if (config.capacityLeaseId) {
      capacity.heartbeat(config.capacityLeaseId, process.pid);
      capacityHeartbeat = setInterval(() => {
        try { capacity?.heartbeat(config.capacityLeaseId!, process.pid); } catch { /* parent TTL is fallback */ }
      }, 10_000);
      capacityHeartbeat.unref?.();
    }
  }

  try {
    const pool = buildKeyPool();
    const apiKeyManager = new ApiKeyManager(pool);
    const llmAdapter = new LlmAdapter(apiKeyManager);
    // Subagents must run on the SAME model/config the user chose — otherwise they silently fall back
    // to the adapter's hardcoded default. Load the persisted config and apply it.
    try {
      const cfg = await loadConfig();
      llmAdapter.applyConfig({
        model: cfg.model,
        // No explicit lite model → use the USER'S model for the lite lane too, not the adapter's
        // hardcoded default. Sub-agents otherwise made their first call (router/smalltalk lane) on
        // a reasoning model the user never chose — which NIM queues for minutes on free keys, the
        // core of "sub-agents are hell of slow". Matching slots also lets the router short-circuit
        // (no pre-flight classifier call at all).
        liteModel: cfg.liteModel || cfg.model,
        visionModel: cfg.visionModel,
        temperature: cfg.temperature, topP: cfg.topP,
        maxTokens: cfg.maxTokens, reasoningEffort: cfg.reasoningEffort, parallelToolCalls: cfg.parallelToolCalls,
      });
    } catch { /* fall back to adapter defaults if config can't be read in the worker */ }
    // Per-agent model override (spawn tool's `model` arg / config.subagentModel) wins over the
    // inherited config. Set as BOTH slots so the router's unified short-circuit applies — a
    // sub-agent on an explicit model never burns a pre-flight classifier call.
    if (config.model) llmAdapter.applyConfig({ model: config.model, liteModel: config.model });
    // Permission bridge: inherit parent's mode
    const eventBus = new EventBus();
    const governor = new Governor(eventBus);
    governor.mode = config.parentMode as any;

    const toolRegistry = new ToolRegistry();
    const workerSessionId = config.outcomeTaskId || `worker-${process.pid}-${Date.now()}`;
    const workerOutcome = new OutcomeManager({
      sessionId: () => workerSessionId,
      directory: () => path.join(os.tmpdir(), 'bimax-worker-outcomes'),
    });
    workerOutcome.syncSession();
    __setOutcomeManager(workerOutcome);
    const onReviewChange = () => workerOutcome.onMutation();
    const onReviewEvidence = (event: any) => workerOutcome.onBuildEvidence(event);
    engineEvents.on('review_change', onReviewChange);
    engineEvents.on('review_evidence', onReviewEvidence);
    // Must match the parent's graph backend (container.ts uses createGraphStore: SQLite when
    // available, legacy JSON otherwise), keyed off the sub-agent's project cwd — NOT
    // ~/.breakglass/graph.json, which left workers querying an empty/stale store.
    const { createGraphStore } = await import('../graph/sqlite.graph.store');
    const graphStore = createGraphStore(config.cwd || process.cwd());
    const { isCodebase } = await import('../graph/graph.summary');
    if (isCodebase(config.cwd || process.cwd())) {
      await graphStore.loadFromDisk();
    }
    
    // Register basic tools for the worker
    toolRegistry.register(createBashTool(governor));
    toolRegistry.register(createReadFileTool(governor));
    toolRegistry.register(createWriteFileTool(governor));
    toolRegistry.register(createEditFileTool(governor));
    toolRegistry.register(createMultiEditTool(governor));
    toolRegistry.register(createSymbolEditTool(governor));
    toolRegistry.register(createRelatedTestsTool(governor));
    toolRegistry.register(createDeleteTool(governor));
    toolRegistry.register(createMakeDirTool(governor));
    toolRegistry.register(createGrepTool(governor));
    toolRegistry.register(createGlobTool(governor));
    toolRegistry.register(createTodoWriteTool(governor));
    toolRegistry.register(createOutcomeTool(governor));
    toolRegistry.register(createTasksTool(governor));
    // Floored episodes are net: none — WebFetch/WebSearch run fetches from the worker thread
    // itself, where the kernel sandbox on Bash children can't reach, so simply don't arm them.
    if (!episodeFloor) toolRegistry.register(createWebFetchTool(governor));
    toolRegistry.register(createCdTool(governor));
    toolRegistry.register(createGraphQueryTool(governor, graphStore));
    toolRegistry.register(createGraphContextTool(governor, graphStore));
    toolRegistry.register(createGitTool(governor));
    // Shared project memory is a persistence channel out of the episode — floored workers'
    // lessons re-enter only via the dream grader, never directly.
    if (!episodeFloor) toolRegistry.register(createRememberTool(governor, globalProjectMemory));
    // Same hybrid store as the parent process (see container.ts): without this the worker persona's
    // auto-recall and remember tool run BM25-only on a second store racing the parent's writes over
    // the same vectors.json. Floored episodes get no store at all — retrieval is a read of shared
    // state, and floored lessons must re-enter only through the grader.
    if (!episodeFloor && apiKeyManager) {
      const { RemoteEmbeddingBackend } = await import('../memory/embeddings');
      const { RemoteReranker } = await import('../memory/rerank');
      const { resolveMemorySettings, rerankURLFor } = await import('../memory/settings');
      const { VectorStore } = await import('../memory/vector.store');
      const memorySettings = resolveMemorySettings();
      const resolveKey = async () => {
        const key = await apiKeyManager.getNextKey();
        if (!key.keyStr) return null;
        return { apiKey: key.keyStr, baseURL: key.baseURL || 'https://integrate.api.nvidia.com/v1', rerankURL: rerankURLFor(key.baseURL || 'https://integrate.api.nvidia.com/v1') };
      };
      globalProjectMemory.useStore(new VectorStore(
        new RemoteEmbeddingBackend({ resolve: resolveKey, model: memorySettings.embeddingModel, dimensions: memorySettings.embeddingDimensions }),
        new RemoteReranker({ resolve: resolveKey, model: memorySettings.rerankModel }),
      ));
    }
    globalSkillService.load(config.cwd || process.cwd());
    toolRegistry.register(createSkillTool(governor, globalSkillService));
    // Skill installs fetch from the network AND persist outside the episode — both off-limits
    // under the floor (persistence must go through the objective grader, not side effects).
    if (!episodeFloor) toolRegistry.register(createSkillInstallTool(governor, globalSkillService));
    loadHooksConfig(config.cwd || process.cwd());
    toolRegistry.register(createToolSearchTool(governor, toolRegistry));
    if (!episodeFloor) toolRegistry.register(createWebSearchTool(governor));

    // Nested sub-agents (3-level agent trees, the Claude Code June-2026 pattern): a worker that
    // still has depth budget can spawn its own children for layered task decomposition. The spawn
    // tool re-checks BIMAX_SUBAGENT_DEPTH itself, so the registration gate here is belt-and-braces.
    // Floored episodes don't get it — their children would inherit the floor but multiply the
    // blast radius of an autonomous episode.
    if (depth + 1 < MAX_SUBAGENT_DEPTH && !episodeFloor) {
      const { createSpawnSubagentTool } = await import('../tools/implementations/spawn.tool');
      toolRegistry.register(createSpawnSubagentTool(governor, toolRegistry, llmAdapter));
    }

    // 2. Instantiate Persona
    let agent: AgentPersona;
    if (config.agentType === 'Hermes') agent = new HermesPersona(toolRegistry, llmAdapter);
    else if (config.agentType === 'OpenCode') agent = new OpenCodePersona(toolRegistry, llmAdapter);
    else if (config.agentType === 'OpenClaw') agent = new OpenClawPersona(toolRegistry, llmAdapter);
    else if (config.agentType === 'BiMax') agent = new BiMaxPersona(toolRegistry, llmAdapter);
    else {
      // Must load skills again in this thread
      SkillLoader.loadSkills();
      const skillConfig = SkillLoader.getSkill(config.agentType);
      if (skillConfig) {
        agent = new DynamicPersona(skillConfig, toolRegistry, llmAdapter);
      } else {
        // Unknown/blank type → spawn BiMax itself rather than failing the whole sub-agent.
        agent = new BiMaxPersona(toolRegistry, llmAdapter);
      }
    }

    // Isolate CWD
    agent.cwd = config.cwd;

    // Forward this sub-agent's tool activity to the parent so the UI can nest it under the spawn
    // (T3). engineEvents here is the process/thread-local singleton the agent loop emits on; the
    // transport-specific emitEvent relays it (postMessage for a thread, a stdout sentinel for a
    // subprocess). The parent (SubAgentManager) tags it with parentId/agentLabel.
    const onCall = (call: any) => emitEvent('tool_call', call);
    const onResult = (call: any) => emitEvent('tool_call_result', call);
    engineEvents.on('tool_call', onCall);
    engineEvents.on('tool_call_result', onResult);

    // Boot done — everything above (key pool, config, graph store, ~18 tools, persona/system-prompt)
    // is the fixable per-spawn overhead WS2 measures. Signal it NOW, before the first llm call, so
    // the parent can split boot time from the model's time-to-first-action.
    signalReady?.();

    // 3. Execute
    try {
      return await agent.execute(config.prompt, () => { /* streaming ignored in sub-agents */ });
    } finally {
      engineEvents.off('tool_call', onCall);
      engineEvents.off('tool_call_result', onResult);
      engineEvents.off('review_change', onReviewChange);
      engineEvents.off('review_evidence', onReviewEvidence);
      workerOutcome.shutdown();
      __setOutcomeManager(null);
    }
  } finally {
    if (capacityHeartbeat) clearInterval(capacityHeartbeat);
    if (capacity && config.capacityLeaseId) {
      try { capacity.release(config.capacityLeaseId); } catch { /* TTL reclaims it */ }
    }
  }
}

// Worker-thread transport (Node dev/dist): config in workerData, results/events via postMessage.
async function runWorker(): Promise<void> {
  if (!parentPort) return;
  const config = workerData as SubAgentConfig;
  try {
    const result = await runSubAgentCore(
      config,
      (subtype, call) => parentPort!.postMessage({ type: 'tool_event', subtype, call }),
      () => parentPort!.postMessage({ type: 'ready' }),
    );
    parentPort.postMessage({ type: 'success', result });
  } catch (err: any) {
    parentPort.postMessage({ type: 'error', error: err?.message || String(err) });
  }
}

// Subprocess transport (the bun-compiled single binary re-execing itself): config arrives via env,
// results/events go out as stdout sentinel lines the parent parses back into worker-style messages.
// index.ts calls this when it detects BIMAX_SUBAGENT_CONFIG, instead of booting the engine.
export async function runAsSubprocess(): Promise<void> {
  const write = (s: string) => { try { process.stdout.write(s + '\n'); } catch { /* best-effort */ } };
  let config: SubAgentConfig;
  try { config = JSON.parse(process.env.BIMAX_SUBAGENT_CONFIG || '{}') as SubAgentConfig; }
  catch { write(SUB_ERROR + JSON.stringify({ error: 'invalid BIMAX_SUBAGENT_CONFIG' })); process.exit(1); return; }
  try {
    const result = await runSubAgentCore(
      config,
      (subtype, call) => write(SUB_EVENT + JSON.stringify({ subtype, call })),
      () => write(SUB_READY),
    );
    write(SUB_RESULT + JSON.stringify({ result }));
    process.exit(0);
  } catch (err: any) {
    write(SUB_ERROR + JSON.stringify({ error: err?.message || String(err) }));
    process.exit(1);
  }
}

if (parentPort) runWorker();
