import { IGovernor } from '../../core/interfaces';
import { getOutcomeManager } from '../../outcome/outcome.manager';
import { CriterionStatus, EvidenceKind, OutcomeTaskStatus } from '../../outcome/outcome.model';
import { buildTool } from '../tool.factory';

interface OutcomeArgs {
  action: 'define' | 'set_tasks' | 'update_task' | 'retry_task' | 'integrate_task' | 'confirm_integration' | 'validate_task' | 'record_evidence' | 'set_criterion' | 'set_gaps' | 'set_blocker' | 'iterate' | 'schedule' | 'status' | 'finish';
  objective?: string;
  criteria?: Array<{
    id?: string;
    description: string;
    required?: boolean;
    files?: string[];
    verification?: 'build_test' | 'runtime' | 'visual' | 'research' | 'user' | 'other';
    requires_fresh_evidence?: boolean;
  }>;
  tasks?: Array<{
    id?: string;
    title: string;
    status?: OutcomeTaskStatus;
    required?: boolean;
    depends_on?: string[];
    owner?: string;
    criterion_ids?: string[];
    scope?: string;
    mutates?: boolean;
    execution?: 'local' | 'agent' | 'either';
    estimate_ms?: number;
    priority?: number;
    isolation?: 'worktree';
    max_attempts?: number;
  }>;
  task_id?: string;
  task_status?: OutcomeTaskStatus;
  owner?: string;
  criterion_id?: string;
  criterion_status?: CriterionStatus;
  evidence_ids?: string[];
  evidence_kind?: EvidenceKind;
  evidence_summary?: string;
  evidence_source?: string;
  evidence_ok?: boolean;
  criterion_ids?: string[];
  gaps?: Array<{ id?: string; description: string; criterion_id?: string; resolved?: boolean }>;
  blocker?: string;
  attempted?: string[];
  requires_user?: boolean;
  finish_status?: 'verified' | 'partially_verified' | 'blocked' | 'failed';
  detail?: string;
}

function renderStatus(manager = getOutcomeManager()): string {
  const contract = manager.current();
  const snapshot = manager.snapshot();
  if (!contract || !snapshot) return 'No outcome contract is active.';
  const lines = [
    `Outcome: ${contract.objective}`,
    `Phase: ${snapshot.phase} · loop ${snapshot.iteration}`,
    `Acceptance: ${snapshot.passed}/${snapshot.required} passed · ${snapshot.openGaps} gap(s)`,
    `Tasks: ${contract.tasks.filter(t => t.status === 'completed' || t.status === 'verified').length}/${contract.tasks.length} complete · ${snapshot.activeTasks} active`,
    `Completion gate: ${snapshot.canComplete ? 'OPEN' : 'CLOSED'}`,
    `Scheduler: ${snapshot.schedule.activeAgents} active · ${snapshot.schedule.parallelTasks} safe dispatch · critical ${snapshot.schedule.criticalTaskId || 'none'}`,
    `Next: ${snapshot.nextAction}`,
  ];
  return lines.join('\n');
}

/**
 * Model-facing control surface for the engine-owned outcome contract. Substantial work should define
 * the contract before implementation, keep task/evidence facts current, and ask the runtime—not
 * itself—whether verified completion is allowed.
 */
export const createOutcomeTool = (governor: IGovernor) => buildTool({
  name: 'OutcomeTool',
  description: `Manage the engine-owned outcome contract for substantial work. This is the source of truth for whether the user's requested result is actually complete.

# Required workflow for substantial tasks
1. **define** the exact objective and measurable acceptance criteria before implementation.
2. **set_tasks** with dependencies and owners when the work has multiple steps or parallel agents.
3. Keep tasks current with **update_task**.
4. Use **record_evidence** only to record a claim/source. Model-recorded evidence is untrusted and cannot open the gate; engine test/browser/runtime receipts do.
5. Use **integrate_task** for isolated delegated changes; it rejects scope drift and parent conflicts.
6. Record known gaps/blockers rather than hiding them.
7. Call **finish** with verified only after every required criterion has fresh evidence. The engine rejects dishonest completion.

# Actions
- define: objective + criteria
- set_tasks: replace dependency-aware task graph
- update_task: update one task state/owner
- retry_task: requeue a failed/blocked assignment with a new loop iteration, within its retry budget
- integrate_task: safely commit, merge, verify, and clean up an isolated delegated result
- confirm_integration: after merging an isolated result, engine-check parent files exactly match it
- validate_task: parent-validates a delegated completion using fresh trusted engine evidence
- record_evidence: attach a real check to criteria
- set_criterion: update criterion state with existing evidence ids
- set_gaps: replace known gap list
- set_blocker: record/clear a blocker and attempted solutions
- iterate: begin a new strategy iteration
- schedule: inspect the engine-computed critical path and safe parallel dispatch set
- status: inspect the completion gate
- finish: request verified/partial/blocked/failed terminal state`,
  isDestructive: false,
  isConcurrencySafe: true,
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['define', 'set_tasks', 'update_task', 'retry_task', 'integrate_task', 'confirm_integration', 'validate_task', 'record_evidence', 'set_criterion', 'set_gaps', 'set_blocker', 'iterate', 'schedule', 'status', 'finish'] },
      objective: { type: 'string' },
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, description: { type: 'string' }, required: { type: 'boolean' },
            files: { type: 'array', items: { type: 'string' }, description: 'Exact checked files; unscoped build criteria require repository-wide proof.' },
            verification: { type: 'string', enum: ['build_test', 'runtime', 'visual', 'research', 'user', 'other'] },
            requires_fresh_evidence: { type: 'boolean' },
          },
          required: ['description'],
        },
      },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, title: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'failed', 'completed', 'verified'] },
            required: { type: 'boolean' }, depends_on: { type: 'array', items: { type: 'string' } },
            owner: { type: 'string' }, criterion_ids: { type: 'array', items: { type: 'string' } },
            scope: { type: 'string' }, mutates: { type: 'boolean' },
            execution: { type: 'string', enum: ['local', 'agent', 'either'] },
            estimate_ms: { type: 'number' }, priority: { type: 'number' },
            isolation: { type: 'string', enum: ['worktree'] },
            max_attempts: { type: 'number' },
          },
          required: ['title'],
        },
      },
      task_id: { type: 'string' },
      task_status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'failed', 'completed', 'verified'] },
      owner: { type: 'string' },
      criterion_id: { type: 'string' },
      criterion_status: { type: 'string', enum: ['pending', 'passed', 'failed', 'blocked'] },
      evidence_ids: { type: 'array', items: { type: 'string' } },
      evidence_kind: { type: 'string', enum: ['test', 'runtime', 'screenshot', 'browser', 'diff', 'research', 'data', 'health', 'user', 'checkpoint', 'other'] },
      evidence_summary: { type: 'string' }, evidence_source: { type: 'string' }, evidence_ok: { type: 'boolean' },
      criterion_ids: { type: 'array', items: { type: 'string' } },
      gaps: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, description: { type: 'string' }, criterion_id: { type: 'string' }, resolved: { type: 'boolean' } },
          required: ['description'],
        },
      },
      blocker: { type: 'string' }, attempted: { type: 'array', items: { type: 'string' } }, requires_user: { type: 'boolean' },
      finish_status: { type: 'string', enum: ['verified', 'partially_verified', 'blocked', 'failed'] }, detail: { type: 'string' },
    },
    required: ['action'],
  },
  execute: async (args: OutcomeArgs) => {
    const manager = getOutcomeManager();
    switch (args.action) {
      case 'define':
        manager.define(args.objective || '', (args.criteria || []).map(c => ({
          id: c.id, description: c.description, required: c.required, verification: c.verification, files: c.files,
          requiresFreshEvidence: c.requires_fresh_evidence,
        })));
        return renderStatus(manager);
      case 'set_tasks':
        manager.setTasks((args.tasks || []).map(t => ({
          id: t.id, title: t.title, status: t.status, required: t.required, dependsOn: t.depends_on,
          owner: t.owner, criterionIds: t.criterion_ids,
          scope: t.scope, mutates: t.mutates, execution: t.execution, estimateMs: t.estimate_ms,
          priority: t.priority, isolation: t.isolation,
          maxAttempts: t.max_attempts,
        })));
        return renderStatus(manager);
      case 'update_task':
        if (!args.task_id || !args.task_status) return 'Error: task_id and task_status are required.';
        manager.updateTask(args.task_id, args.task_status, args.owner);
        return renderStatus(manager);
      case 'retry_task':
        if (!args.task_id) return 'Error: task_id is required.';
        manager.retryTask(args.task_id);
        return renderStatus(manager);
      case 'integrate_task':
        if (!args.task_id) return 'Error: task_id is required.';
        await governor.approveTaskExecution('OS_COMMAND', {
          command: `git merge isolated outcome task ${args.task_id}`,
          isDestructive: true,
        });
        manager.integrateTask(args.task_id);
        return renderStatus(manager);
      case 'confirm_integration':
        if (!args.task_id) return 'Error: task_id is required.';
        manager.confirmTaskIntegration(args.task_id);
        return renderStatus(manager);
      case 'validate_task':
        if (!args.task_id) return 'Error: task_id is required.';
        manager.validateTask(args.task_id, args.evidence_ids);
        return renderStatus(manager);
      case 'record_evidence':
        if (!args.evidence_kind || !args.evidence_summary || args.evidence_ok === undefined) {
          return 'Error: evidence_kind, evidence_summary, and evidence_ok are required.';
        }
        manager.addEvidence({
          kind: args.evidence_kind, summary: args.evidence_summary, source: args.evidence_source,
          ok: args.evidence_ok, criterionIds: args.criterion_ids,
        });
        return renderStatus(manager);
      case 'set_criterion':
        if (!args.criterion_id || !args.criterion_status) return 'Error: criterion_id and criterion_status are required.';
        manager.setCriterion(args.criterion_id, args.criterion_status, args.evidence_ids);
        return renderStatus(manager);
      case 'set_gaps':
        manager.setGaps((args.gaps || []).map(g => ({ id: g.id, description: g.description, criterionId: g.criterion_id, resolved: g.resolved })));
        return renderStatus(manager);
      case 'set_blocker':
        manager.setBlocker(args.blocker || '', args.attempted, args.requires_user);
        return renderStatus(manager);
      case 'iterate':
        manager.advanceIteration();
        return renderStatus(manager);
      case 'schedule': {
        const schedule = manager.schedule();
        if (!schedule) return 'No outcome contract is active.';
        return [
          `Critical path: ${schedule.criticalPath.join(' → ') || 'none'}`,
          `Ready: ${schedule.readyTasks} · Waiting: ${schedule.waitingTasks} · Active agents: ${schedule.activeAgents}`,
          `Safe parallel dispatch (${schedule.parallelTasks}/${schedule.maxParallel}): ${schedule.dispatchTaskIds.join(', ') || 'none'}`,
        ].join('\n');
      }
      case 'status':
        return renderStatus(manager);
      case 'finish': {
        if (!args.finish_status) return 'Error: finish_status is required.';
        const gate = manager.requestFinish(args.finish_status, args.detail);
        if (args.finish_status === 'verified' && !gate.allowed) {
          return `Completion rejected by the engine:\n- ${gate.reasons.join('\n- ')}\n\n${renderStatus(manager)}`;
        }
        return renderStatus(manager);
      }
      default:
        return 'Error: unsupported outcome action.';
    }
  },
}, governor);
