import { EventEmitter } from 'events';
import childProcess = require('child_process');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startShellTask } from '../core/shell.tasks';
import { __resetTaskRegistryForTests, TaskRegistry } from '../core/task.registry';
import { __resetExecutionLedgerForTests, getExecutionLedger } from '../core/execution.ledger';
import { createBashTool } from '../tools/implementations/bash.tool';

describe('background shell lifecycle and stream regression', () => {
  let dir: string, registry: TaskRegistry, child: any;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-shell-sprint-'));
    __resetExecutionLedgerForTests(dir);
    registry = __resetTaskRegistryForTests();
    child = Object.assign(new EventEmitter(), {
      pid: 12345678, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: jest.fn(),
    });
    jest.spyOn(childProcess, 'spawn').mockReturnValue(child);
    jest.spyOn(process, 'kill').mockReturnValue(true);
    jest.useFakeTimers();
  });
  afterEach(() => {
    child.emit('close', null, 'SIGKILL');
    jest.useRealTimers(); jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('cancel wakes a paused process so its termination signal can be handled', () => {
    const { task } = startShellTask('sleep 99', { cwd: dir });
    registry.pause(task.id); registry.cancel(task.id);
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGCONT');
    child.emit('close', null, 'SIGTERM');
    expect(task.state).toBe('cancelled');
    expect(getExecutionLedger().reconstruct().find(t => t.taskId === task.id)?.state).toBe('cancelled');
  });
  it('escalates an ignored termination and clears all timers after pipes close', () => {
    const { task } = startShellTask('sleep 99', { cwd: dir, timeoutMs: 100 });
    jest.advanceTimersByTime(100);
    expect(task.state).toBe('cancelling');
    jest.advanceTimersByTime(5000);
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    expect(task.state).toBe('cancelled'); expect(jest.getTimerCount()).toBe(0);
  });
  it.each([0, 2])('a close racing pause records the real exit %s', code => {
    const { task } = startShellTask('build', { cwd: dir });
    registry.pause(task.id); child.emit('close', code, null);
    expect(task.state).toBe(code === 0 ? 'completed' : 'failed-resumable');
    expect(registry.live()).toHaveLength(0);
  });
  it('preserves UTF-8 characters and logical lines across arbitrary pipe chunks', () => {
    const { task } = startShellTask('build', { cwd: dir });
    const bytes = Buffer.from('src/π.ts: error\nnext line');
    const split = bytes.indexOf(Buffer.from('π')) + 1;
    child.stdout.emit('data', bytes.subarray(0, split));
    child.stdout.emit('data', bytes.subarray(split, bytes.length - 4));
    child.stdout.emit('data', bytes.subarray(bytes.length - 4));
    child.emit('close', 1, null);
    expect(registry.output(task.id)).toBe('src/π.ts: error\nnext line');
  });
  it('keeps streamed no-newline output bounded without manufacturing extra lines', () => {
    const { task } = startShellTask('build', { cwd: dir });
    for (let i = 0; i < 1000; i++) child.stdout.emit('data', Buffer.from('x'.repeat(100)));
    child.emit('close', 0, null);
    expect(registry.output(task.id)).toBe('x'.repeat(500) + '…');
  });
  it('BashTool honors an explicit short background timeout', async () => {
    const tool = createBashTool({ approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as any);
    const result = JSON.parse(await tool.execute({ command: 'sleep 99', background: true, timeout: 100 }, { cwd: dir }));
    jest.advanceTimersByTime(100);
    expect(registry.get(result.taskId)?.state).toBe('cancelling');
    child.emit('close', null, 'SIGTERM');
  });
  it('BashTool refuses to report a synchronously failed spawn as success', async () => {
    jest.spyOn(require('../core/fault.injection'), 'faultPoint').mockImplementation((site: unknown) => {
      if (site === 'shell.spawn') throw new Error('injected spawn failure');
    });
    const tool = createBashTool({ approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as any);
    await expect(tool.execute({ command: 'sleep 99', background: true }, { cwd: dir })).rejects.toThrow('injected spawn failure');
    expect(registry.live()).toHaveLength(0);
  });
  it('keeps a large streamed tail bounded and never joins stdout to stderr fragments', () => {
    const { task } = startShellTask('build', { cwd: dir });
    child.stdout.emit('data', Buffer.from('src/parser'));
    child.stderr.emit('data', Buffer.from('.ts: error\n'));
    expect(registry.output(task.id)).toBe('src/parser\n.ts: error');
    child.stdout.emit('data', Buffer.from(Array.from({ length: 1000 }, (_, i) => `line ${i}\n`).join('')));
    const lines = registry.output(task.id, 1000).split('\n');
    expect(lines).toHaveLength(TaskRegistry.OUTPUT_MAX_LINES);
    expect(lines[0]).toBe('line 600'); expect(lines.at(-1)).toBe('line 999');
    child.emit('close', 0, null);
  });
});
