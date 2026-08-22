import {
  AppOwnedExecutionSourceBroker,
  executionManifestDigest,
  type AppExecutionManifest,
  type AppExecutionObservation,
  type AppExecutionSource,
  type AppExecutionWorker,
} from '../app.execution.sources';

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const sources: AppExecutionSource[] = [
  'shortcuts', 'jxa', 'keyboard_navigation', 'clipboard_transaction',
];
const manifests: AppExecutionManifest[] = sources.map((source, index) => ({
  version: 1,
  id: `fixture.${source}`,
  source,
  operation: `fixture_${index}`,
  workerDigest: digest(String(index + 1)),
  provenance: `Bimax Desktop fixed ${source} fixture`,
  timeoutMs: 250,
  privacy: source === 'clipboard_transaction' ? 'ephemeral_content' : 'no_content',
  reversible: source === 'clipboard_transaction',
  allowedParameterKeys: source === 'clipboard_transaction' ? ['payloadHandle'] : ['choice'],
}));

function observation(revision: number, epoch = 3): AppExecutionObservation {
  return {
    snapshotId: `snapshot-${revision}`,
    eventRevision: revision,
    targetDigest: digest('a'),
    permissionGranted: true,
    takeoverEpoch: epoch,
  };
}

function setup(options: {
  observations?: AppExecutionObservation[];
  verified?: boolean;
  authorized?: boolean;
  approved?: boolean;
} = {}) {
  const execute = jest.fn(async () => ({
    attempted: true as const, outcome: 'performed' as const, mutationDigest: digest('b'),
  }));
  const rollback = jest.fn(async () => ({
    attempted: true as const, outcome: 'performed' as const, mutationDigest: digest('c'),
  }));
  const workers: AppExecutionWorker[] = sources.map(source => ({
    source, isolated: true, execute, rollback,
  }));
  const rows = [...(options.observations ?? [observation(10), observation(11), observation(12)])];
  const broker = new AppOwnedExecutionSourceBroker(manifests, workers, {
    authorizeTrustedPlan: async () => options.authorized ?? true,
    approve: async () => options.approved ?? true,
    observe: async () => rows.shift() ?? observation(99),
    verifyPostcondition: async () => ({
      verified: options.verified ?? true,
      ...(options.verified === false ? {} : { evidenceDigest: digest('d') }),
    }),
    verifyRollback: async () => ({ verified: true, evidenceDigest: digest('e') }),
  });
  return { broker, execute, rollback };
}

describe('Phase 6 app-owned execution source broker', () => {
  test.each(manifests)('$source stays behind the bounded verified broker', async (manifest) => {
    const fixture = setup();
    const receipt = await fixture.broker.executeFromMacControl({
      operationId: manifest.id,
      taskId: 'authenticated-task',
      parameters: manifest.source === 'clipboard_transaction'
        ? { payloadHandle: 'ephemeral-opaque-handle' } : { choice: 1 },
      expectedPostcondition: { state: 'fixture-complete' },
    });
    expect(receipt).toMatchObject({
      operationId: manifest.id, source: manifest.source, outcome: 'performed',
      attempted: true, verified: true, privacy: manifest.privacy,
      provenance: { workerDigest: manifest.workerDigest },
      beforeSnapshotId: 'snapshot-10', afterSnapshotId: 'snapshot-11',
      evidenceDigest: digest('d'),
    });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.rollback).not.toHaveBeenCalled();
    expect(executionManifestDigest(manifest)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('never accepts model-authored scripts, commands, executables, or paths', async () => {
    const fixture = setup();
    for (const parameters of [
      { script: 'Application.currentApplication().doShellScript("bad")' },
      { command: '/bin/sh' },
      { path: '/tmp/model.js' },
      { executable: '/usr/bin/osascript' },
    ]) {
      await expect(fixture.broker.executeFromMacControl({
        operationId: manifests[1].id, taskId: 'task', parameters,
        expectedPostcondition: { state: 'done' },
      })).resolves.toMatchObject({
        outcome: 'refused', attempted: false, reason: 'execution_parameters_invalid',
      });
    }
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  test.each([
    ['trusted-plan refusal', { authorized: false }, 'trusted_plan_did_not_authorize_operation'],
    ['approval refusal', { approved: false }, 'execution_not_approved'],
    ['permission revoked', { observations: [{ ...observation(10), permissionGranted: false }] }, 'computer_use_permission_revoked'],
  ])('%s stops before effect', async (_label, options, reason) => {
    const fixture = setup(options);
    const receipt = await fixture.broker.executeFromMacControl({
      operationId: manifests[0].id, taskId: 'task', parameters: { choice: 1 },
      expectedPostcondition: { state: 'done' },
    });
    expect(receipt).toMatchObject({ outcome: 'refused', attempted: false, reason });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  test('takeover between observations aborts without fighting the user with a rollback', async () => {
    const fixture = setup({ observations: [observation(10, 8), observation(11, 9)] });
    const receipt = await fixture.broker.executeFromMacControl({
      operationId: manifests[3].id, taskId: 'task',
      parameters: { payloadHandle: 'opaque' }, expectedPostcondition: { changeCount: 3 },
    });
    expect(receipt).toMatchObject({
      outcome: 'refused', attempted: true, verified: false,
      reason: 'takeover_permission_target_or_frame_continuity_failed',
    });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.rollback).not.toHaveBeenCalled();
  });

  test('an unverified reversible clipboard transaction rolls back with independent proof', async () => {
    const fixture = setup({ verified: false });
    const receipt = await fixture.broker.executeFromMacControl({
      operationId: manifests[3].id, taskId: 'task',
      parameters: { payloadHandle: 'opaque' }, expectedPostcondition: { changeCount: 3 },
    });
    expect(receipt).toMatchObject({
      outcome: 'rolled_back', attempted: true, verified: false,
      reason: 'independent_postcondition_unverified',
      rollback: { attempted: true, succeeded: true },
    });
    expect(fixture.rollback).toHaveBeenCalledTimes(1);
  });

  test('an independently unverified irreversible source is never called successful', async () => {
    const fixture = setup({ verified: false });
    const receipt = await fixture.broker.executeFromMacControl({
      operationId: manifests[0].id, taskId: 'task', parameters: { choice: 2 },
      expectedPostcondition: { state: 'done' },
    });
    expect(receipt).toMatchObject({
      outcome: 'refused', attempted: true, verified: false,
      reason: 'independent_postcondition_unverified',
    });
    expect(fixture.rollback).not.toHaveBeenCalled();
  });

  test('an unisolated worker is never admitted', async () => {
    const manifest = manifests[0];
    const worker: AppExecutionWorker = {
      source: manifest.source, isolated: false,
      execute: jest.fn(async () => ({ attempted: true, outcome: 'performed', mutationDigest: digest('b') })),
    };
    const broker = new AppOwnedExecutionSourceBroker([manifest], [worker], {
      authorizeTrustedPlan: async () => true,
      approve: async () => true,
      observe: async () => observation(10),
      verifyPostcondition: async () => ({ verified: true, evidenceDigest: digest('d') }),
      verifyRollback: async () => ({ verified: true, evidenceDigest: digest('e') }),
    });
    await expect(broker.executeFromMacControl({
      operationId: manifest.id, taskId: 'task', parameters: { choice: 1 },
      expectedPostcondition: { state: 'done' },
    })).resolves.toMatchObject({ outcome: 'refused', reason: 'isolated_app_worker_unavailable' });
    expect(worker.execute).not.toHaveBeenCalled();
  });
});
