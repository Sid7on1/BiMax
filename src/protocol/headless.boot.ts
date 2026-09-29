import { engineEvents, MessageEntry } from '../engine/events';
import { isCodebase } from '../graph/graph.summary';
import type { HeadlessSession } from './headless.session';

// Boot-time chores of the engine's session, split out of startHeadless (flaw list C19). Each is best-effort: none may
// block or fail the engine becoming ready.

/**
 * Launch-grade first run: an empty key pool opens the real provider picker automatically. The
 * selected provider then uses the protocol's masked input request, saves the key globally, applies
 * it to the live adapter, and opens model discovery — no shell exports or restart required.
 * Delay until the ready handshake is on the wire; if a user turn wins the race, defer instead of
 * interrupting it. BIMAX_SKIP_KEY_ONBOARDING=1 is available for hermetic embeds/tests.
 */
export function offerKeySetupWhenPoolEmpty(session: HeadlessSession): void {
  if (process.env.BIMAX_SKIP_KEY_ONBOARDING !== '1') {
    try {
      const { buildKeyPool } = require('../engine/provider') as typeof import('../engine/provider');
      if (buildKeyPool().length === 0) {
        const offerKeys = (attempt = 0) => {
          if (session.isBusy && attempt < 20) {
            const timer = setTimeout(() => offerKeys(attempt + 1), 500);
            timer.unref?.();
            return;
          }
          if (!session.isBusy) void session.dispatch('/setup');
        };
        const timer = setTimeout(() => offerKeys(), 350);
        timer.unref?.();
      }
    } catch {
      /* onboarding must never block engine readiness */
    }
  }
}

/**
 * Mind layer wake-up: one QUICK drives measurement at boot (cheap signals only — a grep and a
 * git status, strictly sequential, never builds/tests) so the footer's 🧠 strip and the DRIVES
 * prompt section reflect reality from the first turn instead of waiting for a manual
 * /drives check. Fire-and-forget; re-snapshots when done. BIMAX_DRIVES_BOOT=0 disables.
 */
export function wakeDrives(): void {
  if (process.env.BIMAX_DRIVES_BOOT !== '0' && isCodebase(process.cwd())) {
    void (async () => {
      try {
        const { getDrivesEngine } = require('../mind/drives.engine');
        await getDrivesEngine().check({ quick: true });
        engineEvents.emit('mind_changed');
      } catch {
        /* best-effort */
      }
    })();
  }
}

/**
 * Crash recovery for task workspaces: tasks the PREVIOUS process left non-terminal are marked
 * failed-resumable in the execution ledger (their processes died with that engine — honesty
 * first), and the user is told what can be re-created. Zellij-style resurrection: we re-CREATE
 * recorded work on request (/tasks retry <id>); we never pretend it kept running.
 */
export function reportInterruptedTasks(): void {
  try {
    const { getExecutionLedger } = require('../core/execution.ledger');
    const ledger = getExecutionLedger();
    const interrupted = ledger.interruptedTasks();
    if (interrupted.length) {
      for (const t of interrupted) {
        ledger.append({
          taskId: t.taskId,
          type: 'transition',
          state: 'failed-resumable',
          reason: 'engine restarted while task was running',
        });
      }
      const resumable = interrupted.filter((t: any) => t.resumable);
      const lines = interrupted
        .slice(0, 5)
        .map((t: any) => `  ✗ ${t.title}${t.resumable ? ` — retry with /tasks retry ${t.taskId}` : ''}`);
      engineEvents.emit('message', {
        id: `task-recovery-${Date.now()}`,
        role: 'system',
        level: 'warn',
        content: `${interrupted.length} background task(s) were interrupted by the last shutdown:\n${lines.join('\n')}${resumable.length ? '' : '\n  (none are re-creatable — no recorded command)'}`,
        timestamp: new Date(),
      } as MessageEntry);
    }
  } catch {
    /* ledger recovery is best-effort */
  }
}

/**
 * Self-heal a stale/invalid model pin (e.g. config.json points at a model from a different
 * provider) so the first turn doesn't 400. Non-blocking — runs concurrently with `ready` so it
 * never delays startup; if the user's first turn beats it, the agent loop's model-404 message
 * covers that one turn. Session-scoped: the switch is NOT persisted (see the note below).
 */
export function healModelPins(llmAdapter: { healModels(): Promise<unknown[]> }): void {
  void (async () => {
    try {
      const healed = await llmAdapter.healModels();
      if (healed.length) {
        // The heal applies to THIS SESSION only — it is deliberately not persisted.
        //
        // It used to `saveConfig(patch, { origin: 'runtime' })` so "the next launch is already
        // correct". That silently overwrote the model the user had explicitly chosen in the
        // picker, and because `moonshotai/kimi-k3` is the top-ranked coding candidate
        // (models.ts:autoSelectCandidates), every heal landed on the same id. The reported
        // symptom was "whenever I open the app the kimi model is selected again" — one transient
        // provider hiccup was enough to replace a deliberate choice permanently, and the user had
        // no way to tell that anything had rewritten it.
        //
        // Healing in memory keeps the session working (nothing 400s) while the stored choice
        // stays the user's. If the pin is genuinely dead the heal simply runs again next launch
        // and says so again, which is honest; a stale pin is now fixed by the user in the picker,
        // never by the engine behind their back.
        const lines = (healed as Array<{ slot: string; from: string; to: string }>).map(
          (h) => `  • ${h.slot}: "${h.from}" → ${h.to ? `"${h.to}"` : 'the Work model'}`,
        );
        engineEvents.emit('message', {
          id: `heal-${Date.now()}`,
          role: 'system',
          level: 'info',
          // Deliberately not "aren't served by your provider": a slot also heals when the model IS
          // served but can't do the job (e.g. one that 400s on every tools+image request), and
          // claiming the provider doesn't have it would send the user chasing the wrong problem.
          content: `${healed.length === 1 ? "A model pinned in your config can't run here" : `${healed.length} models pinned in your config can't run here`} — switched:\n${lines.join('\n')}\nUse /model to choose another.`,
          timestamp: new Date(),
        } as MessageEntry);
        engineEvents.emit('config_changed');
      }
    } catch {
      /* best-effort */
    }
  })();
}
