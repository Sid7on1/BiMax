import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const openExternal = jest.fn<() => Promise<void>>(async () => {});
const showInactive = jest.fn();
const loadFile = jest.fn<() => Promise<void>>(async () => {});
const relaunch = jest.fn();
const quit = jest.fn();

/**
 * Real listener bookkeeping rather than a bare jest.fn: the grant watch registers and REMOVES its
 * activation listeners, and a mock that only records calls cannot show that the removal happened —
 * which is the half that keeps a settled watch from firing again.
 */
const appListeners = new Map<string, Array<() => void>>();
const appOn = (event: string, callback: () => void): void => {
  appListeners.set(event, [...(appListeners.get(event) ?? []), callback]);
};
const appRemoveListener = (event: string, callback: () => void): void => {
  appListeners.set(event, (appListeners.get(event) ?? []).filter((entry) => entry !== callback));
};
const emitApp = (event: string): void => {
  for (const listener of [...(appListeners.get(event) ?? [])]) listener();
};
const listenerCount = (event: string): number => (appListeners.get(event) ?? []).length;

/** The live macOS reading the coach polls. Tests drive it to simulate the grant landing. */
let accessibilityReading: 'granted' | 'denied' = 'denied';

class BrowserWindowMock {
  static instances: BrowserWindowMock[] = [];

  private destroyed = false;
  private onceHandlers = new Map<string, () => void>();

  readonly webContents = {
    id: 42,
    on: jest.fn(),
    startDrag: jest.fn(),
  };

  readonly on = jest.fn();
  readonly once = jest.fn((event: string, callback: () => void) => {
    this.onceHandlers.set(event, callback);
  });
  readonly setAlwaysOnTop = jest.fn();
  readonly setVisibleOnAllWorkspaces = jest.fn();
  readonly showInactive = showInactive;
  readonly loadFile = loadFile;
  readonly loadURL = jest.fn<() => Promise<void>>(async () => {});
  readonly isDestroyed = jest.fn(() => this.destroyed);
  readonly destroy = jest.fn(() => {
    if (this.destroyed) return;
    this.destroyed = true;
    const closed = this.onceHandlers.get('closed');
    this.onceHandlers.delete('closed');
    closed?.();
  });
  readonly hide = jest.fn();

  constructor() {
    BrowserWindowMock.instances.push(this);
  }
}

jest.mock('electron', () => ({
  BrowserWindow: BrowserWindowMock,
  app: {
    getPath: jest.fn(() => '/tmp'),
    on: appOn,
    removeListener: appRemoveListener,
    relaunch,
    quit,
  },
  nativeImage: {
    createFromBitmap: jest.fn(() => ({ isEmpty: () => false })),
  },
  screen: {
    getCursorScreenPoint: jest.fn(() => ({ x: 10, y: 10 })),
    getDisplayNearestPoint: jest.fn(() => ({ workArea: { x: 0, y: 0, width: 1470, height: 863 } })),
  },
  shell: { openExternal },
  systemPreferences: {
    getMediaAccessStatus: jest.fn(() => 'denied'),
    isTrustedAccessibilityClient: jest.fn(() => accessibilityReading === 'granted'),
  },
}));

import {
  endGrantWatch,
  isAwaitingHostGrant,
  permissionDragNeedsGrantWatch,
  probePermissions,
  startBundleDrag,
  startCoach,
  stopCoach,
} from '../permission.coach';
import { setFreshGrantProbe } from '../host.grants';

/**
 * What a fresh child process would report, independently of `accessibilityReading` (which is this
 * process's own, cache-prone answer). Tests that care only about the watch's mechanics leave this
 * null so the reading falls back to `accessibilityReading` and they keep their original meaning.
 */
let freshReading: { accessibility: boolean; screenRecording: boolean } | null = null;

type ElectronProcessWithSystemVersion = NodeJS.Process & { getSystemVersion(): string };
const electronProcess = process as ElectronProcessWithSystemVersion;
const originalGetSystemVersion = electronProcess.getSystemVersion;

describe('permission drag coach', () => {
  beforeEach(() => {
    stopCoach('before-quit');
    endGrantWatch('test-reset');
    jest.clearAllMocks();
    jest.useRealTimers();
    BrowserWindowMock.instances = [];
    accessibilityReading = 'denied';
    // Never the real bundled helper: it would answer for the machine running the suite, so these
    // tests would pass or fail according to the tester's own Accessibility settings.
    freshReading = null;
    setFreshGrantProbe(() => freshReading);
    electronProcess.getSystemVersion = jest.fn(() => '26.5.2');
  });

  afterAll(() => {
    electronProcess.getSystemVersion = originalGetSystemVersion;
    setFreshGrantProbe(null);
    jest.useRealTimers();
  });

  test('opens Accessibility and shows the native drag source instead of failing after hiding Bimax', async () => {
    const stepAside = jest.fn();

    await expect(startCoach(
      'accessibility',
      stepAside,
      jest.fn(),
      '/Applications/Bimax.app',
    )).resolves.toBe(true);

    expect(stepAside).toHaveBeenCalledTimes(1);
    expect(electronProcess.getSystemVersion).toHaveBeenCalledTimes(1);
    // macOS 26 gets the bounded retry after System Settings activates.
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(BrowserWindowMock.instances).toHaveLength(1);
    expect(loadFile).toHaveBeenCalledTimes(1);
    expect(showInactive).toHaveBeenCalledTimes(1);
  });

  test('offers the same native drag source for Screen Recording', async () => {
    const stepAside = jest.fn();

    await expect(startCoach(
      'screenRecording',
      stepAside,
      jest.fn(),
      '/Applications/Bimax.app',
    )).resolves.toBe(true);

    expect(stepAside).toHaveBeenCalledTimes(1);
    expect(BrowserWindowMock.instances).toHaveLength(1);
    expect(showInactive).toHaveBeenCalledTimes(1);
  });

  /**
   * Keyed on "the drop raises an authentication sheet", not on "we can read the result afterwards".
   * Full Disk Access is the case that separates them: its result IS directly readable, and it still
   * prompts for a password — so an observability-keyed rule restored the window onto that prompt.
   */
  test('watches every add-by-drag pane, whichever identity is being dropped', () => {
    expect(permissionDragNeedsGrantWatch('accessibility')).toBe(true);
    expect(permissionDragNeedsGrantWatch('screenRecording')).toBe(true);
    expect(permissionDragNeedsGrantWatch('fullDisk')).toBe(true);
    expect(permissionDragNeedsGrantWatch('accessibility', 'service')).toBe(true);
    // Microphone is a request API, not a drag: no sheet, nothing to wait for.
    expect(permissionDragNeedsGrantWatch('microphone')).toBe(false);
  });

  test('hides the floating tile as soon as the native drag completes', async () => {
    await startCoach('accessibility', jest.fn(), jest.fn(), '/Applications/Bimax.app');
    const active = BrowserWindowMock.instances[0];
    const startDrag = jest.fn();

    expect(startBundleDrag({ sender: { startDrag } } as any)).toBe(true);

    expect(startDrag).toHaveBeenCalledTimes(1);
    expect(active.hide).toHaveBeenCalledTimes(1);
  });

  /**
   * The drop is not the grant.
   *
   * macOS raises an authentication sheet AFTER the bundle lands in the list, and only records the
   * grant once the user satisfies it. The coach used to relaunch the host the moment the drag
   * returned, which quit Bimax on top of that sheet and booted a fresh process whose reading was
   * taken before the grant existed — reported as "it pops up before I can type the password" and
   * "Trust Center still says off after I approved". Neither is recoverable by polling harder, so
   * the drag's completion must not be allowed to stand in for the user's.
   */
  test('does not relaunch or reappear when the drag returns — the password sheet is still up', async () => {
    const restore = jest.fn();
    await startCoach('accessibility', jest.fn(), restore, '/Applications/Bimax.app', 'host');
    const active = BrowserWindowMock.instances[0];

    expect(startBundleDrag({ sender: { startDrag: jest.fn() } } as any)).toBe(true);
    active.destroy();

    expect(relaunch).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(isAwaitingHostGrant()).toBe(true);
  });

  /**
   * The reported defect, as a test.
   *
   * macOS decides a process's Accessibility trust once. The main process starts before the user
   * grants anything, so `isTrustedAccessibilityClient()` returns false for the rest of its life no
   * matter what the user approves — measured on macOS 26.5.2, where the bundled helper reported
   * `accessibility: true` while the running process still said no.
   *
   * So the grant here lands ONLY in the fresh reading, and `accessibilityReading` stays denied for
   * the whole test. Against the old code — which polled this process — the watch could never
   * settle: it sat out its full five-minute timeout instead of restoring the window, and the Trust
   * Center went on showing Off however many times the permission was granted.
   */
  test('settles on a grant only a fresh process can see, while this one still reports denied', async () => {
    const restore = jest.fn();
    await startCoach('accessibility', jest.fn(), restore, '/Applications/Bimax.app', 'host');
    jest.useFakeTimers();
    startBundleDrag({ sender: { startDrag: jest.fn() } } as any);
    BrowserWindowMock.instances[0].destroy();

    freshReading = { accessibility: false, screenRecording: false };
    jest.advanceTimersByTime(10_000);
    expect(restore).not.toHaveBeenCalled();

    // The user authenticates. This process is not told, and never will be.
    freshReading = { accessibility: true, screenRecording: false };
    jest.advanceTimersByTime(1_000);

    expect(accessibilityReading).toBe('denied');
    expect(restore).toHaveBeenCalledTimes(1);
    expect(isAwaitingHostGrant()).toBe(false);
  });

  test('labels fresh and fallback readings so the UI never recommends restart for a live probe', () => {
    freshReading = { accessibility: true, screenRecording: true };
    const fresh = probePermissions();
    expect(fresh.readingSource).toBe('helper');
    expect(fresh.readings).toMatchObject({ accessibility: 'granted', screenRecording: 'granted' });

    setFreshGrantProbe(() => null);
    const fallback = probePermissions();
    expect(fallback.readingSource).toBe('in-process');
  });

  test('comes back by itself once the grant actually lands', async () => {
    const restore = jest.fn();
    // Fake timers only after startCoach: its macOS 26 pane retry awaits a real timeout.
    await startCoach('accessibility', jest.fn(), restore, '/Applications/Bimax.app', 'host');
    jest.useFakeTimers();
    startBundleDrag({ sender: { startDrag: jest.fn() } } as any);
    BrowserWindowMock.instances[0].destroy();

    // Still authenticating: several polls must change nothing.
    jest.advanceTimersByTime(10_000);
    expect(restore).not.toHaveBeenCalled();

    accessibilityReading = 'granted';
    jest.advanceTimersByTime(1_000);

    expect(restore).toHaveBeenCalledTimes(1);
    expect(isAwaitingHostGrant()).toBe(false);
    // A settled watch must stop listening, or the next activation restores a second time.
    expect(listenerCount('did-become-active')).toBe(0);
    expect(listenerCount('activate')).toBe(0);
    expect(relaunch).not.toHaveBeenCalled();
  });

  test('ignores the drag’s own reopen event, and honours the user’s real return', async () => {
    const restore = jest.fn();
    await startCoach('accessibility', jest.fn(), restore, '/Applications/Bimax.app', 'host');
    jest.useFakeTimers();
    startBundleDrag({ sender: { startDrag: jest.fn() } } as any);
    BrowserWindowMock.instances[0].destroy();

    // macOS reopens this app as System Settings resolves the dropped bundle. That is the drag
    // talking, not the user, and acting on it is what buried the password sheet.
    jest.advanceTimersByTime(500);
    emitApp('did-become-active');
    expect(restore).not.toHaveBeenCalled();
    expect(isAwaitingHostGrant()).toBe(true);

    // Later, the user clicks the dock icon. Nothing else can produce that.
    jest.advanceTimersByTime(20_000);
    emitApp('did-become-active');

    expect(restore).toHaveBeenCalledTimes(1);
    expect(isAwaitingHostGrant()).toBe(false);
  });

  /**
   * A service drag grants a separate XPC identity that main cannot read. The watch must therefore
   * never settle itself on a host reading — that would be answering a question about the service
   * with a fact about ourselves. The renderer's handshake poll proves it and calls stop().
   */
  test('a service drag waits too, and is settled by the renderer’s handshake, not a host reading', async () => {
    const restore = jest.fn();
    await startCoach(
      'accessibility', jest.fn(), restore, '/Applications/Bimax.app/Contents/XPCServices/X.xpc', 'service',
    );
    jest.useFakeTimers();
    startBundleDrag({ sender: { startDrag: jest.fn() } } as any);
    BrowserWindowMock.instances[0].destroy();
    expect(isAwaitingHostGrant()).toBe(true);

    // The HOST being granted says nothing about the service, so it must not end this watch.
    accessibilityReading = 'granted';
    jest.advanceTimersByTime(5_000);
    expect(restore).not.toHaveBeenCalled();
    expect(isAwaitingHostGrant()).toBe(true);

    // The renderer saw the service handshake succeed and stopped the coach.
    stopCoach('renderer-request');

    expect(restore).toHaveBeenCalledTimes(1);
    expect(isAwaitingHostGrant()).toBe(false);
  });

  /**
   * Full Disk Access prompts for a password exactly like the other two. The first version of this
   * fix keyed the wait on whether the grant was observable, so this pane kept restoring the window
   * straight onto its prompt — the original bug, surviving in the one row a dev host can still hit.
   */
  test('Full Disk Access waits for its password prompt like the rest', async () => {
    const restore = jest.fn();
    await startCoach('fullDisk', jest.fn(), restore, '/Applications/Bimax.app', 'host');
    startBundleDrag({ sender: { startDrag: jest.fn() } } as any);
    BrowserWindowMock.instances[0].destroy();

    expect(restore).not.toHaveBeenCalled();
    expect(isAwaitingHostGrant()).toBe(true);
  });

  test('quitting abandons the watch instead of pulling the window back on the way out', async () => {
    const restore = jest.fn();
    await startCoach('accessibility', jest.fn(), restore, '/Applications/Bimax.app', 'host');
    jest.useFakeTimers();
    startBundleDrag({ sender: { startDrag: jest.fn() } } as any);
    BrowserWindowMock.instances[0].destroy();

    stopCoach('before-quit');

    expect(isAwaitingHostGrant()).toBe(false);
    expect(restore).not.toHaveBeenCalled();
    accessibilityReading = 'granted';
    jest.advanceTimersByTime(5_000);
    expect(restore).not.toHaveBeenCalled();
  });
});
