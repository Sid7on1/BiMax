import { createHash } from 'crypto';

import type { NativeServiceHandshake } from '../native.service.client';
import { BIMAX_CU_PROTOCOL } from '../native.service.client';
import {
  compileNativeSemanticTransaction,
  NativeTransactionCompileError,
  type NativeElementRef,
  type NativeTransactionStep,
} from '../native.transaction.compiler';

function handshake(): NativeServiceHandshake {
  return {
    selectedProtocol: BIMAX_CU_PROTOCOL,
    serviceVersion: 'test',
    platform: { os: 'macos', version: 'test', architecture: 'arm64' },
    capabilities: {
      observe: {
        profiles: ['flash'], scopes: ['window'], axDiff: true, eventRevisions: true,
        som: false, regionCapture: false, zoom: false, streams: false,
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

function ref(overrides: Partial<NativeElementRef> = {}): NativeElementRef {
  return {
    token: 'token-one', snapshotId: 'snapshot-one', pid: 42, windowId: 7,
    windowGeneration: 3, axRevision: 11, stablePathHash: 'stable-one', ...overrides,
  };
}

function steps(): NativeTransactionStep[] {
  return [
    {
      stepId: 'edit-one', element: ref(), action: 'set_value',
      value: { type: 'string', value: 'after-one' },
      precondition: { expectedRole: 'AXTextField', expectedValue: 'before-one' },
    },
    {
      stepId: 'select-two', element: ref({ token: 'token-two', stablePathHash: 'stable-two' }),
      action: 'set_selected', value: { type: 'boolean', value: true },
      precondition: { expectedSelected: false },
    },
  ];
}

function compile(candidate = steps()) {
  return compileNativeSemanticTransaction({
    basedOnSnapshotId: 'snapshot-one', steps: candidate, deliveryPolicy: 'background_only',
  }, handshake());
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error('expected compiler to refuse');
  } catch (error) {
    expect(error).toBeInstanceOf(NativeTransactionCompileError);
    expect((error as NativeTransactionCompileError).code).toBe(code);
  }
}

describe('native semantic transaction compiler', () => {
  test('binds an expanded routine-only approval manifest to the exact wire payload', () => {
    const compiled = compile();
    expect(compiled.request.approvalManifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash('sha256').update(compiled.canonicalPayload).digest('hex'))
      .toBe(compiled.request.approvalManifestHash);
    expect(compiled.approvalManifest).toMatchObject({
      bindingHash: compiled.request.approvalManifestHash,
      basedOnSnapshotId: 'snapshot-one',
      target: { pid: 42, windowId: 7, windowGeneration: 3 },
      deliveryPath: 'background_only',
      containsCommitBoundary: false,
    });
    expect(compiled.approvalManifest.steps.every(step => (
      step.impact === 'routine' && !step.commitBoundary && step.requiredEvidence === 'semantic'
    ))).toBe(true);
  });

  test('matches the Swift JSONEncoder sorted-key SHA-256 vector', () => {
    const vectorSteps: NativeTransactionStep[] = [
      {
        stepId: 'edit/日本',
        element: ref({
          token: 'token/日本', snapshotId: 'snapshot/vector', stablePathHash: 'stable/path',
        }),
        action: 'set_value', value: { type: 'string', value: 'after/value' },
        precondition: { expectedRole: 'AXTextField', expectedValue: 'before/value' },
      },
    ];
    const compiled = compileNativeSemanticTransaction({
      basedOnSnapshotId: 'snapshot/vector', steps: vectorSteps,
      deliveryPolicy: 'background_native',
    }, handshake());
    expect(compiled.canonicalPayload).toBe(
      '{"basedOnSnapshotId":"snapshot\\/vector","deliveryPolicy":"background_native","steps":[{"action":"set_value","element":{"axRevision":11,"pid":42,"snapshotId":"snapshot\\/vector","stablePathHash":"stable\\/path","token":"token\\/日本","windowGeneration":3,"windowId":7},"precondition":{"expectedRole":"AXTextField","expectedValue":"before\\/value"},"stepId":"edit\\/日本","value":{"type":"string","value":"after\\/value"}}]}',
    );
    expect(compiled.request.approvalManifestHash)
      .toBe('17c667538c791fe90c92b6958f31458eabb72557d9cc8ce1ebd25a4db8bccf6a');
  });

  test('changes the binding when an entered value is tampered', () => {
    const before = compile();
    const changed = steps();
    changed[0].value = { type: 'string', value: 'different' };
    expect(compile(changed).request.approvalManifestHash)
      .not.toBe(before.request.approvalManifestHash);
  });

  test('refuses mixed snapshots and exact targets before transport', () => {
    const mixedSnapshot = steps();
    mixedSnapshot[1].element.snapshotId = 'snapshot-two';
    expectCode(() => compile(mixedSnapshot), 'transaction_snapshot_mismatch');

    const mixedWindow = steps();
    mixedWindow[1].element.windowGeneration = 4;
    expectCode(() => compile(mixedWindow), 'transaction_target_mismatch');
  });

  test('refuses duplicate IDs, malformed values, and the measured step limit', () => {
    const duplicate = steps();
    duplicate[1].stepId = duplicate[0].stepId;
    expectCode(() => compile(duplicate), 'invalid_transaction_step_id');

    const malformed = steps();
    malformed[1].value = { type: 'string', value: 'not boolean' };
    expectCode(() => compile(malformed), 'invalid_transaction_value');

    const value = handshake();
    value.limits.maxTransactionSteps = 1;
    expectCode(() => compileNativeSemanticTransaction({
      basedOnSnapshotId: 'snapshot-one', steps: steps(), deliveryPolicy: 'background_only',
    }, value), 'invalid_transaction_size');
  });

  test('refuses a commit-boundary action and partial capability claims', () => {
    const commit = steps() as unknown as Array<Record<string, unknown>>;
    commit[0].action = 'submit';
    expectCode(() => compile(commit as unknown as NativeTransactionStep[]), 'transaction_commit_boundary');

    const value = handshake();
    value.capabilities.delivery.verifiedSemanticActions = ['set_value'];
    expectCode(() => compileNativeSemanticTransaction({
      basedOnSnapshotId: 'snapshot-one', steps: steps(), deliveryPolicy: 'background_only',
    }, value), 'transaction_capability_unavailable');
  });

  test('refuses unexpected step fields rather than hashing hidden intent', () => {
    const candidate = steps() as unknown as Array<NativeTransactionStep & { commitBoundary?: boolean }>;
    candidate[0].commitBoundary = false;
    expectCode(() => compile(candidate), 'transaction_action_unsupported');

    const nested = steps() as unknown as Array<NativeTransactionStep & {
      element: NativeElementRef & { hidden?: string };
    }>;
    nested[0].element.hidden = 'not on the Swift wire type';
    expectCode(() => compile(nested), 'invalid_transaction_field');
  });

  test('freezes both the signed request and expanded approval view', () => {
    const compiled = compile();
    expect(Object.isFrozen(compiled.request)).toBe(true);
    expect(Object.isFrozen(compiled.request.steps[0].value)).toBe(true);
    expect(Object.isFrozen(compiled.approvalManifest)).toBe(true);
    expect(Object.isFrozen(compiled.approvalManifest.steps[0].element)).toBe(true);
  });
});
