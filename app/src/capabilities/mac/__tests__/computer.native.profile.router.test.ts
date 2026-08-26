import type { NativeServiceHandshake } from '../native.service.client';
import { BIMAX_CU_PROTOCOL } from '../native.service.client';
import {
  routeNativePerceptionProfile,
  type NativeModelPerceptionCapabilities,
} from '../native.profile.router';

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
        policies: ['background_native', 'background_only'],
        verifiedDeliveryPolicies: ['background_native', 'background_only'],
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

const textModel: NativeModelPerceptionCapabilities = {
  visionInput: false, parallelToolCalls: true, coordinateGrounding: false,
};
const toolVisionModel: NativeModelPerceptionCapabilities = {
  visionInput: true, parallelToolCalls: true, coordinateGrounding: false,
};
const coordinateModel: NativeModelPerceptionCapabilities = {
  visionInput: true, parallelToolCalls: true, coordinateGrounding: true,
};

describe('native perception profile routing', () => {
  test('routes text-only and strong-tool vision models through advertised AX profiles', () => {
    expect(routeNativePerceptionProfile({ model: textModel }, handshake())).toMatchObject({
      desiredProfile: 'flash', selectedProfile: 'flash', backendEligible: true, blockers: [],
    });
    expect(routeNativePerceptionProfile({ model: toolVisionModel }, handshake())).toMatchObject({
      desiredProfile: 'balanced', selectedProfile: 'balanced', backendEligible: true, blockers: [],
    });

    const flashOnly = handshake();
    flashOnly.capabilities.observe.profiles = ['flash'];
    expect(routeNativePerceptionProfile({ model: toolVisionModel }, flashOnly)).toMatchObject({
      desiredProfile: 'balanced', selectedProfile: 'flash', backendEligible: true, blockers: [],
    });
  });

  test('does not launder the suspended capture gate into a visual profile', () => {
    const route = routeNativePerceptionProfile({ model: coordinateModel }, handshake());
    expect(route).toMatchObject({
      desiredProfile: 'som', selectedProfile: null, backendEligible: false,
      consideredProfiles: ['som', 'vision'],
    });
    expect(route.blockers).toEqual(expect.arrayContaining([
      'profile_som_unadvertised', 'som_unavailable', 'capture_unavailable',
      'profile_vision_unadvertised',
    ]));
  });

  test('keeps explicit visual requests blocked when their evidence cannot be produced', () => {
    const route = routeNativePerceptionProfile({
      model: toolVisionModel, requestedProfile: 'vision',
    }, handshake());
    expect(route.selectedProfile).toBeNull();
    expect(route.blockers).toContain('capture_unavailable');
    expect(route.consideredProfiles).not.toContain('balanced');
    expect(route.consideredProfiles).not.toContain('flash');
  });

  test('escalates AX-silent and repeatedly ungrounded targets to measured visual routes', () => {
    const value = handshake();
    value.capabilities.observe.profiles.push('vision', 'som');
    value.capabilities.observe.regionCapture = true;
    value.capabilities.observe.som = true;

    expect(routeNativePerceptionProfile({
      model: toolVisionModel, requestedProfile: 'flash', target: { axSilent: true },
    }, value)).toMatchObject({
      desiredProfile: 'vision', selectedProfile: 'vision', safetyEscalation: true,
    });
    expect(routeNativePerceptionProfile({
      model: coordinateModel, requestedProfile: 'balanced', target: { groundingFailures: 2 },
    }, value)).toMatchObject({
      desiredProfile: 'som', selectedProfile: 'som', safetyEscalation: true,
    });
  });

  test('requires audit evidence for high-impact commits and never downgrades it', () => {
    const blocked = routeNativePerceptionProfile({
      model: textModel, requestedProfile: 'flash', action: { highImpact: true },
    }, handshake());
    expect(blocked).toMatchObject({
      desiredProfile: 'audit', selectedProfile: null, backendEligible: false,
      safetyEscalation: true, consideredProfiles: ['audit'],
    });

    const value = handshake();
    value.capabilities.observe.profiles.push('audit');
    value.capabilities.observe.regionCapture = true;
    expect(routeNativePerceptionProfile({
      model: textModel, action: { highImpact: true },
    }, value)).toMatchObject({
      desiredProfile: 'audit', selectedProfile: 'audit', backendEligible: true,
    });
  });

  test('uses only capabilities actually advertised by the native handshake', () => {
    const value = handshake();
    value.capabilities.observe.som = true;
    value.capabilities.observe.regionCapture = true;
    const route = routeNativePerceptionProfile({ model: coordinateModel }, value);
    expect(route.selectedProfile).toBeNull();
    expect(route.blockers).toContain('profile_som_unadvertised');
    expect(route.blockers).toContain('profile_vision_unadvertised');
  });

  test('rejects malformed model capability input rather than guessing', () => {
    const route = routeNativePerceptionProfile({
      model: { visionInput: true } as NativeModelPerceptionCapabilities,
    }, handshake());
    expect(route).toMatchObject({
      selectedProfile: null, backendEligible: false, blockers: ['invalid_model_capabilities'],
    });
  });
});
