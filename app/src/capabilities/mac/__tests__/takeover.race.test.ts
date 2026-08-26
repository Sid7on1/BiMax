import type { NativeServiceOperationClient } from '../native.bridge.transport';
import { NativeToolCoordinator } from '../native.tool.coordinator';
import { NativeInputInterlock } from '../native.input.interlock';
import { BIMAX_CU_PROTOCOL, type NativeServiceHandshake } from '../native.service.client';

/**
 * The takeover timing race, at the boundary where it actually matters.
 *
 * A single authority refresh near MCP-call entry is not enough. Between admission and delivery an
 * action still passes through approval, targeting, fallback selection and execution preparation, and
 * the user can press Take Control at any point in that window. The property under test is therefore
 * not "the tool returned an error" but **the native transport received zero mutation calls** — the
 * only statement that means no click, key, drag or typing reached the machine.
 *
 * Every case drives the real `NativeToolCoordinator` with an injected authority refresh, which is
 * how the moment of the pause is made deterministic instead of timing-dependent.
 */

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
      inputMonitoring: 'not_required', serviceSigned: true, signatureIntact: true,
    },
  };
}

function snapshot(sessionId: string, snapshotId = 'snapshot-one') {
  return {
    snapshotId, sessionId, pid: 42, windowId: 7, windowGeneration: 3,
    eventRevision: 11, eventTracking: true, truncated: false, partial: false,
    changedDuringCapture: false,
    nodes: [{
      token: 'button', role: 'AXButton', label: 'Continue', enabled: true,
      elementRef: {
        token: 'button', snapshotId, pid: 42, windowId: 7, windowGeneration: 3,
        axRevision: 11, stablePathHash: 'stable-button',
      },
    }],
  };
}

/**
 * A transport that separates READS from MUTATIONS, because the guarantee is asymmetric: reads and
 * capture must keep working while paused, and mutations must not happen at all.
 */
function transport() {
  const mutations: string[] = [];
  const reads: string[] = [];
  const client = {
    available: () => true,
    createSession: async () => { reads.push('createSession'); return { sessionId: 'native-session' }; },
    workspace: async () => { reads.push('workspace'); return { apps: [{ app: { pid: 42, displayName: 'Fixture', bundleId: 'ai.bimax.fixture' } }] }; },
    observe: async () => { reads.push('observe'); return snapshot('native-session'); },
    capture: async () => { reads.push('capture'); return { mode: 'image', image: { handle: 'image-one' } }; },
    closeSession: async () => { reads.push('closeSession'); },
    dispose: async () => { reads.push('dispose'); },
    action: async () => { mutations.push('action'); return { op: 'semantic.action.receipt', payload: { outcome: 'performed' } }; },
    transaction: async () => { mutations.push('transaction'); return { outcome: 'completed' }; },
    launchApp: async () => { mutations.push('launchApp'); return {}; },
    fileOperation: async () => { mutations.push('fileOperation'); return {}; },
    openUrl: async () => { mutations.push('openUrl'); return {}; },
    windowOperation: async () => { mutations.push('windowOperation'); return {}; },
  };
  return { mutations, reads, client: client as unknown as NativeServiceOperationClient };
}

const ACTION = {
  snapshotId: 'snapshot-one', elementToken: 'button', action: 'invoke',
  deliveryPolicy: 'background_only',
} as const;

/** Build a coordinator whose authority refresh is a script the test controls. */
function coordinatorWith(refresh: () => Promise<unknown>) {
  const bridge = transport();
  const interlock = new NativeInputInterlock();
  const coordinator = new NativeToolCoordinator(
    handshake(), bridge.client, undefined, undefined, interlock, refresh,
  );
  return { ...bridge, interlock, coordinator };
}

describe('a pause already active before the call', () => {
  test('refuses and the transport sees zero mutations', async () => {
    const setup = coordinatorWith(async () => {});
    setup.interlock.pause('You took control');

    await expect(setup.coordinator.observe('task', { pid: 42, scope: 'window', profile: 'flash' }))
      .resolves.toBeDefined();
    await expect(
      setup.coordinator.prepareAction('task', { ...ACTION })
        .then(prepared => setup.coordinator.performAction('task', prepared)),
    ).rejects.toMatchObject({ code: 'computer_use_paused' });

    expect(setup.mutations).toEqual([]);
  });
});

describe('a pause AFTER tool admission but before bridge delivery', () => {
  test('the delivery-time refresh catches it and no mutation is sent', async () => {
    // The action is admitted while running; the user presses Take Control during preparation. The
    // refresh at the delivery boundary is the only thing that can see this.
    let refreshes = 0;
    const setup = coordinatorWith(async () => {
      refreshes += 1;
      // The first refresh is the delivery-time one for this action.
      if (refreshes === 1) setup.interlock.pause('You took control');
    });

    await setup.coordinator.observe('task', { pid: 42, scope: 'window', profile: 'flash' });
    const prepared = await setup.coordinator.prepareAction('task', { ...ACTION });
    expect(setup.interlock.state().paused).toBe(false); // still running at admission

    await expect(setup.coordinator.performAction('task', prepared))
      .rejects.toMatchObject({ code: 'computer_use_paused' });
    expect(setup.mutations).toEqual([]);
  });
});

describe('a pause during approval/targeting preparation', () => {
  test('a main-process pause+resume between provider reads still discards the prepared action', async () => {
    // The provider sees generation 0 at admission. Electron main then transitions to paused
    // generation 1 and back to running generation 2 before the provider reads again. The boolean
    // is "running" at both reads; only the authority generation can reveal the intervention.
    let setup: ReturnType<typeof coordinatorWith>;
    setup = coordinatorWith(async () => {
      setup.interlock.synchronizeAuthority({ paused: false, generation: 2 });
    });
    setup.interlock.synchronizeAuthority({ paused: false, generation: 0 });
    await setup.coordinator.observe('task', { pid: 42, scope: 'window', profile: 'flash' });
    const prepared = await setup.coordinator.prepareAction('task', { ...ACTION });
    expect(setup.interlock.state().paused).toBe(false);

    await expect(setup.coordinator.performAction('task', prepared))
      .rejects.toMatchObject({ code: 'computer_use_takeover_intervened' });
    expect(setup.mutations).toEqual([]);
  });
});

describe('resume followed by a new explicitly allowed action', () => {
  test('a freshly prepared action after the resume is delivered', async () => {
    const setup = coordinatorWith(async () => {});
    await setup.coordinator.observe('task', { pid: 42, scope: 'window', profile: 'flash' });

    setup.interlock.pause('You took control');
    await expect(
      setup.coordinator.prepareAction('task', { ...ACTION })
        .then(prepared => setup.coordinator.performAction('task', prepared)),
    ).rejects.toMatchObject({ code: 'computer_use_paused' });
    expect(setup.mutations).toEqual([]);

    setup.interlock.resume();
    const fresh = await setup.coordinator.prepareAction('task', { ...ACTION });
    await expect(setup.coordinator.performAction('task', fresh)).resolves.toMatchObject({
      op: 'semantic.action.receipt',
    });
    expect(setup.mutations).toEqual(['action']);
  });
});

describe('reads and screenshots while paused', () => {
  test('observation and capture keep working — the inspector still needs fresh evidence', async () => {
    const setup = coordinatorWith(async () => {});
    setup.interlock.pause('You took control');

    await expect(setup.coordinator.observe('task', { pid: 42, scope: 'window', profile: 'flash' }))
      .resolves.toBeDefined();
    await expect(setup.coordinator.capture('task', {
      mode: 'image', pid: 42, windowId: 7, windowGeneration: 3,
    } as never))
      .resolves.toBeDefined();

    expect(setup.reads).toEqual(expect.arrayContaining(['observe', 'capture']));
    expect(setup.mutations).toEqual([]);
  });
});

describe('no queued mutation leaks through after a takeover', () => {
  test('several mutations prepared before the pause all refuse, and the transport stays untouched', async () => {
    const setup = coordinatorWith(async () => {});
    await setup.coordinator.observe('task', { pid: 42, scope: 'window', profile: 'flash' });

    // A batch prepared while running — the realistic queue: the model asked for several actions in
    // one turn and the human took control partway through.
    const queued = await Promise.all([
      setup.coordinator.prepareAction('task', { ...ACTION }),
      setup.coordinator.prepareAction('task', { ...ACTION }),
      setup.coordinator.prepareAction('task', { ...ACTION }),
    ]);

    setup.interlock.pause('You took control');

    const outcomes = await Promise.allSettled(
      queued.map(prepared => setup.coordinator.performAction('task', prepared)),
    );
    expect(outcomes.every(outcome => outcome.status === 'rejected')).toBe(true);

    // The assertion that carries the guarantee.
    expect(setup.mutations).toEqual([]);
  });

  test('MUTANT — without the delivery-time gate the same queue reaches the transport', async () => {
    const setup = coordinatorWith(async () => {});
    await setup.coordinator.observe('task', { pid: 42, scope: 'window', profile: 'flash' });
    const queued = await Promise.all([
      setup.coordinator.prepareAction('task', { ...ACTION }),
      setup.coordinator.prepareAction('task', { ...ACTION }),
    ]);

    // No pause at all: the identical calls are delivered. That is what makes "zero mutations" above
    // a real observation about the pause rather than about the harness.
    await Promise.all(queued.map(prepared => setup.coordinator.performAction('task', prepared)));
    expect(setup.mutations).toEqual(['action', 'action']);
  });
});
