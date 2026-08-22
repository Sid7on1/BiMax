import { createHmac, timingSafeEqual } from 'node:crypto';
import { classifyMacActionImpact } from './action.impact';

export const TRUSTED_PLAN_SECRET_ENV = 'BIMAX_CU_TRUSTED_PLAN_SECRET';
export const TRUSTED_PLAN_REQUIRED_ENV = 'BIMAX_CU_TRUSTED_PLAN_REQUIRED';

export interface VerifiedTrustedPlan {
  version: 1;
  taskId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  instructionHash: string;
  normalizedInstruction: string;
  allowedActions: string[];
}

export interface TrustedBranchDecision {
  taskId?: string;
  action: string;
  decision: 'allowed' | 'blocked' | 'not_required';
  trustedFields: string[];
  untrustedFields: string[];
  reason: string;
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any> : {};
}

export function normalizeTrustedText(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase() : '';
}

function canonicalPlan(plan: VerifiedTrustedPlan): string {
  return JSON.stringify({
    version: plan.version,
    taskId: plan.taskId,
    issuedAtMs: plan.issuedAtMs,
    expiresAtMs: plan.expiresAtMs,
    instructionHash: plan.instructionHash,
    normalizedInstruction: plan.normalizedInstruction,
    allowedActions: [...plan.allowedActions],
  });
}

export function verifyTrustedPlan(context: unknown, now = Date.now()): VerifiedTrustedPlan | null {
  const envelope = object(object(context).trustedPlan);
  const candidate = object(envelope.plan) as Partial<VerifiedTrustedPlan>;
  const secret = process.env[TRUSTED_PLAN_SECRET_ENV] || '';
  if (!secret || candidate.version !== 1 || typeof candidate.taskId !== 'string'
      || typeof candidate.issuedAtMs !== 'number' || typeof candidate.expiresAtMs !== 'number'
      || typeof candidate.instructionHash !== 'string' || typeof candidate.normalizedInstruction !== 'string'
      || !Array.isArray(candidate.allowedActions)
      || candidate.issuedAtMs > now + 30_000 || candidate.expiresAtMs < now
      || candidate.expiresAtMs - candidate.issuedAtMs > 15 * 60_000
      || typeof envelope.signature !== 'string') return null;
  const plan = candidate as VerifiedTrustedPlan;
  const expected = createHmac('sha256', secret).update(canonicalPlan(plan)).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(envelope.signature, 'base64url'); } catch { return null; }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? plan : null;
}

function explicitlyGrounded(value: unknown, instruction: string): boolean {
  const normalized = normalizeTrustedText(value);
  return !!normalized && instruction.includes(normalized);
}

/**
 * Deterministic control-flow guard. Observation text may select a low-impact branch inside an
 * already-authorized verb, but it cannot add verbs or supply a high-impact destination.
 */
export function authorizeTrustedBranch(
  action: string,
  command: Record<string, unknown>,
  selectedNode: Record<string, unknown> | undefined,
  context: unknown,
): TrustedBranchDecision {
  const required = process.env[TRUSTED_PLAN_REQUIRED_ENV] === '1';
  const plan = verifyTrustedPlan(context);
  if (!required && !plan) {
    return { action, decision: 'not_required', trustedFields: [], untrustedFields: [], reason: 'trusted-plan enforcement is not enabled on this host' };
  }
  if (!plan) {
    return { action, decision: 'blocked', trustedFields: [], untrustedFields: [], reason: 'missing, expired, or invalid authenticated task plan' };
  }
  const base = {
    taskId: plan.taskId,
    action,
    trustedFields: ['action'],
    untrustedFields: selectedNode ? ['selectedNode.role', 'selectedNode.label', 'selectedNode.value'] : [],
  };
  if (!plan.allowedActions.includes(action)) {
    return { ...base, decision: 'blocked', reason: `action ${action} is outside the pre-observation branch graph` };
  }
  if (action === 'open') {
    const target = command.bundleId ?? command.app;
    if (!explicitlyGrounded(target, plan.normalizedInstruction)) {
      return { ...base, decision: 'blocked', reason: 'application target originates outside the trusted instruction' };
    }
    base.trustedFields.push(command.bundleId ? 'bundleId' : 'app');
  }
  if (action === 'type' || action === 'set_value') {
    const value = action === 'type' ? command.text : command.value;
    if (!explicitlyGrounded(value, plan.normalizedInstruction)) {
      return { ...base, decision: 'blocked', reason: 'text payload originates outside the trusted instruction' };
    }
    base.trustedFields.push(action === 'type' ? 'text' : 'value');
  }
  const impact = classifyMacActionImpact(action, {
    ...Object.fromEntries(Object.entries(command).map(([key, value]) => [
      key, typeof value === 'string' ? normalizeTrustedText(value) : value,
    ])),
    selectedRole: normalizeTrustedText(selectedNode?.role),
    selectedLabel: normalizeTrustedText(selectedNode?.label),
  });
  if (impact.high) {
    const observationLabel = normalizeTrustedText(selectedNode?.label);
    if (observationLabel && !plan.normalizedInstruction.includes(observationLabel)) {
      return { ...base, decision: 'blocked', reason: `high-impact target is observation-only (${impact.reason})` };
    }
  }
  const selectedRole = normalizeTrustedText(selectedNode?.role);
  const selectedLabel = normalizeTrustedText(selectedNode?.label);
  const destinationRole = new Set(['axcell', 'axrow', 'axlistitem', 'axlink']);
  const externalIdentifier = /(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/|\b\+?\d[\d ()-]{6,}\d\b)/i;
  if (selectedLabel
      && (destinationRole.has(selectedRole) || externalIdentifier.test(selectedLabel))
      && !plan.normalizedInstruction.includes(selectedLabel)) {
    return {
      ...base,
      decision: 'blocked',
      reason: 'recipient or external destination is observation-only',
    };
  }
  return { ...base, decision: 'allowed', reason: impact.high ? 'high-impact branch is explicitly grounded in the trusted instruction' : 'low-impact branch stays inside the authenticated action graph' };
}
