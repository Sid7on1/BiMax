import * as fs from 'fs';
import * as path from 'path';
import { Governor } from '../governor/governor';
import { GlobalPrompter } from '../engine/prompter';
import { SafetyPolicy } from '../governor/policy.engine';
import { taskGrants } from '../governor/task.grants';

/**
 * Record 46's restoration trap, fixed in record 65 stage 3: inside a Bimax Thread the governor's Thread branch returned
 * before the computer-control floors, so neither the sensitive-target refusal nor "not while unattended" held there.
 * A press or a typing (PressInAppTool, TypeInAppTool: COMPUTER_CONTROL) must meet both floors and plan mode first.
 * Since stage 6 (§6h, the owner's choice) the engine raises no card of its own in a Thread: the app reads the window,
 * runs ordinary steps and stops on its own card before anything that commits.
 */

const bus = { emit: jest.fn(), on: jest.fn() } as any;
let dir: string, root: string;
const originalWorkspace = SafetyPolicy.allowedWorkspace;
beforeEach(() => {
  // Under the repo, not os.tmpdir(): /private/var/… is a forbidden system path for the workspace floor.
  dir = fs.mkdtempSync(path.join(process.cwd(), '.computer-floor-test-'));
  root = path.join(dir, 'task'); fs.mkdirSync(root);
  process.env.BIMAX_THREAD_ROOT = root; SafetyPolicy.allowedWorkspace = root;
  taskGrants.clear();
});
afterEach(() => {
  delete process.env.BIMAX_THREAD_ROOT; SafetyPolicy.allowedWorkspace = originalWorkspace;
  jest.restoreAllMocks(); taskGrants.clear(); fs.rmSync(dir, { recursive: true, force: true });
});

const press = (gov: Governor, app: string, control = 'Save') =>
  gov.approveTaskExecution('COMPUTER_CONTROL', { tool: 'PressInAppTool', app, control, context: { cwd: root }, isDestructive: true });

test('in a Bimax Thread a press at a credential store or security setting is refused before any card', async () => {
  const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValue('Allow');
  const governor = new Governor(bus);
  for (const app of ['1Password', 'Keychain Access', 'System Settings', 'MetaMask wallet']) {
    await expect(press(governor, app)).rejects.toThrow(/sensitive targets/);
  }
  expect(ask).not.toHaveBeenCalled();
});

test('in a Bimax Thread nobody watching means no computer control at all', async () => {
  const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValue('Allow');
  const governor = new Governor(bus);
  governor.mode = 'unattended';
  await expect(press(governor, 'BimaxCuFixture')).rejects.toThrow('not allowed while unattended');
  expect(ask).not.toHaveBeenCalled();
});

test('in plan mode a press is refused', async () => {
  const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValue('Allow');
  const governor = new Governor(bus);
  governor.mode = 'plan';
  await expect(press(governor, 'BimaxCuFixture')).rejects.toThrow(/Plan mode/);
  expect(ask).not.toHaveBeenCalled();
});

test('past the floors, a press or a typing in a Thread raises no engine card and leaves no grant: the app owns the card', async () => {
  const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValue('Deny');
  const governor = new Governor(bus);
  await expect(press(governor, 'WhatsApp', 'Send')).resolves.toBeUndefined();
  await expect(governor.approveTaskExecution('COMPUTER_CONTROL', { tool: 'TypeInAppTool', app: 'WhatsApp', text: 'hi', context: { cwd: root }, isDestructive: true })).resolves.toBeUndefined();
  expect(ask).not.toHaveBeenCalled();
  expect(taskGrants.list()).toEqual([]);
});

test('a typing meets the same floors as a press', async () => {
  const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValue('Allow');
  const governor = new Governor(bus);
  const type = (app: string) => governor.approveTaskExecution('COMPUTER_CONTROL', { tool: 'TypeInAppTool', app, text: 'x', context: { cwd: root }, isDestructive: true });
  await expect(type('1Password')).rejects.toThrow(/sensitive targets/);
  governor.mode = 'plan';
  await expect(type('Notes')).rejects.toThrow(/Plan mode/);
  governor.mode = 'unattended';
  await expect(type('Notes')).rejects.toThrow('not allowed while unattended');
  expect(ask).not.toHaveBeenCalled();
});

test('outside a Thread the floors still come first', async () => {
  delete process.env.BIMAX_THREAD_ROOT;
  const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValue('Allow');
  const governor = new Governor(bus);
  await expect(press(governor, '1Password')).rejects.toThrow(/sensitive targets/);
  governor.mode = 'unattended';
  await expect(press(governor, 'BimaxCuFixture')).rejects.toThrow('not allowed while unattended');
  expect(ask).not.toHaveBeenCalled();
});
