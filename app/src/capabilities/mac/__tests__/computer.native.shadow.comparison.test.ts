import type { DesktopResult } from '../desktop.runtime';
import type { NativeServiceOperationClient } from '../native.bridge.transport';
import {
  NativeShadowComparisonController,
} from '../native.shadow.comparison';
import {
  BIMAX_CU_PROTOCOL,
  assessNativeShadowEligibility,
  type NativeServiceCapabilityClient,
  type NativeServiceHandshake,
} from '../native.service.client';

function handshake(): NativeServiceHandshake {
  return {
    selectedProtocol: BIMAX_CU_PROTOCOL,
    serviceVersion: 'shadow-test',
    platform: { os: 'macos', version: 'test', architecture: 'arm64' },
    capabilities: {
      observe: {
        profiles: ['flash', 'balanced'], scopes: ['application', 'window', 'system_ui'],
        axDiff: true, eventRevisions: true, som: false, regionCapture: false, zoom: false,
        streams: false,
      },
      delivery: {
        policies: [], verifiedDeliveryPolicies: [], semanticActions: [],
        verifiedSemanticActions: [], targetedEvents: false, physicalInput: false,
        focusLease: false, semanticTransactions: false,
      },
      workspace: {
        apps: true, windows: true, displays: true, spaces: false,
        files: [], operations: [], verifiedOperations: [],
      },
      browser: { typedRoute: false, dialogs: false, fileInput: false, downloads: false },
      recording: { trajectory: false, video: false, replayModes: [] },
    },
    limits: {
      maxTransactionSteps: 5, maxElements: 2_000, maxDiffOperations: 5_000,
      maxImageDimension: 4_096, maxConcurrentReadSessions: 4, maxCaptureStreams: 2,
    },
    permissions: {
      accessibility: 'granted', screenRecording: 'denied', screenCapturable: false,
      inputMonitoring: 'not_required', serviceSigned: true, signatureIntact: true,
    },
  };
}

function capability(value: NativeServiceHandshake): NativeServiceCapabilityClient {
  return {
    probe: jest.fn(async () => ({
      configured: true, reachable: true, routingEligible: false,
      cutoverBlockers: ['physical_input_unavailable'], attempts: 1, handshake: value,
    })),
  } as unknown as NativeServiceCapabilityClient;
}

function nativeNode(snapshotId: string, token: string, role: string, label: string) {
  return {
    token, role, label, enabled: true,
    elementRef: {
      token, snapshotId, pid: 42, windowId: 7, windowGeneration: 3,
      axRevision: 11, stablePathHash: `stable-${token}`,
    },
  };
}

function operation(value: NativeServiceHandshake) {
  const raw = {
    available: jest.fn(() => true),
    handshake: jest.fn(async () => value),
    createSession: jest.fn(async () => ({ sessionId: 'native-shadow-session' })),
    workspace: jest.fn(async () => ({
      windows: [{ window: { pid: 42, windowId: 7, generation: 3 } }],
    })),
    observe: jest.fn(async () => ({
      snapshotId: 'native-snapshot', sessionId: 'native-shadow-session', pid: 42,
      windowId: 7, windowGeneration: 3, eventRevision: 11, eventTracking: true,
      truncated: false, partial: false, changedDuringCapture: false,
      nodes: [
        nativeNode('native-snapshot', 'one', 'AXButton', 'Continue'),
        nativeNode('native-snapshot', 'two', 'AXTextField', 'Email'),
      ],
    })),
    action: jest.fn(),
    transaction: jest.fn(),
    closeSession: jest.fn(async () => {}),
    dispose: jest.fn(async () => {}),
  };
  return { raw, client: raw as unknown as NativeServiceOperationClient };
}

function compatibility(): DesktopResult {
  return {
    ok: true, action: 'observe', driver: 'compat', frameId: 'compat-frame',
    pid: 42, windowId: 7, summary: 'observed',
    elements: [
      { role: 'AXButton', name: 'Continue' },
      { role: 'AXTextField', label: 'Email' },
    ],
  };
}

describe('Phase 9 native shadow comparison', () => {
  test('has a narrower read-only gate without accepting unsigned or stale observers', () => {
    const ready = handshake();
    expect(assessNativeShadowEligibility(ready, true)).toEqual({ eligible: true, blockers: [] });
    ready.permissions.serviceSigned = false;
    ready.capabilities.observe.eventRevisions = false;
    expect(assessNativeShadowEligibility(ready, true).blockers).toEqual([
      'service_not_signed', 'event_revisions_unavailable',
    ]);
    expect(assessNativeShadowEligibility(undefined, false).blockers).toEqual([
      'shadow_gate_disabled', 'service_unreachable',
    ]);
  });

  test('compares exact-window semantics without retaining labels or calling an action endpoint', async () => {
    const service = handshake();
    const bridge = operation(service);
    const controller = new NativeShadowComparisonController(
      true, capability(service), () => bridge.client, () => 1_000,
    );
    const receipt = await controller.compare('task-secret', compatibility(), {
      query: 'Continue', maxElements: 80,
    });
    expect(receipt).toMatchObject({
      outcome: 'compared',
      compatibility: { pid: 42, windowId: 7, elements: 2 },
      native: { pid: 42, windowId: 7, nodes: 2, exactWindow: true },
      comparison: { shared: 2, union: 2, jaccard: 1, agreement: 'high' },
    });
    expect(bridge.raw.observe).toHaveBeenCalledWith('native-shadow-session', {
      pid: 42, scope: 'window', profile: 'balanced', maxElements: 80,
      windowId: 7, windowGeneration: 3, query: 'Continue',
    });
    expect(bridge.raw.action).not.toHaveBeenCalled();
    expect(bridge.raw.transaction).not.toHaveBeenCalled();
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('Continue');
    expect(serialized).not.toContain('Email');
    expect(serialized).not.toContain('task-secret');
    expect(controller.status()).toMatchObject({
      enabled: true, inFlight: 0, receipts: 1, compared: 1, skipped: 0, failed: 0,
      lastOutcome: 'compared', lastAgreement: 'high',
    });
    expect(controller.recent(0)).toEqual([]);
    await controller.dispose();
    expect(bridge.raw.closeSession).toHaveBeenCalledTimes(1);
    expect(bridge.raw.dispose).toHaveBeenCalledTimes(1);
  });

  test('falls back to application scope and records failures instead of throwing', async () => {
    const service = handshake();
    const bridge = operation(service);
    bridge.raw.workspace.mockResolvedValueOnce({ windows: [] });
    const controller = new NativeShadowComparisonController(
      true, capability(service), () => bridge.client,
    );
    const fallback = await controller.compare('task-one', compatibility());
    expect(fallback).toMatchObject({ outcome: 'compared', native: { exactWindow: false } });
    expect(bridge.raw.observe).toHaveBeenLastCalledWith(
      'native-shadow-session', expect.objectContaining({ scope: 'application' }),
    );

    bridge.raw.observe.mockRejectedValueOnce(Object.assign(new Error('private content'), {
      code: 'ax_timed_out',
    }));
    const failed = await controller.compare('task-one', compatibility());
    expect(failed).toMatchObject({ outcome: 'failed', reason: 'ax_timed_out' });
    expect(JSON.stringify(failed)).not.toContain('private content');
    await controller.dispose();
  });

  test('sheds a second observation for the same task instead of queueing it', async () => {
    const service = handshake();
    const bridge = operation(service);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    bridge.raw.observe.mockImplementationOnce(async () => {
      await gate;
      return {
        snapshotId: 'native-snapshot', sessionId: 'native-shadow-session', pid: 42,
        windowId: 7, windowGeneration: 3, eventRevision: 11, eventTracking: true,
        truncated: false, partial: false, changedDuringCapture: false,
        nodes: [nativeNode('native-snapshot', 'one', 'AXButton', 'Continue')],
      };
    });
    const controller = new NativeShadowComparisonController(
      true, capability(service), () => bridge.client,
    );
    const first = controller.compare('same-task', compatibility());
    await Promise.resolve();
    const second = await controller.compare('same-task', compatibility());
    expect(second).toMatchObject({ outcome: 'skipped', reason: 'shadow_task_busy' });
    release();
    await expect(first).resolves.toMatchObject({ outcome: 'compared' });
    await controller.dispose();
  });
});
