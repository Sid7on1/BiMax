import { engineEvents, MessageEntry } from '../engine/events';
import { getConfig } from '../engine/config';
import type { HeadlessSession } from './headless.session';
import type { OutcomeManager } from '../outcome/outcome.manager';
import type { OutcomeTask } from '../outcome/outcome.model';

/**
 * Durable outcome convergence: a background assignment settling queues a receipt in the
 * contract. Once the interactive turn is idle, wake the parent coordinator to integrate,
 * independently verify, validate, and dispatch newly-ready graph work. Every wake must make a
 * measurable contract change; three no-progress wakes or the process-wide cap stop the loop.
 *
 * Split out of startHeadless (flaw list C19). Returns the function that stops it.
 */
export function startOutcomeContinuation(deps: {
  session: HeadlessSession;
  outcomeManager: OutcomeManager;
  config: { autoContinueOutcome?: boolean };
}): () => void {
  const { session, outcomeManager, config } = deps;
  let continuationTimer: ReturnType<typeof setTimeout> | null = null;
  let continuationRunning = false;
  let reportedHaltRevision = 0;
  const continuationEnabled = () => {
    try {
      return getConfig().autoContinueOutcome !== false && process.env.BIMAX_AUTO_CONTINUE_OUTCOME !== '0';
    } catch {
      return config.autoContinueOutcome !== false && process.env.BIMAX_AUTO_CONTINUE_OUTCOME !== '0';
    }
  };
  const continuationWakeLimit = () => {
    const requested = Number(process.env.BIMAX_AUTO_CONTINUE_MAX_WAKEUPS || 24);
    return Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.floor(requested))) : 24;
  };
  const scheduleOutcomeContinuation = (delayMs = 250) => {
    if (continuationTimer || continuationRunning || !continuationEnabled()) return;
    continuationTimer = setTimeout(() => {
      continuationTimer = null;
      void attemptOutcomeContinuation();
    }, delayMs);
    continuationTimer.unref?.();
  };
  const outcomeNeedsAnotherWake = () => {
    const contract = outcomeManager.current();
    const snapshot = outcomeManager.snapshot();
    if (!contract || !snapshot || contract.phase === 'verified') return false;
    if (contract.blocker?.requiresUser || snapshot.activeTasks > 0) return false;
    // Past the guards above the contract is not verified, so another wake is always wanted. (This read
    // `!snapshot.canComplete || contract.phase !== 'verified'`, which is true whenever it is reached — found when the
    // outcome manager got its type back, 2026-09-30.)
    return true;
  };
  const continuationPrompt = (taskIds: string[]) => {
    const contract = outcomeManager.current();
    const tasks = (contract?.tasks || []).filter((task: OutcomeTask) => taskIds.includes(task.id));
    const settled = tasks.map(
      (task: OutcomeTask) =>
        `- ${task.id}: ${task.title} · ${task.status}${task.assignment?.integrationStatus ? ` · integration ${task.assignment.integrationStatus}` : ''}`,
    );
    return [
      '[ENGINE OUTCOME CONTINUATION — this is not a new user request]',
      `Continue the active outcome: ${contract?.objective || 'the current verified outcome'}`,
      ...(settled.length ? ['Background assignment updates:', ...settled] : []),
      'Act now; do not merely summarize the updates.',
      '1. Inspect each delegated receipt and actual files/results.',
      '2. Integrate isolated changes with OutcomeTool(action:"integrate_task") when required.',
      '3. Run fresh parent-side verification that covers the changed scope.',
      '4. Validate completed delegated tasks only with trusted evidence.',
      '5. Recompute the schedule and immediately dispatch newly-ready independent tasks when that is the fastest safe path.',
      '6. Complete local critical-path work directly and continue until verified, waiting on active work, or genuinely blocked on the user.',
      'Keep the outcome contract current. Never treat a worker report or this wake-up as proof of completion.',
    ].join('\n');
  };
  const attemptOutcomeContinuation = async (): Promise<void> => {
    if (continuationRunning || !continuationEnabled()) return;
    const pending = outcomeManager.continuation();
    if (!pending || pending.state === 'idle') return;
    if (pending.state === 'halted') {
      if (reportedHaltRevision !== pending.revision) {
        reportedHaltRevision = pending.revision;
        engineEvents.emit('message', {
          id: `outcome-halt-${Date.now()}`,
          role: 'system',
          level: 'warn',
          content: `Outcome auto-continuation paused safely: ${pending.lastError || 'circuit breaker reached'}`,
          timestamp: new Date(),
        } as MessageEntry);
      }
      return;
    }
    if (session.isBusy) {
      scheduleOutcomeContinuation(500);
      return;
    }
    const claim = outcomeManager.claimContinuation(continuationWakeLimit(), 30_000);
    if (!claim || claim.claimedRevision === undefined) {
      // A prior process may have died during its coordinator wake. The short durable lease avoids
      // double execution while letting this process reclaim it without user babysitting.
      scheduleOutcomeContinuation(1000);
      return;
    }
    continuationRunning = true;
    const before = outcomeManager.progressFingerprint();
    engineEvents.emit(
      'status',
      `Outcome loop ${claim.wakeups}: coordinating ${claim.taskIds.length || 'remaining'} task(s)…`,
    );
    const result = await session.dispatchAutonomous(continuationPrompt(claim.taskIds));
    const progress = result === 'completed' && before !== outcomeManager.progressFingerprint();
    outcomeManager.completeContinuation(
      claim.claimedRevision,
      progress,
      progress
        ? undefined
        : `Coordinator wake ${result === 'completed' ? 'made no measurable outcome progress' : result}.`,
    );
    continuationRunning = false;

    if (result === 'interrupted') {
      engineEvents.emit('status', 'Outcome auto-continuation paused by user interruption.');
      return;
    }
    const after = outcomeManager.continuation();
    if (after?.state === 'halted') {
      scheduleOutcomeContinuation();
      return;
    }
    if (after?.state === 'pending') {
      scheduleOutcomeContinuation(progress ? 250 : 1000);
      return;
    }
    if (outcomeNeedsAnotherWake()) {
      outcomeManager.requestContinuation([], 'outcome_incomplete');
    }
  };
  const onOutcomeContinuation = (event?: { sessionId?: string }) => {
    if (event?.sessionId && event.sessionId !== outcomeManager.activeSessionId()) return;
    scheduleOutcomeContinuation();
  };
  const onContinuationSessionChanged = () => scheduleOutcomeContinuation(100);
  engineEvents.on('outcome_continuation_requested', onOutcomeContinuation);
  engineEvents.on('session_changed', onContinuationSessionChanged);
  scheduleOutcomeContinuation(100);
  return () => {
    if (continuationTimer) clearTimeout(continuationTimer);
    engineEvents.off('outcome_continuation_requested', onOutcomeContinuation);
    engineEvents.off('session_changed', onContinuationSessionChanged);
  };
}
