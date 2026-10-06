import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OutcomeManager } from '../outcome/outcome.manager';
import { computeAdaptiveSchedule } from '../outcome/adaptive.scheduler';
import {
  OutcomeEvidence,
  completionGate,
  createContract,
  toOutcomeSnapshot,
  validateTaskGraph,
} from '../outcome/outcome.model';

describe('Outcome Contract completion gate', () => {
  it('rejects model-only completion without attributed evidence', () => {
    const contract = createContract('s1', 'Ship the repaired CLI', [{
      id: 'tests', description: 'All tests pass', status: 'passed', verification: 'build_test',
    }], 100);
    expect(completionGate(contract)).toMatchObject({ allowed: false, passed: 0, required: 1 });
    expect(completionGate(contract).reasons.join(' ')).toMatch(/no passing evidence/i);
  });

  it('opens only after required tasks, gaps, and fresh criterion evidence are complete', () => {
    const contract = createContract('s1', 'Ship the repaired CLI', [{
      id: 'tests', description: 'All tests pass', verification: 'build_test',
    }], 100);
    contract.tasks = [{
      id: 'implement', title: 'Implement repair', status: 'completed', required: true,
      dependsOn: [], criterionIds: ['tests'], evidenceIds: [], mutates: true,
      execution: 'either', estimateMs: 60_000, priority: 0, attempts: 0, maxAttempts: 3, updatedAt: 120,
    }];
    contract.lastMutationAt = 150;
    const evidence: OutcomeEvidence = {
      id: 'ev1', kind: 'test', summary: 'npm test', source: 'npm test', ok: true,
      provenance: 'engine', trusted: true, criterionIds: ['tests'], at: 160,
    };
    contract.evidence.push(evidence);
    contract.criteria[0].status = 'passed';
    contract.criteria[0].evidenceIds.push('ev1');
    expect(completionGate(contract)).toEqual({
      allowed: true, passed: 1, required: 1, openTasks: 0, openGaps: 0, reasons: [],
    });
    expect(toOutcomeSnapshot(contract, 200)).toMatchObject({ canComplete: true, passed: 1, required: 1 });

    contract.lastMutationAt = 170;
    expect(completionGate(contract).reasons.join(' ')).toMatch(/stale/i);
  });

  it('rejects missing dependencies and cycles before scheduling', () => {
    const base = (id: string, dependsOn: string[]) => ({
      id, title: id, status: 'pending' as const, required: true, dependsOn, criterionIds: [], evidenceIds: [],
      mutates: true, execution: 'either' as const, estimateMs: 60_000, priority: 0,
      attempts: 0, maxAttempts: 3, updatedAt: 1,
    });
    expect(validateTaskGraph([base('a', ['missing'])]).join(' ')).toMatch(/missing task/i);
    expect(validateTaskGraph([base('a', ['b']), base('b', ['a'])]).join(' ')).toMatch(/cycle/i);
  });

  it('quantifies parallel savings and freezes time to verified outcome', () => {
    const contract = createContract('s-perf', 'Ship faster', ['Works'], 100);
    contract.tasks = [
      { id: 'a', title: 'A', status: 'pending', required: true, dependsOn: [], criterionIds: [], evidenceIds: [], mutates: false, execution: 'agent', estimateMs: 100, priority: 0, attempts: 0, maxAttempts: 3, updatedAt: 100 },
      { id: 'b', title: 'B', status: 'pending', required: true, dependsOn: [], criterionIds: [], evidenceIds: [], mutates: false, execution: 'agent', estimateMs: 80, priority: 0, attempts: 0, maxAttempts: 3, updatedAt: 100 },
    ];
    expect(computeAdaptiveSchedule(contract, 4)).toMatchObject({
      estimatedSequentialMs: 180, estimatedCriticalPathMs: 100, estimatedParallelSavingsMs: 80,
    });
    contract.verifiedAt = 260;
    expect(toOutcomeSnapshot(contract, 999).timeToVerifiedMs).toBe(160);
  });
});

describe('OutcomeManager persistence and review integration', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-outcome-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('invalidates passing evidence after a later mutation and persists the contract', () => {
    const io = { sessionId: () => 'session-1', directory: () => dir };
    const manager = new OutcomeManager(io);
    manager.syncSession();
    manager.define('Implement outcome runtime', [{
      id: 'tests', description: 'Tests pass', verification: 'build_test',
    }]);
    manager.setTasks([{ id: 'implementation', title: 'Implement runtime', status: 'completed' }]);
    manager.onBuildEvidence({ command: 'npm test', ok: true, repoWide: true });
    expect(manager.snapshot()).toMatchObject({ canComplete: true, passed: 1, required: 1 });

    manager.onMutation();
    expect(manager.snapshot()).toMatchObject({ canComplete: false, passed: 0, phase: 'executing' });
    expect(manager.current()?.criteria[0].status).toBe('pending');

    manager.saveNow();
    const restored = new OutcomeManager(io);
    restored.syncSession();
    expect(restored.current()).toMatchObject({ objective: 'Implement outcome runtime', lastMutationAt: expect.any(Number) });
    expect(restored.snapshot()?.canComplete).toBe(false);
    manager.shutdown();
    restored.shutdown();
  });

  it('enforces task dependencies and refuses a dishonest verified finish', () => {
    const manager = new OutcomeManager({ sessionId: () => 'session-2', directory: () => dir });
    manager.syncSession();
    manager.define('Coordinate work', [{ id: 'done', description: 'Integrated result works' }]);
    manager.setTasks([
      { id: 'research', title: 'Research', status: 'pending' },
      { id: 'build', title: 'Build', status: 'pending', dependsOn: ['research'] },
    ]);
    expect(() => manager.updateTask('build', 'in_progress')).toThrow(/waiting on: research/);
    const gate = manager.requestFinish('verified');
    expect(gate.allowed).toBe(false);
    expect(manager.snapshot()?.phase).toBe('verifying');
    expect(manager.continuationPrompt()).toMatch(/outcome contract is still incomplete/i);

    manager.setBlocker('Need the user API credential', ['Checked environment and key store'], true);
    expect(manager.continuationPrompt()).toBe('');
    manager.shutdown();
  });

  it('rebinds a crashed assignment without charging a second attempt', () => {
    const manager = new OutcomeManager({ sessionId: () => 'recovery-session', directory: () => dir });
    manager.syncSession();
    manager.define('Recover coordinated work', [{ id: 'done', description: 'Work is verified' }]);
    manager.setTasks([{ id: 'build', title: 'Build safely', execution: 'agent', mutates: false }]);
    manager.assignTask('build', 'dead-worker');
    expect(manager.task('build')).toMatchObject({ attempts: 1, owner: 'dead-worker', status: 'in_progress' });

    manager.resumeAssignment('build', 'dead-worker', 'replacement-worker');
    expect(manager.task('build')).toMatchObject({
      attempts: 1, owner: 'replacement-worker', status: 'in_progress',
      recovery: { state: 'resumed', previousOwner: 'dead-worker', resumedAt: expect.any(Number) },
    });
    expect(manager.snapshot()?.recoveringTasks).toBe(1);
    manager.shutdown();
  });

  it('validates the crashed owner before changing a recovery assignment', () => {
    const manager = new OutcomeManager({ sessionId: () => 'recovery-validation', directory: () => dir });
    manager.syncSession();
    manager.define('Preserve invalid recovery state', [{ id: 'done', description: 'Work is verified' }]);
    manager.setTasks([{ id: 'build', title: 'Build safely', execution: 'agent', mutates: false }]);
    manager.assignTask('build', 'live-owner');

    expect(() => manager.assertAssignmentRecoverable('build', 'stale-owner')).toThrow(/owned by live-owner/);
    expect(manager.task('build')).toMatchObject({ attempts: 1, owner: 'live-owner', status: 'in_progress' });
    manager.shutdown();
  });

  it('durably leases coordinator wakes without losing results that arrive mid-turn', () => {
    const manager = new OutcomeManager({ sessionId: () => 'continuation-session', directory: () => dir });
    manager.syncSession();
    manager.define('Continue the dependency graph', [{ id: 'done', description: 'Work is verified' }]);
    manager.setTasks([
      { id: 'research', title: 'Research', execution: 'agent', mutates: false },
      { id: 'build', title: 'Build', execution: 'agent', mutates: false, dependsOn: ['research'] },
    ]);
    manager.assignTask('research', 'worker-1');
    manager.settleAssignment('research', 'worker-1', true, 'research complete');
    expect(manager.continuation()).toMatchObject({
      state: 'pending', revision: 1, taskIds: ['research'], reason: 'assignment_settled', wakeups: 0,
    });

    const beforeLease = manager.progressFingerprint();
    const first = manager.claimContinuation(4, 30_000, 1000)!;
    expect(first).toMatchObject({ state: 'running', claimedRevision: 1, wakeups: 1 });
    expect(manager.progressFingerprint()).toBe(beforeLease);

    manager.requestContinuation(['build'], 'assignment_settled');
    manager.completeContinuation(first.claimedRevision!, true);
    expect(manager.continuation()).toMatchObject({
      state: 'pending', revision: 2, taskIds: ['research', 'build'], consecutiveNoProgress: 0,
    });
    manager.shutdown();

    const restored = new OutcomeManager({ sessionId: () => 'continuation-session', directory: () => dir });
    restored.syncSession();
    expect(restored.continuation()).toMatchObject({ state: 'pending', revision: 2, wakeups: 1 });
    restored.shutdown();
  });

  it('halts autonomous convergence after three coordinator wakes without measurable progress', () => {
    const manager = new OutcomeManager({ sessionId: () => 'continuation-halt', directory: () => dir });
    manager.syncSession();
    manager.define('Avoid an endless loop', [{ id: 'done', description: 'Work is verified' }]);
    manager.requestContinuation([], 'outcome_incomplete');

    for (let attempt = 1; attempt <= 3; attempt++) {
      const claim = manager.claimContinuation(24, 0, attempt)!;
      manager.completeContinuation(claim.claimedRevision!, false, 'no measurable progress');
      if (attempt < 3) manager.requestContinuation([], 'outcome_incomplete');
    }
    expect(manager.continuation()).toMatchObject({
      state: 'halted', wakeups: 3, consecutiveNoProgress: 3,
      lastError: 'no measurable progress',
    });
    expect(manager.claimContinuation()).toBeNull();
    manager.shutdown();
  });

  it('settles a late agent result into its original session after the UI switches threads', () => {
    let sessionId = 'original-session';
    const manager = new OutcomeManager({ sessionId: () => sessionId, directory: () => dir });
    manager.syncSession();
    manager.define('Original outcome', [{ id: 'done', description: 'Original task completes' }]);
    manager.setTasks([{ id: 'research', title: 'Research', execution: 'agent', mutates: false }]);
    manager.assignTask('research', 'worker-1');

    sessionId = 'other-session';
    manager.syncSession();
    manager.define('Other outcome', [{ id: 'other', description: 'Other task' }]);
    manager.settleAssignmentForSession('original-session', 'research', 'worker-1', true, 'finished late');

    const original = new OutcomeManager({ sessionId: () => 'original-session', directory: () => dir, silent: true });
    original.syncSession();
    expect(original.task('research')).toMatchObject({ status: 'completed', owner: 'worker-1' });
    expect(original.current()?.evidence.at(-1)).toMatchObject({ provenance: 'subagent', trusted: false });
    expect(manager.current()?.objective).toBe('Other outcome');
    original.shutdown();
    manager.shutdown();
  });
});
