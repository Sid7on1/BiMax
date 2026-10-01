import * as fs from 'fs';
import * as path from 'path';
import { Governor, TASK_GRANT_OPTION } from '../governor/governor';
import { GlobalPrompter } from '../engine/prompter';
import { SafetyPolicy } from '../governor/policy.engine';
import { taskGrants } from '../governor/task.grants';

/**
 * Record 46's restoration trap, fixed in record 65 stage 3: inside a Bimax Thread the governor's Thread branch returned
 * before the computer-control floors, so neither the sensitive-target refusal nor "not while unattended" held there.
 * A press (PressInAppTool, COMPUTER_CONTROL) must meet both floors first, then the engine's own one-time card — never
 * a grant for the task — before the app asks again for the press itself.
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

test('an ordinary press asks every time, once, naming the control — and offers no grant for the task', async () => {
  const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValueOnce('Allow').mockResolvedValueOnce('Allow').mockResolvedValue('Deny');
  const governor = new Governor(bus);
  await expect(press(governor, 'BimaxCuFixture', 'Fixture Button')).resolves.toBeUndefined();
  await expect(press(governor, 'BimaxCuFixture', 'Fixture Button')).resolves.toBeUndefined();
  await expect(press(governor, 'BimaxCuFixture', 'Fixture Button')).rejects.toThrow('Action declined');
  expect(ask).toHaveBeenCalledTimes(3);
  const [question, options] = ask.mock.calls[0];
  expect(question).toBe('Let this task press “Fixture Button” in BimaxCuFixture?');
  expect(options).toEqual(['Allow', 'Deny']);
  expect(options).not.toContain(TASK_GRANT_OPTION);
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
