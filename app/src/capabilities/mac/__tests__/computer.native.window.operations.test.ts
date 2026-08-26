import type { NativeServiceOperationClient } from '../native.bridge.transport';
import { NativeToolCoordinator } from '../native.tool.coordinator';
import { computeWindowTile, displayForWindow } from '../native.window.layout';
import { BIMAX_CU_PROTOCOL, type NativeServiceHandshake } from '../native.service.client';

const WINDOW_OPERATIONS = [
  'move_window', 'resize_window', 'set_window_frame', 'minimize_window', 'unminimize_window',
  'close_window', 'set_window_fullscreen',
];

function handshake(verified: string[] = WINDOW_OPERATIONS): NativeServiceHandshake {
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
        policies: ['background_only'], verifiedDeliveryPolicies: ['background_only'],
        semanticActions: ['invoke'], verifiedSemanticActions: ['invoke'],
        targetedEvents: true, physicalInput: false, focusLease: false, semanticTransactions: false,
      },
      workspace: {
        apps: true, windows: true, displays: true, spaces: false, files: [],
        operations: WINDOW_OPERATIONS, verifiedOperations: verified,
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

function fakeClient(usableBounds: unknown = { x: 0, y: 33, width: 1_470, height: 864 }) {
  const client = {
    available: jest.fn(() => true),
    createSession: jest.fn(async () => ({ sessionId: 'native-session' })),
    workspace: jest.fn(async () => ({
      windows: [{
        window: { pid: 42, windowId: 7, generation: 3, title: 'Fixture' },
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      }],
      displays: [{
        displayId: 1, bounds: { x: 0, y: 0, width: 1_470, height: 956 },
        // `null` stands for a display whose usable area could not be measured, which the wire
        // represents by omitting the field entirely.
        ...(usableBounds ? { usableBounds } : {}),
      }],
    })),
    windowOperation: jest.fn(async (_session: string, request: Record<string, unknown>) => ({
      operation: request.operation, window: request.window, attempted: true, honored: true,
      boundsBefore: { x: 100, y: 100, width: 800, height: 600 },
      boundsAfter: request.frame ?? { x: 100, y: 100, width: 800, height: 600 },
      windowGone: false, frontmostPidBefore: 501, frontmostPidAfter: 501,
      frontmostChanged: false, durationMs: 40,
    })),
    closeSession: jest.fn(async () => {}),
    dispose: jest.fn(async () => {}),
  };
  return { client: client as unknown as NativeServiceOperationClient, raw: client };
}

describe('native window operations', () => {
  test('layout presets divide the usable area, not the whole display', () => {
    const usable = { x: 0, y: 33, width: 1_470, height: 864 };
    expect(computeWindowTile('maximize', usable)).toEqual(usable);
    expect(computeWindowTile('left_half', usable)).toEqual({ x: 0, y: 33, width: 735, height: 864 });
    expect(computeWindowTile('right_half', usable)).toEqual({ x: 735, y: 33, width: 735, height: 864 });
    expect(computeWindowTile('bottom_right', usable)).toEqual({ x: 735, y: 465, width: 735, height: 432 });
    expect(computeWindowTile('center_third', usable)).toEqual({ x: 490, y: 33, width: 490, height: 864 });
    expect(computeWindowTile('right_two_thirds', usable)).toEqual({ x: 490, y: 33, width: 980, height: 864 });
    expect(computeWindowTile('center', usable)).toEqual({ x: 368, y: 249, width: 735, height: 432 });

    // A tile never covers the menu bar: every preset stays inside the usable rectangle.
    for (const preset of ['left_half', 'top_half', 'top_left', 'center', 'maximize'] as const) {
      const rect = computeWindowTile(preset, usable)!;
      expect(rect.y).toBeGreaterThanOrEqual(usable.y);
      expect(rect.x + rect.width).toBeLessThanOrEqual(usable.x + usable.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(usable.y + usable.height + 1);
    }

    // An unmeasured or degenerate usable area produces no layout at all.
    expect(computeWindowTile('maximize', undefined)).toBeNull();
    expect(computeWindowTile('maximize', { x: 0, y: 0, width: 0, height: 100 })).toBeNull();
  });

  test('a window is tiled on the display it is actually on', () => {
    const displays = [
      { displayId: 1, bounds: { x: 0, y: 0, width: 1_470, height: 956 }, usableBounds: { x: 0, y: 33, width: 1_470, height: 864 } },
      { displayId: 2, bounds: { x: 1_470, y: 0, width: 1_920, height: 1_080 }, usableBounds: { x: 1_470, y: 0, width: 1_920, height: 1_080 } },
    ];
    expect(displayForWindow({ x: 1_600, y: 200, width: 400, height: 300 }, displays)?.displayId).toBe(2);
    expect(displayForWindow({ x: 100, y: 100, width: 400, height: 300 }, displays)?.displayId).toBe(1);
    // A window entirely off every display still resolves to the one it overlaps most, or nothing.
    expect(displayForWindow({ x: 9_000, y: 9_000, width: 10, height: 10 }, displays)).toBeNull();
  });

  test('window operations require an exact generation-bound target', async () => {
    const fake = fakeClient();
    const coordinator = new NativeToolCoordinator(handshake(), fake.client);
    for (const input of [
      { pid: 42, windowId: 7 },
      { pid: 42, windowGeneration: 3 },
      { windowId: 7, windowGeneration: 3 },
      { pid: 0, windowId: 7, windowGeneration: 3 },
      { pid: 42, windowId: 7, windowGeneration: -1 },
    ]) {
      await expect(coordinator.prepareWindowOperation('task', 'minimize_window', input))
        .rejects.toMatchObject({ code: 'invalid_window_target' });
    }
    expect(fake.raw.windowOperation).not.toHaveBeenCalled();
  });

  test('geometry and fullScreen belong only to the operations that take them', async () => {
    const fake = fakeClient();
    const coordinator = new NativeToolCoordinator(handshake(), fake.client);
    const target = { pid: 42, windowId: 7, windowGeneration: 3 };
    await expect(coordinator.prepareWindowOperation('task', 'minimize_window', {
      ...target, frame: { x: 0, y: 0, width: 10, height: 10 },
    })).rejects.toMatchObject({ code: 'invalid_window_operation' });
    await expect(coordinator.prepareWindowOperation('task', 'move_window', { ...target, fullScreen: true }))
      .rejects.toMatchObject({ code: 'invalid_window_operation' });
    await expect(coordinator.prepareWindowOperation('task', 'set_window_fullscreen', target))
      .rejects.toMatchObject({ code: 'invalid_window_operation' });
    // Exactly one of frame or tile.
    await expect(coordinator.prepareWindowOperation('task', 'set_window_frame', target))
      .rejects.toMatchObject({ code: 'invalid_window_operation' });
    await expect(coordinator.prepareWindowOperation('task', 'set_window_frame', {
      ...target, frame: { x: 0, y: 0, width: 10, height: 10 }, tile: 'left_half',
    })).rejects.toMatchObject({ code: 'invalid_window_operation' });
    await expect(coordinator.prepareWindowOperation('task', 'move_window', { ...target, tile: 'left_half' }))
      .rejects.toMatchObject({ code: 'invalid_window_operation' });
    for (const frame of [
      { x: 0, y: 0, width: 10 },
      { x: 0, y: 0, width: 10, height: 10, z: 1 },
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 99_999, height: 10 },
    ]) {
      await expect(coordinator.prepareWindowOperation('task', 'set_window_frame', { ...target, frame }))
        .rejects.toMatchObject({ code: 'invalid_window_frame' });
    }
    expect(fake.raw.windowOperation).not.toHaveBeenCalled();
  });

  test('a tile is resolved against the live display and delivered as an ordinary frame', async () => {
    const fake = fakeClient();
    const coordinator = new NativeToolCoordinator(handshake(), fake.client);
    const prepared = await coordinator.prepareWindowOperation('task-one', 'set_window_frame', {
      pid: 42, windowId: 7, windowGeneration: 3, tile: 'right_half',
    });
    expect(prepared.tile).toBe('right_half');
    expect(prepared.frame).toEqual({ x: 735, y: 33, width: 735, height: 864 });
    expect(prepared.commitAction).toBe(false);
    expect(Object.isFrozen(prepared)).toBe(true);

    await expect(coordinator.performWindowOperation('task-one', { ...prepared }))
      .rejects.toMatchObject({ code: 'unsigned_window_operation' });
    await expect(coordinator.performWindowOperation('other', prepared))
      .rejects.toMatchObject({ code: 'window_operation_session_mismatch' });
    await expect(coordinator.performWindowOperation('task-one', prepared)).resolves.toMatchObject({
      honored: true,
    });
    expect(fake.raw.windowOperation).toHaveBeenCalledWith('native-session', {
      operation: 'set_window_frame',
      window: { pid: 42, windowId: 7, generation: 3 },
      frame: { x: 735, y: 33, width: 735, height: 864 },
    });
  });

  test('a tile refuses a display with no measured usable area and a window that is gone', async () => {
    const noUsable = fakeClient(null);
    const coordinator = new NativeToolCoordinator(handshake(), noUsable.client);
    await expect(coordinator.prepareWindowOperation('task', 'set_window_frame', {
      pid: 42, windowId: 7, windowGeneration: 3, tile: 'maximize',
    })).rejects.toMatchObject({ code: 'window_layout_unavailable' });
    expect(noUsable.raw.windowOperation).not.toHaveBeenCalled();

    const stale = fakeClient();
    const staleCoordinator = new NativeToolCoordinator(handshake(), stale.client);
    await expect(staleCoordinator.prepareWindowOperation('task', 'set_window_frame', {
      pid: 42, windowId: 7, windowGeneration: 99, tile: 'maximize',
    })).rejects.toMatchObject({ code: 'window_generation_stale' });
    expect(stale.raw.windowOperation).not.toHaveBeenCalled();
  });

  test('closing is the one window operation marked as a commit action', async () => {
    const fake = fakeClient();
    const coordinator = new NativeToolCoordinator(handshake(), fake.client);
    const target = { pid: 42, windowId: 7, windowGeneration: 3 };
    const close = await coordinator.prepareWindowOperation('task', 'close_window', target);
    expect(close.commitAction).toBe(true);
    const minimize = await coordinator.prepareWindowOperation('task', 'minimize_window', target);
    expect(minimize.commitAction).toBe(false);
  });

  test('an unverified window operation is refused before transport', async () => {
    const fake = fakeClient();
    const coordinator = new NativeToolCoordinator(handshake(['move_window']), fake.client);
    await expect(coordinator.prepareWindowOperation('task', 'close_window', {
      pid: 42, windowId: 7, windowGeneration: 3,
    })).rejects.toMatchObject({ code: 'workspace_operation_unverified' });
    await expect(coordinator.prepareWindowOperation('task', 'move_window', {
      pid: 42, windowId: 7, windowGeneration: 3, frame: { x: 1, y: 2, width: 3, height: 4 },
    })).resolves.toMatchObject({ operation: 'move_window' });
  });
});
