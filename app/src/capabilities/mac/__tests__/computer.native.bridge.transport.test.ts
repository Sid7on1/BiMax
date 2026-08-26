import {
  NativeBridgeTransportError,
  NativeServiceOperationClient,
  NativeServiceWireClient,
  type NativeBridgeLinePort,
  type NativeWireRequestEnvelope,
  type NativeWireResponseEnvelope,
} from '../native.bridge.transport';
import type { NativeServiceHandshake } from '../native.service.client';
import { BIMAX_CU_PROTOCOL } from '../native.service.client';
import {
  compileNativeSemanticTransaction,
  type NativeElementRef,
} from '../native.transaction.compiler';

function handshake(): NativeServiceHandshake {
  return {
    selectedProtocol: BIMAX_CU_PROTOCOL,
    serviceVersion: 'test',
    platform: { os: 'macos', version: 'test', architecture: 'arm64' },
    capabilities: {
      observe: {
        profiles: ['flash', 'balanced'], scopes: ['window'], axDiff: true,
        eventRevisions: true, som: false, regionCapture: false, zoom: false, streams: false,
      },
      delivery: {
        policies: ['background_only'], verifiedDeliveryPolicies: ['background_only'],
        semanticActions: ['set_value', 'set_selected'],
        verifiedSemanticActions: ['set_value', 'set_selected'],
        targetedEvents: true, physicalInput: false, focusLease: false,
        semanticTransactions: true,
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

class StubPort implements NativeBridgeLinePort {
  public requests: NativeWireRequestEnvelope[] = [];
  public disposed = false;

  public constructor(
    private readonly responder: (request: NativeWireRequestEnvelope) => NativeWireResponseEnvelope,
  ) {}

  public available(): boolean { return true; }
  public async exchange(line: string): Promise<string> {
    const request = JSON.parse(line) as NativeWireRequestEnvelope;
    this.requests.push(request);
    return JSON.stringify({ requestId: request.requestId, response: this.responder(request) });
  }
  public async dispose(): Promise<void> { this.disposed = true; }
}

function response(
  request: NativeWireRequestEnvelope,
  op: string,
  payload?: unknown,
): NativeWireResponseEnvelope {
  return {
    protocol: BIMAX_CU_PROTOCOL,
    requestId: request.requestId,
    sessionId: request.sessionId,
    serviceVersion: 'test',
    body: payload === undefined ? { op } : { op, payload },
  };
}

function element(): NativeElementRef {
  return {
    token: 'token', snapshotId: 'snapshot', pid: 42, windowId: 7,
    windowGeneration: 3, axRevision: 11, stablePathHash: 'stable',
  };
}

describe('native signed bridge transport', () => {
  test('constructs and correlates a versioned request envelope', async () => {
    const port = new StubPort(request => response(request, 'workspace.snapshot', { apps: [] }));
    const wire = new NativeServiceWireClient(port);
    const result = await wire.request('session-one', {
      op: 'workspace.snapshot', payload: { includeOffscreenWindows: false },
    }, 1_000);
    expect(result.body?.payload).toEqual({ apps: [] });
    expect(port.requests[0]).toMatchObject({
      protocol: BIMAX_CU_PROTOCOL,
      sessionId: 'session-one',
      deadlineMs: 1_000,
      body: { op: 'workspace.snapshot', payload: { includeOffscreenWindows: false } },
    });
    expect(port.requests[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('validates the live handshake again after XPC transport', async () => {
    const port = new StubPort(request => response(request, 'handshake', handshake()));
    const client = new NativeServiceOperationClient(new NativeServiceWireClient(port));
    await expect(client.handshake()).resolves.toMatchObject({
      selectedProtocol: BIMAX_CU_PROTOCOL,
      capabilities: { observe: { profiles: ['flash', 'balanced'] } },
    });

    const malformed = new StubPort(request => response(request, 'handshake', {
      selectedProtocol: BIMAX_CU_PROTOCOL,
    }));
    await expect(new NativeServiceOperationClient(
      new NativeServiceWireClient(malformed),
    ).handshake()).rejects.toThrow(/invalid platform metadata/);
  });

  test('sends only compiler-issued transactions', async () => {
    const port = new StubPort(request => response(request, 'semantic.transaction.receipt', {
      outcome: 'completed',
    }));
    const client = new NativeServiceOperationClient(new NativeServiceWireClient(port));
    const compiled = compileNativeSemanticTransaction({
      basedOnSnapshotId: 'snapshot', deliveryPolicy: 'background_only',
      steps: [{
        stepId: 'edit', element: element(), action: 'set_value',
        value: { type: 'string', value: 'after' },
      }],
    }, handshake());
    await expect(client.transaction('session-one', compiled)).resolves.toEqual({ outcome: 'completed' });
    expect(port.requests[0].body).toEqual({
      op: 'semantic.transaction', payload: compiled.request,
    });

    await expect(client.transaction('session-one', {
      ...compiled,
    })).rejects.toMatchObject({ code: 'unsigned_transaction' });
    expect(port.requests).toHaveLength(1);
  });

  test('maps capture handles through the typed control envelope', async () => {
    const port = new StubPort(request => response(request, 'capture.image.receipt', {
      mode: 'image', image: { handle: 'image-one' },
    }));
    const client = new NativeServiceOperationClient(new NativeServiceWireClient(port));
    await expect(client.capture('session-one', {
      target: { type: 'display', displayId: 1 }, mode: 'image', format: 'jpeg',
      maxDimension: 1_456, jpegQuality: 0.85, zoomFactor: 1,
    })).resolves.toMatchObject({ mode: 'image', image: { handle: 'image-one' } });
    expect(port.requests[0].body.op).toBe('capture.image');
  });

  test('rejects bridge and service identity mismatches', async () => {
    const mismatchedBridge: NativeBridgeLinePort = {
      available: () => true,
      exchange: async () => JSON.stringify({ requestId: 'different', response: {} }),
      dispose: async () => {},
    };
    await expect(new NativeServiceWireClient(mismatchedBridge).request(
      'session-one', { op: 'session.status' },
    )).rejects.toMatchObject({ code: 'bridge_correlation_failed' });

    const mismatchedService = new StubPort(request => ({
      ...response(request, 'session'), sessionId: 'another-session',
    }));
    await expect(new NativeServiceWireClient(mismatchedService).request(
      'session-one', { op: 'session.status' },
    )).rejects.toMatchObject({ code: 'service_correlation_failed' });
  });

  test('surfaces typed service errors without retrying mutations', async () => {
    const port = new StubPort(request => ({
      protocol: BIMAX_CU_PROTOCOL,
      requestId: request.requestId,
      sessionId: request.sessionId,
      serviceVersion: 'test',
      error: { code: 'stale_element_ref', message: 'target changed', retryable: false },
    }));
    const client = new NativeServiceOperationClient(new NativeServiceWireClient(port));
    await expect(client.observe('session-one', { pid: 42 })).rejects.toMatchObject({
      code: 'stale_element_ref', message: 'target changed',
    });
    expect(port.requests).toHaveLength(1);
  });

  test('refuses malformed operations, deadlines, sessions, and oversized envelopes locally', async () => {
    const port = new StubPort(request => response(request, 'unused'));
    const wire = new NativeServiceWireClient(port);
    await expect(wire.request('', { op: 'session.status' })).rejects.toMatchObject({ code: 'invalid_session_id' });
    await expect(wire.request('session', { op: '../action' })).rejects.toMatchObject({ code: 'invalid_operation' });
    await expect(wire.request('session', { op: 'session.status' }, 0)).rejects.toMatchObject({ code: 'invalid_deadline' });
    await expect(wire.request('session', {
      op: 'ax.observe', payload: { query: 'x'.repeat(2 * 1024 * 1024) },
    })).rejects.toMatchObject({ code: 'bridge_request_too_large' });
    expect(port.requests).toHaveLength(0);
  });

  test('disposes the injected bridge port', async () => {
    const port = new StubPort(request => response(request, 'session.closed'));
    await new NativeServiceWireClient(port).dispose();
    expect(port.disposed).toBe(true);
  });
});
