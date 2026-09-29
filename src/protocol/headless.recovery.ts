import { engineEvents } from '../engine/events';
import type { HeadlessSession } from './headless.session';
import type { OutcomeManager } from '../outcome/outcome.manager';

/**
 * Unattended crash recovery: only recent, single-session, outcome-bound assignments running
 * under normal permissions qualify. The recovery command reuses the same audited session and
 * assignment rebinding path as manual `/subagents resume`; unsafe/legacy snapshots stay visible
 * for manual review. A user turn that wins the startup race is never interrupted or switched.
 *
 * Split out of startHeadless (flaw list C19). Returns the function that stops it.
 */
export function startAssignmentRecovery(deps: {
  session: HeadlessSession;
  outcomeManager: OutcomeManager;
  config: { autoResumeAgents?: boolean };
}): () => void {
  const { session, outcomeManager, config } = deps;
  let recoveryStarted = false;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  const attemptAutomaticRecovery = async (attempt = 0): Promise<void> => {
    if (recoveryStarted) return;
    const checkpoint = require('../core/agent.checkpoint') as typeof import('../core/agent.checkpoint');
    const plan = checkpoint.planAutomaticRecovery(checkpoint.crashedAgents(), {
      enabled: config.autoResumeAgents !== false && process.env.BIMAX_AUTO_RESUME_AGENTS !== '0',
    });
    if (!plan.automatic || !plan.sessionId) {
      engineEvents.emit('status', `${plan.reason} Use /subagents resume after reviewing the interrupted work.`);
      return;
    }
    if (session.isBusy) {
      if (attempt < 30)
        recoveryTimer = setTimeout(() => {
          void attemptAutomaticRecovery(attempt + 1);
        }, 1000);
      else
        engineEvents.emit(
          'status',
          'Automatic assignment recovery deferred because the current turn stayed busy; use /subagents resume later.',
        );
      return;
    }
    // `activeSessionId()` is '' on every fresh boot — a brand-new terminal is indistinguishable
    // from "picking the same session back up" by process state alone, so treating '' as a pass
    // here silently hijacked EVERY new chat onto whatever old session left a crashed sub-agent
    // behind: it dispatched a full /resume (replaying that session's transcript into the new
    // terminal and rebinding the recorder so every later turn kept appending to the old thread).
    // Automatic recovery is only safe when the CURRENT session already is the crashed one.
    const activeSession = outcomeManager.activeSessionId();
    if (activeSession !== plan.sessionId) {
      engineEvents.emit(
        'status',
        `${plan.agents.length} interrupted assignment(s) from a previous session (${plan.sessionId}) can be recovered — run /resume ${plan.sessionId} then /subagents resume to pick them back up.`,
      );
      return;
    }
    recoveryStarted = true;
    engineEvents.emit('status', `Recovering ${plan.agents.length} interrupted assignment(s) from ${plan.sessionId}…`);
    await session.dispatch(`/resume ${plan.sessionId}`);
    if (outcomeManager.activeSessionId() !== plan.sessionId) {
      recoveryStarted = false;
      engineEvents.emit(
        'status',
        `Could not restore outcome session ${plan.sessionId}; interrupted agents were not restarted.`,
      );
      return;
    }
    await session.dispatch('/subagents resume');
    engineEvents.emit('status', `${plan.agents.length} interrupted assignment(s) resumed safely.`);
  };
  const onAgentRecoveryAvailable = () => {
    void attemptAutomaticRecovery();
  };
  engineEvents.on('agent_recovery_available', onAgentRecoveryAvailable);
  return () => {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    engineEvents.off('agent_recovery_available', onAgentRecoveryAvailable);
  };
}
