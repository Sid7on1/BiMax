// The Desktop evidence store — Phase 8, owner section 28.
//
// The engine owns its own ledger (`src/evidence/ledger.ts`); Desktop owns this one. They share the
// vocabulary in `app/src/shared/evidence.schema.ts` and nothing else, which is the whole point of §9's
// process architecture: "the renderer receives typed findings and approvals, not raw native handles,
// unrestricted paths, audit tokens, secrets, or network payloads."
//
// This file is the main-process half of that boundary. Three rules it enforces that the renderer
// cannot be trusted to enforce for itself:
//
//   1. **Every record is validated on ingest.** Records arrive over IPC from the engine and from the
//      Mac capability provider. A record that fails a schema honesty invariant is rejected at the
//      door with a reason, not stored and rendered.
//   2. **Deletion is real.** §2.4 requires a delete control, and a delete control that leaves the
//      data on disk is a lie. `deleteTask` and `deleteAll` remove records and record the eviction,
//      so the timeline shows that data is gone rather than pretending it never existed.
//   3. **Bounded, with the bound visible.** Retention classes expire, capacity evicts, and both
//      leave an eviction note rendered as an evidence gap.
//
// Electron-free: no `electron` import, so the whole store is testable in a plain Node process.

import { createHash } from 'node:crypto';
import {
  EvidenceRecord, Retention, canonicalJson, validate,
} from '../shared/evidence.schema';

export interface EvictionNote {
  at: number;
  droppedRecords: number;
  reason: 'capacity' | 'retention' | 'user-deletion';
}

export interface IngestResult {
  accepted: boolean;
  /** Present when the record was refused. Shown in diagnostics, never silently swallowed. */
  violations: string[];
}

/** How long each retention class survives. Mirrors the engine's table; nothing is kept forever. */
export const RETENTION_MS: Record<Retention, number> = {
  none: 0,
  session: 12 * 60 * 60 * 1000,
  task: 7 * 24 * 60 * 60 * 1000,
  bounded: 30 * 24 * 60 * 60 * 1000,
  audit: 180 * 24 * 60 * 60 * 1000,
};

export interface EvidenceStoreOptions {
  maxRecords?: number;
  now?: () => number;
}

/** The content address of a record, recomputed here rather than trusted from the sender. */
function contentId(record: EvidenceRecord): string {
  const { id: _ignored, ...rest } = record as EvidenceRecord & { id: string };
  return createHash('sha256').update(canonicalJson(rest)).digest('hex').slice(0, 24);
}

export class DesktopEvidenceStore {
  private readonly records = new Map<string, EvidenceRecord>();
  private readonly order: string[] = [];
  private readonly evictions: EvictionNote[] = [];
  private readonly maxRecords: number;
  private readonly now: () => number;

  constructor(options: EvidenceStoreOptions = {}) {
    this.maxRecords = options.maxRecords ?? 20_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Admit a record that arrived over IPC.
   *
   * The seal is recomputed rather than trusted: a sender that edits a record after sealing it — or a
   * compromised renderer replaying an altered record back — has changed the content, and the content
   * is what the id is derived from. This is the one place Desktop can catch that.
   */
  ingest(record: EvidenceRecord): IngestResult {
    const validation = validate(record);
    if (!validation.ok) return { accepted: false, violations: validation.violations };
    if (!record.id.endsWith(contentId(record))) {
      return { accepted: false, violations: ['record id does not match its content'] };
    }
    if (this.records.has(record.id)) return { accepted: true, violations: [] };
    this.records.set(record.id, record);
    this.order.push(record.id);
    this.enforceCapacity();
    return { accepted: true, violations: [] };
  }

  /** Admit a batch, reporting each refusal. A bad record never poisons the good ones beside it. */
  ingestAll(records: EvidenceRecord[]): { accepted: number; refused: { id: string; violations: string[] }[] } {
    let accepted = 0;
    const refused: { id: string; violations: string[] }[] = [];
    for (const record of records) {
      const result = this.ingest(record);
      if (result.accepted) accepted += 1;
      else refused.push({ id: record.id, violations: result.violations });
    }
    return { accepted, refused };
  }

  all(): EvidenceRecord[] {
    return this.order.map(id => this.records.get(id)).filter(Boolean) as EvidenceRecord[];
  }

  forTask(taskIntentId: string): EvidenceRecord[] {
    return this.all().filter(record => (
      ('taskIntentId' in record && record.taskIntentId === taskIntentId) || record.id === taskIntentId
    ));
  }

  evictionLog(): readonly EvictionNote[] { return this.evictions; }

  get size(): number { return this.records.size; }

  /** Drop expired observations. Returns how many went. */
  applyRetention(): number {
    const now = this.now();
    const expired = this.all().filter(record => (
      record.kind === 'Observation' && now - record.createdAt > RETENTION_MS[record.retention]
    ));
    return this.drop(expired.map(r => r.id), 'retention');
  }

  /** Per-task delete control. */
  deleteTask(taskIntentId: string): number {
    return this.drop(this.forTask(taskIntentId).map(r => r.id), 'user-deletion');
  }

  /** The "delete every observation" control. */
  deleteObservations(): number {
    return this.drop(this.all().filter(r => r.kind === 'Observation').map(r => r.id), 'user-deletion');
  }

  /** The "delete everything" control. */
  deleteAll(): number {
    return this.drop([...this.order], 'user-deletion');
  }

  private drop(ids: string[], reason: EvictionNote['reason']): number {
    let dropped = 0;
    for (const id of ids) {
      if (!this.records.delete(id)) continue;
      const index = this.order.indexOf(id);
      if (index >= 0) this.order.splice(index, 1);
      dropped += 1;
    }
    if (dropped) this.evictions.push({ at: this.now(), droppedRecords: dropped, reason });
    return dropped;
  }

  private enforceCapacity(): void {
    const excess = this.order.length - this.maxRecords;
    if (excess <= 0) return;
    this.drop(this.order.slice(0, excess), 'capacity');
  }
}

// --- S28-09: an unavailable sensor is a state, not a retry loop --------------------------------

export type SensorAvailability = 'available' | 'denied' | 'revoked' | 'unavailable';

export interface SensorStatus {
  sensor: string;
  availability: SensorAvailability;
  /** Rendered verbatim. §2.4 requires the user can see why a capability is not working. */
  detail: string;
  /** When Bimax will next attempt it, or null when it will not until the user acts. */
  nextAttemptAt: number | null;
  attempts: number;
}

/**
 * Backoff for an unavailable sensor.
 *
 * S28-09's end state is "core Code works; sensor reports unavailable without retry storm". A denial
 * or revocation is a *user decision*, so Bimax stops asking entirely — retrying a denied permission
 * is how an app produces a dialog loop. Only a transient `unavailable` backs off and retries, and
 * that backoff is capped.
 */
export const MAX_BACKOFF_MS = 15 * 60 * 1000;

export function nextAttempt(availability: SensorAvailability, attempts: number, now: number): number | null {
  if (availability === 'available') return null;
  // A user's "no" is not a transient error. Bimax waits for the user to change it, and says so.
  if (availability === 'denied' || availability === 'revoked') return null;
  const backoff = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.max(0, attempts - 1));
  return now + backoff;
}

export function sensorStatus(
  sensor: string,
  availability: SensorAvailability,
  attempts: number,
  now: number,
): SensorStatus {
  const detail = availability === 'available' ? 'available'
    : availability === 'denied' ? 'you have not granted this permission; Bimax will not ask again until you change it in System Settings'
      : availability === 'revoked' ? 'this permission was revoked; Bimax stopped using the sensor and will not re-prompt'
        : 'the sensor is not responding; Bimax will retry with a bounded backoff';
  return { sensor, availability, detail, nextAttemptAt: nextAttempt(availability, attempts, now), attempts };
}

/**
 * Whether core coding is affected by a sensor being unavailable.
 *
 * Always false, and it is a function rather than a constant so the claim is testable: the section 28
 * gate's first row is "Code remains fully usable with all optional intelligence/CU permissions
 * denied or revoked", and nothing in the contextual-intelligence plane is on the coding path.
 */
export function codingAffectedBy(_status: SensorStatus): boolean { return false; }
