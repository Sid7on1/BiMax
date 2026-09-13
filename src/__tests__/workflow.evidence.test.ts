import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { WorkflowEvidence, evidenceIsCurrent, readEvidenceFile } from '../core/workflow.evidence';
import { createToolWorkflowTool } from '../tools/implementations/workflow.tool';
import { createReadFileTool } from '../tools/implementations/file.tool';
import { createGrepTool, createGlobTool } from '../tools/implementations/search.tool';
import { ToolRegistry } from '../tools/tool.registry';
import { IGovernor } from '../core/interfaces';
import { WorkflowStep, WorkflowResult } from '../core/tool.workflow';
import { clearHooks, registerPreHook, registerPostHook } from '../tools/hooks';
import { walkFiles } from '../utils/fsWalk';
import { WorkflowStore } from '../core/workflow.store';

interface Result { ok: boolean; workflowId?: string; retained: boolean; steps: WorkflowResult[]; error?: string }
const read = (id: string, file: string): WorkflowStep => ({ id, tool: 'ReadFileTool', args: { path: file } });

describe('workflow evidence and incremental refresh', () => {
  let cwd: string;
  let registry: ToolRegistry;
  let tool: ReturnType<typeof createToolWorkflowTool>;
  let approve: jest.Mock;
  let context: { cwd: string; sessionId: string };
  const run = async (steps: WorkflowStep[]): Promise<Result> => JSON.parse(await tool.execute({ steps }, context));
  const refresh = async (workflowId: string): Promise<Result> => JSON.parse(await tool.execute({ action: 'refresh', workflowId }, context));
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-evidence-'));
    context = { cwd, sessionId: 'fixture-session' };
    approve = jest.fn(async () => {});
    const governor = { approveTaskExecution: approve } as unknown as IGovernor;
    registry = new ToolRegistry();
    registry.register(createReadFileTool(governor));
    registry.register(createGrepTool(governor));
    registry.register(createGlobTool(governor));
    tool = createToolWorkflowTool(governor, registry);
    await fs.writeFile(path.join(cwd, 'config.json'), '{"entry":"a.ts"}');
    await fs.writeFile(path.join(cwd, 'a.ts'), 'export const value = 1;');
    await fs.writeFile(path.join(cwd, 'b.ts'), 'export const value = 2;');
    await fs.writeFile(path.join(cwd, 'human.txt'), 'unfinished human edit');
  });
  afterEach(async () => { clearHooks(); await fs.rm(cwd, { recursive: true, force: true }); });

  const graph = (): WorkflowStep[] => [
    read('config', 'config.json'),
    { id: 'source', tool: 'ReadFileTool', args: {}, bindings: { path: { step: 'config', pointer: '/entry' } } },
    read('independent', 'human.txt'),
  ];

  it('reuses unchanged branches, but reruns a changed input and its dependents', async () => {
    const first = await run(graph());
    expect(first.ok).toBe(true);
    expect(first.steps.map(s => s.freshness)).toEqual(['current', 'current', 'current']);
    expect(first.steps.every(s => !!s.evidenceDigest && !!s.checkedAt && s.inputCount === 1)).toBe(true);
    const second = await refresh(first.workflowId!);
    expect(second.steps.map(s => s.reused)).toEqual([true, true, true]);
    await fs.writeFile(path.join(cwd, 'config.json'), '{"entry":"b.ts"}');
    const third = await refresh(first.workflowId!);
    expect(third.steps.map(s => s.reused)).toEqual([false, false, true]);
    expect(third.steps[1].output).toBe('export const value = 2;');
    expect(third.steps[0].evidenceDigest).not.toBe(first.steps[0].evidenceDigest);
    expect(await fs.readFile(path.join(cwd, 'human.txt'), 'utf8')).toBe('unfinished human edit');
    // Outer + every child still reaches the Governor, including the all-reused run.
    expect(approve).toHaveBeenCalledTimes(12);
  });

  it('detects byte changes even when size and modification time are preserved', async () => {
    const file = path.join(cwd, 'a.ts');
    const before = await fs.stat(file);
    const first = await run([read('a', 'a.ts')]);
    await fs.writeFile(file, 'export const value = 9;');
    await fs.utimes(file, before.atime, before.mtime);
    const next = await refresh(first.workflowId!);
    expect(next.steps[0].reused).toBe(false);
    expect(next.steps[0].output).toBe('export const value = 9;');
  });

  it('reruns descendants of changed evidence even when their resolved arguments are unchanged', async () => {
    const first = await run(graph());
    await fs.writeFile(path.join(cwd, 'config.json'), '{ "entry": "a.ts" }');
    const next = await refresh(first.workflowId!);
    expect(next.steps.map(s => s.reused)).toEqual([false, false, true]);
    expect(next.steps[1].output).toBe(first.steps[1].output);
  });

  it('invalidates search absence when a new matching file appears', async () => {
    const first = await run([
      { id: 'search', tool: 'GrepTool', args: { pattern: 'UNIQUE_MARKER', path: '.', glob: '*.ts' } },
      read('independent', 'human.txt'),
    ]);
    expect(first.steps[0].freshness).toBe('current');
    expect(first.steps[0].output).toContain('No matches');
    expect((await refresh(first.workflowId!)).steps[0].reused).toBe(true);
    await fs.writeFile(path.join(cwd, 'new.ts'), 'export const UNIQUE_MARKER = true;');
    const next = await refresh(first.workflowId!);
    expect(next.steps.map(s => s.reused)).toEqual([false, true]);
    expect(next.steps[0].output).toContain('UNIQUE_MARKER = true');
  });

  it('invalidates glob membership on deletion and empty-directory additions', async () => {
    await fs.mkdir(path.join(cwd, 'empty'));
    const first = await run([{ id: 'files', tool: 'GlobTool', args: { pattern: '**/*.ts' } }]);
    await fs.unlink(path.join(cwd, 'a.ts'));
    await fs.writeFile(path.join(cwd, 'empty', 'nested.ts'), '');
    const next = await refresh(first.workflowId!);
    expect(next.steps[0].reused).toBe(false);
    expect(next.steps[0].output).not.toContain('\na.ts');
    expect(next.steps[0].output).toContain('empty/nested.ts');
  });

  it('does not reuse incomplete result-limited searches or their dependent conclusions', async () => {
    const first = await run([
      { id: 'search', tool: 'GrepTool', args: { pattern: 'value', glob: '*.ts', maxResults: 1 } },
      { ...read('dependent', 'human.txt'), dependsOn: ['search'] },
    ]);
    expect(first.steps.map(s => s.freshness)).toEqual(['incomplete', 'incomplete']);
    expect(first.steps[0].evidenceGaps).toContain('Result limit reached');
    expect((await refresh(first.workflowId!)).steps.map(s => s.reused)).toEqual([false, false]);
  });

  it('marks binary-file omission incomplete rather than complete absence', async () => {
    await fs.writeFile(path.join(cwd, 'binary.dat'), Buffer.from([0, 1, 2]));
    const result = await run([{ id: 'search', tool: 'GrepTool', args: { pattern: 'absent', path: 'binary.dat' } }]);
    expect(result.steps[0].freshness).toBe('incomplete');
    expect(result.steps[0].evidenceGaps).toContain('Binary file skipped');
  });

  it('detects a change in a post-hook before allowing a dependent to consume it', async () => {
    registerPostHook('ReadFileTool', async (_name, args) => {
      if (args.path === 'config.json') await fs.writeFile(path.join(cwd, 'config.json'), '{"entry":"b.ts"}');
    });
    const result = await run(graph());
    expect(result.ok).toBe(false);
    expect(result.steps[0].freshness).toBe('stale');
    expect(result.steps[1].status).toBe('skipped');
    expect(result.steps[1].freshness).toBe('stale');
    expect(result.steps[2].freshness).toBe('current');
  });

  it('propagates a late stale input to already-completed descendants at the final check', async () => {
    registerPostHook('ReadFileTool', async (_name, args) => {
      if (args.path === 'human.txt') await fs.writeFile(path.join(cwd, 'config.json'), '{"entry":"b.ts"}');
    });
    const steps = graph();
    steps[2].dependsOn = ['source'];
    const result = await run(steps);
    expect(result.ok).toBe(false);
    expect(result.steps.map(s => s.freshness)).toEqual(['stale', 'stale', 'stale']);
  });

  it('checks current permission and hooks before returning a reusable result', async () => {
    const first = await run([read('a', 'a.ts')]);
    registerPreHook('ReadFileTool', () => ({ block: true, reason: 'revoked' }));
    const result = await refresh(first.workflowId!);
    expect(result.ok).toBe(false);
    expect(result.steps[0].output).toContain('revoked');
    expect(result.steps[0].output).not.toContain('value = 1');
  });

  it('rejects a revoked Governor permission before touching the cached result', async () => {
    const first = await run([read('a', 'a.ts')]);
    approve.mockImplementation(async (_type: string, payload: { tool: string }) => {
      if (payload.tool === 'ReadFileTool') throw new Error('read permission revoked');
    });
    const result = await refresh(first.workflowId!);
    expect(result.ok).toBe(false);
    expect(result.steps[0].output).toContain('read permission revoked');
    expect(result.steps[0].output).not.toContain('value = 1');
  });

  it('revalidates arguments after pre-hooks before selecting cached raw output', async () => {
    const first = await run([read('a', 'a.ts')]);
    registerPreHook('ReadFileTool', (_name, args) => { args.path = 'b.ts'; });
    const result = await refresh(first.workflowId!);
    expect(result.steps[0].reused).toBe(false);
    expect(result.steps[0].output).toContain('value = 2');
  });

  it('does not reuse output across a tool implementation replacement', async () => {
    const first = await run([read('a', 'a.ts')]);
    const governor = { approveTaskExecution: approve } as unknown as IGovernor;
    registry.register(createReadFileTool(governor));
    const result = await refresh(first.workflowId!);
    expect(result.steps[0].reused).toBe(false);
  });

  it('recomputes post-hook output and never accumulates old appended text', async () => {
    const first = await run([read('a', 'a.ts')]);
    registerPostHook('ReadFileTool', () => ({ appendToResult: 'fresh diagnostic' }));
    const second = await refresh(first.workflowId!);
    expect(second.steps[0].freshness).toBe('incomplete');
    expect(second.steps[0].output.match(/fresh diagnostic/g)).toHaveLength(1);
    const third = await refresh(first.workflowId!);
    expect(third.steps[0].reused).toBe(false);
    expect(third.steps[0].output.match(/fresh diagnostic/g)).toHaveLength(1);
  });

  it('fences retained graphs by session and cwd', async () => {
    const first = await run([read('a', 'a.ts')]);
    const otherSession = JSON.parse(await tool.execute({ action: 'refresh', workflowId: first.workflowId }, { ...context, sessionId: 'other' }));
    expect(otherSession.ok).toBe(false);
    expect(otherSession.steps).toEqual([]);
    const otherDir = JSON.parse(await tool.execute({ action: 'refresh', workflowId: first.workflowId }, { ...context, cwd: path.dirname(cwd) }));
    expect(otherDir.ok).toBe(false);
  });

  it('never accepts a replacement plan during refresh', async () => {
    const first = await run([read('a', 'a.ts')]);
    const result = JSON.parse(await tool.execute({ action: 'refresh', workflowId: first.workflowId, steps: [read('b', 'b.ts')] }, context));
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([]);
  });

  it('detects retargeting of a symlink to different content', async () => {
    await fs.symlink(path.join(cwd, 'a.ts'), path.join(cwd, 'link.ts'));
    const first = await run([read('link', 'link.ts')]);
    await fs.unlink(path.join(cwd, 'link.ts'));
    await fs.symlink(path.join(cwd, 'b.ts'), path.join(cwd, 'link.ts'));
    const result = await refresh(first.workflowId!);
    expect(result.steps[0].reused).toBe(false);
    expect(result.steps[0].output).toContain('value = 2');
  });

  it('bounds file reads before allocating a whole oversized file', async () => {
    await expect(readEvidenceFile(path.join(cwd, 'a.ts'), undefined, 4)).rejects.toThrow('byte limit');
    const collector = new WorkflowEvidence();
    await expect(collector.readFile(path.join(cwd, 'missing'))).rejects.toThrow();
    expect(collector.snapshot().complete).toBe(false);
  });

  it('rejects missing observations and stops walks on cancellation', async () => {
    expect(await evidenceIsCurrent(new WorkflowEvidence().snapshot())).toBe(false);
    const abort = new AbortController();
    let visited = 0;
    await expect((async () => {
      for await (const _file of walkFiles(cwd, { signal: abort.signal })) { visited++; abort.abort(); }
    })()).rejects.toThrow();
    expect(visited).toBe(1);
  });

  it('reports a capped or unreadable walk as incomplete', async () => {
    const gaps: string[] = [];
    for await (const _file of walkFiles(cwd, { maxFiles: 1, onIncomplete: reason => gaps.push(reason) })) { /* drain */ }
    expect(gaps).toContain('File scan limit reached');
    for await (const _file of walkFiles(path.join(cwd, 'missing'), { onIncomplete: reason => gaps.push(reason) })) { /* drain */ }
    expect(gaps).toContain('Directory could not be read');
  });

  it('expires retained workflows and rejects overlapping refreshes', () => {
    const store = new WorkflowStore();
    const id = store.save('scope', [], new Map())!;
    store.acquire(id, 'scope');
    expect(() => store.acquire(id, 'scope')).toThrow('already running');
    store.release(id);
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
    try { expect(() => store.acquire(id, 'scope')).toThrow('unavailable'); }
    finally { now.mockRestore(); }
  });

  it('bounds the retained workflow count by evicting old idle entries', () => {
    const store = new WorkflowStore();
    const first = store.save('scope', [], new Map())!;
    for (let i = 0; i < 16; i++) store.save('scope', [], new Map());
    expect(() => store.acquire(first, 'scope')).toThrow('unavailable');
  });

  it('bounds retained state bytes instead of keeping an oversized graph', () => {
    const store = new WorkflowStore();
    expect(store.save('scope', [read('big', 'x'.repeat(8 * 1024 * 1024))], new Map())).toBeUndefined();
  });
});
