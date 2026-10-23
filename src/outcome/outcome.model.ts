/**
 * Outcome Contract domain model.
 *
 * This is the engine-owned source of truth for "is the user's requested outcome actually done?".
 * It deliberately stores facts (criteria, tasks, evidence, mutations, blockers) and derives the
 * completion gate from them. A model cannot make a contract verified by merely writing "done".
 */

export type OutcomePhase =
  | 'defining'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'blocked'
  | 'failed'
  | 'partially_verified'
  | 'verified';

export type CriterionStatus = 'pending' | 'passed' | 'failed' | 'blocked';
export type OutcomeTaskStatus = 'pending' | 'in_progress' | 'blocked' | 'failed' | 'completed' | 'verified';
export type EvidenceKind =
  | 'test'
  | 'runtime'
  | 'screenshot'
  | 'browser'
  | 'diff'
  | 'research'
  | 'data'
  | 'health'
  | 'user'
  | 'checkpoint'
  | 'agent_report'
  | 'other';

export interface OutcomeCriterion {
  id: string;
  description: string;
  required: boolean;
  status: CriterionStatus;
  /** Optional verifier class used to connect existing engine evidence automatically. */
  /** Exact files whose checks may automatically satisfy this criterion. Unscoped criteria need repo-wide proof. */
  files?: string[];
  verification?: 'build_test' | 'runtime' | 'visual' | 'research' | 'user' | 'other';
  /** True by default: a later mutation makes prior passing evidence stale. */
  requiresFreshEvidence: boolean;
  evidenceIds: string[];
  updatedAt: number;
}

export interface OutcomeTask {
  id: string;
  title: string;
  status: OutcomeTaskStatus;
  required: boolean;
  dependsOn: string[];
  owner?: string;
  criterionIds: string[];
  /** Trusted parent-side receipts used to validate a delegated assignment. */
  evidenceIds: string[];
  /** Claimed files/directories/topic. Used to prevent unsafe parallel edits. */
  scope?: string;
  /** Whether this assignment can change repository state. Defaults to true for agent work. */
  mutates: boolean;
  /** Preferred executor. `either` lets the coordinator choose the fastest safe path. */
  execution: 'local' | 'agent' | 'either';
  /** Relative duration estimate used to find the critical path. */
  estimateMs: number;
  /** Higher values win when two ready tasks have equal critical-path cost. */
  priority: number;
  /** Independent worktree permits overlapping edit scopes without clobbering the main tree. */
  isolation?: 'worktree';
  attempts: number;
  maxAttempts: number;
  /** Engine-authored receipt for delegated execution and its integration state. */
  assignment?: OutcomeAssignmentReceipt;
  /** Durable audit trail when a crashed worker was rebound to this task. */
  recovery?: {
    state: 'resumed';
    previousOwner: string;
    resumedAt: number;
  };
  updatedAt: number;
}

export interface OutcomeAssignmentReceipt {
  version: 1;
  agentTaskId: string;
  report: string;
  claimedScope: string;
  observedChangedFiles: string[];
  startedAt: number;
  endedAt: number;
  toolCalls: number;
  integrationStatus: 'not_required' | 'pending' | 'integrated' | 'conflict';
  integratedAt?: number;
  integrationCommit?: string;
  isolation?: {
    kind: 'worktree';
    repoRoot: string;
    path: string;
    branch: string;
    baseCommit: string;
  };
}

export interface OutcomeEvidence {
  id: string;
  kind: EvidenceKind;
  summary: string;
  source?: string;
  ok: boolean;
  provenance: 'engine' | 'user' | 'subagent' | 'model';
  /** Only engine receipts or explicit user confirmation may satisfy an acceptance criterion. */
  trusted: boolean;
  criterionIds: string[];
  /** Exact changed-file claims covered by this verification receipt. */
  coveredFiles?: string[];
  /** Successful repository-wide verification rather than a path-scoped check. */
  repoWide?: boolean;
  at: number;
}

export interface OutcomeGap {
  id: string;
  description: string;
  criterionId?: string;
  resolved: boolean;
  updatedAt: number;
}

export interface OutcomeBlocker {
  description: string;
  attempted: string[];
  requiresUser: boolean;
  at: number;
}

export interface OutcomeContinuation {
  state: 'pending' | 'running' | 'idle' | 'halted';
  /** Monotonic generation. New background results arriving during a wake cannot be lost. */
  revision: number;
  claimedRevision?: number;
  taskIds: string[];
  reason: 'assignment_settled' | 'outcome_incomplete';
  requestedAt: number;
  wakeups: number;
  consecutiveNoProgress: number;
  lastWakeAt?: number;
  lastError?: string;
}

export interface OutcomeContract {
  version: 1;
  sessionId: string;
  objective: string;
  phase: OutcomePhase;
  iteration: number;
  startedAt: number;
  updatedAt: number;
  /** Frozen when the engine-owned completion gate enters the verified terminal state. */
  verifiedAt?: number;
  lastMutationAt: number;
  criteria: OutcomeCriterion[];
  tasks: OutcomeTask[];
  evidence: OutcomeEvidence[];
  gaps: OutcomeGap[];
  blocker?: OutcomeBlocker;
  /** Durable parent-coordinator wake-up state for unattended graph convergence. */
  continuation?: OutcomeContinuation;
}

export interface CompletionGate {
  allowed: boolean;
  passed: number;
  required: number;
  openTasks: number;
  openGaps: number;
  reasons: string[];
}

export interface OutcomeSnapshot {
  sessionId: string;
  objective: string;
  phase: OutcomePhase;
  iteration: number;
  elapsedMs: number;
  /** Stable time-to-verified-outcome once complete; undefined while convergence is active. */
  timeToVerifiedMs?: number;
  passed: number;
  required: number;
  openTasks: number;
  activeTasks: number;
  recoveringTasks: number;
  continuationState?: OutcomeContinuation['state'];
  continuationWakeups: number;
  openGaps: number;
  canComplete: boolean;
  nextAction: string;
  blocker?: OutcomeBlocker;
  schedule: OutcomeScheduleSnapshot;
  updatedAt: number;
}

export interface OutcomeScheduleSnapshot {
  maxParallel: number;
  activeAgents: number;
  readyTasks: number;
  waitingTasks: number;
  blockedTasks: number;
  parallelTasks: number;
  criticalTaskId?: string;
  criticalTaskTitle?: string;
  criticalPath: string[];
  dispatchTaskIds: string[];
  /** Remaining-work estimates used to quantify whether parallelism is actually buying time. */
  estimatedSequentialMs: number;
  estimatedCriticalPathMs: number;
  estimatedParallelSavingsMs: number;
}

export function slugId(value: string, fallback: string): string {
  const id = String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return id || fallback;
}

export function createContract(
  sessionId: string,
  objective: string,
  criteria: Array<string | Partial<OutcomeCriterion>>,
  at = Date.now(),
): OutcomeContract {
  const seen = new Set<string>();
  const normalized = criteria.map((raw, index): OutcomeCriterion => {
    const data = typeof raw === 'string' ? { description: raw } : raw;
    const description = String(data.description || '').trim();
    let id = slugId(String(data.id || description), `criterion-${index + 1}`);
    for (let n = 2; seen.has(id); n++) id = `${slugId(id, 'criterion')}-${n}`;
    seen.add(id);
    return {
      id,
      description,
      required: data.required !== false,
      status: data.status || 'pending',
      verification: data.verification,
      files: Array.isArray(data.files) ? [...new Set(data.files.map(String))] : undefined,
      requiresFreshEvidence: data.requiresFreshEvidence !== false,
      evidenceIds: Array.isArray(data.evidenceIds) ? [...new Set(data.evidenceIds.map(String))] : [],
      updatedAt: Number(data.updatedAt) || at,
    };
  }).filter(c => c.description);

  return {
    version: 1,
    sessionId,
    objective: String(objective || '').trim(),
    phase: normalized.length ? 'planning' : 'defining',
    iteration: 1,
    startedAt: at,
    updatedAt: at,
    lastMutationAt: 0,
    criteria: normalized,
    tasks: [],
    evidence: [],
    gaps: [],
  };
}

/** Validate task dependencies before the scheduler accepts a graph. */
export function validateTaskGraph(tasks: OutcomeTask[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.id) errors.push('Every task needs an id.');
    else if (ids.has(task.id)) errors.push(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) errors.push(`Task ${task.id} depends on missing task ${dep}.`);
      if (dep === task.id) errors.push(`Task ${task.id} cannot depend on itself.`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map(t => [t.id, t]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn || []) {
      if (byId.has(dep) && visit(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of ids) {
    if (visit(id)) { errors.push(`Task graph contains a dependency cycle involving ${id}.`); break; }
  }
  return [...new Set(errors)];
}

function passingEvidence(contract: OutcomeContract, criterion: OutcomeCriterion): OutcomeEvidence[] {
  const ids = new Set(criterion.evidenceIds);
  return contract.evidence.filter(e => e.trusted && ids.has(e.id) && e.ok && e.criterionIds.includes(criterion.id));
}

/**
 * The engine-owned completion decision. Required criteria need green, attributed evidence; required
 * tasks must be terminal; unresolved gaps and blockers prevent a verified outcome.
 */
export function completionGate(contract: OutcomeContract): CompletionGate {
  const requiredCriteria = contract.criteria.filter(c => c.required);
  const reasons: string[] = [];
  let passed = 0;

  if (!contract.objective.trim()) reasons.push('Outcome objective is missing.');
  if (requiredCriteria.length === 0) reasons.push('No required acceptance criteria are defined.');

  for (const criterion of requiredCriteria) {
    if (criterion.status !== 'passed') {
      reasons.push(`Criterion not passed: ${criterion.description}`);
      continue;
    }
    const evidence = passingEvidence(contract, criterion);
    if (evidence.length === 0) {
      reasons.push(`Criterion has no passing evidence: ${criterion.description}`);
      continue;
    }
    if (criterion.requiresFreshEvidence && contract.lastMutationAt > 0 && !evidence.some(e => e.at >= contract.lastMutationAt)) {
      reasons.push(`Criterion evidence is stale after the latest change: ${criterion.description}`);
      continue;
    }
    passed++;
  }

  const openTasks = contract.tasks.filter(t => {
    if (!t.required) return false;
    // A delegated task's worker may only report execution complete. The parent must validate it.
    if (t.owner) return t.status !== 'verified';
    return t.status !== 'completed' && t.status !== 'verified';
  }).length;
  if (openTasks > 0) reasons.push(`${openTasks} required task${openTasks === 1 ? '' : 's'} remain open.`);
  const openGaps = contract.gaps.filter(g => !g.resolved).length;
  if (openGaps > 0) reasons.push(`${openGaps} known gap${openGaps === 1 ? '' : 's'} remain unresolved.`);
  if (contract.blocker) reasons.push(`Outcome is blocked: ${contract.blocker.description}`);

  return {
    allowed: reasons.length === 0,
    passed,
    required: requiredCriteria.length,
    openTasks,
    openGaps,
    reasons,
  };
}

export function toOutcomeSnapshot(contract: OutcomeContract, now = Date.now()): OutcomeSnapshot {
  const gate = completionGate(contract);
  const activeTasks = contract.tasks.filter(t => t.status === 'in_progress').length;
  const recoveringTasks = contract.tasks.filter(t => t.status === 'in_progress' && t.recovery?.state === 'resumed').length;
  let nextAction = gate.allowed
    ? 'All required criteria have fresh evidence — outcome may be marked verified.'
    : gate.reasons[0] || 'Continue working toward the requested outcome.';
  if (contract.phase === 'verified' && gate.allowed) nextAction = 'Outcome verified.';
  return {
    sessionId: contract.sessionId,
    objective: contract.objective,
    phase: contract.phase,
    iteration: contract.iteration,
    elapsedMs: Math.max(0, now - contract.startedAt),
    timeToVerifiedMs: contract.verifiedAt ? Math.max(0, contract.verifiedAt - contract.startedAt) : undefined,
    passed: gate.passed,
    required: gate.required,
    openTasks: gate.openTasks,
    activeTasks,
    recoveringTasks,
    continuationState: contract.continuation?.state,
    continuationWakeups: contract.continuation?.wakeups || 0,
    openGaps: gate.openGaps,
    canComplete: gate.allowed,
    nextAction,
    blocker: contract.blocker,
    schedule: {
      maxParallel: 1,
      activeAgents: activeTasks,
      readyTasks: 0,
      waitingTasks: 0,
      blockedTasks: 0,
      parallelTasks: 0,
      criticalPath: [],
      dispatchTaskIds: [],
      estimatedSequentialMs: 0,
      estimatedCriticalPathMs: 0,
      estimatedParallelSavingsMs: 0,
    },
    updatedAt: contract.updatedAt,
  };
}
