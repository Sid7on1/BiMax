import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeAdaptiveSchedule } from '../outcome/adaptive.scheduler';
import { OutcomeManager } from '../outcome/outcome.manager';
import { OutcomeTask, createContract } from '../outcome/outcome.model';

const task = (id: string, input: Partial<OutcomeTask> = {}): OutcomeTask => ({
  id, title: id, status: 'pending', required: true, dependsOn: [], owner: undefined,
  criterionIds: [], evidenceIds: [], scope: id, mutates: true, execution: 'agent',
  estimateMs: 1, priority: 0, updatedAt: 1, ...input,
  attempts: input.attempts ?? 0, maxAttempts: input.maxAttempts ?? 3,
});

describe('adaptive outcome scheduler', () => {
  it('prioritizes the longest remaining path and dispatches disjoint ready work', () => {
    const contract = createContract('s', 'Ship', ['works']);
    contract.tasks = [
      task('api', { scope: 'src/api', estimateMs: 8 }),
      task('ui', { scope: 'src/ui', estimateMs: 3 }),
      task('integration', { dependsOn: ['api', 'ui'], scope: 'tests', estimateMs: 5 }),
    ];
    const schedule = computeAdaptiveSchedule(contract, 4);
    expect(schedule.criticalPath).toEqual(['api', 'integration']);
    expect(schedule.dispatchTaskIds).toEqual(['api', 'ui']);
    expect(schedule).toMatchObject({ readyTasks: 2, waitingTasks: 1, parallelTasks: 2 });
  });

  it('blocks overlapping writable work but permits read-only and worktree-isolated assignments', () => {
    const contract = createContract('s', 'Ship', ['works']);
    contract.tasks = [
      task('active', { status: 'in_progress', owner: 'agent-1', scope: 'src/core' }),
      task('overlap', { scope: 'src/core/auth' }),
      task('read', { scope: 'src/core', mutates: false }),
      task('isolated', { scope: 'src/core', isolation: 'worktree' }),
    ];
    const schedule = computeAdaptiveSchedule(contract, 4);
    expect(schedule.dispatchTaskIds).toEqual(expect.arrayContaining(['read', 'isolated']));
    expect(schedule.dispatchTaskIds).not.toContain('overlap');
    expect(schedule.activeAgents).toBe(1);
  });

  it('distinguishes dependency failure from ordinary waiting', () => {
    const contract = createContract('s', 'Ship', ['works']);
    contract.tasks = [
      task('failed', { status: 'failed' }),
      task('blocked-child', { dependsOn: ['failed'] }),
      task('running-dependency', { status: 'in_progress' }),
      task('waiting-child', { dependsOn: ['running-dependency'] }),
    ];
    expect(computeAdaptiveSchedule(contract)).toMatchObject({ blockedTasks: 1, waitingTasks: 1 });
  });

  it('does not release dependents from a delegated task until parent validation', () => {
    const contract = createContract('s', 'Ship', ['works']);
    contract.tasks = [
      task('delegated', { status: 'completed', owner: 'agent-1' }),
      task('integration', { dependsOn: ['delegated'] }),
    ];
    expect(computeAdaptiveSchedule(contract)).toMatchObject({ readyTasks: 0, waitingTasks: 1, criticalTaskId: 'delegated' });
    contract.tasks[0].status = 'verified';
    expect(computeAdaptiveSchedule(contract).dispatchTaskIds).toEqual(['integration']);
  });
});

describe('delegated assignment validation', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-scheduler-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('keeps a worker-completed task open until fresh trusted parent evidence validates it', () => {
    const manager = new OutcomeManager({ sessionId: () => 's', directory: () => dir });
    manager.syncSession();
    manager.define('Ship verified work', [{ id: 'tests', description: 'Tests pass', verification: 'build_test' }]);
    manager.setTasks([{
      id: 'build', title: 'Build', scope: 'src', execution: 'agent', criterionIds: ['tests'],
    }]);
    manager.assignTask('build', 'agent-1');
    manager.settleAssignment('build', 'agent-1', true, 'I changed the implementation and tests pass.');
    expect(manager.snapshot()).toMatchObject({ canComplete: false, openTasks: 1 });
    expect(() => manager.validateTask('build')).toThrow(/no fresh trusted parent verification/i);

    manager.onBuildEvidence({ command: 'npm test', ok: true, repoWide: true });
    manager.validateTask('build');
    expect(manager.task('build')).toMatchObject({ status: 'verified', owner: 'agent-1' });
    expect(manager.snapshot()).toMatchObject({ canComplete: true, openTasks: 0 });
    manager.shutdown();
  });

  it('requeues failed work with a bounded retry budget and a new loop iteration', () => {
    const manager = new OutcomeManager({ sessionId: () => 'retry', directory: () => dir });
    manager.syncSession();
    manager.define('Retry safely', [{ id: 'done', description: 'Result works' }]);
    manager.setTasks([{ id: 'work', title: 'Work', scope: 'src', execution: 'agent', maxAttempts: 2 }]);
    manager.assignTask('work', 'agent-1');
    manager.settleAssignment('work', 'agent-1', false, 'first strategy failed');
    manager.retryTask('work');
    expect(manager.task('work')).toMatchObject({ status: 'pending', attempts: 1, maxAttempts: 2 });
    expect(manager.snapshot()?.iteration).toBe(2);
    manager.assignTask('work', 'agent-2');
    manager.settleAssignment('work', 'agent-2', false, 'second strategy failed');
    expect(() => manager.retryTask('work')).toThrow(/exhausted/i);
    manager.shutdown();
  });
});
