import { ToolDef, buildTool, BuiltTool } from '../tool.factory';
import { IGovernor } from '../../core/interfaces';
import { ToolRegistry } from '../tool.registry';
import { LlmAdapter } from '../../core/llm.adapter';
import { SkillLoader } from '../../cli/skills.loader';
import { Logger } from '../../utils/logger';
import { SubAgentManager, globalSubAgentManager, MAX_SUBAGENT_DEPTH } from '../../core/subagent.manager';
import { globalSubAgentBlackboard } from '../../core/subagent.blackboard';
import { cliEvents } from '../../cli/events';
import { randomUUID } from 'crypto';
import { getOutcomeManager, OutcomeManager } from '../../outcome/outcome.manager';
import {
  CAPACITY_LEASE_ENV,
  CAPACITY_PATH_ENV,
  CAPACITY_RUN_ENV,
  resolveCapacityContext,
  runtimeConcurrentSubagentLimit,
  SubAgentCapacityCoordinator,
} from '../../core/subagent.capacity';
import { formatSubAgentResult } from '../../core/subagent.result';
import { powerThrottleAdvice } from '../../governor/power.monitor';

export function createSpawnSubagentTool(governor: IGovernor, registry: ToolRegistry, llmAdapter: LlmAdapter): BuiltTool {
  return buildTool({
    name: 'SpawnSubagentTool',
    description: `Spawns an asynchronous, parallel sub-agent (own worker, own context window) to handle a delegated task.

Use it when work can genuinely run in parallel (independent sub-tasks across disjoint files) or when a big exploration would flood your own context. Do NOT use it for small sequential steps — doing those yourself is faster than a spawn round-trip.

# How to spawn well
- **Self-contained prompt:** The sub-agent boots with a BLANK memory — no conversation history, no idea what the user said. Its prompt must carry everything: the goal, relevant file paths, constraints, what "done" looks like, and what to report back.
- **Disjoint scopes:** Give each parallel sibling a \`scope\` that doesn't overlap the others. Coordinated writable overlaps are blocked unless isolated in worktrees; two agents on the same files waste time and require merge validation.
- **Outcome assignment:** When an outcome task graph is active, pass \`outcome_task_id\`. The engine checks dependencies, critical-path capacity, and edit-scope safety, then owns the task↔agent link.
- **Worktree when editing in parallel:** Set \`isolation: "worktree"\` whenever the sub-agent will EDIT files while siblings run — each gets its own git worktree + branch, so they can never clobber each other. Read-only agents don't need it.
- **Model:** By default the sub-agent inherits your model. Pass \`model\` to run it on a different one (e.g. a cheaper/faster model for bulk mechanical work, a heavier one for a gnarly refactor).
- **Asynchronous:** You get \`TASK_QUEUED\` immediately. The result is posted into the conversation as a system message when the agent finishes — it is NOT injected mid-turn. Finish your current turn; the result will be waiting. Don't spin-wait or re-spawn the same task.`,
    isDestructive: false,
    schema: {
      type: 'object',
      properties: {
        agentType: {
          type: 'string',
          enum: ['BiMax', 'Hermes', 'OpenCode', 'OpenClaw', ...Object.keys(SkillLoader.getAllSkills())],
          description: 'The sub-agent persona. Default and standard is "BiMax" — a full copy of yourself with the same tools and reasoning; omit this to spawn BiMax. The others are legacy specialized personas — only use one if the task specifically calls for it.'
        },
        prompt: {
          type: 'string',
          description: 'The highly detailed prompt/task for the sub-agent.'
        },
        scope: {
          type: 'string',
          description: 'What this sub-agent OWNS — the files, directories, or topic it covers (e.g. "src/graph, src/mind" or "the auth flow"). Give each parallel sub-agent a DISJOINT scope so two agents never read/redo the same thing. Overlaps are flagged back to you.'
        },
        isolation: {
          type: 'string',
          enum: ['worktree'],
          description: 'Set to "worktree" to run the sub-agent in its own git worktree + branch (under .bimax/worktrees/). Use this whenever the sub-agent will EDIT files and siblings run in parallel — isolated agents can never clobber each other. The worktree is auto-removed if the agent changes nothing; otherwise its path and branch are reported for review/merge.'
        },
        model: {
          type: 'string',
          description: 'Model id this sub-agent runs on (e.g. "mistralai/mistral-small-4-119b-2603"). Omit to inherit the main model (or the configured subagentModel). Use a fast model for bulk mechanical tasks, a heavier one for hard reasoning.'
        },
        outcome_task_id: {
          type: 'string',
          description: 'The exact ready task id from OutcomeTool(action:"schedule"). Required for coordinated outcome work.'
        },
      },
      required: ['prompt']
    },
    execute: async (args: { agentType?: string, prompt: string, scope?: string, isolation?: 'worktree', model?: string, outcome_task_id?: string }, context?: any) => {
      // Default to a BiMax sub-agent (a copy of ourselves) — never a stray legacy persona.
      const agentType = args.agentType || 'BiMax';
      const runtimeLimit = runtimeConcurrentSubagentLimit();
      // Engine-owned cap: models cannot request an arbitrary fan-out.
      let scope = args.scope || '';
      let isolation = args.isolation;
      let outcomeManager: OutcomeManager | null = null;
      let outcomeTask = null;
      if (args.outcome_task_id) {
        try {
          outcomeManager = getOutcomeManager();
          outcomeTask = outcomeManager.task(args.outcome_task_id);
          if (!outcomeTask) return `Error: unknown outcome task ${args.outcome_task_id}. Run OutcomeTool(action:"schedule") for current task ids.`;
          scope = scope || outcomeTask.scope || '';
          // Every coordinated mutation is isolated, even when serial. Without an authoritative
          // worktree manifest the parent cannot prove what the worker changed or whether it was
          // actually integrated before accepting verification.
          isolation = outcomeTask.mutates ? 'worktree' : (isolation || outcomeTask.isolation);
          if (outcomeTask.mutates && !scope && isolation !== 'worktree') {
            return `Error: writable outcome task ${outcomeTask.id} needs a concrete scope or worktree isolation before parallel dispatch.`;
          }
          const schedule = outcomeManager.schedule(runtimeLimit);
          if (outcomeTask.mutates && (schedule?.parallelTasks || 0) > 1 && isolation !== 'worktree') {
            return `Error: ${outcomeTask.id} is part of a ${schedule?.parallelTasks}-way writable dispatch. Parallel edits require worktree isolation.`;
          }
        } catch (error: any) {
          return `Error: cannot bind outcome task: ${error?.message || String(error)}`;
        }
      }
      // Model resolution: per-spawn arg > config.subagentModel > inherit (worker loads config.model).
      let model = (args.model || '').trim();
      if (!model) {
        try { model = ((await (await import('../../cli/config')).loadConfig()).subagentModel || '').trim(); }
        catch { /* config optional — inherit */ }
      }
      // Coordination: warn (don't block) if this scope collides with an already-running sibling, so
      // the orchestrator can re-partition instead of two agents grinding the same files.
      const collisions = globalSubAgentBlackboard.overlapping(scope);
      const unsafeCollision = collisions.length > 0 && outcomeTask?.mutates && isolation !== 'worktree';
      if (unsafeCollision) {
        return `Error: writable scope overlaps running sibling(s): ${collisions.map(c => `${c.agentType}[${c.scope}]`).join(', ')}. Repartition the task or use worktree isolation.`;
      }
      // Hard cap — NOT model-controllable. Keeping this as a constant (not an arg) prevents
      // the model from passing maxSubAgents:100 and spawning 100 worker threads.
      if (globalSubAgentManager.activeCount() >= runtimeLimit) {
        return `Error: Concurrent sub-agent limit reached (${runtimeLimit}). Wait for running sub-agents to finish before spawning more.`;
      }

      // Phase 3a power-aware soft backoff: on battery / thermal throttle, serialize fan-out under a
      // reduced effective ceiling (never below 1). This is advisory — it caps *parallel* spawns so a
      // long unattended run doesn't drain the battery or cook the CPU; sequential work still proceeds
      // once a running sub-agent finishes. Reads cached power state (no I/O on this path).
      const powerAdvice = powerThrottleAdvice();
      if (powerAdvice.level !== 'none'
        && globalSubAgentManager.activeCount() >= powerAdvice.maxConcurrentSubagents) {
        return `Deferred (power-aware backoff): ${powerAdvice.reason}. Holding parallel sub-agents at ${powerAdvice.maxConcurrentSubagents} while unplugged/throttled — let a running sub-agent finish, or do this work sequentially yourself. Override with BIMAX_POWER_AWARE=off.`;
      }

      const currentCwd = context?.cwd || process.cwd();
      const parentMode = (governor as any).mode; // Pass the permission bridge
      const capacityContext = resolveCapacityContext(currentCwd);
      process.env[CAPACITY_PATH_ENV] = capacityContext.path;
      process.env[CAPACITY_RUN_ENV] = capacityContext.runId;
      try {
        const globalActive = new SubAgentCapacityCoordinator(capacityContext.path).active().length;
        if (globalActive >= runtimeLimit) {
          return `Error: Global sub-agent limit reached (${runtimeLimit}) across the nested agent tree. Wait for a running assignment to finish.`;
        }
      } catch (error: any) {
        return `Error: ${error?.message || String(error)}`;
      }

      // Nesting: this process's own depth is 0 in the main session; inside a worker it was set
      // (thread-local env) by worker.entry.ts. The child is one level deeper, hard-capped so a
      // runaway model can't fork-bomb an unbounded tree.
      const myDepth = Number(process.env.BIMAX_SUBAGENT_DEPTH || '0');
      if (myDepth + 1 >= MAX_SUBAGENT_DEPTH) {
        return `Error: Maximum agent-tree depth (${MAX_SUBAGENT_DEPTH} levels) reached — this agent cannot spawn deeper. Do the work directly.`;
      }

      const taskId = `subagent-${randomUUID()}`;
      const outcomeSessionId = outcomeManager?.activeSessionId() || '';

      if (outcomeManager && outcomeTask) {
        try { outcomeManager.assignTask(outcomeTask.id, taskId, runtimeLimit); }
        catch (error: any) { return `Error: scheduler rejected ${outcomeTask.id}: ${error?.message || String(error)}`; }
      }

      const assignmentPrompt = outcomeTask
        ? `${args.prompt}\n\nENGINE ASSIGNMENT\n- Outcome task: ${outcomeTask.id} — ${outcomeTask.title}\n- Owned scope: ${scope || '(read-only/unscoped)'}\n- Acceptance criteria: ${outcomeTask.criterionIds.join(', ') || 'report concrete verification evidence'}\nWork persistently until this bounded assignment is complete. Return exact changed files, commands/checks run, results, gaps, and blockers. Your report is not trusted completion evidence; the parent will verify it independently.`
        : args.prompt;

      // We don't await the worker here. We fire and forget.
      globalSubAgentManager.spawnWorker(taskId, {
        agentType,
        prompt: assignmentPrompt,
        cwd: currentCwd,
        parentMode: parentMode,
        scope,
        depth: myDepth + 1,
        capacityPath: capacityContext.path,
        capacityRunId: capacityContext.runId,
        ...(process.env[CAPACITY_LEASE_ENV] ? { capacityParentLeaseId: process.env[CAPACITY_LEASE_ENV] } : {}),
        ...(outcomeTask ? { outcomeTaskId: outcomeTask.id } : {}),
        ...(outcomeSessionId ? { outcomeSessionId } : {}),
        ...(model ? { model } : {}),
        ...(isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
        ...(outcomeTask?.mutates && isolation === 'worktree' ? { isolationRequired: true } : {}),
      }).then(result => {
        Logger.info(`[SpawnSubagentTool] Sub-agent ${taskId} finished successfully.`);
        // Surface the result instead of discarding it (the prior code only logged). Posted as a
        // system message so it's visible to the user and captured in the transcript.
        const text = formatSubAgentResult(result);
        if (outcomeManager && outcomeTask) {
          try { outcomeManager.settleAssignmentForSession(outcomeSessionId, outcomeTask.id, taskId, true, result); } catch { /* surfaced by task state */ }
        }
        cliEvents.emit('message', {
          id: `subagent-result-${taskId}`,
          role: 'system',
          level: 'success',
          content: `✓ Sub-agent ${agentType} (${taskId}) finished:\n\n${text.slice(0, 4000)}`,
          timestamp: new Date(),
        });
      }).catch(err => {
        if (outcomeManager && outcomeTask) {
          try { outcomeManager.settleAssignmentForSession(outcomeSessionId, outcomeTask.id, taskId, false, err.message); } catch { /* surfaced by task state */ }
        }
        Logger.error(`[SpawnSubagentTool] Sub-agent ${taskId} failed: ${err.message}`);
        cliEvents.emit('message', {
          id: `subagent-result-${taskId}`,
          role: 'system',
          level: 'error',
          content: `✗ Sub-agent ${agentType} (${taskId}) failed: ${err.message}`,
          timestamp: new Date(),
        });
      });

      const overlapNote = collisions.length > 0
        ? ` ⚠ isolated scope overlaps sibling(s): ${collisions.map(c => `${c.agentType}[${c.scope}]`).join(', ')} — parent merge validation is required.`
        : '';
      return `TASK_QUEUED: Sub-agent ${agentType} spawned${outcomeTask ? ` for ${outcomeTask.id}` : ''}${scope ? ` (scope: ${scope})` : ''}${model ? ` on ${model}` : ''}${isolation === 'worktree' ? ' in an isolated git worktree' : ''} as ${taskId}.${overlapNote}`;
    }
  }, governor);
}
