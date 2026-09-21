import * as fs from 'fs';
import * as path from 'path';
import { Governor, TASK_GRANT_OPTION } from '../governor/governor';
import { GlobalPrompter } from '../engine/prompter';
import { SafetyPolicy } from '../governor/policy.engine';
import { EventEmitter } from 'events';
import { TaskGrants, endGrantsWithTask, grantFor, taskGrants } from '../governor/task.grants';
import { planFileChange } from '../tools/thread.changes';
import '../engine/commands/grants';
import { globalCommandRegistry } from '../engine/commands/registry';

/**
 * Backlog N13: "Allow for this task". A thread asked afresh for every existing-file write and every mutating command;
 * a grant answers once for an explicitly described change, reused only while target, scope and risk stay the same,
 * and only after every floor has run.
 */

// Under the repo, not os.tmpdir(): /private/var/… is a forbidden system path for the workspace floor.
let dir: string, root: string;
const originalWorkspace = SafetyPolicy.allowedWorkspace;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.cwd(), '.task-grants-test-'));
  root = path.join(dir, 'Downloads'); fs.mkdirSync(root);
  process.env.BIMAX_THREAD_ROOT = root; process.env.BIMAX_STATE_DIR = dir; SafetyPolicy.allowedWorkspace = root;
  taskGrants.clear();
});
afterEach(() => {
  delete process.env.BIMAX_THREAD_ROOT; delete process.env.BIMAX_STATE_DIR; SafetyPolicy.allowedWorkspace = originalWorkspace;
  jest.restoreAllMocks(); taskGrants.clear(); fs.rmSync(dir, { recursive: true, force: true });
});

const file = (name: string, text = 'x') => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const write = (gov: Governor, target: string) => gov.approveTaskExecution('FILE_WRITE', { tool: 'EditFileTool', targetPath: target, context: { cwd: root }, isDestructive: true });
const shell = (gov: Governor, command: string) => gov.approveTaskExecution('OS_COMMAND', { tool: 'BashTool', command, context: { cwd: root }, isDestructive: true });

describe('what a grant can cover', () => {
  test('one existing file; undoable changes inside the folder; one exact command — and nothing else', () => {
    const math = file('math.js');
    const writePlan = planFileChange('FILE_WRITE', { tool: 'EditFileTool', targetPath: math }, root);
    expect(grantFor('FILE_WRITE', writePlan, {}, root, root)).toEqual({ key: `write:${fs.realpathSync(math)}`, label: 'edits to “math.js”' });

    file('a.pdf');
    const move = planFileChange('OS_COMMAND', { command: 'mv a.pdf invoice-2026-09.pdf' }, root);
    expect(move?.kind).toBe('move');
    expect(grantFor('OS_COMMAND', move, { command: 'mv a.pdf invoice-2026-09.pdf' }, root, root)?.label).toBe('moving and renaming items inside “Downloads” (each can be undone)');

    const command = planFileChange('OS_COMMAND', { command: 'npm run build' }, root);
    expect(command?.kind).toBe('command');
    expect(grantFor('OS_COMMAND', command, { command: 'npm run build' }, root, root)?.label).toBe('running `npm run build` in “Downloads”');
    expect(grantFor('OS_COMMAND', command, { command: 'npm run build\nrm -rf ~' }, root, root)).toBeNull();

    // Out of the folder, or not undoable: one-time answers only.
    const outside = planFileChange('OS_COMMAND', { command: `mv a.pdf ${dir}/` }, root);
    expect(grantFor('OS_COMMAND', outside, { command: 'mv' }, root, root)).toBeNull();
    expect(grantFor('FILE_WRITE', null, {}, root, root)).toBeNull();
    expect(grantFor('OS_COMMAND', { kind: 'move', title: 't', preview: [], undoable: false, moves: [{ from: path.join(root, 'a'), to: path.join(root, 'b') }], trash: [], creates: [], overwrites: [] }, {}, root, root)).toBeNull();
  });
});

describe('through the governor', () => {
  test('"Allow for this task" stops the question for the same file, and only that file', async () => {
    const gov = new Governor({ emit: jest.fn() } as any);
    const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValueOnce(TASK_GRANT_OPTION).mockResolvedValue('Deny');
    const math = file('math.js');
    await write(gov, math);
    expect(ask.mock.calls[0][1]).toEqual(['Allow', TASK_GRANT_OPTION, 'Deny']);
    expect(ask.mock.calls[0][2]?.body).toContain('also allows edits to “math.js” until this task ends');
    await write(gov, math);
    await write(gov, math);
    expect(ask).toHaveBeenCalledTimes(1);
    await expect(write(gov, file('other.js'))).rejects.toThrow('declined');
    expect(ask).toHaveBeenCalledTimes(2);
    expect(taskGrants.list()).toEqual([expect.objectContaining({ label: 'edits to “math.js”', uses: 2 })]);
  });

  test('a plain "Allow" is one time only', async () => {
    const gov = new Governor({ emit: jest.fn() } as any);
    const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValue('Allow');
    const math = file('math.js');
    await write(gov, math);
    await write(gov, math);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(taskGrants.list()).toEqual([]);
  });

  test('a change that cannot be granted offers only Allow and Deny', async () => {
    const gov = new Governor({ emit: jest.fn() } as any);
    const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValue('Allow');
    await shell(gov, 'npm run build\necho done');
    expect(ask.mock.calls[0][1]).toEqual(['Allow', 'Deny']);
  });

  test('a grant never gets past a floor: a permanent delete is refused even with a matching grant', async () => {
    const gov = new Governor({ emit: jest.fn() } as any);
    const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValue('Allow');
    const command = 'git clean -fd';
    taskGrants.add({ key: `command:${fs.realpathSync(root)}:${command}`, label: 'running it' });
    await expect(shell(gov, command)).rejects.toThrow();
    expect(ask).not.toHaveBeenCalled();
    expect(taskGrants.list()[0].uses).toBe(0);
  });

  test('the same command is not asked again; a different one is', async () => {
    const gov = new Governor({ emit: jest.fn() } as any);
    const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValueOnce(TASK_GRANT_OPTION).mockResolvedValue('Deny');
    await shell(gov, 'npm run build');
    await shell(gov, 'npm run build');
    await expect(shell(gov, 'npm run deploy')).rejects.toThrow('declined');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  test('a command grant is for that folder: the same command somewhere else asks again', async () => {
    const gov = new Governor({ emit: jest.fn() } as any);
    const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValueOnce(TASK_GRANT_OPTION).mockResolvedValue('Deny');
    const sub = path.join(root, 'site'); fs.mkdirSync(sub);
    await shell(gov, 'npm run build');
    await expect(gov.approveTaskExecution('OS_COMMAND', { tool: 'BashTool', command: 'npm run build', context: { cwd: sub }, isDestructive: true })).rejects.toThrow('declined');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  test('one move grant covers other undoable moves inside the folder', async () => {
    const gov = new Governor({ emit: jest.fn() } as any);
    const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValueOnce(TASK_GRANT_OPTION).mockResolvedValue('Deny');
    file('a.pdf'); file('b.pdf');
    await shell(gov, 'mv a.pdf invoice-1.pdf');
    await shell(gov, 'mv b.pdf invoice-2.pdf');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  test('grants end with the task: a new task, or a switch to another saved one', () => {
    for (const event of ['clear', 'session_changed']) {
      const events = new EventEmitter();
      const grants = new TaskGrants();
      endGrantsWithTask(events, grants);
      grants.add({ key: 'write:/x', label: 'edits to “x”' });
      events.emit(event);
      expect([event, grants.list()]).toEqual([event, []]);
    }
  });

  test('/grants lists them and /grants clear takes them back', async () => {
    taskGrants.add({ key: 'write:/x', label: 'edits to “x”' });
    const listed = await globalCommandRegistry.execute('/grants', {} as any) as any;
    expect(listed.content).toContain('edits to “x”');
    const cleared = await globalCommandRegistry.execute('/grants clear', {} as any) as any;
    expect(cleared.content).toContain('Cleared 1 permission');
    expect(taskGrants.list()).toEqual([]);
  });
});
