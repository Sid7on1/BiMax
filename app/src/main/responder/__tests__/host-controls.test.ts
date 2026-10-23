import { BrowserWindow, dialog } from 'electron';
import { DesktopHostControls } from '../host-controls';

jest.mock('electron', () => {
  const windows: any[] = [];
  class FakeWindow {
    handlers = new Map<string, (...args: any[]) => void>();
    destroyed = false;
    url = '';
    shown = false;
    webContents = {
      on: (name: string, handler: (...args: any[]) => void) => this.handlers.set(name, handler),
      setWindowOpenHandler: jest.fn(),
    };
    constructor(readonly options: unknown) { windows.push(this); }
    async loadURL(url: string) { this.url = url; }
    showInactive() { this.shown = true; }
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
  }
  class FakeTray {
    setTitle = jest.fn(); setToolTip = jest.fn(); setContextMenu = jest.fn(); destroy = jest.fn();
  }
  return { BrowserWindow: FakeWindow, Tray: FakeTray, Menu: { buildFromTemplate: (items: unknown) => items },
    nativeImage: { createEmpty: () => ({}) }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000 } }) },
    dialog: { showMessageBox: jest.fn() }, windows };
});

const operation = { kind: 'command' as const, peer: 'phone-1', text: 'Run the tests' };
const showDialog = dialog.showMessageBox as unknown as jest.MockedFunction<(
  window: BrowserWindow, options: Electron.MessageBoxOptions,
) => Promise<Electron.MessageBoxReturnValue>>;
const lastWindow = (): any => (jest.requireMock('electron') as any).windows.at(-1);
beforeEach(() => jest.clearAllMocks());

test('shows sandboxed banner, exact request and deny-default native consent; no pre-consent grant', async () => {
  const stop = jest.fn(async () => {});
  const controls = new DesktopHostControls(stop);
  expect(await controls.authorize(operation, new AbortController().signal)).toBe(false);
  await controls.setRemoteSessionActive(true, operation.peer);
  const window = lastWindow();
  expect(window.shown).toBe(true);
  expect(window.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  const html = decodeURIComponent(window.url.split(',').slice(1).join(','));
  expect(html).toContain('Remote access is active');
  expect(html).toContain('Stop Remote Access');
  let grant!: (value: { response: number; checkboxChecked: boolean }) => void;
  showDialog.mockImplementation(() => new Promise((resolve) => { grant = resolve; }));
  let resolved = false;
  const authorization = controls.authorize(operation, new AbortController().signal).then((result) => { resolved = true; return result; });
  await Promise.resolve();
  expect(resolved).toBe(false);
  expect(showDialog).toHaveBeenCalledWith(window, expect.objectContaining({ defaultId: 0, cancelId: 0,
    detail: 'Phone: phone-1\n\nRun the tests', buttons: ['Not Now', 'Allow This Request', 'Stop Remote Access'] }));
  grant({ response: 1, checkboxChecked: false });
  expect(await authorization).toBe(true);
  expect(stop).not.toHaveBeenCalled();
  await controls.setRemoteSessionActive(false);
  expect(window.destroyed).toBe(true);
});

test('local Stop cancels pending consent, ignores late Allow and latches remote access off', async () => {
  const stop = jest.fn(async () => {});
  const controls = new DesktopHostControls(stop);
  await controls.setRemoteSessionActive(true, operation.peer);
  let grant!: (value: { response: number; checkboxChecked: boolean }) => void;
  showDialog.mockImplementation(() => new Promise((resolve) => { grant = resolve; }));
  const authorization = controls.authorize(operation, new AbortController().signal);
  const options = showDialog.mock.calls[0][1]!;
  const preventDefault = jest.fn();
  lastWindow().handlers.get('will-navigate')({ preventDefault }, 'bimax-remote-stop://local');
  await controls.stop();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(preventDefault).toHaveBeenCalled();
  expect(options.signal!.aborted).toBe(true);
  grant({ response: 1, checkboxChecked: false });
  expect(await authorization).toBe(false);
  await expect(controls.setRemoteSessionActive(true, operation.peer)).rejects.toThrow(/restart Bimax/);
});

test('rejects wrong peers, denied/aborted consent and text that cannot be fully displayed', async () => {
  const controls = new DesktopHostControls(async () => {});
  await controls.setRemoteSessionActive(true, operation.peer);
  expect(await controls.authorize({ ...operation, peer: 'other' }, new AbortController().signal)).toBe(false);
  expect(await controls.authorize({ ...operation, text: 'x'.repeat(16385) }, new AbortController().signal)).toBe(false);
  showDialog.mockResolvedValue({ response: 0, checkboxChecked: false });
  expect(await controls.authorize(operation, new AbortController().signal)).toBe(false);
  const aborted = new AbortController(); aborted.abort();
  expect(await controls.authorize(operation, aborted.signal)).toBe(false);
  await controls.setRemoteSessionActive(false);
});

test('escapes peer text and prevents every unexpected navigation or new window', async () => {
  const stop = jest.fn(async () => {});
  const controls = new DesktopHostControls(stop);
  await controls.setRemoteSessionActive(true, '<script>alert(1)</script>');
  const window = lastWindow();
  const html = decodeURIComponent(window.url.split(',').slice(1).join(','));
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  const preventDefault = jest.fn();
  window.handlers.get('will-navigate')({ preventDefault }, 'https://attacker.example');
  expect(preventDefault).toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  const open = window.webContents.setWindowOpenHandler.mock.calls[0][0];
  expect(open({ url: 'https://attacker.example' })).toEqual({ action: 'deny' });
  await controls.setRemoteSessionActive(false);
});
