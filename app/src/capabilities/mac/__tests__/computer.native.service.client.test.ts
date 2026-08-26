import {
  BIMAX_CU_PROTOCOL,
  NativeServiceCapabilityClient,
  NativeServiceHandshake,
  assessNativeCutover,
  assessNativeSemanticOptIn,
  assessNativeShadowEligibility,
  unsignedServiceOverrideActive,
  assessAdHocServiceTrust,
  supportsFocusLease,
  supportsPageScrolling,
  supportsTextSelection,
} from '../native.service.client';

function handshake(overrides: Partial<NativeServiceHandshake> = {}): NativeServiceHandshake {
  return {
    selectedProtocol: BIMAX_CU_PROTOCOL,
    serviceVersion: '0.6.0',
    platform: { os: 'macos', version: 'test', architecture: 'arm64' },
    capabilities: {
      observe: { profiles: ['flash', 'balanced'], scopes: ['application', 'window', 'system_ui'], axDiff: true, eventRevisions: true, som: false, regionCapture: false, zoom: false, streams: false },
      delivery: {
        policies: [
          'background_native', 'background_only', 'background_preferred',
          'foreground_once', 'foreground_persistent',
        ],
        // The baseline fixture below models the older pre-broker state; individual tests promote
        // foreground policies when they exercise the current cutover gate.
        verifiedDeliveryPolicies: ['background_native', 'background_only', 'background_preferred'],
        semanticActions: [
          'invoke', 'set_value', 'increment', 'decrement', 'toggle', 'expand', 'collapse', 'select',
          'select_text_range', 'select_text', 'set_caret', 'scroll_page',
          'set_selected', 'scroll_to_visible', 'scroll_to_fraction',
        ],
        verifiedSemanticActions: [
          'invoke', 'set_value', 'increment', 'decrement', 'toggle', 'expand', 'collapse', 'select',
          'select_text_range', 'select_text', 'set_caret', 'set_selected', 'scroll_to_fraction',
        ],
        targetedEvents: false,
        physicalInput: false,
        focusLease: false,
        semanticTransactions: false,
      },
      workspace: { apps: true, windows: true, displays: true, spaces: false, files: [], operations: [], verifiedOperations: [] },
      browser: { typedRoute: false, dialogs: false, fileInput: false, downloads: false },
      recording: { trajectory: false, video: false, replayModes: [] },
    },
    limits: { maxTransactionSteps: 5, maxElements: 2_000, maxDiffOperations: 5_000, maxImageDimension: 4_096, maxConcurrentReadSessions: 4, maxCaptureStreams: 2 },
    permissions: {
      accessibility: 'granted', screenRecording: 'denied', screenCapturable: false,
      inputMonitoring: 'not_required', serviceSigned: true, signatureIntact: true,
    },
    ...overrides,
  };
}

const darwinOnly = process.platform === 'darwin' ? describe : describe.skip;

darwinOnly('NativeServiceCapabilityClient', () => {
  test('reports native semantic delivery as reachable but not routing eligible before cutover', async () => {
    const runner = jest.fn(async () => JSON.stringify(handshake()));
    const client = new NativeServiceCapabilityClient('/tmp/bimax-cu-service', runner);
    const result = await client.probe();
    expect(result).toMatchObject({ configured: true, reachable: true, routingEligible: false, attempts: 1 });
    expect(result.handshake?.capabilities.workspace.windows).toBe(true);
  });

  test('allows Phase 9 semantic opt-in without claiming global physical input', () => {
    const ready = handshake();
    ready.capabilities.observe.regionCapture = true;
    ready.capabilities.delivery.verifiedDeliveryPolicies = [
      ...ready.capabilities.delivery.verifiedDeliveryPolicies,
      'foreground_once', 'foreground_persistent',
    ];
    ready.capabilities.delivery.focusLease = true;
    expect(assessNativeCutover(ready, true).blockers).toContain('physical_input_unavailable');
    expect(assessNativeSemanticOptIn(ready, true)).toEqual({ eligible: true, blockers: [] });
    ready.capabilities.observe.regionCapture = false;
    expect(assessNativeSemanticOptIn(ready, true).blockers).toContain('capture_unavailable');
  });

  test('the routing gate alone cannot cut over a backend that is not ready', async () => {
    const runner = jest.fn(async () => JSON.stringify(handshake()));
    const client = new NativeServiceCapabilityClient('/tmp/bimax-cu-service', runner, 2_000, 30_000, true);
    const result = await client.probe();
    expect(result).toMatchObject({ reachable: true, routingEligible: false, attempts: 1 });
    // The env flag is satisfied; the missing Phase 4/5 engines are what still refuse.
    expect(result.cutoverBlockers).not.toContain('routing_gate_disabled');
    expect(result.cutoverBlockers).toEqual(expect.arrayContaining([
      'capture_unavailable',
      'physical_input_unavailable',
      'focus_lease_unavailable',
    ]));
  });

  test('reports the routing gate itself as a blocker when it is off', async () => {
    const runner = jest.fn(async () => JSON.stringify(handshake()));
    const client = new NativeServiceCapabilityClient('/tmp/bimax-cu-service', runner);
    const result = await client.probe();
    expect(result.routingEligible).toBe(false);
    expect(result.cutoverBlockers).toContain('routing_gate_disabled');
  });

  test('becomes eligible only when every structural blocker clears', () => {
    const ready = handshake();
    ready.capabilities.observe.regionCapture = true;
    ready.capabilities.delivery.physicalInput = true;
    // Eligibility follows the evidence, not the flag: the lease has to have been demonstrated.
    ready.capabilities.delivery.verifiedDeliveryPolicies = [
      ...ready.capabilities.delivery.verifiedDeliveryPolicies, 'foreground_once', 'foreground_persistent',
    ];
    ready.capabilities.delivery.focusLease = true;
    expect(assessNativeCutover(ready, true)).toEqual({ eligible: true, blockers: [] });
    expect(assessNativeCutover(ready, false)).toEqual({
      eligible: false,
      blockers: ['routing_gate_disabled'],
    });
    expect(assessNativeCutover(undefined, true)).toEqual({
      eligible: false,
      blockers: ['service_unreachable'],
    });
  });

  test('refuses cutover on unsigned, untrusted, or catalog-incomplete services', () => {
    const ready = () => {
      const value = handshake();
      value.capabilities.observe.regionCapture = true;
      value.capabilities.delivery.physicalInput = true;
      value.capabilities.delivery.verifiedDeliveryPolicies = [
        ...value.capabilities.delivery.verifiedDeliveryPolicies, 'foreground_once', 'foreground_persistent',
      ];
      value.capabilities.delivery.focusLease = true;
      return value;
    };
    const unsigned = ready();
    unsigned.permissions.serviceSigned = false;
    expect(assessNativeCutover(unsigned, true).blockers).toEqual(['service_not_signed']);

    const untrusted = ready();
    untrusted.permissions.accessibility = 'denied';
    expect(assessNativeCutover(untrusted, true).blockers).toEqual(['accessibility_not_granted']);

    const noDiff = ready();
    noDiff.capabilities.observe.axDiff = false;
    noDiff.capabilities.observe.eventRevisions = false;
    expect(assessNativeCutover(noDiff, true).blockers).toEqual([
      'ax_diff_unavailable',
      'event_revisions_unavailable',
    ]);

    const thinCatalog = ready();
    thinCatalog.capabilities.delivery.verifiedSemanticActions = ['invoke'];
    expect(assessNativeCutover(thinCatalog, true).blockers).toEqual([
      'semantic_catalog_unverified',
      'text_selection_unsupported',
      'page_scrolling_unsupported',
    ]);

    // Advertising an action is not evidence it works; only the verified subset counts.
    const advertisedOnly = ready();
    advertisedOnly.capabilities.delivery.verifiedSemanticActions = [];
    expect(assessNativeCutover(advertisedOnly, true).blockers).toEqual([
      'semantic_catalog_unverified',
      'text_selection_unsupported',
      'page_scrolling_unsupported',
    ]);

    // A service claiming to have verified something it will not accept is inconsistent.
    const inconsistent = ready();
    inconsistent.capabilities.delivery.verifiedSemanticActions = [
      ...inconsistent.capabilities.delivery.verifiedSemanticActions, 'teleport',
    ];
    expect(assessNativeCutover(inconsistent, true).blockers).toContain('verified_catalog_inconsistent');
  });

  test('coalesces and caches successful probes', async () => {
    const runner = jest.fn(async () => JSON.stringify(handshake()));
    const client = new NativeServiceCapabilityClient('/tmp/bimax-cu-service', runner);
    const [a, b] = await Promise.all([client.probe(), client.probe()]);
    const c = await client.probe();
    expect(a).toEqual(b);
    expect(c).toEqual(a);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test('recovers from a one-shot crash and does not cache terminal failures', async () => {
    const runner = jest.fn()
      .mockRejectedValueOnce(new Error('service exited'))
      .mockResolvedValueOnce(JSON.stringify(handshake()));
    const client = new NativeServiceCapabilityClient('/tmp/bimax-cu-service', runner);
    await expect(client.probe()).resolves.toMatchObject({ reachable: true, attempts: 2 });

    const failedRunner = jest.fn().mockRejectedValue(new Error('service exited'));
    const failed = new NativeServiceCapabilityClient('/tmp/bimax-cu-service', failedRunner);
    await expect(failed.probe()).resolves.toMatchObject({ reachable: false, attempts: 2 });
    await failed.probe();
    expect(failedRunner).toHaveBeenCalledTimes(4);
  });

  test('fails closed on a protocol mismatch', async () => {
    const runner = jest.fn(async () => JSON.stringify(handshake({ selectedProtocol: 'bimax.cu.v2' })));
    const client = new NativeServiceCapabilityClient('/tmp/bimax-cu-service', runner);
    await expect(client.probe()).resolves.toMatchObject({ reachable: false, routingEligible: false, attempts: 2 });
  });

  test('detects the advertised text-selection and page-scroll catalog', async () => {
    const runner = jest.fn(async () => JSON.stringify(handshake()));
    const client = new NativeServiceCapabilityClient('/tmp/bimax-cu-service', runner);
    const result = await client.probe();
    expect(supportsTextSelection(result.handshake)).toBe(true);
    expect(supportsPageScrolling(result.handshake)).toBe(true);
  });

  test('treats a pre-slice-6 service as lacking text and scroll support', async () => {
    const legacy = handshake();
    legacy.capabilities.delivery.semanticActions = ['invoke', 'set_value', 'toggle', 'select'];
    legacy.capabilities.delivery.verifiedSemanticActions = [];
    const runner = jest.fn(async () => JSON.stringify(legacy));
    const client = new NativeServiceCapabilityClient('/tmp/bimax-cu-service', runner);
    const result = await client.probe();
    // The older service still handshakes and is still reachable; only the newer catalog is absent.
    expect(result).toMatchObject({ reachable: true, attempts: 1 });
    expect(supportsTextSelection(result.handshake)).toBe(false);
    expect(supportsPageScrolling(result.handshake)).toBe(false);
    expect(supportsTextSelection(undefined)).toBe(false);
  });

  test('does not claim text support from a partially advertised catalog', () => {
    const partial = handshake();
    partial.capabilities.delivery.verifiedSemanticActions = ['invoke', 'select_text', 'scroll_to_fraction'];
    expect(supportsTextSelection(partial)).toBe(false);
    expect(supportsPageScrolling(partial)).toBe(true);
  });

  test('believes the focus lease only from the policies actually verified', () => {
    const advertisedOnly = handshake();
    // Every foreground policy is advertised, none is verified: this is the service as it ships.
    expect(advertisedOnly.capabilities.delivery.policies).toEqual(
      expect.arrayContaining(['foreground_once', 'foreground_persistent']),
    );
    expect(supportsFocusLease(advertisedOnly)).toBe(false);
    expect(assessNativeCutover(advertisedOnly, true).blockers).toContain('focus_lease_unavailable');

    const partial = handshake();
    partial.capabilities.delivery.verifiedDeliveryPolicies = [
      ...partial.capabilities.delivery.verifiedDeliveryPolicies, 'foreground_once',
    ];
    // A lease that restores but was never shown to persist is not a verified lease.
    expect(supportsFocusLease(partial)).toBe(false);

    expect(supportsFocusLease(undefined)).toBe(false);
  });

  test('refuses a service that claims a focus lease it has not demonstrated', () => {
    const overclaiming = handshake();
    overclaiming.capabilities.observe.regionCapture = true;
    overclaiming.capabilities.delivery.physicalInput = true;
    // The flag says yes; the evidence list says nothing was ever observed.
    overclaiming.capabilities.delivery.focusLease = true;
    const blockers = assessNativeCutover(overclaiming, true).blockers;
    expect(blockers).toContain('focus_lease_overclaimed');
    expect(blockers).toContain('focus_lease_unavailable');
    expect(assessNativeCutover(overclaiming, true).eligible).toBe(false);
  });

  test('refuses a service verifying a policy it does not accept', () => {
    const inconsistent = handshake();
    inconsistent.capabilities.delivery.verifiedDeliveryPolicies = [
      ...inconsistent.capabilities.delivery.verifiedDeliveryPolicies, 'teleport_once',
    ];
    expect(assessNativeCutover(inconsistent, true).blockers).toContain('verified_policies_inconsistent');
  });

  test('treats a service predating focus conformance as having verified nothing', async () => {
    const legacy = handshake() as unknown as { capabilities: { delivery: Record<string, unknown> } };
    delete legacy.capabilities.delivery.verifiedDeliveryPolicies;
    const runner = jest.fn(async () => JSON.stringify(legacy));
    const client = new NativeServiceCapabilityClient('/tmp/bimax-cu-service', runner);
    const result = await client.probe();
    expect(result).toMatchObject({ reachable: true, routingEligible: false, attempts: 1 });
    expect(result.handshake?.capabilities.delivery.verifiedDeliveryPolicies).toEqual([]);
    expect(supportsFocusLease(result.handshake)).toBe(false);
  });

  test('defaults an omitted additive event-revision capability to unsupported', async () => {
    const legacy = handshake() as unknown as { capabilities: { observe: Record<string, unknown> } };
    delete legacy.capabilities.observe.eventRevisions;
    delete legacy.capabilities.observe.scopes;
    const runner = jest.fn(async () => JSON.stringify(legacy));
    const client = new NativeServiceCapabilityClient('/tmp/bimax-cu-service', runner);
    const result = await client.probe();
    expect(result).toMatchObject({ reachable: true, routingEligible: false, attempts: 1 });
    expect(result.handshake?.capabilities.observe.eventRevisions).toBe(false);
    expect(result.handshake?.capabilities.observe.scopes).toEqual([]);
  });
});

// A service whose only remaining blocker is signing — the exact live state measured on
// 2026-08-02 (regionCapture true, focusLease verified, 15 verified actions, serviceSigned false).
function signingIsTheOnlyBlocker(): NativeServiceHandshake {
  const value = handshake();
  value.capabilities.observe.regionCapture = true;
  value.capabilities.delivery.physicalInput = true;
  value.capabilities.delivery.focusLease = true;
  value.capabilities.delivery.verifiedDeliveryPolicies = [
    ...value.capabilities.delivery.verifiedDeliveryPolicies, 'foreground_once', 'foreground_persistent',
  ];
  value.permissions.serviceSigned = false;
  return value;
}

describe('unsigned-service development override', () => {
  const original = process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
  afterEach(() => {
    if (original === undefined) delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
    else process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE = original;
  });

  test('is off unless set to exactly "1"', () => {
    delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
    expect(unsignedServiceOverrideActive({} as NodeJS.ProcessEnv)).toBe(false);
    // Truthy-looking values must not enable it — a security override should never be reachable by
    // accident from a stray shell export.
    for (const value of ['0', 'true', 'yes', '', 'TRUE', '2']) {
      expect(unsignedServiceOverrideActive({ BIMAX_CU_ALLOW_UNSIGNED_SERVICE: value } as NodeJS.ProcessEnv)).toBe(false);
    }
    expect(unsignedServiceOverrideActive({ BIMAX_CU_ALLOW_UNSIGNED_SERVICE: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  test('refuses an unsigned service by default', () => {
    delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
    const assessment = assessNativeSemanticOptIn(signingIsTheOnlyBlocker(), true);
    expect(assessment.eligible).toBe(false);
    expect(assessment.blockers).toEqual(['service_not_signed']);
  });

  test('admits the same service when the override is set, and still says so in the blockers', () => {
    process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE = '1';
    const assessment = assessNativeSemanticOptIn(signingIsTheOnlyBlocker(), true);
    expect(assessment.eligible).toBe(true);
    // Eligible, but never silent: the run is still recorded as unsigned so a receipt or status line
    // can never imply this was a signed build.
    expect(assessment.blockers).toEqual(['service_unsigned_development_override']);
  });

  test('never clears a MEASURED capability blocker', () => {
    // The whole point of the gate is that capabilities come from the handshake. An environment
    // variable may lower the trust bar; it must not be able to invent a capability.
    process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE = '1';
    const value = signingIsTheOnlyBlocker();
    value.capabilities.observe.regionCapture = false;
    value.capabilities.delivery.physicalInput = false;
    const assessment = assessNativeSemanticOptIn(value, true);
    expect(assessment.eligible).toBe(false);
    expect(assessment.blockers).toContain('capture_unavailable');
  });

  test('does not clear physical input on the FULL cutover gate', () => {
    // Signing is the narrower gate's only blocker; the full replacement gate must still refuse,
    // because physical input genuinely is not implemented.
    process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE = '1';
    const value = signingIsTheOnlyBlocker();
    value.capabilities.delivery.physicalInput = false;
    const assessment = assessNativeCutover(value, true);
    expect(assessment.eligible).toBe(false);
    expect(assessment.blockers).toContain('physical_input_unavailable');
  });

  test('still refuses when routing itself is disabled', () => {
    // The override lowers the signing bar only. It must not imply the routing gate.
    process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE = '1';
    const assessment = assessNativeSemanticOptIn(signingIsTheOnlyBlocker(), false);
    expect(assessment.eligible).toBe(false);
    expect(assessment.blockers).toContain('routing_gate_disabled');
  });

  test('applies identically to the shadow gate, so the two cannot drift', () => {
    process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE = '1';
    const value = signingIsTheOnlyBlocker();
    value.capabilities.observe.scopes = ['application', 'window'];
    const assessment = assessNativeShadowEligibility(value, true);
    expect(assessment.blockers).not.toContain('service_not_signed');
    expect(assessment.blockers).toContain('service_unsigned_development_override');
  });
});

describe('user-approved ad-hoc service (Developer-ID dropped, integrity kept)', () => {
  const CDHASH = '0fa45ab41e395b996479ea2de29ccdaaf7cefd7c';
  const original = process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
  afterEach(() => {
    if (original === undefined) delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
    else process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE = original;
  });

  /** An ad-hoc service whose seal verifies — the shape measured from a real build on 2026-08-06. */
  const adHoc = (over: Record<string, unknown> = {}) => {
    const value = signingIsTheOnlyBlocker();
    value.permissions.adHocSigned = true;
    value.permissions.signatureIntact = true;
    value.permissions.codeDirectoryHash = CDHASH;
    Object.assign(value.permissions, over);
    return value;
  };

  test('admits an intact, approved ad-hoc service and still says so in the blockers', () => {
    delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
    const assessment = assessNativeSemanticOptIn(adHoc(), true, { codeDirectoryHash: CDHASH });
    expect(assessment.eligible).toBe(true);
    // Advisory, never silent: no status line or receipt may imply a production identity.
    expect(assessment.blockers).toEqual(['service_ad_hoc_user_approved']);
  });

  test('refuses the same binary when the user has not approved it', () => {
    delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
    const assessment = assessNativeSemanticOptIn(adHoc(), true);
    expect(assessment.eligible).toBe(false);
    expect(assessment.blockers).toEqual(['service_not_signed']);
  });

  // The two attacks this design exists to refuse. Measured on a real ad-hoc binary: flipping one
  // byte took signatureIntact true -> false (errSecCSSignatureFailed) while codeDirectoryHash did
  // NOT change, because the hash is read out of the signature blob rather than recomputed.
  test('refuses a tampered binary that kept the approved hash', () => {
    delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
    const tampered = adHoc({ signatureIntact: false });
    const trust = assessAdHocServiceTrust(tampered.permissions, { codeDirectoryHash: CDHASH });
    expect(trust.trusted).toBe(false);
    expect(trust.reason).toMatch(/modified after it was sealed/i);
    expect(assessNativeSemanticOptIn(tampered, true, { codeDirectoryHash: CDHASH }).eligible).toBe(false);
  });

  test('refuses a DIFFERENT binary that is perfectly intact — re-signing ad-hoc is free', () => {
    delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
    const substituted = adHoc({ codeDirectoryHash: 'deadbeef'.repeat(5) });
    const trust = assessAdHocServiceTrust(substituted.permissions, { codeDirectoryHash: CDHASH });
    expect(trust.trusted).toBe(false);
    expect(trust.reason).toMatch(/changed since it was approved/i);
    expect(assessNativeSemanticOptIn(substituted, true, { codeDirectoryHash: CDHASH }).eligible).toBe(false);
  });

  test('a missing field is never a satisfied check', () => {
    // An older service that predates these fields must not be admitted by their absence.
    for (const missing of [{ adHocSigned: undefined }, { signatureIntact: undefined }, { codeDirectoryHash: undefined }]) {
      const trust = assessAdHocServiceTrust(adHoc(missing).permissions, { codeDirectoryHash: CDHASH });
      expect(trust.trusted).toBe(false);
    }
  });

  test('never clears a MEASURED blocker', () => {
    // Consent speaks to provenance only. A capability the service does not have cannot be approved
    // into existence.
    delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
    const value = adHoc();
    value.permissions.accessibility = 'denied';
    value.capabilities.observe.axDiff = false;
    const assessment = assessNativeCutover(value, true, { codeDirectoryHash: CDHASH });
    expect(assessment.eligible).toBe(false);
    expect(assessment.blockers).toContain('accessibility_not_granted');
    expect(assessment.blockers).toContain('ax_diff_unavailable');
  });

  test('applies identically to the shadow gate, so the two cannot drift', () => {
    delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
    const value = adHoc();
    value.capabilities.observe.scopes = ['application', 'window'];
    const assessment = assessNativeShadowEligibility(value, true, { codeDirectoryHash: CDHASH });
    expect(assessment.eligible).toBe(true);
    expect(assessment.blockers).toEqual(['service_ad_hoc_user_approved']);
  });

  test('a production-signed service needs no approval and is not labelled ad-hoc', () => {
    const signed = signingIsTheOnlyBlocker();
    signed.permissions.serviceSigned = true;
    const assessment = assessNativeSemanticOptIn(signed, true);
    expect(assessment.eligible).toBe(true);
    expect(assessment.blockers).toEqual([]);
  });

  test('a non-ad-hoc identity never hides a failed signature validation', () => {
    const signed = signingIsTheOnlyBlocker();
    signed.permissions.serviceSigned = true;
    signed.permissions.signatureIntact = false;
    expect(assessNativeSemanticOptIn(signed, true)).toMatchObject({
      eligible: false,
      blockers: ['service_signature_invalid'],
    });
  });

  // The gate above shipped implemented, tested, and INERT: no caller supplied an approval, so it
  // always saw `undefined` and every ad-hoc service was refused exactly as before. These are the
  // tests that would have failed then — they pin that a stored approval actually reaches a probe.
  darwinOnly('reaching the gate from a live probe', () => {
    const service = () => JSON.stringify(adHoc());

    test('a probe with no stored approval refuses the ad-hoc service', async () => {
      delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
      const client = new NativeServiceCapabilityClient(
        '/tmp/bimax-cu-service', jest.fn(async () => service()), 2_000, 30_000, true, () => undefined,
      );
      const result = await client.probe();
      expect(result.routingEligible).toBe(false);
      expect(result.cutoverBlockers).toEqual(['service_not_signed']);
      expect(result.adHocApproval).toBeUndefined();
    });

    test('a probe with the matching approval admits it, and carries the record forward', async () => {
      delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
      const client = new NativeServiceCapabilityClient(
        '/tmp/bimax-cu-service', jest.fn(async () => service()), 2_000, 30_000, true,
        () => ({ codeDirectoryHash: CDHASH }),
      );
      const result = await client.probe();
      expect(result.routingEligible).toBe(true);
      expect(result.cutoverBlockers).toEqual(['service_ad_hoc_user_approved']);
      // Carried, not re-read: every later gate must assess against the SAME record, or a revoke
      // landing mid-probe could leave one surface calling the service trusted and another unsigned.
      expect(result.adHocApproval).toEqual({ codeDirectoryHash: CDHASH });
    });

    test('an approval for a different binary does not admit this one', async () => {
      delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
      const client = new NativeServiceCapabilityClient(
        '/tmp/bimax-cu-service', jest.fn(async () => service()), 2_000, 30_000, true,
        () => ({ codeDirectoryHash: 'deadbeef'.repeat(5) }),
      );
      const result = await client.probe();
      expect(result.routingEligible).toBe(false);
      expect(result.cutoverBlockers).toEqual(['service_not_signed']);
    });

    test('the approval is read per probe, so a revoke takes effect without a restart', async () => {
      delete process.env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE;
      let approved = true;
      const client = new NativeServiceCapabilityClient(
        '/tmp/bimax-cu-service', jest.fn(async () => service()), 2_000, 30_000, true,
        () => (approved ? { codeDirectoryHash: CDHASH } : undefined),
      );
      expect((await client.probe()).routingEligible).toBe(true);
      approved = false;
      client.invalidate(); // what /computer trust-service revoke does
      expect((await client.probe(true)).routingEligible).toBe(false);
    });
  });
});
