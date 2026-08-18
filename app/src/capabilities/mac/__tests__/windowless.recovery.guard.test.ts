import { BimaxComputerRuntime } from '../desktop.runtime';

/**
 * The windowless-recovery guard.
 *
 * `hasUsableTargetWindow` decides whether an app has any window worth acting on. When it says no,
 * the runtime escalates — last resort Cmd+N, which in a document app CREATES USER DATA (a note in
 * Notes, a New Playlist sheet in Music).
 *
 * `ComputerTarget.windowId` is optional, and the check compared `Number(w.window_id) === undefined`
 * for such targets — false for every window ever listed. So a target with no window id could never
 * see a window, and the destructive recovery fired against an app that was plainly on screen.
 * Measured 2026-08-18: a target reported as "process 46395, window not reported" left a New
 * Playlist sheet open in the user's Music library.
 */
function runtimeWithWindows(windows: any[]) {
  const runtime = Object.create(BimaxComputerRuntime.prototype) as any;
  runtime.call = async (verb: string) => {
    if (verb !== 'list_windows') throw new Error(`unexpected verb ${verb}`);
    return { windows };
  };
  return runtime;
}

const big = (over: Record<string, unknown> = {}) => ({
  window_id: 411, is_on_screen: true, bounds: { width: 1470, height: 867 }, ...over,
});

describe('an id-less target still sees the app windows', () => {
  it('finds a usable window when the target carries no windowId', async () => {
    const runtime = runtimeWithWindows([big()]);
    await expect(runtime.hasUsableTargetWindow({ app: 'Music', pid: 46395 })).resolves.toBe(true);
  });

  it('still honours an explicitly pinned windowId', async () => {
    const runtime = runtimeWithWindows([big({ window_id: 411 })]);
    await expect(runtime.hasUsableTargetWindow({ app: 'Music', pid: 46395, windowId: 411 }))
      .resolves.toBe(true);
    await expect(runtime.hasUsableTargetWindow({ app: 'Music', pid: 46395, windowId: 999 }))
      .resolves.toBe(false);
  });

  it('does not count offscreen or tiny windows as usable', async () => {
    const offscreen = runtimeWithWindows([big({ is_on_screen: false })]);
    await expect(offscreen.hasUsableTargetWindow({ app: 'Music', pid: 46395 })).resolves.toBe(false);
    const tiny = runtimeWithWindows([big({ bounds: { width: 33, height: 33 } })]);
    await expect(tiny.hasUsableTargetWindow({ app: 'Music', pid: 46395 })).resolves.toBe(false);
  });

  it('still reports windowless when the app genuinely has no window', async () => {
    const runtime = runtimeWithWindows([]);
    await expect(runtime.hasUsableTargetWindow({ app: 'Music', pid: 46395 })).resolves.toBe(false);
  });
});
