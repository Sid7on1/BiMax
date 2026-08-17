import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate from the developer's real ~/.breakglass — computerApprovals there would otherwise
// change what the gating tests observe.
const testBreakglass = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-computer-tool-test-'));
process.env.BIMAX_BREAKGLASS_DIR = testBreakglass;

import { appNamesMatch, scaleNormalizedPoint, DesktopRuntimePort, DesktopResult, PUBLIC_DESKTOP_ACTIONS } from '../computer/desktop.runtime';
import { screenshotFromToolResult } from '../core/multimodal';
import { IGovernor } from '../core/interfaces';
import { createComputerTool } from '../tools/implementations/computer.tool';
import { COMPUTER_ACTION_CONTRACTS } from '../computer/action.contract';
import { __resetConfigForTests } from '../cli/config';

afterAll(() => { try { fs.rmSync(testBreakglass, { recursive: true, force: true }); } catch { /* tmp */ } });

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;

function fakeRuntime(overrides: Partial<DesktopResult> = {}): DesktopRuntimePort {
  return {
    run: jest.fn().mockImplementation(async (cmd: any): Promise<DesktopResult> => ({
      ok: true, action: cmd.action, driver: 'fake', app: cmd.app, summary: `${cmd.action} done`, ...overrides,
    })),
    quickStatus: jest.fn().mockReturnValue({ driver: 'fake', ready: true, accessibility: null, screenRecording: null }),
    frontmostApp: jest.fn().mockResolvedValue('Notes'),
  };
}

describe('live preview state is reported, not left to imagination', () => {
  // The preview is presentation-only — no verb can look at it. Asked what it was showing, a model
  // with nothing to read answered anyway, naming an app after every switch in two real sessions.
  // An observation therefore carries the runtime's own view of the preview.
  const runtimeWithPip = (pip: any): DesktopRuntimePort => ({
    run: jest.fn(async (cmd: any): Promise<DesktopResult> => ({
      ok: true, action: cmd.action, driver: 'fake', summary: `${cmd.action} done`,
    })),
    quickStatus: jest.fn().mockReturnValue({ driver: 'fake', ready: true }),
    frontmostApp: jest.fn().mockResolvedValue('Notes'),
    pipStatus: jest.fn(async () => pip),
  } as any);

  it('names the surface the preview is actually showing', async () => {
    const tool = createComputerTool(governor, runtimeWithPip({ enabled: true, running: true, surface: 'Calculator window 6748' }));
    const out = JSON.parse(await tool.execute({ action: 'observe' }, undefined as any));
    expect(out.preview).toContain('Calculator window 6748');
  });

  it('says so when the preview is enabled but not running', async () => {
    const tool = createComputerTool(governor, runtimeWithPip({ enabled: true, running: false }));
    const out = JSON.parse(await tool.execute({ action: 'observe' }, undefined as any));
    expect(out.preview).toMatch(/not currently running/);
  });

  it('never fails an observation because the preview could not be read', async () => {
    const broken = runtimeWithPip(null);
    (broken as any).pipStatus = jest.fn(async () => { throw new Error('pip is gone'); });
    const tool = createComputerTool(governor, broken);
    const out = JSON.parse(await tool.execute({ action: 'observe' }, undefined as any));
    expect(out.ok).toBe(true);
    expect(out.preview).toBeUndefined();
  });
});

describe('ComputerTool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetConfigForTests();
    fs.rmSync(path.join(testBreakglass, 'config.json'), { force: true });
  });

  function setApprovals(mode: string): void {
    fs.mkdirSync(testBreakglass, { recursive: true });
    fs.writeFileSync(path.join(testBreakglass, 'config.json'), JSON.stringify({ computerApprovals: mode }));
    __resetConfigForTests();
  }

  it('exposes and forwards every public desktop action from the shared action contract', async () => {
    const runtime = fakeRuntime();
    const tool = createComputerTool(governor, runtime);
    expect(tool.schema.properties.action.enum).toEqual([...PUBLIC_DESKTOP_ACTIONS]);
    expect(new Set(PUBLIC_DESKTOP_ACTIONS).size).toBe(PUBLIC_DESKTOP_ACTIONS.length);

    for (const action of PUBLIC_DESKTOP_ACTIONS) {
      const command: any = { action, app: 'Fixture App' };
      if (action === 'click') Object.assign(command, { x: 10, y: 20, frameId: 'frame-fixture' });
      if (action === 'type') command.text = 'fixture';
      if (action === 'key') command.combo = 'return';
      if (action === 'set_value') Object.assign(command, { elementIndex: 1, value: 'fixture' });
      if (action === 'drag') Object.assign(command, { x: 10, y: 20, toX: 30, toY: 40, frameId: 'frame-fixture' });
      if (action === 'scroll') command.dy = 50;
      if (['hover', 'hold', 'mouse_down', 'mouse_up'].includes(action)) {
        Object.assign(command, { x: 10, y: 20, frameId: 'frame-fixture' });
      }
      if (action === 'move') Object.assign(command, { x: 10, y: 20 });
      if (action === 'arrange') command.layout = 'center';
      await tool.execute(command, { cwd: process.cwd() });
    }

    expect((runtime.run as jest.Mock).mock.calls.map(([command]) => command.action))
      .toEqual([...PUBLIC_DESKTOP_ACTIONS]);
  });

  it('gives every public action its own complete model-facing contract', () => {
    expect(Object.keys(COMPUTER_ACTION_CONTRACTS)).toEqual([...PUBLIC_DESKTOP_ACTIONS]);
    for (const action of PUBLIC_DESKTOP_ACTIONS) {
      const spec = COMPUTER_ACTION_CONTRACTS[action];
      expect(spec.purpose).toBeTruthy();
      expect(spec.input).toBeTruthy();
      expect(spec.returns).toBeTruthy();
      expect(createComputerTool(governor, fakeRuntime()).description).toContain(`${action}: ${spec.purpose}`);
    }
  });

  it('rejects unframed raw coordinates before approval or runtime delivery', async () => {
    const runtime = fakeRuntime();
    const tool = createComputerTool(governor, runtime);
    const out = JSON.parse(await tool.execute({ action: 'click', x: 10, y: 20 }, { cwd: process.cwd() }));
    expect(out).toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/require frameId/) }));
    expect(runtime.run).not.toHaveBeenCalled();
    expect((governor.approveTaskExecution as jest.Mock).mock.calls.some(([kind]) => kind === 'COMPUTER_CONTROL')).toBe(false);
  });

  it('sends compact action evidence to the model, not runtime diagnostics or duplicate guidance', async () => {
    const runtime = fakeRuntime({
      screenshot: '/tmp/shot.png', frameId: 'frame-1', pid: 12, windowId: 34,
      elements: [{ elementIndex: 1, role: 'AXButton', label: 'Continue' }],
      tree: 'large duplicate accessibility tree',
      completionGuidance: 'large duplicate generic guidance',
      details: { transportDump: 'large native response' },
    });
    const out = JSON.parse(await createComputerTool(governor, runtime).execute({ action: 'observe' }, { cwd: process.cwd() }));
    expect(out).toEqual(expect.objectContaining({ screenshot: '/tmp/shot.png', frameId: 'frame-1', pid: 12, windowId: 34 }));
    expect(out.elements).toHaveLength(1);
    expect(out).not.toHaveProperty('tree');
    expect(out).not.toHaveProperty('completionGuidance');
    expect(out).not.toHaveProperty('details');
  });

  it('maps normalized 0–1000 coordinates to screen points, clamped', () => {
    expect(scaleNormalizedPoint(500, 1470)).toBe(735);
    expect(scaleNormalizedPoint(0, 1470)).toBe(0);
    expect(scaleNormalizedPoint(1000, 956)).toBe(956);
    expect(scaleNormalizedPoint(-50, 1470)).toBe(0);
    expect(scaleNormalizedPoint(2000, 1470)).toBe(1470);
  });

  it('compares app names without case or the .app suffix', () => {
    expect(appNamesMatch('Calculator', 'calculator.app')).toBe(true);
    expect(appNamesMatch('Terminal', 'Calculator')).toBe(false);
  });

  it('ignores invisible bidi format marks in app names (macOS 26 reports "‎WhatsApp")', () => {
    // Real failure: frontmost was "‎WhatsApp" (leading LEFT-TO-RIGHT MARK), the target
    // "WhatsApp" — every keyboard action died on "could not focus WhatsApp; frontmost app is
    // WhatsApp" with the two names rendering identically. trim() does not remove format marks.
    expect(appNamesMatch('‎WhatsApp', 'WhatsApp')).toBe(true);
    expect(appNamesMatch('⁦WhatsApp⁩', 'whatsapp.app')).toBe(true);
    expect(appNamesMatch('‎Terminal', 'WhatsApp')).toBe(false);
    expect(appNamesMatch('‎', 'WhatsApp')).toBe(false); // marks-only never matches anything
  });

  it('keeps routine acting verbs governor-visible; prompting follows the user-owned approvals mode', async () => {
    // Both halves are pinned explicitly because the default is 'always' (every action faces the
    // human) and the routine auto-approve path only exists under 'high-impact-only'. A earlier
    // version of this test asserted the routine metadata while running under the 'always'
    // default — it only passed when the DEVELOPER's real config said 'high-impact-only'.
    const { loadConfig, saveConfig } = require('../cli/config');

    // Default mode: the click is governor-approved and destructive-flagged (it will prompt).
    __resetConfigForTests();
    fs.rmSync(path.join(testBreakglass, 'config.json'), { force: true });
    (governor.approveTaskExecution as jest.Mock).mockClear();
    const runtime = fakeRuntime();
    const tool = createComputerTool(governor, runtime);
    await tool.execute({ action: 'screenshot' }, { cwd: process.cwd() });
    await tool.execute({ action: 'cursor' }, { cwd: process.cwd() });
    await tool.execute({ action: 'status' }, { cwd: process.cwd() });
    // Observation verbs never reach the CU-specific classification at all.
    expect((governor.approveTaskExecution as jest.Mock).mock.calls.filter(c => c[0] === 'COMPUTER_CONTROL')).toHaveLength(0);

    await tool.execute({ action: 'click', x: 10, y: 20, frameId: 'fresh', app: 'Notes' }, { cwd: process.cwd() });
    expect(governor.approveTaskExecution).toHaveBeenCalledWith('COMPUTER_CONTROL', expect.objectContaining({
      tool: 'ComputerTool', action: 'click', app: 'Notes', isDestructive: true,
    }));

    // User-owned routine mode: the same click is still governor-VISIBLE (the call happens, with
    // full metadata) but classified non-destructive, so it flows without a prompt.
    await loadConfig();
    await saveConfig({ computerApprovals: 'high-impact-only' });
    (governor.approveTaskExecution as jest.Mock).mockClear();
    await tool.execute({ action: 'click', x: 10, y: 20, frameId: 'fresh', app: 'Notes' }, { cwd: process.cwd() });
    expect(governor.approveTaskExecution).toHaveBeenCalledWith('COMPUTER_CONTROL', expect.objectContaining({
      tool: 'ComputerTool', action: 'click', app: 'Notes', isDestructive: false,
    }));
    __resetConfigForTests();
  });

  it('does not let pointer movement, scrolling, or permission requests bypass the governor', async () => {
    const runtime = fakeRuntime();
    const tool = createComputerTool(governor, runtime);
    for (const action of ['scroll', 'move', 'hover', 'request_access'] as const) {
      await tool.execute({ action, x: 10, y: 20, dy: 120, frameId: 'fresh' }, { cwd: process.cwd() });
    }
    const gated = (governor.approveTaskExecution as jest.Mock).mock.calls
      .filter(([kind]) => kind === 'COMPUTER_CONTROL')
      .map(([, payload]) => payload.action);
    expect(gated).toEqual(['scroll', 'move', 'hover', 'request_access']);
  });

  it('normalizes verb synonyms BEFORE gating, so an alias cannot bypass approval', async () => {
    setApprovals('always');
    const runtime = fakeRuntime();
    const tool = createComputerTool(governor, runtime);

    // "press" is a synonym for the GATED verb `key`. Were the alias resolved downstream of the
    // gate, this would sail through as an unrecognized, ungated action and then execute as a
    // keystroke — an approval bypass reachable from plain model vocabulary.
    await tool.execute({ action: 'press', combo: 'return', app: 'Notes' } as any, { cwd: process.cwd() });
    expect(governor.approveTaskExecution).toHaveBeenCalledWith('COMPUTER_CONTROL', expect.objectContaining({
      tool: 'ComputerTool', action: 'key',
    }));
    expect((runtime.run as jest.Mock).mock.calls[0][0]).toEqual(expect.objectContaining({ action: 'key' }));
  });

  it('accepts browser-style press key payloads as native key combos', async () => {
    setApprovals('always');
    const runtime = fakeRuntime();
    const tool = createComputerTool(governor, runtime);

    await tool.execute({ action: 'press', key: 'return', app: 'Safari' } as any, { cwd: process.cwd() });

    expect((runtime.run as jest.Mock).mock.calls[0][0]).toEqual(expect.objectContaining({
      action: 'key', combo: 'return', app: 'Safari',
    }));
  });

  it('always approvals mode keeps routine acting verbs prompt-worthy', async () => {
    setApprovals('always');
    const tool = createComputerTool(governor, fakeRuntime());

    await tool.execute({ action: 'click', x: 10, y: 20, frameId: 'fresh' }, { cwd: process.cwd() });
    expect(governor.approveTaskExecution).toHaveBeenCalledWith('COMPUTER_CONTROL', expect.objectContaining({
      action: 'click', isDestructive: true,
    }));
  });

  it('high-impact-only approvals: routine actions flow without a prompt, high-impact still asks', async () => {
    setApprovals('high-impact-only');
    const tool = createComputerTool(governor, fakeRuntime());

    // Routine click → still governor-visible (sensitive-target floor runs) but not prompt-worthy.
    await tool.execute({ action: 'click', x: 10, y: 20, frameId: 'fresh' }, { cwd: process.cwd() });
    expect(governor.approveTaskExecution).toHaveBeenCalledWith('COMPUTER_CONTROL', expect.objectContaining({
      action: 'click', isDestructive: false,
    }));

    // Typing text that matches the high-impact intent (a delete) keeps the human in the loop.
    jest.clearAllMocks();
    await tool.execute({ action: 'type', text: 'delete all my files', app: 'Notes' }, { cwd: process.cwd() });
    expect(governor.approveTaskExecution).toHaveBeenCalledWith('COMPUTER_CONTROL', expect.objectContaining({
      action: 'type', highImpact: true, isDestructive: true,
    }));
  });

  it('plan mode ignores high-impact-only and keeps every acting verb destructive', async () => {
    setApprovals('high-impact-only');
    const planGovernor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined), mode: 'plan' } as unknown as IGovernor;
    const tool = createComputerTool(planGovernor, fakeRuntime());
    await tool.execute({ action: 'click', x: 10, y: 20, frameId: 'fresh' }, { cwd: process.cwd() });
    expect(planGovernor.approveTaskExecution).toHaveBeenCalledWith('COMPUTER_CONTROL', expect.objectContaining({
      action: 'click', isDestructive: true,
    }));
  });

  it('scopes the open action to the app being opened, not the current frontmost one', async () => {
    const tool = createComputerTool(governor, fakeRuntime());
    await tool.execute({ action: 'open', app: 'Calculator' }, { cwd: process.cwd() });
    expect(governor.approveTaskExecution).toHaveBeenCalledWith('COMPUTER_CONTROL', expect.objectContaining({
      action: 'open', app: 'Calculator',
    }));
  });

  it('scopes an open-by-bundleId action to the bundle id, never the stale frontmost app', async () => {
    // Regression: intendedApp only looked at args.app, so open-by-bundleId fell through to
    // frontmostApp() — the approval prompt named whatever app was still focused (e.g. the
    // terminal) instead of what was actually about to be opened. Live-PTY repro against the
    // packaged binary reproduced this verbatim: "Allow? open in ComputerTool @ ghostty" when the
    // model opened Calculator by bundle id alone.
    const runtime = fakeRuntime();
    const tool = createComputerTool(governor, runtime);
    await tool.execute({ action: 'open', bundleId: 'com.apple.calculator' }, { cwd: process.cwd() });
    expect(governor.approveTaskExecution).toHaveBeenCalledWith('COMPUTER_CONTROL', expect.objectContaining({
      action: 'open', app: 'com.apple.calculator',
    }));
    expect(runtime.frontmostApp).not.toHaveBeenCalled();
  });

  it('locks later keyboard input and cleanup to the most recently opened app', async () => {
    const runtime = fakeRuntime();
    const tool = createComputerTool(governor, runtime);
    await tool.execute({ action: 'open', app: 'Calculator' }, { cwd: process.cwd() });
    await tool.execute({ action: 'type', text: '2+2' }, { cwd: process.cwd() });
    await tool.execute({ action: 'key', combo: 'return' }, { cwd: process.cwd() });
    await tool.execute({ action: 'close' }, { cwd: process.cwd() });

    const calls = (runtime.run as jest.Mock).mock.calls.map(([cmd]) => cmd);
    expect(calls.slice(1)).toEqual([
      expect.objectContaining({ action: 'type', app: 'Calculator' }),
      expect.objectContaining({ action: 'key', app: 'Calculator' }),
      expect.objectContaining({ action: 'close', app: 'Calculator' }),
    ]);
    const approvals = (governor.approveTaskExecution as jest.Mock).mock.calls
      .filter(([kind]) => kind === 'COMPUTER_CONTROL')
      .map(([, payload]) => payload);
    expect(approvals.every((payload: any) => payload.app === 'Calculator')).toBe(true);
  });

  it('scopes copy, paste, and arrange to the owned app instead of the approval UI', async () => {
    const runtime = fakeRuntime();
    const tool = createComputerTool(governor, runtime);
    await tool.execute({ action: 'open', app: 'Calculator' }, { cwd: process.cwd() });
    jest.clearAllMocks();

    await tool.execute({ action: 'copy' }, { cwd: process.cwd() });
    await tool.execute({ action: 'paste' }, { cwd: process.cwd() });
    await tool.execute({ action: 'arrange', layout: 'left' }, { cwd: process.cwd() });

    const calls = (runtime.run as jest.Mock).mock.calls.map(([cmd]) => cmd);
    expect(calls).toEqual([
      expect.objectContaining({ action: 'copy', app: 'Calculator' }),
      expect.objectContaining({ action: 'paste', app: 'Calculator' }),
      expect.objectContaining({ action: 'arrange', app: 'Calculator' }),
    ]);
    const approvals = (governor.approveTaskExecution as jest.Mock).mock.calls
      .filter(([kind]) => kind === 'COMPUTER_CONTROL')
      .map(([, payload]) => payload);
    expect(approvals).toHaveLength(3);
    expect(approvals.every((payload: any) => payload.app === 'Calculator')).toBe(true);
    expect(runtime.frontmostApp).not.toHaveBeenCalled();
  });

  it('flags high-impact intent (send/purchase/delete wording) so the governor always prompts', async () => {
    const tool = createComputerTool(governor, fakeRuntime());
    const controlCalls = () => (governor.approveTaskExecution as jest.Mock).mock.calls.filter(call => call[0] === 'COMPUTER_CONTROL');
    await tool.execute({ action: 'key', combo: 'cmd+return' }, { cwd: process.cwd() });
    expect(controlCalls()[0][1].highImpact).toBeUndefined();

    await tool.execute({ action: 'type', text: 'confirm purchase now' }, { cwd: process.cwd() });
    const payload = controlCalls()[1][1];
    expect(payload.highImpact).toBe(true);
    expect(payload.impactReason).toBeTruthy();
  });

  it('classifies a fresh semantic target before asking the governor', async () => {
    const runtime = fakeRuntime();
    runtime.describeTarget = jest.fn().mockReturnValue({ label: 'Delete account', role: 'AXButton' });
    const tool = createComputerTool(governor, runtime);
    await tool.execute({ action: 'click', app: 'Settings', pid: 12, windowId: 9, elementToken: 'fresh' }, { cwd: process.cwd() });
    expect(governor.approveTaskExecution).toHaveBeenCalledWith('COMPUTER_CONTROL', expect.objectContaining({
      action: 'click', highImpact: true, impactReason: expect.stringContaining('Delete'),
    }));
  });

  it('does not act when the governor vetoes', async () => {
    const veto = { approveTaskExecution: jest.fn().mockRejectedValue(new Error('vetoed')) } as unknown as IGovernor;
    const runtime = fakeRuntime();
    const tool = createComputerTool(veto, runtime);
    await expect(tool.execute({ action: 'click', x: 1, y: 1, frameId: 'fresh' }, { cwd: process.cwd() })).rejects.toThrow('vetoed');
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it('feeds screenshots into the vision observation loop via the shared extractor', async () => {
    const runtime = fakeRuntime({ screenshot: '/tmp/shot.png' });
    const tool = createComputerTool(governor, runtime);
    const output = await tool.execute({ action: 'screenshot' }, { cwd: process.cwd() });
    expect(screenshotFromToolResult('ComputerTool', output)).toBe('/tmp/shot.png');
    // The extractor is SHAPE-keyed, not tool-name-keyed: any structured {ok, screenshot} result
    // is evidence, and attribution cannot be spoofed by a tool NAME — only by emitting the shape.
    // A ReadTool-shaped result (no screenshot field) therefore yields nothing.
    expect(screenshotFromToolResult('ReadTool', JSON.stringify({ ok: true, path: '/tmp/x.ts' }))).toBeNull();
    expect(screenshotFromToolResult('ComputerTool', 'plain non-JSON output')).toBeNull();
  });

  it('keeps delivery mode user-owned and forwards modifier-click selection', async () => {
    const runtime = fakeRuntime();
    const tool = createComputerTool(governor, runtime);
    await tool.execute({
      action: 'click', x: 10, y: 20, frameId: 'fresh', deliveryMode: 'background', modifier: ['cmd'],
    }, { cwd: process.cwd() });

    expect(runtime.run).toHaveBeenCalledWith(expect.objectContaining({
      action: 'click', x: 10, y: 20, modifier: ['cmd'],
    }), expect.anything());
    expect((runtime.run as jest.Mock).mock.calls[0][0]).not.toHaveProperty('deliveryMode');
  });
});

describe('ComputerTool whole-display recording approval is unforgeable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetConfigForTests();
    fs.rmSync(path.join(testBreakglass, 'config.json'), { force: true });
  });

  it('strips model-supplied approveFullDisplay/fullDisplayToken and mints a token only after governor approval', async () => {
    const authorize = jest.fn().mockReturnValue('governor-minted-token');
    const runtime: DesktopRuntimePort = {
      run: jest.fn().mockImplementation(async (cmd: any): Promise<DesktopResult> => ({
        ok: true, action: cmd.action, driver: 'fake', summary: 'ok',
      })),
      quickStatus: jest.fn().mockReturnValue({ driver: 'fake', ready: true, accessibility: null, screenRecording: null }),
      frontmostApp: jest.fn().mockResolvedValue('Notes'),
      recordingScopePreview: jest.fn().mockReturnValue({ scope: 'whole display', captureSafe: false }),
      authorizeFullDisplayRecording: authorize,
    };
    const tool = createComputerTool(governor, runtime);

    // The model tries to self-authorize with a boolean AND a forged token. Both must be stripped;
    // the runtime must receive ONLY the token the approval layer minted after governor approval.
    await tool.execute({ action: 'record_start', approveFullDisplay: true, fullDisplayToken: 'model-forged' } as any, { cwd: '/tmp' });
    const sent = (runtime.run as jest.Mock).mock.calls[0][0];
    expect(sent.approveFullDisplay).toBeUndefined();
    expect(sent.fullDisplayToken).toBe('governor-minted-token');
    // The governor prompt stated the TRUE whole-display scope, high-impact.
    const approval = (governor.approveTaskExecution as jest.Mock).mock.calls.find(c => c[0] === 'COMPUTER_CONTROL');
    expect(approval[1].highImpact).toBe(true);
    expect(approval[1].impactReason).toMatch(/WHOLE-DISPLAY/);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it('a governor DENY means no token is ever minted and the runtime is never called', async () => {
    const authorize = jest.fn();
    const deny = { approveTaskExecution: jest.fn().mockRejectedValue(new Error('denied')) } as unknown as IGovernor;
    const runtime: DesktopRuntimePort = {
      run: jest.fn(),
      quickStatus: jest.fn().mockReturnValue({ driver: 'fake', ready: true, accessibility: null, screenRecording: null }),
      frontmostApp: jest.fn().mockResolvedValue('Notes'),
      recordingScopePreview: jest.fn().mockReturnValue({ scope: 'whole display', captureSafe: false }),
      authorizeFullDisplayRecording: authorize,
    };
    const tool = createComputerTool(deny, runtime);
    await expect(tool.execute({ action: 'record_start' } as any, { cwd: '/tmp' })).rejects.toThrow(/denied/);
    expect(authorize).not.toHaveBeenCalled();
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it('a window-scoped recording never mints a whole-display token', async () => {
    const authorize = jest.fn();
    const runtime: DesktopRuntimePort = {
      run: jest.fn().mockImplementation(async (cmd: any): Promise<DesktopResult> => ({ ok: true, action: cmd.action, driver: 'fake', summary: 'ok' })),
      quickStatus: jest.fn().mockReturnValue({ driver: 'fake', ready: true, accessibility: null, screenRecording: null }),
      frontmostApp: jest.fn().mockResolvedValue('Notes'),
      recordingScopePreview: jest.fn().mockReturnValue({ scope: 'Notes window 7', captureSafe: true }),
      authorizeFullDisplayRecording: authorize,
    };
    const tool = createComputerTool(governor, runtime);
    await tool.execute({ action: 'record_start' } as any, { cwd: '/tmp' });
    expect(authorize).not.toHaveBeenCalled();
    const sent = (runtime.run as jest.Mock).mock.calls[0][0];
    expect(sent.fullDisplayToken).toBeUndefined();
  });

  it('treats an explicit display capture as whole-display even while a window is owned', async () => {
    const authorize = jest.fn().mockReturnValue('display-token');
    const preview = jest.fn().mockReturnValue({ scope: 'whole display', captureSafe: false });
    const runtime: DesktopRuntimePort = {
      run: jest.fn().mockImplementation(async (cmd: any): Promise<DesktopResult> => ({ ok: true, action: cmd.action, driver: 'fake', summary: 'ok' })),
      quickStatus: jest.fn().mockReturnValue({ driver: 'fake', ready: true, accessibility: null, screenRecording: null }),
      frontmostApp: jest.fn().mockResolvedValue('Fixture App'),
      recordingScopePreview: preview,
      authorizeFullDisplayRecording: authorize,
    };
    const tool = createComputerTool(governor, runtime);
    await tool.execute({ action: 'record_start', captureScope: 'display' }, { cwd: '/tmp' });
    expect(preview).toHaveBeenCalledWith('display');
    expect(authorize).toHaveBeenCalledTimes(1);
    expect((runtime.run as jest.Mock).mock.calls[0][0]).toEqual(expect.objectContaining({
      captureScope: 'display', fullDisplayToken: 'display-token',
    }));
  });
});
