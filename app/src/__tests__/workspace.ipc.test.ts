import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The workspace panels' channels, moved out of main/index.ts into workspace.ipc.ts (flaw list C13). They must all go
 * through the checked gate, read the project at call time (not at registration), and keep every path inside it.
 */

const showItemInFolder = jest.fn();
const showMessageBox = jest.fn();
const builtMenus: { template: any[]; popup: jest.Mock }[] = [];
jest.mock('electron', () => ({
  shell: { showItemInFolder: (file: string) => showItemInFolder(file) },
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) },
  Menu: {
    buildFromTemplate: (template: any[]) => {
      const menu = { template, popup: jest.fn() };
      builtMenus.push(menu);
      return menu;
    },
  },
}));

import { registerWorkspaceIpc } from '../main/workspace.ipc';
import type { IpcGate } from '../main/ipc.gate';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, { fallback: unknown; fn: Handler }>();
const listeners = new Map<string, Handler>();
const gate: IpcGate = {
  handle: (channel, fallback, fn) => { handlers.set(channel, { fallback, fn: fn as Handler }); },
  on: (channel, fn) => { listeners.set(channel, fn as Handler); },
};

let project = '';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-workspace-ipc-'));
beforeAll(() => {
  fs.mkdirSync(path.join(root, 'a', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'src', 'main.ts'), 'export const x = 1;\n');
  fs.mkdirSync(path.join(root, 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'b', 'other.txt'), 'b\n');
  registerWorkspaceIpc(gate, { projectDir: () => project, projectGeneration: () => 7, broadcast: () => undefined, window: () => null });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test('registers exactly the workspace channels, all through the gate', () => {
  expect([...handlers.keys()].sort()).toEqual([
    'files:confirm-close', 'files:list', 'files:read', 'files:reveal', 'files:search', 'files:tab-menu', 'files:write',
    'git:branches', 'git:diff', 'git:fetch', 'git:log', 'git:pull', 'git:push', 'git:remote', 'git:status',
    'models:local', 'pty:create', 'sessions:meta',
  ]);
  expect([...listeners.keys()].sort()).toEqual(['pty:input', 'pty:kill', 'pty:resize']);
});

test('reads the project at call time, so switching projects switches what the panels see', async () => {
  const list = handlers.get('files:list')!.fn;
  project = path.join(root, 'a');
  expect(JSON.stringify(await list({}, ''))).toContain('src');
  project = path.join(root, 'b');
  expect(JSON.stringify(await list({}, ''))).toContain('other.txt');
});

test('a path outside the project is refused, not revealed', async () => {
  project = path.join(root, 'a');
  const reveal = handlers.get('files:reveal')!.fn;
  await expect(Promise.resolve().then(() => reveal({}, '../b/other.txt'))).rejects.toThrow();
  expect(showItemInFolder).not.toHaveBeenCalled();
  await reveal({}, 'src/main.ts');
  expect(showItemInFolder).toHaveBeenCalledWith(path.join(root, 'a', 'src', 'main.ts'));
});

describe('the file tabs (UI fix list item 8)', () => {
  test('closing an unsaved tab asks Save / Don’t Save / Cancel, and Esc is Cancel', async () => {
    const ask = handlers.get('files:confirm-close')!.fn;
    for (const [response, answer] of [[0, 'save'], [1, 'discard'], [2, 'cancel']] as const) {
      showMessageBox.mockResolvedValueOnce({ response });
      expect(await ask({}, 'src/api/client.ts')).toBe(answer);
    }
    const options = showMessageBox.mock.calls[0][0];
    expect(options.buttons).toEqual(['Save', 'Don’t Save', 'Cancel']);
    expect(options.cancelId).toBe(2);
    expect(options.message).toContain('client.ts');
    // The name is shown, never used: a path that is not a string is simply not named.
    showMessageBox.mockResolvedValueOnce({ response: 2 });
    await ask({}, { evil: true });
    expect(showMessageBox.mock.calls[3][0].message).toContain('this file');
  });

  test('a tab’s menu answers with the command chosen, and with nothing when dismissed', async () => {
    const menu = handlers.get('files:tab-menu')!.fn;
    const chosen = menu({}, true, false) as Promise<unknown>;
    const { template } = builtMenus[builtMenus.length - 1];
    const item = (label: string) => template.find((entry) => entry.label === label);
    expect(item('Close Others').enabled).toBe(true);
    expect(item('Close to the Right').enabled).toBe(false);
    item('Close Others').click();
    expect(await chosen).toBe('others');

    jest.useFakeTimers();
    try {
      const dismissed = menu({}, false, false) as Promise<unknown>;
      const last = builtMenus[builtMenus.length - 1];
      expect(last.template.find((entry) => entry.label === 'Close Others').enabled).toBe(false);
      last.popup.mock.calls[0][0].callback();
      jest.runAllTimers();
      expect(await dismissed).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
