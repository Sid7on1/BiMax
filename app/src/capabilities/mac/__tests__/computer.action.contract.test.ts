/**
 * Regression tests — computer-use action outcome contract (P0).
 *
 * 1. ActionResult separates delivery from proof: pixel no-change is NOT a failure, and only a
 *    matched semantic postcondition yields confidence 'proven'.
 * 2. Visually-static verbs (wait/hover/move) never feed the no-progress latch.
 * 3. A latched recovery failure is cleared ONLY by a successful re-observation that produced
 *    fresh evidence — issuing observe/screenshot alone (or a failed capture) does not bypass it.
 */
jest.mock('../mcp.client', () => ({ openClient: jest.fn() }));

import * as fs from 'fs';
import { openClient } from '../mcp.client';
import { BimaxComputerRuntime } from '../desktop.runtime';
import { classifyVerification, toActionResult } from '../verification';
import { computerResultForModel, unwrapActionEnvelope, validateModelComputerCommand } from '../action.contract';
import { __resetConfigForTests } from '../config';

/**
 * A native fallback stub for tests that build a runtime directly.
 *
 * The runtime asks the native helper for the frontmost app before the sidecar (4ms versus 642ms),
 * so a runtime built without one interrogates the REAL desktop and then tries to activate apps that
 * only exist in the fixture. Tests must describe their own desktop.
 */
const hermeticFallback = () => ({
  run: jest.fn(async (cmd: any) => ({
    ok: true, action: cmd.action, driver: 'native-helper', app: cmd.app, x: 10, y: 10,
    summary: `${cmd.action} delivered`,
  })),
  quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
  frontmostApp: async () => 'Calculator',
} as any);

describe('ActionResult contract (pure)', () => {
  it('spoon-feeds one canonical handle per observed element', () => {
    const projected = computerResultForModel({
      ok: true, action: 'observe', summary: 'observed',
      elements: [
        { element_token: 's000f:47', element_index: 47, role: 'AXTextArea', label: 'Compose message' },
        { element_index: 12, role: 'VisualText', label: 'visual only' },
      ],
      targeting: {
        query: 'Compose message', confidence: 'high', margin: 20,
        elementToken: 's000f:47', elementIndex: 47,
      },
    } as any);
    expect(projected.elements).toEqual([
      { element_token: 's000f:47', role: 'AXTextArea', label: 'Compose message' },
      { element_index: 12, role: 'VisualText', label: 'visual only' },
    ]);
    expect(projected.targeting).toEqual(expect.objectContaining({ elementToken: 's000f:47' }));
    expect(projected.targeting).not.toHaveProperty('elementIndex');
  });

  it('pixel no-change is delivered-but-unproven, never a failure', () => {
    const v = classifyVerification({ ok: true, prevFrameHash: 'a', nextFrameHash: 'a', hadScreenshot: true });
    const r = toActionResult(v);
    expect(r.delivered).toBe(true);
    expect(r.observed).toBe('no-change');
    expect(r.confidence).toBe('unknown');
    expect(r.failureReason).toBeUndefined();
  });

  it('a visible change is only "likely" — pixels cannot prove task success', () => {
    const v = classifyVerification({ ok: true, prevFrameHash: 'a', nextFrameHash: 'b', hadScreenshot: true });
    const r = toActionResult(v);
    expect(r.confidence).toBe('likely');
    expect(r.observed).toBe('changed');
  });

  it('only a matched semantic postcondition is "proven"', () => {
    const v = classifyVerification({ ok: true, prevFrameHash: 'a', nextFrameHash: 'b', hadScreenshot: true, queryMatched: true });
    const r = toActionResult(v, { query: 'Saved', matched: true });
    expect(r.confidence).toBe('proven');
    expect(r.postcondition).toEqual({ query: 'Saved', matched: true });
  });

  it('driver failure and wrong-window carry a failureReason', () => {
    const failed = toActionResult(classifyVerification({ ok: false, hadScreenshot: false }));
    expect(failed.delivered).toBe(false);
    expect(failed.failureReason).toBeTruthy();
    const wrong = toActionResult(classifyVerification({ ok: true, hadScreenshot: true, nextFrameHash: 'x', expectedApp: 'Notes', actualApp: 'Terminal' }));
    expect(wrong.observed).toBe('wrong-window');
    expect(wrong.failureReason).toMatch(/Notes/);
  });

  it('treats a visible application rejection as delivered input but failed operation', () => {
    const rejected = toActionResult(classifyVerification({
      ok: true,
      prevFrameHash: 'before',
      nextFrameHash: 'error-dialog',
      hadScreenshot: true,
      observedFailure: 'This photo could not be sent. Please choose a different photo.',
    }));
    expect(rejected).toEqual(expect.objectContaining({
      delivered: true,
      observed: 'rejected',
      confidence: 'unknown',
      failureReason: expect.stringMatching(/could not be sent/i),
    }));
  });
});

describe('recovery latch semantics (runtime)', () => {
  const callTool = jest.fn();
  const SHOT = '/tmp/bimax-latch-test.png';
  let windowStateFails = false;

  beforeEach(() => {
    jest.clearAllMocks();
    windowStateFails = false;
    process.env.BIMAX_COMPUTER_USE_DRIVER = process.execPath;
    process.env.BIMAX_COMPUTER_USE_DAEMON = '0';
    process.env.BIMAX_COMPUTER_RECORD = '0';
    process.env.BIMAX_COMPUTER_PIP = '0';
    process.env.BIMAX_COMPUTER_VISIBLE = '0'; // background delivery → sidecar click path
    __resetConfigForTests();
    fs.writeFileSync(SHOT, 'static-frame-bytes'); // identical bytes every capture → no-change
    (openClient as jest.Mock).mockResolvedValue({ callTool, close: jest.fn() });
    callTool.mockImplementation(async ({ name }: any) => {
      const ok = (structuredContent: any) => ({ structuredContent, content: [], isError: false });
      if (name === 'launch_app') return ok({ name: 'Calculator', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'get_window_state') {
        if (windowStateFails) throw new Error('window capture failed');
        return ok({
          screenshot_file_path: SHOT, screenshot_width: 500, screenshot_height: 700,
          elements: [{ element_index: 1, role: 'AXButton', label: 'Go', frame: { x: 0, y: 0, w: 500, h: 700 } }],
        });
      }
      if (name === 'list_windows') return ok({ windows: [{ window_id: 7, is_on_screen: true, bounds: { width: 500, height: 700 } }] });
      return ok({ ok: true });
    });
  });

  afterEach(() => {
    delete process.env.BIMAX_COMPUTER_USE_DRIVER;
    delete process.env.BIMAX_COMPUTER_USE_DAEMON;
    delete process.env.BIMAX_COMPUTER_RECORD;
    delete process.env.BIMAX_COMPUTER_PIP;
    delete process.env.BIMAX_COMPUTER_VISIBLE;
    __resetConfigForTests();
    fs.rmSync(SHOT, { force: true });
  });

  async function latchRuntime() {
    const runtime = new BimaxComputerRuntime(hermeticFallback());
    await runtime.run({ action: 'open', app: 'Calculator' }, { cwd: '/tmp' });
    await runtime.run({ action: 'observe' }, { cwd: '/tmp' }); // ground the frame
    // Repeated no-effect clicks until the recovery authority latches stop-failure.
    for (let i = 0; i < 6; i++) {
      await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'background' }, { cwd: '/tmp' });
    }
    const refused = await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/recovery budget exhausted/);
    return runtime;
  }

  it('latches after repeated no-effect actions and refuses further acting verbs', async () => {
    await latchRuntime();
  }, 30000);

  it('a FAILED observe does not clear the latch; a successful fresh observe does', async () => {
    const runtime = await latchRuntime();

    // Observe whose capture fails → no fresh evidence → still latched.
    windowStateFails = true;
    const badObserve = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    expect(badObserve.ok).toBe(false);
    const stillRefused = await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(stillRefused.ok).toBe(false);
    expect(stillRefused.error).toMatch(/recovery budget exhausted/);

    // Successful observe WITH a captured frame → new evidence → latch clears.
    windowStateFails = false;
    const goodObserve = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    expect(goodObserve.ok).toBe(true);
    expect(goodObserve.frameHash).toBeTruthy();
    const allowed = await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(allowed.ok).toBe(true);
  }, 30000);

  it('invalidates stale perception when post-action capture fails', async () => {
    const runtime = new BimaxComputerRuntime(hermeticFallback());
    await runtime.run({ action: 'open', app: 'Calculator' }, { cwd: '/tmp' });
    await runtime.run({ action: 'observe' }, { cwd: '/tmp' });

    windowStateFails = true;
    const delivered = await runtime.run(
      { action: 'click', x: 10, y: 10, deliveryMode: 'background' },
      { cwd: '/tmp' },
    );
    expect(delivered.ok).toBe(true);
    expect(delivered.actionResult).toEqual(expect.objectContaining({
      delivered: true,
      observed: 'unverified',
    }));
    expect(delivered.summary).toMatch(/fresh post-action screen could not be captured/);

    const blindFollowUp = await runtime.run(
      { action: 'click', x: 10, y: 10, deliveryMode: 'background' },
      { cwd: '/tmp' },
    );
    expect(blindFollowUp.ok).toBe(false);
    expect(blindFollowUp.error).toMatch(/fresh screenshot.*required before input/);
  }, 30000);

  it('refuses first input before any target observation', async () => {
    const runtime = new BimaxComputerRuntime(hermeticFallback());
    const result = await runtime.run(
      { action: 'click', x: 10, y: 10, pid: 42, windowId: 7, app: 'Calculator', deliveryMode: 'background' },
      { cwd: '/tmp' },
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/observe the target window first/);
  });

  it('static verbs (wait/hover/move) never feed the no-progress latch', async () => {
    const runtime = new BimaxComputerRuntime(hermeticFallback());
    await runtime.run({ action: 'open', app: 'Calculator' }, { cwd: '/tmp' });
    await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    // Many pixel-identical waits — legitimately static — must not accrue a stuck state.
    for (let i = 0; i < 8; i++) {
      const r = await runtime.run({ action: 'wait', ms: 50 }, { cwd: '/tmp' });
      expect(r.ok).toBe(true);
    }
    const click = await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(click.ok).toBe(true); // no false latch
  }, 30000);
});

describe('routing: one driver implementation per action, one ActionResult', () => {
  const callTool = jest.fn();
  const SHOT = '/tmp/bimax-routing-test.png';

  const fakeFallback = () => {
    const run = jest.fn(async (cmd: any) => ({
      ok: true, action: cmd.action, driver: 'native-helper', app: cmd.app, x: cmd.x, y: cmd.y,
      summary: `${cmd.action} delivered`,
    }));
    return {
      run,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Calculator',
    } as any;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BIMAX_COMPUTER_USE_DRIVER = process.execPath;
    process.env.BIMAX_COMPUTER_USE_DAEMON = '0';
    process.env.BIMAX_COMPUTER_RECORD = '0';
    process.env.BIMAX_COMPUTER_PIP = '0';
    process.env.BIMAX_COMPUTER_VISIBLE = '1';
    fs.writeFileSync(SHOT, `frame-${Date.now()}-${Math.random()}`);
    (openClient as jest.Mock).mockResolvedValue({ callTool, close: jest.fn() });
    callTool.mockImplementation(async ({ name }: any) => {
      const ok = (structuredContent: any) => ({ structuredContent, content: [], isError: false });
      if (name === 'launch_app') return ok({ name: 'Calculator', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'get_window_state') {
        fs.writeFileSync(SHOT, `frame-${Date.now()}-${Math.random()}`); // always-fresh frame
        return ok({
          screenshot_file_path: SHOT, screenshot_width: 500, screenshot_height: 700,
          elements: [
            { element_index: 0, role: 'AXWindow', frame: { x: 0, y: 0, w: 500, h: 700 } },
            { element_index: 1, role: 'AXButton', label: 'Test target', frame: { x: 0, y: 0, w: 40, h: 40 } },
          ],
        });
      }
      if (name === 'list_windows') return ok({ windows: [{ window_id: 7, is_on_screen: true, bounds: { width: 500, height: 700 } }] });
      return ok({ ok: true });
    });
  });

  afterEach(() => {
    delete process.env.BIMAX_COMPUTER_USE_DRIVER;
    delete process.env.BIMAX_COMPUTER_USE_DAEMON;
    delete process.env.BIMAX_COMPUTER_RECORD;
    delete process.env.BIMAX_COMPUTER_PIP;
    delete process.env.BIMAX_COMPUTER_VISIBLE;
    __resetConfigForTests();
    fs.rmSync(SHOT, { force: true });
  });

  const INPUT_VERBS = new Set(['click', 'type', 'key', 'drag', 'scroll', 'move', 'hover', 'hold', 'mouse_down', 'mouse_up']);

  it('a saved background-first preference keeps input off the physical cursor', async () => {
    process.env.BIMAX_COMPUTER_VISIBLE = '0';
    __resetConfigForTests();
    const fallback = fakeFallback();
    const runtime = new BimaxComputerRuntime(fallback);
    await runtime.run({ action: 'open', app: 'Calculator' }, { cwd: '/tmp' });
    await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    const clicked = await runtime.run({ action: 'click', elementIndex: 1 }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(true);
    expect(callTool.mock.calls.some(([a]) => a.name === 'click')).toBe(true);
    const fallbackInputCalls = (fallback.run as jest.Mock).mock.calls.filter(([c]) => INPUT_VERBS.has(c.action));
    expect(fallbackInputCalls.filter(([c]) => c.action === 'click')).toHaveLength(0);
    expect(clicked.actionResult).toBeDefined(); // exactly one ActionResult, from evidence
  });

  it('explicit internal background diagnostics still route to the sidecar only', async () => {
    const fallback = fakeFallback();
    const runtime = new BimaxComputerRuntime(fallback);
    await runtime.run({ action: 'open', app: 'Calculator' }, { cwd: '/tmp' });
    await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    const clicked = await runtime.run({ action: 'click', elementIndex: 1, deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(true);
    expect(callTool.mock.calls.some(([a]) => a.name === 'click')).toBe(true);
    expect((fallback.run as jest.Mock).mock.calls.filter(([c]) => INPUT_VERBS.has(c.action))).toHaveLength(0);
  });

  it('foreground click delivers via the NATIVE fallback only — the sidecar click RPC is never used', async () => {
    process.env.BIMAX_COMPUTER_VISIBLE = '1';
    __resetConfigForTests();
    const fallback = fakeFallback();
    const runtime = new BimaxComputerRuntime(fallback);
    await runtime.run({ action: 'open', app: 'Calculator' }, { cwd: '/tmp' });
    await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    const clicked = await runtime.run({ action: 'click', elementIndex: 1 }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(true);
    // Input delivered exactly once, by the native driver.
    const nativeClicks = (fallback.run as jest.Mock).mock.calls.filter(([c]) => c.action === 'click');
    expect(nativeClicks).toHaveLength(1);
    // The sidecar performed windowing/observation ONLY — never the input delivery.
    expect(callTool.mock.calls.some(([a]) => a.name === 'click')).toBe(false);
    expect(clicked.actionResult).toBeDefined();
  });

  it('without a sidecar driver, every action routes to the fallback and the sidecar never spawns', async () => {
    // 'off' (not unset): with no env var the transport now discovers a cached driver from a prior
    // packaged run, which would make this test machine-dependent.
    process.env.BIMAX_COMPUTER_USE_DRIVER = 'off';
    __resetConfigForTests();
    const fallback = fakeFallback();
    const runtime = new BimaxComputerRuntime(fallback);
    await runtime.run({ action: 'click', x: 5, y: 5, app: 'Notes' }, { cwd: '/tmp' });
    expect(openClient).not.toHaveBeenCalled();
    expect((fallback.run as jest.Mock).mock.calls.filter(([c]) => c.action === 'click')).toHaveLength(1);
  });
});

describe('fallback close is truthful (delivered-but-unverified)', () => {
  it('never claims a verified close, and recovery cannot read it as proven success', async () => {
    const { DesktopRuntime } = require('../desktop.runtime');
    const { RecoveryController } = require('../recovery');
    const runtime = new DesktopRuntime();
    // Stub the underlying key delivery + activation so no real desktop is touched.
    (runtime as any).activateApp = jest.fn().mockResolvedValue('TestApp');
    (runtime as any).runDarwin = jest.fn().mockResolvedValue({ app: 'TestApp', summary: 'pressed cmd+w' });
    (runtime as any).runLinux = jest.fn().mockResolvedValue({ app: 'TestApp', summary: 'pressed ctrl+w' });
    const closed = await runtime.run({ action: 'close', app: 'TestApp' });
    expect(closed.ok).toBe(true);
    expect(closed.actionResult).toEqual(expect.objectContaining({
      delivered: true,
      observed: 'unverified',
      confidence: 'unknown',
      postcondition: { query: 'target window closed', matched: false },
    }));
    expect(closed.summary).toMatch(/cannot verify/);
    expect(closed.summary).toMatch(/^sent close-window/); // states delivery, never claims closure
    // Downstream recovery: an 'unverified' outcome can never latch stop-success.
    const rc = new RecoveryController();
    expect(rc.record(closed.actionResult!.observed)).toBe('continue');
    expect(rc.succeeded).toBe(false);
  });
});

/**
 * The action-as-envelope shape, and refusals a model can act on.
 *
 * Measured on the Phase 10 baseline (2026-08-08, nvidia/nemotron-nano-12b-v2-vl driving the fixture
 * app): the model sent `{"click":{...}}` rather than `{"action":"click",...}`, was told
 * `unknown public action: undefined`, and repeated the IDENTICAL call six times before giving up.
 * The refusal named the symptom, never the mistake, so nothing in it could teach the model what to
 * change. See docs/BIMAX_CU_BASELINE_v1.1.0.md.
 */
describe('malformed model call shapes', () => {
  test('unwraps the action-as-envelope form into a real command', () => {
    const unwrapped = unwrapActionEnvelope({ click: { elementIndex: 2 } });
    expect(unwrapped).toEqual({ action: 'click', elementIndex: 2 });
    // ...and the unwrapped command is then judged on its merits, not rejected as "undefined".
    expect(validateModelComputerCommand(unwrapped as any)).toBeNull();
  });

  test('leaves a well-formed command exactly as it arrived', () => {
    const good = { action: 'click', query: 'OK' };
    expect(unwrapActionEnvelope({ ...good })).toEqual(good);
    // An `action` key present anywhere means the envelope form was not used, even if a same-named
    // key rides alongside it — rewriting there would silently retarget a real command.
    expect(unwrapActionEnvelope({ action: 'type', click: { query: 'OK' } }))
      .toEqual({ action: 'type', click: { query: 'OK' } });
  });

  test('refuses to rewrite anything that is not unambiguously the envelope', () => {
    // Two keys: not an envelope.
    expect(unwrapActionEnvelope({ click: { query: 'a' }, scroll: { dy: 1 } }))
      .toEqual({ click: { query: 'a' }, scroll: { dy: 1 } });
    // Single key that is not a public action.
    expect(unwrapActionEnvelope({ frobnicate: { query: 'a' } })).toEqual({ frobnicate: { query: 'a' } });
    // Single action-named key whose value is not an argument object.
    expect(unwrapActionEnvelope({ click: 'OK' })).toEqual({ click: 'OK' });
    expect(unwrapActionEnvelope({ click: ['OK'] })).toEqual({ click: ['OK'] });
  });

  test('normalizes SHAPE only — a conflicting selector set is still refused', () => {
    // The baseline call carried query AND elementIndex AND x+y at once. Unwrapping must not be
    // mistaken for disambiguating: choosing one for the model lands a click nobody asked for.
    const unwrapped = unwrapActionEnvelope({
      click: { query: 'pop-up button', elementIndex: 2, x: 450, y: 300, frameId: 'f1' },
    });
    const refusal = validateModelComputerCommand(unwrapped as any);
    expect(refusal).toMatch(/exactly one selector/);
    // The refusal names what it received, so the model can see its own mistake rather than repeat it.
    expect(refusal).toMatch(/query \+ elementIndex \+ x\+y/);
  });
});
