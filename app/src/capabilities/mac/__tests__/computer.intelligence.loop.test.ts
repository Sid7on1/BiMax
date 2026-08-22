jest.mock('../mcp.client', () => ({
  openClient: jest.fn(),
  isDeadConnectionError: () => false,
}));

import * as fs from 'fs';
import { openClient } from '../mcp.client';
import { BimaxComputerRuntime } from '../desktop.runtime';
import { __resetConfigForTests } from '../config';

const ok = (structuredContent: unknown) => ({ structuredContent, content: [], isError: false });
const BEFORE = '/tmp/bimax-intelligence-before.png';
const AFTER = '/tmp/bimax-intelligence-after.png';

function native() {
  return {
    run: jest.fn(async (cmd: any) => ({
      ok: true, action: cmd.action, driver: 'native-helper', app: 'Demo', x: cmd.x, y: cmd.y,
      summary: `${cmd.action} delivered`,
    })),
    quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
    frontmostApp: async () => 'Demo',
  } as any;
}

describe('confidence-aware computer-use loop', () => {
  const callTool = jest.fn();
  let acted = false;

  beforeEach(() => {
    jest.clearAllMocks();
    acted = false;
    fs.writeFileSync(BEFORE, 'before-frame');
    fs.writeFileSync(AFTER, 'after-frame');
    process.env.BIMAX_COMPUTER_USE_DRIVER = process.execPath;
    process.env.BIMAX_COMPUTER_USE_DAEMON = '0';
    process.env.BIMAX_COMPUTER_PIP = '0';
    process.env.BIMAX_COMPUTER_VISIBLE = '0';
    __resetConfigForTests();
    (openClient as jest.Mock).mockResolvedValue({ callTool, close: jest.fn() });
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session') return ok({ ok: true });
      if (name === 'launch_app') return ok({ name: 'Demo', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return ok({ activated: true });
      if (name === 'list_windows') return ok({ windows: [
        { window_id: 7, is_on_screen: true, bounds: { x: 10, y: 20, width: 700, height: 500 } },
      ] });
      if (name === 'click') { acted = true; return ok({ effect: 'delivered' }); }
      if (name === 'get_window_state') return ok({
        screenshot_file_path: acted ? AFTER : BEFORE,
        screenshot_width: 700, screenshot_height: 500,
        // This suite exercises the confidence/recovery loop, not sparse-AX menu fallback. Supply
        // enough named controls to classify the synthetic window as AX-ready and keep the fake
        // `Demo` app from reaching the real macOS menu adapter.
        elements: acted
          ? [
            { element_index: 2, role: 'AXHeading', label: 'Dashboard', frame: { x: 20, y: 40, w: 200, h: 30 } },
            { element_index: 3, role: 'AXButton', label: 'Refresh', enabled: true, frame: { x: 240, y: 40, w: 100, h: 30 } },
            { element_index: 4, role: 'AXButton', label: 'Account', enabled: true, frame: { x: 350, y: 40, w: 100, h: 30 } },
            { element_index: 5, role: 'AXButton', label: 'Help', enabled: true, frame: { x: 460, y: 40, w: 100, h: 30 } },
          ]
          : [
            { element_index: 1, role: 'AXButton', label: 'Continue', enabled: true, frame: { x: 20, y: 40, w: 100, h: 30 } },
            { element_index: 3, role: 'AXButton', label: 'Cancel', enabled: true, frame: { x: 130, y: 40, w: 100, h: 30 } },
            { element_index: 4, role: 'AXButton', label: 'Help', enabled: true, frame: { x: 240, y: 40, w: 100, h: 30 } },
          ],
        max_elements_echo: args?.max_elements,
      });
      return ok({ ok: true });
    });
  });

  afterEach(() => {
    fs.rmSync(BEFORE, { force: true });
    fs.rmSync(AFTER, { force: true });
    delete process.env.BIMAX_COMPUTER_USE_DRIVER;
    delete process.env.BIMAX_COMPUTER_USE_DAEMON;
    delete process.env.BIMAX_COMPUTER_PIP;
    delete process.env.BIMAX_COMPUTER_VISIBLE;
    __resetConfigForTests();
  });

  async function openedRuntime() {
    const runtime = new BimaxComputerRuntime(native());
    expect((await runtime.run({ action: 'open', app: 'Demo' }, { cwd: '/tmp' })).ok).toBe(true);
    expect((await runtime.run({ action: 'observe' }, { cwd: '/tmp' })).ok).toBe(true);
    return runtime;
  }

  /**
   * A frame that merely aged out is refreshable. Refusing a coordinate-free action against it
   * deadlocked a live messaging run: the phase gate declared `key combo="return"` the only legal
   * action while this check refused that same Return as expired and demanded an observation. Raw
   * pixels still refuse — they mean nothing against a different picture.
   */
  describe('an aged planning frame refreshes instead of failing', () => {
    // FrameRegistry captures its clock as a default parameter at construction, so the spy has to be
    // installed BEFORE the runtime is built or the registry keeps the real Date.now.
    async function agedRuntime() {
      let clock = Date.now();
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      const runtime = await openedRuntime();
      const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
      clock += 120_000; // well past DEFAULT_FRAME_MAX_AGE_MS
      return {
        runtime,
        frameId: observed.frameId,
        restore: () => (Date.now as unknown as jest.Mock).mockRestore(),
      };
    }

    it('delivers a keystroke after silently re-capturing the window', async () => {
      const { runtime, frameId, restore } = await agedRuntime();
      const pressed = await runtime.run({
        action: 'key', combo: 'return', frameId, deliveryMode: 'background',
      }, { cwd: '/tmp' });
      restore();
      expect(pressed.ok).toBe(true);
      expect((pressed.details as any)?.semanticRegrounding?.notification).toMatch(/expired/);
      await runtime.dispose();
    });

    it('delivers a named click after re-resolving it', async () => {
      const { runtime, frameId, restore } = await agedRuntime();
      const clicked = await runtime.run({
        action: 'click', query: 'Continue', frameId, deliveryMode: 'background',
      }, { cwd: '/tmp' });
      restore();
      expect(clicked.ok).toBe(true);
      expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'click' }));
      await runtime.dispose();
    });

    it('still refuses raw coordinates, which cannot survive a new picture', async () => {
      const { runtime, frameId, restore } = await agedRuntime();
      const refused = await runtime.run({
        action: 'click', x: 50, y: 50, frameId, deliveryMode: 'background',
      }, { cwd: '/tmp' });
      restore();
      expect(refused.ok).toBe(false);
      expect(refused.summary).toMatch(/expired/);
      await runtime.dispose();
    });
  });

  it('acts and proves a semantic postcondition in the same call', async () => {
    const runtime = await openedRuntime();
    const result = await runtime.run({
      action: 'click', query: 'Continue button', expect: 'Dashboard', expectMode: 'present',
      deliveryMode: 'background',
    }, { cwd: '/tmp' });
    expect(result.ok).toBe(true);
    expect(result.progressCheck?.outcome).toBe('confirmed');
    expect(result.actionResult).toEqual(expect.objectContaining({
      delivered: true,
      confidence: 'proven',
      postcondition: { query: 'presence of "Dashboard"', matched: true },
    }));
    expect(result.recoveryDecision).toBe('continue');
  });

  it('does not confuse arbitrary pixel change with a missed requested result', async () => {
    const runtime = await openedRuntime();
    const result = await runtime.run({
      action: 'click', query: 'Continue', expect: 'Settings', expectMode: 'present',
      deliveryMode: 'background',
    }, { cwd: '/tmp' });
    expect(result.ok).toBe(true); // delivery succeeded; the postcondition did not
    expect(result.progressCheck?.outcome).toBe('expectation-missed');
    expect(result.actionResult).toEqual(expect.objectContaining({
      confidence: 'unknown',
      postcondition: { query: 'presence of "Settings"', matched: false },
    }));
    expect(result.summary).toMatch(/EXPECTED RESULT NOT FOUND/);
    expect(result.recoveryDecision).toBe('recover');
  });

  it('does not accept text already visible before an action as proof of a new effect', async () => {
    const runtime = await openedRuntime();
    // "Continue" is present in the input frame and remains present after the click. It is not a
    // transition caused by this action, so it cannot certify a newly sent message or created item.
    const result = await runtime.run({
      action: 'click', query: 'Continue', expect: 'Continue', expectMode: 'present',
      deliveryMode: 'background',
    }, { cwd: '/tmp' });
    expect(result.ok).toBe(true);
    expect(result.progressCheck?.outcome).toBe('expectation-missed');
    expect(result.actionResult?.postcondition).toEqual({
      query: 'new presence of "Continue"', matched: false,
    });
  });

  it('refuses untargeted typing when Search and a composer are both editable', async () => {
    const runtime = await openedRuntime();
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'get_window_state') return ok({
        screenshot_file_path: BEFORE, screenshot_width: 700, screenshot_height: 500,
        elements: [
          { element_index: 1, role: 'AXSearchField', label: 'Search', editable: true, frame: { x: 20, y: 40, w: 200, h: 30 } },
          { element_index: 2, role: 'AXTextArea', label: 'Text Message', editable: true, frame: { x: 300, y: 440, w: 300, h: 30 } },
        ],
      });
      if (name === 'list_windows') return ok({ windows: [
        { window_id: 7, is_on_screen: true, bounds: { x: 10, y: 20, width: 700, height: 500 } },
      ] });
      return ok({ ok: true });
    });
    await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    callTool.mockClear();

    const refused = await runtime.run({
      action: 'type', text: 'mom', deliveryMode: 'background',
    }, { cwd: '/tmp' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/multiple editable fields.*Search.*Text Message/i);
    expect(callTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'type_text' }));
    await runtime.dispose();
  });

  it('starts observation cheaply and deepens only when a named target is beyond the first pass', async () => {
    const runtime = await openedRuntime();
    callTool.mockClear();
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'get_window_state') {
        const cap = Number(args?.max_elements || 0);
        const filler = Array.from({ length: cap }, (_, i) => ({
          element_index: i, role: 'AXStaticText', label: `Row ${i}`, frame: { x: 10, y: i + 20, w: 80, h: 10 },
        }));
        if (cap >= 600) filler[500] = { element_index: 500, role: 'AXButton', label: 'Deep target', frame: { x: 20, y: 200, w: 100, h: 30 } };
        return ok({ screenshot_file_path: BEFORE, screenshot_width: 700, screenshot_height: 500, elements: filler });
      }
      if (name === 'list_windows') return ok({ windows: [
        { window_id: 7, is_on_screen: true, bounds: { x: 10, y: 20, width: 700, height: 500 } },
      ] });
      return ok({ ok: true });
    });
    const observed = await runtime.run({ action: 'observe', query: 'Deep target' }, { cwd: '/tmp' });
    expect(observed.verification).toEqual(expect.objectContaining({ matched: true }));
    expect((observed.details as any).perception.scanCaps).toEqual([180, 600]);
  });

  it('re-observes and re-grounds a semantic action when ordinary AX state changes', async () => {
    let notify: ((event: any) => void) | undefined;
    const stop = jest.fn();
    const fallback = {
      ...native(),
      watchAccessibility: jest.fn((pid: number, onEvent: (event: any) => void) => {
        notify = onEvent;
        return stop;
      }),
    } as any;
    const runtime = new BimaxComputerRuntime(fallback);
    await runtime.run({ action: 'open', app: 'Demo', deliveryMode: 'background' }, { cwd: '/tmp' });
    const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    expect(observed.ok).toBe(true);
    notify?.({ pid: 42, notification: 'AXValueChanged', timestampMs: Date.now() });

    callTool.mockClear();
    const clicked = await runtime.run({
      action: 'click', query: 'Continue', frameId: observed.frameId, deliveryMode: 'background',
    }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(true);
    expect(callTool.mock.calls.filter(([arg]) => arg.name === 'get_window_state').length).toBeGreaterThanOrEqual(2);
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'click' }));
    await runtime.dispose();
    expect(stop).toHaveBeenCalled();
  });

  it('re-grounds a named message composer instead of looping on AXValueChanged', async () => {
    let notify: ((event: any) => void) | undefined;
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session' || name === 'set_agent_cursor_enabled') return ok({ ok: true });
      if (name === 'launch_app') return ok({ name: 'Demo', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return ok({ windows: [
        { window_id: 7, is_on_screen: true, bounds: { x: 10, y: 20, width: 700, height: 500 } },
      ] });
      if (name === 'get_window_state') return ok({
        screenshot_file_path: BEFORE, screenshot_width: 700, screenshot_height: 500,
        elements: [{
          element_index: 2, element_token: 'composer-current', role: 'AXTextArea',
          label: 'Text Message • SMS', editable: true, frame: { x: 300, y: 440, w: 300, h: 30 },
        }],
      });
      if (name === 'type_text') return ok({ effect: 'delivered' });
      return ok({ ok: true });
    });
    const fallback = {
      ...native(),
      watchAccessibility: jest.fn((_pid: number, onEvent: (event: any) => void) => {
        notify = onEvent;
        return jest.fn();
      }),
    } as any;
    const runtime = new BimaxComputerRuntime(fallback);
    await runtime.run({ action: 'open', app: 'Demo', deliveryMode: 'background' }, { cwd: '/tmp' });
    const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    notify?.({ pid: 42, notification: 'AXValueChanged', timestampMs: Date.now() });
    callTool.mockClear();

    const typed = await runtime.run({
      action: 'type', query: 'Text Message • SMS', text: 'hi',
      frameId: observed.frameId, deliveryMode: 'background',
    }, { cwd: '/tmp' });

    expect(typed.ok).toBe(true);
    expect(callTool.mock.calls.filter(([arg]) => arg.name === 'get_window_state').length).toBeGreaterThanOrEqual(2);
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'type_text', arguments: expect.objectContaining({ element_token: 'composer-current', text: 'hi' }),
    }));
    await runtime.dispose();
  });

  it('still refuses raw coordinates when an AX event invalidates their picture', async () => {
    let notify: ((event: any) => void) | undefined;
    const fallback = {
      ...native(),
      watchAccessibility: jest.fn((_pid: number, onEvent: (event: any) => void) => {
        notify = onEvent;
        return jest.fn();
      }),
    } as any;
    const runtime = new BimaxComputerRuntime(fallback);
    await runtime.run({ action: 'open', app: 'Demo', deliveryMode: 'background' }, { cwd: '/tmp' });
    const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    notify?.({ pid: 42, notification: 'AXValueChanged', timestampMs: Date.now() });

    const refused = await runtime.run({
      action: 'click', x: 50, y: 50, frameId: observed.frameId, deliveryMode: 'background',
    }, { cwd: '/tmp' });

    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/accessibility state changed.*AXValueChanged/i);
    expect(callTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'click' }));
    await runtime.dispose();
  });

  it('delivers a combo-only key after an AX event instead of refusing it', async () => {
    // A keystroke carries no coordinate and no element handle — it goes to whatever holds focus, and
    // the `key` path never reads the element map at all. The stale-frame guard exists because "the
    // visible element map may no longer own those coordinates"; with no coordinates that premise is
    // simply absent, so refusing here is self-inflicted.
    //
    // Measured live on WhatsApp 2026-08-05: opening the app raised its own "New chat" popover, the
    // runtime's guidance said to press escape to dismiss it, and escape was then refused for
    // AXFocusedUIElementChanged — the app's own opening event. The advice and the guard disagreed,
    // and escape is precisely how a caller answers a surface that just appeared.
    let notify: ((event: any) => void) | undefined;
    const fallback = {
      ...native(),
      watchAccessibility: jest.fn((_pid: number, onEvent: (event: any) => void) => {
        notify = onEvent;
        return jest.fn();
      }),
    } as any;
    const runtime = new BimaxComputerRuntime(fallback);
    await runtime.run({ action: 'open', app: 'Demo', deliveryMode: 'background' }, { cwd: '/tmp' });
    const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    notify?.({ pid: 42, notification: 'AXFocusedUIElementChanged', timestampMs: Date.now() });

    const pressed = await runtime.run({
      action: 'key', combo: 'escape', frameId: observed.frameId,
    }, { cwd: '/tmp' });

    expect(pressed.ok).toBe(true);
    expect(pressed.error).toBeUndefined();
    await runtime.dispose();
  });

  describe('an unnamed type survives events that cannot have moved focus', () => {
    // Measured live in Finder on 2026-08-06: `key cmd+shift+g` opened Go to Folder, its completion
    // list posted AXSelectedChildrenChanged, and the `type` that was the whole reason for opening the
    // sheet was refused — told that "the visible element map may no longer own those coordinates"
    // for an action carrying no coordinates. Intermittent, because it races the app's autocompletion.
    //
    // The watcher registers AXValueChanged/AXSelectedChildrenChanged/AXSelectedTextChanged on the
    // CURRENTLY FOCUSED element, so those are emitted by the very field the text is going into.
    const runWithEvent = async (notification: string, extra: Record<string, unknown> = {}) => {
      let notify: ((event: any) => void) | undefined;
      const fallback = {
        ...native(),
        watchAccessibility: jest.fn((_pid: number, onEvent: (event: any) => void) => {
          notify = onEvent;
          return jest.fn();
        }),
      } as any;
      const runtime = new BimaxComputerRuntime(fallback);
      await runtime.run({ action: 'open', app: 'Demo', deliveryMode: 'background' }, { cwd: '/tmp' });
      const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
      notify?.({ pid: 42, notification, timestampMs: Date.now(), ...extra });
      const typed = await runtime.run({
        action: 'type', text: 'hi', frameId: observed.frameId, deliveryMode: 'background',
      }, { cwd: '/tmp' });
      await runtime.dispose();
      return typed;
    };

    it.each(['AXValueChanged', 'AXSelectedChildrenChanged', 'AXSelectedTextChanged'])(
      'delivers after %s, which the focused field itself emits', async notification => {
        const typed = await runWithEvent(notification);
        expect(typed.ok).toBe(true);
        expect(typed.error).toBeUndefined();
      });

    it.each(['AXFocusedUIElementChanged', 'AXFocusedWindowChanged'])(
      'still refuses after %s, which can put the text in another field', async notification => {
        const typed = await runWithEvent(notification);
        expect(typed.ok).toBe(false);
        expect(typed.error).toMatch(/accessibility state changed/i);
      });

    it('refuses when the event has no name, because that is not evidence focus held', async () => {
      const typed = await runWithEvent('');
      expect(typed.ok).toBe(false);
    });
  });

  it('ignores frame-less app-level AXWindowCreated noise after observation', async () => {
    let notify: ((event: any) => void) | undefined;
    const fallback = {
      ...native(),
      watchAccessibility: jest.fn((_pid: number, onEvent: (event: any) => void) => {
        notify = onEvent;
        return jest.fn();
      }),
    } as any;
    const runtime = new BimaxComputerRuntime(fallback);
    await runtime.run({ action: 'open', app: 'Demo', deliveryMode: 'background' }, { cwd: '/tmp' });
    const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    notify?.({
      pid: 42, notification: 'AXWindowCreated', timestampMs: Date.now(),
      element: { pid: 42, role: 'AXApplication', label: 'Demo' },
    });

    const clicked = await runtime.run({
      action: 'click', query: 'Continue', frameId: observed.frameId, deliveryMode: 'background',
    }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(true);
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'click' }));
    await runtime.dispose();
  });

  /** A concrete new window really did change the surface. The property that must hold is that no
   * action is delivered against the caller's superseded picture — NOT that every action is refused.
   * Raw coordinates have nothing to re-resolve, so they are refused; a named target is re-grounded
   * from a replacement observation and the result says so. Refusing the semantic case too was
   * measured as fatal: an app that creates its own window on open (Messages) or on search then
   * refuses the very operation that produced the event, and the task never reaches send. */
  async function runtimeWithNewWindowEvent() {
    let notify: ((event: any) => void) | undefined;
    const fallback = {
      ...native(),
      watchAccessibility: jest.fn((_pid: number, onEvent: (event: any) => void) => {
        notify = onEvent;
        return jest.fn();
      }),
    } as any;
    const runtime = new BimaxComputerRuntime(fallback);
    await runtime.run({ action: 'open', app: 'Demo', deliveryMode: 'background' }, { cwd: '/tmp' });
    const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    notify?.({
      pid: 42, notification: 'AXWindowCreated', timestampMs: Date.now(),
      element: { pid: 42, role: 'AXWindow', frame: { x: 30, y: 40, w: 300, h: 200 } },
    });
    return { runtime, observed };
  }

  it('refuses raw coordinates when AXWindowCreated identifies a concrete new window', async () => {
    const { runtime, observed } = await runtimeWithNewWindowEvent();
    const refused = await runtime.run({
      action: 'click', x: 50, y: 50, frameId: observed.frameId, deliveryMode: 'background',
    }, { cwd: '/tmp' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/AXWindowCreated/);
    expect(callTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'click' }));
    await runtime.dispose();
  });

  it('re-grounds a named target through a concrete new window and discloses it', async () => {
    const { runtime, observed } = await runtimeWithNewWindowEvent();
    const clicked = await runtime.run({
      action: 'click', query: 'Continue', frameId: observed.frameId, deliveryMode: 'background',
    }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(true);
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'click' }));
    // The model must never read this as a click on the picture it planned from.
    expect(clicked.summary).toMatch(/re-resolved from a fresh observation/i);
    expect((clicked.details as any)?.semanticRegrounding?.notification).toBe('AXWindowCreated');
    await runtime.dispose();
  });

  it('uses on-device OCR only after native semantic search misses', async () => {
    const fallback = native();
    fallback.run.mockImplementation(async (cmd: any) => {
      if (cmd.action === 'visual_analysis') return {
        ok: true, action: cmd.action, driver: 'native-helper', summary: 'analysed',
        visualAnalysis: {
          texts: [{ text: 'Mystery Control', confidence: 0.96, frame: { x: 100, y: 120, w: 130, h: 24 } }],
          shapes: [{ id: 'shape-0', contourCount: 2, topLevelCount: 1, rectangleCount: 1, kind: 'square' }],
          latencyMs: 9,
        },
      };
      if (cmd.action === 'visual_signatures') return {
        ok: true, action: cmd.action, driver: 'native-helper', summary: 'sampled', visualSignatures: [],
      };
      return { ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} delivered` };
    });
    const runtime = new BimaxComputerRuntime(fallback);
    await runtime.run({ action: 'open', app: 'Demo', deliveryMode: 'background' }, { cwd: '/tmp' });

    const observed = await runtime.run({ action: 'observe', query: 'Mystery Control' }, { cwd: '/tmp' });
    expect(observed.verification).toEqual({ query: 'Mystery Control', matched: true, matchCount: 1 });
    expect(observed.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'VisualText', label: 'Mystery Control', source: 'on_device_vision' }),
    ]));
    expect((observed.details as any).perception.foveated).toEqual(expect.objectContaining({
      triggered: true, ocrTextRegions: 1, shapeRegions: 1, latencyMs: 9,
    }));
    await runtime.dispose();
  });
});
