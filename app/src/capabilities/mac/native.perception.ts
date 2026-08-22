import {
  classifyAxReadiness,
  nextAxReadinessPrevious,
  type AxReadinessObservation,
  type AxReadinessPrevious,
  type AxReadinessSignals,
} from './ax.readiness';

export type NativePerceptionPhase = 'workspace' | 'observe' | 'capture' | 'verification';

export interface NativePerceptionTiming {
  phase: NativePerceptionPhase;
  durationMs: number;
}

export interface NativeLatencySummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface NativeSnapshotAuthority {
  usable: boolean;
  cache: 'disabled_pending_mutation_proof';
  reason: string;
}

interface SnapshotLike {
  snapshotId?: unknown;
  pid?: unknown;
  windowId?: unknown;
  windowGeneration?: unknown;
  eventRevision?: unknown;
  eventTracking?: unknown;
  truncated?: unknown;
  partial?: unknown;
  changedDuringCapture?: unknown;
  baseSnapshotId?: unknown;
  diff?: unknown;
  query?: unknown;
  nodes?: unknown;
}

const TARGETABLE_ROLES = new Set([
  'axbutton', 'axcheckbox', 'axcombobox', 'axlink', 'axmenuitem', 'axradiobutton',
  'axslider', 'axtextfield', 'axtextarea', 'axsearchfield', 'axpopbutton', 'axcell',
]);
const EDITABLE_ROLES = new Set(['axtextfield', 'axtextarea', 'axsearchfield', 'axcombobox']);

function finiteDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value * 1_000) / 1_000) : 0;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

/** Separate native timing buckets. The numbers are evidence, never an action-authority input. */
export class NativePerceptionLatency {
  private readonly samples = new Map<NativePerceptionPhase, number[]>();

  async measure<T>(phase: NativePerceptionPhase, operation: () => Promise<T>): Promise<{
    value: T;
    timing: NativePerceptionTiming;
  }> {
    const started = process.hrtime.bigint();
    try {
      return { value: await operation(), timing: this.record(phase, started) };
    } catch (error) {
      this.record(phase, started);
      throw error;
    }
  }

  summary(): Record<NativePerceptionPhase, NativeLatencySummary> {
    const result = {} as Record<NativePerceptionPhase, NativeLatencySummary>;
    for (const phase of ['workspace', 'observe', 'capture', 'verification'] as const) {
      const values = this.samples.get(phase) ?? [];
      result[phase] = {
        count: values.length,
        p50Ms: percentile(values, 0.5),
        p95Ms: percentile(values, 0.95),
        maxMs: values.length ? Math.max(...values) : 0,
      };
    }
    return result;
  }

  private record(phase: NativePerceptionPhase, started: bigint): NativePerceptionTiming {
    const durationMs = finiteDuration(Number(process.hrtime.bigint() - started) / 1_000_000);
    const values = this.samples.get(phase) ?? [];
    values.push(durationMs);
    this.samples.set(phase, values);
    return { phase, durationMs };
  }
}

export function nativeSnapshotAuthority(snapshot: SnapshotLike): NativeSnapshotAuthority {
  const cache = 'disabled_pending_mutation_proof' as const;
  if (typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId) {
    return { usable: false, cache, reason: 'snapshot identity is missing' };
  }
  if (!Number.isSafeInteger(snapshot.pid) || Number(snapshot.pid) <= 0) {
    return { usable: false, cache, reason: 'snapshot pid is invalid' };
  }
  if (!Number.isSafeInteger(snapshot.windowId) || Number(snapshot.windowId) <= 0
      || !Number.isSafeInteger(snapshot.windowGeneration) || Number(snapshot.windowGeneration) < 0) {
    return { usable: false, cache, reason: 'snapshot is not bound to an exact window generation' };
  }
  if (snapshot.eventTracking !== true || !Number.isSafeInteger(snapshot.eventRevision)) {
    return { usable: false, cache, reason: 'snapshot has no event-tracked revision' };
  }
  if (snapshot.truncated === true || snapshot.partial === true || snapshot.changedDuringCapture === true) {
    return { usable: false, cache, reason: 'snapshot is incomplete or changed during capture' };
  }
  if (snapshot.baseSnapshotId !== undefined || snapshot.diff !== undefined || snapshot.query !== undefined) {
    return { usable: false, cache, reason: 'diff or filtered observations cannot authorize actions' };
  }
  if (!Array.isArray(snapshot.nodes)) {
    return { usable: false, cache, reason: 'snapshot has no full node array' };
  }
  return { usable: true, cache, reason: 'complete event-tracked full snapshot' };
}

function signalsFrom(nodes: readonly Record<string, unknown>[], backgroundBlockedBy?: string): AxReadinessSignals {
  let targetableCount = 0;
  let namedTargetableCount = 0;
  let editableCount = 0;
  for (const node of nodes) {
    const role = typeof node.role === 'string' ? node.role.toLocaleLowerCase() : '';
    const actions = Array.isArray(node.actions) ? node.actions : [];
    const targetable = node.enabled !== false && (TARGETABLE_ROLES.has(role) || actions.length > 0);
    if (!targetable) continue;
    targetableCount += 1;
    if ([node.label, node.identifier, node.value].some(value => typeof value === 'string' && value.trim())) {
      namedTargetableCount += 1;
    }
    if (EDITABLE_ROLES.has(role)) editableCount += 1;
  }
  return { targetableCount, namedTargetableCount, editableCount, ...(backgroundBlockedBy ? { backgroundBlockedBy } : {}) };
}

/** Readiness history is exact-window scoped. A new generation never inherits an old verdict. */
export class NativePerceptionReadiness {
  private readonly windows = new Map<string, { previous: AxReadinessPrevious; attempts: number }>();

  observe(snapshot: SnapshotLike): AxReadinessObservation {
    const key = `${String(snapshot.pid)}:${String(snapshot.windowId)}:${String(snapshot.windowGeneration)}`;
    const prior = this.windows.get(key);
    const raw = snapshot as Record<string, unknown>;
    const backgroundBlockedBy = typeof raw.backgroundBlockedBy === 'string'
      ? raw.backgroundBlockedBy : undefined;
    const readiness = classifyAxReadiness(
      signalsFrom(Array.isArray(snapshot.nodes) ? snapshot.nodes.map(node => (node && typeof node === 'object' ? node as Record<string, unknown> : {})) : [], backgroundBlockedBy),
      prior?.previous,
      prior?.attempts ?? 0,
    );
    this.windows.set(key, {
      previous: nextAxReadinessPrevious(readiness),
      attempts: (prior?.attempts ?? 0) + 1,
    });
    return readiness;
  }

  clear(): void {
    this.windows.clear();
  }
}
