import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runToolWorkflow, WorkflowStep } from '../core/tool.workflow';
import { ToolRegistry } from '../tools/tool.registry';
import { buildTool } from '../tools/tool.factory';
import { createReadFileTool } from '../tools/implementations/file.tool';
import { createGrepTool, createGlobTool } from '../tools/implementations/search.tool';
import { createToolWorkflowTool } from '../tools/implementations/workflow.tool';
import { clearHooks, registerPreHook } from '../tools/hooks';
import { IGovernor } from '../core/interfaces';

const step = (id: string, args: Record<string, unknown> = { path: 'package.json' }): WorkflowStep => ({ id, tool: 'ReadFileTool', args });
const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};

describe('read-only tool workflows', () => {
  let cwd: string;
  let registry: ToolRegistry;
  let approve: jest.Mock;
  let governor: IGovernor;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-workflow-'));
    await fs.writeFile(path.join(cwd, 'package.json'), '{"entry":"main.ts","name":"needle"}');
    await fs.writeFile(path.join(cwd, 'main.ts'), 'export const needle = 42;\n');
    await fs.writeFile(path.join(cwd, 'dirty.txt'), 'unfinished user edit\n');
    approve = jest.fn(async () => {});
    governor = { approveTaskExecution: approve } as unknown as IGovernor;
    registry = new ToolRegistry();
    registry.register(createReadFileTool(governor));
    registry.register(createGrepTool(governor));
    registry.register(createGlobTool(governor));
  });
  afterEach(async () => { clearHooks(); await fs.rm(cwd, { recursive: true, force: true }); });

  const register = (registry: ToolRegistry, governor: IGovernor, execute: (args: any, ctx: any) => Promise<any>, safe = true) => {
    registry.register(buildTool({
      name: 'ProbeTool', description: 'fixture', schema: { type: 'object', properties: {} },
      isDestructive: false, workflowReadOnly: true, isConcurrencySafe: safe, execute,
    }, governor));
  };

  it('runs real JSON read → bound source read and grep, preserving unrelated bytes', async () => {
    const before = await fs.readFile(path.join(cwd, 'dirty.txt'));
    const result = await runToolWorkflow([
      { ...step('source', {}), bindings: { path: { step: 'config', pointer: '/entry' } } },
      step('config'),
      { id: 'search', tool: 'GrepTool', args: { path: 'main.ts' }, bindings: { pattern: { step: 'config', pointer: '/name' } } },
      { id: 'files', tool: 'GlobTool', args: { pattern: '*.ts' } },
    ], registry, { cwd });
    expect(result.ok).toBe(true);
    expect(result.steps.map(s => s.id)).toEqual(['source', 'config', 'search', 'files']);
    expect(result.steps[0].output).toBe('export const needle = 42;\n');
    expect(result.steps[2].output).toContain('needle = 42');
    expect(result.steps[3].output).toContain('main.ts');
    expect(approve).toHaveBeenCalledTimes(4);
    expect(await fs.readFile(path.join(cwd, 'dirty.txt'))).toEqual(before);
  });

  it.each([
    [step('a'), step('a')],
    [{ ...step('a'), dependsOn: ['missing'] }],
    [{ ...step('a'), dependsOn: ['b'] }, { ...step('b'), dependsOn: ['a'] }],
    [step('a'), { id: 'b', tool: 'BashTool', args: { command: 'ls' } }],
    [step('a'), { ...step('b'), tool: 'read_file' }],
    [step('a'), { ...step('b'), args: {} }],
    [step('a'), { ...step('b'), bindings: { path: { step: 'a' } } }],
  ])('rejects invalid graph before any child executes: %j', async (...steps) => {
    await expect(runToolWorkflow(steps as WorkflowStep[], registry, { cwd })).rejects.toThrow();
    expect(approve).not.toHaveBeenCalled();
  });

  it('skips transitive dependents on a real missing file and completes another branch', async () => {
    const result = await runToolWorkflow([
      step('missing', { path: 'absent.ts' }),
      { ...step('child'), dependsOn: ['missing'] },
      { ...step('grandchild'), dependsOn: ['child'] },
      step('independent'),
    ], registry, { cwd });
    expect(result.ok).toBe(false);
    expect(result.steps.map(s => s.status)).toEqual(['error', 'skipped', 'skipped', 'ok']);
    expect(approve).toHaveBeenCalledTimes(2);
  });

  it('preserves nested governor refusals and hook blocks', async () => {
    approve.mockRejectedValueOnce(new Error('Permission denied'));
    let result = await runToolWorkflow([step('a')], registry, { cwd });
    expect(result.steps[0].status).toBe('error');
    registerPreHook('ReadFileTool', () => ({ block: true, reason: 'protected fixture' }));
    result = await runToolWorkflow([step('a')], registry, { cwd });
    expect(result.steps[0].status).toBe('error');
    expect(result.steps[0].output).toContain('protected fixture');
    expect(result.steps[0].output).not.toContain('needle');
  });

  it('propagates invalid search outcomes without treating error prose as successful data', async () => {
    const result = await runToolWorkflow([
      { id: 'bad', tool: 'GrepTool', args: { pattern: '[' } },
      { ...step('child'), dependsOn: ['bad'] },
    ], registry, { cwd });
    expect(result.steps.map(s => s.status)).toEqual(['error', 'skipped']);
  });

  it('overlaps independent steps and starts a dependent before an unrelated slow branch finishes', async () => {
    const slow = latch();
    const childStarted = latch();
    const starts: string[] = [];
    register(registry, governor, async args => {
      starts.push(args.id);
      if (args.id === 'slow') await slow.promise;
      if (args.id === 'child') childStarted.resolve();
      return args.id;
    });
    const run = runToolWorkflow([
      { id: 'fast', tool: 'ProbeTool', args: { id: 'fast' } },
      { id: 'slow', tool: 'ProbeTool', args: { id: 'slow' } },
      { id: 'child', tool: 'ProbeTool', args: { id: 'child' }, dependsOn: ['fast'] },
    ], registry);
    await childStarted.promise;
    expect(starts).toEqual(['fast', 'slow', 'child']);
    slow.resolve();
    expect((await run).ok).toBe(true);
  });

  it('serializes tools whose concurrency declaration is exclusive', async () => {
    let live = 0;
    let peak = 0;
    register(registry, governor, async () => {
      peak = Math.max(peak, ++live);
      await new Promise(r => setTimeout(r, 1));
      live--;
      return 'ok';
    }, false);
    await runToolWorkflow(Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, tool: 'ProbeTool', args: {} })), registry);
    expect(peak).toBe(1);
  });

  it('stops dispatch on interrupt and drains an operation that ignores cancellation', async () => {
    const controller = new AbortController();
    const started = latch();
    const finish = latch();
    let calls = 0;
    register(registry, governor, async () => { calls++; started.resolve(); await finish.promise; return 'finished'; }, false);
    let settled = false;
    const run = runToolWorkflow([
      { id: 'a', tool: 'ProbeTool', args: {} }, { id: 'b', tool: 'ProbeTool', args: {} },
    ], registry, { signal: controller.signal }).then(r => { settled = true; return r; });
    await started.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish.resolve();
    expect((await run).steps.map(s => s.status)).toEqual(['cancelled', 'cancelled']);
    expect(calls).toBe(1);
  });

  it('retains full intermediate text beyond previews and resolves text lines', async () => {
    const content = 'x'.repeat(3000) + '\nmain.ts';
    await fs.writeFile(path.join(cwd, 'pointer.txt'), content);
    const result = await runToolWorkflow([
      step('a', { path: 'pointer.txt' }),
      { ...step('b', {}), bindings: { path: { step: 'a', line: 1 } } },
    ], registry, { cwd });
    expect(result.ok).toBe(true);
    expect(result.steps[0].truncated).toBe(true);
    expect(result.steps[0].output.length).toBe(2000);
    expect(result.steps[1].output).toContain('needle = 42');
  });

  it.each(['/missing', '/__proto__', '/constructor', '/bad~2escape'])('refuses invalid or inherited JSON pointers: %s', async pointer => {
    const result = await runToolWorkflow([
      step('a'), { ...step('b', {}), bindings: { path: { step: 'a', pointer } } },
    ], registry, { cwd });
    expect(result.steps.map(s => s.status)).toEqual(['ok', 'error']);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized intermediate results and skips their consumers', async () => {
    register(registry, governor, async () => '界'.repeat(23000));
    const result = await runToolWorkflow([
      { id: 'big', tool: 'ProbeTool', args: {} }, { ...step('child'), dependsOn: ['big'] },
    ], registry);
    expect(result.steps.map(s => s.status)).toEqual(['error', 'skipped']);
    expect(result.steps[0].output).toContain('64 KiB');
  });

  it('exposes a deferred outer barrier and reports aggregate failure through the factory', async () => {
    const tool = createToolWorkflowTool(governor, registry);
    registry.register(tool);
    expect(registry.isDeferred(tool.name)).toBe(true);
    expect(registry.searchDeferred('select:ToolWorkflowTool')[0].name).toBe(tool.name);
    expect(tool.concurrencySafeFor?.({})).toBe(false);
    const reportOutcome = jest.fn();
    const raw = await tool.execute({ steps: [step('a', { path: 'missing' })] }, { cwd, reportOutcome });
    expect(JSON.parse(raw).ok).toBe(false);
    expect(reportOutcome).toHaveBeenCalledTimes(1);
    expect(reportOutcome.mock.calls[0][0].status).toBe('error');
  });

  it('rejects non-opted-in tools even if they advertise read-only concurrency', async () => {
    registry.register(buildTool({ name: 'OtherTool', description: '', schema: {}, isDestructive: false, isConcurrencySafe: true, execute: async () => 'no' }, governor));
    await expect(runToolWorkflow([{ id: 'a', tool: 'OtherTool', args: {} }], registry)).rejects.toThrow('not eligible');
    expect(approve).not.toHaveBeenCalled();
  });

  it('validates bound arguments before the destination tool runs', async () => {
    await fs.writeFile(path.join(cwd, 'invalid.json'), '{"path":[]}');
    const result = await runToolWorkflow([
      step('a', { path: 'invalid.json' }),
      { ...step('b', {}), bindings: { path: { step: 'a', pointer: '/path' } } },
    ], registry, { cwd });
    expect(result.steps.map(s => s.status)).toEqual(['ok', 'error']);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('honors the configured pool bound and refuses more than 32 steps', async () => {
    const previous = process.env.BIMAX_MAX_PARALLEL_TOOLS;
    process.env.BIMAX_MAX_PARALLEL_TOOLS = '2';
    let live = 0;
    let peak = 0;
    register(registry, governor, async () => {
      peak = Math.max(peak, ++live);
      await new Promise(r => setTimeout(r, 1));
      live--;
      return 'ok';
    });
    try {
      const steps = Array.from({ length: 32 }, (_, i) => ({ id: `s${i}`, tool: 'ProbeTool', args: {} }));
      expect((await runToolWorkflow(steps, registry)).ok).toBe(true);
      expect(peak).toBe(2);
      await expect(runToolWorkflow([...steps, { id: 'extra', tool: 'ProbeTool', args: {} }], registry)).rejects.toThrow('1–32');
      expect(approve).toHaveBeenCalledTimes(32);
    } finally {
      if (previous === undefined) delete process.env.BIMAX_MAX_PARALLEL_TOOLS;
      else process.env.BIMAX_MAX_PARALLEL_TOOLS = previous;
    }
  });
});
