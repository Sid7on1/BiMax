import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startShellTask } from '../core/shell.tasks';
import { __resetTaskRegistryForTests, TaskRegistry } from '../core/task.registry';
import { __resetExecutionLedgerForTests } from '../core/execution.ledger';
import { createTasksTool } from '../tools/implementations/tasks.tool';

const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(ready: () => boolean, limit = 4000) {
  const deadline = Date.now() + limit;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error('fixture did not reach its expected state');
    await delay(20);
  }
}

describe('real background shell end states', () => {
  let dir: string, registry: TaskRegistry, pids: number[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-shell-real-'));
    __resetExecutionLedgerForTests(dir); registry = __resetTaskRegistryForTests(); pids = [];
  });
  afterEach(async () => {
    for (const task of registry.live()) registry.cancel(task.id);
    for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ } }
    await until(() => registry.live().length === 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function fixture(body: string) {
    const file = path.join(dir, 'job.cjs');
    fs.writeFileSync(file, body);
    return startShellTask(`exec ${quote(process.execPath)} ${quote(file)}`, { cwd: dir }).task;
  }
  it('cooperative cancellation wakes a genuinely paused job and drains its final output', async () => {
    const task = fixture(`process.on('SIGTERM', () => { console.log('TERM handled'); process.exit(0); });
      console.log('PID=' + process.pid); setInterval(() => {}, 1000);`);
    await until(() => registry.output(task.id).includes('PID='));
    const pid = Number(registry.output(task.id).split('PID=')[1]); pids.push(pid);
    expect(registry.pause(task.id)).toContain('Paused');
    registry.cancel(task.id);
    await until(() => task.state === 'cancelled');
    expect(registry.output(task.id)).toContain('TERM handled');
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('kills a SIGTERM-resistant job and its inherited process-group descendant', async () => {
    const task = fixture(`const {spawn} = require('child_process');
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('child ready'); setInterval(()=>{},1000)"], {stdio:['ignore','pipe','inherit']});
      process.on('SIGTERM',()=>{});
      child.stdout.once('data', () => console.log('PIDS=' + process.pid + ',' + child.pid));
      setInterval(()=>{},1000);`);
    await until(() => registry.output(task.id).includes('PIDS='));
    const [pid, descendant] = registry.output(task.id).split('PIDS=')[1].split(',').map(Number); pids.push(pid);
    registry.cancel(task.id); await until(() => task.state === 'cancelled');
    expect(task.lastEvent).toContain('SIGKILL');
    expect(() => process.kill(pid, 0)).toThrow();
    await until(() => { try { process.kill(descendant, 0); return false; } catch { return true; } });
  });
  it('a real BashTool background task is inspectable and waitable through TasksTool', async () => {
    const { createBashTool } = await import('../tools/implementations/bash.tool');
    const governor: any = { approveTaskExecution: async () => {} };
    const bash = createBashTool(governor), tasks = createTasksTool(governor);
    const launched = JSON.parse(await bash.execute({ command: "printf 'parser: ready\\n'; exit 3", background: true }, { cwd: dir }));
    const result = await tasks.execute({ action: 'wait', taskId: launched.taskId, timeout_seconds: 2 });
    expect(result).toContain('[failed-resumable]'); expect(result).toContain('exit 3'); expect(result).toContain('parser: ready');
    expect(await tasks.execute({ action: 'get', taskId: launched.taskId })).toContain('parser: ready');
  });
});
