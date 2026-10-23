import {
  ReviewFacts, deriveReviewState, emptyFacts, readsAsApproved, toSnapshot,
} from '../review/review.model';
import { ReviewManager } from '../review/review.manager';
import { ToolCallEntry } from '../engine/events';
import { requiresBuildVerification } from '../review/verification.scope';

function facts(): ReviewFacts {
  return emptyFacts('thread-1');
}

describe('review lifecycle derivation', () => {
  it('does not prescribe a build/test for prose artifacts', () => {
    expect(requiresBuildVerification('~/Desktop/story.txt')).toBe(false);
    expect(requiresBuildVerification('src/agent.ts')).toBe(true);

    const f = facts();
    f.changes.push({ file: '~/Desktop/story.txt', tools: ['WriteFileTool'], edits: 1, lastAt: 20 });
    expect(toSnapshot(f).nextAction).toBe('1 non-code file changed — no build/test needed.');
  });

  it('moves from idle to planning when the task has unfinished plan steps', () => {
    const f = facts();
    expect(deriveReviewState(f)).toBe('idle');
    f.todos = [{ content: 'Edit parser', status: 'pending' }];
    expect(deriveReviewState(f)).toBe('planning');
  });

  it('gives an unresolved approval precedence over every other state', () => {
    const f = facts();
    f.changes.push({ file: 'src/a.ts', tools: ['EditFileTool'], edits: 1, lastAt: 20 });
    f.approvals.push({ id: 7, kind: 'diff', question: 'Apply this diff?', requestedAt: 30 });
    expect(deriveReviewState(f, { applying: true })).toBe('awaiting_approval');
    expect(toSnapshot(f).nextAction).toContain('Apply this diff?');
  });

  it('treats verification as evidence only when it happened after the newest edit', () => {
    const f = facts();
    f.changes.push({ file: 'src/a.ts', tools: ['EditFileTool'], edits: 1, lastAt: 200 });
    f.verifications.push({ command: 'npm test', ok: true, settled: 1, coveredFiles: [], repoWide: true, at: 100 });
    expect(deriveReviewState(f)).toBe('unverified');

    f.verifications.push({ command: 'npm test', ok: false, settled: 1, coveredFiles: ['src/a.ts'], repoWide: false, at: 300 });
    expect(deriveReviewState(f)).toBe('verification_failed');

    f.verifications.push({ command: 'npm test', ok: true, settled: 1, coveredFiles: [], repoWide: true, at: 400 });
    expect(deriveReviewState(f)).toBe('verified');
  });

  it('requires a successful checkpoint after the newest edit', () => {
    const f = facts();
    f.changes.push({ file: 'src/a.ts', tools: ['EditFileTool'], edits: 1, lastAt: 200 });
    f.verifications.push({ command: 'npm test', ok: true, settled: 1, coveredFiles: [], repoWide: true, at: 300 });
    f.checkpoints.push({ id: '', label: 'failed', ts: 350, auto: false, ok: false });
    expect(deriveReviewState(f)).toBe('verified');
    expect(toSnapshot(f).checkpoints.at(-1)?.ok).toBe(false);

    f.checkpoints.push({ id: 'abc123', label: 'verified task', ts: 400, auto: false, ok: true });
    expect(deriveReviewState(f)).toBe('checkpointed');

    f.changes[0].lastAt = 500;
    expect(deriveReviewState(f)).toBe('unverified');
  });

  it('does not call a multi-file change verified until green evidence covers every code file', () => {
    const f = facts();
    f.changes.push(
      { file: 'src/a.ts', tools: ['EditFileTool'], edits: 1, lastAt: 100 },
      { file: 'src/b.ts', tools: ['EditFileTool'], edits: 1, lastAt: 100 },
    );
    f.verifications.push({
      command: 'npx jest src/a.ts', ok: true, settled: 1,
      coveredFiles: ['src/a.ts'], repoWide: false, at: 200,
    });
    expect(deriveReviewState(f)).toBe('unverified');
    f.verifications.push({
      command: 'npx jest src/b.ts', ok: true, settled: 1,
      coveredFiles: ['src/b.ts'], repoWide: false, at: 300,
    });
    expect(deriveReviewState(f)).toBe('verified');
  });

  it('classifies consent conservatively and never treats rejection as approval', () => {
    expect(readsAsApproved('diff', 'Approve')).toBe(true);
    expect(readsAsApproved('permission', 'always allow')).toBe(true);
    expect(readsAsApproved('diff', 'Reject')).toBe(false);
    expect(readsAsApproved('permission', '')).toBe(false);
    expect(readsAsApproved('question', 'any answer')).toBe(true);
  });
});

describe('ReviewManager fact folding', () => {
  let manager: ReviewManager;

  beforeEach(() => {
    jest.useFakeTimers();
    manager = new ReviewManager();
  });

  afterEach(() => {
    manager.shutdown();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('records a rejected approval once and does not leave it pending', () => {
    manager.onRequestPending({ id: 1, kind: 'diff', question: 'Apply?' });
    expect(manager.snapshot().state).toBe('awaiting_approval');
    manager.onRequestResolved({ id: 1, value: 'Reject' });
    manager.onRequestResolved({ id: 1, value: 'Approve' }); // late duplicate: ignored
    const snapshot = manager.snapshot();
    expect(snapshot.state).toBe('idle');
    expect(snapshot.approvals[0].resolution).toMatchObject({ value: 'Reject', approved: false });
  });

  it('folds mutation liveness, attributed changes, failed verification, and retry', () => {
    const running: ToolCallEntry = {
      id: 'call-1', toolName: 'EditFileTool', input: 'src/a.ts', output: '', status: 'running',
      startTime: new Date(),
    };
    manager.onToolCall(running);
    expect(manager.snapshot().state).toBe('applying');
    manager.onToolResult({ ...running, status: 'success', endTime: new Date() });
    manager.onChange({ tool: 'EditFileTool', file: 'src/a.ts', callId: 'call-1' });
    expect(manager.snapshot().state).toBe('unverified');

    manager.onEvidence({ command: 'npm test', ok: false, settled: 1 });
    expect(manager.snapshot().state).toBe('verification_failed');
    manager.onEvidence({ command: 'npm test', ok: true, settled: 1 });
    expect(manager.snapshot().state).toBe('verified');
  });

  it('surfaces failed checkpoint attempts without mistaking them for safety', () => {
    manager.onChange({ tool: 'WriteFileTool', file: 'src/b.ts' });
    manager.onEvidence({ command: 'npm run build', ok: true, settled: 1 });
    manager.onCheckpointFailed('verified task');
    const snapshot = manager.snapshot();
    expect(snapshot.state).toBe('verified');
    expect(snapshot.lastCheckpoint).toBeNull();
    expect(snapshot.checkpoints.at(-1)).toMatchObject({ label: 'verified task', ok: false });
  });
});
