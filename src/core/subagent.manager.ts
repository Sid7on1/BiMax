import { Worker } from 'worker_threads';
import * as path from 'path';
import { existsSync } from 'fs';
import { Logger } from '../utils/logger';
import { engineEvents } from '../engine/events';
import { FLOOR_ENV } from '../sandbox/exec.sandbox';
import { globalSubAgentBlackboard } from './subagent.blackboard';
import { getTracer } from '../telemetry/trace';
import { createWorktree, inspectWorktreeChanges, settleWorktree, validateWorktree, worktreeChangedPaths, WorktreeInfo } from './worktree.manager';
import { saveCheckpoint, CheckpointedAgent } from './agent.checkpoint';
import { journalSubagent } from './subagent.journal';
import {
  resolveCapacityContext,
  SubAgentCapacityCoordinator,
  SubAgentCapacityLease,
} from './subagent.capacity';
import { formatSubAgentResult, SubAgentResultEnvelope } from './subagent.result';

// Line-delimited sentinels the sub-agent SUBPROCESS (bun-compiled binary re-execing itself) writes to
// stdout, and the parent parses back into the same {type} messages a worker_thread posts. Shared with
// worker.entry.ts's runAsSubprocess so the two ends can never drift.
export const SUB_RESULT = '\x00BIMAX_SUB_RESULT\x00';
export const SUB_ERROR = '\x00BIMAX_SUB_ERROR\x00';
export const SUB_EVENT = '\x00BIMAX_SUB_EVENT\x00';
export const SUB_READY = '\x00BIMAX_SUB_READY\x00';

// The uniform surface both a Worker (Node dev/dist) and a child-process handle (bun binary) expose,
// so the spawn/timeout/settle logic below is identical for both transports.
interface WorkerHandle {
  on(event: 'message' | 'error' | 'exit', listener: (arg: any) => void): void;
  terminate(): void | Promise<number>;
}

export interface SubAgentConfig {
  agentType: string;
  prompt: string;
  cwd: string;
  parentMode: string;
  // What this agent is responsible for (paths/globs/topic) — its claim on the blackboard, used to
  // detect overlap with sibling agents and to show coverage in /subagents and the TUI panel.
  scope?: string;
  // Model this sub-agent runs on. Unset = inherit the parent's configured model. Set per-spawn
  // (SpawnSubagentTool's `model` arg) or globally (config.subagentModel).
  model?: string;
  // Sandbox floor (BiMax v2): when set, the worker runs as an isolated autonomous episode —
  // Bash confined by the OS sandbox to this root with network denied, file tools' workspace
  // narrowed to it, net-facing tools not registered. Carried via the worker's own env copy.
  sandboxFloorRoot?: string;
  // Worktree isolation (the Cursor 2.0 / Claude Code pattern): the sub-agent runs in its own git
  // worktree + branch under .bimax/worktrees/, so parallel agents can't clobber each other's
  // edits. Auto-removed when the agent changed nothing; kept (and reported) when it did.
  isolation?: 'worktree';
  /** Coordinated writable assignments fail closed if their requested worktree cannot be created. */
  isolationRequired?: boolean;
  // Nesting depth of this agent in the tree: the main session is 0, its sub-agents are 1, theirs
  // are 2. Workers register SpawnSubagentTool only while depth < MAX_SUBAGENT_DEPTH, giving the
  // 3-level agent trees Claude Code ships (main + two nested layers).
  depth?: number;
  /** Stable link to the engine-owned outcome task this worker is executing. */
  outcomeTaskId?: string;
  /** Outcome session owning the assignment, so a late result cannot settle a different thread. */
  outcomeSessionId?: string;
  /** Shared cross-process capacity context inherited by nested workers and worktrees. */
  capacityPath?: string;
  capacityRunId?: string;
  capacityLeaseId?: string;
  capacityParentLeaseId?: string;
  /** Durable identity of an already-created isolated checkout; used to resume crash-surviving edits. */
  recoveryWorktree?: WorktreeInfo;
  /** Previous worker id when this config was reconstructed from a crash checkpoint. */
  recoveryOf?: string;
}

/** Maximum nesting depth of the agent tree (main session = 0, so 3 ⇒ two nested worker layers). */
export const MAX_SUBAGENT_DEPTH = 3;

export class SubAgentManager {
  private activeWorkers = new Map<string, WorkerHandle>();
  private workerScriptPath: string;
  // Extra Node args for the worker thread. In dev the engine runs from TypeScript source via `tsx`,
  // so the worker must load the tsx hooks to parse the .ts entry — otherwise `new Worker(...ts)`
  // throws "Cannot find module" / can't parse TS. Empty in prod (compiled .js needs no loader).
  private readonly workerExecArgv: string[];
  // True inside a `bun --compile` single binary (the shipped global install). There is no dist/ or
  // node_modules on disk there, so the worker can't be spawned from a filesystem path — it must be
  // the bun-EMBEDDED worker (see worker.target.bun.ts). Node dev/dist keep the compiled-.js path.
  private readonly isBun: boolean = !!(process as any).versions?.bun;
  // Set when a test passes an explicit worker script — that path always wins over bun-embedding.
  private readonly hasScriptOverride: boolean;
  // A sub-agent that hangs (stalled stream, infinite loop) must not block the parent
  // forever. Configurable; defaults to 10 minutes — generous for slow reasoning models.
  private readonly workerTimeoutMs: number;

  // opts is a test seam: production callers use the default worker entrypoint and timeout.
  constructor(opts?: { workerScriptPath?: string; timeoutMs?: number }) {
    // ALWAYS prefer a COMPILED worker entry. A worker thread does not reliably inherit a TypeScript
    // loader (tsx/ts-node) via execArgv across Node versions — passing `--import tsx` to the worker
    // fails to register the ESM hooks, which surfaced as "Cannot find package 'minimatch'" /
    // "Unknown file extension '.ts'" and killed EVERY sub-agent whenever the engine ran from source.
    // A plain .js worker under plain node needs no loader and just works.
    // Candidates: the sibling .js when we're already compiled (dist/core → dist/engine), and the dist
    // copy when running from source (src/core → ../../dist/engine). Fall back to the .ts entry + tsx
    // only if no compiled worker exists at all (pure-source checkout with no build).
    const compiledCandidates = [
      path.resolve(__dirname, '../engine/worker.entry.js'),
      path.resolve(__dirname, '../../dist/engine/worker.entry.js'),
    ];
    const compiledJs = compiledCandidates.find(existsSync);
    const tsPath = path.resolve(__dirname, '../engine/worker.entry.ts');
    this.hasScriptOverride = !!opts?.workerScriptPath;
    if (opts?.workerScriptPath) {
      this.workerScriptPath = opts.workerScriptPath;
      this.workerExecArgv = opts.workerScriptPath.endsWith('.ts') ? ['--import', 'tsx'] : [];
    } else if (compiledJs) {
      this.workerScriptPath = compiledJs;
      this.workerExecArgv = [];
    } else {
      this.workerScriptPath = tsPath;
      this.workerExecArgv = ['--import', 'tsx'];
    }
    this.workerTimeoutMs = opts?.timeoutMs ?? parseInt(process.env.BGW_WORKER_TIMEOUT_MS || '600000', 10);
  }

  // Choose the transport. Node dev/dist → a worker_thread (fast, shared address space). The
  // bun-compiled single binary → a CHILD PROCESS that re-execs the binary itself: worker_threads
  // in a bun --compile executable cannot resolve their dependencies (minimatch et al. aren't
  // bundled into the embedded worker), but a re-exec of the whole binary carries every dependency.
  private createHandle(taskId: string, config: SubAgentConfig, workerOpts: any): WorkerHandle {
    if (this.isBun && !this.hasScriptOverride) {
      return this.spawnSubprocessHandle(config, workerOpts);
    }
    return new Worker(this.workerScriptPath, { ...workerOpts, execArgv: this.workerExecArgv });
  }

  // Re-exec THIS binary with BIMAX_SUBAGENT_CONFIG set; index.ts detects it and runs the sub-agent
  // instead of the engine, streaming results back over stdout sentinels which we translate into the
  // same {type: 'success'|'error'|'tool_event'} messages a worker_thread would post.
  private spawnSubprocessHandle(config: SubAgentConfig, workerOpts: any): WorkerHandle {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process') as typeof import('child_process');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventEmitter } = require('events') as typeof import('events');
    const env = { ...(workerOpts.env || process.env), BIMAX_SUBAGENT_CONFIG: JSON.stringify(config) };
    const child = spawn(process.execPath, [], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    const emitter = new EventEmitter();
    let buf = '';
    // StringDecoder, not per-chunk toString(): a multibyte UTF-8 char split across two pipe
    // reads would otherwise decode to U+FFFD and corrupt the sub-agent's result text.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { StringDecoder } = require('string_decoder') as typeof import('string_decoder');
    const utf8 = new StringDecoder('utf8');
    child.stdout?.on('data', (d: Buffer) => {
      buf += utf8.write(d);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try {
          if (line.startsWith(SUB_RESULT)) emitter.emit('message', { type: 'success', result: JSON.parse(line.slice(SUB_RESULT.length)).result });
          else if (line.startsWith(SUB_ERROR)) emitter.emit('message', { type: 'error', error: JSON.parse(line.slice(SUB_ERROR.length)).error });
          else if (line.startsWith(SUB_READY)) emitter.emit('message', { type: 'ready' });
          else if (line.startsWith(SUB_EVENT)) { const e = JSON.parse(line.slice(SUB_EVENT.length)); emitter.emit('message', { type: 'tool_event', subtype: e.subtype, call: e.call }); }
          // any other line is stray child stdout — ignore it
        } catch { /* malformed sentinel line — ignore */ }
      }
    });
    child.on('error', (e: Error) => emitter.emit('error', e));
    child.on('exit', (code: number | null) => emitter.emit('exit', code ?? 0));
    return {
      on: (ev, fn) => { emitter.on(ev, fn); },
      terminate: () => { try { child.kill('SIGKILL'); } catch { /* best-effort */ } },
    };
  }

  // The config each live task was spawned with — the recovery data the checkpoint persists.
  private spawnConfigs = new Map<string, SubAgentConfig>();

  /**
   * Snapshot the blackboard onto the event bus (so the /subagents view + TUI panel stay live)
   * AND checkpoint the agent tree to disk (so a crashed parent's swarm is recoverable).
   */
  private emitBoard(): void {
    try { engineEvents.emit('subagent_update', globalSubAgentBlackboard.all()); } catch { /* best-effort */ }
    try {
      const agents: CheckpointedAgent[] = globalSubAgentBlackboard.all()
        .filter(c => this.spawnConfigs.has(c.taskId))
        .map(c => ({ claim: c, config: this.spawnConfigs.get(c.taskId)! }));
      saveCheckpoint(agents);
    } catch { /* best-effort */ }
  }

  public spawnWorker(taskId: string, config: SubAgentConfig): Promise<SubAgentResultEnvelope> {
    return new Promise((resolve, reject) => {
      Logger.info(`[SubAgentManager] Spawning worker for task ${taskId} (Agent: ${config.agentType})`);

      // WS2.1 — lifecycle instrumentation. All timestamps are parent-side (message arrival),
      // so the journal adds zero overhead inside the worker. t0 is taken BEFORE worktree
      // creation so isolation cost lands in msToFirstEvent, where it belongs.
      const t0 = Date.now();
      let sawFirstEvent = false;
      let toolCallCount = 0;
      const journalFirstEvent = () => {
        if (sawFirstEvent) return;
        sawFirstEvent = true;
        journalSubagent({ taskId, phase: 'first_event', ms: Date.now() - t0 });
      };
      const journalSettled = (outcome: 'done' | 'failed' | 'timeout') =>
        journalSubagent({ taskId, phase: 'settled', outcome, ms: Date.now() - t0, toolCalls: toolCallCount });

      // Worktree isolation: give the agent its own checkout + branch BEFORE the config is frozen
      // into workerData. Creation failing (not a git repo, git missing) falls back to running
      // unisolated — the pre-worktree behavior — never a spawn failure. A floored episode is
      // re-floored to the worktree so the OS sandbox confines it to its own copy.
      const capacityRootCwd = config.recoveryWorktree?.repoRoot || config.cwd;
      let worktree: WorktreeInfo | null = null;
      if (config.isolation === 'worktree') {
        if (config.recoveryWorktree) {
          if (!validateWorktree(config.recoveryWorktree)) {
            reject(new Error(`Checkpointed worktree for ${taskId} is missing or no longer matches its recorded branch; refusing to discard interrupted work.`));
            return;
          }
          worktree = config.recoveryWorktree;
          config = {
            ...config,
            cwd: worktree.path,
            ...(config.sandboxFloorRoot ? { sandboxFloorRoot: worktree.path } : {}),
          };
        } else {
          worktree = createWorktree(config.cwd, taskId);
        }
        if (!worktree && config.isolationRequired) {
          reject(new Error(`Required worktree isolation could not be created for ${taskId}.`));
          return;
        }
        if (worktree) {
          config = {
            ...config,
            cwd: worktree.path,
            recoveryWorktree: worktree,
            ...(config.sandboxFloorRoot ? { sandboxFloorRoot: worktree.path } : {}),
          };
        }
      }
      const capacityContext = resolveCapacityContext(capacityRootCwd, config.capacityPath, config.capacityRunId);
      const capacity = new SubAgentCapacityCoordinator(capacityContext.path);
      let capacityLease: SubAgentCapacityLease;
      try {
        capacityLease = capacity.acquire({
          taskId,
          runId: capacityContext.runId,
          parentLeaseId: config.capacityParentLeaseId,
        });
        config = {
          ...config,
          capacityPath: capacityContext.path,
          capacityRunId: capacityContext.runId,
          capacityLeaseId: capacityLease.id,
        };
      } catch (error: any) {
        const note = worktree ? settleWorktree(worktree).note : '';
        reject(new Error(`${error?.message || String(error)}${note ? `\n\n${note}` : ''}`));
        return;
      }
      let capacityReleased = false;
      const heartbeat = setInterval(() => {
        try { capacity.heartbeat(capacityLease.id); } catch { /* expiry remains the crash fallback */ }
      }, 10_000);
      heartbeat.unref?.();
      const releaseCapacity = () => {
        if (capacityReleased) return;
        capacityReleased = true;
        clearInterval(heartbeat);
        try { capacity.release(capacityLease.id); } catch { /* TTL reclaims it */ }
      };
      // Settle exactly once on whichever completion path fires first: remove the worktree when
      // the agent changed nothing, keep + describe it when it made edits/commits.
      const settleIsolation = (): string => {
        if (!worktree) return '';
        const info = worktree;
        worktree = null;
        try { return settleWorktree(info).note; } catch { return ''; }
      };
      const outsideOwnedScope = (changed: string[]): string[] => {
        if (!config.outcomeTaskId || changed.length === 0) return [];
        const owned = (config.scope || '').split(/[\s,;]+/)
          .map(value => value.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
          .filter(Boolean);
        if (owned.length === 0) return changed;
        return changed.filter(file => !owned.some(scope => file === scope || file.startsWith(`${scope}/`)));
      };

      globalSubAgentBlackboard.register(taskId, config.agentType, config.scope || '', config.prompt, config.outcomeTaskId);
      this.spawnConfigs.set(taskId, config);
      this.emitBoard();

      journalSubagent({
        taskId, phase: 'spawned', agentType: config.agentType,
        ...(config.model ? { model: config.model } : {}),
        ...(config.depth ? { depth: config.depth } : {}),
        ...(config.isolation ? { isolation: config.isolation } : {}),
      });

      // Sub-agent lifetime span (OTel GenAI invoke_agent). end() is idempotent, so the
      // timeout / error / exit paths can all settle it without coordination.
      const span = getTracer().startSpan(`invoke_agent ${config.agentType}`, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': config.agentType,
        'bimax.subagent.task_id': taskId,
        ...(config.scope ? { 'bimax.subagent.scope': config.scope } : {}),
      });

      const workerOpts = {
        workerData: config,
        // Floored episodes get their own env copy with the floor flag — thread-scoped, so the
        // parent session and sibling workers are unaffected.
        ...(config.sandboxFloorRoot
          ? { env: { ...process.env, [FLOOR_ENV]: config.sandboxFloorRoot } }
          : {}),
      };
      let worker: WorkerHandle;
      try {
        worker = this.createHandle(taskId, config, workerOpts);
      } catch (error) {
        globalSubAgentBlackboard.markFailed(taskId, error instanceof Error ? error.message : String(error));
        this.spawnConfigs.delete(taskId);
        this.emitBoard();
        settleIsolation();
        releaseCapacity();
        reject(error);
        return;
      }

      this.activeWorkers.set(taskId, worker);

      // Watchdog: terminate and reject if the worker produces no result in time. Cleared
      // the moment the promise settles so a healthy worker never trips it.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        Logger.error(`[SubAgentManager] Worker for task ${taskId} timed out after ${this.workerTimeoutMs}ms. Terminating.`);
        this.activeWorkers.delete(taskId);
        Promise.resolve(worker.terminate()).catch(() => { /* TTL reclaims the lease */ }).finally(releaseCapacity);
        // Settle the board too — a timed-out agent must not linger as 'running' (it would show
        // forever in /subagents AND look crash-recoverable to the checkpoint).
        globalSubAgentBlackboard.markFailed(taskId, `timed out after ${this.workerTimeoutMs}ms`);
        this.spawnConfigs.delete(taskId);
        this.emitBoard();
        span.end('error', `timed out after ${this.workerTimeoutMs}ms`);
        journalSettled('timeout');
        const note = settleIsolation();
        if (note) Logger.warn(`[SubAgentManager] ${taskId} timed out but left changes: ${note}`);
        reject(new Error(`Worker for task ${taskId} timed out after ${this.workerTimeoutMs}ms`));
      }, this.workerTimeoutMs);

      const finalize = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeWorkers.delete(taskId);
        releaseCapacity();
        fn();
      };

      worker.on('message', (message) => {
        // Post-settlement guard: after a timeout (or any earlier terminal event) a late
        // success/error message must NOT re-write the board — it would flip a timed-out agent to
        // "done" or overwrite the real failure reason and fire a spurious board refresh.
        if (settled && (message.type === 'success' || message.type === 'error')) return;
        // 'ready' = boot finished, about to make the first llm call. It's OUR overhead and precedes
        // any real work, so record it as its own phase and do NOT let it consume first_event.
        if (message.type === 'ready') {
          if (!settled) {
            // The worker now owns lease renewal. Stopping the parent heartbeat is important for
            // subprocesses: otherwise parent/child PIDs would race in the shared lease record.
            clearInterval(heartbeat);
            globalSubAgentBlackboard.setPhase(taskId, 'working');
            this.emitBoard();
            journalSubagent({ taskId, phase: 'ready', ms: Date.now() - t0 });
          }
          return;
        }
        journalFirstEvent(); // first substantive message — log, tool event, or immediate result
        if (message.type === 'success') {
          let changed: string[];
          try {
            changed = worktree
              ? (config.outcomeTaskId ? inspectWorktreeChanges(worktree) : worktreeChangedPaths(worktree))
              : [];
          } catch (error: any) {
            const detail = `Could not inspect coordinated worktree changes: ${error?.message || error}`;
            globalSubAgentBlackboard.markFailed(taskId, detail);
            this.spawnConfigs.delete(taskId);
            this.emitBoard();
            span.end('error', detail);
            journalSettled('failed');
            const note = settleIsolation();
            finalize(() => reject(new Error(`${detail}${note ? `\n\n${note}` : ''}`)));
            return;
          }
          const outside = outsideOwnedScope(changed);
          if (outside.length > 0) {
            const error = `Assignment changed files outside owned scope ${config.scope}: ${outside.join(', ')}`;
            globalSubAgentBlackboard.markFailed(taskId, error);
            this.spawnConfigs.delete(taskId);
            this.emitBoard();
            span.end('error', error);
            journalSettled('failed');
            const note = settleIsolation();
            finalize(() => reject(new Error(`${error}${note ? `\n\n${note}` : ''}`)));
            return;
          }
          const rawResult = typeof message.result === 'string' ? message.result : JSON.stringify(message.result);
          const result: SubAgentResultEnvelope = {
            version: 1,
            taskId,
            outcomeTaskId: config.outcomeTaskId,
            agentType: config.agentType,
            report: rawResult,
            claimedScope: config.scope || '',
            observedChangedFiles: changed,
            startedAt: t0,
            endedAt: Date.now(),
            toolCalls: toolCallCount,
            ...(worktree && changed.length ? {
              isolation: {
                kind: 'worktree' as const,
                repoRoot: worktree.repoRoot,
                path: worktree.path,
                branch: worktree.branch,
                baseCommit: worktree.baseCommit,
                state: 'pending_integration' as const,
              },
            } : {}),
          };
          globalSubAgentBlackboard.markDone(taskId, formatSubAgentResult(result));
          this.spawnConfigs.delete(taskId); // settled — no longer crash-recoverable
          this.emitBoard();
          span.end('ok');
          journalSettled('done');
          const note = settleIsolation();
          if (note) Logger.info(`[SubAgentManager] ${taskId}: ${note}`);
          finalize(() => resolve(result));
        } else if (message.type === 'error') {
          globalSubAgentBlackboard.markFailed(taskId, String(message.error));
          this.spawnConfigs.delete(taskId);
          this.emitBoard();
          span.end('error', String(message.error));
          journalSettled('failed');
          const note = settleIsolation();
          if (note) Logger.warn(`[SubAgentManager] ${taskId} failed but left changes: ${note}`);
          finalize(() => reject(new Error(message.error)));
        } else if (message.type === 'log') {
          Logger.info(`[Worker ${taskId}] ${message.content}`);
        } else if (message.type === 'tool_event' && message.call) {
          // T3 — re-emit a sub-agent's tool activity on the main event bus, tagged so the UI nests
          // it under this spawn. Tag-and-forward only; never settles the spawn promise.
          globalSubAgentBlackboard.incTool(taskId);
          if (message.subtype === 'tool_call') {
            const tool = String(message.call.toolName || '').toLowerCase();
            const input = String(message.call.input || '').toLowerCase();
            const phase = /test|jest|vitest|pytest|cargo test|go test|typecheck|lint/.test(`${tool} ${input}`)
              ? 'testing'
              : /edit|write|delete|multiedit|symboledit/.test(tool)
                ? 'editing'
                : /search|grep|glob|read|graph|web|scout/.test(tool)
                  ? 'researching'
                  : 'working';
            globalSubAgentBlackboard.setPhase(taskId, phase);
            this.emitBoard(); // one board refresh per new call, not per result
            toolCallCount++;
            journalSubagent({ taskId, phase: 'tool_call', tool: message.call.toolName, ms: Date.now() - t0 });
          }
          const call = { ...message.call, parentId: taskId, agentLabel: config.agentType };
          engineEvents.emit(message.subtype === 'tool_call_result' ? 'tool_call_result' : 'tool_call', call);
        }
      });

      worker.on('error', (err) => {
        if (settled) return; // already resolved/rejected/timed-out — don't clobber the outcome
        globalSubAgentBlackboard.markFailed(taskId, err?.message || String(err));
        this.spawnConfigs.delete(taskId);
        this.emitBoard();
        span.end('error', err?.message || String(err));
        settleIsolation();
        finalize(() => reject(err));
      });

      worker.on('exit', (code) => {
        // A terminate()-driven exit follows every timeout/error/success settle. Bail so it can't
        // overwrite the recorded reason ("timed out after Nms" → "exited with code 1") or double-emit.
        if (settled) return;
        if (code !== 0) {
          span.end('error', `exit code ${code}`);
          settleIsolation();
          // A worker that died without posting an error would otherwise stay 'running' on the
          // board — settle it so the panel and the crash checkpoint both see the truth.
          globalSubAgentBlackboard.markFailed(taskId, `worker exited with code ${code}`);
          this.spawnConfigs.delete(taskId);
          this.emitBoard();
          finalize(() => reject(new Error(`Worker stopped with exit code ${code}`)));
        } else {
          span.end('ok');
          const note = settleIsolation();
          this.spawnConfigs.delete(taskId);
          // Worker exited cleanly but never posted a 'success' message — settle the
          // promise so the caller is never left hanging. No-op if already settled.
          const result: SubAgentResultEnvelope = {
            version: 1, taskId, outcomeTaskId: config.outcomeTaskId, agentType: config.agentType,
            report: `Worker exited cleanly with no explicit result.${note ? ` ${note}` : ''}`,
            claimedScope: config.scope || '', observedChangedFiles: [], startedAt: t0,
            endedAt: Date.now(), toolCalls: toolCallCount,
          };
          finalize(() => resolve(result));
        }
      });
    });
  }

  public activeCount(): number {
    return this.activeWorkers.size;
  }

  public killWorker(taskId: string): void {
    const worker = this.activeWorkers.get(taskId);
    if (worker) {
      worker.terminate();
      this.activeWorkers.delete(taskId);
      Logger.warn(`[SubAgentManager] Terminated worker for task ${taskId}`);
    }
  }

  public killAll(): void {
    for (const [taskId, worker] of this.activeWorkers) {
      worker.terminate();
      Logger.warn(`[SubAgentManager] Terminated worker for task ${taskId}`);
    }
    this.activeWorkers.clear();
  }
}

export const globalSubAgentManager = new SubAgentManager();
