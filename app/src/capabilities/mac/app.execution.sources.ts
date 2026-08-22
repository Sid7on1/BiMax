import { createHash } from 'node:crypto';

/**
 * Phase 6 broker for additional Desktop-owned execution sources.
 *
 * This is intentionally not a shell adapter. The model selects only a pre-registered operation ID;
 * the corresponding app-owned worker owns its fixed executable/script/shortcut. Every call still
 * needs trusted-plan admission, takeover continuity, approval, a deadline, and an independently
 * observed postcondition. Nothing in this module is registered as an engine or Terminal tool.
 */

export type AppExecutionSource = 'shortcuts' | 'jxa' | 'keyboard_navigation' | 'clipboard_transaction';
export type PrivacyBehavior = 'no_content' | 'redacted_parameters' | 'ephemeral_content';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_PARAMETER_KEYS = new Set([
  'script', 'source', 'javascript', 'shell', 'command', 'executable', 'path', 'workingDirectory',
]);

export interface AppExecutionManifest {
  version: 1;
  id: string;
  source: AppExecutionSource;
  operation: string;
  workerDigest: string;
  provenance: string;
  timeoutMs: number;
  privacy: PrivacyBehavior;
  reversible: boolean;
  allowedParameterKeys: readonly string[];
}

export interface AppExecutionRequest {
  operationId: string;
  taskId: string;
  parameters: Record<string, string | number | boolean>;
  expectedPostcondition: Record<string, string | number | boolean>;
}

export interface AppExecutionObservation {
  snapshotId: string;
  eventRevision: number;
  targetDigest: string;
  permissionGranted: boolean;
  takeoverEpoch: number;
}

export interface AppExecutionAttempt {
  attempted: boolean;
  outcome: 'performed' | 'refused' | 'failed';
  mutationDigest?: string;
  detail?: string;
}

export interface AppExecutionWorker {
  source: AppExecutionSource;
  isolated: boolean;
  execute(
    manifest: AppExecutionManifest,
    request: AppExecutionRequest,
    admission: AppExecutionObservation,
    signal: AbortSignal,
  ): Promise<AppExecutionAttempt>;
  rollback?(
    manifest: AppExecutionManifest,
    request: AppExecutionRequest,
    admission: AppExecutionObservation,
    signal: AbortSignal,
  ): Promise<AppExecutionAttempt>;
}

export interface AppExecutionBrokerHooks {
  authorizeTrustedPlan: (manifest: AppExecutionManifest, request: AppExecutionRequest) => Promise<boolean>;
  approve: (manifest: AppExecutionManifest, request: AppExecutionRequest) => Promise<boolean>;
  observe: (manifest: AppExecutionManifest, request: AppExecutionRequest) => Promise<AppExecutionObservation>;
  verifyPostcondition: (input: {
    manifest: AppExecutionManifest;
    request: AppExecutionRequest;
    before: AppExecutionObservation;
    after: AppExecutionObservation;
    attempt: AppExecutionAttempt;
  }) => Promise<{ verified: boolean; evidenceDigest?: string }>;
  verifyRollback: (input: {
    manifest: AppExecutionManifest;
    request: AppExecutionRequest;
    before: AppExecutionObservation;
    afterRollback: AppExecutionObservation;
  }) => Promise<{ verified: boolean; evidenceDigest?: string }>;
}

export interface AppExecutionReceipt {
  operationId: string;
  source: AppExecutionSource;
  outcome: 'performed' | 'refused' | 'rolled_back';
  attempted: boolean;
  verified: boolean;
  reason?: string;
  provenance: { workerDigest: string; description: string };
  privacy: PrivacyBehavior;
  timeoutMs: number;
  beforeSnapshotId?: string;
  afterSnapshotId?: string;
  evidenceDigest?: string;
  rollback?: { attempted: boolean; succeeded: boolean };
}

function boundedRecord(value: Record<string, unknown>, allowedKeys?: readonly string[]): boolean {
  const entries = Object.entries(value);
  if (entries.length > 24) return false;
  const allowed = allowedKeys ? new Set(allowedKeys) : null;
  return entries.every(([key, item]) => key.length <= 80
    && !FORBIDDEN_PARAMETER_KEYS.has(key)
    && (!allowed || allowed.has(key))
    && (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))
      || (typeof item === 'string' && item.length <= 4_096)));
}

function validManifest(manifest: AppExecutionManifest): boolean {
  return manifest.version === 1 && /^[a-z0-9][a-z0-9._-]{2,79}$/.test(manifest.id)
    && /^[a-z0-9][a-z0-9._-]{1,79}$/.test(manifest.operation)
    && DIGEST.test(manifest.workerDigest) && manifest.provenance.trim().length > 0
    && manifest.provenance.length <= 512
    && Number.isSafeInteger(manifest.timeoutMs) && manifest.timeoutMs >= 50 && manifest.timeoutMs <= 10_000
    && manifest.allowedParameterKeys.length <= 24
    && manifest.allowedParameterKeys.every(key => !FORBIDDEN_PARAMETER_KEYS.has(key));
}

function timeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('execution_source_timeout'));
    }, timeoutMs);
    operation(controller.signal).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

export function executionManifestDigest(manifest: AppExecutionManifest): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    version: manifest.version, id: manifest.id, source: manifest.source,
    operation: manifest.operation, workerDigest: manifest.workerDigest,
    provenance: manifest.provenance, timeoutMs: manifest.timeoutMs,
    privacy: manifest.privacy, reversible: manifest.reversible,
    allowedParameterKeys: [...manifest.allowedParameterKeys],
  })).digest('hex')}`;
}

export class AppOwnedExecutionSourceBroker {
  private readonly manifests = new Map<string, AppExecutionManifest>();
  private readonly workers = new Map<AppExecutionSource, AppExecutionWorker>();

  constructor(
    manifests: readonly AppExecutionManifest[],
    workers: readonly AppExecutionWorker[],
    private readonly hooks: AppExecutionBrokerHooks,
  ) {
    for (const manifest of manifests) {
      if (!validManifest(manifest)) throw new Error(`invalid_execution_manifest:${manifest.id}`);
      if (this.manifests.has(manifest.id)) throw new Error(`duplicate_execution_manifest:${manifest.id}`);
      this.manifests.set(manifest.id, { ...manifest, allowedParameterKeys: [...manifest.allowedParameterKeys] });
    }
    for (const worker of workers) {
      if (this.workers.has(worker.source)) throw new Error(`duplicate_execution_worker:${worker.source}`);
      this.workers.set(worker.source, worker);
    }
  }

  /** This is the only mutation entrypoint and is intended to be called by mac_control's adapter. */
  async executeFromMacControl(request: AppExecutionRequest): Promise<AppExecutionReceipt> {
    const manifest = this.manifests.get(request.operationId);
    const source = manifest?.source ?? 'shortcuts';
    const provenance = {
      workerDigest: manifest?.workerDigest ?? `sha256:${'0'.repeat(64)}`,
      description: manifest?.provenance ?? 'unregistered',
    };
    const base = {
      operationId: request.operationId, source, attempted: false, verified: false,
      provenance, privacy: manifest?.privacy ?? 'no_content' as PrivacyBehavior,
      timeoutMs: manifest?.timeoutMs ?? 0,
    };
    const refuse = (reason: string): AppExecutionReceipt => ({ ...base, outcome: 'refused', reason });
    if (!manifest) return refuse('execution_operation_not_registered');
    if (!request.taskId.trim()) return refuse('authenticated_task_required');
    if (!boundedRecord(request.parameters, manifest.allowedParameterKeys)
        || !boundedRecord(request.expectedPostcondition)) return refuse('execution_parameters_invalid');
    const worker = this.workers.get(manifest.source);
    if (!worker || worker.source !== manifest.source || !worker.isolated) return refuse('isolated_app_worker_unavailable');
    if (!await this.hooks.authorizeTrustedPlan(manifest, request)) return refuse('trusted_plan_did_not_authorize_operation');
    const before = await this.hooks.observe(manifest, request);
    if (!before.permissionGranted) return refuse('computer_use_permission_revoked');
    if (!DIGEST.test(before.targetDigest)) return refuse('exact_target_identity_unavailable');
    if (!await this.hooks.approve(manifest, request)) return refuse('execution_not_approved');
    let attempt: AppExecutionAttempt;
    try {
      // The exact target and takeover epoch are part of the worker's admission. A real worker must
      // bind them into its native coordinator call so Phase 3/4 authority is rechecked at delivery,
      // not merely observed after an effect.
      attempt = await timeout(signal => worker.execute(manifest, request, before, signal), manifest.timeoutMs);
    } catch (error) {
      return { ...base, outcome: 'refused', attempted: true, reason: error instanceof Error ? error.message : String(error) };
    }
    const after = await this.hooks.observe(manifest, request);
    const continuityFailed = !after.permissionGranted || after.takeoverEpoch !== before.takeoverEpoch
      || after.targetDigest !== before.targetDigest || after.snapshotId === before.snapshotId
      || after.eventRevision <= before.eventRevision;
    const delivered = attempt.attempted && attempt.outcome === 'performed'
      && !!attempt.mutationDigest && DIGEST.test(attempt.mutationDigest);
    const verification = continuityFailed || !delivered
      ? { verified: false }
      : await this.hooks.verifyPostcondition({ manifest, request, before, after, attempt });
    if (delivered && !continuityFailed && verification.verified && verification.evidenceDigest
        && DIGEST.test(verification.evidenceDigest)) {
      return {
        ...base, outcome: 'performed', attempted: true, verified: true,
        beforeSnapshotId: before.snapshotId, afterSnapshotId: after.snapshotId,
        evidenceDigest: verification.evidenceDigest,
      };
    }
    const reason = continuityFailed
      ? 'takeover_permission_target_or_frame_continuity_failed'
      : !delivered ? 'execution_source_did_not_prove_delivery'
        : 'independent_postcondition_unverified';
    // User takeover, permission loss or target drift removes mutation authority. Do not issue a
    // compensating action in that state: even a well-meant rollback would fight the user's hands.
    if (continuityFailed) {
      return {
        ...base, outcome: 'refused', attempted: attempt.attempted, reason,
        beforeSnapshotId: before.snapshotId, afterSnapshotId: after.snapshotId,
      };
    }
    if (!manifest.reversible || !worker.rollback) {
      return {
        ...base, outcome: 'refused', attempted: true, reason,
        beforeSnapshotId: before.snapshotId, afterSnapshotId: after.snapshotId,
      };
    }
    try {
      const rolledBack = await timeout(
        signal => worker.rollback!(manifest, request, before, signal), manifest.timeoutMs,
      );
      const afterRollback = await this.hooks.observe(manifest, request);
      const rollbackContinuity = afterRollback.permissionGranted
        && afterRollback.takeoverEpoch === before.takeoverEpoch
        && afterRollback.targetDigest === before.targetDigest
        && afterRollback.snapshotId !== after.snapshotId
        && afterRollback.eventRevision > after.eventRevision;
      const rollbackProof = rollbackContinuity && rolledBack.attempted && rolledBack.outcome === 'performed'
        ? await this.hooks.verifyRollback({ manifest, request, before, afterRollback })
        : { verified: false };
      const succeeded = rollbackProof.verified && !!rollbackProof.evidenceDigest
        && DIGEST.test(rollbackProof.evidenceDigest);
      return {
        ...base, outcome: succeeded ? 'rolled_back' : 'refused', attempted: true, verified: false,
        reason, beforeSnapshotId: before.snapshotId, afterSnapshotId: after.snapshotId,
        rollback: { attempted: rolledBack.attempted, succeeded },
      };
    } catch {
      return {
        ...base, outcome: 'refused', attempted: true, reason,
        beforeSnapshotId: before.snapshotId, afterSnapshotId: after.snapshotId,
        rollback: { attempted: true, succeeded: false },
      };
    }
  }
}
