import { cliEvents } from '../cli/events';

export type CapabilityState = 'degraded' | 'unavailable' | 'ready';
export interface CapabilityStatus {
  id: string;
  label: string;
  state: CapabilityState;
  reason: string;
  impact: string;
  action: string;
  observedAt: string;
}

/** Operational state, not a claim that unused capabilities have been tested. No raw errors,
 * credentials, URLs, arguments or document contents belong in this channel. */
const states = new Map<string, CapabilityStatus>();
let sequence = 0;
export function capabilityMessage(status: CapabilityStatus) {
  return {
    id: `capability-${++sequence}`, role: 'system' as const,
    level: status.state === 'ready' ? 'success' as const : 'warn' as const,
    content: `${status.label}: ${status.state === 'ready' ? 'recovered' : status.state}. ${status.reason} ${status.impact} ${status.action}`.trim(),
    timestamp: new Date(status.observedAt), payload: { capabilityStatus: status },
  };
}
export function reportCapability(input: Omit<CapabilityStatus, 'observedAt'>): void {
  if (!states.has(input.id) && input.state === 'ready') return;
  const status = { ...input, observedAt: new Date().toISOString() };
  // Reserve one slot for overflow. Never evict an unresolved failure to show another one.
  if (states.size >= 127 && !states.has(input.id)) {
    const recovered = [...states].find(([, value]) => value.state === 'ready');
    if (recovered) states.delete(recovered[0]);
    else Object.assign(status, {
      id: 'additional-capabilities', label: 'Additional capabilities', state: 'unavailable',
      reason: 'Additional operational failures occurred; inspect the task results.',
      impact: 'Some additional operations could not complete.',
      action: 'Resolve the reported task failures and restart the engine to recheck.',
    });
  }
  const previous = states.get(status.id);
  if (previous && previous.state === status.state && previous.reason === status.reason
    && previous.impact === status.impact && previous.action === status.action) return;
  states.set(status.id, status);
  cliEvents.emit('message', capabilityMessage(status));
}
export function capabilitySnapshot(): CapabilityStatus[] { return [...states.values()]; }
export function resetCapabilityStatus(): void { states.clear(); }

/** Abort plus a deadline race: a transport or credential resolver that ignores abort cannot
 * hold retrieval forever. The rejected race never commits late provider output. */
export async function capabilityDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Capability deadline exceeded')); }, ms);
      }),
    ]);
  } finally { clearTimeout(timer!); }
}

/** Diagnostic endpoint identity excludes userinfo, query strings and fragments. */
export function capabilityEndpoint(value: string): string {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
  catch { return 'configured endpoint'; }
}
