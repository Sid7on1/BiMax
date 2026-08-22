import { AsyncLocalStorage } from 'async_hooks';
import { createHash, createHmac, randomUUID } from 'crypto';

export const TRUSTED_PLAN_SECRET_ENV = 'BIMAX_CU_TRUSTED_PLAN_SECRET';
export const TRUSTED_PLAN_REQUIRED_ENV = 'BIMAX_CU_TRUSTED_PLAN_REQUIRED';

export interface TrustedComputerPlan {
  version: 1;
  taskId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  instructionHash: string;
  normalizedInstruction: string;
  allowedActions: string[];
}

export interface TrustedComputerPlanEnvelope {
  plan: TrustedComputerPlan;
  signature: string;
}

const activePlan = new AsyncLocalStorage<TrustedComputerPlanEnvelope>();

export function normalizeTrustedInstruction(value: string): string {
  return String(value || '').normalize('NFKC')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function allowedActions(instruction: string): string[] {
  const actions = new Set(['status', 'apps', 'windows', 'observe', 'screenshot', 'frontmost', 'wait']);
  const add = (...values: string[]) => values.forEach(value => actions.add(value));
  if (/\b(?:open|launch|start)\b/.test(instruction)) add('open');
  if (/\b(?:click|press|choose|select|send|submit|confirm|approve|buy|purchase|pay|delete|remove)\b/.test(instruction)) add('click');
  if (/\b(?:type|enter|write|fill|compose|reply|send)\b/.test(instruction)) add('type', 'set_value');
  if (/\b(?:arrange|tile|move|resize|maximi[sz]e|center)\b/.test(instruction)) add('arrange');
  if (/\b(?:close|dismiss)\b/.test(instruction)) add('close');
  return [...actions].sort();
}

function canonicalPlan(plan: TrustedComputerPlan): string {
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

export function signTrustedComputerPlan(
  instruction: string,
  secret = process.env[TRUSTED_PLAN_SECRET_ENV] || '',
  now = Date.now(),
  taskId: string = randomUUID(),
): TrustedComputerPlanEnvelope | undefined {
  if (!secret) return undefined;
  const normalizedInstruction = normalizeTrustedInstruction(instruction);
  const plan: TrustedComputerPlan = {
    version: 1,
    taskId,
    issuedAtMs: now,
    expiresAtMs: now + 15 * 60_000,
    instructionHash: createHash('sha256').update(instruction).digest('hex'),
    normalizedInstruction,
    allowedActions: allowedActions(normalizedInstruction),
  };
  return {
    plan,
    signature: createHmac('sha256', secret).update(canonicalPlan(plan)).digest('base64url'),
  };
}

export function runWithTrustedComputerPlan<T>(instruction: string, operation: () => Promise<T>): Promise<T> {
  const envelope = signTrustedComputerPlan(instruction);
  return envelope ? activePlan.run(envelope, operation) : operation();
}

export function getActiveTrustedComputerPlan(): TrustedComputerPlanEnvelope | undefined {
  return activePlan.getStore();
}
