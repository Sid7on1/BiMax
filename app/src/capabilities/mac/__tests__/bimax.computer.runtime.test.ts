// The runtime consults isDeadConnectionError on every sidecar call to decide whether a failure is
// worth reconnecting for, so the module mock has to provide it — omitting it turns an ordinary
// caught sidecar error into a TypeError that surfaces as an unrelated failure.
jest.mock('../mcp.client', () => ({
  openClient: jest.fn(),
  isDeadConnectionError: (e: any) => /connection closed|not connected|transport (?:closed|error)|EPIPE|ECONNRESET|write after end/i.test(String(e?.message || e)),
}));

// This suite waits on REAL settle timers, not on I/O — every call here is mocked. `open`, `focus`,
// `close` and `quit_app` all sleep in desktop.runtime.ts because WindowServer genuinely needs the
// time: 900 ms at :4513, a 200/400/600 ms frontmost retry at :4348, a 350/450/700 ms close poll at
// :6572, and a 350 ms quit settle at :6611. A test driving four of those operations therefore needs
// several real seconds and sits right on jest's 5 s default — it passed alone (162/162) and timed
// out only in the full parallel run under memory pressure, on 2026-08-02.
//
// Raised here rather than globally, so slowness in unrelated suites still surfaces. NOT fixed by
// shortening the production settles: they are live-debugged values covering real WindowServer
// grace periods, and this is a harness limit, not a claim about how fast the runtime is. Nothing in
// this file asserts a duration, so a larger budget hides nothing that exists today. If these ever
// need to be fast, make the settle clock injectable — do not trim the constants.
jest.setTimeout(30_000);

import { openClient } from '../mcp.client';
import { BimaxComputerRuntime, pngDimensionsFromBytes, layoutRect, screenForRect, classifySpaceCombo, resolveDesktopIcon, withoutWindowChrome, describeUnlabeledControls, visibleApplicationFailure } from '../desktop.runtime';
import { __resetConfigForTests, loadConfig } from '../config';
import { LivePipPort } from '../pip';
import { useIsolatedStateDir } from './isolated-state-dir';

// This suite drives the runtime without an explicit ctx.cwd in most cases, and the runtime persists
// its session state under <cwd>/.bimax/computer. Run it inside a throwaway directory so a generated
// artifact can never land in the repository — and fail the suite if one does anyway.
useIsolatedStateDir();

function result(structuredContent: any, text = '') {
  return { structuredContent, content: text ? [{ type: 'text', text }] : [], isError: false };
}

describe('BimaxComputerRuntime', () => {
  const callTool = jest.fn();

  describe('visibleApplicationFailure', () => {
    // A rejected verdict spends a recovery immediately and four of them latch the controller into
    // stop-failure for the rest of the session, so each condition below is load-bearing.
    const error = {
      role: 'AXStaticText',
      label: 'This photo could not be sent. Please choose a different photo.',
      frame: { x: 400, y: 300, w: 300, h: 40 },
    };
    const okButton = { role: 'AXButton', label: 'OK', frame: { x: 560, y: 360, w: 80, h: 30 } };

    it('needs dialog evidence: negative text on its own is ordinary page content', () => {
      expect(visibleApplicationFailure([error])).toBeNull();
      expect(visibleApplicationFailure([error, okButton])).toMatch(/could not be sent/i);
    });

    it('accepts an alert role without any dismissal control', () => {
      expect(visibleApplicationFailure([{ ...error, role: 'AXAlert' }])).toMatch(/could not be sent/i);
    });

    it('ignores text that was already on screen before the action', () => {
      // The reason this matters: chat transcripts, mail and documents are full of sentences like
      // "I couldn't make it". Without freshness one such message would reject every later action in
      // that window until the recovery budget latched the session dead.
      const chat = {
        role: 'AXStaticText', label: "Sorry, I couldn't make it tonight",
        frame: { x: 100, y: 200, w: 260, h: 20 },
      };
      const close = { role: 'AXButton', label: 'Close', frame: { x: 180, y: 240, w: 60, h: 24 } };
      expect(visibleApplicationFailure([chat, close])).toMatch(/couldn't make it/i);
      expect(visibleApplicationFailure([chat, close], [
        "Sorry, I couldn't make it tonight",
      ])).toBeNull();
    });

    it('does not let a distant dismissal control certify unrelated text', () => {
      const farAway = { ...okButton, frame: { x: 20, y: 1200, w: 80, h: 30 } };
      expect(visibleApplicationFailure([error, farAway])).toBeNull();
    });

    it('still reports an alert that is STILL up, so a repeated failure is not downgraded', () => {
      // Freshness protects against document/chat text, which is why it guards the circumstantial
      // nearby-dismissal route only. An AXAlert is unambiguous, and one still on screen is still an
      // unresolved rejection: requiring novelty there would let a retried action silently degrade to
      // no-change and lose the reason the app gave.
      const alert = { ...error, role: 'AXAlert' };
      expect(visibleApplicationFailure([alert], [error.label])).toMatch(/could not be sent/i);
    });

    it('does not mistake a synthesized icon-button name for an app-supplied dismissal', () => {
      // describeUnlabeledControls always appends a relation and an ordinal, so its names cannot be
      // an exact dismissal word. This pins that invariant rather than trusting it.
      const synthesized = { role: 'AXButton', label: 'right of "Close" #2', originalLabel: '', frame: okButton.frame };
      expect(visibleApplicationFailure([error, synthesized])).toBeNull();
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BIMAX_COMPUTER_USE_DRIVER = process.execPath;
    process.env.BIMAX_COMPUTER_USE_DAEMON = '0';
    process.env.BIMAX_COMPUTER_RECORD = '0';
    process.env.BIMAX_COMPUTER_PIP = '0';
    // Isolate the suite from the developer machine's global config. Individual background tests
    // opt out explicitly through deliveryMode or override this env value.
    process.env.BIMAX_COMPUTER_VISIBLE = '1';
    __resetConfigForTests();
    (openClient as jest.Mock).mockResolvedValue({ callTool, close: jest.fn() });
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({
        name: 'Calculator', pid: 42, windows: [{ window_id: 7, title: 'Calculator' }],
      });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/bimax-window.png', screenshot_width: 500, screenshot_height: 700,
        tree_markdown: '[3] AXStaticText value="216,174"',
        elements: [{ element_index: 3, element_token: 'fresh-token', role: 'AXStaticText', label: 'Result', value: '216,174' }],
      }, 'Cua Driver observation');
      if (name === 'type_text') return result({ effect: 'delivered' });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'start_recording') return result({ enabled: true });
      if (name === 'get_recording_state') return result({ enabled: true, output_dir: '/tmp/recording' });
      if (name === 'stop_recording') return result({ enabled: false, last_video_path: '/tmp/recording/recording.mp4' });
      if (name === 'hotkey') return result({ effect: 'unverifiable' });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      return result({ ok: true });
    });
  });

  afterEach(() => {
    delete process.env.BIMAX_COMPUTER_USE_DRIVER;
    delete process.env.BIMAX_COMPUTER_USE_DAEMON;
    delete process.env.BIMAX_COMPUTER_RECORD;
    delete process.env.BIMAX_COMPUTER_PIP;
    delete process.env.BIMAX_COMPUTER_VISIBLE;
    __resetConfigForTests();
  });

  it('uses real PNG pixels when Retina metadata reports logical points', () => {
    const pngHeader = Buffer.alloc(24);
    pngHeader.write('IHDR', 12, 'ascii');
    pngHeader.writeUInt32BE(1317, 16);
    pngHeader.writeUInt32BE(1568, 20);
    expect(pngDimensionsFromBytes(pngHeader)).toEqual({ width: 1317, height: 1568 });
  });

  it('keeps one native session and carries pid/window identity through observe and actions', async () => {
    const nativeRun = jest.fn(async (cmd: any) => ({
      ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} delivered`,
    }));
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Calculator',
    };
    const runtime = new BimaxComputerRuntime(native);
    const opened = await runtime.run({ action: 'open', app: 'Calculator', deliveryMode: 'foreground' });
    expect(opened).toEqual(expect.objectContaining({ ok: true, app: 'Calculator', pid: 42, windowId: 7 }));
    expect(callTool).toHaveBeenCalledWith({ name: 'bring_to_front', arguments: { pid: 42, window_id: 7 } });

    const observed = await runtime.run({ action: 'observe' });
    expect(observed).toEqual(expect.objectContaining({
      ok: true, pid: 42, windowId: 7, screenshot: '/tmp/bimax-window.png',
      tree: expect.stringContaining('216,174'),
    }));
    expect(runtime.describeTarget({ action: 'click', elementToken: 'fresh-token' }))
      .toEqual(expect.objectContaining({ label: 'Result', value: '216,174' }));
    const observeCall = callTool.mock.calls.find(([arg]) => arg.name === 'get_window_state')?.[0];
    // The driver's walk costs ~3.7ms PER NODE (measured: 300→1.1s, 800→3.0s, 2000→6.1s), so this
    // number is a latency budget, not a detail. A previous version added a flat +500 "menu
    // allowance" here and asserted 800 — pinning a 3s observe in place and making this test defend
    // the regression instead of catching it. Deep scans are earned by the escalation path (rescan
    // only when the walk yielded no window elements), never paid up front on every observe.
    expect(observeCall.arguments.max_elements).toBe(120);

    await runtime.run({ action: 'type', text: '1271*170+104', deliveryMode: 'foreground' });
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({
      action: 'type', app: 'Calculator', text: '1271*170+104',
    }), undefined);
    expect(callTool.mock.calls.some(([arg]) => arg.name === 'type_text')).toBe(false);
    expect(callTool.mock.calls.filter(([arg]) => arg.name === 'start_session')).toHaveLength(1);
    expect(callTool).toHaveBeenCalledWith({
      name: 'set_agent_cursor_enabled',
      arguments: { enabled: false, cursor_id: expect.stringMatching(/^bimax-/) },
    });
    expect((openClient as jest.Mock).mock.calls[0][0].args).not.toContain('--experimental-pip');
  });

  it('makes the window actually captured after an action authoritative for the next input', async () => {
    const nativeRun = jest.fn(async (cmd: any) => ({
      ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} delivered`,
    }));
    const runtime = new BimaxComputerRuntime({
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Calculator',
    } as any);
    await runtime.run({ action: 'open', app: 'Calculator', deliveryMode: 'background' });

    // Reproduce the live failure: window discovery/result assembly chooses a newly focused
    // same-process surface (8), while FrameRegistry proves the returned pixels still belong to the
    // stable parent (7). Ownership must follow the immutable captured frame, not a provisional id.
    (runtime as any).refreshTargetWindow = jest.fn(async (target: any) => ({ ...target, windowId: 8 }));
    (runtime as any).observeTarget = jest.fn(async () => ({
      ok: true,
      action: 'observe',
      driver: 'test',
      app: 'Calculator',
      pid: 42,
      windowId: 8,
      screenshot: '/tmp/bimax-window.png',
      frameHash: 'captured-parent',
      width: 500,
      height: 700,
      elements: [],
      degraded: false,
      summary: 'result assembled with provisional child id',
    }));

    const observed = await runtime.run({ action: 'observe', deliveryMode: 'background' });
    expect(observed.windowId).toBe(7);
    expect((runtime as any).targets.current()).toEqual(expect.objectContaining({ pid: 42, windowId: 7 }));

    const keyed = await runtime.run({ action: 'key', combo: 'x', deliveryMode: 'background' });

    expect(keyed.ok).toBe(true);
    expect(keyed.windowId).toBe(7);
    expect((runtime as any).targets.current()).toEqual(expect.objectContaining({ pid: 42, windowId: 7 }));
  });

  it('opens an exact discovered window instead of hardcoding or taking the first app window', async () => {
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({
        name: 'Quasar Workspace', pid: 42,
        windows: [{ window_id: 7 }, { window_id: 9 }],
      });
      if (name === 'list_windows') return result({ windows: [
        { window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } },
        { window_id: 9, is_on_screen: true, bounds: { x: 520, y: 0, width: 500, height: 700 } },
      ] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/quasar-window.png', screenshot_width: 500, screenshot_height: 700,
        elements: [{ role: 'AXWindow', label: 'Fixture', frame: { x: 520, y: 0, w: 500, h: 700 } }],
      });
      if (name === 'bring_to_front') return result({ activated: true, window_id: args?.window_id });
      return result({ ok: true });
    });
    const native: any = {
      run: jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action })),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Quasar Workspace',
    };
    const runtime = new BimaxComputerRuntime(native);

    const opened = await runtime.run({
      action: 'open', app: 'Quasar Workspace', windowId: 9, deliveryMode: 'background',
    });

    expect(opened.ok).toBe(true);
    expect(opened.windowId).toBe(9);
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'get_window_state', arguments: expect.objectContaining({ pid: 42, window_id: 9 }),
    }));
  });

  it('focuses an app that is already running but was never opened by this session', async () => {
    // The everyday case: the user left the app open. Refusing with "not open in this session" forced
    // `open`, which re-launches and discards whatever state the app was in.
    const launch = jest.fn();
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') { launch(); return result({ name: 'Ledger', pid: 77, windows: [{ window_id: 3 }] }); }
      if (name === 'list_windows') return result({ windows: [
        { window_id: 3, app_name: 'Ledger', pid: 77, is_on_screen: true, z_index: 40, bounds: { x: 0, y: 0, width: 600, height: 800 } },
      ] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/ledger.png', screenshot_width: 600, screenshot_height: 800,
        elements: [{ role: 'AXWindow', label: 'Ledger', frame: { x: 0, y: 0, w: 600, h: 800 } }],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime({
      run: jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action })),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Ledger',
    } as any);

    const focused = await runtime.run({ action: 'focus', app: 'Ledger' });

    expect(focused.ok).toBe(true);
    expect(focused.pid).toBe(77);
    // Adopting must not relaunch — that is the whole point of preferring focus over open.
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses to focus an app with no on-screen window rather than silently taking another app', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'list_windows') return result({ windows: [
        { window_id: 3, app_name: 'Something Else', pid: 77, is_on_screen: true, z_index: 40, bounds: { x: 0, y: 0, width: 600, height: 800 } },
      ] });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime({
      run: jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action })),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Something Else',
    } as any);

    const focused = await runtime.run({ action: 'focus', app: 'Ledger' });
    expect(focused.ok).toBe(false);
    expect(String(focused.error)).toMatch(/not running/i);
  });

  it('keeps an explicitly named window instead of re-deriving the largest one', async () => {
    // Window 9 is deliberately the SMALLER surface, so passing the heuristic would pick 7. An app
    // with a main window plus a document window is the real shape of this: the runtime's own
    // "try another window" recovery is worthless if the pick is overruled on the next capture.
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Ledger', pid: 77, windows: [{ window_id: 7 }, { window_id: 9 }] });
      if (name === 'list_windows') return result({ windows: [
        { window_id: 7, app_name: 'Ledger', pid: 77, is_on_screen: true, z_index: 50, bounds: { x: 0, y: 0, width: 900, height: 900 } },
        { window_id: 9, app_name: 'Ledger', pid: 77, is_on_screen: true, z_index: 40, bounds: { x: 0, y: 0, width: 400, height: 400 } },
      ] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/ledger.png', screenshot_width: 400, screenshot_height: 400,
        elements: [{ role: 'AXWindow', label: 'Ledger', frame: { x: 0, y: 0, w: 400, h: 400 } }],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime({
      run: jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action })),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Ledger',
    } as any);

    await runtime.run({ action: 'open', app: 'Ledger' });
    const focused = await runtime.run({ action: 'focus', app: 'Ledger', windowId: 9 });
    expect(focused.windowId).toBe(9);

    // And it must SURVIVE the next capture, not just the call that set it.
    const observed = await runtime.run({ action: 'observe' });
    expect(observed.windowId).toBe(9);
  });

  it('honors background-first config without fronting the app and prefers semantic handles', async () => {
    process.env.BIMAX_COMPUTER_VISIBLE = '0';
    __resetConfigForTests();
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'WhatsApp', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/whatsapp.png', screenshot_width: 500, screenshot_height: 700,
        elements: [
          { element_index: 1, element_token: 'composer', role: 'AXTextArea', label: 'Message composer', frame: { x: 40, y: 620, w: 380, h: 50 } },
          { element_index: 2, element_token: 'send', role: 'AXButton', label: 'Send', frame: { x: 440, y: 620, w: 40, h: 40 } },
        ],
      });
      if (name === 'type_text' || name === 'click') return result({ effect: 'delivered' });
      return result({ ok: true });
    });
    const nativeRun = jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action }));
    const runtime = new BimaxComputerRuntime({
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Codex',
    } as any);

    const opened = await runtime.run({ action: 'open', app: 'WhatsApp' });
    expect(opened.ok).toBe(true);
    await runtime.run({ action: 'type', query: 'Message composer', text: 'hi' });
    await runtime.run({ action: 'click', query: 'Send' });

    expect(callTool.mock.calls.some(([arg]) => arg.name === 'bring_to_front')).toBe(false);
    expect(nativeRun.mock.calls.some(([cmd]) => ['click', 'type', 'key'].includes(cmd.action))).toBe(false);
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'type_text', arguments: expect.objectContaining({ delivery_mode: 'background', element_token: 'composer' }),
    }));
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'click', arguments: expect.objectContaining({ delivery_mode: 'background', element_token: 'send' }),
    }));
  });

  it('background typing uses an exact visual placeholder point when the hidden app has no editable AX handle', async () => {
    process.env.BIMAX_COMPUTER_VISIBLE = '0';
    __resetConfigForTests();
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'WhatsApp', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: false, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/whatsapp-hidden.png', screenshot_width: 500, screenshot_height: 700,
        elements: [
          { element_index: 0, role: 'AXWindow', label: 'WhatsApp', frame: { x: 0, y: 0, w: 500, h: 700 } },
          { role: 'AXStaticText', label: 'Type a message', frame: { x: 50, y: 620, w: 350, h: 40 } },
        ],
      });
      if (name === 'type_text') return result({ effect: 'delivered' });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'WhatsApp' });
    const typed = await runtime.run({ action: 'type', query: 'Type a message', text: 'hello' });

    expect(typed.ok).toBe(true);
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'type_text',
      arguments: expect.objectContaining({
        delivery_mode: 'background', window_id: 7, x: 225, y: 640, text: 'hello',
      }),
    }));
  });

  it('types into WhatsApp Compose message instead of a message-bearing chat button', async () => {
    process.env.BIMAX_COMPUTER_VISIBLE = '0';
    __resetConfigForTests();
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'WhatsApp', pid: 42861, windows: [{ window_id: 2049 }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 2049, is_on_screen: true, bounds: { x: 0, y: 0, width: 1567, height: 918 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/whatsapp-compose.png', screenshot_width: 1567, screenshot_height: 918,
        elements: [
          { element_index: 22, element_token: 's000f:22', role: 'AXButton', label: 'Chapter2Drip',
            value: 'message, A little welcome gift', frame: { x: 72, y: 682, w: 391, h: 73 } },
          { element_index: 47, element_token: 's000f:47', role: 'AXTextArea', label: 'Compose message',
            frame: { x: 526, y: 879, w: 985, h: 26 } },
        ],
      });
      if (name === 'type_text') return result({ effect: 'delivered' });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'WhatsApp' });
    const typed = await runtime.run({ action: 'type', query: 'Type a message', text: 'hi' });

    expect(typed.ok).toBe(true);
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'type_text',
      arguments: expect.objectContaining({
        pid: 42861, window_id: 2049, delivery_mode: 'background',
        element_token: 's000f:47', text: 'hi',
      }),
    }));
  });

  it('attaches native sRGB evidence and reports bounded temporal element changes', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session' || name === 'bring_to_front' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Demo', pid: 42, windows: [{ window_id: 7, title: 'Demo' }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/bimax-colour-window.png', screenshot_width: 500, screenshot_height: 700,
        elements: [{ element_index: 4, element_token: 'send', role: 'AXButton', label: 'Send', enabled: true,
          frame: { x: 100, y: 200, w: 80, h: 32 } }],
      });
      return result({ ok: true });
    });
    let sample = 0;
    const native: any = {
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Demo',
      run: jest.fn(async (cmd: any) => {
        if (cmd.action !== 'visual_signatures') return { ok: true, action: cmd.action, driver: 'native-helper', summary: 'done' };
        expect(cmd.regions[0]).toEqual(expect.objectContaining({ x: 100, y: 200, w: 80, h: 32 }));
        // open returns its own fresh observation, so keep that baseline and the first explicit
        // observe blue; the second explicit observe is the state transition under test.
        const changed = sample++ > 1;
        return {
          ok: true, action: cmd.action, driver: 'native-helper', summary: 'sampled',
          visualSignatures: [{
            id: cmd.regions[0].id,
            center_rgb: changed ? [240, 110, 30] : [30, 120, 240],
            median_rgb: changed ? [240, 110, 30] : [30, 120, 240],
            dominant: [{ rgb: changed ? [240, 110, 30] : [30, 120, 240], coverage: 0.9 }],
            oklab: changed ? [0.72, 0.12, 0.09] : [0.61, -0.02, -0.18],
            luminance: changed ? 0.43 : 0.21, chroma: changed ? 0.15 : 0.18,
            color_name: changed ? 'orange' : 'blue', entropy: 0.1, confidence: 0.95,
            sample_count: 49, source_color_space: 'sRGB',
          }],
        };
      }),
    };
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'Demo' });
    const first = await runtime.run({ action: 'observe' });
    expect(first.elements?.[0]).toEqual(expect.objectContaining({
      visual: expect.objectContaining({ color: 'blue', rgb: [30, 120, 240], confidence: 0.95 }),
    }));
    const second = await runtime.run({ action: 'observe' });
    expect(second.elements?.[0]).toEqual(expect.objectContaining({
      visual: expect.objectContaining({ color: 'orange', changed: true, deltaE: expect.any(Number) }),
    }));
    expect((second.details as any).perception.visual).toEqual(expect.objectContaining({ sampled: 1, changed: 1, colorSpace: 'sRGB' }));
  });

  it('focuses a named composer and returns a privacy-preserving keyboard Action Receipt', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session' || name === 'bring_to_front' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Demo', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/action-receipt.png', screenshot_width: 500, screenshot_height: 700,
        elements: [{ element_index: 4, element_token: 'composer', role: 'AXTextArea', label: 'Message composer',
          enabled: true, focused: true, frame: { x: 80, y: 600, w: 320, h: 60 } }],
      });
      return result({ ok: true });
    });
    let focusRead = 0;
    const run = jest.fn(async (cmd: any) => {
      const base = { ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action };
      if (cmd.action === 'window_at') return { ...base, windowAt: {
        owner_pid: 42, owner_name: 'Demo', window_id: 7, layer: 0, bounds: { x: 0, y: 0, w: 500, h: 700 },
        element_chain: [{ pid: 42, role: 'AXTextArea', title: 'Message composer', identifier: 'composer',
          editable: true, enabled: true, frame: { x: 80, y: 600, w: 320, h: 60 } }],
      } };
      if (cmd.action === 'focused_element') {
        const length = focusRead++ === 0 ? 0 : 5;
        const focused = { pid: 42, role: 'AXTextArea', title: 'Message composer', identifier: 'composer',
          editable: true, valueLength: length, selectedRange: { location: length, length: 0 },
          frame: { x: 80, y: 600, w: 320, h: 60 } };
        return { ...base, app: 'Demo', pid: 42, focusedElement: focused, focusChain: [focused] };
      }
      if (cmd.action === 'cursor') return { ...base, x: 100, y: 620 };
      if (cmd.action === 'click' || cmd.action === 'type') return { ...base, app: 'Demo', x: cmd.x, y: cmd.y };
      if (cmd.action === 'visual_signatures') return { ...base, visualSignatures: [] };
      return base;
    });
    const native: any = {
      run, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Demo',
    };
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'Demo' });
    const typed = await runtime.run({ action: 'type', query: 'message composer', text: 'hello' });
    expect(typed.ok).toBe(true);
    expect(typed.actionReceipt).toEqual(expect.objectContaining({
      kind: 'keyboard',
      preflight: expect.objectContaining({ windowMatched: true, editable: true }),
      commit: expect.objectContaining({ delivered: true, recipientApp: 'Demo' }),
      postcondition: { query: 'literal text changed the same focused editable element', matched: true },
    }));
    expect(typed.actionResult?.confidence).toBe('proven');
    expect(JSON.stringify(typed.actionReceipt)).not.toContain('hello');
    expect(run.mock.calls.filter(([cmd]) => cmd.action === 'click')).toHaveLength(1);
    expect(run.mock.calls.filter(([cmd]) => cmd.action === 'type')).toHaveLength(1);
  });

  it('never starts recording from ordinary open/observe/type — record_start is the only path', async () => {
    // Even with recording ENABLED in config, ordinary actions must not begin a recording.
    process.env.BIMAX_COMPUTER_RECORD = '1';
    __resetConfigForTests();
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'Calculator' }, { cwd: '/tmp' });
    await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'background' }, { cwd: '/tmp' });
    await runtime.run({ action: 'type', text: '2+2', deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(callTool.mock.calls.some(([a]) => a.name === 'start_recording')).toBe(false);

    // Explicit record_start (window-scoped after open) is the one path that records.
    const rec = await runtime.run({ action: 'record_start' }, { cwd: '/tmp' });
    expect(rec.ok).toBe(true);
    const start = callTool.mock.calls.find(([arg]) => arg.name === 'start_recording')?.[0];
    expect(start.arguments).toEqual(expect.objectContaining({ record_video: true }));
    expect(start.arguments.output_dir).toMatch(/\/tmp\/\.bimax\/computer\/recordings\/run-/);

    const status = await runtime.run({ action: 'record_status' }, { cwd: '/tmp' });
    expect(status.recording).toEqual(expect.objectContaining({ enabled: true, outputDir: '/tmp/recording' }));
    const stopped = await runtime.run({ action: 'record_stop' }, { cwd: '/tmp' });
    expect(stopped.recording?.videoPath).toBe('/tmp/recording/recording.mp4');
  });

  it('refuses record_start entirely when recording is not opted in (default)', async () => {
    // beforeEach sets BIMAX_COMPUTER_RECORD=0 — the shipped default is also false.
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'Calculator' }, { cwd: '/tmp' });
    const rec = await runtime.run({ action: 'record_start' }, { cwd: '/tmp' });
    expect(rec.ok).toBe(false);
    expect(rec.error).toMatch(/opt-in/);
    expect(callTool.mock.calls.some(([a]) => a.name === 'start_recording')).toBe(false);
  });

  it('refuses whole-display video without explicit approval; scopes to the agent window when one exists', async () => {
    process.env.BIMAX_COMPUTER_RECORD = '1';
    __resetConfigForTests();
    // No window yet → whole-display video is REFUSED without explicit approval.
    const wide = new BimaxComputerRuntime(simulatedNative());
    const refused = await wide.run({ action: 'record_start' }, { cwd: '/tmp' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/whole-display/i);
    expect(callTool.mock.calls.some(([a]) => a.name === 'start_recording')).toBe(false);

    // A model-controlled boolean (the legacy field) can NEVER authorize whole-display capture …
    const forgedBool = await wide.run({ action: 'record_start', approveFullDisplay: true } as any, { cwd: '/tmp' });
    expect(forgedBool.ok).toBe(false);
    expect(forgedBool.error).toMatch(/whole-display/i);
    // … and neither can a guessed/forged token.
    const forgedToken = await wide.run({ action: 'record_start', fullDisplayToken: 'forged-token' }, { cwd: '/tmp' });
    expect(forgedToken.ok).toBe(false);
    expect(callTool.mock.calls.some(([a]) => a.name === 'start_recording')).toBe(false);

    // Only a governor-issued token (minted by the approval layer AFTER the user approved the
    // whole-display scope) authorizes it — and it is single-use.
    const token = wide.authorizeFullDisplayRecording();
    const approved = await wide.run({ action: 'record_start', fullDisplayToken: token }, { cwd: '/tmp' });
    expect(approved.ok).toBe(true);
    expect(approved.recording?.captureSafe).toBe(false);
    expect(approved.recording?.scope).toBe('whole display');
    expect(await wide.pipStatus()).toEqual(expect.objectContaining({ captureSafe: false }));
    // The consumed token cannot be replayed by a second runtime request.
    const replayTarget = new BimaxComputerRuntime(simulatedNative());
    const replay = await replayTarget.run({ action: 'record_start', fullDisplayToken: token }, { cwd: '/tmp' });
    expect(replay.ok).toBe(false);

    // With a live agent window, recording + PiP scope to that capture-safe surface only —
    // no whole-display approval needed.
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'Calculator', deliveryMode: 'foreground' }, { cwd: '/tmp' });
    const scoped = await runtime.run({ action: 'record_start' }, { cwd: '/tmp' });
    expect(scoped.recording?.captureSafe).toBe(true);
    expect(scoped.recording?.scope).toContain('window 7');
    const startCall = callTool.mock.calls.filter(([a]) => a.name === 'start_recording').pop()?.[0];
    expect(startCall.arguments).toEqual(expect.objectContaining({ pid: 42, window_id: 7 }));
    expect(await runtime.pipStatus()).toEqual(expect.objectContaining({
      captureSafe: true,
      surface: expect.stringMatching(/window 7/i),
    }));

    // The caller can deliberately request the same composited display a human sees. This must not
    // silently collapse back to the owned window merely because one exists.
    await runtime.run({ action: 'record_stop' }, { cwd: '/tmp' });
    const displayToken = runtime.authorizeFullDisplayRecording();
    const display = await runtime.run({
      action: 'record_start', captureScope: 'display', fullDisplayToken: displayToken,
    }, { cwd: '/tmp' });
    expect(display.recording).toEqual(expect.objectContaining({ scope: 'whole display', captureSafe: false }));
    const displayStart = callTool.mock.calls.filter(([a]) => a.name === 'start_recording').pop()?.[0];
    expect(displayStart.arguments).not.toHaveProperty('pid');
    expect(displayStart.arguments).not.toHaveProperty('window_id');
  });

  it('ends the native session at a turn boundary so PiP cannot linger', async () => {
    const close = jest.fn();
    (openClient as jest.Mock).mockResolvedValue({ callTool, close });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'Calculator' });
    await runtime.dispose();
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'end_session' }));
    expect(close).toHaveBeenCalledTimes(1);

    await runtime.run({ action: 'status' });
    expect(openClient).toHaveBeenCalledTimes(2);
    expect(callTool.mock.calls.filter(([arg]) => arg.name === 'start_session')).toHaveLength(2);
  });

  it('streams the active target continuously, suspends for takeover, resumes, and stops on dispose', async () => {
    process.env.BIMAX_COMPUTER_PIP = '1';
    __resetConfigForTests();
    // syncLivePip resolves config fire-and-forget; a cold cache means real disk reads that the
    // single setImmediate below does not wait for. Warm the cache so sync lands deterministically.
    await loadConfig();
    const sync = jest.fn();
    const stop = jest.fn(async () => undefined);
    const pip: LivePipPort = {
      sync,
      stop,
      status: () => ({
        enabled: true,
        running: true,
        continuous: true,
        captureSafe: true,
        surface: 'Calculator window 7',
      }),
    };
    const native: any = {
      run: jest.fn(async (cmd: any) => ({
        ok: true, action: cmd.action, driver: 'native-helper',
        app: cmd.app || 'Calculator', x: cmd.x, y: cmd.y, summary: `${cmd.action} done`,
      })),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Calculator',
    };
    const runtime = new BimaxComputerRuntime(native, pip);

    await runtime.run({ action: 'open', app: 'Calculator', deliveryMode: 'foreground' });
    await new Promise(resolve => setImmediate(resolve));
    expect(sync).toHaveBeenLastCalledWith(
      { pid: 42, windowId: 7, label: 'Calculator window 7' },
      true,
    );
    expect(await runtime.pipStatus()).toEqual(expect.objectContaining({
      enabled: true, running: true, continuous: true, captureSafe: true,
    }));

    runtime.pauseForUser();
    await new Promise(resolve => setImmediate(resolve));
    expect(sync).toHaveBeenLastCalledWith(null, true);

    runtime.resume();
    await new Promise(resolve => setImmediate(resolve));
    expect(sync).toHaveBeenLastCalledWith(
      { pid: 42, windowId: 7, label: 'Calculator window 7' },
      true,
    );

    await runtime.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('pins actions to the freshly opened window and ignores stale model-repeated ids', async () => {
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'Calculator' });

    const observed = await runtime.run({
      action: 'observe', app: 'Calculator', pid: 999, windowId: 5142, query: '216,174',
    });
    expect(observed).toEqual(expect.objectContaining({
      ok: true, pid: 42, windowId: 7,
      verification: { query: '216,174', matched: true, matchCount: 1 },
    }));
    const observeCall = callTool.mock.calls.find(([arg]) => arg.name === 'get_window_state')?.[0];
    expect(observeCall.arguments).toEqual(expect.objectContaining({ pid: 42, window_id: 7 }));

    await runtime.run({
      action: 'click', app: 'Calculator', pid: 999, windowId: 5142,
      x: 250, y: 300, deliveryMode: 'background', pixelFallback: true,
    });
    const clickCall = callTool.mock.calls.find(([arg]) => arg.name === 'click')?.[0];
    expect(clickCall.arguments).toEqual(expect.objectContaining({
      pid: 42, window_id: 7, x: 250, y: 300, delivery_mode: 'background',
    }));
    expect(callTool.mock.calls.some(([arg]) => arg.name === 'move_cursor')).toBe(false);
  });

  it('rescans at the driver ceiling when the menu-first walk exhausts the budget (driver >=0.12)', async () => {
    // Driver >=0.12 walks the menu bar before the window; a big menu tree can consume the whole
    // scan cap. The runtime must retry once at 2000 instead of reporting a degraded window.
    const menuEls = Array.from({ length: 800 }, (_, i) => ({ element_index: i, role: 'AXMenuItem', label: `menu ${i}` }));
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'launch_app') return result({ name: 'Calculator', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') {
        const shot = { screenshot_file_path: '/tmp/bimax-window.png', screenshot_width: 500, screenshot_height: 700 };
        if (Number(args?.max_elements) <= 800) return result({ ...shot, tree_markdown: '', elements: menuEls });
        return result({
          ...shot, tree_markdown: '[900] AXButton "New Chat"',
          elements: [...menuEls, { element_index: 900, element_token: 'chat-token', role: 'AXButton', label: 'New Chat', frame: { x: 10, y: 10, w: 40, h: 20 } }],
        });
      }
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'Calculator' }, { cwd: '/tmp' });
    const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    expect(observed.degraded).toBeFalsy();
    expect(observed.elements?.some((e: any) => e.label === 'New Chat')).toBe(true);
    const caps = callTool.mock.calls
      .filter(([arg]) => arg.name === 'get_window_state')
      .map(([arg]) => arg.arguments.max_elements);
    expect(caps).toContain(2000);
  });

  it('strips invisible bidi marks from driver-reported app names before they enter target state', async () => {
    // Driver >=0.12 reports a bidi-marked app name (0.8 reported it clean). A marked name breaks
    // `open -a` focus recovery and leaks invisible characters into every summary.
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'launch_app') return result({ name: '‎WhatsApp', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/bimax-window.png', screenshot_width: 500, screenshot_height: 700,
        tree_markdown: '', elements: [{ element_index: 1, role: 'AXButton', label: 'New Chat' }],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    const opened = await runtime.run({ action: 'open', app: 'WhatsApp' }, { cwd: '/tmp' });
    expect(opened.app).toBe('WhatsApp');
    expect(String(opened.summary)).not.toMatch(/‎/);
  });

  // Captured from a live WhatsApp run: driver 0.12.3 hands back bidi-marked ELEMENT text too, and
  // the sidebar exposes its chat rows next to icon-only buttons carrying no label at all.
  const whatsAppWindow = (elements: any[]) => async ({ name }: any) => {
    if (name === 'launch_app') return result({ name: 'WhatsApp', pid: 42, windows: [{ window_id: 7 }] });
    if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
    if (name === 'get_window_state') return result({
      screenshot_file_path: '/tmp/bimax-window.png', screenshot_width: 500, screenshot_height: 700,
      tree_markdown: '', elements,
    });
    return result({ ok: true });
  };

  it('strips bidi marks from element text so an exact label still beats a substring match', async () => {
    // A marked label survives trim(), so "‎chats" !== "chats" while "‎chats".includes("chats")
    // is true: the exact tier goes empty and the real button lands in the same bucket as every
    // partial hit, which the resolver then rejects as ambiguous. That is what drove the live model
    // off `query` and onto guessed element indices.
    callTool.mockImplementation(whatsAppWindow([
      { element_index: 0, role: 'AXWindow', label: '‎WhatsApp', frame: { x: 0, y: 0, w: 500, h: 700 } },
      { element_index: 1, role: 'AXButton', label: '‎Chats', frame: { x: 10, y: 80, w: 60, h: 40 } },
      { element_index: 2, role: 'AXButton', label: 'Archived Chats', frame: { x: 10, y: 200, w: 120, h: 40 } },
    ]));
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'WhatsApp' }, { cwd: '/tmp' });
    const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    expect(JSON.stringify(observed.elements)).not.toMatch(/‎/);

    const clicked = await runtime.run({ action: 'click', query: 'Chats', deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(true);
    const click = callTool.mock.calls.filter(([a]) => a.name === 'click').map(([a]) => a.arguments).pop();
    expect(click).toEqual(expect.objectContaining({ element_index: 1 })); // exact semantic control
  });

  it('resolves a click query to the clickable control, not an identically-named heading', async () => {
    callTool.mockImplementation(whatsAppWindow([
      { element_index: 0, role: 'AXWindow', label: 'WhatsApp', frame: { x: 0, y: 0, w: 500, h: 700 } },
      { element_index: 1, role: 'AXHeading', label: 'Chats', frame: { x: 150, y: 20, w: 80, h: 30 } },
      { element_index: 2, role: 'AXButton', label: 'Chats', frame: { x: 10, y: 80, w: 60, h: 40 } },
    ]));
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'WhatsApp' }, { cwd: '/tmp' });
    await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    const clicked = await runtime.run({ action: 'click', query: 'Chats', deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(true);
    const click = callTool.mock.calls.filter(([a]) => a.name === 'click').map(([a]) => a.arguments).pop();
    expect(click).toEqual(expect.objectContaining({ element_index: 2 })); // the button, not the heading
  });

  it('names unlabeled icon buttons so each is distinctly addressable', async () => {
    // Icon-only controls (send/attach/emoji) arrive as AXButton "" — indistinguishable from each
    // other, unusable in a query, and the reason the model fell back to guessing coordinates.
    callTool.mockImplementation(whatsAppWindow([
      { element_index: 0, role: 'AXWindow', label: 'WhatsApp', frame: { x: 0, y: 0, w: 500, h: 700 } },
      { element_index: 1, role: 'AXStaticText', label: 'Type a message', frame: { x: 100, y: 600, w: 150, h: 20 } },
      { element_index: 2, role: 'AXButton', label: '', frame: { x: 60, y: 600, w: 30, h: 30 } },
      { element_index: 3, role: 'AXButton', label: '', frame: { x: 280, y: 600, w: 30, h: 30 } },
      { element_index: 4, role: 'AXButton', label: '', frame: { x: 450, y: 60, w: 30, h: 30 } },
    ]));
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'WhatsApp' }, { cwd: '/tmp' });
    const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    const blanks = (observed.elements as any[]).filter(e => [2, 3, 4].includes(e.element_index));
    expect(blanks).toHaveLength(3);
    expect(blanks.every(e => String(e.label || '').trim())).toBe(true);
    expect(new Set(blanks.map(e => e.label)).size).toBe(3); // each one addressable on its own
    // The two beside the composer are named by it; the far-away one falls back to position.
    expect(blanks.filter(e => /Type a message/.test(e.label))).toHaveLength(2);
    expect(blanks.find(e => e.element_index === 4).label).toMatch(/top-right/);

    // ...and a synthesized name is a real handle: it resolves to that exact control.
    const target = blanks.find(e => e.element_index === 3).label;
    const clicked = await runtime.run({ action: 'click', query: target, deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(true);
    const click = callTool.mock.calls.filter(([a]) => a.name === 'click').map(([a]) => a.arguments).pop();
    expect(click).toEqual(expect.objectContaining({ element_index: 3 }));
  });

  it('re-acquires the previous turn\'s window so a follow-up request is not stranded', async () => {
    // dispose() runs at every user-turn boundary and drops target ownership, but the app stays open
    // and the next request continues the same workflow ("now reply to her"). Turn 2 then had no
    // legal move: observe refused for want of a target, input refused for want of a frame only
    // observe could produce, and `open` looked wrong for an already-open app — so the model looped
    // observe/click until the turn was interrupted.
    callTool.mockImplementation(whatsAppWindow([
      { element_index: 0, role: 'AXWindow', label: 'WhatsApp', frame: { x: 0, y: 0, w: 500, h: 700 } },
      { element_index: 1, role: 'AXButton', label: 'Mom 2', frame: { x: 10, y: 80, w: 60, h: 40 } },
    ]));
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'WhatsApp' }, { cwd: '/tmp' });
    await runtime.dispose(); // ← the user-turn boundary

    const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    expect(observed.ok).toBe(true);
    expect(observed.windowId).toBe(7);
    // Identity came back, and with it a fresh frame — so input is legal again in the new turn.
    const clicked = await runtime.run({ action: 'click', query: 'Mom 2', deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(true);
  });

  it('refuses with the exact recovery verb when the remembered app is really gone', async () => {
    callTool.mockImplementation(whatsAppWindow([
      { element_index: 0, role: 'AXWindow', label: 'WhatsApp', frame: { x: 0, y: 0, w: 500, h: 700 } },
    ]));
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'WhatsApp' }, { cwd: '/tmp' });
    await runtime.dispose();
    // The app quit between turns: no windows remain for that pid, so nothing may be re-adopted.
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'list_windows') return result({ windows: [] });
      return result({ ok: true });
    });
    const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    expect(observed.ok).toBe(false);
    expect(observed.error).toMatch(/action=open with app="WhatsApp"/);
  });

  it('folds model verb synonyms onto real actions instead of failing the step', async () => {
    // "snapshot" showed up in nearly every live episode: the model wanted a frame, got
    // "unsupported computer action: snapshot", and wasted the step.
    callTool.mockImplementation(whatsAppWindow([
      { element_index: 0, role: 'AXWindow', label: 'WhatsApp', frame: { x: 0, y: 0, w: 500, h: 700 } },
    ]));
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'WhatsApp' }, { cwd: '/tmp' });
    const shot = await runtime.run({ action: 'snapshot' } as any, { cwd: '/tmp' });
    expect(shot.ok).toBe(true);
    expect(shot.action).toBe('screenshot');
  });

  it('applies the no-usable-window recovery to any app, not a hardcoded one', async () => {
    // The Cmd+N recovery used to be gated on the app being named "Finder". Any app can be frontmost
    // while exposing only a menu proxy or having had its last window closed, so the recovery is now
    // driven by probing the window. This app is deliberately not one macOS special-cases.
    let realWindow = false;
    const nativeRun = jest.fn(async (cmd: any) => {
      if (cmd.action === 'key' && cmd.combo === 'cmd+n') realWindow = true;
      return { ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} done` };
    });
    const native: any = { run: nativeRun, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }), frontmostApp: async () => 'Zephyr' };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'launch_app') return result({ name: 'Zephyr', pid: 777, windows: [{ window_id: 10 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: 777, name: 'Zephyr', active: true }] });
      if (name === 'list_windows') return result({ windows: realWindow
        ? [{ window_id: 4242, is_on_screen: true, bounds: { width: 900, height: 700 } }]
        : [{ window_id: 10, is_on_screen: true, bounds: { width: 1200, height: 34 } }] });
      if (name === 'get_window_state') return result({ screenshot_file_path: '/tmp/z.png', screenshot_width: 900, screenshot_height: 700, elements: [] });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(native);
    const opened = await runtime.run({ action: 'open', app: 'Zephyr', deliveryMode: 'foreground' });
    expect(opened.ok).toBe(true);
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({ action: 'key', combo: 'cmd+n' }), undefined);
    expect(opened.windowId).toBe(4242);
  });

  // ---- multi-app sessions -------------------------------------------------------------------
  // Every real cross-app workflow (send a file from a file manager to a chat app; copy here and
  // paste there) needs two apps alive at once. A single owned target could only ever describe one.

  /** Which app the simulated window server reports as frontmost; Space tests drive this. */
  let activeApp = '';

  /**
   * A native fallback wired to the same simulated window server as the sidecar fixture.
   *
   * The runtime asks the native helper for the frontmost app before it asks the sidecar, because
   * the helper answers in 4ms where the sidecar's app enumeration takes 642ms. A test that builds a
   * runtime WITHOUT a native stub therefore asks the real desktop — which reports whatever app the
   * developer happens to have in front, then sends the runtime down the "activated X but Y is still
   * frontmost" escalation path against real apps that do not exist. Slow, and dependent on the
   * machine rather than the fixture.
   */
  const simulatedNative = () => ({
    run: jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action })),
    quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
    frontmostApp: async () => activeApp,
  } as any);

  /** Two independent apps, each with its own pid/window, addressable by name. */
  const twoApps = (elementsByPid: Record<number, any[]>) => {
    const meta: Record<string, { pid: number; window: number }> = {
      alpha: { pid: 42, window: 7 }, beta: { pid: 84, window: 9 },
    };
    return async ({ name, arguments: args }: any) => {
      if (name === 'launch_app') {
        const key = String(args?.name || '').toLowerCase();
        const m = meta[key];
        if (!m) return result({ ok: false });
        activeApp = key === 'alpha' ? 'Alpha' : 'Beta';
        return result({ name: activeApp, pid: m.pid, windows: [{ window_id: m.window }] });
      }
      // Activating an app makes it frontmost. Modelling that is what keeps the two authorities the
      // runtime can ask — the sidecar's app list and the native helper — telling the same story. A
      // fixture that pins one app as permanently frontmost while the test activates another
      // describes an impossible desktop, and it hid a real "activated B, A is still in front"
      // report as long as the sidecar answered "unknown".
      if (name === 'bring_to_front') {
        const pid = Number(args?.pid || 0);
        if (pid === 42) activeApp = 'Alpha';
        else if (pid === 84) activeApp = 'Beta';
        return result({ activated: true });
      }
      if (name === 'list_windows') {
        const pid = Number(args?.pid || 0);
        const window = pid === 84 ? 9 : 7;
        if (pid && !elementsByPid[pid]) return result({ windows: [] });
        return result({ windows: [{ window_id: window, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      }
      // `active` is how the runtime resolves the frontmost app through the sidecar, so the fixture
      // has to carry it — otherwise frontmostApp() comes back empty and any test about which app is
      // in front silently tests nothing.
      if (name === 'list_apps') {
        return result({ apps: [
          { pid: 42, name: 'Alpha', active: activeApp === 'Alpha' },
          { pid: 84, name: 'Beta', active: activeApp === 'Beta' },
        ] });
      }
      if (name === 'get_window_state') {
        const pid = Number(args?.pid || 42);
        return result({
          screenshot_file_path: `/tmp/bimax-${pid}.png`, screenshot_width: 500, screenshot_height: 700,
          tree_markdown: '', elements: elementsByPid[pid] || [],
        });
      }
      return result({ ok: true });
    };
  };

  const alphaBeta = () => twoApps({
    42: [
      { element_index: 0, role: 'AXWindow', label: 'Alpha', frame: { x: 0, y: 0, w: 500, h: 700 } },
      { element_index: 1, role: 'AXButton', label: 'Alpha Action', frame: { x: 10, y: 80, w: 60, h: 40 } },
    ],
    84: [
      { element_index: 0, role: 'AXWindow', label: 'Beta', frame: { x: 0, y: 0, w: 500, h: 700 } },
      { element_index: 1, role: 'AXButton', label: 'Beta Action', frame: { x: 20, y: 120, w: 60, h: 40 } },
    ],
  });

  it('keeps both apps registered when a second one is opened', async () => {
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const beta = await runtime.run({ action: 'open', app: 'beta' }, { cwd: '/tmp' });
    expect(beta.pid).toBe(84);
    // The newly opened app becomes the ACTIVE surface — the registry used to leave `active` pinned
    // to whichever app was registered first, so PiP capture and the persisted session state both
    // kept naming an app the agent had already moved on from.
    expect(runtime.activeSurface()?.pid).toBe(84);
    expect(runtime.surfaceSnapshot().map(s => s.pid).sort()).toEqual([42, 84]);
  });

  it('cannot let a late Notes-style observation overwrite a newer app target or PiP', async () => {
    process.env.BIMAX_COMPUTER_PIP = '1';
    const impl = alphaBeta();
    let blockAlphaObserve = false;
    let releaseObserve!: () => void;
    let markObserveStarted!: () => void;
    const observeGate = new Promise<void>(resolve => { releaseObserve = resolve; });
    const observeStarted = new Promise<void>(resolve => { markObserveStarted = resolve; });
    callTool.mockImplementation(async (request: any) => {
      if (blockAlphaObserve && request.name === 'get_window_state' && Number(request.arguments?.pid) === 42) {
        markObserveStarted();
        await observeGate;
      }
      return impl(request);
    });
    let previewTarget: { pid: number; windowId: number } | undefined;
    const sync = jest.fn(async (target: any) => {
      previewTarget = target ? { pid: target.pid, windowId: target.windowId } : undefined;
    });
    const pip: LivePipPort = {
      sync,
      stop: jest.fn(async () => undefined),
      status: () => ({
        enabled: true, running: !!previewTarget, continuous: true,
        captureSafe: !!previewTarget, target: previewTarget,
      }),
    };
    const runtime = new BimaxComputerRuntime(simulatedNative(), pip);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });

    blockAlphaObserve = true;
    const oldObservation = runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    await observeStarted;
    const switchToBeta = runtime.run({ action: 'open', app: 'beta' }, { cwd: '/tmp' });
    await new Promise(resolve => setImmediate(resolve));
    // The switch waits behind the observation because both replace the one target/frame pipeline.
    expect(callTool.mock.calls.filter(([a]) => a.name === 'launch_app')).toHaveLength(1);

    releaseObserve();
    await expect(oldObservation).resolves.toEqual(expect.objectContaining({ ok: true, pid: 42 }));
    await expect(switchToBeta).resolves.toEqual(expect.objectContaining({ ok: true, pid: 84 }));
    expect(runtime.activeSurface()).toEqual(expect.objectContaining({ pid: 84, windowId: 9 }));
    expect(previewTarget).toEqual({ pid: 84, windowId: 9 });
    expect(sync.mock.calls.some(([target]) => target === null)).toBe(true); // old preview hidden first

    const clicked = await runtime.run({ action: 'click', query: 'Beta Action', deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(true);
    expect(callTool.mock.calls.filter(([a]) => a.name === 'click').pop()?.[0].arguments)
      .toEqual(expect.objectContaining({ pid: 84, window_id: 9 }));
  });

  it('refuses input when an enabled PiP cannot acquire the exact owned window', async () => {
    process.env.BIMAX_COMPUTER_PIP = '1';
    callTool.mockImplementation(alphaBeta());
    const pip: LivePipPort = {
      sync: jest.fn(async () => undefined), // broken preview: accepts sync but never owns a target
      stop: jest.fn(async () => undefined),
      status: () => ({
        enabled: true, running: false, continuous: true, captureSafe: false, target: undefined,
      }),
    };
    const runtime = new BimaxComputerRuntime(simulatedNative(), pip);
    const opened = await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const clicked = await runtime.run({
      action: 'click', query: 'Alpha Action', frameId: opened.frameId, deliveryMode: 'background',
    }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(false);
    expect(clicked.error).toMatch(/preview has no target/i);
    expect(callTool.mock.calls.filter(([a]) => a.name === 'click')).toHaveLength(0);
  });

  it('switches back to an already-open app with focus, without re-launching it', async () => {
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    await runtime.run({ action: 'open', app: 'beta' }, { cwd: '/tmp' });
    const launchesBefore = callTool.mock.calls.filter(([a]) => a.name === 'launch_app').length;

    const back = await runtime.run({ action: 'focus', app: 'Alpha' }, { cwd: '/tmp' });
    expect(back.ok).toBe(true);
    expect(back.pid).toBe(42);
    // Re-launching a running app risks a second instance and discards its current state — the whole
    // reason focus exists. It must switch using the registration alone.
    expect(callTool.mock.calls.filter(([a]) => a.name === 'launch_app')).toHaveLength(launchesBefore);
    expect(runtime.activeSurface()?.pid).toBe(42);

    // focus returns a fresh frame, so input is legal immediately afterwards.
    const clicked = await runtime.run({ action: 'click', query: 'Alpha Action', deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(true);
    expect(callTool.mock.calls.filter(([a]) => a.name === 'click').pop()?.[0].arguments)
      .toEqual(expect.objectContaining({ pid: 42 }));
  });

  it('serializes focus with clipboard mutations so OS-global state cannot race a target switch', async () => {
    const impl = alphaBeta();
    let blockFocus = false;
    let releaseFocus!: () => void;
    let markFocusStarted!: () => void;
    const focusGate = new Promise<void>(resolve => { releaseFocus = resolve; });
    const focusStarted = new Promise<void>(resolve => { markFocusStarted = resolve; });
    callTool.mockImplementation(async (request: any) => {
      if (blockFocus && request.name === 'bring_to_front' && Number(request.arguments?.pid) === 42) {
        markFocusStarted();
        await focusGate;
      }
      return impl(request);
    });
    const native = simulatedNative();
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    await runtime.run({ action: 'open', app: 'beta' }, { cwd: '/tmp' });

    blockFocus = true;
    const focusing = runtime.run({ action: 'focus', app: 'Alpha' }, { cwd: '/tmp' });
    await focusStarted;
    const writingClipboard = runtime.run({ action: 'clipboard', value: 'queued safely' }, { cwd: '/tmp' });
    await new Promise(resolve => setTimeout(resolve, 0));

    // Before the fix, focus was outside the single-input executor and this write ran immediately.
    expect(native.run).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'clipboard_write' }), expect.anything());
    releaseFocus();
    await expect(focusing).resolves.toEqual(expect.objectContaining({ ok: true, app: 'Alpha' }));
    await expect(writingClipboard).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(native.run).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'clipboard_write', text: 'queued safely' }),
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('drops the old perception snapshot when a same-app focus fails to capture', async () => {
    const impl = alphaBeta();
    let failCapture = false;
    callTool.mockImplementation(async (request: any) => {
      if (failCapture && request.name === 'get_window_state') throw new Error('capture unavailable');
      return impl(request);
    });
    const native = simulatedNative();
    const runtime = new BimaxComputerRuntime(native);
    const opened = await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    expect(opened.frameId).toBeTruthy();

    failCapture = true;
    const failedFocus = await runtime.run({ action: 'focus', app: 'Alpha' }, { cwd: '/tmp' });
    expect(failedFocus.ok).toBe(false);
    const staleClick = await runtime.run({ action: 'click', x: 20, y: 120, deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(staleClick.ok).toBe(false);
    expect(staleClick.error).toMatch(/fresh screenshot.*required before input/);
  });

  it('refuses an action when the live window geometry no longer matches its frame', async () => {
    let liveX = 0;
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'launch_app') return result({ name: 'Alpha', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: liveX, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/bimax-geometry.png', screenshot_width: 500, screenshot_height: 700,
        elements: [{ element_index: 0, role: 'AXWindow', label: 'Alpha', frame: { x: 0, y: 0, w: 500, h: 700 } }],
      });
      return result({ ok: true });
    });
    const native = simulatedNative();
    const runtime = new BimaxComputerRuntime(native);
    const opened = await runtime.run({ action: 'open', app: 'Alpha' }, { cwd: '/tmp' });
    expect(opened.frameId).toBeTruthy();

    // Translation is safe (the screenshot-local layout is unchanged), but a resize can reflow the
    // controls and must invalidate every coordinate planned from the old frame.
    liveX = 0;
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'launch_app') return result({ name: 'Alpha', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: liveX, y: 0, width: 420, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/bimax-geometry.png', screenshot_width: 500, screenshot_height: 700,
        elements: [{ element_index: 0, role: 'AXWindow', label: 'Alpha', frame: { x: 0, y: 0, w: 500, h: 700 } }],
      });
      return result({ ok: true });
    });
    const clicked = await runtime.run({
      action: 'click', x: 100, y: 100, frameId: opened.frameId, deliveryMode: 'foreground',
    }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(false);
    expect(clicked.error).toMatch(/geometry-changed/);
    expect(native.run).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'click' }), expect.anything());
  });

  it('refuses input aimed at a non-active app and names focus as the recovery', async () => {
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    await runtime.run({ action: 'open', app: 'beta' }, { cwd: '/tmp' });
    // Beta is active and its frame is the newest one. Delivering a click labelled "Alpha" here would
    // ground Beta's geometry against Alpha's window, so it must still be refused — but the model now
    // gets the verb that actually fixes it instead of being told to re-open a running app.
    const refused = await runtime.run({ action: 'click', app: 'Alpha', query: 'Alpha Action' }, { cwd: '/tmp' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/already open/);
    expect(refused.error).toMatch(/action=focus with app="Alpha"/);
  });

  it('tells the model to open an app that is neither registered nor running', async () => {
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const missing = await runtime.run({ action: 'focus', app: 'Gamma' }, { cwd: '/tmp' });
    expect(missing.ok).toBe(false);
    // "not open in this session" was the old wording, and it was misleading once focus learned to
    // adopt a running app: the session's own history is no longer what decides. What focus can now
    // report is the thing that is actually true — no on-screen window belongs to Gamma.
    expect(missing.error).toMatch(/not running/);
    expect(missing.error).toMatch(/open in this session: Alpha/);
    expect(missing.error).toMatch(/action=open/);
  });

  it('forgets only the quit app and leaves the other registered', async () => {
    // quit_app always goes through the foreground path (a cooperative Cmd+Q must reach the frontmost
    // app), so this case needs a working native fallback rather than background delivery.
    const native: any = {
      run: jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} delivered` })),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Beta',
    };
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    await runtime.run({ action: 'open', app: 'beta' }, { cwd: '/tmp' });
    // Beta is active; quitting it must not erase Alpha's registration and force a re-launch.
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'list_windows' && Number(args?.pid) === 84) return result({ windows: [] });
      return alphaBeta()({ name, arguments: args });
    });
    const quit = await runtime.run({ action: 'quit_app' }, { cwd: '/tmp' });
    expect(quit.ok).toBe(true);
    expect(quit.pid).toBe(84);

    callTool.mockImplementation(alphaBeta());
    const back = await runtime.run({ action: 'focus', app: 'Alpha' }, { cwd: '/tmp' });
    expect(back.ok).toBe(true);
    expect(back.pid).toBe(42);
  });

  // ---- clipboard bridge ---------------------------------------------------------------------
  // Moving content between apps goes through the pasteboard, an OS service — the same operation
  // for every application, with no per-app knowledge anywhere in the path.

  /** A native fallback with a simulated system pasteboard, including the OS write counter. */
  const clipboardNative = (initial: Partial<{ text: string; files: string[]; changeCount: number }> = {}) => {
    const board = { text: '', files: [] as string[], types: [] as string[], changeCount: 10, ...initial };
    const run = jest.fn(async (cmd: any) => {
      if (cmd.action === 'clipboard_read') {
        return { ok: true, action: cmd.action, driver: 'native-helper', clipboard: { ...board }, summary: 'read' };
      }
      if (cmd.action === 'clipboard_write') {
        board.text = cmd.text || ''; board.files = []; board.changeCount++;
        return { ok: true, action: cmd.action, driver: 'native-helper', clipboard: { ...board }, summary: 'wrote' };
      }
      if (cmd.action === 'clipboard_write_files') {
        board.files = [...(cmd.paths || [])]; board.text = ''; board.changeCount++;
        return { ok: true, action: cmd.action, driver: 'native-helper', clipboard: { ...board }, summary: 'wrote files' };
      }
      return { ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} delivered` };
    });
    return {
      board,
      native: { run, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }), frontmostApp: async () => 'Alpha' } as any,
      /** Make the next copy shortcut behave like an app that really copied something. */
      copyPlaces: (text: string) => run.mockImplementation(async (cmd: any) => {
        if (cmd.action === 'key' && cmd.combo === 'cmd+c') { board.text = text; board.changeCount++; return { ok: true, action: 'key', driver: 'native-helper', summary: 'copied' }; }
        if (cmd.action === 'clipboard_read') return { ok: true, action: cmd.action, driver: 'native-helper', clipboard: { ...board }, summary: 'read' };
        return { ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} delivered` };
      }),
    };
  };

  it('fails a copy that delivered the keystroke but placed nothing on the clipboard', async () => {
    // Cmd+C with no selection is accepted by every app and does nothing. Without checking the OS
    // write counter this reports as a clean success, and the agent goes on to paste stale content.
    const { native } = clipboardNative({ text: 'stale from earlier', changeCount: 10 });
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const copied = await runtime.run({ action: 'copy' }, { cwd: '/tmp' });
    expect(copied.ok).toBe(false);
    expect(copied.error).toMatch(/clipboard did not change/);
    expect(copied.error).toMatch(/nothing was selected/);
    expect(copied.actionResult).toEqual(expect.objectContaining({
      delivered: true, postcondition: { query: 'clipboard received new content', matched: false },
    }));
  });

  it('confirms a copy when the OS write counter advances', async () => {
    const clip = clipboardNative({ changeCount: 10 });
    clip.copyPlaces('the text that was selected');
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(clip.native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const copied = await runtime.run({ action: 'copy' }, { cwd: '/tmp' });
    expect(copied.ok).toBe(true);
    expect(copied.clipboard?.text).toBe('the text that was selected');
    expect(copied.actionResult?.confidence).toBe('proven');
  });

  it('treats a re-copy of identical text as a real copy', async () => {
    // Content comparison alone would call this "no change". The OS counter advances on every write,
    // which is exactly why it — and not the text — is the signal.
    const clip = clipboardNative({ text: 'same text', changeCount: 10 });
    clip.copyPlaces('same text');
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(clip.native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    expect((await runtime.run({ action: 'copy' }, { cwd: '/tmp' })).ok).toBe(true);
  });

  it('refuses a background click aimed at bare pixels when the window is off the active Space', async () => {
    // The hole this closes: the Space guard only ran for FOREGROUND delivery, and its own
    // remediation told the caller to use deliveryMode="background" instead. But background with
    // nothing but an x/y has no accessibility handle to address, so the driver synthesizes a real
    // global cursor event — landing in whatever app actually owns those screen coordinates.
    process.env.BIMAX_COMPUTER_VISIBLE = '0';
    __resetConfigForTests();
    const clicks: any[] = [];
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Alpha', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: false, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/alpha-offspace.png', screenshot_width: 500, screenshot_height: 700,
        elements: [{ element_index: 0, element_token: 'win', role: 'AXWindow', label: 'Alpha', frame: { x: 0, y: 0, w: 500, h: 700 } }],
      });
      if (name === 'click') { clicks.push(args); return result({ effect: 'delivered' }); }
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime({
      run: jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action })),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Alpha',
    } as any);
    await runtime.run({ action: 'open', app: 'Alpha' }, { cwd: '/tmp' });
    const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });

    const refused = await runtime.run({
      action: 'click', x: 100, y: 100, deliveryMode: 'background', frameId: observed.frameId,
    }, { cwd: '/tmp' });

    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toMatch(/not on the active Space/);
    // The point of the guard: nothing may reach the driver.
    expect(clicks).toHaveLength(0);
  });

  it('keeps copy and paste PID/window-scoped in background mode without fronting the app', async () => {
    process.env.BIMAX_COMPUTER_VISIBLE = '0';
    __resetConfigForTests();
    const clip = clipboardNative({ text: 'carried across', changeCount: 10 });
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Alpha', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: false, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/alpha-background.png', screenshot_width: 500, screenshot_height: 700,
        elements: [{ element_index: 0, role: 'AXWindow', label: 'Alpha', frame: { x: 0, y: 0, w: 500, h: 700 } }],
      });
      if (name === 'hotkey') {
        expect(args).toEqual(expect.objectContaining({
          pid: 42, delivery_mode: 'background', keys: expect.any(Array),
        }));
        expect(args.window_id).toBeUndefined(); // same-PID focused child/editable receives it
        if (args.keys.includes('c')) { clip.board.text = 'new selection'; clip.board.changeCount++; }
        return result({ effect: 'delivered' });
      }
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(clip.native);
    await runtime.run({ action: 'open', app: 'Alpha' }, { cwd: '/tmp' });

    const copied = await runtime.run({ action: 'copy' }, { cwd: '/tmp' });
    expect(copied.ok).toBe(true);
    expect(copied.clipboard?.text).toBe('new selection');
    const pasted = await runtime.run({ action: 'paste' }, { cwd: '/tmp' });
    expect(pasted.ok).toBe(true);

    expect(callTool.mock.calls.some(([call]: any) => call.name === 'bring_to_front')).toBe(false);
    expect((clip.native.run as jest.Mock).mock.calls.some(([cmd]: any) => cmd.action === 'key')).toBe(false);
  });

  it('refuses to paste an empty clipboard instead of pressing a shortcut that does nothing', async () => {
    const { native } = clipboardNative({ text: '', files: [] });
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const pasted = await runtime.run({ action: 'paste' }, { cwd: '/tmp' });
    expect(pasted.ok).toBe(false);
    expect(pasted.error).toMatch(/clipboard is empty/);
  });

  it('verifies a paste by finding the pasted text in the destination frame', async () => {
    const { native } = clipboardNative({ text: 'carried across', changeCount: 12 });
    callTool.mockImplementation(twoApps({
      42: [
        { element_index: 0, role: 'AXWindow', label: 'Alpha', frame: { x: 0, y: 0, w: 500, h: 700 } },
        // The destination now shows the pasted content — the postcondition a paste can actually prove.
        { element_index: 1, role: 'AXTextArea', label: 'Body', value: 'carried across', frame: { x: 10, y: 80, w: 400, h: 200 } },
      ],
    }));
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const pasted = await runtime.run({ action: 'paste' }, { cwd: '/tmp' });
    expect(pasted.ok).toBe(true);
    expect(pasted.actionResult?.postcondition).toEqual({ query: 'pasted text visible in Alpha', matched: true });
  });

  it('reports a paste whose text never appeared as unproven rather than successful', async () => {
    const { native } = clipboardNative({ text: 'carried across', changeCount: 12 });
    callTool.mockImplementation(alphaBeta()); // destination shows no such text
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const pasted = await runtime.run({ action: 'paste' }, { cwd: '/tmp' });
    expect(pasted.actionResult?.postcondition).toEqual({ query: 'pasted text visible in Alpha', matched: false });
    expect(pasted.actionResult?.confidence).not.toBe('proven');
  });

  it('puts files on the clipboard so a paste hands over the file, not its name', async () => {
    const { native, board } = clipboardNative();
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const put = await runtime.run({ action: 'clipboard', paths: ['/Users/me/Downloads/photo.jpg'] }, { cwd: '/tmp' });
    expect(put.ok).toBe(true);
    expect(board.files).toEqual(['/Users/me/Downloads/photo.jpg']);
    // Text must be empty: had the path landed as a string, the paste would type the filename into
    // the app instead of attaching the photo.
    expect(board.text).toBe('');
    expect(put.summary).toMatch(/photo\.jpg/);
  });

  // ---- window arrangement -------------------------------------------------------------------

  /** A native fallback with a simulated window server: screens, per-pid frames, fullscreen state. */
  const geometryNative = (opts: { minWidth?: number; fullscreenSupported?: boolean } = {}) => {
    const frames: Record<number, { x: number; y: number; w: number; h: number }> = {
      42: { x: 200, y: 200, w: 600, h: 400 }, 84: { x: 300, y: 250, w: 600, h: 400 },
    };
    const fullscreen: Record<number, boolean> = {};
    const run = jest.fn(async (cmd: any) => {
      const ok = (extra: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action, ...extra });
      if (cmd.action === 'screens') {
        return ok({ screens: [{ index: 1, main: true, scale: 2, frame: { x: 0, y: 0, w: 1470, h: 956 }, visible: { x: 0, y: 33, w: 1470, h: 864 } }] });
      }
      if (cmd.action === 'window_frame') return ok({ windowFrame: frames[cmd.pid], fullscreen: !!fullscreen[cmd.pid] });
      if (cmd.action === 'window_set_frame') {
        // Real apps clamp to their own minimum size — the reason the achieved frame is reported.
        const w = Math.max(cmd.bounds.w, opts.minWidth || 0);
        frames[cmd.pid] = { ...cmd.bounds, w };
        return ok({ windowFrame: frames[cmd.pid], requestedFrame: cmd.bounds });
      }
      if (cmd.action === 'window_fullscreen') {
        const supported = opts.fullscreenSupported !== false;
        if (supported) fullscreen[cmd.pid] = cmd.value === 'true';
        return ok({ fullscreen: !!fullscreen[cmd.pid], fullscreenSupported: supported, fullscreenMatched: supported && !!fullscreen[cmd.pid] === (cmd.value === 'true') });
      }
      return ok({});
    });
    // Follows the same simulated window server as the sidecar fixture, so the geometry stub cannot
    // claim a different app is in front than the one the test just activated.
    return { frames, run, native: { run, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }), frontmostApp: async () => activeApp || 'Alpha' } as any };
  };

  it('computes halves that tile the usable area exactly, with no seam or overlap', () => {
    // Derived from the visible area, so a tile clears the menu bar (y=33) and the Dock (h=864).
    const visible = { x: 0, y: 33, w: 1470, h: 864 };
    const left = layoutRect('left', visible);
    const right = layoutRect('right', visible);
    expect(left).toEqual({ x: 0, y: 33, w: 735, h: 864 });
    expect(right).toEqual({ x: 735, y: 33, w: 735, h: 864 });
    expect(left.x + left.w).toBe(right.x);           // they meet
    expect(right.x + right.w).toBe(visible.x + visible.w); // and reach the edge
  });

  it('splits an odd width without leaving a gap between the halves', () => {
    const visible = { x: 0, y: 33, w: 1471, h: 864 };
    const left = layoutRect('left', visible);
    const right = layoutRect('right', visible);
    expect(left.x + left.w).toBe(right.x);
    expect(right.x + right.w).toBe(1471);
  });

  it('tiles three columns that meet exactly, on any width', () => {
    // Thirds exist for the three-app layout halves cannot express. The property that matters is the
    // same one halves have: adjacent tiles meet, and the last one reaches the edge — on widths that
    // are not divisible by three, which is most of them.
    for (const w of [1470, 1471, 1472, 1920, 2559, 3440]) {
      const visible = { x: 0, y: 33, w, h: 864 };
      const left = layoutRect('left-third', visible);
      const centre = layoutRect('center-third', visible);
      const right = layoutRect('right-third', visible);
      expect(left.x).toBe(visible.x);
      expect(left.x + left.w).toBe(centre.x);
      expect(centre.x + centre.w).toBe(right.x);
      expect(right.x + right.w).toBe(visible.x + w);
      // Every column keeps the full usable height and clears the menu bar.
      for (const tile of [left, centre, right]) {
        expect(tile.y).toBe(33);
        expect(tile.h).toBe(864);
        expect(tile.w).toBeGreaterThan(0);
      }
    }
  });

  it('pairs two-thirds layouts with the complementary third, without overlap', () => {
    const visible = { x: 0, y: 33, w: 1471, h: 864 };
    const leftTwo = layoutRect('left-two-thirds', visible);
    const rightOne = layoutRect('right-third', visible);
    // The classic "editor + sidebar" split: the pair must tile the width exactly.
    expect(leftTwo.x + leftTwo.w).toBe(rightOne.x);
    expect(rightOne.x + rightOne.w).toBe(1471);

    const leftOne = layoutRect('left-third', visible);
    const rightTwo = layoutRect('right-two-thirds', visible);
    expect(leftOne.x + leftOne.w).toBe(rightTwo.x);
    expect(rightTwo.x + rightTwo.w).toBe(1471);
  });

  it('tiles on the display the window is actually on, not always the main one', () => {
    const screens = [
      { index: 1, main: true, scale: 2, frame: { x: 0, y: 0, w: 1470, h: 956 }, visible: { x: 0, y: 33, w: 1470, h: 864 } },
      { index: 2, main: false, scale: 1, frame: { x: 1470, y: 0, w: 1920, h: 1080 }, visible: { x: 1470, y: 0, w: 1920, h: 1080 } },
    ];
    // A window sitting on the external display must tile within THAT display; resolving against the
    // main screen would fling it back to the laptop panel.
    expect(screenForRect({ x: 1600, y: 100, w: 800, h: 600 }, screens)?.index).toBe(2);
    expect(screenForRect({ x: 100, y: 100, w: 800, h: 600 }, screens)?.index).toBe(1);
    // Straddling both: the display holding most of the window wins.
    expect(screenForRect({ x: 1300, y: 100, w: 800, h: 600 }, screens)?.index).toBe(2);
    // Parked off-screen entirely, or unknown — fall back to main rather than failing.
    expect(screenForRect({ x: -5000, y: -5000, w: 100, h: 100 }, screens)?.index).toBe(1);
    expect(screenForRect(undefined, screens)?.index).toBe(1);
  });

  it('tiles two apps side by side, each within the usable area', async () => {
    const geo = geometryNative();
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(geo.native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const left = await runtime.run({ action: 'arrange', layout: 'left' }, { cwd: '/tmp' });
    await runtime.run({ action: 'open', app: 'beta' }, { cwd: '/tmp' });
    const right = await runtime.run({ action: 'arrange', layout: 'right' }, { cwd: '/tmp' });
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    expect(geo.frames[42]).toEqual({ x: 0, y: 33, w: 735, h: 864 });
    expect(geo.frames[84]).toEqual({ x: 735, y: 33, w: 735, h: 864 });
    expect(left.actionResult?.confidence).toBe('proven');
  });

  it('reports the achieved frame when the app refuses the requested size', async () => {
    // TextEdit really does this: asked for a 735-wide left half, it clamps to its 818px minimum and
    // silently overlaps the other tile. Claiming a clean tile here would be a lie.
    const geo = geometryNative({ minWidth: 818 });
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(geo.native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const tiled = await runtime.run({ action: 'arrange', layout: 'left' }, { cwd: '/tmp' });
    expect(tiled.ok).toBe(true);
    expect(tiled.windowFrame).toEqual({ x: 0, y: 33, w: 818, h: 864 });
    expect(tiled.requestedFrame).toEqual({ x: 0, y: 33, w: 735, h: 864 });
    expect(tiled.actionResult?.postcondition?.matched).toBe(false);
    expect(tiled.actionResult?.confidence).not.toBe('proven');
    expect(tiled.summary).toMatch(/minimum size or size increments/);
  });

  it('accepts explicit bounds for an exact placement', async () => {
    const geo = geometryNative();
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(geo.native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const placed = await runtime.run({ action: 'arrange', bounds: { x: 10, y: 40, w: 500, h: 300 } }, { cwd: '/tmp' });
    expect(placed.ok).toBe(true);
    expect(geo.frames[42]).toEqual({ x: 10, y: 40, w: 500, h: 300 });
  });

  it('toggles native fullscreen and confirms the window settled into it', async () => {
    const geo = geometryNative();
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(geo.native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const full = await runtime.run({ action: 'arrange', layout: 'fullscreen' }, { cwd: '/tmp' });
    expect(full.ok).toBe(true);
    expect(full.fullscreen).toBe(true);
    expect(full.actionResult?.confidence).toBe('proven');
    const windowed = await runtime.run({ action: 'arrange', layout: 'unfullscreen' }, { cwd: '/tmp' });
    expect(windowed.ok).toBe(true);
    expect(windowed.fullscreen).toBe(false);
  });

  it('fails honestly when the window cannot go fullscreen at all', async () => {
    // Panels and utility windows expose no fullscreen capability. Reporting success here would send
    // the agent on to Space-switching shortcuts that can never reach a window that never went full.
    const geo = geometryNative({ fullscreenSupported: false });
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(geo.native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const full = await runtime.run({ action: 'arrange', layout: 'fullscreen' }, { cwd: '/tmp' });
    expect(full.ok).toBe(false);
    expect(full.error).toMatch(/no window that supports fullscreen/);
    expect(full.error).toMatch(/layout=maximize/);
  });

  it('refuses an arrange with neither layout nor bounds', async () => {
    const geo = geometryNative();
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(geo.native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const bad = await runtime.run({ action: 'arrange' }, { cwd: '/tmp' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/needs layout/);
  });

  // ---- the desktop surface ----------------------------------------------------------------------
  // The desktop has no window id, so it is enumerated natively and addressed in global screen points
  // rather than through the window-scoped observation path.

  /** A simulated desktop whose items move when dragged, and which can be told to snap them back. */
  const desktopNative = (opts: { snapsBack?: boolean } = {}) => {
    let icons = [
      { name: 'Report.pdf', frame: { x: 1359, y: 43, w: 96, h: 96 } },
      { name: 'Archive', frame: { x: 1359, y: 339, w: 96, h: 96 } },
      { name: 'Report Draft.pdf', frame: { x: 1241, y: 43, w: 96, h: 96 } },
    ];
    const run = jest.fn(async (cmd: any) => {
      if (cmd.action === 'desktop_icons') {
        return { ok: true, action: cmd.action, driver: 'native-helper', icons: icons.map(i => ({ ...i, frame: { ...i.frame } })), summary: 'listed' };
      }
      if (cmd.action === 'drag' && !opts.snapsBack) {
        const centre = (f: any) => ({ x: f.x + f.w / 2, y: f.y + f.h / 2 });
        const moved = icons.find(i => Math.abs(centre(i.frame).x - cmd.x) < 2 && Math.abs(centre(i.frame).y - cmd.y) < 2);
        const onto = icons.find(i => i !== moved && Math.abs(centre(i.frame).x - cmd.toX) < 2 && Math.abs(centre(i.frame).y - cmd.toY) < 2);
        if (moved && onto) icons = icons.filter(i => i !== moved);            // filed into a folder
        else if (moved) moved.frame = { ...moved.frame, x: cmd.toX - 48, y: cmd.toY - 48 };
      }
      return { ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} delivered` };
    });
    return { run, native: { run, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }), frontmostApp: async () => 'Alpha' } as any };
  };

  it('lists desktop items with their on-screen rectangles', async () => {
    const { native } = desktopNative();
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(native);
    const listed = await runtime.run({ action: 'desktop' }, { cwd: '/tmp' });
    expect(listed.ok).toBe(true);
    expect(listed.icons?.map(i => i.name)).toEqual(['Report.pdf', 'Archive', 'Report Draft.pdf']);
    expect(listed.actionResult).toEqual(expect.objectContaining({ delivered: false, observed: 'confirmed' }));
    expect(listed.summary).toMatch(/Report\.pdf/);
  });

  it('treats an unavailable desktop-item surface as a valid empty listing', async () => {
    const run = jest.fn(async (cmd: any) => ({
      ok: false,
      action: cmd.action,
      driver: 'native-helper',
      error: 'desktop-icons: error: no desktop icon surface is present on this system',
      summary: 'desktop icon enumeration unavailable',
    }));
    const native = {
      run,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Alpha',
    } as any;
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(native);

    const listed = await runtime.run({ action: 'desktop' }, { cwd: '/tmp' });

    expect(listed.ok).toBe(true);
    expect(listed.icons).toEqual([]);
    expect(listed.details).toEqual({ desktopSurface: 'unavailable' });
    expect(listed.actionResult).toEqual(expect.objectContaining({ delivered: false, observed: 'confirmed' }));
  });

  it('filters unnamed desktop accessibility containers from the item list', async () => {
    const { native } = desktopNative();
    native.run.mockImplementationOnce(async (cmd: any) => ({
      ok: true,
      action: cmd.action,
      driver: 'native-helper',
      icons: [
        { name: '', frame: { x: 0, y: 0, w: 100, h: 100 } },
        { name: 'Visible.txt', frame: { x: 100, y: 100, w: 96, h: 96 } },
      ],
      summary: 'listed',
    }));
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(native);

    const listed = await runtime.run({ action: 'desktop' }, { cwd: '/tmp' });

    expect(listed.icons?.map(icon => icon.name)).toEqual(['Visible.txt']);
    expect(listed.summary).not.toMatch(/2 item/);
  });

  it('repositions a desktop item and verifies it by re-reading the desktop', async () => {
    const { native } = desktopNative();
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(native);
    const moved = await runtime.run({ action: 'desktop', query: 'Report.pdf', toX: 200, toY: 400 }, { cwd: '/tmp' });
    expect(moved.ok).toBe(true);
    // Dragged from its own centre (1359+48, 43+48) to the requested point.
    const drag = native.run.mock.calls.map(([c]: any) => c).find((c: any) => c.action === 'drag');
    expect(drag).toEqual(expect.objectContaining({ x: 1407, y: 91, toX: 200, toY: 400 }));
    expect(moved.icons?.find(i => i.name === 'Report.pdf')?.frame).toEqual(expect.objectContaining({ x: 152, y: 352 }));
    expect(moved.actionResult?.postcondition?.matched).toBe(true);
  });

  it('files a desktop item into a folder and notices it left the desktop', async () => {
    const { native } = desktopNative();
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(native);
    const filed = await runtime.run({ action: 'desktop', query: 'Report.pdf', toQuery: 'Archive' }, { cwd: '/tmp' });
    expect(filed.ok).toBe(true);
    expect(filed.icons?.map(i => i.name)).not.toContain('Report.pdf');
    expect(filed.summary).toMatch(/no longer on the desktop/);
  });

  it('fails honestly when the desktop snaps the item back', async () => {
    // A desktop using Stacks or Sort By recomputes every position, so a hand-placed item returns to
    // where it started. The drag really was delivered — reporting success would be a lie.
    const { native } = desktopNative({ snapsBack: true });
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(native);
    const moved = await runtime.run({ action: 'desktop', query: 'Report.pdf', toX: 200, toY: 400 }, { cwd: '/tmp' });
    expect(moved.ok).toBe(false);
    expect(moved.error).toMatch(/Stacks|Sort By/);
    expect(moved.actionResult).toEqual(expect.objectContaining({ delivered: true, observed: 'no-change' }));
  });

  it('refuses an ambiguous desktop item name rather than moving the wrong file', () => {
    const icons = [
      { name: 'Report.pdf', frame: { x: 0, y: 0, w: 96, h: 96 } },
      { name: 'Report Draft.pdf', frame: { x: 100, y: 0, w: 96, h: 96 } },
    ];
    // "Report" matches both — picking one silently would move a file the user did not name.
    expect(() => resolveDesktopIcon(icons, 'Report')).toThrow(/matches several/);
    // An exact name still wins outright even though it is a prefix of the other.
    expect(resolveDesktopIcon(icons, 'Report.pdf').name).toBe('Report.pdf');
    // A unique partial is fine.
    expect(resolveDesktopIcon(icons, 'draft').name).toBe('Report Draft.pdf');
    expect(() => resolveDesktopIcon(icons, 'Nothing')).toThrow(/no desktop item named/);
  });

  it('requires a destination when moving a desktop item', async () => {
    const { native } = desktopNative();
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(native);
    const bad = await runtime.run({ action: 'desktop', query: 'Report.pdf' }, { cwd: '/tmp' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/needs a destination/);
  });

  // ---- cross-app drag ---------------------------------------------------------------------------

  /** Two apps at explicit on-screen positions, so a drop point can be reasoned about globally. */
  const dragFixture = (positions: Record<number, { x: number; y: number; width: number; height: number }>) => {
    const native: any = {
      run: jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} delivered` })),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => activeApp,
    };
    const impl = async ({ name, arguments: args }: any) => {
      if (name === 'launch_app') {
        const key = String(args?.name || '').toLowerCase();
        const pid = key === 'beta' ? 84 : 42;
        return result({ name: key === 'beta' ? 'Beta' : 'Alpha', pid, windows: [{ window_id: pid === 84 ? 9 : 7 }] });
      }
      if (name === 'list_apps') {
        return result({ apps: [
          { pid: 42, name: 'Alpha', active: activeApp === 'Alpha' },
          { pid: 84, name: 'Beta', active: activeApp === 'Beta' },
        ] });
      }
      if (name === 'list_windows') {
        const pid = Number(args?.pid || 42);
        return result({ windows: [{ window_id: pid === 84 ? 9 : 7, is_on_screen: true, bounds: positions[pid] }] });
      }
      if (name === 'get_window_state') {
        const pid = Number(args?.pid || 42);
        const box = positions[pid];
        // Driver element frames are GLOBAL screen rectangles, not window-relative ones — the runtime
        // converts them into screenshot pixels on ingestion. Placing them relative to the window
        // origin here is what makes the coordinate assertions below mean anything.
        return result({
          screenshot_file_path: `/tmp/bimax-${pid}.png`, screenshot_width: box.width, screenshot_height: box.height,
          tree_markdown: '', elements: [
            { element_index: 0, role: 'AXWindow', label: pid === 84 ? 'Beta' : 'Alpha', frame: { x: box.x, y: box.y, w: box.width, h: box.height } },
            { element_index: 1, role: 'AXImage', label: 'photo.jpg', frame: { x: box.x + 20, y: box.y + 20, w: 60, h: 60 } },
          ],
        });
      }
      return result({ ok: true });
    };
    return { native, impl };
  };

  /** Side by side: Alpha owns the left half, Beta the right — the arrangement a drop requires. */
  const sideBySide = () => dragFixture({
    42: { x: 0, y: 33, width: 735, height: 864 },
    84: { x: 735, y: 33, width: 735, height: 864 },
  });

  it('drags a file into another app and captures the DESTINATION afterwards', async () => {
    const { native, impl } = sideBySide();
    activeApp = 'Alpha';
    callTool.mockImplementation(impl);
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'beta' }, { cwd: '/tmp' });
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    await runtime.run({ action: 'observe' }, { cwd: '/tmp' });

    const dropped = await runtime.run({ action: 'drag', query: 'photo.jpg', toApp: 'Beta' }, { cwd: '/tmp' });
    expect(dropped.ok).toBe(true);
    const dragCall = native.run.mock.calls.map(([c]: any) => c).find((c: any) => c.action === 'drag');
    // Source: photo.jpg sits at global (20,53) in a 60x60 box inside Alpha's window at (0,33), so
    // its centre is global (50,83) — mapped through the SOURCE window's own frame.
    expect(dragCall).toEqual(expect.objectContaining({ x: 50, y: 83 }));
    // Destination defaults to Beta's window centre: 735 + 735/2 = 1102.5 → 1103, 33 + 432 = 465.
    expect(dragCall.toX).toBe(1103);
    expect(dragCall.toY).toBe(465);
    // Paced delivery — the default fast path never gives the receiving app time to accept.
    expect(dragCall.ms).toBeGreaterThan(0);
    // The result lives in the destination, so that is what gets captured and targeted.
    expect(dropped.app).toBe('Beta');
    expect(dropped.pid).toBe(84);
    expect(runtime.activeSurface()?.pid).toBe(84);
    // Delivery is never acceptance: an app can ignore a type it does not handle, silently.
    expect(dropped.actionResult?.confidence).toBe('unknown');
    expect(dropped.summary).toMatch(/Confirm from the attached frame/);
  });

  it('refuses a drop the source window is covering, and names the arrangement fix', async () => {
    // Both windows overlapping: the source is frontmost, so the drop would land right back on it —
    // the file appears to move and nothing happens.
    const { native, impl } = dragFixture({
      42: { x: 0, y: 33, width: 1400, height: 864 },
      84: { x: 100, y: 100, width: 900, height: 600 },
    });
    activeApp = 'Alpha';
    callTool.mockImplementation(impl);
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'beta' }, { cwd: '/tmp' });
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    await runtime.run({ action: 'observe' }, { cwd: '/tmp' });

    const dropped = await runtime.run({ action: 'drag', query: 'photo.jpg', toApp: 'Beta' }, { cwd: '/tmp' });
    expect(dropped.ok).toBe(false);
    expect(dropped.error).toMatch(/covering the drop point/);
    expect(dropped.error).toMatch(/arrange layout=left/);
    expect(native.run.mock.calls.map(([c]: any) => c).some((c: any) => c.action === 'drag')).toBe(false);
  });

  it('refuses a cross-app drag to an app that is not open', async () => {
    const { native, impl } = sideBySide();
    activeApp = 'Alpha';
    callTool.mockImplementation(impl);
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    const dropped = await runtime.run({ action: 'drag', query: 'photo.jpg', toApp: 'Gamma' }, { cwd: '/tmp' });
    expect(dropped.ok).toBe(false);
    expect(dropped.error).toMatch(/not open in this session/);
  });

  it('rejects a drop point outside the destination window', async () => {
    const { native, impl } = sideBySide();
    activeApp = 'Alpha';
    callTool.mockImplementation(impl);
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'beta' }, { cwd: '/tmp' });
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
    // toX/toY are read in BETA's window, so 5000 is far outside its 735-wide frame.
    const dropped = await runtime.run({ action: 'drag', query: 'photo.jpg', toApp: 'Beta', toX: 5000, toY: 10 }, { cwd: '/tmp' });
    expect(dropped.ok).toBe(false);
    expect(dropped.error).toMatch(/outside/);
  });

  // ---- Space switching ------------------------------------------------------------------------

  it('classifies only the WindowServer-level combos as Space changes', () => {
    expect(classifySpaceCombo('ctrl+right')).toBe('switch');
    expect(classifySpaceCombo('ctrl+left')).toBe('switch');
    expect(classifySpaceCombo('control+3')).toBe('switch');
    expect(classifySpaceCombo('ctrl+up')).toBe('overview');
    expect(classifySpaceCombo('ctrl+down')).toBe('overview');
    // Ordinary app shortcuts that merely contain ctrl must NOT be diverted — treating ctrl+c as a
    // Space change would break every non-macOS-style keybinding an app defines.
    expect(classifySpaceCombo('ctrl+c')).toBeNull();
    expect(classifySpaceCombo('cmd+right')).toBeNull();
    expect(classifySpaceCombo('right')).toBeNull();
    expect(classifySpaceCombo('')).toBeNull();
  });

  it('retargets to the app now in front after switching Spaces', async () => {
    // The bug this exists to prevent: pressing ctrl+right, then screenshotting the OLD window, which
    // is now on a hidden Space and captures empty — indistinguishable from a crashed app.
    activeApp = 'Alpha';
    const native: any = {
      run: jest.fn(async (cmd: any) => {
        // The Space shortcut brings a DIFFERENT app to the front — the whole point of the switch.
        if (cmd.action === 'key' && cmd.combo === 'ctrl+right') { activeApp = 'Beta'; }
        return { ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} delivered` };
      }),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => activeApp,
    };
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'beta' }, { cwd: '/tmp' });
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });

    const switched = await runtime.run({ action: 'key', combo: 'ctrl+right' }, { cwd: '/tmp' });
    expect(switched.ok).toBe(true);
    // Beta was already registered, so it becomes the active target with a real frame of ITS window.
    expect(switched.app).toBe('Beta');
    expect(switched.pid).toBe(84);
    expect(switched.screenshot).toBeTruthy();
    expect(switched.actionResult?.postcondition).toEqual({ query: 'a different Space is now showing', matched: true });
    // …and input now legally goes to Beta.
    const clicked = await runtime.run({ action: 'click', query: 'Beta Action', deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(true);
  });

  it('drops the active target when a Space switch lands on an unmanaged app', async () => {
    // Alpha is frontmost until the Space shortcut fires; only AFTER it does an app this session
    // never opened come to the front. Flipping earlier would fail activation before the switch and
    // never exercise the branch under test.
    let landedElsewhere = false;
    const native: any = {
      run: jest.fn(async (cmd: any) => {
        if (cmd.action === 'key' && cmd.combo === 'ctrl+right') landedElsewhere = true;
        return { ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} delivered` };
      }),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => (landedElsewhere ? 'Some Other App' : 'Alpha'),
    };
    activeApp = 'Alpha';
    const base = alphaBeta();
    callTool.mockImplementation(async (arg: any) => {
      if (arg.name === 'list_apps') {
        return landedElsewhere
          ? result({ apps: [{ pid: 999, name: 'Some Other App', active: true }] })
          : result({ apps: [{ pid: 42, name: 'Alpha', active: true }] });
      }
      return base(arg);
    });
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const switched = await runtime.run({ action: 'key', combo: 'ctrl+right' }, { cwd: '/tmp' });
    expect(switched.ok).toBe(true);
    expect(switched.summary).toMatch(/Some Other App/);
    expect(switched.summary).toMatch(/would capture empty/);
    // No active target, so input is refused until an explicit focus produces a fresh frame…
    const clicked = await runtime.run({ action: 'click', query: 'Alpha Action', deliveryMode: 'background' }, { cwd: '/tmp' });
    expect(clicked.ok).toBe(false);
    // …but the registration survived, so recovering costs a focus rather than a re-launch.
    const launchesBefore = callTool.mock.calls.filter(([a]) => a.name === 'launch_app').length;
    callTool.mockImplementation(alphaBeta());
    const back = await runtime.run({ action: 'focus', app: 'Alpha' }, { cwd: '/tmp' });
    expect(back.ok).toBe(true);
    expect(callTool.mock.calls.filter(([a]) => a.name === 'launch_app')).toHaveLength(launchesBefore);
  });

  it('says the overview is covering the screen instead of capturing a window behind it', async () => {
    const native: any = {
      run: jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} delivered` })),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Alpha',
    };
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const overview = await runtime.run({ action: 'key', combo: 'ctrl+up' }, { cwd: '/tmp' });
    expect(overview.ok).toBe(true);
    expect(overview.summary).toMatch(/overview/);
    expect(overview.summary).toMatch(/escape/);
    // Nothing is capturable under the overlay, so no frame is claimed.
    expect(overview.screenshot).toBeUndefined();
  });

  it('reports honestly when there is no further Space in that direction', async () => {
    const native: any = {
      run: jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} delivered` })),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Alpha', // never changes: already at the last Space
    };
    activeApp = 'Alpha';
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    const switched = await runtime.run({ action: 'key', combo: 'ctrl+right' }, { cwd: '/tmp' });
    expect(switched.ok).toBe(true);
    expect(switched.summary).toMatch(/still frontmost/);
    expect(switched.actionResult?.postcondition?.matched).toBe(false);
    expect(switched.actionResult?.confidence).toBe('unknown');
  });

  it('maps switch_app/activate onto focus rather than a re-launch', async () => {
    callTool.mockImplementation(alphaBeta());
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'alpha' }, { cwd: '/tmp' });
    await runtime.run({ action: 'open', app: 'beta' }, { cwd: '/tmp' });
    const launchesBefore = callTool.mock.calls.filter(([a]) => a.name === 'launch_app').length;
    // These synonyms mean "switch to an app that is already open"; routing them to open re-launched
    // a running app, which is the second-instance/state-loss hazard focus exists to avoid.
    const switched = await runtime.run({ action: 'switch_app', app: 'Alpha' } as any, { cwd: '/tmp' });
    expect(switched.ok).toBe(true);
    expect(switched.action).toBe('focus');
    expect(switched.pid).toBe(42);
    expect(callTool.mock.calls.filter(([a]) => a.name === 'launch_app')).toHaveLength(launchesBefore);
  });

  it('reports a hidden window honestly instead of blaming Screen Recording permission', async () => {
    // A minimized / other-Space window captures empty for reasons unrelated to TCC. The old message
    // asserted a permission problem, so the model told a user who HAD granted it to go enable it.
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'launch_app') return result({ name: 'WhatsApp', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({ screenshot_file_path: '', elements: [] }); // no pixels
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    const opened = await runtime.run({ action: 'open', app: 'WhatsApp' }, { cwd: '/tmp' });
    expect(opened.ok).toBe(false);
    expect(opened.error).toMatch(/minimized, hidden, or on another macOS Space/);
    expect(opened.error).toMatch(/action=open app="WhatsApp"/);
  });

  it('accepts fresh screenshot pixels and maps a visible label to its frame center', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/settings.png', screenshot_width: 700, screenshot_height: 800,
        tree_markdown: 'Storage',
        elements: [
          { element_index: 0, element_token: 'window', role: 'AXWindow', frame: { x: 0, y: 0, w: 700, h: 800 } },
          { element_index: 80, element_token: 'storage-token', role: 'AXButton', label: 'Storage', frame: { x: 10, y: 20, w: 100, h: 40 } },
        ],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'System Settings' });
    await runtime.run({ action: 'observe' });

    const guessed = await runtime.run({ action: 'click', x: 100, y: 100, deliveryMode: 'background' });
    expect(guessed).toEqual(expect.objectContaining({ ok: true, screenshot: '/tmp/settings.png' }));
    const clicked = await runtime.run({ action: 'click', query: 'Storage', deliveryMode: 'background' });
    expect(clicked).toEqual(expect.objectContaining({ ok: true, summary: expect.stringContaining('Storage') }));
    const calls = callTool.mock.calls.filter(([arg]) => arg.name === 'click').map(([arg]) => arg.arguments);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.objectContaining({ pid: 42, window_id: 7, x: 100, y: 100 }));
    expect(calls[1]).toEqual(expect.objectContaining({ pid: 42, window_id: 7, element_token: 'storage-token' }));
  });

  it('maps a captured label frame into model-visible screenshot pixels', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 100, y: 50, width: 350, height: 400 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/settings.png', screenshot_width: 700, screenshot_height: 800,
        tree_markdown: 'General',
        elements: [
          { element_index: 0, element_token: 'window', role: 'AXWindow', frame: { x: 100, y: 50, w: 350, h: 400 } },
          { element_index: 10, element_token: 'general', role: 'AXStaticText', label: 'General', frame: { x: 150, y: 100, w: 100, h: 40 } },
        ],
      });
      if (name === 'click') {
        return result({ effect: 'delivered' });
      }
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    const opened = await runtime.run({ action: 'open', app: 'System Settings' });
    expect(opened.coordinateSpace).toEqual({
      xY: 'screenshot_pixels', elementFrames: 'screenshot_pixels', normalized: '0-1000',
    });
    expect(opened.completionGuidance).toMatch(/categorical.*not a percentage/i);
    const observed = await runtime.run({ action: 'observe' });
    expect(observed.coordinateSpace).toEqual({
      xY: 'screenshot_pixels', elementFrames: 'screenshot_pixels', normalized: '0-1000',
    });
    expect(observed.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ element_index: 10, frame: { x: 100, y: 100, w: 200, h: 80 } }),
    ]));
    const clicked = await runtime.run({ action: 'click', query: 'General', deliveryMode: 'background' });
    expect(clicked.summary).toContain('accessibility element token');
    const clicks = callTool.mock.calls.filter(([arg]) => arg.name === 'click').map(([arg]) => arg.arguments);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toEqual(expect.objectContaining({ element_token: 'general', pid: 42, window_id: 7 }));
  });

  it('keeps enough post-action elements to reach controls beyond a long sidebar', async () => {
    const elements = [
      { element_index: 0, element_token: 'window', role: 'AXWindow', frame: { x: 0, y: 0, w: 500, h: 700 } },
      ...Array.from({ length: 99 }, (_, index) => ({
        element_index: index + 1, element_token: `element-${index + 1}`,
        role: index === 78 ? 'AXButton' : 'AXStaticText',
        label: index === 78 ? 'Details' : `Sidebar item ${index + 1}`,
        frame: { x: 10, y: 10 + index, w: 100, h: 20 },
      })),
    ];
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/settings.png', screenshot_width: 500, screenshot_height: 700,
        tree_markdown: '', elements,
      });
      return result({ ok: true });
    });
    const opened = await new BimaxComputerRuntime(simulatedNative()).run({ action: 'open', app: 'System Settings' });
    expect(opened.elements).toHaveLength(80);
    expect(opened.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ element_index: 79, label: 'Details' }),
    ]));
  });

  it('disambiguates repeated detail buttons with their nearby row labels', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/settings.png', screenshot_width: 700, screenshot_height: 800,
        tree_markdown: '',
        elements: [
          { element_index: 0, element_token: 'window', role: 'AXWindow', frame: { x: 0, y: 0, w: 700, h: 800 } },
          { element_index: 40, role: 'AXStaticText', label: 'Battery Health', frame: { x: 250, y: 100, w: 130, h: 30 } },
          { element_index: 41, role: 'AXStaticText', label: 'Normal', frame: { x: 500, y: 100, w: 60, h: 30 } },
          { element_index: 69, element_token: 'battery-detail', role: 'AXButton', label: 'Show Detail', frame: { x: 620, y: 100, w: 30, h: 30 } },
          { element_index: 50, role: 'AXStaticText', label: 'Charging', frame: { x: 250, y: 160, w: 100, h: 30 } },
          { element_index: 70, element_token: 'charging-detail', role: 'AXButton', label: 'Show Detail', frame: { x: 620, y: 160, w: 30, h: 30 } },
        ],
      });
      if (name === 'click') return result({ effect: 'delivered' });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    const opened = await runtime.run({ action: 'open', app: 'System Settings' });
    expect(opened.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        element_index: 69,
        label: 'Show Detail — Battery Health · Normal',
        context_label: 'Battery Health · Normal',
      }),
      expect.objectContaining({ element_index: 70, label: 'Show Detail — Charging' }),
    ]));

    await runtime.run({ action: 'click', query: 'Battery Health · Normal', deliveryMode: 'background' });
    const click = callTool.mock.calls.find(([arg]) => arg.name === 'click')?.[0];
    expect(click.arguments).toEqual(expect.objectContaining({ element_token: 'battery-detail', pid: 42, window_id: 7 }));
  });

  it('refuses semantic clicks on structural accessibility containers', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/settings.png', screenshot_width: 700, screenshot_height: 800,
        tree_markdown: '',
        elements: [
          { element_index: 0, element_token: 'window', role: 'AXWindow', frame: { x: 0, y: 0, w: 700, h: 800 } },
          { element_index: 1, element_token: 'sidebar', role: 'AXOutline', label: 'Sidebar', frame: { x: 0, y: 50, w: 220, h: 700 } },
        ],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'System Settings' });
    const clicked = await runtime.run({ action: 'click', elementIndex: 1 });
    expect(clicked.ok).toBe(false);
    expect(clicked.error).toMatch(/structural container/i);
    expect(callTool.mock.calls.some(([arg]) => arg.name === 'click')).toBe(false);
  });

  it('labels an unlabeled slider from its row and refuses approximate clicks inside it', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/settings-slider.png', screenshot_width: 700, screenshot_height: 800,
        tree_markdown: '',
        elements: [
          { element_index: 0, element_token: 'window', role: 'AXWindow', frame: { x: 0, y: 0, w: 700, h: 800 } },
          { element_index: 20, role: 'AXStaticText', label: 'Alert volume', frame: { x: 250, y: 150, w: 120, h: 30 } },
          { element_index: 21, role: 'AXButton', label: 'Decrease volume', frame: { x: 390, y: 150, w: 30, h: 30 } },
          { element_index: 22, element_token: 'alert-slider', role: 'AXSlider', frame: { x: 430, y: 150, w: 200, h: 30 } },
          { element_index: 23, role: 'AXButton', label: 'Increase volume', frame: { x: 640, y: 150, w: 30, h: 30 } },
          { element_index: 30, element_token: 'output-slider', role: 'AXSlider', label: 'Output volume', frame: { x: 430, y: 500, w: 200, h: 30 } },
        ],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    const opened = await runtime.run({ action: 'open', app: 'System Settings' });
    expect(opened.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        element_index: 22,
        label: 'Slider — Alert volume',
        context_label: 'Alert volume',
      }),
    ]));

    const semanticClick = await runtime.run({ action: 'click', query: 'Alert volume' });
    expect(semanticClick.ok).toBe(false);
    expect(semanticClick.error).toMatch(/slider.*set_value/i);

    const pixelClick = await runtime.run({ action: 'click', x: 500, y: 165 });
    expect(pixelClick.ok).toBe(false);
    expect(pixelClick.error).toMatch(/inside "Slider — Alert volume".*set_value/i);
  });

  it('sets slider endpoints by fresh query and returns an exact semantic value result', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/settings-slider.png', screenshot_width: 700, screenshot_height: 800,
        tree_markdown: '',
        elements: [
          { element_index: 0, element_token: 'window', role: 'AXWindow', frame: { x: 0, y: 0, w: 700, h: 800 } },
          { element_index: 20, role: 'AXStaticText', label: 'Alert volume', frame: { x: 250, y: 150, w: 120, h: 30 } },
          { element_index: 22, element_token: 'alert-slider', role: 'AXSlider', frame: { x: 430, y: 150, w: 200, h: 30 } },
          { element_index: 30, element_token: 'output-slider', role: 'AXSlider', label: 'Output volume', frame: { x: 430, y: 500, w: 200, h: 30 } },
        ],
      });
      if (name === 'set_value') return result({ effect: 'delivered' });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'System Settings' });
    const set = await runtime.run({ action: 'set_value', query: 'Alert volume', value: 'full' });

    const nativeSet = callTool.mock.calls.find(([arg]) => arg.name === 'set_value')?.[0];
    expect(nativeSet.arguments).toEqual(expect.objectContaining({
      pid: 42, window_id: 7, element_token: 'alert-slider', value: '1',
    }));
    expect(set).toEqual(expect.objectContaining({
      ok: true,
      summary: 'Slider — Alert volume set to exact maximum endpoint; fresh screen attached',
      details: expect.objectContaining({
        requestedValue: 'full', appliedValue: '1', endpoint: 'maximum',
      }),
      actionResult: expect.objectContaining({
        delivered: true,
        confidence: 'proven',
        postcondition: {
          query: 'Slider — Alert volume native maximum endpoint (1)',
          matched: true,
        },
      }),
    }));
  });

  it('selects an AppKit pop-up option synchronously when direct AX set_value has no children', async () => {
    let menuOpen = false;
    let selected = false;
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session' || name === 'bring_to_front' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Fixture', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({
        windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 400 } }],
      });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/popup-fallback.png', screenshot_width: 500, screenshot_height: 400,
        tree_markdown: '',
        elements: [
          { element_index: 0, element_token: 'window', role: 'AXWindow', label: 'Fixture', frame: { x: 0, y: 0, w: 500, h: 400 } },
          { element_index: 8, element_token: 'popup', role: 'AXPopUpButton',
            label: selected ? 'Third' : 'First', value: selected ? 'Third' : 'First',
            frame: { x: 100, y: 100, w: 200, h: 30 } },
          ...(menuOpen ? [
            { element_index: 10, element_token: 'first', role: 'AXMenuItem', label: 'First', frame: { x: 100, y: 135, w: 200, h: 30 } },
            { element_index: 11, element_token: 'second', role: 'AXMenuItem', label: 'Second', frame: { x: 100, y: 165, w: 200, h: 30 } },
            { element_index: 12, element_token: 'third', role: 'AXMenuItem', label: 'Third', frame: { x: 100, y: 195, w: 200, h: 30 } },
          ] : []),
        ],
      });
      if (name === 'set_value') throw new Error('AXPopUpButton [8] has no AX children to match value');
      return result({ ok: true });
    });
    const nativeRun = jest.fn(async (cmd: any) => {
      const base = { ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action };
      if (cmd.action === 'window_at') {
        const item = Number(cmd.y) >= 180;
        return { ...base, windowAt: {
          owner_pid: 42, owner_name: 'Fixture', window_id: 7,
          top_owner_name: 'Fixture', top_window_id: 7, layer: 0,
          bounds: { x: 0, y: 0, w: 500, h: 400 },
          element_chain: [item
            ? { pid: 42, role: 'AXMenuItem', title: 'Third', enabled: true, frame: { x: 100, y: 195, w: 200, h: 30 } }
            : { pid: 42, role: 'AXPopUpButton', title: selected ? 'Third' : 'First', enabled: true, frame: { x: 100, y: 100, w: 200, h: 30 } }],
        } };
      }
      if (cmd.action === 'click') {
        if (Number(cmd.y) >= 180) { selected = true; menuOpen = false; }
        else menuOpen = true;
        return { ...base, app: 'Fixture', x: cmd.x, y: cmd.y };
      }
      if (cmd.action === 'cursor') return { ...base, x: 200, y: 115 };
      return base;
    });
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Fixture',
    };
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'Fixture', deliveryMode: 'foreground' });
    const set = await runtime.run({ action: 'set_value', query: 'First', value: 'Third', deliveryMode: 'foreground' });

    expect(set).toEqual(expect.objectContaining({
      ok: true,
      summary: 'selected exact pop-up option "Third" through its fresh native menu; fresh screen attached',
      details: expect.objectContaining({
        fallback: 'foreground-popup-menu', requestedValue: 'Third', appliedValue: 'Third',
      }),
      actionResult: expect.objectContaining({
        confidence: 'proven',
        postcondition: expect.objectContaining({ matched: true }),
      }),
    }));
    expect(nativeRun.mock.calls.filter(([cmd]) => cmd.action === 'click')).toHaveLength(2);
    expect(selected).toBe(true);
  });

  it('reports embedded host attribution as ready when bundle identity is the only failed check', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'health_report') return result({
        overall: 'degraded',
        checks: [
          { name: 'bundle_identity', status: 'fail', message: 'Process has no CFBundleIdentifier.' },
          { name: 'tcc_accessibility', status: 'pass' },
          { name: 'tcc_screen_recording', status: 'pass' },
          { name: 'ax_capability', status: 'pass' },
          { name: 'screen_capture_capability', status: 'pass' },
        ],
      });
      return result({ ok: true });
    });
    const status = await new BimaxComputerRuntime(simulatedNative()).run({ action: 'status' });
    expect(status).toEqual(expect.objectContaining({
      ok: true, accessibility: true, screenRecording: true,
      details: expect.objectContaining({ overall: 'ready', attribution: 'embedded_host' }),
    }));
    // The property under test is that an embedded-identity failure alone is NOT degraded — not the
    // exact sentence. With no target acquired there is no session-scoped call to probe, and status
    // must say so rather than let the driver's own "session_active" claim pass as evidence.
    expect(status.summary).toMatch(/^Bimax Computer Use ready/);
    expect((status.details as any).sessionProbe).toEqual({ probed: false, reachable: null, note: expect.any(String) });
  });

  it('reports degraded when a session-scoped call is rejected, however healthy the permission report', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'health_report') return result({
        overall: 'ready',
        checks: [
          { name: 'session_active', status: 'pass', message: 'MCP session is active.' },
          { name: 'tcc_accessibility', status: 'pass' },
          { name: 'tcc_screen_recording', status: 'pass' },
        ],
      });
      if (name === 'launch_app') return result({ name: 'TextEdit', pid: 42, windows: [{ window_id: 7, title: 'TextEdit' }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      // The exact shape observed live: the driver retires the session and rejects every
      // session-scoped call while still self-reporting "session_active: pass".
      if (name === 'get_window_state') {
        return { isError: true, content: [{ type: 'text', text: "session 'bimax-1-abcd' has ended; tool call 'get_window_state' was rejected." }] };
      }
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'TextEdit' });
    const status = await runtime.run({ action: 'status' });
    expect(status.ok).toBe(false);
    expect((status.details as any).overall).toBe('degraded');
    expect((status.details as any).sessionProbe.reachable).toBe(false);
    expect(status.summary).toContain('session unreachable');
  });

  it('revives a retired session in place and retries the call instead of wedging for the process lifetime', async () => {
    // Observed live: the driver retires the session, and because that arrives as an app-level
    // isError RESULT (not a rejected promise) it never reached the dead-connection branch, so the
    // runtime reused a client whose session was gone and EVERY stateful call failed until restart.
    let rejectedOnce = false;
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'launch_app') return result({ name: 'TextEdit', pid: 42, windows: [{ window_id: 7, title: 'TextEdit' }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') {
        if (!rejectedOnce) {
          rejectedOnce = true;
          return { isError: true, content: [{ type: 'text', text: "session 'bimax-1-abcd' has ended; tool call 'get_window_state' was rejected. Call start_session with this id to revive it." }] };
        }
        return result({
          screenshot_file_path: '/tmp/bimax-window.png', screenshot_width: 500, screenshot_height: 700,
          tree_markdown: '[1] AXTextArea label="First Text View"',
          elements: [{ element_index: 1, element_token: 's0002:1', role: 'AXTextArea', label: 'First Text View' }],
        }, 'Cua Driver observation');
      }
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'TextEdit' });
    const observed = await runtime.run({ action: 'observe' });

    expect(rejectedOnce).toBe(true);
    // The retried call carries the real observation through, so the caller never sees the retirement.
    expect(observed.ok).toBe(true);
    expect(observed.elements).toEqual([expect.objectContaining({ label: 'First Text View' })]);
    // Revived on the SAME connection — the repair the driver's own message asks for — rather than
    // paying a fresh cold start: one handshake plus exactly one revive, and no re-open of the client.
    expect(callTool.mock.calls.filter(([a]: any) => a.name === 'start_session')).toHaveLength(2);
    expect(openClient as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('reports a launch it delivered even when the first frame cannot be captured', async () => {
    // Observed live: `open` returned ok:false / delivered:false while TextEdit was starting,
    // because the post-launch observation failed. delivered:false for a side effect that DID
    // happen is the dangerous direction — the caller retries and launches the app twice.
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'launch_app') return result({ name: 'TextEdit', pid: 42, windows: [{ window_id: 7, title: 'TextEdit' }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return { isError: true, content: [{ type: 'text', text: 'the sidecar returned no usable pixels' }] };
      return result({ ok: true });
    });
    const opened = await new BimaxComputerRuntime(simulatedNative()).run({ action: 'open', app: 'TextEdit' });
    expect(opened.ok).toBe(false);
    expect(opened.actionResult).toEqual(expect.objectContaining({ delivered: true, observed: 'unverified' }));
    expect(opened.pid).toBe(42);
    expect(String(opened.error)).toMatch(/LAUNCHED as pid 42/);
    expect(String(opened.error)).toMatch(/Do NOT open it again/);
  });

  it('hides window-server furniture that can never be a target', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'list_windows') return result({
        windows: [
          { app_name: 'TextEdit', window_id: 7, title: 'Untitled', is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } },
          // Untitled full-width 33px menu-bar proxies and 64x64 service surfaces: 50 of these per
          // call, none of them addressable.
          { app_name: 'Finder', window_id: 8, title: '', is_on_screen: false, bounds: { x: 0, y: 0, width: 1470, height: 33 } },
          { app_name: 'CursorUIViewService', window_id: 9, title: '', is_on_screen: false, bounds: { x: 0, y: 456, width: 64, height: 64 } },
          // The driver's OWN capture surface, which outranks the app it is driving.
          { app_name: 'bimax-computer-use-a0c5e34a3594', window_id: 10, title: '', is_on_screen: true, bounds: { x: 0, y: 0, width: 1470, height: 956 } },
          // A titled window that is off-screen (another Space) must still be findable.
          { app_name: 'Notes', window_id: 11, title: 'Ideas', is_on_screen: false, bounds: { x: 0, y: 0, width: 800, height: 600 } },
        ],
      });
      return result({ ok: true });
    });
    const listed = await new BimaxComputerRuntime(simulatedNative()).run({ action: 'windows' });
    const ids = ((listed.details as any).windows as any[]).map(w => w.window_id);
    expect(ids).toEqual([7, 11]);
    expect((listed.details as any).suppressed).toBe(3);
  });

  it('narrows the installed-app list instead of returning the whole machine', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'list_apps') return result({
        apps: [
          // The driver fills `windows: []` for every app, running or not — dead weight in a payload
          // that was 22KB for 106 apps.
          { name: 'Safari', bundle_id: 'com.apple.Safari', running: false, pid: 0, windows: [], launch_path: '/Applications/Safari.app', last_used: '2026-06-24T23:58:17Z' },
          { name: 'TextEdit', bundle_id: 'com.apple.TextEdit', running: true, pid: 42, active: true, windows: [], launch_path: '/System/Applications/TextEdit.app' },
          { name: '‎WhatsApp', bundle_id: 'net.whatsapp.WhatsApp', running: false, pid: 0, windows: [] },
        ],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    const all = await runtime.run({ action: 'apps' });
    const apps = (all.details as any).apps as any[];
    // Running first, no empty `windows` array, and the bidi mark stripped from the name so the
    // string a caller reads back into `open` is the string it saw.
    expect(apps[0]).toEqual({ name: 'TextEdit', bundle_id: 'com.apple.TextEdit', running: true, pid: 42, active: true });
    expect(apps.some(a => 'windows' in a)).toBe(false);
    expect(apps.map(a => a.name)).toContain('WhatsApp');

    const filtered = await runtime.run({ action: 'apps', query: 'safari' });
    expect(((filtered.details as any).apps as any[]).map(a => a.name)).toEqual(['Safari']);
    expect((filtered.details as any).total).toBe(3);
  });

  it('makes screenshot the picture and observe the element list, without weakening targeting', async () => {
    // They were the same call under two names: identical payload, identical summary, ~21KB each.
    // The split is in what they RETURN — the capture and the element map are produced identically,
    // and the map is cached on the runtime, so a semantic click after a screenshot still resolves.
    const nativeRun = jest.fn(async (cmd: any) => ({
      ok: true, action: cmd.action, driver: 'native-helper', app: 'Calculator',
      x: cmd.x, y: cmd.y, summary: 'physical click delivered',
    }));
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Calculator',
    };
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'Calculator', deliveryMode: 'foreground' });

    const observed = await runtime.run({ action: 'observe' });
    expect(Array.isArray(observed.elements)).toBe(true);
    expect(observed.tree).toBeDefined();

    const shot = await runtime.run({ action: 'screenshot' });
    expect(shot.ok).toBe(true);
    expect(shot.screenshot).toBe('/tmp/bimax-window.png');   // still the picture
    expect(shot.frameId).toBeTruthy();                        // still a frame you can act from
    expect(shot.elements).toBeUndefined();                    // but not the element echo
    expect(shot.tree).toBeUndefined();
    expect(shot.elementCount).toBeGreaterThan(0);
    expect(JSON.stringify(shot).length).toBeLessThan(JSON.stringify(observed).length);

    // The whole point: targeting still works from the map the screenshot resolved.
    const clicked = await runtime.run({ action: 'click', query: 'Result', deliveryMode: 'foreground' });
    expect(clicked.ok).toBe(true);
  });

  it('does not report a recording stopped when none was running', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'stop_recording') return result({ enabled: false });
      return result({ ok: true });
    });
    const stopped = await new BimaxComputerRuntime(simulatedNative()).run({ action: 'record_stop' });
    expect(stopped.ok).toBe(false);
    expect(String(stopped.error)).toMatch(/no recording was running/);
  });

  it('physically clicks a fresh elementIndex at its screenshot center', async () => {
    const nativeRun = jest.fn(async (cmd: any) => ({
      ok: true, action: cmd.action, driver: 'native-helper', app: 'System Settings',
      x: cmd.x, y: cmd.y, summary: 'physical click delivered',
    }));
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'System Settings',
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 100, y: 50, width: 350, height: 400 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/settings-element.png', screenshot_width: 700, screenshot_height: 800,
        elements: [
          { element_index: 0, element_token: 'window', role: 'AXWindow', frame: { x: 100, y: 50, w: 350, h: 400 } },
          { element_index: 20, element_token: 'battery', role: 'AXStaticText', label: 'Battery', frame: { x: 150, y: 100, w: 100, h: 40 } },
        ],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'System Settings' });
    await runtime.run({ action: 'observe' });
    const clicked = await runtime.run({ action: 'click', elementIndex: 20 });

    expect(clicked.ok).toBe(true);
    expect(clicked.summary).toContain('physical mouse click on "Battery"');
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({
      action: 'click', x: 200, y: 120, normalized: false, app: 'System Settings',
    }), undefined);
    expect(callTool.mock.calls.filter(([arg]) => arg.name === 'click')).toHaveLength(0);
  });

  it('forwards normalized screenshot coordinates in the driver PNG pixel space', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 100, y: 50, width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/settings.png', screenshot_width: 1400, screenshot_height: 1600,
        tree_markdown: 'Battery Health',
        elements: [
          { element_index: 0, element_token: 'window', role: 'AXWindow', frame: { x: 100, y: 50, w: 700, h: 800 } },
        ],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'System Settings' });
    await runtime.run({ action: 'observe' });
    await runtime.run({ action: 'click', x: 750, y: 250, normalized: true, deliveryMode: 'background' });

    const click = callTool.mock.calls.find(([arg]) => arg.name === 'click')?.[0];
    expect(click.arguments).toEqual(expect.objectContaining({ x: 1049, y: 400, pid: 42, window_id: 7 }));
  });

  it('uses the real global cursor for foreground screenshot clicks', async () => {
    const nativeRun = jest.fn(async (cmd: any) => ({
      ok: true, action: cmd.action, driver: 'native-helper', summary: 'clicked',
    }));
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'System Settings',
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 100, y: 50, width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/settings.png', screenshot_width: 1400, screenshot_height: 1600,
        tree_markdown: 'Battery Health',
        elements: [
          { element_index: 0, element_token: 'window', role: 'AXWindow', frame: { x: 100, y: 50, w: 700, h: 800 } },
        ],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'System Settings' });
    await runtime.run({ action: 'observe' });
    const clicked = await runtime.run({
      action: 'click', x: 750, y: 250, normalized: true, deliveryMode: 'foreground', modifier: ['cmd'],
    });

    expect(clicked.summary).toContain('physical mouse click');
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({
      action: 'click', x: 625, y: 250, normalized: false, app: 'System Settings',
      modifier: ['cmd'],
    }), undefined);
    expect(callTool.mock.calls.filter(([arg]) => arg.name === 'click')).toHaveLength(0);
  });

  it('maps screenshot pixels through the LIVE post-activation window bounds', async () => {
    const nativeRun = jest.fn(async (cmd: any) => ({
      ok: true, action: cmd.action, driver: 'native-helper', app: 'System Settings',
      x: cmd.x, y: cmd.y, summary: 'physical click delivered',
    }));
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'System Settings',
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_apps') return result({ apps: [{ name: 'System Settings', active: true }] });
      if (name === 'list_windows') return result({
        windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 900, y: 300, width: 800, height: 600 } }],
      });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/settings-live-frame.png', screenshot_width: 1000, screenshot_height: 1000,
        elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 100, y: 100, w: 500, h: 500 } }],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'System Settings' });
    await runtime.run({ action: 'observe' });
    const clicked = await runtime.run({ action: 'click', x: 500, y: 500 });

    expect(clicked.ok).toBe(true);
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({
      action: 'click', x: 1300, y: 600, normalized: false,
    }), undefined);
    expect(clicked.details).toEqual(expect.objectContaining({
      inputVerified: true,
      screenshotPoint: { x: 500, y: 500 },
      requestedGlobalPoint: { x: 1300, y: 600 },
      landedGlobalPoint: { x: 1300, y: 600 },
    }));
  });

  it('does not claim success when the physical cursor misses the requested point', async () => {
    const native: any = {
      run: jest.fn(async (cmd: any) => ({
        ok: true, action: cmd.action, driver: 'native-helper', app: 'System Settings',
        x: Number(cmd.x) + 25, y: cmd.y, summary: 'cursor moved elsewhere',
      })),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'System Settings',
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_apps') return result({ apps: [{ name: 'System Settings', active: true }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, bounds: { x: 100, y: 50, width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/settings-miss.png', screenshot_width: 1400, screenshot_height: 1600,
        elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 100, y: 50, w: 700, h: 800 } }],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'System Settings' });
    await runtime.run({ action: 'observe' });
    const clicked = await runtime.run({ action: 'click', x: 700, y: 800 });
    expect(clicked.ok).toBe(false);
    expect(clicked.error).toMatch(/did not land/);
  });

  it('uses the same real cursor for foreground drag and scroll', async () => {
    const nativeRun = jest.fn(async (cmd: any) => ({
      ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} done`,
    }));
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'TextEdit',
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'TextEdit', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 100, y: 50, width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/textedit.png', screenshot_width: 1400, screenshot_height: 1600,
        tree_markdown: 'TextEdit',
        elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 100, y: 50, w: 700, h: 800 } }],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'TextEdit' });
    await runtime.run({ action: 'observe' });
    const dragged = await runtime.run({
      action: 'drag', x: 100, y: 200, toX: 800, toY: 200, normalized: true, deliveryMode: 'foreground',
    });
    const scrolled = await runtime.run({
      action: 'scroll', x: 500, y: 500, dy: 240, normalized: true, deliveryMode: 'foreground',
    });

    expect(dragged.summary).toContain('visible native cursor drag');
    expect(scrolled.summary).toContain('visible native cursor scrolled');
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({
      action: 'drag', x: 170, y: 210, toX: 660, toY: 210,
    }), undefined);
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({
      action: 'scroll', x: 450, y: 450, dy: 240,
    }), undefined);
    expect(callTool.mock.calls.some(([arg]) => arg.name === 'drag' || arg.name === 'scroll')).toBe(false);
    // The drag ran through the explicit state machine and recorded every phase, ending verified.
    expect((dragged.details as any).dragTrace?.map((e: any) => e.phase)).toEqual([
      'idle', 'source-located', 'source-verified', 'mouse-down', 'dragging', 'dragging',
      'destination-located', 'destination-verified', 'mouse-up', 'verified',
    ]);
  });

  it('grounds both drag ends in semantic element handles from the newest observation', async () => {
    const nativeRun = jest.fn(async (cmd: any) => ({
      ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} done`,
    }));
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Finder',
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Finder', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 100, y: 50, width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/finder.png', screenshot_width: 1400, screenshot_height: 1600,
        tree_markdown: 'Finder',
        elements: [
          { element_index: 1, element_token: 'shot-1', role: 'AXImage', label: 'Screenshot 1.png', frame: { x: 200, y: 250, w: 100, h: 100 } },
          { element_index: 2, element_token: 'trash-row', role: 'AXRow', label: 'Trash', frame: { x: 150, y: 650, w: 200, h: 50 } },
        ],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'Finder' });
    await runtime.run({ action: 'observe' });

    const dragged = await runtime.run({
      action: 'drag', query: 'Screenshot 1.png', toQuery: 'Trash', deliveryMode: 'foreground',
    });
    expect(dragged.ok).toBe(true);
    expect(dragged.summary).toContain('visible native cursor drag');
    // Element centers: source (250,300) global, destination (250,675) global.
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({
      action: 'drag', x: 250, y: 300, toX: 250, toY: 675,
    }), undefined);

    const byToken = await runtime.run({
      action: 'drag', elementToken: 'shot-1', toElementToken: 'trash-row', deliveryMode: 'foreground',
    });
    expect(byToken.ok).toBe(true);
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({
      action: 'drag', x: 250, y: 300, toX: 250, toY: 675,
    }), undefined);
  });

  it('rejects a drag missing either end with an error that names the semantic alternatives', async () => {
    const native: any = {
      run: jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: 'done' })),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Finder',
    };
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'Calculator' });

    const noSource = await runtime.run({ action: 'drag', toX: 10, toY: 10 });
    expect(noSource.ok).toBe(false);
    expect(noSource.error).toMatch(/drag needs a source: query\/elementToken\/elementIndex/);

    const noDest = await runtime.run({ action: 'drag', x: 10, y: 10 });
    expect(noDest.ok).toBe(false);
    expect(noDest.error).toMatch(/drag needs a destination: toQuery\/toElementToken\/toElementIndex/);
  });

  it('delivers fine-grained pointer primitives with the visible cursor (hover/hold/mouse_down/mouse_up)', async () => {
    const nativeRun = jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} done` }));
    const native: any = { run: nativeRun, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }), frontmostApp: async () => 'TextEdit' };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'TextEdit', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/te.png', screenshot_width: 1400, screenshot_height: 1600,
        elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 100, y: 50, w: 700, h: 800 } }],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'TextEdit', deliveryMode: 'foreground' });
    await runtime.run({ action: 'observe' });
    await runtime.run({ action: 'hover', x: 700, y: 800, deliveryMode: 'foreground' });
    await runtime.run({ action: 'hold', x: 700, y: 800, ms: 500, deliveryMode: 'foreground' });
    const down = await runtime.run({ action: 'mouse_down', x: 700, y: 800, deliveryMode: 'foreground' });
    await runtime.run({ action: 'mouse_up', x: 700, y: 800, deliveryMode: 'foreground' });
    // screenshot pixel 700,800 in a 1400×1600 image of window {100,50,700,800} → global 450,450.
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({ action: 'hover', x: 450, y: 450 }), undefined);
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({ action: 'hold', x: 450, y: 450, ms: 500 }), undefined);
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({ action: 'mouse_down', x: 450, y: 450 }), undefined);
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({ action: 'mouse_up', x: 450, y: 450 }), undefined);
    expect(down.summary).toMatch(/button held/i); // a bare mouse_down warns the button is still down
    expect(runtime.lastMechanism()).toBe('physical-foreground');
  });

  it('posts an emergency mouse-up when mouse_down fails after it may have reached the OS', async () => {
    const nativeRun = jest.fn(async (cmd: any) => ({
      ok: cmd.action !== 'mouse_down', action: cmd.action, driver: 'native-helper',
      error: cmd.action === 'mouse_down' ? 'helper timed out after posting' : undefined,
      summary: `${cmd.action} ${cmd.action === 'mouse_down' ? 'failed' : 'done'}`,
    }));
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'TextEdit',
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'launch_app') return result({ name: 'TextEdit', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 100, y: 50, width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/te.png', screenshot_width: 1400, screenshot_height: 1600,
        elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 100, y: 50, w: 700, h: 800 } }],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'TextEdit', deliveryMode: 'foreground' });
    const down = await runtime.run({ action: 'mouse_down', x: 700, y: 800, deliveryMode: 'foreground' });
    expect(down.ok).toBe(false);
    const pointerCalls = nativeRun.mock.calls.map(([cmd]: any) => cmd.action).filter((action: string) => action === 'mouse_down' || action === 'mouse_up');
    expect(pointerCalls).toEqual(['mouse_down', 'mouse_up']);
    await expect(runtime.releaseHeldInput('test cleanup')).resolves.toEqual({ released: 0, errors: [] });
  });

  it('resolves a human app name when launch_app returns only a bundle id (no "opened ?")', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ pid: 81453, windows: [{ window_id: 9 }] }); // no name
      if (name === 'list_apps') return result({ apps: [{ pid: 81453, name: 'WhatsApp', active: true }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 9, is_on_screen: true, bounds: { width: 800, height: 600 } }] });
      if (name === 'get_window_state') return result({ screenshot_file_path: '/tmp/wa.png', screenshot_width: 800, screenshot_height: 600, elements: [] });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    const opened = await runtime.run({ action: 'open', bundleId: 'net.whatsapp.WhatsApp', deliveryMode: 'foreground' });
    expect(opened.app).toBe('WhatsApp');
    expect(opened.summary).not.toContain('opened ?');
    expect(opened.summary).toContain('WhatsApp');
  });

  it('retries by human app name when the model supplies a stale bundle id', async () => {
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app' && args?.bundle_id === 'com.apple.iChat') {
        return {
          isError: true,
          structuredContent: {},
          content: [{ type: 'text', text: "No installed macOS app found for bundle_id 'com.apple.iChat'." }],
        };
      }
      if (name === 'launch_app' && args?.name === 'Messages') {
        return result({ name: 'Messages', pid: 12412, windows: [{ window_id: 1383 }] });
      }
      if (name === 'list_windows') return result({ windows: [{
        window_id: 1383, is_on_screen: true, bounds: { x: 0, y: 0, width: 900, height: 700 },
      }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/messages.png', screenshot_width: 900, screenshot_height: 700,
        elements: [],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());

    const opened = await runtime.run({
      action: 'open', app: 'Messages', bundleId: 'com.apple.iChat', deliveryMode: 'background',
    });

    expect(opened).toEqual(expect.objectContaining({ ok: true, app: 'Messages', pid: 12412, windowId: 1383 }));
    const launches = callTool.mock.calls
      .map(([call]) => call)
      .filter((call: any) => call.name === 'launch_app');
    expect(launches).toEqual([
      { name: 'launch_app', arguments: { bundle_id: 'com.apple.iChat' } },
      { name: 'launch_app', arguments: { name: 'Messages' } },
    ]);
  });

  /**
   * Measured 2026-08-14: `{"action":"open","app":"com.apple.Messages"}` cost a whole turn on
   * "No installed macOS app found for name 'com.apple.Messages'". Two separate mistakes had to line
   * up — the identifier was in the `app` field, AND it was the wrong identifier (Messages is really
   * com.apple.MobileSMS) — so neither the name lookup nor an id lookup can succeed. The display
   * name is sitting in the last component the whole time.
   */
  it('recovers when a bundle id arrives in the app field, even a wrong one', async () => {
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app' && args?.bundle_id === 'com.apple.Messages') {
        return {
          isError: true,
          structuredContent: {},
          content: [{ type: 'text', text: "No installed macOS app found for bundle_id 'com.apple.Messages'." }],
        };
      }
      if (name === 'launch_app' && args?.name === 'Messages') {
        return result({ name: 'Messages', pid: 91942, windows: [{ window_id: 26998 }] });
      }
      if (name === 'list_windows') return result({ windows: [{
        window_id: 26998, is_on_screen: true, bounds: { x: 0, y: 0, width: 900, height: 700 },
      }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/messages.png', screenshot_width: 900, screenshot_height: 700,
        elements: [],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());

    const opened = await runtime.run({ action: 'open', app: 'com.apple.Messages', deliveryMode: 'background' });

    expect(opened).toEqual(expect.objectContaining({ ok: true, app: 'Messages', pid: 91942 }));
    const launches = callTool.mock.calls
      .map(([call]) => call)
      .filter((call: any) => call.name === 'launch_app');
    // Addressed as an id first (never as a nonsense display name), then the leaf as a name.
    expect(launches).toEqual([
      { name: 'launch_app', arguments: { bundle_id: 'com.apple.Messages' } },
      { name: 'launch_app', arguments: { name: 'Messages' } },
    ]);
  });

  it('does not retry a launch failure that is not "no installed app"', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') {
        return { isError: true, structuredContent: {}, content: [{ type: 'text', text: 'launch timed out' }] };
      }
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());

    const opened = await runtime.run({ action: 'open', app: 'com.apple.Messages', deliveryMode: 'background' });

    expect(opened.ok).toBe(false);
    // A timeout may have delivered. Retrying it could open a second instance the user never asked for.
    const launches = callTool.mock.calls
      .map(([call]) => call)
      .filter((call: any) => call.name === 'launch_app');
    expect(launches).toHaveLength(1);
  });

  /**
   * The refusal that killed a real run on 2026-08-14.
   *
   * A Messages conversation row is an anonymous container whose name this runtime SYNTHESIZES by
   * folding its descendant AXStaticText leaves — so the "label" is `name, last message, date`. The
   * app emitted AXUIElementDestroyed 1.5s after the frame (it was still settling after launch), the
   * tree was re-walked, the composite came back with a different trailing segment, and exact
   * equality refused a row that was visible on screen the entire time: "the element you named ... is
   * no longer in the tree after the app changed". The run never recovered.
   */
  describe('re-acquiring a named handle after the app changed', () => {
    const rowsWith = (mamaJiLabel: string) => [
      { element_index: 28, element_token: 's:28', role: 'AXStaticText', label: 'Mom 2, Hi, Saturday', value: 'Mom 2, Hi, Saturday' },
      { element_index: 32, element_token: 's:32', role: 'AXStaticText', label: mamaJiLabel, value: mamaJiLabel },
      { element_index: 40, element_token: 's:40', role: 'AXToolbar', label: '' },
    ];

    const runtimeShowing = async (elements: any[]) => {
      callTool.mockImplementation(async ({ name }: any) => {
        if (name === 'start_session' || name === 'set_agent_cursor_enabled') return result({ ok: true });
        if (name === 'launch_app') return result({ name: 'Messages', pid: 91942, windows: [{ window_id: 26998 }] });
        if (name === 'list_windows') return result({ windows: [{ window_id: 26998, is_on_screen: true, bounds: { x: 0, y: 0, width: 900, height: 700 } }] });
        if (name === 'get_window_state') return result({
          screenshot_file_path: '/tmp/m.png', screenshot_width: 900, screenshot_height: 700, elements,
        });
        return result({ ok: true });
      });
      const runtime = new BimaxComputerRuntime(simulatedNative());
      await runtime.run({ action: 'open', app: 'Messages', deliveryMode: 'background' });
      return runtime;
    };

    it('re-acquires the row when a trailing segment of the folded label changed', async () => {
      const before = await runtimeShowing(rowsWith('Mama Ji 🔥, 7732-091343 veeramani, 7/12/26'));
      const identity = before.describeTarget({ action: 'click', elementToken: 's:32' } as any)!;
      expect(identity).toBeTruthy();

      // A new message arrives: same row, same leading name, different tail.
      const after = await runtimeShowing(rowsWith('Mama Ji 🔥, ok see you then, Today'));
      const reacquired = after.reacquireByIdentity(identity);

      expect(reacquired).toBeTruthy();
      expect(reacquired!.elementToken).toBe('s:32');
    });

    it('still prefers an exact match when one exists', async () => {
      const before = await runtimeShowing(rowsWith('Mama Ji 🔥, 7732-091343 veeramani, 7/12/26'));
      const identity = before.describeTarget({ action: 'click', elementToken: 's:32' } as any)!;
      const after = await runtimeShowing(rowsWith('Mama Ji 🔥, 7732-091343 veeramani, 7/12/26'));

      expect(after.reacquireByIdentity(identity)!.elementToken).toBe('s:32');
    });

    /**
     * The invariant the strict match existed to protect. A near-miss is a silent click on the wrong
     * control, which is worse than the refusal it replaces — so ambiguity must still refuse.
     */
    it('refuses rather than guess when the stable part matches two rows', async () => {
      const before = await runtimeShowing(rowsWith('Mama Ji 🔥, 7732-091343 veeramani, 7/12/26'));
      const identity = before.describeTarget({ action: 'click', elementToken: 's:32' } as any)!;

      const after = await runtimeShowing([
        { element_index: 32, element_token: 's:32', role: 'AXStaticText', label: 'Mama Ji 🔥, one, 7/12/26', value: 'Mama Ji 🔥, one, 7/12/26' },
        { element_index: 33, element_token: 's:33', role: 'AXStaticText', label: 'Mama Ji 🔥, two, 7/13/26', value: 'Mama Ji 🔥, two, 7/13/26' },
      ]);

      expect(after.reacquireByIdentity(identity)).toBeNull();
    });

    it('refuses when the row is genuinely gone', async () => {
      const before = await runtimeShowing(rowsWith('Mama Ji 🔥, 7732-091343 veeramani, 7/12/26'));
      const identity = before.describeTarget({ action: 'click', elementToken: 's:32' } as any)!;

      const after = await runtimeShowing([
        { element_index: 28, element_token: 's:28', role: 'AXStaticText', label: 'Mom 2, Hi, Saturday', value: 'Mom 2, Hi, Saturday' },
      ]);

      expect(after.reacquireByIdentity(identity)).toBeNull();
    });
  });

  it('warns instead of claiming success when an opened app never becomes frontmost', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'WhatsApp', pid: 81453, windows: [{ window_id: 9 }] });
      // The terminal stays frontmost even though bring_to_front returned ok (the real WhatsApp bug).
      if (name === 'list_apps') return result({ apps: [{ pid: 500, name: 'Terminal', active: true }, { pid: 81453, name: 'WhatsApp', active: false }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 9, is_on_screen: true, bounds: { width: 800, height: 600 } }] });
      if (name === 'get_window_state') return result({ screenshot_file_path: '/tmp/wa.png', screenshot_width: 800, screenshot_height: 600, elements: [] });
      return result({ ok: true });
    });
    const nativeRun = jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} done` }));
    const native: any = { run: nativeRun, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }), frontmostApp: async () => 'Terminal' };
    const runtime = new BimaxComputerRuntime(native);
    const opened = await runtime.run({ action: 'open', app: 'WhatsApp', deliveryMode: 'foreground' });
    expect(opened.frontmostWarning).toBeTruthy();
    expect(opened.frontmostWarning).toContain('Terminal');
    expect(opened.summary).toContain('WARNING');
    // Escalated to the native `open -a` contract when bring_to_front left the wrong app in front.
    expect(nativeRun.mock.calls.some(([c]: any) => c.action === 'open' && c.app === 'WhatsApp')).toBe(true);
  });

  it('acquires the app window for screenshot instead of full-display capturing the terminal', async () => {
    let windowReady = false;
    let windowPolls = 0;
    const fullDisplay = jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: 'screenshot of display 1 with Terminal frontmost' }));
    const native: any = { run: fullDisplay, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }), frontmostApp: async () => 'WhatsApp' };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'WhatsApp', pid: 81453, windows: [] }); // window not enumerable yet
      if (name === 'list_apps') return result({ apps: [{ pid: 81453, name: 'WhatsApp', active: true }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') {
        windowReady = ++windowPolls >= 2; // materializes while open() is polling, as a real launching app does
        return result({ windows: windowReady ? [{ window_id: 9, is_on_screen: true, bounds: { width: 800, height: 600 } }] : [] });
      }
      if (name === 'get_window_state') return result({ screenshot_file_path: '/tmp/wa.png', screenshot_width: 800, screenshot_height: 600, elements: [] });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'WhatsApp', deliveryMode: 'foreground' });
    const shot = await runtime.run({ action: 'screenshot' });
    expect(shot.screenshot).toBe('/tmp/wa.png');
    expect(shot.width).toBe(800);
    // The whole-screen fallback (which would have captured the terminal) was never used.
    expect(fullDisplay.mock.calls.some(([c]: any) => c.action === 'screenshot')).toBe(false);
  });

  it('reopens a closed app window in background mode without stealing the foreground app', async () => {
    let windowReady = false;
    const nativeRun = jest.fn(async (cmd: any) => {
      if (cmd.action === 'reopen_background') windowReady = true;
      return { ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} done` };
    });
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Terminal',
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'WhatsApp', pid: 81453, windows: [] });
      if (name === 'list_apps') return result({ apps: [{ pid: 81453, name: 'WhatsApp', active: false }] });
      if (name === 'list_windows') return result({ windows: windowReady
        ? [{ window_id: 9, is_on_screen: false, bounds: { x: 100, y: 100, width: 800, height: 600 } }]
        : [] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/wa-background.png', screenshot_width: 800, screenshot_height: 600,
        elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 100, y: 100, w: 800, h: 600 } }],
      });
      return result({ ok: true });
    });

    const runtime = new BimaxComputerRuntime(native);
    const opened = await runtime.run({ action: 'open', app: 'WhatsApp', deliveryMode: 'background' });

    expect(opened).toEqual(expect.objectContaining({ ok: true, windowId: 9, width: 800, height: 600 }));
    expect(nativeRun.mock.calls.some(([cmd]: any) => cmd.action === 'reopen_background' && cmd.app === 'WhatsApp')).toBe(true);
    expect(nativeRun.mock.calls.some(([cmd]: any) => cmd.action === 'open')).toBe(false);
    expect(callTool.mock.calls.some(([call]: any) => call.name === 'bring_to_front')).toBe(false);
  });

  it('restores the prior app after a bounded foreground pulse when background reopen is ignored', async () => {
    let windowReady = false;
    let frontmost = 'Terminal';
    const nativeRun = jest.fn(async (cmd: any) => {
      if (cmd.action === 'open' && cmd.app === 'WhatsApp') {
        frontmost = 'WhatsApp';
        windowReady = true;
      } else if (cmd.action === 'open' && cmd.app === 'Terminal') {
        frontmost = 'Terminal';
      }
      return { ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} done` };
    });
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => frontmost,
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'WhatsApp', pid: 81453, windows: [] });
      if (name === 'list_apps') return result({ apps: [{ pid: 81453, name: 'WhatsApp', active: frontmost === 'WhatsApp' }] });
      if (name === 'list_windows') return result({ windows: windowReady
        ? [{ window_id: 9, is_on_screen: frontmost === 'WhatsApp', bounds: { x: 100, y: 100, width: 800, height: 600 } }]
        : [] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/wa-pulsed-background.png', screenshot_width: 800, screenshot_height: 600,
        elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 100, y: 100, w: 800, h: 600 } }],
      });
      return result({ ok: true });
    });

    const runtime = new BimaxComputerRuntime(native);
    const opened = await runtime.run({ action: 'open', app: 'WhatsApp', deliveryMode: 'background' });

    expect(opened).toEqual(expect.objectContaining({ ok: true, windowId: 9 }));
    expect(nativeRun.mock.calls.map(([cmd]: any) => `${cmd.action}:${cmd.app || ''}`))
      .toEqual(expect.arrayContaining(['reopen_background:WhatsApp', 'open:WhatsApp', 'open:Terminal']));
    expect(frontmost).toBe('Terminal');
    expect(callTool.mock.calls.some(([call]: any) => call.name === 'bring_to_front')).toBe(false);
  });

  it('waits for the window to finish rendering instead of capturing a 35px menu-bar strip', async () => {
    let ticks = 0;
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Finder', pid: 615, windows: [{ window_id: 2272 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: 615, name: 'Finder', active: true }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') {
        // Finder's window is a 1559×35 toolbar strip for the first polls, then fills in to full size.
        ticks++;
        return result({ windows: [{ window_id: 2272, is_on_screen: true, bounds: { width: 1559, height: ticks >= 3 ? 900 : 35 } }] });
      }
      if (name === 'get_window_state') return result({ screenshot_file_path: '/tmp/desk.png', screenshot_width: 1342, screenshot_height: 1568, elements: [] });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'Finder', deliveryMode: 'background' });
    const shot = await runtime.run({ action: 'screenshot' });
    expect(shot).toEqual(expect.objectContaining({ ok: true, windowId: 2272, width: 1342 }));
    // It polled past the 35px strip (≥3 list_windows) rather than capturing the half-rendered window.
    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  it('tells a vision-only frame the truth instead of sending it back to observe forever', async () => {
    // Reproduces a live product failure: "send hi to my mom on WhatsApp" spent its whole turn in
    // observe → click → "handle is stale, observe again" → observe, while the chat it wanted was
    // visible on screen the entire time.
    //
    // The cause is structural, not a model defect. When the AX walk yields nothing the observation is
    // built from on-device Vision, whose items have a label and a rectangle but no element_index or
    // element_token by construction — so indexedElements is empty and EVERY handle click fails. The
    // old error said "observe again and use a handle from the newest result", which describes an
    // action that cannot exist for this window. An obedient model loops on it forever.
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session' || name === 'bring_to_front' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'WhatsApp', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'WhatsApp', active: true }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      // A window whose only AX node is the window itself: exactly the Catalyst thin-tree case. The
      // lone AXWindow is the point — it registers an index, so a naive "are there any handles?" check
      // would call this addressable and reproduce the loop.
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/wa-vision.png', screenshot_width: 500, screenshot_height: 700,
        elements: [{ element_index: 0, role: 'AXWindow', label: 'Mom 2', frame: { x: 0, y: 0, w: 500, h: 700 } }],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'WhatsApp' });
    await runtime.run({ action: 'observe', maxElements: 200 });

    const clicked = await runtime.run({ action: 'click', elementIndex: 3 });
    expect(clicked.ok).toBe(false);
    // It must NOT repeat the instruction that cannot succeed...
    expect(clicked.error).not.toMatch(/observe again and use a handle/i);
    // ...and must name the modes that do survive a handle-less frame.
    expect(clicked.error).toMatch(/no actionable accessibility handles/i);
    expect(clicked.error).toMatch(/query=/);
    expect(clicked.error).toMatch(/x\/y/);
    // Naming what IS visible is what lets the model act on the very next call.
    expect(clicked.error).toMatch(/Mom 2/);
  });

  it('keeps a held window id when enumeration never offers a properly sized window', async () => {
    // The strip guard above must NARROW which id gets newly pinned — it must not DISCARD an id we are
    // already driving. WindowServer's per-pid enumeration is routinely unhelpful for an app whose only
    // surfaces are the desktop or menu-bar proxies (Finder with no folder window open is the everyday
    // case) while direct capture of the held id works perfectly.
    //
    // This is a live regression, caught by `npm run test:computer:all` and by nothing in this file:
    // dropping the id turned `open Finder` into "observe needs pid + windowId" and refused 14
    // downstream actions that passed at HEAD. Enumeration being unhelpful is not evidence that the
    // window we already own is degenerate.
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Finder', pid: 615, windows: [{ window_id: 2272 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: 615, name: 'Finder', active: true }] });
      // Only menu-bar proxies, forever — never a window over 100x100.
      if (name === 'list_windows') return result({ windows: [
        { window_id: 2273, is_on_screen: true, bounds: { x: 0, y: 0, width: 1559, height: 35 } },
        { window_id: 2274, is_on_screen: true, bounds: { x: 0, y: 0, width: 1559, height: 24 } },
      ] });
      if (name === 'get_window_state') {
        expect(Number(args?.window_id)).toBe(2272); // the held id, not a strip and not undefined
        return result({
          screenshot_file_path: '/tmp/finder-held.png', screenshot_width: 1342, screenshot_height: 900,
          elements: [{ element_index: 0, role: 'AXWindow', label: 'Desktop', frame: { x: 0, y: 0, w: 1342, h: 900 } }],
        });
      }
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    const opened = await runtime.run({ action: 'open', app: 'Finder', deliveryMode: 'background' });
    expect(opened).toEqual(expect.objectContaining({ ok: true, windowId: 2272 }));
    // And it must never adopt one of the proxy strips as the action surface.
    expect(opened.windowId).not.toBe(2273);
    expect(opened.windowId).not.toBe(2274);
  });

  it('background mode chooses the real off-screen app window over menu-bar proxy strips', async () => {
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'WhatsApp', pid: 67078, windows: [{ window_id: 2089 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: 67078, name: 'WhatsApp', active: false }] });
      if (name === 'list_windows') return result({ windows: [
        { window_id: 2089, is_on_screen: false, bounds: { x: 0, y: 0, width: 1470, height: 33 } },
        { window_id: 2088, is_on_screen: false, bounds: { x: 0, y: 0, width: 1470, height: 33 } },
        { window_id: 2054, is_on_screen: false, bounds: { x: 91, y: 33, width: 801, height: 864 } },
      ] });
      if (name === 'get_window_state') {
        expect(args.window_id).toBe(2054);
        return result({ screenshot_file_path: '/tmp/whatsapp-hidden.png', screenshot_width: 1454, screenshot_height: 1568, elements: [] });
      }
      return result({ ok: true });
    });
    const nativeRun = jest.fn(async (cmd: any) => ({
      ok: true, action: cmd.action, driver: 'native-helper',
      windowFrame: cmd.action === 'window_frame' ? { x: 91, y: 33, w: 801, h: 864 } : undefined,
      summary: `${cmd.action} done`,
    }));
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Terminal',
    };
    const runtime = new BimaxComputerRuntime(native);
    const opened = await runtime.run({ action: 'open', app: 'WhatsApp', deliveryMode: 'background' });
    expect(opened).toEqual(expect.objectContaining({ ok: true, windowId: 2054, width: 1454, height: 1568 }));
    expect(callTool.mock.calls.some(([call]: any) => call.name === 'bring_to_front')).toBe(false);
  });

  it('launches by the bundle id the OS resolves, and creates a real window from a menu-only proxy', async () => {
    // Both halves of this used to be hardcoded to Finder by name. The bundle id now comes from a
    // Launch Services lookup, and the "activated but no usable window, so press Cmd+N" recovery is
    // driven by probing the window — so any app with either shape gets the same treatment.
    let realWindow = false;
    const nativeRun = jest.fn(async (cmd: any) => {
      if (cmd.action === 'key' && cmd.combo === 'cmd+n') realWindow = true;
      // The OS answers the bundle-id lookup; nothing in the runtime knows this mapping.
      if (cmd.action === 'bundle_id') {
        return { ok: true, action: cmd.action, driver: 'native-helper', bundleId: 'com.apple.finder', summary: 'resolved' };
      }
      return { ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} done` };
    });
    const native: any = { run: nativeRun, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }), frontmostApp: async () => 'Finder' };
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') {
        expect(args).toEqual(expect.objectContaining({ bundle_id: 'com.apple.finder' }));
        expect(args.name).toBeUndefined();
        expect(args.creates_new_application_instance).toBeUndefined();
        return result({ name: 'Finder', pid: 615, windows: [{ window_id: 2272 }] });
      }
      if (name === 'list_apps') return result({ apps: [{ pid: 615, name: 'Finder', active: true }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: realWindow
        ? [{ window_id: 3001, is_on_screen: true, bounds: { width: 900, height: 700 } }]
        : [{ window_id: 2272, is_on_screen: true, bounds: { width: 1559, height: 35 } }] });
      if (name === 'get_window_state') return result({ screenshot_file_path: '/tmp/finder.png', screenshot_width: 900, screenshot_height: 700, elements: [] });
      return result({ ok: true });
    });

    const runtime = new BimaxComputerRuntime(native);
    const opened = await runtime.run({ action: 'open', app: 'Finder', newInstance: true, deliveryMode: 'foreground' });
    expect(opened).toEqual(expect.objectContaining({ ok: true, app: 'Finder', windowId: 3001, width: 900, height: 700 }));
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({ action: 'key', combo: 'cmd+n' }), undefined);
  });

  it('maps System Settings sheets through the parent window and blocks clicks behind the modal', async () => {
    // The sheet's modality is answered by macOS (AX), not inferred from its rectangle. AX is live
    // where the window list is not, so the sheet stops being reported the moment it is dismissed —
    // which is what lets the parent page become clickable again on the very next action.
    const sheet = { x: 200, y: 300, w: 500, h: 200 };
    let sheetOpen = true;
    const nativeRun = jest.fn(async (cmd: any) => {
      if (cmd.action === 'modal_frame') {
        return { ok: true, action: cmd.action, driver: 'native-helper', summary: 'probe', modalFrame: sheetOpen ? sheet : undefined };
      }
      if (cmd.action === 'click' && sheetOpen
        && cmd.x >= sheet.x && cmd.x <= sheet.x + sheet.w && cmd.y >= sheet.y && cmd.y <= sheet.y + sheet.h) {
        sheetOpen = false; // the Done button lives on the sheet, so clicking it closes the sheet
      }
      return {
        ok: true, action: cmd.action, driver: 'native-helper', x: cmd.x, y: cmd.y,
        app: 'System Settings', summary: `${cmd.action} delivered`,
      };
    });
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'System Settings',
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 9 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'System Settings', active: true }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [
        { window_id: 9, is_on_screen: true, bounds: { x: 200, y: 300, width: 500, height: 200 } },
        { window_id: 7, is_on_screen: true, bounds: { x: 100, y: 50, width: 700, height: 800 } },
      ] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/settings-parent.png', screenshot_width: 700, screenshot_height: 800,
        elements: [
          { element_index: 1, role: 'AXWindow', frame: { x: 100, y: 50, w: 700, h: 800 } },
          { element_index: 2, role: 'AXButton', label: 'Done', frame: { x: 550, y: 430, w: 100, h: 40 } },
        ],
      });
      return result({ ok: true });
    });

    const runtime = new BimaxComputerRuntime(native);
    const opened = await runtime.run({ action: 'open', app: 'System Settings', deliveryMode: 'foreground' });
    expect(opened).toEqual(expect.objectContaining({ ok: true, windowId: 7 }));
    expect(opened.completionGuidance).toMatch(/foreground dialog is currently detected/i);

    const blocked = await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'foreground' });
    expect(blocked).toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/foreground dialog is blocking/i) }));
    const inside = await runtime.run({ action: 'click', elementIndex: 2, deliveryMode: 'foreground' });
    expect(inside.ok).toBe(true);
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({ action: 'click', x: 600, y: 450 }), undefined);
    // The sidecar may report the closed sheet for one stale list_windows tick. A verified click on
    // the semantic Done control must still unblock the freshly visible parent page.
    const parent = await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'foreground' });
    expect(parent.ok).toBe(true);
  });

  it('right-click returns a full-display observation and menu clicks skip activation', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    // Minimal real PNG header (1440x900) so displayObservation can read authoritative dimensions.
    const displayPng = path.join(os.tmpdir(), `bimax-test-display-${Date.now()}.png`);
    const png = Buffer.alloc(24);
    png.write('\x89PNG\r\n\x1a\n', 0, 'binary');
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(1440, 16);
    png.writeUInt32BE(900, 20);
    fs.writeFileSync(displayPng, png);

    const nativeRun = jest.fn(async (cmd: any) => cmd.action === 'screenshot'
      ? { ok: true, action: 'screenshot', driver: 'native-helper', screenshot: displayPng, summary: 'display captured' }
      : { ok: true, action: cmd.action, driver: 'native-helper', x: cmd.x, y: cmd.y, app: 'Finder', summary: `${cmd.action} delivered` });
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Finder',
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Finder', pid: 12, windows: [{ window_id: 5 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: 12, name: 'Finder', active: true }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 5, is_on_screen: true, bounds: { x: 100, y: 50, width: 700, height: 500 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/finder.png', screenshot_width: 700, screenshot_height: 500,
        elements: [{ element_index: 1, role: 'AXWindow', frame: { x: 100, y: 50, w: 700, h: 500 } }],
      });
      return result({ ok: true });
    });

    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'Finder', deliveryMode: 'foreground' });
    const rightClick = await runtime.run({ action: 'click', x: 350, y: 250, button: 'right', deliveryMode: 'foreground' });
    expect(rightClick.ok).toBe(true);
    // The evidence is the full display, not the window PNG.
    expect(rightClick.screenshot).toBe(displayPng);
    expect(rightClick).toEqual(expect.objectContaining({ width: 1440, height: 900 }));
    expect(rightClick.completionGuidance).toMatch(/FULL DISPLAY/);

    // Element handles from the window observation are invalid now.
    await expect(runtime.run({ action: 'click', elementIndex: 1, deliveryMode: 'foreground' }))
      .resolves.toEqual(expect.objectContaining({ ok: false }));

    const frontsBefore = callTool.mock.calls.filter(([arg]) => arg.name === 'bring_to_front').length;
    // Clicking a menu item: display pixels map 1:1 to global points, no activation.
    const menuClick = await runtime.run({ action: 'click', x: 400, y: 300, deliveryMode: 'foreground' });
    expect(menuClick.ok).toBe(true);
    const menuNative = nativeRun.mock.calls.find(([cmd]: any[]) => cmd.action === 'click' && cmd.button !== 'right');
    expect(menuNative?.[0]).toEqual(expect.objectContaining({ x: 400, y: 300 }));
    expect(callTool.mock.calls.filter(([arg]) => arg.name === 'bring_to_front').length).toBe(frontsBefore);
    fs.rmSync(displayPng, { force: true });
  });

  it('promotes a full-display frame when a normal click opens a separately composed transient', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const windowPng = path.join(os.tmpdir(), `bimax-left-popover-window-${Date.now()}.png`);
    const displayPng = path.join(os.tmpdir(), `bimax-left-popover-display-${Date.now()}.png`);
    const writePng = (file: string, width: number, height: number) => {
      const png = Buffer.alloc(24);
      png.write('\x89PNG\r\n\x1a\n', 0, 'binary');
      png.write('IHDR', 12, 'ascii');
      png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
      fs.writeFileSync(file, png);
    };
    writePng(windowPng, 700, 500);
    writePng(displayPng, 1440, 900);
    let transientOpen = false;
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session' || name === 'bring_to_front' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'App', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'App', active: true }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 100, y: 50, width: 700, height: 500 } }] });
      if (name === 'get_window_state') return result(transientOpen
        ? { elements: [] } // separately composed popover makes parent capture unavailable
        : { screenshot_file_path: windowPng, screenshot_width: 700, screenshot_height: 500,
            elements: [{ element_index: 1, role: 'AXButton', label: 'Open menu', frame: { x: 150, y: 100, w: 80, h: 40 } }] });
      if (name === 'click') { transientOpen = true; return result({ effect: 'delivered' }); }
      return result({ ok: true });
    });
    const native: any = {
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'App',
      run: jest.fn(async (cmd: any) => {
        if (cmd.action === 'screens') return { ok: true, action: cmd.action, driver: 'native-helper', screens: [{ index: 1, main: true, scale: 1, frame: { x: 0, y: 0, w: 1440, h: 900 }, visible: { x: 0, y: 25, w: 1440, h: 850 } }], summary: 'screens' };
        if (cmd.action === 'screenshot') return { ok: true, action: cmd.action, driver: 'native-helper', screenshot: displayPng, summary: 'display captured' };
        if (cmd.action === 'window_frame') return { ok: true, action: cmd.action, driver: 'native-helper', windowFrame: { x: 100, y: 50, w: 700, h: 500 }, summary: 'window' };
        return { ok: true, action: cmd.action, driver: 'native-helper', app: 'App', summary: cmd.action };
      }),
    };

    try {
      const runtime = new BimaxComputerRuntime(native);
      await runtime.run({ action: 'open', app: 'App', deliveryMode: 'background' });
      const opened = await runtime.run({ action: 'click', elementIndex: 1, deliveryMode: 'background' });
      expect(opened.ok).toBe(true);
      expect(opened.screenshot).toBe(displayPng);
      expect(opened).toEqual(expect.objectContaining({ width: 1440, height: 900, degraded: true }));
      expect(opened.completionGuidance).toMatch(/FULL DISPLAY/);
      expect(opened.recoveryHint).toMatch(/foreground transient opened or the app is hidden\/off-Space/i);
    } finally {
      fs.rmSync(windowPng, { force: true });
      fs.rmSync(displayPng, { force: true });
    }
  });

  it('adopts a newly created same-app popup as the exact action surface before using display fallback', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const parentPng = path.join(os.tmpdir(), `bimax-parent-${Date.now()}.png`);
    const popupPng = path.join(os.tmpdir(), `bimax-popup-${Date.now()}.png`);
    const writePng = (file: string, width: number, height: number) => {
      const png = Buffer.alloc(24);
      png.write('\x89PNG\r\n\x1a\n', 0, 'binary');
      png.write('IHDR', 12, 'ascii');
      png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
      fs.writeFileSync(file, png);
    };
    writePng(parentPng, 700, 500);
    writePng(popupPng, 346, 268);
    let popupOpen = false;
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session' || name === 'bring_to_front' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'App', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'App', active: false }] });
      // Enumerated parent-first, and with NO stacking field: `list_windows` returns none, so the
      // adoption order has to come from the monotonic CGWindowID space (8 was minted by the click,
      // after the observation that saw only 7). An earlier draft sorted on an invented `z_index`,
      // which this mock used to supply — the test passed while production ordered nothing.
      if (name === 'list_windows') return result({ windows: popupOpen ? [
        { window_id: 7, is_on_screen: false, bounds: { x: 100, y: 50, width: 700, height: 500 } },
        { window_id: 8, is_on_screen: false, bounds: { x: 300, y: 200, width: 346, height: 268 } },
      ] : [{ window_id: 7, is_on_screen: false, bounds: { x: 100, y: 50, width: 700, height: 500 } }] });
      if (name === 'get_window_state') {
        if (Number(args?.window_id) === 8) return result({
          screenshot_file_path: popupPng, screenshot_width: 346, screenshot_height: 268,
          elements: [{ element_index: 9, element_token: 'popup-file', role: 'AXButton', label: 'File',
            frame: { x: 320, y: 220, w: 120, h: 44 } }],
        });
        return result(popupOpen
          ? { elements: [] }
          : { screenshot_file_path: parentPng, screenshot_width: 700, screenshot_height: 500,
              elements: [{ element_index: 1, element_token: 'open-menu', role: 'AXButton', label: 'Open menu',
                frame: { x: 150, y: 100, w: 80, h: 40 } }] });
      }
      if (name === 'click') { popupOpen = true; return result({ effect: 'delivered' }); }
      return result({ ok: true });
    });
    const nativeRun = jest.fn(async (cmd: any) => ({
      ok: true, action: cmd.action, driver: 'native-helper', app: 'App', summary: cmd.action,
    }));
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Terminal',
    };

    try {
      const runtime = new BimaxComputerRuntime(native);
      await runtime.run({ action: 'open', app: 'App', deliveryMode: 'background' });
      const opened = await runtime.run({ action: 'click', elementToken: 'open-menu', deliveryMode: 'background' });
      expect(opened).toEqual(expect.objectContaining({
        ok: true, windowId: 8, screenshot: popupPng,
        recoveryHint: expect.stringMatching(/adopted its exact pixels and coordinates/i),
      }));
      expect(opened.elements).toEqual(expect.arrayContaining([
        expect.objectContaining({ element_token: 'popup-file', label: 'File' }),
      ]));
    } finally {
      fs.rmSync(parentPng, { force: true });
      fs.rmSync(popupPng, { force: true });
    }
  });

  it('attaches human display context while keeping the target window as the action frame', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const writePngHeader = (file: string, width: number, height: number) => {
      const png = Buffer.alloc(24);
      png.write('\x89PNG\r\n\x1a\n', 0, 'binary');
      png.write('IHDR', 12, 'ascii');
      png.writeUInt32BE(width, 16);
      png.writeUInt32BE(height, 20);
      fs.writeFileSync(file, png);
    };
    const windowPng = path.join(os.tmpdir(), `bimax-human-window-${Date.now()}.png`);
    const displayPng = path.join(os.tmpdir(), `bimax-human-display-${Date.now()}.png`);
    writePngHeader(windowPng, 500, 350);
    writePngHeader(displayPng, 1440, 900);
    const targetFrame = { x: 100, y: 50, w: 500, h: 350 };

    const nativeRun = jest.fn(async (cmd: any) => {
      if (cmd.action === 'screenshot') {
        return { ok: true, action: cmd.action, driver: 'native-helper', screenshot: displayPng, width: 1440, height: 900, summary: 'display captured' };
      }
      if (cmd.action === 'screens') {
        return { ok: true, action: cmd.action, driver: 'native-helper', screens: [{ index: 1, main: true, scale: 2, frame: { x: 0, y: 0, w: 720, h: 450 }, visible: { x: 0, y: 13, w: 720, h: 425 } }], summary: 'screens' };
      }
      if (cmd.action === 'window_frame') {
        return { ok: true, action: cmd.action, driver: 'native-helper', windowFrame: targetFrame, summary: 'focused window frame' };
      }
      if (cmd.action === 'window_at') {
        return {
          ok: true, action: cmd.action, driver: 'native-helper', summary: 'target owns point',
          windowAt: {
            owner_pid: 42, owner_name: 'App', window_id: 7,
            top_owner_name: 'App', top_window_id: 7, layer: 0,
            bounds: targetFrame,
            element_chain: [{ pid: 42, role: 'AXButton', title: 'Send', frame: { x: 150, y: 100, w: 80, h: 40 } }],
          },
        };
      }
      return { ok: true, action: cmd.action, driver: 'native-helper', x: cmd.x, y: cmd.y, app: 'App', summary: cmd.action };
    });
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'App',
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session' || name === 'bring_to_front' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'App', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'App', active: true }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 100, y: 50, width: 500, height: 350 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: windowPng, screenshot_width: 500, screenshot_height: 350,
        elements: [
          { element_index: 0, role: 'AXWindow', label: 'Document', frame: targetFrame },
          { element_index: 1, element_token: 'send', role: 'AXButton', label: 'Send', enabled: true, frame: { x: 150, y: 100, w: 80, h: 40 } },
        ],
      });
      return result({ ok: true });
    });

    try {
      const runtime = new BimaxComputerRuntime(native);
      await runtime.run({ action: 'open', app: 'App', deliveryMode: 'foreground' });
      const observed = await runtime.run({ action: 'observe' });

      expect(observed.screenshot).toBe(windowPng);
      expect(observed.displayScreenshot).toBe(displayPng);
      expect(observed).toEqual(expect.objectContaining({
        width: 500, height: 350, displayWidth: 1440, displayHeight: 900, windowId: 7,
      }));
      expect((observed.details as any)?.perception?.view).toEqual(expect.objectContaining({
        mode: 'dual-frame', actionVisual: 'exact-window', contextVisual: 'display', semantics: 'exact-window',
      }));
      const send = (observed.elements as any[]).find(element => element.label === 'Send');
      // Coordinates stay local to the clean target-window image; the Retina display is context only.
      expect(send.frame).toEqual({ x: 50, y: 50, w: 80, h: 40 });

      const frontsBefore = callTool.mock.calls.filter(([arg]) => arg.name === 'bring_to_front').length;
      const clicked = await runtime.run({ action: 'click', elementToken: 'send', deliveryMode: 'foreground' });
      expect(clicked.ok).toBe(true);
      expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({ action: 'click', x: 190, y: 120 }), undefined);
      // Foreground mode may raise before physical input; background mode (covered separately) does not.
      expect(callTool.mock.calls.filter(([arg]) => arg.name === 'bring_to_front').length).toBeGreaterThanOrEqual(frontsBefore);
    } finally {
      fs.rmSync(windowPng, { force: true });
      fs.rmSync(displayPng, { force: true });
    }
  });

  it('adopts the Accessibility-focused non-modal window when a same-app click creates one', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const windowPng = path.join(os.tmpdir(), `bimax-focused-window-${Date.now()}.png`);
    const png = Buffer.alloc(24);
    png.write('\x89PNG\r\n\x1a\n', 0, 'binary');
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(600, 16);
    png.writeUInt32BE(500, 20);
    fs.writeFileSync(windowPng, png);
    const first = { window_id: 7, is_on_screen: true, bounds: { x: 40, y: 40, width: 600, height: 500 } };
    const created = { window_id: 9, is_on_screen: true, bounds: { x: 90, y: 90, width: 600, height: 500 } };
    let liveWindows = [first];

    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session' || name === 'bring_to_front' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'App', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'App', active: true }] });
      if (name === 'list_windows') return result({ windows: liveWindows });
      if (name === 'get_window_state') {
        const id = Number(args?.window_id || 0);
        const bounds = id === 9 ? { x: 90, y: 90, w: 600, h: 500 } : { x: 40, y: 40, w: 600, h: 500 };
        return result({
          screenshot_file_path: windowPng, screenshot_width: 600, screenshot_height: 500,
          elements: [{ element_index: 0, role: 'AXWindow', label: `Document ${id}`, frame: bounds }],
        });
      }
      return result({ ok: true });
    });
    const native: any = {
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'App',
      run: jest.fn(async (cmd: any) => {
        if (cmd.action === 'window_frame') {
          const bounds = liveWindows.length > 1 ? created.bounds : first.bounds;
          return { ok: true, action: cmd.action, driver: 'native-helper', windowFrame: { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height }, summary: 'focused frame' };
        }
        if (cmd.action === 'window_at') return { ok: true, action: cmd.action, driver: 'native-helper', summary: 'no reliable centre hit' };
        if (cmd.action === 'screens') return { ok: true, action: cmd.action, driver: 'native-helper', screens: [{ index: 1, main: true, scale: 2, frame: { x: 0, y: 0, w: 1440, h: 900 }, visible: { x: 0, y: 25, w: 1440, h: 850 } }], summary: 'screens' };
        if (cmd.action === 'screenshot') return { ok: true, action: cmd.action, driver: 'native-helper', screenshot: windowPng, summary: 'display' };
        return { ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action };
      }),
    };

    try {
      const runtime = new BimaxComputerRuntime(native);
      await runtime.run({ action: 'open', app: 'App' });
      liveWindows = [first, created];
      const observed = await runtime.run({ action: 'observe', includeScreenshot: false });
      expect(observed.windowId).toBe(9);
      expect((observed.elements as any[])[0]?.label).toBe('Document 9');
      expect(runtime.activeSurface()).toEqual(expect.objectContaining({ windowId: 9 }));
    } finally {
      fs.rmSync(windowPng, { force: true });
    }
  });

  it('retains exact ownership when AX focus geometry matches overlapping same-sized windows', async () => {
    const owned = { window_id: 7, is_on_screen: true, bounds: { x: 40, y: 40, width: 600, height: 500 } };
    const overlapping = { window_id: 9, is_on_screen: true, bounds: { ...owned.bounds } };
    let liveWindows = [owned];
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session' || name === 'bring_to_front' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Quasar Workspace', pid: 42, windows: [owned] });
      if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'Quasar Workspace', active: true }] });
      if (name === 'list_windows') return result({ windows: liveWindows });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/quasar-overlap.png', screenshot_width: 600, screenshot_height: 500,
        elements: [{ role: 'AXWindow', label: `Document ${args?.window_id}`, frame: { x: 40, y: 40, w: 600, h: 500 } }],
      });
      return result({ ok: true });
    });
    const native: any = {
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Quasar Workspace',
      run: jest.fn(async (cmd: any) => {
        const base = { ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action };
        if (cmd.action === 'window_frame') return { ...base, windowFrame: { x: 40, y: 40, w: 600, h: 500 } };
        if (cmd.action === 'window_at') return base;
        return base;
      }),
    };
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'Quasar Workspace', deliveryMode: 'background' });
    // Put the other id first to prove enumeration order cannot take ownership from window 7.
    liveWindows = [overlapping, owned];

    const observed = await runtime.run({ action: 'observe', includeScreenshot: false });

    expect(observed.ok).toBe(true);
    expect(observed.windowId).toBe(7);
    expect((observed.elements as any[])[0]?.label).toBe('Document 7');
    expect(runtime.activeSurface()).toEqual(expect.objectContaining({ windowId: 7 }));
  });

  it('keeps the parent capture pinned when a contained autocomplete child takes AX focus', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const windowPng = path.join(os.tmpdir(), `bimax-focused-child-${Date.now()}.png`);
    const png = Buffer.alloc(24);
    png.write('\x89PNG\r\n\x1a\n', 0, 'binary');
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(600, 16);
    png.writeUInt32BE(500, 20);
    fs.writeFileSync(windowPng, png);
    const parent = { window_id: 7, is_on_screen: true, bounds: { x: 40, y: 40, width: 600, height: 500 } };
    const popup = { window_id: 9, is_on_screen: true, bounds: { x: 170, y: 70, width: 300, height: 150 } };
    let popupOpen = false;

    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session' || name === 'bring_to_front' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'App', pid: 42, windows: [parent] });
      if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'App', active: true }] });
      if (name === 'list_windows') return result({ windows: popupOpen ? [popup, parent] : [parent] });
      if (name === 'get_window_state') {
        expect(Number(args?.window_id)).toBe(7);
        return result({
          screenshot_file_path: windowPng, screenshot_width: 600, screenshot_height: 500,
          elements: [{ element_index: 0, role: 'AXWindow', label: 'Parent', frame: { x: 40, y: 40, w: 600, h: 500 } }],
        });
      }
      return result({ ok: true });
    });
    const native: any = {
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'App',
      run: jest.fn(async (cmd: any) => {
        if (cmd.action === 'window_frame') {
          const bounds = popupOpen ? popup.bounds : parent.bounds;
          return { ok: true, action: cmd.action, driver: 'native-helper', windowFrame: { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height }, summary: 'focused frame' };
        }
        if (cmd.action === 'window_at') return { ok: true, action: cmd.action, driver: 'native-helper', summary: 'no reliable centre hit' };
        if (cmd.action === 'screens') return { ok: true, action: cmd.action, driver: 'native-helper', screens: [], summary: 'screens' };
        if (cmd.action === 'screenshot') return { ok: true, action: cmd.action, driver: 'native-helper', screenshot: windowPng, summary: 'display' };
        return { ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action };
      }),
    };

    try {
      const runtime = new BimaxComputerRuntime(native);
      await runtime.run({ action: 'open', app: 'App' });
      popupOpen = true;
      const observed = await runtime.run({ action: 'observe', includeScreenshot: false });
      expect(observed.windowId).toBe(7);
      expect((observed.elements as any[])[0]?.label).toBe('Parent');
      expect(runtime.activeSurface()).toEqual(expect.objectContaining({ windowId: 7 }));
    } finally {
      fs.rmSync(windowPng, { force: true });
    }
  });

  it('escape dismissal clears the transient dialog guard like a Done/Close click', async () => {
    let sheetOpen = true;
    const nativeRun = jest.fn(async (cmd: any) => {
      if (cmd.action === 'modal_frame') {
        return { ok: true, action: cmd.action, driver: 'native-helper', summary: 'probe', modalFrame: sheetOpen ? { x: 200, y: 300, w: 500, h: 200 } : undefined };
      }
      if (cmd.action === 'key' && /escape/i.test(String(cmd.combo || ''))) sheetOpen = false;
      return {
        ok: true, action: cmd.action, driver: 'native-helper', x: cmd.x, y: cmd.y,
        app: 'System Settings', summary: `${cmd.action} delivered`,
      };
    });
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'System Settings',
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 9 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'System Settings', active: true }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [
        { window_id: 9, is_on_screen: true, bounds: { x: 200, y: 300, width: 500, height: 200 } },
        { window_id: 7, is_on_screen: true, bounds: { x: 100, y: 50, width: 700, height: 800 } },
      ] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/settings-parent.png', screenshot_width: 700, screenshot_height: 800,
        elements: [
          { element_index: 1, role: 'AXWindow', frame: { x: 100, y: 50, w: 700, h: 800 } },
        ],
      });
      return result({ ok: true });
    });

    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'System Settings', deliveryMode: 'foreground' });
    const blocked = await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'foreground' });
    expect(blocked.ok).toBe(false);
    const escaped = await runtime.run({ action: 'key', combo: 'escape', deliveryMode: 'foreground' });
    expect(escaped.ok).toBe(true);
    // WindowServer may keep the dismissed sheet enumerable for a tick; Escape is a semantic
    // dismissal and must unblock the parent page exactly like a verified Done/Close click.
    const parent = await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'foreground' });
    expect(parent.ok).toBe(true);
  });

  it('fails honestly when loginwindow prevents the sidecar from producing screenshot pixels', async () => {
    const native: any = {
      run: jest.fn(),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'loginwindow',
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'System Settings', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({ windows: [
        { window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 700, height: 800 } },
      ] });
      if (name === 'get_window_state') return result({ screenshot_file_path: '/tmp/missing-locked-shot.png', elements: [] });
      return result({ ok: true });
    });

    const runtime = new BimaxComputerRuntime(native);
    const opened = await runtime.run({ action: 'open', app: 'System Settings', deliveryMode: 'background' });
    expect(opened).toEqual(expect.objectContaining({
      ok: false,
      error: expect.stringMatching(/Mac screen is locked.*loginwindow/i),
    }));
  });

  it('bounds immediate stale-handle failures until a fresh observation resets input', async () => {
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'Calculator', deliveryMode: 'background' });
    await runtime.run({ action: 'observe' });
    for (let attempt = 0; attempt < 3; attempt++) {
      const failed = await runtime.run({ action: 'click', query: 'definitely absent', deliveryMode: 'background' });
      expect(failed.ok).toBe(false);
    }
    const bounded = await runtime.run({ action: 'click', query: 'another absent target', deliveryMode: 'background' });
    expect(bounded.error).toMatch(/three consecutive input actions failed/i);
    const refreshed = await runtime.run({ action: 'observe' });
    expect(refreshed.ok).toBe(true);
    const retry = await runtime.run({ action: 'click', query: 'still absent', deliveryMode: 'background' });
    expect(retry.error).not.toMatch(/three consecutive input actions failed/i);
  });

  it('glides the one cursor into the target window before foreground typing', async () => {
    const nativeRun = jest.fn(async (cmd: any) => ({
      ok: true, action: cmd.action, driver: 'native-helper',
      ...(cmd.action === 'cursor' ? { x: 5, y: 5 } : {}), // cursor currently OUTSIDE the window
      summary: `${cmd.action} done`,
    }));
    const native: any = { run: nativeRun, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }), frontmostApp: async () => 'TextEdit' };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'TextEdit', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/te.png', screenshot_width: 1400, screenshot_height: 1600,
        elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 100, y: 50, w: 700, h: 800 } }],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'TextEdit', deliveryMode: 'foreground' });
    await runtime.run({ action: 'observe' });
    await runtime.run({ action: 'type', text: 'hi', deliveryMode: 'foreground' });
    // Cursor was read, found outside the window, and glided to the window centre before typing.
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({ action: 'cursor' }), undefined);
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({ action: 'move', x: 450, y: 450 }), undefined);
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({ action: 'type', text: 'hi', app: 'TextEdit' }), undefined);
  });

  it('tracks the active execution surface on open and clears it on close', async () => {
    let closed = false;
    const nativeRun = jest.fn(async (cmd: any) => {
      if (cmd.action === 'key' && cmd.combo === 'cmd+w') closed = true;
      return { ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} done` };
    });
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'TextEdit',
    };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'TextEdit', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'TextEdit', active: true }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: closed ? [] : [{ window_id: 7, is_on_screen: true, bounds: { width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/te.png', screenshot_width: 700, screenshot_height: 800,
        elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 100, y: 50, w: 700, h: 800 } }],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'TextEdit', deliveryMode: 'foreground' });
    const surface = runtime.activeSurface();
    expect(surface).toEqual(expect.objectContaining({
      kind: 'native-window', app: 'TextEdit', pid: 42, windowId: 7, focusOwner: 'agent',
      bounds: { x: 100, y: 50, w: 700, h: 800 }, captureSafe: true, backgroundCapable: true,
    }));
    // close removes the surface so it can't linger into the next task.
    await runtime.run({ action: 'close' });
    expect(runtime.activeSurface()).toBeNull();
  });

  it('does not claim agent input ownership when the opened app never came frontmost', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'WhatsApp', pid: 81453, windows: [{ window_id: 9 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: 500, name: 'Terminal', active: true }, { pid: 81453, name: 'WhatsApp', active: false }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 9, is_on_screen: true, bounds: { width: 800, height: 600 } }] });
      if (name === 'get_window_state') return result({ screenshot_file_path: '/tmp/wa.png', screenshot_width: 800, screenshot_height: 600, elements: [] });
      return result({ ok: true });
    });
    const nativeRun = jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} done` }));
    const native: any = { run: nativeRun, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }), frontmostApp: async () => 'Terminal' };
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'WhatsApp', deliveryMode: 'foreground' });
    // Surface exists but the agent does NOT own input, because the terminal stayed frontmost.
    expect(runtime.activeSurface()?.focusOwner).toBe('none');
  });

  it('pauses for user takeover, refuses to act, then resumes', async () => {
    const nativeRun = jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: `${cmd.action} done` }));
    const native: any = { run: nativeRun, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }), frontmostApp: async () => 'Calculator' };
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'Calculator', deliveryMode: 'foreground' });
    await runtime.run({ action: 'observe' });

    // User takes over → the agent must not act.
    runtime.pauseForUser();
    expect(runtime.activeSurface()?.focusOwner).toBe('user');
    const refused = await runtime.run({ action: 'type', text: 'hi', deliveryMode: 'foreground' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/paused for user takeover/i);
    expect(refused.executor).toEqual(expect.objectContaining({ level: 'stop', mechanism: null }));
    expect(runtime.lastExecutor()).toBe('stop');
    expect(nativeRun.mock.calls.some(([c]: any) => c.action === 'type')).toBe(false); // never delivered

    // Resume → the agent acts again.
    runtime.resume();
    expect(runtime.activeSurface()?.focusOwner).toBe('agent');
    const typed = await runtime.run({ action: 'type', text: 'hi', deliveryMode: 'foreground' });
    expect(typed.ok).toBe(true);
    expect(runtime.lastMechanism()).toBe('physical-foreground');
    expect(runtime.lastExecutor()).toBe('physical');
  });

  it('records the honest delivery mechanism per action (foreground vs background)', async () => {
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'Calculator' });
    await runtime.run({ action: 'observe' });
    const visual = await runtime.run({ action: 'click', x: 100, y: 100, deliveryMode: 'background' });
    expect(runtime.lastMechanism()).toBe('sidecar-background'); // no AX handle → synthetic path
    expect(visual.executor).toEqual(expect.objectContaining({
      level: 'visual', mechanism: 'sidecar-background',
    })); // screenshot grounding is the weaker rung, regardless of delivery
    const semantic = await runtime.run({ action: 'click', query: '216,174', deliveryMode: 'background' });
    expect(runtime.lastMechanism()).toBe('accessibility'); // named element → AX preferred
    expect(semantic.executor).toEqual(expect.objectContaining({
      level: 'semantic', mechanism: 'accessibility',
    }));

    await runtime.run({ action: 'observe' });
    expect(runtime.lastMechanism()).toBeNull(); // attribution never leaks from the prior click
    expect(runtime.lastExecutor()).toBeNull();
  });

  it('refuses a raw pixel click when the window changed while the model was thinking', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const original = path.join(os.tmpdir(), `bimax-original-${Date.now()}.png`);
    const changed = path.join(os.tmpdir(), `bimax-changed-${Date.now()}.png`);
    fs.writeFileSync(original, Buffer.from([1, 2, 3, 4]));
    fs.writeFileSync(changed, Buffer.from([4, 3, 2, 1]));
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Calculator', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: Number(args?.max_elements) === 1 ? changed : original,
        screenshot_width: 500, screenshot_height: 700,
        elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 0, y: 0, w: 500, h: 700 } }],
      });
      if (name === 'click') return result({ effect: 'delivered' });
      return result({ ok: true });
    });
    try {
      const runtime = new BimaxComputerRuntime(simulatedNative());
      await runtime.run({ action: 'open', app: 'Calculator' }, { cwd: '/tmp' });
      const refused = await runtime.run({ action: 'click', x: 200, y: 200, deliveryMode: 'background' }, { cwd: '/tmp' });
      expect(refused.ok).toBe(false);
      expect(refused.error).toMatch(/pixels changed.*refused before delivery/i);
      expect(callTool.mock.calls.some(([a]) => a.name === 'click')).toBe(false);
    } finally {
      fs.rmSync(original, { force: true });
      fs.rmSync(changed, { force: true });
    }
  });

  it('allows a raw pixel click when only pixels outside the intended target region changed', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const original = path.join(os.tmpdir(), `bimax-local-original-${Date.now()}.png`);
    const changed = path.join(os.tmpdir(), `bimax-local-changed-${Date.now()}.png`);
    fs.writeFileSync(original, Buffer.from([1, 2, 3, 4]));
    fs.writeFileSync(changed, Buffer.from([4, 3, 2, 1]));
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Calculator', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: Number(args?.max_elements) === 1 ? changed : original,
        screenshot_width: 500, screenshot_height: 700,
        elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 0, y: 0, w: 500, h: 700 } }],
      });
      if (name === 'click') return result({ effect: 'delivered' });
      return result({ ok: true });
    });
    const nativeRun = jest.fn(async (cmd: any) => {
      const base = { ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action };
      if (cmd.action !== 'visual_signatures') return base;
      return {
        ...base,
        summary: 'sampled stable local target',
        visualSignatures: [{
          id: cmd.regions[0].id,
          center_rgb: [30, 30, 30], median_rgb: [30, 30, 30],
          dominant: [{ rgb: [30, 30, 30], coverage: 1 }],
          oklab: [0.2, 0, 0], luminance: 0.2, chroma: 0,
          color_name: 'gray', entropy: 0.1, confidence: 1,
          sample_count: 100, source_color_space: 'sRGB',
        }],
      };
    });
    const native: any = {
      run: nativeRun,
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Calculator',
    };
    try {
      const runtime = new BimaxComputerRuntime(native);
      await runtime.run({ action: 'open', app: 'Calculator' }, { cwd: '/tmp' });
      const clicked = await runtime.run({ action: 'click', x: 200, y: 200, deliveryMode: 'background' }, { cwd: '/tmp' });
      expect(clicked.ok).toBe(true);
      const localSample = nativeRun.mock.calls.map(([cmd]) => cmd).find(
        cmd => cmd.action === 'visual_signatures' && cmd.regions?.[0]?.id === 'raw-target',
      );
      // Assert the PROPERTIES the comparison depends on, not the literal rectangle: a hardcoded
      // 152/152/96/96 pins whatever radius happened to be in the source and turns any correction to
      // it (such as making the fallback scale-relative instead of a fixed pixel count) into a
      // spurious failure.
      expect(localSample).toBeDefined();
      const region = localSample!.regions[0];
      expect(region.w).toBeGreaterThan(0);
      expect(region.h).toBeGreaterThan(0);
      expect(region.x).toBeGreaterThanOrEqual(0);
      expect(region.y).toBeGreaterThanOrEqual(0);
      // Contains the click, and is a genuine PATCH — materially smaller than the 500x700 window,
      // otherwise it could not distinguish local stability from whole-window animation.
      expect(region.x).toBeLessThanOrEqual(200);
      expect(region.y).toBeLessThanOrEqual(200);
      expect(region.x + region.w).toBeGreaterThanOrEqual(200);
      expect(region.y + region.h).toBeGreaterThanOrEqual(200);
      expect(region.w * region.h).toBeLessThan(500 * 700 * 0.1);
      expect(callTool.mock.calls.some(([a]) => a.name === 'click')).toBe(true);
    } finally {
      fs.rmSync(original, { force: true });
      fs.rmSync(changed, { force: true });
    }
  });

  it('attaches a typed no-change verification and a recovery hint when actions do not change the screen', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const tmp = path.join(os.tmpdir(), `bimax-verify-${Date.now()}.png`);
    fs.writeFileSync(tmp, Buffer.from([9, 9, 9, 9])); // identical bytes each observe → identical frameHash
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Calculator', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({ screenshot_file_path: tmp, screenshot_width: 500, screenshot_height: 700, elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 0, y: 0, w: 500, h: 700 } }] });
      return result({ ok: true });
    });
    try {
      const runtime = new BimaxComputerRuntime(simulatedNative());
      await runtime.run({ action: 'open', app: 'Calculator' });
      await runtime.run({ action: 'observe' });
      const c1 = await runtime.run({ action: 'click', x: 100, y: 100, deliveryMode: 'background' });
      expect(c1.progressCheck?.outcome).toBe('no-change'); // driver "succeeded" but the screen is unchanged
      await runtime.run({ action: 'click', x: 100, y: 100, deliveryMode: 'background' });
      const c3 = await runtime.run({ action: 'click', x: 100, y: 100, deliveryMode: 'background' });
      expect(c3.recoveryHint).toMatch(/no visible change/i); // 3 consecutive no-effect actions → nudge
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  // Live probing across five applications produced shapeRegions: 0 every time, which first read as
  // a gap. It was not: shape regions are foveated into ACTIONABLE controls that carry no label, and
  // every window probed had fully labeled controls, so the shape list was legitimately empty. The
  // path had simply never been exercised with input that reaches it. This does that, without
  // needing an application that happens to ship unlabeled buttons.
  it('foveates shape analysis into actionable controls that carry no label', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const tmp = path.join(os.tmpdir(), `bimax-shapes-${Date.now()}.png`);
    fs.writeFileSync(tmp, Buffer.from([3, 1, 4, 1, 5]));
    // Five actionable controls, none labeled — a toolbar of bare icons, in no particular app.
    const icons = [0, 1, 2, 3, 4].map(i => ({
      element_index: i + 1, element_token: `icon-${i}`, role: 'AXButton', label: '',
      frame: { x: 20 + i * 40, y: 12, w: 32, h: 32 },
    }));
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'App', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'App', active: true }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: tmp, screenshot_width: 500, screenshot_height: 700,
        elements: [{ element_index: 0, role: 'AXWindow', label: 'Window', frame: { x: 0, y: 0, w: 500, h: 700 } }, ...icons],
      });
      return result({ ok: true });
    });

    let analysisRegions: any[] = [];
    const native = {
      run: jest.fn(async (cmd: any) => {
        if (cmd.action === 'visual_analysis') {
          analysisRegions = cmd.regions || [];
          const shapeIds = analysisRegions.filter((r: any) => String(r.id).startsWith('shape-'));
          return {
            ok: true, action: cmd.action, driver: 'native-helper', summary: 'analysed',
            visualAnalysis: {
              texts: [],
              shapes: shapeIds.map((r: any) => ({
                id: r.id, contourCount: 12, topLevelCount: 3, rectangleCount: 1, kind: 'roundish',
                occupiedFrame: { x: r.x, y: r.y, w: r.w, h: r.h },
              })),
              latencyMs: 21,
            },
          };
        }
        return { ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action };
      }),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'App',
    } as any;

    try {
      const runtime = new BimaxComputerRuntime(native);
      await runtime.run({ action: 'open', app: 'App' });
      const observed = await runtime.run({ action: 'observe' });
      const foveated = (observed.details as any)?.perception?.foveated;

      expect(foveated.triggered).toBe(true); // a tree of unnamed actionables is the ambiguity case
      expect(foveated.shapeRegions).toBe(5); // one fovea per unlabeled control, not one per element
      // The window-wide OCR pass and the per-control shape regions are distinct requests.
      expect(analysisRegions.filter((r: any) => r.id === 'ocr-window')).toHaveLength(1);
      expect(analysisRegions.filter((r: any) => String(r.id).startsWith('shape-'))).toHaveLength(5);
      // Shape regions are screenshot pixels of the control, never the whole window.
      const first = analysisRegions.find((r: any) => r.id === 'shape-0');
      expect(first).toEqual(expect.objectContaining({ w: 32, h: 32 }));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  // An accessibility walk that returns nothing but menu-bar nodes has not observed the window — it
  // has observed the application's menu bar. Measured live, one app produced a 255-element
  // "observation" that was 100% AXMenuItem/AXMenu, with no window content and no frame, returned as
  // a successful observe. Two properties follow, and neither may name an application.
  describe('an observation with no window content is a failed acquisition, not a thin tree', () => {
    const menuOnly = [
      { element_index: 1, role: 'AXMenuBar', label: 'menu bar' },
      { element_index: 2, role: 'AXMenuBarItem', label: 'File' },
      { element_index: 3, role: 'AXMenu', label: 'File' },
      { element_index: 4, role: 'AXMenuItem', label: 'New Window' },
      { element_index: 5, role: 'AXMenuItem', label: 'Close' },
    ];
    const realWindow = [
      { element_index: 0, role: 'AXWindow', label: 'Document', frame: { x: 0, y: 0, w: 500, h: 700 } },
      { element_index: 6, role: 'AXButton', label: 'Send', frame: { x: 10, y: 10, w: 60, h: 24 } },
    ];

    it('re-derives the top window once and observes that instead', async () => {
      const fs = require('fs'), os = require('os'), path = require('path');
      const tmp = path.join(os.tmpdir(), `bimax-menuonly-${Date.now()}.png`);
      fs.writeFileSync(tmp, Buffer.from([1, 2, 3, 4]));
      // Window 7 is acquired at open, then replaced by window 11 before the observation runs — the
      // ordinary case of a window being closed and re-created underneath us. Observing 7 therefore
      // enumerates only the menu bar. Ownership (pid) never changes; only the window component does.
      const windowStateCalls: number[] = [];
      const sized = (id: number) => ({ window_id: id, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } });
      let liveWindows = [sized(7)];
      callTool.mockImplementation(async ({ name, arguments: args }: any) => {
        if (name === 'start_session') return result({ ok: true });
        if (name === 'launch_app') return result({ name: 'App', pid: 42, windows: [{ window_id: 7 }] });
        if (name === 'bring_to_front') return result({ activated: true });
        if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'App', active: true }] });
        if (name === 'list_windows') return result({ windows: liveWindows });
        if (name === 'get_window_state') {
          const windowId = Number(args?.window_id || 0);
          windowStateCalls.push(windowId);
          return result({
            screenshot_file_path: tmp, screenshot_width: 500, screenshot_height: 700,
            elements: windowId === 11 ? realWindow : menuOnly,
          });
        }
        return result({ ok: true });
      });
      try {
        const runtime = new BimaxComputerRuntime(simulatedNative());
        await runtime.run({ action: 'open', app: 'App' }); // pins window 7
        liveWindows = [sized(11)]; // …which is then closed and replaced before we observe
        windowStateCalls.length = 0;
        const observed = await runtime.run({ action: 'observe' });

        expect(windowStateCalls).toContain(11); // it went and got the real window
        expect(observed.windowId).toBe(11);
        expect(observed.degraded).toBeFalsy();
        expect((observed.elements as any[]).some(e => e.label === 'Send')).toBe(true);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });

    it('never offers menu-bar nodes as the targets of a window-scoped observation', async () => {
      const fs = require('fs'), os = require('os'), path = require('path');
      const tmp = path.join(os.tmpdir(), `bimax-menulie-${Date.now()}.png`);
      fs.writeFileSync(tmp, Buffer.from([5, 6, 7, 8]));
      // No other window exists, so reacquisition cannot help: the honest result is a degraded,
      // screenshot-only observation — not five menu items dressed up as window targets. They would
      // be addressable by token/index while the semantic resolver refuses to consider them.
      callTool.mockImplementation(async ({ name }: any) => {
        if (name === 'start_session') return result({ ok: true });
        if (name === 'launch_app') return result({ name: 'App', pid: 42, windows: [{ window_id: 7 }] });
        if (name === 'bring_to_front') return result({ activated: true });
        if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'App', active: true }] });
        if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
        if (name === 'get_window_state') return result({
          screenshot_file_path: tmp, screenshot_width: 500, screenshot_height: 700, elements: menuOnly,
        });
        return result({ ok: true });
      });
      try {
        const runtime = new BimaxComputerRuntime(simulatedNative());
        await runtime.run({ action: 'open', app: 'App' });
        const observed = await runtime.run({ action: 'observe' });

        expect(observed.degraded).toBe(true);
        expect(observed.elements).toEqual([]);
        const roles = (observed.elements as any[]).map(e => e.role);
        expect(roles).not.toContain('AXMenuItem');
        expect(roles).not.toContain('AXMenuBarItem');
        // Hidden means unaddressable, not merely omitted from the serialized observation. A
        // menu-only walk leaves no actionable handle, so the refusal names that and points at the
        // targeting modes that still work rather than telling the caller to observe again — which
        // for this window would loop forever.
        expect(runtime.describeTarget({ action: 'click', elementIndex: 4 })).toBeNull();
        const refused = await runtime.run({ action: 'click', elementIndex: 4 });
        expect(refused.ok).toBe(false);
        expect(refused.error).toMatch(/stale or missing|no actionable accessibility handles/i);
        expect(refused.error).not.toMatch(/observe again and use a handle/i);
        expect(observed.screenshot).toBeTruthy(); // the screenshot remains the source of truth
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });
  });

  // Right-click produced a menu nobody could see. Every menu role was dropped from the element map,
  // so the one thing a right-click exists to do was invisible — while the raw payload had carried the
  // menu, with frames and names, the whole time.
  //
  // The shapes below are the live Finder measurement of 2026-08-06 (see COMPUTER_USE_HANDOFF_LOG
  // section 17). macOS lays a menu out only while it is OPEN, so a frame is proof it is on screen:
  // with nothing open 321 of 330 menu nodes had no frame, with a context menu open 33 gained one.
  // That is why these fixtures differ only by frame — it is the whole discriminator.
  describe('an open menu is part of the window; the static menu bar is not', () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const windowContent = [
      { element_index: 0, role: 'AXWindow', label: 'Docs', frame: { x: 0, y: 0, w: 500, h: 700 } },
      { element_index: 1, role: 'AXButton', label: 'Send', frame: { x: 10, y: 10, w: 60, h: 24 } },
    ];
    // Always present, always laid out, and never the target of a window-scoped observation.
    const menuBar = [
      { element_index: 10, role: 'AXMenuBar', label: 'menu bar', frame: { x: 0, y: 0, w: 1470, h: 33 } },
      { element_index: 11, role: 'AXMenuBarItem', label: 'File', frame: { x: 106, y: 0, w: 42, h: 33 } },
      // Closed: its children exist in the tree but are not laid out.
      { element_index: 12, role: 'AXMenu', label: 'File' },
      { element_index: 13, role: 'AXMenuItem', label: 'New Finder Window' },
      { element_index: 14, role: 'AXMenuItem', label: 'Move to Trash' },
    ];
    const openContextMenu = [
      { element_index: 20, role: 'AXMenu', frame: { x: 587, y: 125, w: 269, h: 509 } },
      { element_index: 21, role: 'AXMenuItem', label: 'Open', frame: { x: 587, y: 130, w: 269, h: 24 } },
      { element_index: 22, role: 'AXMenuItem', label: 'Get Info', frame: { x: 587, y: 154, w: 269, h: 24 } },
      // A separator: laid out, thin, and carrying no name of any kind.
      { element_index: 23, role: 'AXMenuItem', frame: { x: 587, y: 178, w: 269, h: 11 } },
      // A submenu that has not been opened yet — laid out only once its parent is chosen.
      { element_index: 24, role: 'AXMenu', label: 'Open With' },
      { element_index: 25, role: 'AXMenuItem', label: 'TextEdit (default)' },
    ];

    const runWith = async (elements: unknown[], run: (runtime: BimaxComputerRuntime) => Promise<void>) => {
      const tmp = path.join(os.tmpdir(), `bimax-menu-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
      fs.writeFileSync(tmp, Buffer.from([1, 2, 3, 4]));
      callTool.mockImplementation(async ({ name }: any) => {
        if (name === 'start_session') return result({ ok: true });
        if (name === 'launch_app') return result({ name: 'Finder', pid: 42, windows: [{ window_id: 7 }] });
        if (name === 'bring_to_front') return result({ activated: true });
        if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'Finder', active: true }] });
        if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
        if (name === 'get_window_state') return result({
          screenshot_file_path: tmp, screenshot_width: 500, screenshot_height: 700, elements,
        });
        return result({ ok: true });
      });
      try {
        const runtime = new BimaxComputerRuntime(simulatedNative());
        await runtime.run({ action: 'open', app: 'Finder' });
        await run(runtime);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    };

    it('surfaces the commands of an open context menu, with their names', async () => {
      await runWith([...windowContent, ...menuBar, ...openContextMenu], async runtime => {
        const observed = await runtime.run({ action: 'observe' });
        const labels = (observed.elements as any[]).map(e => e.label);
        expect(labels).toContain('Open');
        expect(labels).toContain('Get Info');
        // The window's own content is not displaced by the menu.
        expect(labels).toContain('Send');
      });
    });

    it('keeps the static menu bar out, open menu or not', async () => {
      for (const elements of [
        [...windowContent, ...menuBar],                     // nothing open
        [...windowContent, ...menuBar, ...openContextMenu], // context menu open
      ]) {
        await runWith(elements, async runtime => {
          const observed = await runtime.run({ action: 'observe' });
          const roles = (observed.elements as any[]).map(e => e.role);
          expect(roles).not.toContain('AXMenuBar');
          expect(roles).not.toContain('AXMenuBarItem');
          const labels = (observed.elements as any[]).map(e => e.label);
          // Laid out ≠ visible-as-a-command: these live under a CLOSED menu-bar menu.
          expect(labels).not.toContain('New Finder Window');
        });
      }
    });

    it('offers nothing new when no menu is open', async () => {
      await runWith([...windowContent, ...menuBar], async runtime => {
        const observed = await runtime.run({ action: 'observe' });
        const roles = (observed.elements as any[]).map(e => e.role);
        expect(roles.filter(role => String(role).startsWith('AXMenu'))).toEqual([]);
      });
    });

    it('drops separators and unopened submenus, which activate nothing', async () => {
      await runWith([...windowContent, ...menuBar, ...openContextMenu], async runtime => {
        const observed = await runtime.run({ action: 'observe' });
        const items = (observed.elements as any[]).filter(e => e.role === 'AXMenuItem');
        // Open + Get Info only: the nameless separator would otherwise be handed a positional
        // placeholder that reads exactly like a real command.
        expect(items.map(e => e.label).sort()).toEqual(['Get Info', 'Open']);
        // The submenu's contents are not laid out until it is opened.
        expect((observed.elements as any[]).map(e => e.label)).not.toContain('TextEdit (default)');
      });
    });

    it('lets a menu command be clicked by name, and refuses the panel that holds it', async () => {
      await runWith([...windowContent, ...menuBar, ...openContextMenu], async runtime => {
        await runtime.run({ action: 'observe' });
        const clicked = await runtime.run({ action: 'click', query: 'Get Info' });
        expect(clicked.ok).toBe(true);
        expect(clicked.targeting?.label).toBe('Get Info');

        // The AXMenu panel is a container; the commands are its children.
        const panel = await runtime.run({ action: 'click', elementIndex: 20 });
        expect(panel.ok).toBe(false);
        expect(panel.error).toMatch(/structural container/i);
      });
    });
  });

  // A keystroke swallowed by an app-modal sheet is delivered and has no effect. Driving the runtime
  // directly during cross-app verification, a cleanup loop read `ok: true` as "it closed" and
  // pressed cmd+w five times against a save dialog that ate every one. The runtime was right and
  // the caller was wrong — but only because `delivered` is kept separate from `observed`. This
  // pins that separation on the KEY path; the test above covers clicks only.
  it('reports a no-effect key press as delivered but unproven, never as success', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const tmp = path.join(os.tmpdir(), `bimax-key-noop-${Date.now()}.png`);
    fs.writeFileSync(tmp, Buffer.from([9, 9, 9, 9])); // identical bytes each observe → no-change
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'TextEdit', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'TextEdit', active: true }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({ screenshot_file_path: tmp, screenshot_width: 500, screenshot_height: 700, elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 0, y: 0, w: 500, h: 700 } }] });
      return result({ ok: true });
    });
    // A local native fake: the shared simulatedNative() reports whichever app the surrounding
    // fixtures last activated, and the foreground key path refuses to act unless the target is
    // genuinely frontmost.
    const native = {
      run: jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action })),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'TextEdit',
    } as any;
    try {
      const runtime = new BimaxComputerRuntime(native);
      await runtime.run({ action: 'open', app: 'TextEdit' });
      const observed = await runtime.run({ action: 'observe' });
      const pressed = await runtime.run({ action: 'key', combo: 'cmd+w', frameId: observed.frameId, deliveryMode: 'foreground' });

      expect(pressed.ok).toBe(true); // the command ran — that is all ok means
      expect(pressed.actionReceipt?.commit.delivered).toBe(true); // the keystroke really was posted
      // …and none of that is allowed to read as the action having worked.
      expect(pressed.progressCheck?.outcome).toBe('no-change');
      expect(pressed.actionResult).toEqual(expect.objectContaining({ observed: 'no-change', confidence: 'unknown' }));
      expect(pressed.actionResult?.confidence).not.toBe('proven');
      expect(pressed.summary).toMatch(/did NOT change/i);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('bounds a stuck agent: refuses to keep acting once the recovery budget is exhausted, until it re-observes', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const tmp = path.join(os.tmpdir(), `bimax-recov-${Date.now()}.png`);
    fs.writeFileSync(tmp, Buffer.from([7, 7, 7, 7])); // identical bytes each observe → identical frameHash → no-change
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Calculator', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({ screenshot_file_path: tmp, screenshot_width: 500, screenshot_height: 700, elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 0, y: 0, w: 500, h: 700 } }] });
      return result({ ok: true });
    });
    try {
      const runtime = new BimaxComputerRuntime(simulatedNative());
      await runtime.run({ action: 'open', app: 'Calculator' });
      await runtime.run({ action: 'observe' });
      // Four no-effect clicks exhaust the no-progress budget (maxNoProgress = 4).
      let last: any;
      for (let i = 0; i < 4; i++) last = await runtime.run({ action: 'click', x: 100, y: 100, deliveryMode: 'background' });
      expect(last.recoveryDecision).toBe('stop-failure');

      // The NEXT acting verb is refused — the agent cannot keep hammering the stuck UI.
      const refused = await runtime.run({ action: 'click', x: 100, y: 100, deliveryMode: 'background' });
      expect(refused.ok).toBe(false);
      expect(refused.error).toMatch(/recovery budget exhausted/i);
      expect(callTool.mock.calls.filter(([a]) => a.name === 'click')).toHaveLength(4); // the 5th never reached the driver

      // Re-observing is the agent re-orienting itself — it resets the budget so real work can resume.
      await runtime.run({ action: 'observe' });
      const allowed = await runtime.run({ action: 'click', x: 100, y: 100, deliveryMode: 'background' });
      expect(allowed.ok).toBe(true);
      expect(callTool.mock.calls.filter(([a]) => a.name === 'click')).toHaveLength(5);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('records a durable, resumable session (action history + active surface persisted)', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-dur-'));
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'TextEdit', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({ screenshot_width: 700, screenshot_height: 800, elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 0, y: 0, w: 700, h: 800 } }] });
      return result({ ok: true });
    });
    try {
      const runtime = new BimaxComputerRuntime(simulatedNative());
      await runtime.run({ action: 'open', app: 'TextEdit', deliveryMode: 'background' }, { cwd });
      await runtime.run({ action: 'observe' }, { cwd });
      await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'background' }, { cwd });
      const hist = runtime.history();
      expect(hist.byAction.open).toBe(1);
      expect(hist.byAction.click).toBe(1);
      expect(runtime.sessionSummary().surface?.app).toBe('TextEdit');
      expect(runtime.memoryFootprint().historyKept).toBeGreaterThanOrEqual(2);
      // dispose persists a final snapshot; a fresh runtime can RESUME it after an interruption.
      await runtime.dispose();
      const resumed = new BimaxComputerRuntime(simulatedNative()).loadPersistedState(cwd);
      expect(resumed?.surface?.app).toBe('TextEdit');
      expect(resumed?.history.total).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('resumes the persisted history when a fresh runtime reopens the same app after an interruption', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-resume-'));
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'TextEdit', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({ screenshot_width: 700, screenshot_height: 800, elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 0, y: 0, w: 700, h: 800 } }] });
      return result({ ok: true });
    });
    try {
      // Session 1: act, then simulate an interruption. dispose persists the final snapshot.
      const first = new BimaxComputerRuntime(simulatedNative());
      await first.run({ action: 'open', app: 'TextEdit', deliveryMode: 'background' }, { cwd });
      await first.run({ action: 'click', x: 10, y: 10, deliveryMode: 'background' }, { cwd });
      const before = first.history().total;
      expect(before).toBeGreaterThanOrEqual(2);
      await first.dispose();

      // Session 2: a brand-new runtime opens the SAME app in the SAME cwd → history continues.
      const second = new BimaxComputerRuntime(simulatedNative());
      await second.run({ action: 'open', app: 'TextEdit', deliveryMode: 'background' }, { cwd });
      expect(second.history().total).toBe(before + 1); // continued, not reset to 1
      expect(second.history().byAction.open).toBe(2);   // one restored open + this one

      // Session 3: a DIFFERENT app must NOT inherit the prior app's history.
      callTool.mockImplementation(async ({ name }: any) => {
        if (name === 'start_session') return result({ ok: true });
        if (name === 'launch_app') return result({ name: 'Calculator', pid: 99, windows: [{ window_id: 3 }] });
        if (name === 'bring_to_front') return result({ activated: true });
        if (name === 'list_windows') return result({ windows: [{ window_id: 3, is_on_screen: true, bounds: { width: 500, height: 700 } }] });
        if (name === 'get_window_state') return result({ screenshot_width: 500, screenshot_height: 700, elements: [{ element_index: 0, role: 'AXWindow', frame: { x: 0, y: 0, w: 500, h: 700 } }] });
        return result({ ok: true });
      });
      const third = new BimaxComputerRuntime(simulatedNative());
      await third.run({ action: 'open', app: 'Calculator', deliveryMode: 'background' }, { cwd });
      expect(third.history().byAction.open).toBe(1); // fresh — different app, no resume
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('never forwards the search query to the driver, because that replaces the tree that names rows', async () => {
    // The driver answers a `query` with the matched node's ancestry INSTEAD of the window tree —
    // measured in Notes, 367 tree lines became 8 — while returning the identical element_index set.
    // Since the AXStaticText leaves live only in that tree, forwarding the query stripped the name
    // off every row except the searched one. It bit hardest on `postActionEvidence`, which re-
    // observes using the active expectation as its query, so the frame handed back after any action
    // carrying `expect` listed 46 indistinguishable `ICMNoteListCell`s.
    const rowTree = [
      '- [0] AXWindow "Notes" [id=_NS:6]',
      '  - [1] AXCell [id=ICMNoteListCell]',
      '    - AXStaticText = "Potatoes 1kg"',
      '  - [2] AXCell [id=ICMNoteListCell]',
      '    - AXStaticText = "Google Maps"',
    ].join('\n');
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Notes', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/bimax-window.png', screenshot_width: 500, screenshot_height: 700,
        tree_markdown: rowTree,
        elements: [
          { element_index: 1, element_token: 't1', role: 'AXCell', label: 'ICMNoteListCell', frame: { x: 0, y: 0, w: 200, h: 40 } },
          { element_index: 2, element_token: 't2', role: 'AXCell', label: 'ICMNoteListCell', frame: { x: 0, y: 40, w: 200, h: 40 } },
        ],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'Notes' });
    const observed = await runtime.run({ action: 'observe', query: 'Google Maps' });

    const stateCalls = callTool.mock.calls.filter(([arg]) => arg.name === 'get_window_state');
    expect(stateCalls.length).toBeGreaterThan(0);
    for (const [call] of stateCalls) expect(call.arguments).not.toHaveProperty('query');
    // The query still does its job — it is matched locally, over the elements the walk returned.
    expect(observed.verification).toEqual({ query: 'Google Maps', matched: true, matchCount: 1 });
    // BOTH rows keep the name the tree gave them, not just the one that was searched for.
    expect(observed.elements?.map((element: any) => element.label).sort())
      .toEqual(['Google Maps', 'Potatoes 1kg']);
  });

  it('refuses a background click on a control with no AX press action, and names the delivery that works', async () => {
    // A Notes row advertises `actions=[showmenu]` and no press, so background delivery cannot
    // activate it at all — the app answers AXPress with -25206. The raw driver string named an AX
    // constant and offered no next step, so the model reissued the identical call.
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Notes', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/bimax-window.png', screenshot_width: 500, screenshot_height: 700,
        tree_markdown: '- [1] AXCell [id=ICMNoteListCell]\n  - AXStaticText = "Potatoes 1kg"',
        elements: [{ element_index: 1, element_token: 't1', role: 'AXCell', label: 'ICMNoteListCell', frame: { x: 0, y: 0, w: 200, h: 40 } }],
      });
      if (name === 'click') throw new Error('AX action failed: AXUIElementPerformAction(AXPress) returned -25206');
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'Notes' });
    const clicked = await runtime.run({ action: 'click', query: 'Potatoes 1kg', deliveryMode: 'background' });
    expect(clicked.ok).toBe(false);
    expect(clicked.error).toContain('publishes no accessibility press action');
    // Says it is permanent, so the caller stops retrying, and names the delivery that does work.
    expect(clicked.error).toContain('retrying background delivery will fail identically');
    expect(clicked.error).toContain('deliveryMode="foreground"');
  });

  it('refuses BEFORE attempting when the tree already published the control actions', async () => {
    // The refusal above is correct but reactive: it only fires once the app has answered -25206, so
    // it costs a round trip and "fires on discovery". The tree states what each control publishes, so
    // when it says `actions=[showmenu]` the answer is already in the observation the caller planned
    // from. Same message, no attempt.
    const clicks: any[] = [];
    callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Notes', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/bimax-window.png', screenshot_width: 500, screenshot_height: 700,
        tree_markdown: '- [1] AXCell [id=ICMNoteListCell actions=[showmenu]]\n  - AXStaticText = "Potatoes 1kg"',
        elements: [{ element_index: 1, element_token: 't1', role: 'AXCell', label: 'ICMNoteListCell', frame: { x: 0, y: 0, w: 200, h: 40 } }],
      });
      if (name === 'click') { clicks.push(args); return result({ effect: 'delivered' }); }
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'Notes' });
    const clicked = await runtime.run({ action: 'click', query: 'Potatoes 1kg', deliveryMode: 'background' });

    expect(clicked.ok).toBe(false);
    expect(clicked.error).toContain('publishes no accessibility press action');
    expect(clicked.error).toContain('deliveryMode="foreground"');
    // It names the evidence it actually had, rather than an error the app never sent.
    expect(clicked.error).toContain('showmenu');
    expect(clicked.error).not.toContain('-25206');
    // And it never reached the driver.
    expect(clicks).toHaveLength(0);
  });

  it('tells the caller up front which controls cannot take a background press', async () => {
    // Measured live 2026-08-05: every one of Notes' 214 rows/cells publishes `showmenu` and no press,
    // while 30 of WhatsApp's 31 controls accept one. Saying so in the observation lets a caller pick
    // foreground BEFORE spending a turn on a refusal.
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Notes', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/bimax-window.png', screenshot_width: 500, screenshot_height: 700,
        tree_markdown: [
          '- [0] AXWindow "Notes" [actions=[raise]]',
          '  - [1] AXCell [id=ICMNoteListCell actions=[showmenu]]',
          '    - AXStaticText = "Potatoes 1kg"',
          '  - [2] AXButton "Compose" [actions=[press,showmenu]]',
          '  - [3] AXButton "Quiet" ',
        ].join('\n'),
        elements: [
          { element_index: 0, role: 'AXWindow', label: 'Notes', frame: { x: 0, y: 0, w: 500, h: 700 } },
          { element_index: 1, element_token: 't1', role: 'AXCell', label: 'ICMNoteListCell', frame: { x: 0, y: 0, w: 200, h: 40 } },
          { element_index: 2, element_token: 't2', role: 'AXButton', label: 'Compose', frame: { x: 0, y: 60, w: 80, h: 30 } },
          { element_index: 3, element_token: 't3', role: 'AXButton', label: 'Quiet', frame: { x: 0, y: 100, w: 80, h: 30 } },
        ],
      });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'Notes' });
    const observed = await runtime.run({ action: 'observe' });
    const byIndex = new Map((observed.elements as any[]).map(element => [element.element_index, element]));

    // Publishes showmenu only — the -25206 case, stated before anyone tries it.
    expect(byIndex.get(1).background_activatable).toBe(false);
    // Publishes press — no flag, because there is nothing to warn about.
    expect(byIndex.get(2).background_activatable).toBeUndefined();
    // The tree said nothing about this one; silence is not a "no".
    expect(byIndex.get(3).background_activatable).toBeUndefined();
    // The window is not a click target, so it is never flagged even though it lacks press.
    expect(byIndex.get(0).background_activatable).toBeUndefined();
  });

  it('does not pre-refuse a control the tree said nothing about, or one that can be pressed', async () => {
    // Silence is not a "no". Only an explicit action list without `press` is evidence.
    const attempted: string[] = [];
    const withTree = (tree: string) => async ({ name, arguments: args }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Notes', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/bimax-window.png', screenshot_width: 500, screenshot_height: 700,
        tree_markdown: tree,
        elements: [{ element_index: 1, element_token: 't1', role: 'AXCell', label: 'ICMNoteListCell', frame: { x: 0, y: 0, w: 200, h: 40 } }],
      });
      if (name === 'click') { attempted.push(String(args?.element_token || args?.element_index)); return result({ effect: 'delivered' }); }
      return result({ ok: true });
    };

    callTool.mockImplementation(withTree('- [1] AXCell [id=ICMNoteListCell]\n  - AXStaticText = "Potatoes 1kg"'));
    const silent = new BimaxComputerRuntime(simulatedNative());
    await silent.run({ action: 'open', app: 'Notes' });
    expect((await silent.run({ action: 'click', query: 'Potatoes 1kg', deliveryMode: 'background' })).ok).toBe(true);

    callTool.mockImplementation(withTree('- [1] AXCell [id=ICMNoteListCell actions=[press,showmenu]]\n  - AXStaticText = "Potatoes 1kg"'));
    const pressable = new BimaxComputerRuntime(simulatedNative());
    await pressable.run({ action: 'open', app: 'Notes' });
    expect((await pressable.run({ action: 'click', query: 'Potatoes 1kg', deliveryMode: 'background' })).ok).toBe(true);

    expect(attempted).toHaveLength(2);
  });

  it('refuses to control a different app until it is explicitly opened', async () => {
    const runtime = new BimaxComputerRuntime(simulatedNative());
    await runtime.run({ action: 'open', app: 'Calculator' });
    const clicked = await runtime.run({ action: 'click', app: 'System Settings', pid: 99, windowId: 4, x: 1, y: 1 });
    expect(clicked).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('target app mismatch') }));
    expect(callTool.mock.calls.some(([arg]) => arg.name === 'click')).toBe(false);
  });

  // These two drive the no-usable-window recovery, whose waits are real polling budgets, so they
  // legitimately run for several seconds. `list_windows` returns [] for the whole fixture, so every
  // one of those budgets runs to full timeout — that is the point of the fixture, and it is the
  // slowest path the runtime has.
  //
  // It got slower deliberately. Reaching Cmd+W/Cmd+N means CREATING USER DATA in a document app (an
  // empty note in Notes), so the runtime now proves the window is really absent first: a 2s
  // cold-launch grace, a non-destructive OS reopen event, then a 1.2s re-check. Paying ~3s to avoid
  // writing to the user's library is the intended trade, and this budget records it rather than
  // leaving the suite to fail on a busy machine. The assertions below are unchanged.
  it('close closes ONLY the selected window (Cmd+W) — never quits the application', async () => {
    const nativeRun = jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', app: 'Calculator', summary: 'key delivered' }));
    const native: any = { run: nativeRun, quickStatus: () => ({ driver: 'native-helper', ready: true }), frontmostApp: async () => 'Calculator' };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Calculator', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'hotkey') return result({ effect: 'delivered' });
      if (name === 'list_windows') return result({ windows: [] });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'Calculator' });
    const closed = await runtime.run({ action: 'close' });
    expect(closed.ok).toBe(true);
    expect(closed.summary).toContain('application still running');
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({ action: 'key', combo: 'cmd+w' }), undefined);
    expect(callTool.mock.calls.some(([a]) => a.name === 'hotkey')).toBe(false);
    expect(callTool).toHaveBeenCalledWith({ name: 'list_windows', arguments: { pid: 42 } });
  }, 30_000);

  it('quit_app is the separate action that quits the application and verifies it', async () => {
    const nativeRun = jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', app: 'Calculator', summary: 'key delivered' }));
    const native: any = { run: nativeRun, quickStatus: () => ({ driver: 'native-helper', ready: true }), frontmostApp: async () => 'Calculator' };
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Calculator', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'hotkey') return result({ effect: 'delivered' });
      if (name === 'list_windows') return result({ windows: [] });
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(native);
    await runtime.run({ action: 'open', app: 'Calculator' });
    const quit = await runtime.run({ action: 'quit_app' });
    expect(quit.ok).toBe(true);
    expect(quit.summary).toContain('quit');
    expect(nativeRun).toHaveBeenCalledWith(expect.objectContaining({ action: 'key', combo: 'cmd+q' }), undefined);
    expect(callTool.mock.calls.some(([a]) => a.name === 'hotkey')).toBe(false);
  }, 30_000);

  it('never exposes the upstream product name in model-visible failures', async () => {
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'health_report') return {
        isError: true, structuredContent: {}, content: [{ type: 'text', text: 'cua-driver failed' }],
      };
      return result({ ok: true });
    });
    const runtime = new BimaxComputerRuntime(simulatedNative());
    const status = await runtime.run({ action: 'status' });
    expect(status.ok).toBe(false);
    expect(JSON.stringify(status)).not.toMatch(/cua/i);
    expect(status.error).toContain('Bimax Computer Use');
  });

  describe('element map honesty', () => {
    const window = { element_index: 0, role: 'AXWindow', label: 'WhatsApp', frame: { x: 91, y: 33, w: 801, h: 864 } };
    // The real WhatsApp geometry: close/minimize/zoom are 12x14 buttons at the window's top-left.
    const trafficLights = [
      { element_index: 1, role: 'AXButton', frame: { x: 99, y: 40, w: 12, h: 14 } },
      { element_index: 2, role: 'AXButton', frame: { x: 119, y: 40, w: 12, h: 14 } },
      { element_index: 3, role: 'AXButton', frame: { x: 139, y: 40, w: 12, h: 14 } },
    ];

    it('never offers the window close/minimize/zoom buttons as click targets', () => {
      // These reached the model as `unlabeled Button near "New chat"` — named after a heading 248pt
      // away — so it clicked one expecting the New Chat control and reopened the same popover on
      // every retry. A click on one of these closes the window the task is running in.
      const kept = withoutWindowChrome([window, ...trafficLights,
        { element_index: 4, role: 'AXButton', frame: { x: 400, y: 800, w: 30, h: 30 } }]);
      expect(kept.map((e: any) => e.element_index)).toEqual([0, 4]);
    });

    it('keeps ordinary small buttons that merely sit high in the window', () => {
      // The rule is the window's top-left CORNER, not "small" and not "near the top".
      const toolbarButton = { element_index: 5, role: 'AXButton', frame: { x: 400, y: 40, w: 14, h: 14 } };
      expect(withoutWindowChrome([window, toolbarButton])).toHaveLength(2);
    });

    it('names an icon from text in its row or column, never from text across the window', () => {
      const heading = { element_index: 9, role: 'AXHeading', label: 'New chat', frame: { x: 343, y: 97, w: 59, h: 16 } };
      const icon = { element_index: 10, role: 'AXButton', frame: { x: 119, y: 90, w: 12, h: 14 } };
      const [, named] = describeUnlabeledControls([heading, icon]) as any[];
      // 224pt away on a 12pt-wide control: not its label, however close the flat radius said it was.
      expect(named.label).not.toMatch(/New chat/);
      expect(named.label).toMatch(/unlabeled Button/);

      const composer = { element_index: 11, role: 'AXStaticText', label: 'Type a message', frame: { x: 200, y: 800, w: 300, h: 20 } };
      const send = { element_index: 12, role: 'AXButton', frame: { x: 520, y: 802, w: 16, h: 16 } };
      const [, adjacent] = describeUnlabeledControls([composer, send]) as any[];
      expect(adjacent.label).toMatch(/right of "Type a message"/); // same row, genuinely its label
    });
  });

  describe('observe scan budget', () => {
    it('never pays for a deep walk up front, and escalates only when the walk yielded nothing', async () => {
      // Guards the COST PROPERTY rather than a constant: a routine observe must not exceed the
      // measured floor, and the deep scan must be reachable only through the escalation path.
      const caps: number[] = [];
      let starve = true;
      callTool.mockImplementation(async ({ name, arguments: args }: any) => {
        if (name === 'start_session') return result({ ok: true });
        if (name === 'launch_app') return result({ name: 'Notes', pid: 42, windows: [{ window_id: 7 }] });
        if (name === 'bring_to_front') return result({ activated: true });
        if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
        if (name === 'get_window_state') {
          const cap = Number(args?.max_elements || 0);
          caps.push(cap);
          // Simulate the menu-first driver: at the routine cap the walk fills with menu nodes only.
          const menuOnly = Array.from({ length: cap }, (_, i) => ({ element_index: i, role: 'AXMenuItem', label: `m${i}` }));
          const real = [{ element_index: 0, role: 'AXWindow', frame: { x: 0, y: 0, w: 500, h: 700 } }];
          return result({
            screenshot_file_path: '/tmp/notes.png', screenshot_width: 500, screenshot_height: 700,
            elements: starve && cap < 2000 ? menuOnly : real,
          });
        }
        return result({ ok: true });
      });
      const runtime = new BimaxComputerRuntime(simulatedNative());
      await runtime.run({ action: 'open', app: 'Notes' }, { cwd: '/tmp' });
      caps.length = 0;
      await runtime.run({ action: 'observe', maxElements: 60 }, { cwd: '/tmp' });
      expect(caps[0]).toBe(120);                    // routine observe: fast progressive first pass
      expect(caps[caps.length - 1]).toBe(2000);     // escalated only after the cheap walk starved
      starve = false;
      caps.length = 0;
      await runtime.run({ action: 'observe', maxElements: 60 }, { cwd: '/tmp' });
      // Readiness stability may repeat the same cheap pass, but it must never widen to the deep
      // 2000-node scan once content exists. The retry count is bounded by the readiness contract.
      expect(caps).toEqual([120, 120, 120]);
    });
  });

  describe('click occlusion gate', () => {
    const TARGET_PID = 42;
    const sidecar = () => async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Notes', pid: TARGET_PID, windows: [{ window_id: 7 }] });
      if (name === 'list_apps') return result({ apps: [{ pid: TARGET_PID, name: 'Notes', active: true }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 100, y: 50, width: 700, height: 800 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/notes.png', screenshot_width: 700, screenshot_height: 800,
        elements: [{ element_index: 1, role: 'AXWindow', frame: { x: 100, y: 50, w: 700, h: 800 } }],
      });
      if (name === 'click') return result({ effect: 'delivered' });
      return result({ ok: true });
    };

    /** A native fallback whose accessibility hit test the test controls. */
    const nativeWithRecipient = (recipients: Array<{ pid: number; name: string; windowId?: number; chain?: any[] }>) => {
      const probes: any[] = [];
      const run = jest.fn(async (cmd: any) => {
        const ok = (extra: any = {}) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action, ...extra });
        if (cmd.action === 'window_at') {
          probes.push({ x: cmd.x, y: cmd.y });
          const who = recipients[Math.min(probes.length - 1, recipients.length - 1)];
          return ok({ windowAt: { owner_pid: who.pid, owner_name: who.name, top_owner_name: who.name, window_id: who.windowId || 0, layer: 0, bounds: { x: 0, y: 0, w: 1, h: 1 }, element_chain: who.chain || [] } });
        }
        return ok({ x: cmd.x, y: cmd.y, app: 'Notes' });
      });
      return { run, probes, port: { run, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }), frontmostApp: async () => 'Notes' } as any };
    };

    const pipPort = (pid: number | null) => {
      const avoid = jest.fn();
      return { avoid, port: { sync: jest.fn(), stop: jest.fn(async () => undefined), status: () => ({ enabled: false, running: false, continuous: false, captureSafe: true }), pid: () => pid, avoid } as any };
    };

    it('refuses when another window would receive the click instead of the target', async () => {
      // The screenshot cannot show this: a single-window capture excludes whatever covers the
      // window, so the model sees the target's own pixels while the click lands somewhere else.
      callTool.mockImplementation(sidecar());
      const native = nativeWithRecipient([{ pid: 999, name: 'Finder' }]);
      const runtime = new BimaxComputerRuntime(native.port, pipPort(null).port);
      await runtime.run({ action: 'open', app: 'Notes', deliveryMode: 'foreground' }, { cwd: '/tmp' });
      const blocked = await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'foreground' }, { cwd: '/tmp' });
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toMatch(/Finder is on top of/i);
      expect(blocked.error).toMatch(/capture\s+excludes whatever covers the window/i);
    });

    it('proceeds when the accessibility hit test names the target', async () => {
      callTool.mockImplementation(sidecar());
      const native = nativeWithRecipient([{ pid: TARGET_PID, name: 'Notes' }]);
      const runtime = new BimaxComputerRuntime(native.port, pipPort(null).port);
      await runtime.run({ action: 'open', app: 'Notes', deliveryMode: 'foreground' }, { cwd: '/tmp' });
      const click = await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'foreground' }, { cwd: '/tmp' });
      expect(click.ok).toBe(true);
    });

    it('refuses another window in the same application process', async () => {
      callTool.mockImplementation(sidecar());
      const native = nativeWithRecipient([{ pid: TARGET_PID, name: 'Notes', windowId: 99 }]);
      const runtime = new BimaxComputerRuntime(native.port, pipPort(null).port);
      await runtime.run({ action: 'open', app: 'Notes', deliveryMode: 'foreground' }, { cwd: '/tmp' });
      const blocked = await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'foreground' }, { cwd: '/tmp' });
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toMatch(/live point is in Notes window 99.*target is window 7/i);
      expect((native.run as jest.Mock).mock.calls.filter(([cmd]) => cmd.action === 'click')).toHaveLength(0);
    });

    it('refuses a stale semantic element when the live AX chain names a different control', async () => {
      const base = sidecar();
      callTool.mockImplementation(async (arg: any) => {
        if (arg.name === 'get_window_state') return result({
          screenshot_file_path: '/tmp/notes.png', screenshot_width: 700, screenshot_height: 800,
          elements: [
            { element_index: 1, role: 'AXWindow', frame: { x: 100, y: 50, w: 700, h: 800 } },
            { element_index: 2, element_token: 'save', role: 'AXButton', label: 'Save', enabled: true,
              frame: { x: 200, y: 200, w: 80, h: 32 } },
          ],
        });
        return base(arg);
      });
      const native = nativeWithRecipient([{
        pid: TARGET_PID, name: 'Notes',
        chain: [{ pid: TARGET_PID, role: 'AXButton', title: 'Delete', enabled: true,
          frame: { x: 200, y: 200, w: 80, h: 32 } }],
      }]);
      const runtime = new BimaxComputerRuntime(native.port, pipPort(null).port);
      await runtime.run({ action: 'open', app: 'Notes', deliveryMode: 'foreground' }, { cwd: '/tmp' });
      const blocked = await runtime.run({ action: 'click', query: 'Save', deliveryMode: 'foreground' }, { cwd: '/tmp' });
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toMatch(/element preflight refused/i);
      expect(blocked.error).toMatch(/Delete/);
      expect((native.run as jest.Mock).mock.calls.filter(([cmd]) => cmd.action === 'click')).toHaveLength(0);
    });

    it('moves the Live Preview out of the way rather than refusing', async () => {
      // Raising cannot beat a floating panel — Apple documents floating windows as staying above a
      // window that performs kAXRaiseAction — so the panel has to step aside.
      callTool.mockImplementation(sidecar());
      const PIP_PID = 555;
      // The first probe is observation-time exact-window reconciliation; the next two are the
      // action preflight before and after moving the PiP aside.
      const native = nativeWithRecipient([
        { pid: PIP_PID, name: 'bimax-live-pip' },
        { pid: PIP_PID, name: 'bimax-live-pip' },
        { pid: TARGET_PID, name: 'Notes' },
      ]);
      const pip = pipPort(PIP_PID);
      const runtime = new BimaxComputerRuntime(native.port, pip.port);
      await runtime.run({ action: 'open', app: 'Notes', deliveryMode: 'foreground' }, { cwd: '/tmp' });
      const click = await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'foreground' }, { cwd: '/tmp' });
      expect(click.ok).toBe(true);
      expect(pip.avoid).toHaveBeenCalledWith(expect.objectContaining({ x: 100, y: 50, w: 700, h: 800 }));
    });

    it('does not veto when the hit test cannot answer', async () => {
      // A guard that cannot see must not block input — that failure direction is what turned a
      // geometric modal guess into "every click in this app is refused".
      callTool.mockImplementation(sidecar());
      const failing: any = {
        run: jest.fn(async (cmd: any) => {
          if (cmd.action === 'window_at') throw new Error('native helper unavailable');
          return { ok: true, action: cmd.action, driver: 'native-helper', x: cmd.x, y: cmd.y, app: 'Notes', summary: cmd.action };
        }),
        quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
        frontmostApp: async () => 'Notes',
      };
      const runtime = new BimaxComputerRuntime(failing, pipPort(null).port);
      await runtime.run({ action: 'open', app: 'Notes', deliveryMode: 'foreground' }, { cwd: '/tmp' });
      const click = await runtime.run({ action: 'click', x: 10, y: 10, deliveryMode: 'foreground' }, { cwd: '/tmp' });
      expect(click.ok).toBe(true);
    });
  });

  describe('modal blocker detection', () => {
    /** An app that enumerates a smaller child window inside its main window — the Electron shape. */
    const withChildWindow = () => async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'WhatsApp', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_windows') return result({ windows: [
        { window_id: 7, is_on_screen: true, bounds: { x: 100, y: 50, width: 800, height: 860 } },
        // Smaller, and geometrically inside the main window — indistinguishable from a sheet by shape.
        { window_id: 9, is_on_screen: true, bounds: { x: 300, y: 300, width: 300, height: 200 } },
      ] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/whatsapp.png', screenshot_width: 800, screenshot_height: 860,
        tree_markdown: 'Mom 2',
        elements: [
          { element_index: 0, element_token: 'window', role: 'AXWindow', frame: { x: 100, y: 50, w: 800, h: 860 } },
          { element_index: 4, element_token: 'attach', role: 'AXButton', label: 'Attach', frame: { x: 120, y: 800, w: 40, h: 40 } },
        ],
      });
      if (name === 'click') return result({ effect: 'delivered' });
      return result({ ok: true });
    };

    /** A native fallback whose OS-level modality answer the test controls. */
    const modalNative = (modalFrame?: { x: number; y: number; w: number; h: number }) => {
      const run = jest.fn(async (cmd: any) => {
        if (cmd.action === 'modal_frame') return { ok: true, action: cmd.action, driver: 'native-helper', summary: 'probe', modalFrame };
        return { ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action };
      });
      return { run, native: { run, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }), frontmostApp: async () => 'WhatsApp' } as any };
    };

    it('does not treat an ordinary contained child window as a modal blocker', async () => {
      // The regression: shape alone decided this, so every click outside the child window's
      // rectangle was refused with "a foreground dialog is blocking that background point" —
      // in an app that had no dialog open at all. macOS is the authority, not the rectangle.
      callTool.mockImplementation(withChildWindow());
      const native = modalNative(undefined); // the OS reports no modal
      const runtime = new BimaxComputerRuntime(native.native);
      await runtime.run({ action: 'open', app: 'WhatsApp' }, { cwd: '/tmp' });
      expect((runtime as any).transientDialogFrame).toBeNull();
      expect(native.run).toHaveBeenCalledWith(expect.objectContaining({ action: 'modal_frame', pid: 42 }));
    });

    it('guards background points when macOS confirms a real modal', async () => {
      callTool.mockImplementation(withChildWindow());
      const runtime = new BimaxComputerRuntime(modalNative({ x: 300, y: 300, w: 300, h: 200 }).native);
      await runtime.run({ action: 'open', app: 'WhatsApp' }, { cwd: '/tmp' });
      expect((runtime as any).transientDialogFrame).toEqual({ x: 300, y: 300, w: 300, h: 200 });
    });

    it('never invents a blocker when the modality probe itself fails', async () => {
      // No helper, or no Accessibility permission. An absent guard costs one refused click that the
      // OS would have blocked anyway; a phantom guard blocks every click in the app.
      callTool.mockImplementation(withChildWindow());
      const failing = { run: jest.fn(async () => { throw new Error('native helper unavailable'); }) } as any;
      failing.quickStatus = () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true });
      failing.frontmostApp = async () => 'WhatsApp';
      const runtime = new BimaxComputerRuntime(failing);
      await runtime.run({ action: 'open', app: 'WhatsApp' }, { cwd: '/tmp' });
      expect((runtime as any).transientDialogFrame).toBeNull();
    });
  });

  /**
   * An overlay window blocks the PIXEL ROUTE to a control, not the control's identity. Measured live:
   * Control Center covered a conversation title and every click on it was refused forever, so the
   * target was unreachable even though the OS could still activate it. The pixel route and the
   * element identity fail independently, and only one of them had actually failed.
   */
  describe('an occluded point re-routes a named target through accessibility', () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const button = { element_index: 4, element_token: 'send-token', role: 'AXButton', label: 'Send', frame: { x: 100, y: 200, w: 80, h: 32 } };
    const windowElement = { element_index: 0, role: 'AXWindow', label: 'Chat', frame: { x: 0, y: 0, w: 500, h: 700 } };

    /** Screens that differ every capture, so a re-routed click can prove it changed something. */
    const changingScreens = () => {
      let capture = 0;
      return () => {
        const file = path.join(os.tmpdir(), `bimax-occl-${process.pid}-${capture}.png`);
        fs.writeFileSync(file, Buffer.from([capture, capture, capture, capture]));
        capture++;
        return file;
      };
    };
    /** One unchanging screen, so a re-routed click can prove only that nothing happened. */
    const staticScreen = () => {
      const file = path.join(os.tmpdir(), `bimax-occl-static-${process.pid}.png`);
      fs.writeFileSync(file, Buffer.from([5, 5, 5, 5]));
      return () => file;
    };

    const driverWith = (nextScreen: () => string) => async ({ name }: any) => {
      if (name === 'start_session') return result({ ok: true });
      if (name === 'launch_app') return result({ name: 'Chat', pid: 42, windows: [{ window_id: 7 }] });
      if (name === 'bring_to_front') return result({ activated: true });
      if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'Chat', active: true }] });
      if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
      if (name === 'get_window_state') return result({
        screenshot_file_path: nextScreen(), screenshot_width: 500, screenshot_height: 700,
        elements: [windowElement, button],
      });
      return result({ ok: true });
    };

    /** A native helper whose accessibility hit test always names someone else at the point. */
    const occludedNative = () => {
      const run = jest.fn(async (cmd: any) => {
        if (cmd.action === 'window_at') {
          return { ok: true, action: cmd.action, driver: 'native-helper', summary: 'hit', windowAt: {
            owner_pid: 999, owner_name: 'Control Center', window_id: 11, top_owner_name: 'Control Center',
          } };
        }
        return { ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action };
      });
      return { run, quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }), frontmostApp: async () => 'Chat' } as any;
    };

    const clickCalls = () => callTool.mock.calls
      .map(([call]: any) => call)
      .filter((call: any) => call.name === 'click')
      .map((call: any) => call.arguments);

    afterEach(() => {
      for (const file of fs.readdirSync(os.tmpdir())) {
        if (file.startsWith(`bimax-occl-${process.pid}`) || file.startsWith(`bimax-occl-static-${process.pid}`)) {
          fs.rmSync(path.join(os.tmpdir(), file), { force: true });
        }
      }
    });

    it('activates the element with no coordinates and discloses the switch', async () => {
      callTool.mockImplementation(driverWith(changingScreens()));
      const runtime = new BimaxComputerRuntime(occludedNative());
      await runtime.run({ action: 'open', app: 'Chat' }, { cwd: '/tmp' });
      const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
      const clicked = await runtime.run(
        { action: 'click', query: 'Send', frameId: observed.frameId, deliveryMode: 'foreground' },
        { cwd: '/tmp' },
      );

      expect(clicked.ok).toBe(true);
      expect(clicked.summary).toMatch(/Control Center covers that point/);
      expect(clicked.summary).toMatch(/activated through accessibility/);
      // The occluder is named in the receipt rather than buried: the click really did not reach the
      // point, and a later reader must be able to see which mechanism delivered it.
      expect(clicked.actionReceipt?.preflight).toEqual(expect.objectContaining({
        recipientApp: 'Control Center', recipientPid: 999, windowMatched: false,
      }));
      expect(runtime.lastMechanism()).toBe('accessibility');
      // Delivery addressed the element, never a coordinate.
      const routed = clickCalls().find((args: any) => args.element_token === 'send-token');
      expect(routed).toBeDefined();
      expect(routed.x).toBeUndefined();
      expect(routed.y).toBeUndefined();
      await runtime.dispose();
    });

    it('reports an honest failure when accessibility activation changes nothing', async () => {
      // AX activation is measurably weaker than a real CGEvent — it no-ops in some apps. Trusting the
      // driver's return would convert a permanently refused click into a permanently false success.
      callTool.mockImplementation(driverWith(staticScreen()));
      const runtime = new BimaxComputerRuntime(occludedNative());
      await runtime.run({ action: 'open', app: 'Chat' }, { cwd: '/tmp' });
      const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
      const clicked = await runtime.run(
        { action: 'click', query: 'Send', frameId: observed.frameId, deliveryMode: 'foreground' },
        { cwd: '/tmp' },
      );

      expect(clicked.ok).toBe(false);
      expect(clicked.error).toMatch(/Control Center is on top of/);
      expect(clicked.error).toMatch(/changed nothing on screen, so the click did not happen/);
      await runtime.dispose();
    });

    it('still refuses a raw-pixel click, which has no element to activate', async () => {
      // A static screen so the raw-pixel freshness guard passes and the occlusion guard is what
      // actually answers; with changing pixels the click is refused one step earlier for staleness.
      callTool.mockImplementation(driverWith(staticScreen()));
      const runtime = new BimaxComputerRuntime(occludedNative());
      await runtime.run({ action: 'open', app: 'Chat' }, { cwd: '/tmp' });
      const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
      const clicked = await runtime.run(
        { action: 'click', x: 140, y: 216, frameId: observed.frameId, deliveryMode: 'foreground' },
        { cwd: '/tmp' },
      );

      expect(clicked.ok).toBe(false);
      expect(clicked.error).toMatch(/Control Center is on top of/);
      expect(clicked.error).toMatch(/Move or close that window/);
      await runtime.dispose();
    });

    it('never downgrades a right-click or a double-click into a plain activation', async () => {
      // An AX activation is a press. Silently substituting it would deliver a DIFFERENT action than
      // the caller asked for — worse than refusing, because the caller cannot tell.
      callTool.mockImplementation(driverWith(changingScreens()));
      const runtime = new BimaxComputerRuntime(occludedNative());
      await runtime.run({ action: 'open', app: 'Chat' }, { cwd: '/tmp' });

      const rightClick = await runtime.run(
        { action: 'click', query: 'Send', button: 'right', frameId: (await runtime.run({ action: 'observe' }, { cwd: '/tmp' })).frameId, deliveryMode: 'foreground' },
        { cwd: '/tmp' },
      );
      expect(rightClick.ok).toBe(false);
      expect(rightClick.error).toMatch(/Control Center is on top of/);

      const doubleClick = await runtime.run(
        { action: 'click', query: 'Send', count: 2, frameId: (await runtime.run({ action: 'observe' }, { cwd: '/tmp' })).frameId, deliveryMode: 'foreground' },
        { cwd: '/tmp' },
      );
      expect(doubleClick.ok).toBe(false);
      expect(doubleClick.error).toMatch(/Control Center is on top of/);
      await runtime.dispose();
    });
  });

  /**
   * "Focus a text field first" is only actionable when the window HAS one. Calculator, games and
   * shortcut-driven apps expose no editable element and are driven by typing straight at the window;
   * refusing there removed the only way to interact, and it is why `npm run test:computer` could not
   * get past its own type step at the v1.0.10 release commit.
   */
  describe('literal typing into a surface with no editable field', () => {
    const fs = require('fs'), os = require('os'), path = require('path');

    const driverFor = (elements: unknown[]) => {
      let capture = 0;
      return async ({ name }: any) => {
        if (name === 'start_session') return result({ ok: true });
        if (name === 'launch_app') return result({ name: 'Calculator', pid: 42, windows: [{ window_id: 7 }] });
        if (name === 'bring_to_front') return result({ activated: true });
        if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'Calculator', active: true }] });
        if (name === 'list_windows') return result({ windows: [{ window_id: 7, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }] });
        if (name === 'get_window_state') {
          const file = path.join(os.tmpdir(), `bimax-nofield-${process.pid}-${capture}.png`);
          fs.writeFileSync(file, Buffer.from([capture, capture, capture, capture]));
          capture++;
          return result({ screenshot_file_path: file, screenshot_width: 500, screenshot_height: 700, elements });
        }
        return result({ ok: true });
      };
    };

    /** A helper whose focused element is a non-editable display, as Calculator's genuinely is. */
    const nonEditableFocus = () => ({
      run: jest.fn(async (cmd: any) => {
        if (cmd.action === 'focused_element') {
          return {
            ok: true, action: cmd.action, driver: 'native-helper', summary: 'focus',
            app: 'Calculator', pid: 42,
            focusedElement: { pid: 42, role: 'AXUnknown', editable: false },
            focusChain: [],
          };
        }
        return { ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action };
      }),
      quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
      frontmostApp: async () => 'Calculator',
    } as any);

    afterEach(() => {
      for (const file of fs.readdirSync(os.tmpdir())) {
        if (file.startsWith(`bimax-nofield-${process.pid}`)) fs.rmSync(path.join(os.tmpdir(), file), { force: true });
      }
    });

    it('types at the window when the frame exposes no editable element anywhere', async () => {
      callTool.mockImplementation(driverFor([
        { element_index: 0, role: 'AXWindow', label: 'Calculator', frame: { x: 0, y: 0, w: 500, h: 700 } },
        { element_index: 1, role: 'AXStaticText', label: '0', frame: { x: 20, y: 20, w: 200, h: 40 } },
      ]));
      const runtime = new BimaxComputerRuntime(nonEditableFocus());
      await runtime.run({ action: 'open', app: 'Calculator' }, { cwd: '/tmp' });
      const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
      const typed = await runtime.run(
        { action: 'type', text: '1271*170+104', frameId: observed.frameId, deliveryMode: 'foreground' },
        { cwd: '/tmp' },
      );
      expect(typed.ok).toBe(true);
      await runtime.dispose();
    });

    it('still refuses when the frame does expose a field and focus is somewhere else', async () => {
      // Here "focus a text field first" is real advice, so the guard must keep its teeth.
      callTool.mockImplementation(driverFor([
        { element_index: 0, role: 'AXWindow', label: 'Chat', frame: { x: 0, y: 0, w: 500, h: 700 } },
        { element_index: 1, role: 'AXTextField', label: 'Message', frame: { x: 20, y: 600, w: 400, h: 30 } },
      ]));
      const runtime = new BimaxComputerRuntime(nonEditableFocus());
      await runtime.run({ action: 'open', app: 'Calculator' }, { cwd: '/tmp' });
      const observed = await runtime.run({ action: 'observe' }, { cwd: '/tmp' });
      const typed = await runtime.run(
        { action: 'type', text: 'hi', frameId: observed.frameId, deliveryMode: 'foreground' },
        { cwd: '/tmp' },
      );
      expect(typed.ok).toBe(false);
      expect(typed.error).toMatch(/is not editable; focus a text field first/);
      await runtime.dispose();
    });
  });

  describe('app-agnostic background Menu isolation', () => {
    const menuDriver = () => async ({ name }: any) => {
      if (name === 'start_session' || name === 'set_agent_cursor_enabled') return result({ ok: true });
      if (name === 'launch_app') return result({
        name: 'TargetApp', pid: 42, windows: [{ window_id: 7, title: 'Target' }],
      });
      if (name === 'list_windows') return result({
        windows: [{ window_id: 7, title: 'Target', is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 700 } }],
      });
      if (name === 'get_window_state') return result({
        screenshot_file_path: '/tmp/bimax-menu-target.png', screenshot_width: 500, screenshot_height: 700,
        elements: [{ element_index: 1, element_token: 'target:1', role: 'AXButton', label: 'Action' }],
      });
      return result({ ok: true });
    };

    const foregroundFixture = () => {
      let frontmost = 'Bimax';
      const native: any = {
        run: jest.fn(async (cmd: any) => {
          if (cmd.action === 'open' && cmd.app) frontmost = cmd.app;
          return { ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action };
        }),
        quickStatus: () => ({ driver: 'native-helper', ready: true, accessibility: true, screenRecording: true }),
        frontmostApp: async () => frontmost,
      };
      return { native, frontmost: () => frontmost, setFrontmost: (app: string) => { frontmost = app; } };
    };

    it('AX-activates a generic app command while preserving Bimax as frontmost', async () => {
      callTool.mockImplementation(menuDriver());
      const fixture = foregroundFixture();
      const runtime = new BimaxComputerRuntime(fixture.native);
      await runtime.run({ action: 'open', app: 'TargetApp', deliveryMode: 'background' }, { cwd: '/tmp' });
      (runtime as any).menuSurface.activateAndConfirm = jest.fn(async () => ({
        title: 'Do Action', confirmed: true, elapsedMs: 1,
      }));

      const activated = await runtime.run({
        action: 'menu_activate', menuPath: '2.3', deliveryMode: 'background',
      }, { cwd: '/tmp' });

      expect(activated.ok).toBe(true);
      expect(activated.details).toEqual(expect.objectContaining({
        foregroundInvariant: expect.objectContaining({ preserved: true, before: 'Bimax', after: 'Bimax' }),
      }));
      expect(fixture.frontmost()).toBe('Bimax');
      await runtime.dispose();
    });

    it('stops and restores the human app if a background menu command steals focus', async () => {
      callTool.mockImplementation(menuDriver());
      const fixture = foregroundFixture();
      const runtime = new BimaxComputerRuntime(fixture.native);
      await runtime.run({ action: 'open', app: 'TargetApp', deliveryMode: 'background' }, { cwd: '/tmp' });
      (runtime as any).menuSurface.activateAndConfirm = jest.fn(async () => {
        fixture.setFrontmost('TargetApp');
        return { title: 'Do Action', confirmed: null, elapsedMs: 1 };
      });

      const activated = await runtime.run({
        action: 'menu_activate', menuPath: '2.3', deliveryMode: 'background',
      }, { cwd: '/tmp' });

      expect(activated).toMatchObject({
        ok: false,
        actionResult: { delivered: true, observed: 'failed', confidence: 'proven' },
        details: {
          code: 'background_focus_changed',
          foregroundInvariant: { preserved: false, before: 'Bimax', after: 'TargetApp', restored: true },
        },
      });
      expect(fixture.frontmost()).toBe('Bimax');
      expect(fixture.native.run).toHaveBeenCalledWith(expect.objectContaining({ action: 'open', app: 'Bimax' }), { cwd: '/tmp' });
      await runtime.dispose();
    });

    it('opens generic Search through Menu in the background and stops before ungrounded typing', async () => {
      callTool.mockImplementation(menuDriver());
      const fixture = foregroundFixture();
      const runtime = new BimaxComputerRuntime(fixture.native);
      await runtime.run({ action: 'open', app: 'TargetApp', deliveryMode: 'background' }, { cwd: '/tmp' });
      (runtime as any).observedElements = [];
      (runtime as any).menuSurface.snapshot = jest.fn(async () => ({
        app: 'TargetApp', menus: ['Edit'], elapsedMs: 1,
        commands: [{
          title: 'Search', rawTitle: 'Search', path: ['Edit', 'Search'], indexPath: [2, 4],
          menu: 'Edit', enabled: true, hasSubmenu: false, destructive: false,
        }],
      }));
      (runtime as any).menuSurface.activate = jest.fn(async () => ({ title: 'Search' }));
      (runtime as any).observeTarget = jest.fn(async () => {
        (runtime as any).observedElements = [];
        return { ok: true, action: 'observe', driver: 'test', frameId: 'fresh-search-frame' };
      });

      const searched = await runtime.run({
        action: 'menu_search', searchText: 'needle', query: 'Wanted Result', expect: 'Selected',
        deliveryMode: 'background',
      }, { cwd: '/tmp' });

      expect(searched).toMatchObject({
        ok: false,
        details: {
          code: 'search_field_missing_after_open',
          transaction: [
            { stage: 'open_search', ok: true, foregroundInvariant: { preserved: true, before: 'Bimax', after: 'Bimax' } },
            { stage: 'type', ok: false },
          ],
        },
        actionResult: { delivered: true, observed: 'failed', confidence: 'proven' },
      });
      expect((runtime as any).menuSurface.activate).toHaveBeenCalledWith('TargetApp', [2, 4], undefined);
      expect(callTool.mock.calls.some(([request]) => request.name === 'type_text')).toBe(false);
      expect(fixture.frontmost()).toBe('Bimax');
      await runtime.dispose();
    });
  });
});
