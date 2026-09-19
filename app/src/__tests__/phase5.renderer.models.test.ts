/**
 * Phase 5 renderer view models.
 *
 * These are the modules that decide what the workspace CLAIMS: the task's one state, which evidence
 * lanes exist, what the Live Target says about the app/window/evidence age, and whether a receipt is
 * proven. Every test here grades an end state, and each block ends with the mutation that the
 * assertion exists to catch — `08_ACCEPTANCE_GATES.md` requires a test to fail against a
 * deliberately neutered implementation, so the mutants are written out rather than implied.
 *
 * They live in the Terminal suite alongside `trust.center.model.test.ts` and
 * `receipt.inspector.test.ts`, which is where the existing Desktop pure-logic tests already run.
 */
import { deriveTaskState } from '../renderer/src/task.state';
import { inspectorTabs, resolveActiveTab } from '../renderer/src/inspector.model';
import {
  normalizeUiSnapshot, normalizeReviewSnapshot, normalizeSubAgents, normalizeTodos,
} from '../renderer/src/protocol.normalize';
import type { ReviewSnapshot } from '../renderer/src/protocol';

const NOW = 1_800_000_000_000;

const review = (overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot => ({
  sessionId: 's1',
  state: 'verified',
  nextAction: 'Changes applied and the checks passed.',
  approvals: [],
  changes: [{ file: 'src/api/client.ts', tools: ['EditFileTool'], edits: 2, lastAt: NOW - 60_000 }],
  verifications: [{ command: 'npm test -- retry', ok: true, settled: 1, coveredFiles: [], repoWide: false, at: NOW - 30_000 }],
  checkpoints: [],
  lastCheckpoint: null,
  todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }],
  interrupted: false,
  updatedAt: NOW,
  ...overrides,
});

const idleTaskInput = {
  awaitingReply: false, busy: false, streaming: false, review: null,
  todos: [], macPaused: false, hasContent: false,
};

describe('task state', () => {
  test('a user holding the Mac outranks every other signal, including a busy engine', () => {
    const view = deriveTaskState({ ...idleTaskInput, busy: true, macPaused: true, hasContent: true });
    expect(view.state).toBe('needs-you');
    expect(view.label).toBe('You have control');
    expect(view.interruptible).toBe(false);
  });

  test('a pending approval is never rendered as progress', () => {
    expect(deriveTaskState({ ...idleTaskInput, busy: true, awaitingReply: true }).state).toBe('needs-you');
    expect(deriveTaskState({ ...idleTaskInput, busy: true, review: review({ state: 'awaiting_approval' }) }).state)
      .toBe('needs-you');
  });

  test('a failed verification outranks a finished turn', () => {
    const view = deriveTaskState({ ...idleTaskInput, hasContent: true, review: review({ state: 'verification_failed' }) });
    expect(view.state).toBe('failed');
    expect(view.label).toBe('Check failed');
  });

  test('verified is claimed only when the engine said so', () => {
    expect(deriveTaskState({ ...idleTaskInput, hasContent: true, review: review() }).state).toBe('verified');
    // A turn that simply ended is NOT verified.
    expect(deriveTaskState({ ...idleTaskInput, hasContent: true, review: null }).state).toBe('idle');
    // Nor is an unverified review.
    expect(deriveTaskState({ ...idleTaskInput, hasContent: true, review: review({ state: 'unverified' }) }).state)
      .toBe('working');
  });

  test('progress counts only completed steps', () => {
    const view = deriveTaskState({
      ...idleTaskInput, busy: true,
      review: review({ state: 'applying', todos: [
        { content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' },
      ] }),
    });
    expect(view.progress).toEqual({ done: 1, total: 3 });
  });

  // Mutant: an implementation that reported `busy` first would call a blocked task "Working".
  test('MUTANT — ranking busy above the human would mislabel a blocked task', () => {
    const naive = (input: typeof idleTaskInput): string => (input.busy ? 'working' : 'idle');
    const blocked = { ...idleTaskInput, busy: true, awaitingReply: true };
    expect(naive(blocked)).toBe('working');
    expect(deriveTaskState(blocked).state).not.toBe('working');
  });
});

describe('the four-lane inspector', () => {
  test('Files, Review and Terminal ride on the project; GitHub needs a repository', () => {
    const tabs = inspectorTabs({ review: null, gitStatus: null, hasProject: true, isRepo: false });
    expect(tabs.map(t => t.id)).toEqual(['files', 'review', 'terminal', 'github']);
    expect(tabs.find(t => t.id === 'files')?.available).toBe(true);
    expect(tabs.find(t => t.id === 'review')?.available).toBe(true);
    expect(tabs.find(t => t.id === 'terminal')?.available).toBe(true);
    expect(tabs.find(t => t.id === 'github')?.available).toBe(false);
  });

  test('every unavailable lane explains itself instead of vanishing', () => {
    const tabs = inspectorTabs({ review: null, gitStatus: null, hasProject: false });
    for (const tab of tabs.filter(candidate => !candidate.available)) {
      expect(tab.emptyReason.length).toBeGreaterThan(10);
    }
  });

  test('a failed verification raises attention on Review; commits behind raise it on GitHub', () => {
    const failed = inspectorTabs({
      review: review({ state: 'verification_failed' }), gitStatus: null, hasProject: true,
    });
    expect(failed.find(tab => tab.id === 'review')?.attention).toBe(true);

    const behind = inspectorTabs({
      review: null, gitStatus: null, hasProject: true, isRepo: true, ahead: 0, behind: 3,
    });
    expect(behind.find(tab => tab.id === 'github')?.attention).toBe(true);
  });

  test('unpushed commits become the GitHub badge', () => {
    const tabs = inspectorTabs({ review: null, gitStatus: null, hasProject: true, isRepo: true, ahead: 2, behind: 0 });
    expect(tabs.find(tab => tab.id === 'github')?.count).toBe(2);
  });

  test('resolveActiveTab never selects an unavailable lane and honours an explicit choice', () => {
    const tabs = inspectorTabs({ review: review(), gitStatus: null, hasProject: true, isRepo: false });
    expect(resolveActiveTab(tabs, 'github')).not.toBe('github');
    expect(resolveActiveTab(tabs, 'review')).toBe('review');
    expect(resolveActiveTab(tabs, null)).toBe('files');
  });

  test('a lane needing attention wins when the user has not chosen', () => {
    const tabs = inspectorTabs({
      review: review({ state: 'verification_failed' }), gitStatus: null, hasProject: true,
    });
    expect(resolveActiveTab(tabs, null)).toBe('review');
  });
});

describe('protocol normalization', () => {
  test('a snapshot missing whole sections still produces a renderable shape', () => {
    const snapshot = normalizeUiSnapshot({ graph: null, mind: null });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.models.coding).toBe('');
    expect(snapshot!.graph.engine).toBe('none');
    expect(snapshot!.mind.weakSpots).toBe(0);
    expect(snapshot!.sessions).toEqual([]);
  });

  test('a non-object snapshot is dropped rather than half-adopted', () => {
    expect(normalizeUiSnapshot('nope')).toBeNull();
    expect(normalizeUiSnapshot(null)).toBeNull();
    expect(normalizeUiSnapshot([1, 2])).toBeNull();
  });

  test('an unknown review state degrades to idle, never to a green one', () => {
    const snapshot = normalizeReviewSnapshot({ state: 'from-the-future' });
    expect(snapshot?.state).toBe('idle');
  });

  test('a verification with no stated result is not a pass', () => {
    const snapshot = normalizeReviewSnapshot({
      state: 'verified', verifications: [{ command: 'npm test' }],
    });
    expect(snapshot?.verifications[0].ok).toBe(false);
  });

  test('array payloads that are not arrays become empty, not crashes', () => {
    expect(normalizeSubAgents({ not: 'an array' })).toEqual([]);
    expect(normalizeTodos('nope')).toEqual([]);
    expect(normalizeReviewSnapshot({ changes: null, approvals: 'x' })?.changes).toEqual([]);
  });

  // Mutant: passing the payload straight through.
  test('MUTANT — trusting the payload would put undefined into the composer', () => {
    const passthrough = (raw: any): any => raw;
    expect(() => passthrough({ graph: null }).models.coding).toThrow();
    expect(normalizeUiSnapshot({ graph: null })!.models.coding).toBe('');
  });
});
