#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import readline from 'node:readline';

const protocol = 'bimax.cu.v1';
// The production bridge intentionally forwards almost no environment. The deterministic fixture
// therefore uses one fixed /tmp coordination file unless invoked directly with an override.
const epochFile = process.env.BIMAX_PHASE1_FIXTURE_EPOCH_FILE || '/tmp/bimax-cu-phase1-fixture-epoch';

function epoch() {
  try { return String(readFileSync(epochFile, 'utf8')).trim() || '1'; }
  catch { return '1'; }
}

const handshake = {
  selectedProtocol: protocol,
  serviceVersion: 'phase1-fixture',
  platform: { os: 'macos', version: 'fixture', architecture: process.arch },
  capabilities: {
    observe: {
      profiles: ['flash', 'balanced'], scopes: ['application', 'window', 'system_ui'],
      axDiff: true, eventRevisions: true, som: true, regionCapture: true, zoom: true, streams: false,
    },
    delivery: {
      policies: ['background_only', 'foreground_once', 'foreground_persistent'],
      verifiedDeliveryPolicies: ['background_only', 'foreground_once', 'foreground_persistent'],
      semanticActions: [
        'invoke', 'set_value', 'toggle', 'select', 'select_text_range', 'select_text',
        'set_caret', 'scroll_to_fraction', 'type_text',
      ],
      verifiedSemanticActions: [
        'invoke', 'set_value', 'toggle', 'select', 'select_text_range', 'select_text',
        'set_caret', 'scroll_to_fraction', 'type_text',
      ],
      targetedEvents: true, physicalInput: true, focusLease: true, semanticTransactions: false,
    },
    workspace: {
      apps: true, windows: true, displays: true, spaces: false, files: [],
      operations: ['resolve_app', 'launch_app', 'set_window_frame', 'close_window'],
      verifiedOperations: ['resolve_app', 'launch_app', 'set_window_frame', 'close_window'],
    },
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

if (process.argv.includes('--self-test-handshake')) {
  process.stdout.write(`${JSON.stringify(handshake)}\n`);
  process.exit(0);
}

if (!process.argv.includes('--stdio')) {
  process.stderr.write('native provider fixture requires --self-test-handshake or --stdio\n');
  process.exit(2);
}

let currentEpoch = epoch();
const sessions = new Set();
let actionCount = 0;
let snapshotCount = 0;

function response(request, body = undefined, error = undefined) {
  const service = {
    protocol,
    requestId: request.requestId,
    sessionId: request.sessionId,
    serviceVersion: 'phase1-fixture',
    ...(body ? { body } : {}),
    ...(error ? { error } : {}),
  };
  return { requestId: request.requestId, response: service };
}

function handle(request) {
  const nextEpoch = epoch();
  if (nextEpoch !== currentEpoch) {
    currentEpoch = nextEpoch;
    sessions.clear();
  }
  const op = request?.body?.op;
  if (op === 'handshake') return response(request, { op: 'handshake', payload: handshake });
  if (op === 'session.create') {
    const sessionId = `${String(request.body?.payload?.requestedId || 'task')}-epoch-${currentEpoch}`;
    sessions.add(sessionId);
    return response(request, { op: 'session', payload: { sessionId } });
  }
  if (!sessions.has(request.sessionId)) {
    return response(request, undefined, {
      code: 'session_not_found', message: 'fixture service session retired', retryable: true,
    });
  }
  if (op === 'workspace.snapshot') {
    return response(request, { op: 'workspace.snapshot', payload: {
      apps: [{ app: {
        pid: 42, displayName: `Phase1FixtureEpoch${currentEpoch}`,
        bundleId: 'ai.bimax.phase1.fixture', fixtureActionCount: actionCount,
      } }],
      windows: [{
        window: { pid: 42, windowId: 7, generation: 3 },
        title: 'Phase 2 Fixture', bounds: { x: 100, y: 100, width: 500, height: 400 },
      }],
      displays: [{
        displayId: 1, main: true,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        usableBounds: { x: 0, y: 0, width: 1440, height: 900 },
      }],
      frontmostPid: 900, epoch: currentEpoch,
    } });
  }
  if (op === 'workspace.app.resolve') {
    const lookup = request.body?.payload?.lookup || {};
    return response(request, { op: 'workspace.app.resolved', payload: {
      lookup, resolved: true, bundlePath: '/Applications/Phase2Fixture.app',
      bundleId: lookup.kind === 'bundle_id' ? lookup.value : 'ai.bimax.phase1.fixture',
      displayName: lookup.kind === 'name' ? lookup.value : 'Phase2Fixture', running: [],
    } });
  }
  if (op === 'workspace.app.launch') {
    const lookup = request.body?.payload?.lookup || {};
    return response(request, { op: 'workspace.app.launch.receipt', payload: {
      outcome: 'launched',
      app: {
        pid: 42,
        bundleId: lookup.kind === 'bundle_id' ? lookup.value : 'ai.bimax.phase1.fixture',
        displayName: lookup.kind === 'name' ? lookup.value : 'Phase2Fixture',
      },
      bundleId: lookup.kind === 'bundle_id' ? lookup.value : 'ai.bimax.phase1.fixture',
      requestedActivation: false, frontmostPidBefore: 900, frontmostPidAfter: 900,
      finishedLaunching: true, durationMs: 1,
    } });
  }
  if (op === 'ax.observe') {
    snapshotCount += 1;
    const snapshotId = `phase2-snapshot-${snapshotCount}`;
    const ref = token => ({
      token, snapshotId, pid: 42, windowId: 7, windowGeneration: 3,
      axRevision: snapshotCount, stablePathHash: `phase2-${token}`,
    });
    return response(request, { op: 'ax.snapshot', payload: {
      snapshotId, sessionId: request.sessionId, pid: 42, windowId: 7, windowGeneration: 3,
      eventRevision: snapshotCount, eventTracking: true, truncated: false, partial: false,
      changedDuringCapture: false, profile: request.body?.payload?.profile || 'balanced',
      scope: request.body?.payload?.scope || 'window',
      nodes: [
        {
          token: 'continue', role: 'AXButton', label: 'Continue', enabled: true,
          elementRef: ref('continue'),
        },
        {
          token: 'composer', role: 'AXTextField', label: 'Message', value: '', enabled: true,
          elementRef: ref('composer'),
        },
      ],
    } });
  }
  if (op === 'semantic.action') {
    actionCount += 1;
    const payload = request.body?.payload || {};
    const postcondition = payload.evidence?.postcondition || {};
    const matched = postcondition.text !== 'NEVER_VERIFY'
      && (postcondition.text !== undefined || postcondition.expectedValue !== undefined);
    // Foreground policies are delivered under a simulated exact-PID lease: activation moves the
    // frontmost pid from the human (900) to the target (42), and the receipt carries the lease so
    // the logical grader can prove the requested foreground actually happened.
    const foreground = payload.deliveryPolicy === 'foreground_once'
      || payload.deliveryPolicy === 'foreground_persistent';
    return response(request, { op: 'semantic.action.receipt', payload: {
      actionId: `phase2-action-${actionCount}`, element: payload.element,
      action: payload.action, primitive: payload.action === 'invoke' ? 'AXPress' : 'AXValue',
      outcome: 'performed', deliveryPolicy: payload.deliveryPolicy,
      startedAtMs: 1_000, completedAtMs: 1_010,
      eventRevisionBefore: payload.expectedEventRevision,
      eventRevisionAfter: payload.expectedEventRevision + 1,
      frontmostPidBefore: 900, frontmostPidAfter: foreground ? 42 : 900,
      ...(foreground ? { focusLease: { grantedAtMs: 1_000, expiresAtMs: 61_000 } } : {}),
      attemptedPaths: [],
      evidence: {
        requiredTier: payload.evidence?.tier,
        achievedTier: 1,
        outcome: matched ? 'satisfied' : 'timed_out',
        eventChanged: true, postconditionMatched: matched,
        attempts: matched ? 1 : 2, settledAtMs: 1_009,
      },
    } });
  }
  if (op === 'workspace.window.operate') {
    const payload = request.body?.payload || {};
    const close = payload.operation === 'close_window';
    return response(request, { op: 'workspace.window.receipt', payload: {
      operation: payload.operation, window: payload.window, attempted: true, honored: true,
      boundsBefore: { x: 100, y: 100, width: 500, height: 400 },
      ...(close ? {} : { boundsAfter: payload.frame }),
      windowGone: close, frontmostPidBefore: 900, frontmostPidAfter: 900, durationMs: 1,
    } });
  }
  if (op === 'capture.image') {
    return response(request, { op: 'capture.image.receipt', payload: {
      mode: 'image', image: { handle: 'phase2-image' }, width: 500, height: 400,
    } });
  }
  if (op === 'session.close') {
    sessions.delete(request.sessionId);
    return response(request, { op: 'session.closed' });
  }
  return response(request, undefined, {
    code: 'fixture_operation_unsupported', message: `fixture does not implement ${String(op)}`, retryable: false,
  });
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  try { process.stdout.write(`${JSON.stringify(handle(JSON.parse(line)))}\n`); }
  catch (error) {
    process.stdout.write(`${JSON.stringify({
      requestId: 'malformed', error: { code: 'fixture_error', message: String(error) },
    })}\n`);
  }
});
