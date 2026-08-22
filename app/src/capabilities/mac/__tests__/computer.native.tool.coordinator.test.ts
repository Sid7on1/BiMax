import type { NativeServiceOperationClient } from '../native.bridge.transport';
import { NativeToolCoordinator } from '../native.tool.coordinator';
import { NativeInputInterlock } from '../native.input.interlock';
import { BIMAX_CU_PROTOCOL, type NativeServiceHandshake } from '../native.service.client';

function handshake(): NativeServiceHandshake {
  return {
    selectedProtocol: BIMAX_CU_PROTOCOL,
    serviceVersion: 'test',
    platform: { os: 'macos', version: 'test', architecture: 'arm64' },
    capabilities: {
      observe: {
        profiles: ['flash'], scopes: ['window'], axDiff: true, eventRevisions: true,
        som: true, regionCapture: true, zoom: true, streams: false,
      },
      delivery: {
        policies: ['background_only'], verifiedDeliveryPolicies: ['background_only'],
        semanticActions: ['invoke', 'set_value', 'set_selected'],
        verifiedSemanticActions: ['invoke', 'set_value', 'set_selected'],
        targetedEvents: true, physicalInput: true, focusLease: false, semanticTransactions: true,
      },
      workspace: { apps: true, windows: true, displays: true, spaces: false, files: [], operations: [], verifiedOperations: [] },
      browser: { typedRoute: false, dialogs: false, fileInput: false, downloads: false },
      recording: { trajectory: false, video: false, replayModes: [] },
    },
    limits: {
      maxTransactionSteps: 5, maxElements: 2_000, maxDiffOperations: 5_000,
      maxImageDimension: 4_096, maxConcurrentReadSessions: 4, maxCaptureStreams: 2,
    },
    permissions: {
      accessibility: 'granted', screenRecording: 'granted', screenCapturable: true,
      inputMonitoring: 'not_required', serviceSigned: true,
    },
  };
}

function node(snapshotId: string, token = 'button') {
  return {
    token, role: 'AXButton', label: 'Continue', enabled: true,
    elementRef: {
      token, snapshotId, pid: 42, windowId: 7, windowGeneration: 3,
      axRevision: 11, stablePathHash: `stable-${token}`,
    },
  };
}

function snapshot(sessionId: string, snapshotId = 'snapshot-one') {
  return {
    snapshotId, sessionId, pid: 42, windowId: 7, windowGeneration: 3,
    eventRevision: 11, eventTracking: true, truncated: false, partial: false,
    changedDuringCapture: false, nodes: [node(snapshotId)],
  };
}

function fakeClient() {
  let createResolve: (() => void) | undefined;
  const createGate = new Promise<void>(resolve => { createResolve = resolve; });
  const client = {
    available: jest.fn(() => true),
    createSession: jest.fn(async () => {
      await createGate;
      return { sessionId: 'native-session' };
    }),
    workspace: jest.fn(async () => ({
      apps: [{ app: { pid: 42, displayName: 'Fixture', bundleId: 'ai.bimax.fixture' } }],
    })),
    observe: jest.fn(async () => snapshot('native-session')),
    action: jest.fn(async () => ({ op: 'semantic.action.receipt', payload: { outcome: 'performed' } })),
    transaction: jest.fn(async () => ({ outcome: 'completed' })),
    capture: jest.fn(async () => ({ mode: 'image', image: { handle: 'image-one' } })),
    closeSession: jest.fn(async () => {}),
    dispose: jest.fn(async () => {}),
  };
  return { client: client as unknown as NativeServiceOperationClient, raw: client, release: createResolve! };
}

describe('native operation tool coordinator', () => {
  test('coalesces task session creation and binds app identity to the native PID', async () => {
    const fake = fakeClient();
    const coordinator = new NativeToolCoordinator(handshake(), fake.client);
    const first = coordinator.workspace('task-one', {});
    const second = coordinator.appIdentity('task-one', 42);
    await Promise.resolve();
    expect(fake.raw.createSession).toHaveBeenCalledTimes(1);
    fake.release();
    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBe('Fixture / ai.bimax.fixture');
  });

  test('recreates a retired session once for a read without replaying a mutation', async () => {
    const fake = fakeClient();
    fake.release();
    const coordinator = new NativeToolCoordinator(handshake(), fake.client);
    await coordinator.workspace('task-restart', {});

    fake.raw.workspace
      .mockRejectedValueOnce(Object.assign(new Error('session retired'), { code: 'session_not_found' }))
      .mockResolvedValueOnce({ apps: [] });
    fake.raw.createSession.mockResolvedValueOnce({ sessionId: 'native-session-two' });
    await expect(coordinator.workspace('task-restart', {})).resolves.toEqual({ apps: [] });
    expect(fake.raw.createSession).toHaveBeenCalledTimes(2);
    expect(fake.raw.workspace).toHaveBeenLastCalledWith('native-session-two', {});

    fake.raw.observe.mockResolvedValueOnce(snapshot('native-session-two'));
    await coordinator.observe('task-restart', {});
    const prepared = await coordinator.prepareAction('task-restart', {
      snapshotId: 'snapshot-one', elementToken: 'button', action: 'invoke',
      deliveryPolicy: 'background_only',
    });
    fake.raw.action.mockRejectedValueOnce(Object.assign(
      new Error('session retired during delivery'), { code: 'session_not_found' },
    ));
    await expect(coordinator.performAction('task-restart', prepared)).rejects.toMatchObject({
      code: 'session_not_found',
    });
    expect(fake.raw.action).toHaveBeenCalledTimes(1);
  });

  test('accepts only coordinator-issued, task-bound actions and invalidates authority after delivery', async () => {
    const fake = fakeClient();
    fake.release();
    const coordinator = new NativeToolCoordinator(handshake(), fake.client);
    await coordinator.observe('task-one', { pid: 42, scope: 'window', profile: 'flash' });
    const prepared = await coordinator.prepareAction('task-one', {
      snapshotId: 'snapshot-one', elementToken: 'button', action: 'invoke',
      deliveryPolicy: 'background_only',
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    await expect(coordinator.performAction('task-one', { ...prepared })).rejects.toMatchObject({
      code: 'unsigned_action',
    });
    await expect(coordinator.performAction('other-task', prepared)).rejects.toMatchObject({
      code: 'action_session_mismatch',
    });
    await expect(coordinator.performAction('task-one', prepared)).resolves.toMatchObject({
      op: 'semantic.action.receipt',
    });
    await expect(coordinator.prepareAction('task-one', {
      snapshotId: 'snapshot-one', elementToken: 'button', action: 'invoke',
      deliveryPolicy: 'background_only',
    })).rejects.toMatchObject({ code: 'snapshot_not_retained' });
  });

  test('user takeover refuses a prepared native mutation until explicit resume', async () => {
    const fake = fakeClient();
    fake.release();
    const interlock = new NativeInputInterlock();
    const coordinator = new NativeToolCoordinator(
      handshake(), fake.client, undefined, undefined, interlock,
    );
    await coordinator.observe('task-one', { pid: 42, scope: 'window', profile: 'flash' });
    const prepared = await coordinator.prepareAction('task-one', {
      snapshotId: 'snapshot-one', elementToken: 'button', action: 'invoke',
      deliveryPolicy: 'background_only',
    });
    interlock.pause('fixture takeover');
    await expect(coordinator.performAction('task-one', prepared)).rejects.toMatchObject({
      code: 'computer_use_paused',
    });
    expect(fake.raw.action).not.toHaveBeenCalled();
    interlock.resume();
    await expect(coordinator.performAction('task-one', prepared)).rejects.toMatchObject({
      code: 'computer_use_takeover_intervened',
    });
    expect(fake.raw.action).not.toHaveBeenCalled();

    // Explicit resume permits a newly observed and newly prepared action, never the queued one.
    await coordinator.observe('task-one', { pid: 42, scope: 'window', profile: 'flash' });
    const fresh = await coordinator.prepareAction('task-one', {
      snapshotId: 'snapshot-one', elementToken: 'button', action: 'invoke',
      deliveryPolicy: 'background_only',
    });
    await expect(coordinator.performAction('task-one', fresh)).resolves.toMatchObject({
      op: 'semantic.action.receipt',
    });
  });

  test('returns diffs as evidence but never promotes unchanged base refs into new authority', async () => {
    const fake = fakeClient();
    fake.release();
    const coordinator = new NativeToolCoordinator(handshake(), fake.client);
    await coordinator.observe('task-one', {});
    fake.raw.observe.mockResolvedValueOnce({
      ...snapshot('native-session', 'snapshot-two'), baseSnapshotId: 'snapshot-one',
      nodes: [], diff: [],
    } as any);
    await coordinator.observe('task-one', { sinceSnapshotId: 'snapshot-one' });
    await expect(coordinator.prepareAction('task-one', {
      snapshotId: 'snapshot-two', elementToken: 'button', action: 'invoke',
      deliveryPolicy: 'background_only',
    })).rejects.toMatchObject({ code: 'snapshot_not_retained' });
  });

  test('refuses malformed action shapes before transport', async () => {
    const fake = fakeClient();
    fake.release();
    const coordinator = new NativeToolCoordinator(handshake(), fake.client);
    await coordinator.observe('task-one', {});
    await expect(coordinator.prepareAction('task-one', {
      snapshotId: 'snapshot-one', elementToken: 'button', action: 'invoke', value: 'forged',
      deliveryPolicy: 'background_only',
    })).rejects.toMatchObject({ code: 'invalid_action_shape' });
    expect(fake.raw.action).not.toHaveBeenCalled();
  });

  test('requires an authoritative exact-window snapshot for SOM capture', async () => {
    const fake = fakeClient();
    fake.release();
    const coordinator = new NativeToolCoordinator(handshake(), fake.client);
    await expect(coordinator.capture('task-one', {
      mode: 'som', pid: 42, windowId: 7, windowGeneration: 3,
      basedOnSnapshotId: 'missing',
    })).rejects.toMatchObject({ code: 'snapshot_target_mismatch' });
    await coordinator.observe('task-one', {});
    await expect(coordinator.capture('task-one', {
      mode: 'som', pid: 42, windowId: 7, windowGeneration: 3,
      basedOnSnapshotId: 'snapshot-one',
    })).resolves.toMatchObject({ mode: 'image' });
    expect(fake.raw.capture).toHaveBeenCalledWith('native-session', expect.objectContaining({
      mode: 'som', target: { type: 'window', window: { pid: 42, windowId: 7, generation: 3 } },
    }));
  });

  test('uses independent bridge clients for bounded parallel observations', async () => {
    const fake = fakeClient();
    fake.release();
    let active = 0;
    let peak = 0;
    let releaseReads!: () => void;
    let allReadsStarted!: () => void;
    const readGate = new Promise<void>(resolve => { releaseReads = resolve; });
    const startedGate = new Promise<void>(resolve => { allReadsStarted = resolve; });
    const read = async (id: string) => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 3) allReadsStarted();
      await readGate;
      active -= 1;
      return snapshot('native-session', id);
    };
    fake.raw.observe.mockImplementation(async () => read('parallel-one'));
    const extras = ['parallel-two', 'parallel-three'].map(id => ({
      observe: jest.fn(async () => read(id)), dispose: jest.fn(async () => {}),
    }));
    let next = 0;
    const coordinator = new NativeToolCoordinator(
      handshake(), fake.client, undefined,
      () => extras[next++] as unknown as NativeServiceOperationClient,
    );
    const pending = coordinator.observeParallel('task-one', [
      { pid: 42, scope: 'window', profile: 'flash' },
      { pid: 43, scope: 'application', profile: 'flash' },
      { pid: 44, scope: 'system_ui', profile: 'flash' },
    ]);
    await startedGate;
    expect(peak).toBe(3);
    releaseReads();
    await expect(pending).resolves.toHaveLength(3);
    expect(extras.every(client => client.dispose.mock.calls.length === 1)).toBe(true);
    await expect(coordinator.observeParallel('task-one', [])).rejects.toMatchObject({
      code: 'invalid_parallel_observation',
    });
  });
});
