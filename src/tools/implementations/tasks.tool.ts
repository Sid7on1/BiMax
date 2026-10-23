import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { globalSubAgentBlackboard, SubAgentClaim } from '../../core/subagent.blackboard';
import { globalSubAgentManager } from '../../core/subagent.manager';
import { getTaskRegistry, WorkspaceTask } from '../../core/task.registry';
import { TERMINAL_STATES } from '../../core/execution.ledger';

// Task management — inspect and control the sub-agents (background tasks) spawned via
// SpawnSubagentTool. Sub-agents are otherwise fire-and-forget: the orchestrator could spawn a swarm
// but had no way to LIST who's running, GET one finished agent's output on demand, or STOP a runaway.
// This exposes the parent-side blackboard (status/coverage) + manager (lifecycle) to the agent,
// completing the map→reduce loop. (Parity with Claude Code's TaskList/TaskGet/TaskStop family,
// consolidated into one action-dispatched tool in the BiMax style.)

/** A stable, compact age string for a claim (running → since start; finished → total runtime). */
function ageOf(c: SubAgentClaim): string {
  const ms = (c.endedAt ?? Date.now()) - c.startedAt;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

const ICON: Record<SubAgentClaim['status'], string> = { running: '◍', done: '✓', failed: '✗' };

function fmtRow(c: SubAgentClaim): string {
  const scope = c.scope && c.scope !== '(unscoped)' ? ` · ${c.scope}` : '';
  return `${ICON[c.status]} ${c.taskId} — ${c.agentType} [${c.status}]${scope} · ${c.toolCalls} tools · ${ageOf(c)}\n    ${c.prompt}`;
}

function shellRow(task: WorkspaceTask): string {
  const exit = task.exitCode === undefined ? '' : ` · exit ${task.exitCode}`;
  return `${task.id} — ${task.title} [${task.state}]${exit}${task.failure ? ` · ${task.failure}` : ''}`;
}

function shellResult(task: WorkspaceTask): string {
  const output = getTaskRegistry().output(task.id);
  return `${shellRow(task)}\n\n${output || '(no captured output)'}`;
}

/** One deadline, lifecycle notifications and abort cleanup; no periodic task scans. */
async function waitForUpdate(ready: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const disposers: (() => void)[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      for (const dispose of disposers) dispose();
      signal?.removeEventListener('abort', abort);
    };
    const finish = () => { cleanup(); resolve(); };
    const abort = () => {
      cleanup();
      try { signal?.throwIfAborted(); } catch (error) { reject(error); }
    };
    const check = () => { if (ready()) finish(); };
    disposers.push(globalSubAgentBlackboard.onChange(check), getTaskRegistry().onChange(check));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(finish, timeoutMs);
    check();
  });
}

export const createTasksTool = (governor: IGovernor) => buildTool({
  name: 'TasksTool',
  description: `Inspect and control sub-agent workers from SpawnSubagentTool and background shell tasks from BashTool.

# Actions (pass as \`action\`)
- \`list\` — sub-agent status/scope and background shell task ids/states.
- \`get\` — a worker's result or a shell task's state, exit code, failure and bounded output tail by exact \`taskId\`.
- \`wait\` — wait for the selected \`taskId\` to settle, or any currently running work when omitted (up to \`timeout_seconds\`, max 60). Finished tasks return immediately. Stop interrupts the wait.
- \`stop\` — terminate the selected worker or cancel the selected shell task; shell cancellation finishes only after its output pipes close.
- \`pause\` / \`resume\` — suspend/resume a shell task through its real process handle. Workers cannot pause.`,
  isDestructive: false, // control-plane, not a code mutation — but 'stop' is real, so keep it un-batched
  isConcurrencySafe: (args: any) => ['list', 'get', 'wait'].includes(String(args?.action || '').toLowerCase()),
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'wait', 'stop', 'pause', 'resume'], description: 'list | get | wait | stop | pause | resume' },
      taskId: { type: 'string', description: 'Exact worker or shell task id. Required for get/stop/pause/resume; optional target for wait.' },
      timeout_seconds: { type: 'number', description: 'For wait: 1-60 seconds. Defaults to 30.' },
    },
    required: ['action'],
  },
  execute: async (args: { action: string; taskId?: string; timeout_seconds?: number }, context?: { signal?: AbortSignal }) => {
    const bb = globalSubAgentBlackboard;
    const registry = getTaskRegistry();
    const action = (args.action || '').toLowerCase();

    if (action === 'list') {
      bb.prune();
      const all = bb.all();
      const shells = registry.list().filter(t => t.kind === 'shell');
      if (all.length === 0 && shells.length === 0) return 'No sub-agents spawned this session. No background shell tasks.';
      const running = all.filter(c => c.status === 'running').length;
      return [all.length ? `Sub-agents — ${running} running · ${all.length} total\n\n${all.map(fmtRow).join('\n')}` : '',
        shells.length ? `Background shell tasks\n\n${shells.map(shellRow).join('\n')}` : ''].filter(Boolean).join('\n\n');
    }

    const shell = args.taskId ? registry.get(args.taskId) : undefined;
    if (shell?.kind === 'shell') {
      if (action === 'get') return shellResult(shell);
      if (action === 'stop') return registry.cancel(shell.id);
      if (action === 'pause') return registry.pause(shell.id);
      if (action === 'resume') return registry.resume(shell.id);
    }

    if (action === 'pause' || action === 'resume') {
      return args.taskId ? `Error: ${action} requires a live shell task with a real process handle.`
        : `Error: \`${action}\` requires a \`taskId\` (run \`list\` to see ids).`;
    }

    if (action === 'get') {
      if (!args.taskId) return 'Error: `get` requires a `taskId` (run `list` to see ids).';
      const c = bb.all().find(x => x.taskId === args.taskId);
      if (!c) return `Error: no sub-agent with id ${args.taskId} (it may have been pruned — results older than a few minutes are dropped).`;
      const header = `${ICON[c.status]} ${c.agentType} [${c.status}] · ${c.toolCalls} tools · ${ageOf(c)}`;
      if (c.status === 'running') return `${header}\n\nStill running — no result yet. Re-check with \`get\` shortly, or \`list\` for live status.`;
      if (c.status === 'failed') return `${header}\n\n✗ Failed: ${c.error || 'unknown error'}`;
      return `${header}\n\n${c.result || '(finished with no textual result)'}`;
    }

    if (action === 'wait') {
      const worker = args.taskId ? bb.all().find(c => c.taskId === args.taskId) : undefined;
      if (args.taskId && !worker && shell?.kind !== 'shell') return `Error: no task with id ${args.taskId}.`;
      if (shell?.kind === 'shell' && TERMINAL_STATES.has(shell.state)) return shellResult(shell);
      if (worker && worker.status !== 'running') return `Agent update:\n\n${fmtRow(worker)}`;
      const workers = args.taskId ? worker ? [worker] : [] : bb.active();
      const shells = args.taskId ? shell?.kind === 'shell' ? [shell] : [] : registry.live().filter(t => t.kind === 'shell');
      if (!workers.length && !shells.length) return 'No sub-agents or background shell tasks are running.';
      const raw = Number(args.timeout_seconds);
      const timeoutMs = Math.max(1, Math.min(60, Number.isFinite(raw) && raw !== 0 ? raw : 30)) * 1000;
      const settledWorkers = () => workers.filter(c => c.status !== 'running');
      const settledShells = () => shells.filter(t => TERMINAL_STATES.has(t.state));
      await waitForUpdate(() => settledWorkers().length > 0 || settledShells().length > 0
        || (workers.every(c => !bb.all().includes(c)) && shells.every(t => !registry.get(t.id))), timeoutMs, context?.signal);
      const results = [settledWorkers().length ? `Agent update:\n\n${settledWorkers().map(fmtRow).join('\n')}` : '',
        ...settledShells().map(shellResult)].filter(Boolean);
      if (results.length) return results.join('\n\n');
      return `Wait timed out after ${Math.round(timeoutMs / 1000)}s or tracked tasks were removed; no completion observed.`;
    }

    if (action === 'stop') {
      if (!args.taskId) return 'Error: `stop` requires a `taskId` (run `list` to see ids).';
      const c = bb.all().find(x => x.taskId === args.taskId);
      if (!c) return `Error: no sub-agent with id ${args.taskId}.`;
      if (c.status !== 'running') return `Sub-agent ${args.taskId} is already ${c.status} — nothing to stop.`;
      globalSubAgentManager.killWorker(args.taskId);
      bb.markFailed(args.taskId, 'stopped by the orchestrator');
      return `Stopped sub-agent ${args.taskId} (${c.agentType}).`;
    }

    return `Error: unknown action "${args.action}". Use one of: list, get, wait, stop, pause, resume.`;
  },
}, governor);
