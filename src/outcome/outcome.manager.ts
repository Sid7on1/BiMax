import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { engineEvents } from '../engine/events';
import { getSessionRecorder } from '../engine/session.recorder';
import { sessionDir } from '../engine/session';
import {
  CompletionGate,
  CriterionStatus,
  EvidenceKind,
  OutcomeContract,
  OutcomeContinuation,
  OutcomeAssignmentReceipt,
  OutcomeCriterion,
  OutcomeEvidence,
  OutcomeGap,
  OutcomePhase,
  OutcomeTask,
  OutcomeTaskStatus,
  completionGate,
  createContract,
  slugId,
  toOutcomeSnapshot,
  validateTaskGraph,
} from './outcome.model';
import { computeAdaptiveSchedule } from './adaptive.scheduler';
import type { SubAgentResultEnvelope } from '../core/subagent.result';
import { inspectWorktreeChanges, integrateWorktree } from '../core/worktree.manager';
import { requiresBuildVerification } from '../review/verification.scope';

type CriterionInput = string | Partial<OutcomeCriterion>;
type TaskInput = Pick<OutcomeTask, 'title'> & Partial<Omit<OutcomeTask, 'title'>>;

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Per-session persistent outcome runtime. It binds the existing todo/review/checkpoint event seams
 * into one contract and publishes a compact full snapshot for every front-end.
 */
export class OutcomeManager {
  private contract: OutcomeContract | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private touchedThisTurn = false;

  constructor(private readonly io: {
    sessionId?: () => string;
    directory?: () => string;
    silent?: boolean;
  } = {}) {}

  private sessionId(): string {
    return this.io.sessionId?.() || getSessionRecorder()?.currentId() || '';
  }

  private directory(): string {
    return this.io.directory?.() || sessionDir();
  }

  private filePath(sessionId: string): string {
    return path.join(this.directory(), `${sessionId}.outcome.json`);
  }

  syncSession(): void {
    const sessionId = this.sessionId();
    if (!sessionId) {
      this.contract = null;
      this.publishNow();
      return;
    }
    if (this.contract?.sessionId === sessionId) return;
    this.saveNow();
    this.contract = this.load(sessionId);
    this.publishNow();
  }

  current(): OutcomeContract | null {
    return this.contract ? JSON.parse(JSON.stringify(this.contract)) : null;
  }

  snapshot() {
    if (!this.contract) return null;
    return { ...toOutcomeSnapshot(this.contract), schedule: computeAdaptiveSchedule(this.contract) };
  }

  schedule(maxParallel = 4) {
    return this.contract ? computeAdaptiveSchedule(this.contract, maxParallel) : null;
  }

  task(id: string): OutcomeTask | null {
    const task = this.contract?.tasks.find(item => item.id === id);
    return task ? JSON.parse(JSON.stringify(task)) : null;
  }

  activeSessionId(): string { return this.contract?.sessionId || ''; }

  /** Turn boundary: retain the durable contract but reset whether this user turn actively used it. */
  beginTurn(): void { this.touchedThisTurn = false; }

  wasTouchedThisTurn(): boolean { return this.touchedThisTurn; }

  /**
   * Persistence nudge for AgentLoop. Empty means it is honest to return control to the user. A
   * user-required blocker is terminal for this turn; everything else keeps converging.
   */
  continuationPrompt(): string {
    const contract = this.contract;
    if (!contract || !this.touchedThisTurn) return '';
    if (contract.phase === 'blocked' && contract.blocker?.requiresUser) return '';
    const gate = completionGate(contract);
    if (gate.allowed && contract.phase === 'verified') return '';
    if (gate.allowed) {
      return 'The outcome completion gate is now OPEN, but you stopped before recording the verified terminal state. Call OutcomeTool(action:"finish", finish_status:"verified"), then give the user the evidence-backed result.';
    }
    return [
      'You stopped, but the engine-owned outcome contract is still incomplete:',
      ...gate.reasons.slice(0, 8).map(reason => `- ${reason}`),
      'Continue with the highest-value action that closes these gaps. Change strategy if the previous approach stalled. Do not claim completion while the gate is closed; if a genuine external blocker requires the user, record it with OutcomeTool and explain it precisely.',
    ].join('\n');
  }

  /** Compact dynamic prompt block so the model cannot forget the contract after context compaction. */
  getPromptBlock(): string {
    const contract = this.contract;
    const snapshot = this.snapshot();
    if (!contract || !snapshot) return '';
    const criteria = contract.criteria.map(c =>
      `- [${c.status === 'passed' ? 'x' : c.status === 'failed' ? '!' : c.status === 'blocked' ? 'b' : ' '}] [${c.id}] ${c.description}`
    );
    const active = contract.tasks
      .filter(t => t.status !== 'verified' && !(t.status === 'completed' && !t.owner))
      .slice(0, 12)
      .map(t => `- [${t.status}] [${t.id}] ${t.title}${t.owner ? ` · owner ${t.owner}` : ''}${t.assignment?.integrationStatus === 'pending' ? ' · INTEGRATION PENDING' : ''}`);
    const schedule = computeAdaptiveSchedule(contract);
    const reports = contract.evidence.filter(e => e.provenance === 'subagent').slice(-4)
      .map(e => `- ${e.source || 'sub-agent'}: ${e.ok ? 'reported complete' : 'reported failure'} — ${e.summary.slice(0, 500)}`);
    return [
      `### ACTIVE OUTCOME CONTRACT — LOOP ${contract.iteration}`,
      `Objective: ${contract.objective}`,
      `Completion gate: ${snapshot.canComplete ? 'OPEN' : 'CLOSED'} · ${snapshot.passed}/${snapshot.required} required criteria passed · ${snapshot.openGaps} gap(s)`,
      ...criteria,
      ...(active.length ? ['Open tasks:', ...active] : []),
      `Scheduler: ${schedule.activeAgents} agent(s) active · ${schedule.parallelTasks} safe dispatch slot(s) · critical ${schedule.criticalTaskId || 'none'}`,
      ...(schedule.dispatchTaskIds.length ? [`Dispatch now: ${schedule.dispatchTaskIds.join(', ')}`] : []),
      ...(reports.length ? ['Recent sub-agent reports (UNTRUSTED until parent verification):', ...reports] : []),
      `Next: ${snapshot.nextAction}`,
      'Use OutcomeTool to keep this contract current. Do not claim verified completion while the gate is CLOSED.',
    ].join('\n');
  }

  define(objective: string, criteria: CriterionInput[]): OutcomeContract {
    const sessionId = this.sessionId() || this.contract?.sessionId || '';
    if (!sessionId) throw new Error('No active session yet — define the outcome after the user task begins.');
    if (!String(objective || '').trim()) throw new Error('Outcome objective is required.');
    if (!Array.isArray(criteria) || criteria.length === 0) throw new Error('At least one acceptance criterion is required.');
    this.contract = createContract(sessionId, objective, criteria);
    this.touch();
    return this.current()!;
  }

  setTasks(inputs: TaskInput[]): OutcomeTask[] {
    const contract = this.requireContract();
    const at = Date.now();
    const seen = new Set<string>();
    const tasks = (inputs || []).map((input, index): OutcomeTask => {
      let id = slugId(String(input.id || input.title), `task-${index + 1}`);
      for (let n = 2; seen.has(id); n++) id = `${slugId(id, 'task')}-${n}`;
      seen.add(id);
      return {
        id,
        title: String(input.title || '').trim(),
        status: input.status || 'pending',
        required: input.required !== false,
        dependsOn: Array.isArray(input.dependsOn) ? [...new Set(input.dependsOn.map(String))] : [],
        owner: input.owner ? String(input.owner) : undefined,
        criterionIds: Array.isArray(input.criterionIds) ? [...new Set(input.criterionIds.map(String))] : [],
        evidenceIds: Array.isArray(input.evidenceIds) ? [...new Set(input.evidenceIds.map(String))] : [],
        scope: input.scope ? String(input.scope) : undefined,
        mutates: input.mutates !== false,
        execution: input.execution || 'either',
        estimateMs: Math.max(1, Number(input.estimateMs) || 60_000),
        priority: Number(input.priority) || 0,
        isolation: input.isolation === 'worktree' ? 'worktree' : undefined,
        attempts: Math.max(0, Number(input.attempts) || 0),
        maxAttempts: Math.max(1, Number(input.maxAttempts) || 3),
        assignment: input.assignment,
        updatedAt: at,
      };
    }).filter(t => t.title);
    const errors = validateTaskGraph(tasks);
    if (errors.length) throw new Error(errors.join(' '));
    contract.tasks = tasks;
    contract.phase = tasks.length ? 'planning' : contract.phase;
    this.touch();
    return this.current()!.tasks;
  }

  updateTask(id: string, status: OutcomeTaskStatus, owner?: string): OutcomeTask {
    const contract = this.requireContract();
    const task = contract.tasks.find(t => t.id === id);
    if (!task) throw new Error(`Unknown outcome task: ${id}`);
    if (status === 'in_progress') {
      const incomplete = task.dependsOn.filter(dep => {
        const d = contract.tasks.find(t => t.id === dep);
        return !d || (d.status !== 'verified' && (d.status !== 'completed' || !!d.owner));
      });
      if (incomplete.length) throw new Error(`Task ${id} is waiting on: ${incomplete.join(', ')}`);
    }
    task.status = status;
    if (owner !== undefined) task.owner = owner || undefined;
    task.updatedAt = Date.now();
    if (status === 'in_progress') contract.phase = 'executing';
    if (status === 'blocked') contract.phase = 'blocked';
    if (status === 'failed') contract.phase = 'failed';
    this.touch();
    return { ...task, dependsOn: [...task.dependsOn], criterionIds: [...task.criterionIds] };
  }

  /** Claim one scheduler-approved task for a concrete worker. */
  assignTask(id: string, owner: string, maxParallel = 4): OutcomeTask {
    const task = this.task(id);
    if (!task) throw new Error(`Unknown outcome task: ${id}`);
    if (task.status !== 'pending') throw new Error(`Task ${id} is ${task.status}, not pending.`);
    if (task.execution === 'local') throw new Error(`Task ${id} is reserved for local execution.`);
    const schedule = this.schedule(maxParallel);
    if (!schedule?.dispatchTaskIds.includes(id)) {
      const waiting = task.dependsOn.filter(dep => {
        const item = this.contract?.tasks.find(candidate => candidate.id === dep);
        return !item || (item.status !== 'verified' && (item.status !== 'completed' || !!item.owner));
      });
      if (waiting.length) throw new Error(`Task ${id} is waiting on: ${waiting.join(', ')}`);
      throw new Error(`Task ${id} is not in the current safe dispatch set (${schedule?.dispatchTaskIds.join(', ') || 'empty'}).`);
    }
    const live = this.requireContract().tasks.find(item => item.id === id)!;
    if (live.attempts >= live.maxAttempts) throw new Error(`Task ${id} exhausted its ${live.maxAttempts} attempt(s).`);
    live.attempts++;
    delete live.recovery;
    const assigned = this.updateTask(id, 'in_progress', owner);
    this.saveNow();
    return assigned;
  }

  /** Rebind a checkpointed assignment without charging a second attempt for the same interrupted run. */
  assertAssignmentRecoverable(id: string, previousOwner: string, maxParallel = 4): void {
    const task = this.task(id);
    if (!task) throw new Error(`Unknown outcome task: ${id}`);
    if (task.status === 'pending') {
      if (task.execution === 'local') throw new Error(`Task ${id} is reserved for local execution.`);
      const schedule = this.schedule(maxParallel);
      if (!schedule?.dispatchTaskIds.includes(id)) {
        throw new Error(`Task ${id} is not in the current safe dispatch set (${schedule?.dispatchTaskIds.join(', ') || 'empty'}).`);
      }
      if (task.attempts >= task.maxAttempts) throw new Error(`Task ${id} exhausted its ${task.maxAttempts} attempt(s).`);
      return;
    }
    if (task.status !== 'in_progress') throw new Error(`Task ${id} is ${task.status}, not recoverable.`);
    if (task.owner !== previousOwner) throw new Error(`Task ${id} is owned by ${task.owner || 'nobody'}, not crashed worker ${previousOwner}.`);
  }

  /** Rebind a checkpointed assignment without charging a second attempt for the same interrupted run. */
  resumeAssignment(id: string, previousOwner: string, newOwner: string, maxParallel = 4): OutcomeTask {
    const contract = this.requireContract();
    const task = contract.tasks.find(item => item.id === id);
    this.assertAssignmentRecoverable(id, previousOwner, maxParallel);
    if (!task) throw new Error(`Unknown outcome task: ${id}`);
    if (task.status === 'pending') return this.assignTask(id, newOwner, maxParallel);
    task.owner = newOwner;
    task.updatedAt = Date.now();
    task.recovery = { state: 'resumed', previousOwner, resumedAt: task.updatedAt };
    contract.iteration++;
    contract.phase = 'executing';
    this.touch();
    this.saveNow();
    return { ...task, dependsOn: [...task.dependsOn], criterionIds: [...task.criterionIds], evidenceIds: [...task.evidenceIds] };
  }

  retryTask(id: string): OutcomeTask {
    const contract = this.requireContract();
    const task = contract.tasks.find(item => item.id === id);
    if (!task) throw new Error(`Unknown outcome task: ${id}`);
    if (task.status !== 'failed' && task.status !== 'blocked') throw new Error(`Task ${id} is ${task.status}, not retryable.`);
    if (task.attempts >= task.maxAttempts) throw new Error(`Task ${id} exhausted its ${task.maxAttempts} attempt(s); change the graph or record a genuine blocker.`);
    contract.iteration++;
    return this.updateTask(id, 'pending', '');
  }

  /** A worker report completes execution, never verification; parent evidence still gates outcome. */
  settleAssignment(id: string, owner: string, ok: boolean, report: string | SubAgentResultEnvelope): OutcomeTask {
    const task = this.task(id);
    if (!task) throw new Error(`Unknown outcome task: ${id}`);
    if (task.owner && task.owner !== owner) throw new Error(`Task ${id} is owned by ${task.owner}, not ${owner}.`);
    const summary = typeof report === 'string' ? report : report.report;
    this.addEvidence({
      kind: 'agent_report',
      summary: String(summary || (ok ? 'Sub-agent completed.' : 'Sub-agent failed.')).slice(0, 2000),
      source: owner,
      ok,
      criterionIds: [],
      provenance: 'subagent',
      trusted: false,
    });
    if (typeof report !== 'string') {
      const live = this.requireContract().tasks.find(item => item.id === id)!;
      live.assignment = {
        version: 1,
        agentTaskId: report.taskId,
        report: report.report,
        claimedScope: report.claimedScope,
        observedChangedFiles: [...report.observedChangedFiles],
        startedAt: report.startedAt,
        endedAt: report.endedAt,
        toolCalls: report.toolCalls,
        integrationStatus: report.isolation && report.observedChangedFiles.length ? 'pending' : 'not_required',
        ...(report.isolation ? { isolation: {
          kind: 'worktree' as const,
          repoRoot: report.isolation.repoRoot,
          path: report.isolation.path,
          branch: report.isolation.branch,
          baseCommit: report.isolation.baseCommit,
        } } : {}),
      };
    }
    const settled = this.updateTask(id, ok ? 'completed' : 'failed', owner);
    this.requestContinuation([id], 'assignment_settled');
    this.saveNow();
    return settled;
  }

  /** Persist and publish a parent-coordinator wake-up without trusting the worker report. */
  requestContinuation(
    taskIds: string[] = [],
    reason: OutcomeContinuation['reason'] = 'outcome_incomplete',
  ): OutcomeContinuation {
    const contract = this.requireContract();
    const previous = contract.continuation;
    const at = Date.now();
    contract.continuation = {
      state: 'pending',
      revision: (previous?.revision || 0) + 1,
      taskIds: [...new Set([...(previous?.state === 'pending' || previous?.state === 'running' ? previous.taskIds : []), ...taskIds])],
      reason,
      requestedAt: at,
      wakeups: previous?.wakeups || 0,
      consecutiveNoProgress: previous?.consecutiveNoProgress || 0,
      lastWakeAt: previous?.lastWakeAt,
      lastError: previous?.lastError,
    };
    this.touch();
    this.saveNow();
    if (!this.io.silent) {
      engineEvents.emit('outcome_continuation_requested', {
        sessionId: contract.sessionId,
        revision: contract.continuation.revision,
        taskIds: [...contract.continuation.taskIds],
        reason,
      });
    }
    return JSON.parse(JSON.stringify(contract.continuation));
  }

  continuation(): OutcomeContinuation | null {
    const value = this.contract?.continuation;
    return value ? JSON.parse(JSON.stringify(value)) : null;
  }

  /** Atomically lease one durable coordinator wake. A crashed running lease becomes reclaimable. */
  claimContinuation(maxWakeups = 24, leaseMs = 10 * 60_000, now = Date.now()): OutcomeContinuation | null {
    const contract = this.requireContract();
    const continuation = contract.continuation;
    if (!continuation || continuation.state === 'idle' || continuation.state === 'halted') return null;
    if (continuation.state === 'running' && now - (continuation.lastWakeAt || now) < leaseMs) return null;
    if (continuation.wakeups >= maxWakeups || continuation.consecutiveNoProgress >= 3) {
      continuation.state = 'halted';
      continuation.lastError ||= continuation.consecutiveNoProgress >= 3
        ? 'Coordinator made no measurable outcome progress in three consecutive wakes.'
        : `Coordinator reached its ${maxWakeups}-wake circuit breaker.`;
      this.touch();
      this.saveNow();
      return null;
    }
    continuation.state = 'running';
    continuation.claimedRevision = continuation.revision;
    continuation.wakeups++;
    continuation.lastWakeAt = now;
    delete continuation.lastError;
    this.touch();
    this.saveNow();
    return JSON.parse(JSON.stringify(continuation));
  }

  /** Finish a wake while preserving any newer result queued during the coordinator turn. */
  completeContinuation(claimedRevision: number, progress: boolean, error?: string): OutcomeContinuation | null {
    const contract = this.requireContract();
    const continuation = contract.continuation;
    if (!continuation) return null;
    continuation.consecutiveNoProgress = progress ? 0 : continuation.consecutiveNoProgress + 1;
    if (error) continuation.lastError = error.slice(0, 1000);
    if (continuation.revision > claimedRevision) continuation.state = 'pending';
    else continuation.state = continuation.consecutiveNoProgress >= 3 ? 'halted' : 'idle';
    continuation.claimedRevision = undefined;
    this.touch();
    this.saveNow();
    return JSON.parse(JSON.stringify(continuation));
  }

  /** Facts that change only when real outcome work progressed, excluding continuation bookkeeping. */
  progressFingerprint(): string {
    const contract = this.requireContract();
    return JSON.stringify({
      phase: contract.phase,
      iteration: contract.iteration,
      lastMutationAt: contract.lastMutationAt,
      criteria: contract.criteria.map(item => [item.id, item.status, item.updatedAt, item.evidenceIds]),
      tasks: contract.tasks.map(item => [item.id, item.status, item.owner, item.updatedAt, item.attempts, item.assignment?.integrationStatus]),
      evidence: contract.evidence.map(item => [item.id, item.ok, item.trusted, item.at]),
      gaps: contract.gaps.map(item => [item.id, item.resolved, item.updatedAt]),
      blocker: contract.blocker,
    });
  }

  /** Settle the assignment in the session that spawned it, even if the UI switched threads. */
  settleAssignmentForSession(sessionId: string, id: string, owner: string, ok: boolean, report: string | SubAgentResultEnvelope): OutcomeTask {
    if (!sessionId) throw new Error('Outcome session id is required for session-bound settlement.');
    if (this.contract?.sessionId === sessionId) return this.settleAssignment(id, owner, ok, report);
    const detached = new OutcomeManager({ sessionId: () => sessionId, directory: () => this.directory(), silent: true });
    detached.syncSession();
    try {
      const settled = detached.settleAssignment(id, owner, ok, report);
      detached.saveNow();
      return settled;
    } finally {
      detached.shutdown();
    }
  }

  /** Promote a delegated completion only after fresh, trusted parent-side verification exists. */
  validateTask(id: string, evidenceIds: string[] = []): OutcomeTask {
    const contract = this.requireContract();
    const task = contract.tasks.find(item => item.id === id);
    if (!task) throw new Error(`Unknown outcome task: ${id}`);
    if (!task.owner) throw new Error(`Task ${id} is local and does not require delegated-task validation.`);
    if (task.status !== 'completed') throw new Error(`Task ${id} must be completed before validation (currently ${task.status}).`);
    if (task.assignment?.integrationStatus === 'pending') throw new Error(`Task ${id} has isolated changes pending integration.`);
    if (task.assignment?.integrationStatus === 'conflict') throw new Error(`Task ${id} has an unresolved integration conflict.`);
    const requested = new Set(evidenceIds);
    const candidates = contract.evidence.filter(evidence => {
      if (!evidence.trusted || !evidence.ok || evidence.at < task.updatedAt) return false;
      if (requested.size && !requested.has(evidence.id)) return false;
      return task.criterionIds.length === 0 || evidence.criterionIds.some(id => task.criterionIds.includes(id));
    });
    if (!candidates.length) throw new Error(`Task ${id} has no fresh trusted parent verification.`);
    const requiredFiles = (task.assignment?.observedChangedFiles || []).filter(requiresBuildVerification);
    if (requiredFiles.length) {
      const repoWide = candidates.some(evidence => evidence.repoWide === true);
      const covered = new Set(candidates.flatMap(evidence => evidence.coveredFiles || []).map(file => file.replace(/\\/g, '/').replace(/^\.\//, '')));
      const missing = repoWide ? [] : requiredFiles.filter(file => {
        const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
        return ![...covered].some(candidate => candidate === normalized || candidate.endsWith(`/${normalized}`) || normalized.endsWith(`/${candidate}`));
      });
      if (missing.length) throw new Error(`Task ${id} has no fresh trusted verification covering: ${missing.join(', ')}`);
    }
    task.evidenceIds = [...new Set([...(task.evidenceIds || []), ...candidates.map(evidence => evidence.id)])];
    return this.updateTask(id, 'verified', task.owner);
  }

  /** Verify that reviewed isolated files now exactly match the parent checkout. Does not merge. */
  confirmTaskIntegration(id: string): OutcomeAssignmentReceipt {
    const contract = this.requireContract();
    const task = contract.tasks.find(item => item.id === id);
    if (!task) throw new Error(`Unknown outcome task: ${id}`);
    const receipt = task.assignment;
    if (!receipt) throw new Error(`Task ${id} has no structured assignment receipt.`);
    if (receipt.integrationStatus === 'not_required' || receipt.integrationStatus === 'integrated') return { ...receipt };
    if (!receipt.isolation) throw new Error(`Task ${id} has no isolated worktree receipt.`);

    const fail = (message: string): never => {
      receipt.integrationStatus = 'conflict';
      task.updatedAt = Date.now();
      this.touch();
      this.saveNow();
      throw new Error(message);
    };
    let currentManifest: string[];
    try {
      currentManifest = inspectWorktreeChanges({
        repoRoot: receipt.isolation.repoRoot,
        path: receipt.isolation.path,
        branch: receipt.isolation.branch,
        baseCommit: receipt.isolation.baseCommit,
      });
    } catch (error: any) {
      return fail(`Cannot reinspect task ${id}'s worktree: ${error?.message || error}`);
    }
    const expected = [...receipt.observedChangedFiles].sort();
    if (JSON.stringify(currentManifest) !== JSON.stringify(expected)) {
      return fail(`Task ${id}'s worktree changed after settlement; review it again before integration.`);
    }

    const mismatches = expected.filter(relative => {
      const parentFile = path.join(receipt.isolation!.repoRoot, relative);
      const workerFile = path.join(receipt.isolation!.path, relative);
      const parentExists = fs.existsSync(parentFile);
      const workerExists = fs.existsSync(workerFile);
      if (parentExists !== workerExists) return true;
      if (!parentExists) return false;
      try { return !fs.readFileSync(parentFile).equals(fs.readFileSync(workerFile)); }
      catch { return true; }
    });
    if (mismatches.length) return fail(`Task ${id} is not integrated in the parent checkout: ${mismatches.join(', ')}`);

    const at = Date.now();
    receipt.integrationStatus = 'integrated';
    receipt.integratedAt = at;
    task.updatedAt = at;
    contract.lastMutationAt = at;
    for (const criterion of contract.criteria) {
      if (criterion.requiresFreshEvidence && criterion.status === 'passed') {
        criterion.status = 'pending';
        criterion.updatedAt = at;
      }
    }
    contract.phase = 'executing';
    this.touch();
    this.saveNow();
    return JSON.parse(JSON.stringify(receipt));
  }

  /** Safely commit, merge, verify, and clean up an isolated delegated assignment. */
  integrateTask(id: string): OutcomeAssignmentReceipt {
    const contract = this.requireContract();
    const task = contract.tasks.find(item => item.id === id);
    if (!task) throw new Error(`Unknown outcome task: ${id}`);
    const receipt = task.assignment;
    if (!receipt?.isolation) throw new Error(`Task ${id} has no isolated worktree receipt.`);
    if (receipt.integrationStatus === 'integrated') return JSON.parse(JSON.stringify(receipt));
    if (receipt.integrationStatus === 'not_required') throw new Error(`Task ${id} does not require integration.`);

    try {
      const result = integrateWorktree(
        receipt.isolation,
        receipt.observedChangedFiles,
        task.scope || receipt.claimedScope,
        id,
      );
      receipt.integrationStatus = 'integrated';
      receipt.integratedAt = result.integratedAt;
      receipt.integrationCommit = result.commit;
      task.updatedAt = result.integratedAt;
      contract.lastMutationAt = result.integratedAt;
      for (const criterion of contract.criteria) {
        if (criterion.requiresFreshEvidence && criterion.status === 'passed') {
          criterion.status = 'pending';
          criterion.updatedAt = result.integratedAt;
        }
      }
      contract.phase = 'executing';
      for (const file of result.paths) engineEvents.emit('review_change', { tool: 'SubAgentIntegration', file });
      this.touch();
      this.saveNow();
      return JSON.parse(JSON.stringify(receipt));
    } catch (error) {
      receipt.integrationStatus = 'conflict';
      task.updatedAt = Date.now();
      this.touch();
      this.saveNow();
      throw error;
    }
  }

  addEvidence(input: {
    kind: EvidenceKind;
    summary: string;
    source?: string;
    ok: boolean;
    criterionIds?: string[];
    provenance?: OutcomeEvidence['provenance'];
    trusted?: boolean;
    coveredFiles?: string[];
    repoWide?: boolean;
  }): OutcomeEvidence {
    const contract = this.requireContract();
    const criterionIds = [...new Set((input.criterionIds || []).map(String))];
    const unknown = criterionIds.filter(id => !contract.criteria.some(c => c.id === id));
    if (unknown.length) throw new Error(`Unknown criteria: ${unknown.join(', ')}`);
    const evidence: OutcomeEvidence = {
      id: randomId('evidence'),
      kind: input.kind,
      summary: String(input.summary || '').trim(),
      source: input.source ? String(input.source) : undefined,
      ok: !!input.ok,
      provenance: input.provenance || 'model',
      trusted: input.trusted === true,
      criterionIds,
      ...(Array.isArray(input.coveredFiles) ? { coveredFiles: [...new Set(input.coveredFiles.map(String))].sort() } : {}),
      ...(input.repoWide !== undefined ? { repoWide: input.repoWide === true } : {}),
      at: Date.now(),
    };
    if (!evidence.summary) throw new Error('Evidence summary is required.');
    contract.evidence.push(evidence);
    if (contract.evidence.length > 200) contract.evidence.splice(0, contract.evidence.length - 200);
    for (const criterion of contract.criteria.filter(c => criterionIds.includes(c.id))) {
      if (!criterion.evidenceIds.includes(evidence.id)) criterion.evidenceIds.push(evidence.id);
      if (evidence.trusted) criterion.status = evidence.ok ? 'passed' : 'failed';
      criterion.updatedAt = evidence.at;
    }
    contract.phase = 'verifying';
    this.touch();
    return { ...evidence, criterionIds: [...evidence.criterionIds] };
  }

  setCriterion(id: string, status: CriterionStatus, evidenceIds: string[] = []): OutcomeCriterion {
    const contract = this.requireContract();
    const criterion = contract.criteria.find(c => c.id === id);
    if (!criterion) throw new Error(`Unknown acceptance criterion: ${id}`);
    const known = new Set(contract.evidence.map(e => e.id));
    const unknownEvidence = evidenceIds.filter(e => !known.has(e));
    if (unknownEvidence.length) throw new Error(`Unknown evidence: ${unknownEvidence.join(', ')}`);
    criterion.status = status;
    criterion.evidenceIds = [...new Set([...criterion.evidenceIds, ...evidenceIds])];
    criterion.updatedAt = Date.now();
    this.touch();
    return { ...criterion, evidenceIds: [...criterion.evidenceIds] };
  }

  setGaps(gaps: Array<Pick<OutcomeGap, 'description'> & Partial<OutcomeGap>>): OutcomeGap[] {
    const contract = this.requireContract();
    const at = Date.now();
    contract.gaps = (gaps || []).map((gap, index) => ({
      id: slugId(String(gap.id || gap.description), `gap-${index + 1}`),
      description: String(gap.description || '').trim(),
      criterionId: gap.criterionId ? String(gap.criterionId) : undefined,
      resolved: !!gap.resolved,
      updatedAt: at,
    })).filter(g => g.description);
    this.touch();
    return this.current()!.gaps;
  }

  setBlocker(description: string, attempted: string[] = [], requiresUser = false): void {
    const contract = this.requireContract();
    const text = String(description || '').trim();
    contract.blocker = text ? {
      description: text,
      attempted: (attempted || []).map(String).filter(Boolean).slice(0, 20),
      requiresUser: !!requiresUser,
      at: Date.now(),
    } : undefined;
    contract.phase = text ? 'blocked' : 'executing';
    this.touch();
  }

  advanceIteration(): number {
    const contract = this.requireContract();
    contract.iteration++;
    if (contract.phase === 'failed' || contract.phase === 'blocked') contract.phase = 'executing';
    contract.blocker = undefined;
    this.touch();
    return contract.iteration;
  }

  requestFinish(phase: 'verified' | 'partially_verified' | 'blocked' | 'failed', detail?: string): CompletionGate {
    const contract = this.requireContract();
    const gate = completionGate(contract);
    if (phase === 'verified' && !gate.allowed) {
      contract.phase = 'verifying';
      this.touch();
      return gate;
    }
    contract.phase = phase;
    if (phase === 'verified') contract.verifiedAt ||= Date.now();
    if (phase === 'blocked' && detail) this.setBlocker(detail, [], true);
    else this.touch();
    return gate;
  }

  /** Existing review truth: any mutation invalidates freshness-dependent passing criteria. */
  onMutation(): void {
    if (!this.contract) return;
    const at = Date.now();
    this.contract.lastMutationAt = at;
    for (const criterion of this.contract.criteria) {
      if (criterion.requiresFreshEvidence && criterion.status === 'passed') {
        criterion.status = 'pending';
        criterion.updatedAt = at;
      }
    }
    this.contract.phase = 'executing';
    this.touch();
  }

  /** Existing build/test evidence automatically covers criteria that explicitly request it. */
  onBuildEvidence(event: { command?: string; ok?: boolean; coveredFiles?: string[]; repoWide?: boolean }): void {
    if (!this.contract || !event?.command) return;
    const ids = this.contract.criteria.filter(c => c.verification === 'build_test').map(c => c.id);
    if (!ids.length) return;
    this.addEvidence({
      kind: 'test', summary: String(event.command), source: String(event.command), ok: !!event.ok,
      criterionIds: ids, provenance: 'engine', trusted: true,
      coveredFiles: event.coveredFiles, repoWide: event.repoWide,
    });
  }

  /** Native browser receipts automatically cover criteria that explicitly request visual proof. */
  onBrowserEvidence(event: { action?: string; ok?: boolean; trusted?: boolean; source?: string; summary?: string }): void {
    if (!this.contract || !event?.action) return;
    const ids = this.contract.criteria.filter(c => c.verification === 'visual' || c.verification === 'runtime').map(c => c.id);
    if (!ids.length) return;
    this.addEvidence({
      kind: event.action === 'screenshot' ? 'screenshot' : 'browser',
      summary: String(event.summary || `Browser ${event.action}`),
      source: event.source ? String(event.source) : 'BrowserTool',
      ok: !!event.ok,
      criterionIds: ids,
      provenance: 'engine',
      // A screenshot is a durable artifact, not a semantic comparison. Deterministic assertions
      // and exact visual-baseline comparisons may open the gate without user confirmation.
      trusted: event.trusted === true,
    });
  }

  /** Reuse the existing TodoWrite list as task state when an explicit dependency graph is absent. */
  onTodos(todos: unknown): void {
    if (!this.contract || this.contract.tasks.some(t => t.dependsOn.length > 0 || t.owner)) return;
    if (!Array.isArray(todos)) return;
    const at = Date.now();
    this.contract.tasks = todos.map((todo: any, index): OutcomeTask => ({
      id: slugId(String(todo?.content || ''), `task-${index + 1}`),
      title: String(todo?.content || '').trim(),
      status: todo?.status === 'completed' ? 'completed' : todo?.status === 'in_progress' ? 'in_progress' : 'pending',
      required: true,
      dependsOn: [],
      criterionIds: [],
      evidenceIds: [],
      mutates: true,
      execution: 'either',
      estimateMs: 60_000,
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      updatedAt: at,
    })).filter(t => t.title);
    if (this.contract.tasks.some(t => t.status === 'in_progress')) this.contract.phase = 'executing';
    this.touch();
  }

  saveNow(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.contract?.sessionId) return;
    let tmp = '';
    try {
      fs.mkdirSync(this.directory(), { recursive: true });
      const file = this.filePath(this.contract.sessionId);
      tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, JSON.stringify(this.contract, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch { /* persistence must never break a live turn */ }
    finally { if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ } } }
  }

  shutdown(): void { this.saveNow(); }

  private requireContract(): OutcomeContract {
    if (!this.contract) throw new Error('No outcome contract is active. Define one first.');
    return this.contract;
  }

  private touch(): void {
    if (!this.contract) return;
    this.touchedThisTurn = true;
    this.contract.updatedAt = Date.now();
    this.schedulePublish();
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 300);
      this.saveTimer.unref?.();
    }
  }

  private schedulePublish(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.publishNow();
    }, 50);
    this.emitTimer.unref?.();
  }

  private publishNow(): void {
    if (this.io.silent) return;
    engineEvents.emit('outcome_update', this.snapshot());
  }

  private load(sessionId: string): OutcomeContract | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath(sessionId), 'utf8'));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.criteria)) return null;
      return {
        ...parsed,
        version: 1,
        sessionId,
        objective: String(parsed.objective || ''),
        phase: parsed.phase as OutcomePhase,
        iteration: Math.max(1, Number(parsed.iteration) || 1),
        startedAt: Number(parsed.startedAt) || Date.now(),
        updatedAt: Number(parsed.updatedAt) || Date.now(),
        verifiedAt: Number(parsed.verifiedAt) || undefined,
        lastMutationAt: Number(parsed.lastMutationAt) || 0,
        criteria: parsed.criteria,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map((task: Partial<OutcomeTask>) => ({
          ...task,
          mutates: task.mutates !== false,
          execution: task.execution || 'either',
          estimateMs: Math.max(1, Number(task.estimateMs) || 60_000),
          priority: Number(task.priority) || 0,
          evidenceIds: Array.isArray(task.evidenceIds) ? task.evidenceIds : [],
          attempts: Math.max(0, Number(task.attempts) || 0),
          maxAttempts: Math.max(1, Number(task.maxAttempts) || 3),
          assignment: task.assignment,
          recovery: task.recovery,
        })) : [],
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map((evidence: Partial<OutcomeEvidence>) => ({
          ...evidence,
          provenance: evidence.provenance || 'model',
          trusted: evidence.trusted === true,
        })) : [],
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
        blocker: parsed.blocker,
        continuation: parsed.continuation && typeof parsed.continuation === 'object' ? {
          state: ['pending', 'running', 'idle', 'halted'].includes(parsed.continuation.state)
            ? parsed.continuation.state : 'pending',
          revision: Math.max(1, Number(parsed.continuation.revision) || 1),
          claimedRevision: Number(parsed.continuation.claimedRevision) || undefined,
          taskIds: Array.isArray(parsed.continuation.taskIds) ? parsed.continuation.taskIds.map(String) : [],
          reason: parsed.continuation.reason === 'assignment_settled' ? 'assignment_settled' : 'outcome_incomplete',
          requestedAt: Number(parsed.continuation.requestedAt) || Date.now(),
          wakeups: Math.max(0, Number(parsed.continuation.wakeups) || 0),
          consecutiveNoProgress: Math.max(0, Number(parsed.continuation.consecutiveNoProgress) || 0),
          lastWakeAt: Number(parsed.continuation.lastWakeAt) || undefined,
          lastError: parsed.continuation.lastError ? String(parsed.continuation.lastError) : undefined,
        } : undefined,
      };
    } catch { return null; }
  }
}

let manager: OutcomeManager | null = null;

export function startOutcomeManager(): OutcomeManager {
  if (manager) return manager;
  manager = new OutcomeManager();
  engineEvents.on('session_changed', () => manager?.syncSession());
  engineEvents.on('review_change', () => manager?.onMutation());
  engineEvents.on('review_evidence', (event: any) => manager?.onBuildEvidence(event));
  engineEvents.on('browser_evidence', (event: any) => manager?.onBrowserEvidence(event));
  engineEvents.on('todo_update', (todos: any) => manager?.onTodos(todos));
  engineEvents.on('shutdown', () => manager?.shutdown());
  manager.syncSession();
  return manager;
}

export function getOutcomeManager(): OutcomeManager {
  if (!manager) throw new Error('[OutcomeManager] not initialized — start the headless outcome runtime first.');
  return manager;
}

/** Test seam: do not use in production code. */
export function __setOutcomeManager(value: OutcomeManager | null): void { manager = value; }
