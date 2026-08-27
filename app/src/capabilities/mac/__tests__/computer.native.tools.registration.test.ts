import type { CapabilityGovernor as IGovernor } from '../provider.policy';
import type { NativeServiceOperationClient } from '../native.bridge.transport';
import {
  BIMAX_CU_PROTOCOL,
  type NativeServiceCapabilityClient,
  type NativeServiceHandshake,
} from '../native.service.client';
import { createEligibleNativeComputerTools } from '../native.tools';
import { NativeRolloutController } from '../native.rollout';

function eligibleHandshake(): NativeServiceHandshake {
  return {
    selectedProtocol: BIMAX_CU_PROTOCOL,
    serviceVersion: 'test',
    platform: { os: 'macos', version: 'test', architecture: 'arm64' },
    capabilities: {
      observe: {
        profiles: ['flash', 'balanced', 'vision', 'som', 'audit'], scopes: ['window'],
        axDiff: true, eventRevisions: true, som: true, regionCapture: true, zoom: true, streams: false,
      },
      delivery: {
        policies: ['background_only', 'foreground_once', 'foreground_persistent'],
        verifiedDeliveryPolicies: ['background_only', 'foreground_once', 'foreground_persistent'],
        semanticActions: [
          'invoke', 'set_value', 'toggle', 'select', 'set_selected', 'select_text_range',
          'select_text', 'set_caret', 'scroll_to_fraction', 'type_text',
        ],
        verifiedSemanticActions: [
          'invoke', 'set_value', 'toggle', 'select', 'set_selected', 'select_text_range',
          'select_text', 'set_caret', 'scroll_to_fraction', 'type_text',
        ],
        targetedEvents: true, physicalInput: true, focusLease: true, semanticTransactions: true,
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

const governor = { approveTaskExecution: jest.fn(async () => {}) } as unknown as IGovernor;

function capability(handshake: NativeServiceHandshake, eligible = true) {
  return {
    probe: jest.fn(async () => ({
      configured: true, reachable: true, routingEligible: eligible,
      cutoverBlockers: eligible ? [] : ['capture_unavailable'], attempts: 1, handshake,
    })),
  } as unknown as NativeServiceCapabilityClient;
}

function operation(handshake: NativeServiceHandshake, available = true) {
  const raw = {
    available: jest.fn(() => available), handshake: jest.fn(async () => handshake),
    createSession: jest.fn(async () => ({ sessionId: 'native-session' })),
    workspace: jest.fn(async () => ({
      apps: [{ app: { pid: 42, displayName: 'Fixture', bundleId: 'ai.bimax.fixture' } }],
    })),
    observe: jest.fn(async () => ({
      snapshotId: 'snapshot-one', sessionId: 'native-session', pid: 42,
      windowId: 7, windowGeneration: 3, eventRevision: 11, eventTracking: true,
      truncated: false, partial: false, changedDuringCapture: false,
      nodes: [{
        token: 'button', role: 'AXButton', label: 'Continue', enabled: true,
        elementRef: {
          token: 'button', snapshotId: 'snapshot-one', pid: 42, windowId: 7,
          windowGeneration: 3, axRevision: 11, stablePathHash: 'stable-button',
        },
      }],
    })),
    action: jest.fn(async () => ({
      op: 'semantic.action.receipt', payload: { outcome: 'performed' },
    })),
    resolveApp: jest.fn(async (_session: string, lookup: Record<string, unknown>) => ({
      lookup, resolved: true, bundlePath: '/Applications/BimaxCuFixture.app',
      bundleId: 'ai.bimax.cu.fixture', displayName: 'BimaxCuFixture', running: [],
    })),
    inspectFile: jest.fn(async (_session: string, request: Record<string, unknown>) => ({
      path: request.path, exists: true, isDirectory: false, contentType: 'public.json',
    })),
    fileOperation: jest.fn(async (_session: string, request: Record<string, unknown>) => ({
      operation: request.operation, path: request.path, performed: true,
      requestedActivation: request.operation === 'reveal_file',
      frontmostPidBefore: 501, frontmostPidAfter: 501, frontmostChanged: false, durationMs: 10,
    })),
    openUrl: jest.fn(async (_session: string, request: Record<string, unknown>) => ({
      url: request.url, scheme: 'https', host: 'example.com', opened: true,
      requestedActivation: false, frontmostPidBefore: 501, frontmostPidAfter: 501,
      frontmostChanged: false, durationMs: 20,
    })),
    launchApp: jest.fn(async () => ({
      outcome: 'launched', app: { pid: 4242, bundleId: 'ai.bimax.cu.fixture' },
      requestedActivation: false, frontmostPidBefore: 501, frontmostPidAfter: 501,
      frontmostChanged: false, finishedLaunching: true, durationMs: 90,
    })),
    closeSession: jest.fn(async () => {}), dispose: jest.fn(async () => {}),
  };
  return { raw, client: raw as unknown as NativeServiceOperationClient };
}

describe('native operation tool registration', () => {
  test('registers the capability-filtered surface only after discovery and bridge cutover gates', async () => {
    const handshake = eligibleHandshake();
    const bridge = operation(handshake);
    const surface = await createEligibleNativeComputerTools(
      governor, capability(handshake), bridge.client,
    );
    expect(surface?.tools.map(tool => tool.name)).toEqual([
      'BimaxWorkspaceTool', 'BimaxObserveTool', 'BimaxActionTool',
      'BimaxTransactionTool', 'BimaxCaptureTool',
    ]);
    expect(bridge.raw.handshake).toHaveBeenCalledTimes(1);
    const observe = surface?.tools.find(tool => tool.name === 'BimaxObserveTool');
    const action = surface?.tools.find(tool => tool.name === 'BimaxActionTool');
    await observe?.execute({ pid: 42, scope: 'window', profile: 'flash' }, { sessionId: 'task-one' });
    (governor.approveTaskExecution as jest.Mock).mockClear();
    const actionOutput = await action?.execute({
      snapshotId: 'snapshot-one', elementToken: 'button', action: 'invoke',
      deliveryPolicy: 'background_only',
    }, { sessionId: 'task-one' });
    expect(JSON.parse(String(actionOutput))).toMatchObject({
      op: 'semantic.action.receipt',
      target: { app: expect.stringContaining('Fixture'), pid: 42, windowId: 7 },
    });
    // Action owns one resolved-target COMPUTER_CONTROL decision; buildTool must not add an earlier
    // generic prompt that lacks target/impact context.
    expect(governor.approveTaskExecution).toHaveBeenCalledTimes(1);
    expect(governor.approveTaskExecution).toHaveBeenCalledWith(
      'COMPUTER_CONTROL', expect.objectContaining({ tool: 'BimaxActionTool', app: expect.stringContaining('Fixture') }),
    );
    await surface?.coordinator.dispose();
    expect(bridge.raw.dispose).toHaveBeenCalledTimes(1);
  });

  test('a launch takes its own approval naming the resolved bundle, and a refusal starts nothing', async () => {
    const handshake = eligibleHandshake();
    handshake.capabilities.workspace.operations = ['resolve_app', 'launch_app'];
    handshake.capabilities.workspace.verifiedOperations = ['resolve_app', 'launch_app'];
    const bridge = operation(handshake);
    const surface = await createEligibleNativeComputerTools(
      governor, capability(handshake), bridge.client,
    );
    const workspace = surface?.tools.find(tool => tool.name === 'BimaxWorkspaceTool');

    // Read-only inventory and resolution take no approval.
    (governor.approveTaskExecution as jest.Mock).mockClear();
    await workspace?.execute({ operation: 'apps' }, { sessionId: 'task-one' });
    await workspace?.execute({ operation: 'resolve_app', bundleId: 'ai.bimax.cu.fixture' }, { sessionId: 'task-one' });
    expect(governor.approveTaskExecution).not.toHaveBeenCalled();
    expect(bridge.raw.launchApp).not.toHaveBeenCalled();

    await workspace?.execute({ operation: 'launch_app', bundleId: 'ai.bimax.cu.fixture' }, { sessionId: 'task-one' });
    expect(governor.approveTaskExecution).toHaveBeenCalledTimes(1);
    expect(governor.approveTaskExecution).toHaveBeenCalledWith('COMPUTER_CONTROL', expect.objectContaining({
      tool: 'BimaxWorkspaceTool',
      app: 'BimaxCuFixture / ai.bimax.cu.fixture',
      isDestructive: true,
      target: { bundlePath: '/Applications/BimaxCuFixture.app', bundleId: 'ai.bimax.cu.fixture' },
    }));
    // Resolution ran before the approval, so the decision described the real bundle.
    expect((bridge.raw.resolveApp as jest.Mock).mock.invocationCallOrder[1])
      .toBeLessThan((governor.approveTaskExecution as jest.Mock).mock.invocationCallOrder[0]);
    expect(bridge.raw.launchApp).toHaveBeenCalledTimes(1);

    (governor.approveTaskExecution as jest.Mock).mockRejectedValueOnce(new Error('denied'));
    await expect(workspace?.execute({ operation: 'launch_app', bundleId: 'ai.bimax.cu.fixture' }, { sessionId: 'task-one' }))
      .rejects.toThrow('denied');
    expect(bridge.raw.launchApp).toHaveBeenCalledTimes(1);
    await surface?.coordinator.dispose();
  });

  test('registers the Desktop focus broker as an exact-PID verified capability', async () => {
    const previousEndpoint = process.env.BIMAX_CU_FOCUS_BROKER_ENDPOINT;
    const previousToken = process.env.BIMAX_CU_FOCUS_BROKER_TOKEN;
    const previousFetch = global.fetch;
    process.env.BIMAX_CU_FOCUS_BROKER_ENDPOINT = 'http://127.0.0.1:43210/v1/focus/activate';
    process.env.BIMAX_CU_FOCUS_BROKER_TOKEN = 'b'.repeat(64);
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ accepted: true, code: 'accepted' }),
    })) as unknown as typeof fetch;
    try {
      const handshake = eligibleHandshake();
      const bridge = operation(handshake);
      (bridge.raw.workspace as jest.Mock)
        .mockResolvedValueOnce({
          apps: [{ app: { pid: 42, displayName: 'Fixture', bundleId: 'ai.bimax.fixture' } }],
          frontmostPid: 501,
        })
        .mockResolvedValueOnce({
          apps: [{ app: { pid: 42, displayName: 'Fixture', bundleId: 'ai.bimax.fixture' } }],
          frontmostPid: 42,
        });
      const surface = await createEligibleNativeComputerTools(
        governor, capability(handshake), bridge.client,
      );
      const focus = surface?.tools.find(tool => tool.name === 'BimaxFocusTool');
      expect(focus).toBeDefined();
      (governor.approveTaskExecution as jest.Mock).mockClear();
      const output = JSON.parse(String(await focus?.execute({
        pid: 42, bundleId: 'ai.bimax.fixture',
      }, { sessionId: 'task-focus' })));
      expect(output).toMatchObject({
        operation: 'focus_app', outcome: 'activated', activated: true,
        requestedActivation: true, frontmostPidBefore: 501, frontmostPidAfter: 42,
      });
      expect(governor.approveTaskExecution).toHaveBeenCalledWith(
        'COMPUTER_CONTROL', expect.objectContaining({
          tool: 'BimaxFocusTool', action: 'bring application to foreground',
          bundleId: 'ai.bimax.fixture', target: { pid: 42, bundleId: 'ai.bimax.fixture' },
        }),
      );
      expect(global.fetch).toHaveBeenCalledWith(
        process.env.BIMAX_CU_FOCUS_BROKER_ENDPOINT,
        expect.objectContaining({ method: 'POST' }),
      );
      await surface?.coordinator.dispose();
    } finally {
      if (previousEndpoint === undefined) delete process.env.BIMAX_CU_FOCUS_BROKER_ENDPOINT;
      else process.env.BIMAX_CU_FOCUS_BROKER_ENDPOINT = previousEndpoint;
      if (previousToken === undefined) delete process.env.BIMAX_CU_FOCUS_BROKER_TOKEN;
      else process.env.BIMAX_CU_FOCUS_BROKER_TOKEN = previousToken;
      global.fetch = previousFetch;
    }
  });

  test('file operations are workspace-scoped and cross the right approval boundary', async () => {
    const handshake = eligibleHandshake();
    handshake.capabilities.workspace.operations = [
      'resolve_app', 'launch_app', 'inspect_file', 'open_file', 'reveal_file', 'trash_file',
      'duplicate_file', 'open_url',
    ];
    handshake.capabilities.workspace.verifiedOperations = handshake.capabilities.workspace.operations;
    const bridge = operation(handshake);
    const surface = await createEligibleNativeComputerTools(
      governor, capability(handshake), bridge.client,
    );
    const workspace = surface?.tools.find(tool => tool.name === 'BimaxWorkspaceTool');
    const context = { sessionId: 'task-one', cwd: process.cwd() };

    // A path that leaves the workspace never reaches the native service.
    (governor.approveTaskExecution as jest.Mock).mockClear();
    await expect(workspace?.execute({ operation: 'trash_file', path: '../../etc/passwd' }, context))
      .rejects.toThrow(/workspace/i);
    expect(bridge.raw.fileOperation).not.toHaveBeenCalled();
    expect(governor.approveTaskExecution).not.toHaveBeenCalled();

    // Reading metadata takes no approval.
    await workspace?.execute({ operation: 'inspect_file', path: 'package.json' }, context);
    expect(governor.approveTaskExecution).not.toHaveBeenCalled();
    expect(bridge.raw.inspectFile).toHaveBeenCalledWith('native-session', {
      path: `${process.cwd()}/package.json`,
    });

    // Trash is a delete: FILE_WRITE, destructive, naming the resolved absolute path.
    await workspace?.execute({ operation: 'trash_file', path: 'scratch.txt' }, context);
    expect(governor.approveTaskExecution).toHaveBeenCalledWith('FILE_WRITE', expect.objectContaining({
      tool: 'BimaxWorkspaceTool', action: 'trash_file',
      targetPath: `${process.cwd()}/scratch.txt`, isDestructive: true,
    }));

    // Reveal changes what the human is looking at, so it is disclosed as high-impact.
    (governor.approveTaskExecution as jest.Mock).mockClear();
    await workspace?.execute({ operation: 'reveal_file', path: 'scratch.txt' }, context);
    expect(governor.approveTaskExecution).toHaveBeenCalledWith('COMPUTER_CONTROL', expect.objectContaining({
      action: 'reveal_file', highImpact: true, impactReason: 'brings Finder to the foreground',
    }));

    // Opening a URL is outward-facing and names the host it will reach.
    (governor.approveTaskExecution as jest.Mock).mockClear();
    await workspace?.execute({ operation: 'open_url', url: 'https://Example.com/docs' }, context);
    expect(governor.approveTaskExecution).toHaveBeenCalledWith('COMPUTER_CONTROL', expect.objectContaining({
      action: 'open a URL in the default browser', host: 'example.com', highImpact: true,
    }));

    (governor.approveTaskExecution as jest.Mock).mockRejectedValueOnce(new Error('denied'));
    const before = (bridge.raw.fileOperation as jest.Mock).mock.calls.length;
    await expect(workspace?.execute({ operation: 'duplicate_file', path: 'scratch.txt' }, context))
      .rejects.toThrow('denied');
    expect((bridge.raw.fileOperation as jest.Mock).mock.calls.length).toBe(before);
    await surface?.coordinator.dispose();
  });

  test('keeps the compatibility surface when discovery refuses cutover', async () => {
    const handshake = eligibleHandshake();
    const bridge = operation(handshake);
    await expect(createEligibleNativeComputerTools(
      governor, capability(handshake, false), bridge.client,
    )).resolves.toBeNull();
    expect(bridge.raw.handshake).not.toHaveBeenCalled();
  });

  test('starts Phase 9 semantic opt-in while physical input remains on ComputerTool', async () => {
    const handshake = eligibleHandshake();
    handshake.capabilities.delivery.physicalInput = false;
    const bridge = operation(handshake);
    const surface = await createEligibleNativeComputerTools(
      governor, capability(handshake, false), bridge.client, 'semantic',
    );
    expect(surface?.tools.map(tool => tool.name)).toEqual([
      'BimaxWorkspaceTool', 'BimaxObserveTool', 'BimaxActionTool',
      'BimaxTransactionTool', 'BimaxCaptureTool',
    ]);
    await surface?.coordinator.dispose();
  });

  test('fails closed when the signed bridge handshake is weaker than the discovery probe', async () => {
    const discovered = eligibleHandshake();
    const live = eligibleHandshake();
    live.capabilities.delivery.physicalInput = false;
    const bridge = operation(live);
    await expect(createEligibleNativeComputerTools(
      governor, capability(discovered), bridge.client,
    )).resolves.toBeNull();
  });

  test('does not open XPC when the signed bridge binary is absent', async () => {
    const handshake = eligibleHandshake();
    const bridge = operation(handshake, false);
    await expect(createEligibleNativeComputerTools(
      governor, capability(handshake), bridge.client,
    )).resolves.toBeNull();
    expect(bridge.raw.handshake).not.toHaveBeenCalled();
  });

  test('automatic rollback stops future native delivery while compatibility remains available', async () => {
    const handshake = eligibleHandshake();
    const bridge = operation(handshake);
    const rollout = new NativeRolloutController({ mode: 'native', statePath: null });
    const surface = await createEligibleNativeComputerTools(
      governor, capability(handshake), bridge.client, 'full', rollout,
    );
    const observe = surface?.tools.find(tool => tool.name === 'BimaxObserveTool');
    (bridge.raw.observe as jest.Mock).mockRejectedValueOnce(Object.assign(
      new Error('delivery may have crossed the bridge'), { code: 'bridge_timeout' },
    ));
    await expect(observe?.execute(
      { pid: 42, scope: 'window', profile: 'flash' }, { sessionId: 'task-one' },
    )).rejects.toMatchObject({ code: 'bridge_timeout' });
    expect(rollout.status()).toMatchObject({ tripped: true, state: 'rolled_back' });

    await expect(observe?.execute(
      { pid: 42, scope: 'window', profile: 'flash' }, { sessionId: 'task-two' },
    )).rejects.toMatchObject({ code: 'native_rollout_rolled_back' });
    expect(bridge.raw.observe).toHaveBeenCalledTimes(1);
    await surface?.coordinator.dispose();
  });

  // Whether a native tool EXISTS is the only place the ad-hoc approval can be observed to matter.
  // The gate shipped tested but inert; these fail if nothing carries an approval this far.
  describe('user-approved ad-hoc service', () => {
    const CDHASH = '0fa45ab41e395b996479ea2de29ccdaaf7cefd7c';
    const original = process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
    beforeEach(() => { delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE; });
    afterEach(() => {
      if (original === undefined) delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
      else process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE = original;
    });

    const adHocHandshake = (cdHash = CDHASH): NativeServiceHandshake => {
      const value = eligibleHandshake();
      value.permissions.serviceSigned = false;
      value.permissions.adHocSigned = true;
      value.permissions.signatureIntact = true;
      value.permissions.codeDirectoryHash = cdHash;
      return value;
    };
    const probed = (handshake: NativeServiceHandshake, adHocApproval?: { codeDirectoryHash: string }) => ({
      probe: jest.fn(async () => ({
        configured: true, reachable: true, routingEligible: false,
        cutoverBlockers: ['service_not_signed'], attempts: 1, handshake, adHocApproval,
      })),
    }) as unknown as NativeServiceCapabilityClient;

    test('no approval means no native tools, however intact the seal', async () => {
      const handshake = adHocHandshake();
      const bridge = operation(handshake);
      await expect(createEligibleNativeComputerTools(
        governor, probed(handshake), bridge.client, 'semantic',
      )).resolves.toBeNull();
      expect(bridge.raw.handshake).not.toHaveBeenCalled();
    });

    test('a matching approval registers the surface', async () => {
      const handshake = adHocHandshake();
      const bridge = operation(handshake);
      const surface = await createEligibleNativeComputerTools(
        governor, probed(handshake, { codeDirectoryHash: CDHASH }), bridge.client, 'semantic',
      );
      expect(surface?.tools.length).toBeGreaterThan(0);
      await surface?.coordinator.dispose();
    });

    test('the bridge is re-assessed, so an approved probe cannot vouch for a different binary', async () => {
      // Discovery and the live XPC endpoint report their own signing state independently. A
      // discovery that cleared on the approved sidecar must not carry over to whatever the bridge
      // turns out to be.
      const discovered = adHocHandshake();
      const bridge = operation(adHocHandshake('cafebabe'.repeat(5)));
      await expect(createEligibleNativeComputerTools(
        governor, probed(discovered, { codeDirectoryHash: CDHASH }), bridge.client, 'semantic',
      )).resolves.toBeNull();
      expect(bridge.raw.handshake).toHaveBeenCalledTimes(1);
    });

    test('approval never registers tools for a capability the service lacks', async () => {
      const handshake = adHocHandshake();
      handshake.capabilities.observe.regionCapture = false; // a MEASURED blocker
      const bridge = operation(handshake);
      await expect(createEligibleNativeComputerTools(
        governor, probed(handshake, { codeDirectoryHash: CDHASH }), bridge.client, 'semantic',
      )).resolves.toBeNull();
    });
  });
});
