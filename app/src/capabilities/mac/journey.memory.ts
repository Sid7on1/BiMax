import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
export { DESKTOP_CU_DATA_ENV } from '../../shared/cu.storage';

/**
 * Desktop-owned, privacy-minimal workflow memory for Computer Use.
 *
 * A journey is evidence-derived guidance, never action authority. It deliberately contains no
 * coordinates, element tokens, visible labels, typed values, screenshots, or normalized user
 * instruction. Replay must obtain a new authoritative observation immediately before every step
 * and execute that step through the ordinary logical ladder.
 */

export const JOURNEY_STORE_VERSION = 1 as const;
export const MAX_JOURNEYS = 64;
export const MAX_JOURNEY_STEPS = 32;
export const MAX_JOURNEY_FILE_BYTES = 512 * 1024;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ACTIONS = new Set(['click', 'arrange', 'close', 'open']);

export interface JourneyAppIdentity {
  bundleId: string;
  version: string;
}

export interface JourneyTargetIdentity {
  /** Digest of stable window identity fields, not its title or contents. */
  windowFingerprint: string;
  /** Digest of role + identifier + label. Raw semantic content is never persisted. */
  semanticFingerprint: string;
}

export interface JourneyStep {
  index: number;
  action: 'click' | 'arrange' | 'close' | 'open';
  target: JourneyTargetIdentity;
  postconditionDigest: string;
  receiptDigest: string;
}

export interface ReceiptBackedJourney {
  version: typeof JOURNEY_STORE_VERSION;
  id: string;
  intentDigest: string;
  app: JourneyAppIdentity;
  steps: JourneyStep[];
  createdAtMs: number;
  updatedAtMs: number;
}

interface JourneyFile {
  version: typeof JOURNEY_STORE_VERSION;
  journeys: ReceiptBackedJourney[];
}

export interface JourneyRetentionPolicy {
  enabled: boolean;
  exportEnabled: boolean;
  maxAgeMs: number;
}

export interface FreshJourneyObservation {
  app: JourneyAppIdentity;
  windowFingerprint: string;
  semanticFingerprint: string;
  frameId: string;
  eventRevision: number;
  permissionGranted: boolean;
  takeoverEpoch: number;
}

export interface JourneyExecutionReceipt {
  verified: boolean;
  action: string;
  receiptDigest: string;
  frameId: string;
  eventRevisionAfter: number;
}

export interface JourneyReplayHooks {
  /** Must return a newly captured full snapshot for this one step. */
  observe: (step: JourneyStep) => Promise<FreshJourneyObservation>;
  /** Must call the normal mac_control ladder, including approval and typed postcondition checks. */
  executeThroughLadder: (
    step: JourneyStep,
    observation: FreshJourneyObservation,
  ) => Promise<JourneyExecutionReceipt>;
}

export interface JourneyReplayReceipt {
  journeyId: string;
  outcome: 'performed' | 'refused';
  validatedSteps: number;
  executedSteps: number;
  stoppedAtStep?: number;
  reason?: string;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function normalizedIntentDigest(intent: string): string {
  const normalized = String(intent || '').normalize('NFKC')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  return sha256(normalized);
}

export function semanticFingerprint(input: {
  role?: unknown; identifier?: unknown; label?: unknown;
}): string {
  const field = (value: unknown) => typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase() : '';
  return sha256(JSON.stringify({
    role: field(input.role), identifier: field(input.identifier), label: field(input.label),
  }));
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function validJourney(value: unknown): value is ReceiptBackedJourney {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as ReceiptBackedJourney;
  return row.version === JOURNEY_STORE_VERSION
    && typeof row.id === 'string' && row.id.length <= 128
    && validDigest(row.intentDigest)
    && typeof row.app?.bundleId === 'string' && row.app.bundleId.length <= 256
    && typeof row.app?.version === 'string' && row.app.version.length <= 128
    && Array.isArray(row.steps) && row.steps.length <= MAX_JOURNEY_STEPS
    && row.steps.every((step, index) => step.index === index && SAFE_ACTIONS.has(step.action)
      && validDigest(step.target?.windowFingerprint)
      && validDigest(step.target?.semanticFingerprint)
      && validDigest(step.postconditionDigest) && validDigest(step.receiptDigest))
    && Number.isSafeInteger(row.createdAtMs) && Number.isSafeInteger(row.updatedAtMs);
}

export class ReceiptBackedJourneyStore {
  private readonly filePath: string;

  constructor(
    desktopDataDirectory: string,
    private readonly retention: JourneyRetentionPolicy,
    private readonly now: () => number = Date.now,
  ) {
    if (!path.isAbsolute(desktopDataDirectory)) throw new Error('journey_store_requires_absolute_desktop_data_directory');
    this.filePath = path.join(desktopDataDirectory, 'computer-use', 'journeys.v1.json');
  }

  private async load(): Promise<JourneyFile> {
    if (!this.retention.enabled) return { version: JOURNEY_STORE_VERSION, journeys: [] };
    try {
      const bytes = await readFile(this.filePath);
      if (bytes.byteLength > MAX_JOURNEY_FILE_BYTES) throw new Error('journey_store_exceeds_bounded_size');
      const parsed = JSON.parse(bytes.toString('utf8')) as JourneyFile;
      if (parsed.version !== JOURNEY_STORE_VERSION || !Array.isArray(parsed.journeys)) {
        throw new Error('journey_store_version_invalid');
      }
      const cutoff = this.now() - Math.max(0, this.retention.maxAgeMs);
      return {
        version: JOURNEY_STORE_VERSION,
        journeys: parsed.journeys.filter(validJourney).filter(row => row.updatedAtMs >= cutoff).slice(-MAX_JOURNEYS),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return { version: JOURNEY_STORE_VERSION, journeys: [] };
      throw error;
    }
  }

  private async save(file: JourneyFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const serialized = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_JOURNEY_FILE_BYTES) throw new Error('journey_store_exceeds_bounded_size');
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, this.filePath);
  }

  async remember(input: {
    intent: string;
    app: JourneyAppIdentity;
    steps: Omit<JourneyStep, 'index'>[];
  }): Promise<ReceiptBackedJourney | null> {
    if (!this.retention.enabled) return null;
    if (!input.app.bundleId.trim() || !input.app.version.trim()) throw new Error('journey_app_identity_required');
    if (!input.steps.length || input.steps.length > MAX_JOURNEY_STEPS) throw new Error('journey_step_count_invalid');
    const steps = input.steps.map((step, index): JourneyStep => ({ ...step, index }));
    const now = this.now();
    const journey: ReceiptBackedJourney = {
      version: JOURNEY_STORE_VERSION,
      id: randomUUID(),
      intentDigest: normalizedIntentDigest(input.intent),
      app: { bundleId: input.app.bundleId, version: input.app.version },
      steps,
      createdAtMs: now,
      updatedAtMs: now,
    };
    if (!validJourney(journey)) throw new Error('journey_record_invalid_or_contains_unbounded_data');
    const file = await this.load();
    const key = `${journey.app.bundleId}\u0000${journey.intentDigest}`;
    const kept = file.journeys.filter(row => `${row.app.bundleId}\u0000${row.intentDigest}` !== key);
    await this.save({ version: JOURNEY_STORE_VERSION, journeys: [...kept, journey].slice(-MAX_JOURNEYS) });
    return journey;
  }

  async find(app: JourneyAppIdentity, intent: string): Promise<ReceiptBackedJourney | null> {
    const intentDigest = normalizedIntentDigest(intent);
    const file = await this.load();
    return [...file.journeys].reverse().find(row => row.app.bundleId === app.bundleId
      && row.app.version === app.version && row.intentDigest === intentDigest) ?? null;
  }

  async replay(journey: ReceiptBackedJourney, hooks: JourneyReplayHooks): Promise<JourneyReplayReceipt> {
    const base = { journeyId: journey.id, validatedSteps: 0, executedSteps: 0 };
    if (!validJourney(journey)) return { ...base, outcome: 'refused', reason: 'journey_record_invalid' };
    let takeoverEpoch: number | undefined;
    let previousFrameId: string | undefined;
    let previousRevision = -1;
    for (const step of journey.steps) {
      const observation = await hooks.observe(step);
      const refuse = (reason: string): JourneyReplayReceipt => ({
        ...base, outcome: 'refused', validatedSteps: step.index,
        executedSteps: step.index, stoppedAtStep: step.index, reason,
      });
      if (!observation.permissionGranted) return refuse('computer_use_permission_revoked');
      if (takeoverEpoch === undefined) takeoverEpoch = observation.takeoverEpoch;
      else if (observation.takeoverEpoch !== takeoverEpoch) return refuse('user_takeover_intervened');
      if (observation.app.bundleId !== journey.app.bundleId || observation.app.version !== journey.app.version) {
        return refuse('application_identity_or_version_changed');
      }
      if (observation.windowFingerprint !== step.target.windowFingerprint) return refuse('target_window_changed');
      if (observation.semanticFingerprint !== step.target.semanticFingerprint) return refuse('semantic_fingerprint_changed');
      if (!observation.frameId || observation.frameId === previousFrameId
          || observation.eventRevision < previousRevision) return refuse('fresh_frame_required');
      base.validatedSteps += 1;
      previousFrameId = observation.frameId;
      previousRevision = observation.eventRevision;
      const receipt = await hooks.executeThroughLadder(step, observation);
      if (!receipt.verified || receipt.action !== step.action || receipt.frameId !== observation.frameId
          || !validDigest(receipt.receiptDigest) || receipt.eventRevisionAfter <= observation.eventRevision) {
        return {
          ...base, outcome: 'refused', executedSteps: step.index,
          stoppedAtStep: step.index, reason: 'ordinary_ladder_did_not_prove_exact_postcondition',
        };
      }
      base.executedSteps += 1;
      previousRevision = receipt.eventRevisionAfter;
    }
    return { ...base, outcome: 'performed' };
  }

  async exportRedacted(): Promise<string> {
    if (!this.retention.enabled || !this.retention.exportEnabled) throw new Error('journey_export_not_authorized');
    const file = await this.load();
    // The stored form is already redacted. Rebuild the payload explicitly so future private fields
    // cannot become exports merely by being added to the in-memory interface.
    return JSON.stringify({
      version: JOURNEY_STORE_VERSION,
      journeys: file.journeys.map(row => ({
        version: row.version, id: row.id, intentDigest: row.intentDigest, app: row.app,
        createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs,
        steps: row.steps.map(step => ({
          index: step.index, action: step.action, target: step.target,
          postconditionDigest: step.postconditionDigest, receiptDigest: step.receiptDigest,
        })),
      })),
    }, null, 2);
  }
}
