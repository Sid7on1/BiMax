/**
 * The `mac_control` argument contract, exercised through the tool the model actually calls.
 *
 * `validateModelComputerCommand` existed, was unit-tested, and had NO production caller on this
 * path: the Desktop tool sanitized its arguments and went straight to the runtime. These tests
 * pin the entry point rather than the pure function, because the pure function was never the
 * thing that was broken.
 */
import { compatibilityTool } from '../server';
import type { DesktopCapabilityGovernor } from '../provider.policy';

jest.mock('../session.manager', () => ({
  globalComputerSessionManager: {
    forSession: () => ({
      run: (...args: any[]) => {
        (globalThis as any).__runtimeReached = args;
        return Promise.resolve({ ok: true, action: 'noop' });
      },
    }),
  },
}));

jest.mock('../takeover.authority', () => ({ refreshTakeoverAuthority: async () => {} }));
jest.mock('../native.input.interlock', () => ({
  globalNativeInputInterlock: { state: () => ({ paused: false, reason: '' }) },
}));

function toolUnderTest() {
  const approvals: any[] = [];
  const governor = {
    approveTaskExecution: async (...args: any[]) => { approvals.push(args); },
  } as unknown as DesktopCapabilityGovernor;
  return { tool: compatibilityTool('/tmp', governor), approvals };
}

beforeEach(() => { (globalThis as any).__runtimeReached = undefined; });

describe('mac_control refuses ambiguous arguments before the runtime sees them', () => {
  /**
   * The exact command from the live 2026-08-18 "send hi to my mom using Messages" run. It carried
   * two selectors; elementToken silently won, missed, and the model was told its handle was stale —
   * so it re-sent the same malformed call three times and burned the turn.
   */
  it('names the colliding selectors instead of reporting a stale handle', async () => {
    const { tool, approvals } = toolUnderTest();
    const out = JSON.parse(await tool.execute({
      app: 'Messages', action: 'type', text: 'Hi Mom2',
      elementToken: 's0001:2', elementIndex: 2,
      frameId: 'f1-60545-39304', windowId: 39304, pid: 60545,
    } as any, { cwd: '/tmp', sessionId: 't' } as any));

    expect(out.ok).toBe(false);
    expect(out.code).toBe('invalid_arguments');
    expect(out.error).toContain('elementToken + elementIndex');
    expect(out.error).not.toContain('stale');
    // The refusal must be free: no runtime call, and no approval slot spent on a malformed command.
    expect((globalThis as any).__runtimeReached).toBeUndefined();
    expect(approvals).toHaveLength(0);
  });

  it('still delivers a well-formed single-selector command', async () => {
    const { tool } = toolUnderTest();
    const out = JSON.parse(await tool.execute({
      app: 'Messages', action: 'type', text: 'hi', query: 'Mom 2',
    } as any, { cwd: '/tmp', sessionId: 't' } as any));

    expect(out.ok).toBe(true);
    expect((globalThis as any).__runtimeReached?.[0]).toMatchObject({ action: 'type', query: 'Mom 2' });
  });

  it('folds the browser-style {action:"press", key:"return"} payload onto combo', async () => {
    const { tool } = toolUnderTest();
    await tool.execute({ action: 'press', key: 'return' } as any, { cwd: '/tmp', sessionId: 't' } as any);
    expect((globalThis as any).__runtimeReached?.[0]).toMatchObject({ action: 'key', combo: 'return' });
  });

  it('accepts the {type:{...}} envelope rather than calling it an unknown action', async () => {
    const { tool } = toolUnderTest();
    const out = JSON.parse(await tool.execute(
      { type: { text: 'hi', query: 'Mom 2' } } as any,
      { cwd: '/tmp', sessionId: 't' } as any,
    ));
    expect(out.code).not.toBe('invalid_action');
    expect((globalThis as any).__runtimeReached?.[0]).toMatchObject({ action: 'type', text: 'hi' });
  });
});
