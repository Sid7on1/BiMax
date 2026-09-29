import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The workspace panels' channels, moved out of main/index.ts into workspace.ipc.ts (flaw list C13). They must all go
 * through the checked gate, read the project at call time (not at registration), and keep every path inside it.
 */

const showItemInFolder = jest.fn();
jest.mock('electron', () => ({ shell: { showItemInFolder: (file: string) => showItemInFolder(file) } }));

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
  registerWorkspaceIpc(gate, { projectDir: () => project, projectGeneration: () => 7, broadcast: () => undefined });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test('registers exactly the workspace channels, all through the gate', () => {
  expect([...handlers.keys()].sort()).toEqual([
    'files:list', 'files:read', 'files:reveal', 'files:search', 'files:write',
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
