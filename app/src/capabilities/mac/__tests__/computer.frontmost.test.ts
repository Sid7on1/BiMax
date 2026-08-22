jest.mock('../mcp.client', () => ({
  openClient: jest.fn(),
  isDeadConnectionError: () => false,
}));

import { openClient } from '../mcp.client';
import { BimaxComputerRuntime } from '../desktop.runtime';
import { __resetConfigForTests } from '../config';

function result(structuredContent: any) {
  return { structuredContent, content: [], isError: false };
}

/**
 * Which authority answers "who is frontmost?".
 *
 * This is the activation-confirmation probe: every target switch calls it, and the wait for an app
 * to come forward polls it. Measured on a real machine, the two available authorities cost 642ms
 * (the sidecar enumerating every running application) and 4ms (the native helper reading
 * NSWorkspace) for the same answer — so the choice of authority was most of a target switch, and at
 * 642ms per probe a "poll every 40ms" loop could only ever take one sample.
 *
 * These assert the ORDER and its guard rail, not any timing number: the cheap authority is asked
 * first, and only when it exists already — resolving it must never drag a first-use `swiftc`
 * compile onto the critical path.
 */
describe('frontmost app is read from the cheapest authority', () => {
  const callTool = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BIMAX_COMPUTER_USE_DRIVER = process.execPath;
    process.env.BIMAX_COMPUTER_USE_DAEMON = '0';
    process.env.BIMAX_COMPUTER_PIP = '0';
    __resetConfigForTests();
    (openClient as jest.Mock).mockResolvedValue({ callTool, close: jest.fn() });
    callTool.mockImplementation(async ({ name }: any) => {
      if (name === 'list_apps') return result({ apps: [{ pid: 42, name: 'Sidecar Answer', active: true }] });
      return result({ ok: true });
    });
  });

  afterEach(() => {
    delete process.env.BIMAX_COMPUTER_USE_DRIVER;
    delete process.env.BIMAX_COMPUTER_USE_DAEMON;
    delete process.env.BIMAX_COMPUTER_PIP;
    __resetConfigForTests();
  });

  const helper = (driver: string, name: string) => ({
    run: jest.fn(async (cmd: any) => ({ ok: true, action: cmd.action, driver: 'native-helper', summary: cmd.action })),
    quickStatus: () => ({ driver, ready: true }),
    frontmostApp: jest.fn(async () => name),
  } as any);

  it('asks the native helper and does not enumerate every running application', async () => {
    const native = helper('native-helper', 'Helper Answer');
    const runtime = new BimaxComputerRuntime(native);

    expect(await runtime.frontmostApp()).toBe('Helper Answer');
    expect(native.frontmostApp).toHaveBeenCalled();
    expect(callTool.mock.calls.filter(([a]: any[]) => a.name === 'list_apps')).toHaveLength(0);
  });

  it('never puts a first-use helper COMPILE on the critical path', async () => {
    // `quickStatus` reports this tier when swiftc exists but the helper has not been built yet.
    // Asking it here would block the switch on a compile, so the sidecar answers instead.
    const native = helper('native-helper (compiles on first use)', 'Helper Answer');
    const runtime = new BimaxComputerRuntime(native);

    expect(await runtime.frontmostApp()).toBe('Sidecar Answer');
    expect(native.frontmostApp).not.toHaveBeenCalled();
  });

  it('falls back to the sidecar when the helper answers nothing', async () => {
    // An empty answer is "unknown", not "no app is frontmost" — and an unknown must never be
    // reported as a mismatch, because that manufactures a false activation failure.
    const native = helper('native-helper', '');
    const runtime = new BimaxComputerRuntime(native);

    expect(await runtime.frontmostApp()).toBe('Sidecar Answer');
  });
});
