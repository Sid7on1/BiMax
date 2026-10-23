import { BOOT_LADDER, EnginePhase } from './types';

/**
 * The supervisor's phase transition rules — a pure table + one function, so every legal and
 * illegal move is enumerable in tests. Illegal transitions are NORMALIZED (the current phase is
 * kept and `ok:false` returned), never thrown: a stale or out-of-order message from a child
 * process must not be able to corrupt lifecycle state.
 */

const LEGAL: Record<EnginePhase, readonly EnginePhase[]> = {
  idle: ['spawning'],
  // The engine may legally skip boot phases (an old binary emits none and jumps straight to
  // ready), any live phase can end in exited/failed/stopping, and a launch with shed
  // capabilities lands on `degraded` instead of `ready` — from ANY startup phase.
  spawning: ['booting', 'loading_storage', 'loading_graph', 'loading_tools', 'restoring_session', 'ready', 'degraded', 'exited', 'failed', 'stopping', 'restarting'],
  booting: ['loading_storage', 'loading_graph', 'loading_tools', 'restoring_session', 'ready', 'degraded', 'exited', 'failed', 'stopping', 'restarting'],
  loading_storage: ['loading_graph', 'loading_tools', 'restoring_session', 'ready', 'degraded', 'exited', 'failed', 'stopping', 'restarting'],
  loading_graph: ['loading_tools', 'restoring_session', 'ready', 'degraded', 'exited', 'failed', 'stopping', 'restarting'],
  loading_tools: ['restoring_session', 'ready', 'degraded', 'exited', 'failed', 'stopping', 'restarting'],
  restoring_session: ['ready', 'degraded', 'exited', 'failed', 'stopping', 'restarting'],
  ready: ['degraded', 'restarting', 'stopping', 'exited', 'failed'],
  degraded: ['ready', 'restarting', 'stopping', 'exited', 'failed'],
  restarting: ['spawning', 'failed', 'stopping', 'idle'],
  stopping: ['exited', 'idle', 'spawning'],
  exited: ['spawning', 'restarting', 'idle'],
  failed: ['spawning', 'restarting', 'idle'],
};

export interface TransitionResult {
  ok: boolean;
  phase: EnginePhase; // the phase to be in after the (possibly rejected) transition
}

/** Attempt phase → next. Illegal moves keep the current phase (`ok:false`). Self-moves are ok. */
export function transition(current: EnginePhase, next: EnginePhase): TransitionResult {
  if (current === next) return { ok: true, phase: current };
  if (LEGAL[current]?.includes(next)) return { ok: true, phase: next };
  return { ok: false, phase: current };
}

/** True when `phase` is part of the startup ladder (i.e. before ready). */
export function isStartupPhase(phase: EnginePhase): boolean {
  return phase !== 'ready' && BOOT_LADDER.includes(phase);
}

/** True when the engine is expected to be alive in this phase. */
export function isLivePhase(phase: EnginePhase): boolean {
  return isStartupPhase(phase) || phase === 'ready' || phase === 'degraded' || phase === 'stopping';
}

/** Startup progress for the renderer: 1-based step within the boot ladder, or undefined. */
export function bootProgress(phase: EnginePhase): { step: number; total: number } | undefined {
  const idx = BOOT_LADDER.indexOf(phase);
  if (idx === -1 || phase === 'ready') return undefined;
  return { step: idx + 1, total: BOOT_LADDER.length };
}

/** Human-readable label per phase — the banner's primary line. */
export function phaseMessage(phase: EnginePhase): string {
  switch (phase) {
    case 'idle': return 'No engine running';
    case 'spawning': return 'Launching engine…';
    case 'booting': return 'Engine booting…';
    case 'loading_storage': return 'Loading configuration and storage…';
    case 'loading_graph': return 'Loading code graph…';
    case 'loading_tools': return 'Wiring tools…';
    case 'restoring_session': return 'Restoring sessions…';
    case 'ready': return 'Engine ready';
    case 'degraded': return 'Engine ready (some services disabled)';
    case 'restarting': return 'Restarting engine…';
    case 'stopping': return 'Stopping engine…';
    case 'exited': return 'Engine stopped';
    case 'failed': return 'Engine failed to start';
  }
}
