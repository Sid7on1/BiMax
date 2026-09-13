import { IGovernor } from '../../core/interfaces';
import { runToolWorkflow, WorkflowStep, WorkflowStepState } from '../../core/tool.workflow';
import { WorkflowStore } from '../../core/workflow.store';
import * as path from 'path';
import { buildTool } from '../tool.factory';
import { outcomeError, outcomeOk } from '../outcome';
import { ToolRegistry } from '../tool.registry';

export function createToolWorkflowTool(governor: IGovernor, registry: ToolRegistry) {
  const store = new WorkflowStore();
  return buildTool({
    name: 'ToolWorkflowTool',
    description: `Run a bounded dependency graph of read-only coding lookups in one call.
Eligible tools: ReadFileTool, GrepTool, GlobTool. Use exact names and their normal argument schemas.
Independent steps overlap; dependsOn waits for successful prerequisites. A failed prerequisite skips its dependents while independent branches continue.
bindings maps a destination argument to {step, pointer?, line?}: step is the source ID, pointer is an optional JSON Pointer into its JSON result (empty string selects parsed root), and line is an optional zero-based text line. Bindings automatically add dependencies. Never bind a parameter also supplied in args.
Example: read package.json as step "config", then GrepTool with args {path:"src"} and bindings {pattern:{step:"config",pointer:"/name"}}.
Results are in input order with per-step status, durationMs and 2000-character previews; truncated is explicit. Intermediate results up to 64 KiB remain available to bindings. Narrow larger lookups.
Each step reports input evidence freshness: current, stale or incomplete. current means observed inputs matched at checkedAt, not proven code correctness. Incomplete searches cannot establish absence across the whole scope. Stale prerequisites block their dependents.
action "run" (default) accepts steps. A session-scoped workflowId is returned when retention is available. Later use action "refresh" with workflowId and no steps to recheck input hashes and rerun changed steps and dependents; unchanged steps may reuse results after current permissions/hooks. New files invalidate directory searches. Refresh is explicit, not a background watcher. IDs expire after 30 minutes or eviction/restart; unavailable IDs require a new run.
No shell, edits, arbitrary code, retries or recursive workflows. Each nested call enforces its usual permissions and hooks. Cancellation stops new work and drains started calls. Success means tool completion, not verified code correctness.`,
    isDestructive: false,
    // An outer barrier prevents overlap with other calls that mutate shared state.
    isConcurrencySafe: false,
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['run', 'refresh'] },
        workflowId: { type: 'string', description: 'ID returned by a prior run in this session and working directory.' },
        steps: {
          type: 'array', minItems: 1, maxItems: 32,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' },
              tool: { type: 'string' },
              args: { type: 'object' },
              dependsOn: { type: 'array', items: { type: 'string' } },
              bindings: {
                type: 'object', additionalProperties: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    step: { type: 'string' }, pointer: { type: 'string' },
                    line: { type: 'integer', minimum: 0 },
                  }, required: ['step'],
                },
              },
            }, required: ['id', 'tool', 'args'],
          },
        },
      },
    },
    execute: async (args: { action?: string; steps?: WorkflowStep[]; workflowId?: string }, context?: any) => {
      let acquired: string | undefined;
      try {
        const scope = typeof context?.sessionId === 'string' && context.sessionId
          ? JSON.stringify([context.sessionId, path.resolve(context?.cwd || process.cwd())]) : undefined;
        let steps = args.steps;
        let previous: Map<string, WorkflowStepState> | undefined;
        if (args.action === 'refresh') {
          if (!scope || !args.workflowId || args.steps !== undefined) throw new Error('Refresh requires a session, workflowId and no steps.');
          const saved = store.acquire(args.workflowId, scope);
          acquired = args.workflowId;
          steps = saved.steps;
          previous = saved.state;
        } else if ((args.action !== undefined && args.action !== 'run') || args.workflowId !== undefined) {
          throw new Error('Use run with steps, or refresh with workflowId.');
        }
        if (!steps || Buffer.byteLength(JSON.stringify(steps)) > 64 * 1024) throw new Error('Provide steps with a total plan size of at most 64 KiB.');
        let state = new Map<string, WorkflowStepState>();
        const result = await runToolWorkflow(steps, registry, context, { previous, save: value => { state = value; } });
        const workflowId = scope ? store.save(scope, steps, state, acquired) : undefined;
        const text = JSON.stringify({ ...result, workflowId, retained: workflowId !== undefined });
        return result.ok ? outcomeOk(text) : outcomeError('external', text);
      } catch (error) {
        return outcomeError('invalid_args', JSON.stringify({
          ok: false, error: error instanceof Error ? error.message : String(error), steps: [],
        }));
      } finally { if (acquired) store.release(acquired); }
    },
  }, governor);
}
