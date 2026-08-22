import type { DesktopCommand } from './desktop.runtime';

export type NativeLogicalMutation = 'open' | 'click' | 'type' | 'set_value' | 'arrange' | 'close';

export interface TypedLogicalPostcondition {
  kind: 'semantic_text' | 'semantic_value' | 'app_running' | 'window_frame' | 'window_absent';
  source: 'declared' | 'derived';
  predicate: Record<string, unknown>;
}

export interface MutationVerification {
  status: 'verified' | 'unverified';
  postcondition: TypedLogicalPostcondition;
  freshObservation: boolean;
  delivery: {
    requested: 'background' | 'foreground';
    actual: 'background' | 'foreground' | 'unknown';
    policy?: string;
    focusChanged?: boolean;
  };
  evidence?: Record<string, unknown>;
  reason?: string;
}

export interface MutationGrade {
  ok: boolean;
  verification: MutationVerification;
}

export interface ExpectedSemanticTarget {
  snapshotId: string;
  elementToken: string;
  pid: number;
  windowId?: number;
  windowGeneration?: number;
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any> : {};
}

export type RequestedLogicalDelivery = 'background' | 'foreground_lease';

/**
 * Grade what actually happened against what was requested.
 *
 * `background` keeps the original invariant: a background action must never take focus, acquire a
 * lease, or move the frontmost app. `foreground_lease` inverts exactly those requirements — the
 * delivery is only safe when the native receipt proves a lease-backed foreground policy; a
 * foreground request delivered without a lease is treated like any other broken promise.
 */
function assessDelivery(
  requested: RequestedLogicalDelivery,
  policy: unknown,
  frontmostPidBefore: unknown,
  frontmostPidAfter: unknown,
  focusLease: unknown,
): MutationVerification['delivery'] & { safe: boolean; reason?: string } {
  const policyIsBackground = policy === 'background_only' || policy === 'background_native';
  const policyIsForeground = policy === 'foreground_once' || policy === 'foreground_persistent';
  const beforeKnown = frontmostPidBefore === undefined || Number.isSafeInteger(frontmostPidBefore);
  const afterKnown = frontmostPidAfter === undefined || Number.isSafeInteger(frontmostPidAfter);
  const focusChanged = beforeKnown && afterKnown ? frontmostPidBefore !== frontmostPidAfter : undefined;
  const publicFields = () => ({
    ...(typeof policy === 'string' ? { policy } : {}),
    ...(focusChanged !== undefined ? { focusChanged } : {}),
  });

  if (requested === 'foreground_lease') {
    if (!policyIsForeground) {
      return {
        requested: 'foreground',
        actual: focusLease ? 'foreground' : policyIsBackground ? 'background' : 'unknown',
        ...publicFields(),
        safe: false, reason: 'foreground delivery did not use a verified lease policy',
      };
    }
    if (!focusLease) {
      return {
        requested: 'foreground', actual: policyIsForeground ? 'foreground' : 'unknown', ...publicFields(),
        safe: false, reason: 'a foreground request was delivered without the required focus lease',
      };
    }
    return { requested: 'foreground', actual: 'foreground', ...publicFields(), safe: true };
  }

  const actual = focusLease ? 'foreground' : policyIsBackground ? 'background' : 'unknown';
  if (!policyIsBackground) {
    return {
      requested: 'background', actual, ...publicFields(),
      safe: false, reason: 'the native receipt did not preserve the requested background policy',
    };
  }
  if (focusLease) {
    return {
      requested: 'background', actual: 'foreground', policy,
      ...(focusChanged !== undefined ? { focusChanged } : {}),
      safe: false, reason: 'a background action unexpectedly acquired a foreground focus lease',
    };
  }
  if (focusChanged === true) {
    return {
      requested: 'background', actual: 'background', policy, focusChanged: true,
      safe: false, reason: 'the action changed the measured foreground despite background delivery',
    };
  }
  return {
    requested: 'background', actual: 'background', policy,
    ...(focusChanged !== undefined ? { focusChanged } : {}), safe: true,
  };
}

export function postconditionFor(
  action: NativeLogicalMutation,
  command: DesktopCommand,
): { postcondition?: TypedLogicalPostcondition; reason?: string } {
  if (action === 'set_value') {
    return {
      postcondition: {
        kind: 'semantic_value', source: 'derived', predicate: { expectedValue: command.value },
      },
    };
  }
  if (action === 'click' || action === 'type') {
    const expected = command.expect?.trim();
    if (!expected) {
      return {
        reason: `${action} needs expect naming a checkable fresh end state; delivery alone cannot count as success`,
      };
    }
    return {
      postcondition: {
        kind: 'semantic_text', source: 'declared',
        predicate: {
          text: expected,
          textPresence: command.expectMode === 'absent' ? 'absent' : 'present',
        },
      },
    };
  }
  if (action === 'open') {
    return {
      postcondition: {
        kind: 'app_running', source: 'derived',
        predicate: command.bundleId ? { bundleId: command.bundleId } : { appName: command.app },
      },
    };
  }
  if (action === 'arrange') {
    return {
      postcondition: {
        kind: 'window_frame', source: 'derived',
        predicate: { windowId: command.windowId, layout: command.layout },
      },
    };
  }
  return {
    postcondition: {
      kind: 'window_absent', source: 'derived',
      predicate: { pid: command.pid, windowId: command.windowId },
    },
  };
}

function unverified(
  postcondition: TypedLogicalPostcondition,
  delivery: MutationVerification['delivery'],
  reason: string,
  evidence?: Record<string, unknown>,
): MutationGrade {
  return {
    ok: false,
    verification: {
      status: 'unverified', postcondition, freshObservation: false, delivery,
      ...(evidence ? { evidence } : {}), reason,
    },
  };
}

function publicDelivery(
  delivery: MutationVerification['delivery'] & { safe?: boolean; reason?: string },
): MutationVerification['delivery'] {
  return {
    requested: delivery.requested,
    actual: delivery.actual,
    ...(delivery.policy ? { policy: delivery.policy } : {}),
    ...(delivery.focusChanged !== undefined ? { focusChanged: delivery.focusChanged } : {}),
  };
}

export function gradeSemanticMutation(
  value: Record<string, unknown>,
  postcondition: TypedLogicalPostcondition,
  expectedTarget: ExpectedSemanticTarget,
  requestedDelivery: RequestedLogicalDelivery = 'background',
): MutationGrade {
  const receipt = value.op === 'semantic.action.receipt' ? object(value.payload) : {};
  const evidence = object(receipt.evidence);
  const deliveryAssessment = assessDelivery(
    requestedDelivery,
    receipt.deliveryPolicy,
    receipt.frontmostPidBefore,
    receipt.frontmostPidAfter,
    receipt.focusLease,
  );
  const delivery = publicDelivery(deliveryAssessment);
  const reported = {
    outcome: receipt.outcome,
    eventRevisionBefore: receipt.eventRevisionBefore,
    eventRevisionAfter: receipt.eventRevisionAfter,
    ...(receipt.focusLease ? { focusLease: receipt.focusLease } : {}),
    evidence,
  };
  if (value.op !== 'semantic.action.receipt') {
    return unverified(postcondition, delivery, 'native delivery returned no semantic action receipt', reported);
  }
  if (!deliveryAssessment.safe) {
    return unverified(postcondition, delivery, deliveryAssessment.reason!, reported);
  }
  const element = object(receipt.element);
  const target = object(value.target);
  const targetMatches = element.snapshotId === expectedTarget.snapshotId
    && element.token === expectedTarget.elementToken
    && element.pid === expectedTarget.pid
    && element.windowId === expectedTarget.windowId
    && element.windowGeneration === expectedTarget.windowGeneration
    && target.pid === expectedTarget.pid
    && target.windowId === expectedTarget.windowId
    && target.windowGeneration === expectedTarget.windowGeneration;
  if (!targetMatches) {
    return unverified(
      postcondition,
      delivery,
      'native evidence was not bound to the retained element and exact target window',
      { ...reported, element, target },
    );
  }
  if (receipt.outcome !== 'performed') {
    return unverified(postcondition, delivery, `native semantic outcome was ${String(receipt.outcome || 'missing')}`, reported);
  }
  if (evidence.requiredTier !== 1 || !Number.isSafeInteger(evidence.achievedTier)
      || evidence.achievedTier < 1
      || evidence.outcome !== 'satisfied' || evidence.postconditionMatched !== true
      || !Number.isSafeInteger(evidence.attempts) || evidence.attempts < 1
      || !Number.isSafeInteger(evidence.settledAtMs)) {
    return unverified(
      postcondition,
      delivery,
      'delivery was not independently confirmed by a fresh matching native observation',
      reported,
    );
  }
  return {
    ok: true,
    verification: {
      status: 'verified', postcondition, freshObservation: true, delivery,
      evidence: reported,
    },
  };
}

export function gradeWorkspaceMutation(
  action: 'open' | 'arrange' | 'close',
  value: Record<string, unknown>,
  postcondition: TypedLogicalPostcondition,
): MutationGrade {
  const deliveryAssessment = assessDelivery(
    'background',
    action === 'open' ? 'background_native' : 'background_only',
    value.frontmostPidBefore,
    value.frontmostPidAfter,
    undefined,
  );
  const delivery = publicDelivery(deliveryAssessment);
  if (!deliveryAssessment.safe) {
    return unverified(postcondition, delivery, deliveryAssessment.reason!, value);
  }

  const predicate = postcondition.predicate;
  const app = object(value.app);
  const window = object(value.window);
  const resolved = object(value.resolved);
  const lookup = object(resolved.lookup);
  const targetMatches = action === 'open'
    ? (typeof predicate.bundleId === 'string'
      ? lookup.kind === 'bundle_id' && lookup.value === predicate.bundleId
        && (value.bundleId === predicate.bundleId || app.bundleId === predicate.bundleId)
      : typeof predicate.appName === 'string'
        && lookup.kind === 'name' && lookup.value === predicate.appName
        && Number.isSafeInteger(app.pid) && app.pid > 0)
    : window.pid === predicate.pid
      && window.windowId === predicate.windowId
      && window.generation === predicate.windowGeneration;
  const verified = targetMatches && (action === 'open'
    ? (value.outcome === 'already_running'
      || (value.outcome === 'launched' && value.finishedLaunching === true))
    : action === 'arrange'
      ? value.operation === 'set_window_frame' && value.attempted === true
        && value.honored === true && object(value.boundsAfter).width > 0
      : value.operation === 'close_window' && value.attempted === true
        && value.honored === true && value.windowGone === true);
  if (!verified) {
    return unverified(
      postcondition,
      delivery,
      `native ${action} receipt did not prove its derived postcondition from read-back state`,
      value,
    );
  }
  return {
    ok: true,
    verification: {
      status: 'verified', postcondition, freshObservation: true, delivery, evidence: value,
    },
  };
}
