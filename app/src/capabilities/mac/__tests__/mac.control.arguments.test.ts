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

describe('mac_control canonicalizes proven duplicate handles and refuses real ambiguity', () => {
  /**
   * The exact shape from the live Messages/WhatsApp runs. Bimax exposed two spellings of one handle,
   * the model copied both, and the provider refused the spoon-fed target before doing useful work.
   */
  it('collapses the token/index pair copied from one observed element', async () => {
    const { tool, approvals } = toolUnderTest();
    const out = JSON.parse(await tool.execute({
      app: 'Messages', action: 'type', text: 'Hi Mom2',
      elementToken: 's0001:2', elementIndex: 2,
      frameId: 'f1-60545-39304', windowId: 39304, pid: 60545,
    } as any, { cwd: '/tmp', sessionId: 't' } as any));

    expect(out.ok).toBe(true);
    expect((globalThis as any).__runtimeReached?.[0]).toMatchObject({
      action: 'type', elementToken: 's0001:2',
    });
    expect((globalThis as any).__runtimeReached?.[0]).not.toHaveProperty('elementIndex');
    expect(approvals).toHaveLength(1);
  });

  it('still names and refuses a token/index pair that identifies different elements', async () => {
    const { tool, approvals } = toolUnderTest();
    const out = JSON.parse(await tool.execute({
      app: 'Messages', action: 'type', text: 'Hi Mom2',
      elementToken: 's0001:19', elementIndex: 2,
      frameId: 'f1-60545-39304', windowId: 39304, pid: 60545,
    } as any, { cwd: '/tmp', sessionId: 't' } as any));

    expect(out).toMatchObject({ ok: false, code: 'invalid_arguments' });
    expect(out.error).toContain('elementToken + elementIndex');
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

  it('requires menu_search to name both the result and its verifiable end state', async () => {
    const { tool, approvals } = toolUnderTest();
    const out = JSON.parse(await tool.execute({
      action: 'menu_search', searchText: 'Yellow', query: 'Yellow by Coldplay',
    } as any, { cwd: '/tmp', sessionId: 't' } as any));
    expect(out).toMatchObject({ ok: false, code: 'invalid_arguments' });
    expect(out.error).toContain('expect');
    expect(approvals).toHaveLength(0);
  });

  it('delivers one complete menu_search transaction contract to the runtime', async () => {
    const { tool } = toolUnderTest();
    await tool.execute({
      action: 'menu_search', searchText: 'Yellow', query: 'Yellow by Coldplay', expect: 'Pause',
      deliveryMode: 'foreground',
    } as any, { cwd: '/tmp', sessionId: 't' } as any);
    expect((globalThis as any).__runtimeReached?.[0]).toMatchObject({
      action: 'menu_search', searchText: 'Yellow', query: 'Yellow by Coldplay', expect: 'Pause',
    });
    expect((globalThis as any).__runtimeReached?.[0]).not.toHaveProperty('deliveryMode');
  });
});
