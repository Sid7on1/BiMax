export type AxReadinessState =
  | 'ready'
  | 'warming'
  | 'background_restricted'
  | 'visual_only_stable';

export interface AxReadinessSignals {
  targetableCount: number;
  namedTargetableCount: number;
  editableCount: number;
  backgroundBlockedBy?: string;
}

export interface AxReadinessObservation extends AxReadinessSignals {
  state: AxReadinessState;
  stable: boolean;
  attempt: number;
  reason: string;
}

export interface AxReadinessPrevious {
  targetableCount: number;
  namedTargetableCount: number;
  sparseSamples: number;
}

/**
 * Classify the current observation, not the application forever.
 *
 * Electron/Chromium applications can publish a placeholder AX tree during cold launch and a rich
 * one shortly afterwards. The old session-wide `backgroundUnviableApps` latch turned that first
 * sparse sample into an app identity. Readiness is instead a property of this window at this time.
 */
export function classifyAxReadiness(
  signals: AxReadinessSignals,
  previous: AxReadinessPrevious | undefined,
  attempt: number,
): AxReadinessObservation {
  if (signals.namedTargetableCount >= 3 || signals.editableCount > 0) {
    const changed = !!previous
      && (previous.namedTargetableCount !== signals.namedTargetableCount
        || previous.targetableCount !== signals.targetableCount);
    return {
      ...signals,
      state: 'ready',
      stable: !changed || attempt > 0,
      attempt,
      reason: `AX is ready now (${signals.namedTargetableCount} named of ${signals.targetableCount} targetable, ${signals.editableCount} editable)`,
    };
  }

  if (signals.backgroundBlockedBy) {
    return {
      ...signals,
      state: 'background_restricted',
      stable: true,
      attempt,
      reason: `the current background observation is AX-restricted while ${signals.backgroundBlockedBy} is frontmost; this is not a permanent app capability classification`,
    };
  }

  const sparseSamples = (previous?.sparseSamples ?? 0) + 1;
  if (sparseSamples >= 3) {
    return {
      ...signals,
      state: 'visual_only_stable',
      stable: true,
      attempt,
      reason: `AX stayed sparse for ${sparseSamples} bounded samples; keep semantic retries available on later observations and use vision for the current content`,
    };
  }

  return {
    ...signals,
    state: 'warming',
    stable: false,
    attempt,
    reason: `AX is still warming (${signals.namedTargetableCount} named of ${signals.targetableCount} targetable); re-observe within the bounded readiness window`,
  };
}

export function nextAxReadinessPrevious(
  observation: AxReadinessObservation,
): AxReadinessPrevious {
  return {
    targetableCount: observation.targetableCount,
    namedTargetableCount: observation.namedTargetableCount,
    sparseSamples: observation.state === 'ready' ? 0 : observation.attempt + 1,
  };
}

