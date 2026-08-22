import { MAC_CONTROL_SCHEMA } from '../server';
import { createNativeLogicalMacControl } from '../native.logical.adapter';
import type { NativeComputerToolSurface } from '../native.tools';
import type { CapabilityTool } from '../provider.tool';

function tool(
  name: string,
  properties: Record<string, unknown>,
  execute: jest.Mock<Promise<string>, [Record<string, unknown>, unknown?]>,
): CapabilityTool {
  return {
    name,
    description: name,
    schema: { type: 'object', properties },
    execute,
  };
}

function fixture() {
  const workspace = jest.fn(async (args: Record<string, unknown>) => JSON.stringify(
    args.operation === 'launch_app'
      ? {
        operation: 'launch_app', outcome: 'launched', finishedLaunching: true,
        app: { pid: 42, bundleId: 'ai.bimax.fixture', displayName: 'Fixture' }, requestedActivation: false,
        resolved: {
          lookup: args.bundleId
            ? { kind: 'bundle_id', value: args.bundleId }
            : { kind: 'name', value: args.appName },
          displayName: 'Fixture',
        },
        frontmostPidBefore: 900, frontmostPidAfter: 900,
      }
      : args.operation === 'set_window_frame'
        ? {
          operation: 'set_window_frame', attempted: true, honored: true, windowGone: false,
          window: { pid: 42, windowId: 7, generation: 3 },
          boundsBefore: { x: 100, y: 100, width: 500, height: 400 },
          boundsAfter: { x: 0, y: 0, width: 720, height: 900 },
          frontmostPidBefore: 900, frontmostPidAfter: 900,
        }
        : args.operation === 'close_window'
          ? {
            operation: 'close_window', attempted: true, honored: true, windowGone: true,
            window: { pid: 42, windowId: 7, generation: 3 },
            frontmostPidBefore: 900, frontmostPidAfter: 900,
          }
      : { operation: args.operation, apps: [{ app: { pid: 42, displayName: 'Fixture' } }], frontmostPid: 42 },
  ));
  const observe = jest.fn(async () => JSON.stringify({
    snapshotId: 'snapshot-one', sessionId: 'native-session', pid: 42,
    windowId: 7, windowGeneration: 3, eventRevision: 11,
    eventTracking: true, truncated: false, partial: false, changedDuringCapture: false,
    nodes: [
      { token: 'continue', role: 'AXButton', label: 'Continue', enabled: true },
      { token: 'composer', role: 'AXTextField', label: 'Message', enabled: true },
    ],
  }));
  const action = jest.fn(async (args: Record<string, unknown>) => JSON.stringify({
    op: 'semantic.action.receipt', payload: {
      outcome: 'performed', deliveryPolicy: 'background_only',
      element: {
        token: args.elementToken, snapshotId: 'snapshot-one', pid: 42,
        windowId: 7, windowGeneration: 3,
      },
      frontmostPidBefore: 900, frontmostPidAfter: 900,
      eventRevisionBefore: 11, eventRevisionAfter: 12,
      evidence: {
        requiredTier: 1, achievedTier: 1, outcome: 'satisfied',
        eventChanged: true, postconditionMatched: true, attempts: 1, settledAtMs: 1_000,
      },
    },
    target: { pid: 42, windowId: 7, windowGeneration: 3 }, request: args,
  }));
  const capture = jest.fn(async () => JSON.stringify({
    mode: 'image', image: { handle: 'image-one' }, width: 800, height: 600,
  }));
  const surface = {
    coordinator: { dispose: jest.fn(async () => {}) } as never,
    tools: [
      tool('BimaxWorkspaceTool', {
        operation: { enum: ['apps', 'windows', 'launch_app', 'set_window_frame', 'close_window'] },
      }, workspace),
      tool('BimaxObserveTool', {
        scope: { enum: ['window'] }, profile: { enum: ['flash', 'balanced'] },
      }, observe),
      tool('BimaxActionTool', {
        action: { enum: ['invoke', 'type_text', 'set_value'] },
        deliveryPolicy: { enum: ['background_only'] },
      }, action),
      tool('BimaxCaptureTool', { mode: { enum: ['image'] } }, capture),
    ],
  } as NativeComputerToolSurface;
  return { surface, workspace, observe, action, capture };
}

function parsed(value: string | undefined) {
  return JSON.parse(String(value));
}

describe('native logical mac_control adapter', () => {
  test('keeps one logical surface while translating observe, semantic action, and capture', async () => {
    const native = fixture();
    const adapter = createNativeLogicalMacControl(native.surface, MAC_CONTROL_SCHEMA);
    const context = { sessionId: 'task-one', cwd: '/tmp' };

    expect(parsed(await adapter.execute({ action: 'status' }, context))).toMatchObject({
      ok: true, route: 'native_logical_adapter', driver: 'bimax-native',
    });
    expect(parsed(await adapter.execute({ action: 'open', bundleId: 'ai.bimax.fixture' }, context)))
      .toMatchObject({ ok: true, action: 'open', nativeTool: 'BimaxWorkspaceTool' });
    const observation = parsed(await adapter.execute({ action: 'observe' }, context));
    expect(observation).toMatchObject({ ok: true, action: 'observe', frameId: 'snapshot-one' });
    expect(observation.elements[0]).toMatchObject({ token: 'continue', elementIndex: 0 });
    expect(native.observe).toHaveBeenCalledWith({
      pid: 42, scope: 'window', profile: 'balanced',
    }, context);

    const click = parsed(await adapter.execute({
      action: 'click', query: 'Continue', frameId: 'snapshot-one', expect: 'Welcome',
    }, context));
    expect(click).toMatchObject({
      ok: true, verified: true, action: 'click', nativeTool: 'BimaxActionTool',
      elementToken: 'continue',
      verification: {
        status: 'verified', freshObservation: true,
        postcondition: { kind: 'semantic_text', source: 'declared' },
        delivery: { requested: 'background', actual: 'background', focusChanged: false },
      },
    });
    expect(native.action).toHaveBeenCalledWith(expect.objectContaining({
      snapshotId: 'snapshot-one', elementToken: 'continue', action: 'invoke',
      deliveryPolicy: 'background_only', evidenceTier: 1,
      postcondition: { text: 'Welcome', textPresence: 'present' }, settleTimeoutMs: 750,
    }), context);

    // Every accepted mutation invalidates the old authority; capture cannot ride a pre-action frame.
    expect(parsed(await adapter.execute({ action: 'screenshot', frameId: 'snapshot-one' }, context)))
      .toMatchObject({ ok: false, executor: 'stop', code: 'native_snapshot_required' });
    await adapter.execute({ action: 'observe' }, context);
    expect(parsed(await adapter.execute({ action: 'screenshot', frameId: 'snapshot-one' }, context)))
      .toMatchObject({ ok: true, action: 'screenshot', executor: 'visual', frameId: 'snapshot-one' });
    expect(native.capture).toHaveBeenCalledWith({
      mode: 'image', pid: 42, windowId: 7, windowGeneration: 3,
    }, context);
  });

  test('runs ten sequential native reads in one logical task session', async () => {
    const native = fixture();
    const adapter = createNativeLogicalMacControl(native.surface, MAC_CONTROL_SCHEMA);
    for (let index = 0; index < 10; index += 1) {
      expect(parsed(await adapter.execute({ action: 'apps' }, { sessionId: 'task-ten' })))
        .toMatchObject({ ok: true, action: 'apps', nativeTool: 'BimaxWorkspaceTool' });
    }
    expect(native.workspace).toHaveBeenCalledTimes(10);
  });

  test('semantic, physical, visual-delivery, menu, and stop paths fail closed before effect', async () => {
    const native = fixture();
    const adapter = createNativeLogicalMacControl(native.surface, MAC_CONTROL_SCHEMA);
    const context = { sessionId: 'task-stop' };
    await adapter.execute({ action: 'open', app: 'Fixture' }, context);
    await adapter.execute({ action: 'observe' }, context);
    const before = native.action.mock.calls.length;

    for (const command of [
      { action: 'key', combo: 'return' },
      { action: 'menu_activate', menuPath: '1.2' },
      { action: 'click', x: 20, y: 30, frameId: 'snapshot-one', expect: 'Done' },
      { action: 'quit_app' },
    ]) {
      expect(parsed(await adapter.execute(command, context))).toMatchObject({
        ok: false, executor: 'stop', blocked: true,
        verification: { status: 'not_attempted', freshObservation: false },
      });
    }
    expect(parsed(await adapter.execute({
      action: 'click', query: 'Continue', frameId: 'snapshot-one',
    }, context))).toMatchObject({
      ok: false, executor: 'stop', blocked: true, code: 'postcondition_required',
    });
    expect(parsed(await adapter.execute({ action: 'click', query: 'AX', frameId: 'snapshot-one' }, context)))
      .toMatchObject({ ok: false, executor: 'stop', code: 'native_selector_unresolved' });
    expect(native.action).toHaveBeenCalledTimes(before);
  });

  test('rejects a delivered semantic action when fresh postcondition evidence is absent', async () => {
    const native = fixture();
    native.action.mockResolvedValueOnce(JSON.stringify({
      op: 'semantic.action.receipt',
      payload: {
        outcome: 'performed', deliveryPolicy: 'background_only',
        element: {
          token: 'continue', snapshotId: 'snapshot-one', pid: 42,
          windowId: 7, windowGeneration: 3,
        },
      },
      target: { pid: 42, windowId: 7, windowGeneration: 3 },
    }));
    const adapter = createNativeLogicalMacControl(native.surface, MAC_CONTROL_SCHEMA);
    const context = { sessionId: 'task-false-success' };
    await adapter.execute({ action: 'open', app: 'Fixture' }, context);
    await adapter.execute({ action: 'observe' }, context);

    expect(parsed(await adapter.execute({
      action: 'click', elementToken: 'continue', expect: 'Welcome',
    }, context))).toMatchObject({
      ok: false, verified: false, actionAttempted: true, visible: true,
      code: 'postcondition_unverified',
      verification: { status: 'unverified', freshObservation: false },
    });
  });

  test('derives exact value/window postconditions and rejects dishonest workspace read-back', async () => {
    const native = fixture();
    const adapter = createNativeLogicalMacControl(native.surface, MAC_CONTROL_SCHEMA);
    const context = { sessionId: 'task-derived' };
    await adapter.execute({ action: 'open', app: 'Fixture' }, context);
    await adapter.execute({ action: 'observe' }, context);

    const setValue = parsed(await adapter.execute({
      action: 'set_value', elementToken: 'composer', value: 'hello',
    }, context));
    expect(setValue).toMatchObject({
      ok: true, verified: true,
      verification: { postcondition: { kind: 'semantic_value', source: 'derived' } },
    });
    expect(native.action).toHaveBeenLastCalledWith(expect.objectContaining({
      postcondition: { expectedValue: 'hello' },
    }), context);

    await adapter.execute({ action: 'observe' }, context);
    expect(parsed(await adapter.execute({ action: 'arrange', layout: 'left' }, context)))
      .toMatchObject({
        ok: true, verified: true,
        verification: { postcondition: { kind: 'window_frame', source: 'derived' } },
      });

    await adapter.execute({ action: 'observe' }, context);
    native.workspace.mockResolvedValueOnce(JSON.stringify({
      operation: 'close_window', attempted: true, honored: false, windowGone: false,
      window: { pid: 42, windowId: 7, generation: 3 },
      frontmostPidBefore: 900, frontmostPidAfter: 900,
    }));
    expect(parsed(await adapter.execute({ action: 'close' }, context))).toMatchObject({
      ok: false, verified: false, actionAttempted: true, code: 'postcondition_unverified',
      verification: { postcondition: { kind: 'window_absent', source: 'derived' } },
    });
  });

  test('a provider restart discards snapshot authority and requires a fresh observation', async () => {
    const native = fixture();
    const first = createNativeLogicalMacControl(native.surface, MAC_CONTROL_SCHEMA);
    const context = { sessionId: 'task-restart' };
    await first.execute({ action: 'open', app: 'Fixture' }, context);
    await first.execute({ action: 'observe' }, context);
    expect(parsed(await first.execute({
      action: 'click', elementToken: 'continue', expect: 'Welcome',
    }, context)).ok).toBe(true);

    const restarted = createNativeLogicalMacControl(native.surface, MAC_CONTROL_SCHEMA);
    expect(parsed(await restarted.execute({
      action: 'click', elementToken: 'continue', expect: 'Welcome',
    }, context)))
      .toMatchObject({ ok: false, executor: 'stop', code: 'native_selector_unresolved' });
  });
});
