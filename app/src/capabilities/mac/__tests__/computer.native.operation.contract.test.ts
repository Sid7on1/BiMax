import type { NativeServiceHandshake } from '../native.service.client';
import { BIMAX_CU_PROTOCOL } from '../native.service.client';
import { buildNativeOperationToolContracts } from '../native.operation.contract';

function handshake(): NativeServiceHandshake {
  return {
    selectedProtocol: BIMAX_CU_PROTOCOL,
    serviceVersion: 'test',
    platform: { os: 'macos', version: 'test', architecture: 'arm64' },
    capabilities: {
      observe: {
        profiles: ['flash', 'balanced'], scopes: ['application', 'window'],
        axDiff: true, eventRevisions: true, som: false, regionCapture: false,
        zoom: false, streams: false,
      },
      delivery: {
        policies: ['background_native', 'background_only', 'foreground_persistent'],
        verifiedDeliveryPolicies: ['background_native', 'background_only'],
        semanticActions: ['invoke', 'set_value', 'set_selected', 'scroll_page', 'teleport'],
        verifiedSemanticActions: ['invoke', 'set_value', 'set_selected', 'scroll_page'],
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

describe('native operation-specific capability schemas', () => {
  test('builds read/observe/action/transaction tools and omits failed capture modes', () => {
    const contracts = buildNativeOperationToolContracts(handshake());
    expect(contracts.map(contract => contract.name)).toEqual([
      'BimaxWorkspaceTool', 'BimaxObserveTool', 'BimaxActionTool', 'BimaxTransactionTool',
    ]);
    const action = contracts.find(contract => contract.name === 'BimaxActionTool')!;
    const properties = action.schema.properties as any;
    expect(properties.action.enum).toEqual(['invoke', 'set_value', 'set_selected', 'scroll_page']);
    expect(properties.action.enum).not.toContain('teleport');
    expect(properties.deliveryPolicy.enum).toEqual(['background_native', 'background_only']);
    expect(properties.deliveryPolicy.enum).not.toContain('foreground_persistent');
    const observe = contracts.find(contract => contract.name === 'BimaxObserveTool')!;
    const related = (observe.schema.properties as any).relatedObservations;
    expect(related.maxItems).toBe(3);
    expect(related.items.required).toEqual(['pid', 'scope', 'profile']);
  });

  test('adds only independently live-gated capture modes', () => {
    const value = handshake();
    value.capabilities.observe.regionCapture = true;
    value.capabilities.observe.zoom = true;
    const contracts = buildNativeOperationToolContracts(value);
    const capture = contracts.find(contract => contract.name === 'BimaxCaptureTool')!;
    expect((capture.schema.properties as any).mode.enum).toEqual(['image', 'zoom']);
  });

  test('does not expose partial or inconsistent transaction support', () => {
    const value = handshake();
    value.capabilities.delivery.verifiedSemanticActions = ['invoke', 'set_value'];
    value.capabilities.delivery.verifiedDeliveryPolicies = [];
    const contracts = buildNativeOperationToolContracts(value);
    expect(contracts.map(contract => contract.name)).not.toContain('BimaxTransactionTool');
    expect(contracts.map(contract => contract.name)).not.toContain('BimaxActionTool');
  });

  test('returns no operation tools without a trusted handshake', () => {
    expect(buildNativeOperationToolContracts(undefined)).toEqual([]);
  });
});
