import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentLoop } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import type { ChatEvent, LLMProvider } from '../core/llm.provider';
import { engineEvents } from '../engine/events';
import {
  ASK_FOR_CHECK, CompletionChecks, __setCompletionChecks, changesFiles, isTestFile, type CommandRunner,
} from '../outcome/completion.check';
import { createCompletionCheckTool } from '../tools/implementations/completion.check.tool';

/**
 * Backlog F3: "done" means a stated check passed. A task ended "completed" whenever a turn finished without an error,
 * and nothing looked at the work.
 */

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-check-')); });
afterEach(() => { __setCompletionChecks(null); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.BIMAX_TASK_MAX_RETRIES; });

const checksFor = (session = 's1', maxRetries?: number) =>
  new CompletionChecks({ sessionId: () => session, directory: () => dir, ...(maxRetries === undefined ? {} : { maxRetries: () => maxRetries }) });

/** A runner answering each command with the next exit code, recording what it was asked to run. */
function runner(codes: Array<number | null>): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (command: string) => {
    calls.push(command);
    const exitCode = codes.length ? codes.shift()! : 0;
    return { exitCode, output: JSON.stringify({ stdout: exitCode === 0 ? 'Tests: 12 passed' : 'Tests: 1 failed, 11 passed', stderr: '' }) };
  }) as CommandRunner & { calls: string[] };
  run.calls = calls;
  return run;
}

describe('the rules', () => {
  test('a turn that changed files and has no check is asked once, then ends finished but not checked', async () => {
    const checks = checksFor();
    checks.beginTurn();
    checks.noteChange();
    expect(await checks.settle(runner([]), dir)).toEqual({ continue: ASK_FOR_CHECK });
    expect(await checks.settle(runner([]), dir)).toEqual({ end: null });
    expect(checks.snapshot().state).toBe('unchecked');
  });

  test('a turn that changed nothing is not asked, and says nothing', async () => {
    const checks = checksFor();
    checks.beginTurn();
    expect(await checks.settle(runner([]), dir)).toEqual({ end: null });
    expect(checks.snapshot().state).toBe('none');
  });

  test('the engine runs the check itself and a pass ends the turn saying so', async () => {
    const checks = checksFor();
    checks.beginTurn();
    checks.set([{ kind: 'command', command: 'npm test' }]);
    checks.noteChange();
    const run = runner([0]);
    const verdict = await checks.settle(run, dir);
    expect(run.calls).toEqual(['npm test']);
    expect(verdict).toEqual({ end: expect.stringContaining('✓ Completion check passed: `npm test` exits 0') });
    expect(checks.snapshot().state).toBe('passed');
  });

  test('a failure sends the task back with the output, and after the retry limit the turn ends not done', async () => {
    const checks = checksFor('s1', 1);
    checks.beginTurn();
    checks.set([{ kind: 'command', command: 'npm test' }]);
    checks.noteChange();
    const run = runner([1, 1]);
    const first = await checks.settle(run, dir);
    expect(first).toEqual({ continue: expect.stringContaining('Tests: 1 failed, 11 passed') });
    expect((first as { continue: string }).continue).toContain('attempt 1 of 2');
    // Nothing changed after the failure, and the check still runs again rather than ending quietly.
    const second = await checks.settle(run, dir);
    expect(run.calls).toHaveLength(2);
    expect(second).toEqual({ end: expect.stringContaining('✕ Completion check failed 2 times, so this task is not done') });
    expect(checks.snapshot().state).toBe('failed');
  });

  test('the model cannot change or skip a check that failed in the same turn; the user can, in their next one', async () => {
    const checks = checksFor();
    checks.beginTurn();
    checks.set([{ kind: 'command', command: 'npm test' }]);
    checks.noteChange();
    await checks.settle(runner([1]), dir);
    expect(checks.set([{ kind: 'command', command: 'true' }])).toMatch(/can only be changed when the user asks/);
    expect(checks.skip('too hard')).toMatch(/can only be skipped when the user asks/);
    checks.beginTurn(true); // an engine wake is the same task
    expect(checks.set([{ kind: 'command', command: 'true' }])).not.toBeNull();
    checks.beginTurn(false); // the user's next message
    expect(checks.set([{ kind: 'command', command: 'npm test -- billing' }])).toBeNull();
  });

  test('a pass goes stale when files change after it, and nothing reruns when nothing changed', async () => {
    const checks = checksFor();
    checks.beginTurn();
    checks.set([{ kind: 'command', command: 'npm test' }]);
    await checks.settle(runner([0]), dir);
    checks.beginTurn();
    const idle = runner([0]);
    expect(await checks.settle(idle, dir)).toEqual({ end: null });
    expect(idle.calls).toEqual([]);
    checks.noteChange();
    expect(checks.snapshot().state).toBe('pending');
    const rerun = runner([0]);
    await checks.settle(rerun, dir);
    expect(rerun.calls).toEqual(['npm test']);
  });

  test('file and JSON checks are read directly', async () => {
    fs.writeFileSync(path.join(dir, 'report.md'), '# Totals\nGrand total: 42');
    fs.writeFileSync(path.join(dir, 'data.json'), '{"ok": tru');
    const checks = checksFor('s1', 0);
    checks.beginTurn();
    checks.set([
      { kind: 'file', path: 'report.md', contains: 'Grand total' },
      { kind: 'file', path: 'missing.pdf' },
      { kind: 'json', path: 'data.json' },
    ]);
    const verdict = await checks.settle(runner([]), dir) as { end: string };
    expect(verdict.end).toContain('missing.pdf does not exist');
    expect(verdict.end).toContain('data.json is not valid JSON');
    expect(verdict.end).not.toContain('report.md');
    expect(checks.snapshot().results.map((r) => r.ok)).toEqual([true, false, false]);
  });

  test('the check and its result are saved per session, so a resumed task keeps them (F2)', async () => {
    const before = checksFor('2026-09-21_09-00-00');
    before.beginTurn();
    before.set([{ kind: 'command', command: 'npm test' }]);
    before.noteChange();
    await before.settle(runner([1, 1, 1]), dir);
    const after = checksFor('2026-09-21_09-00-00');
    after.syncSession();
    expect(after.snapshot()).toMatchObject({ state: 'failed', checks: [{ kind: 'command', command: 'npm test' }], attempts: 0 });
    expect(after.promptBlock()).toContain('Last run: failed');
    expect(checksFor('another').snapshot().checks).toEqual([]);
  });

  test('the retry limit comes from the task (F5), and 0 means one run and no retry', async () => {
    process.env.BIMAX_TASK_MAX_RETRIES = '0';
    const checks = checksFor();
    checks.beginTurn();
    checks.set([{ kind: 'command', command: 'npm test' }]);
    expect(await checks.settle(runner([1]), dir)).toEqual({ end: expect.stringContaining('failed 1 time,') });
  });

  test('a pass that follows edits to test files says so, because the pass may rest on them', async () => {
    const checks = checksFor();
    checks.beginTurn();
    checks.set([{ kind: 'command', command: 'npm test' }]);
    checks.noteChange('math.js');
    checks.noteChange('test-strings.js');
    const verdict = await checks.settle(runner([0]), dir) as { end: string };
    expect(verdict.end).toContain('✓ Completion check passed');
    expect(verdict.end).toContain('This task also changed test files (test-strings.js)');
    expect(checks.snapshot()).toMatchObject({ state: 'passed', testsEdited: ['test-strings.js'] });
    expect(checks.promptBlock()).toContain('Do not edit the tests a check runs');
    // The next user turn's clean pass clears the flag.
    checks.beginTurn();
    checks.noteChange('math.js');
    await checks.settle(runner([0]), dir);
    expect(checks.snapshot().testsEdited).toBeUndefined();
  });

  test('which paths are test files', () => {
    for (const file of ['test.js', 'test-strings.js', 'test_math.py', 'math.test.ts', 'math_test.go', 'charge.spec.tsx', 'tests/conftest.py', 'src/__tests__/a.ts', 'spec/models/user_spec.rb']) {
      expect([file, isTestFile(file)]).toEqual([file, true]);
    }
    for (const file of ['math.js', 'testing.md', 'contest.js', 'src/latest.ts', 'attestation.ts', 'package.json']) {
      expect([file, isTestFile(file)]).toEqual([file, false]);
    }
  });

  test('what counts as changing files', () => {
    expect(changesFiles('WriteFileTool', '{"path":"a.ts"}', 'ok')).toBe(true);
    expect(changesFiles('DeleteTool', '{"path":"a.ts"}', 'ok')).toBe(true);
    expect(changesFiles('ReadFileTool', '{"path":"a.ts"}', 'ok')).toBe(false);
    expect(changesFiles('BashTool', JSON.stringify({ command: 'mv a.txt b.txt' }), '')).toBe(true);
    expect(changesFiles('BashTool', JSON.stringify({ command: 'npm install left-pad' }), '')).toBe(true);
    expect(changesFiles('BashTool', JSON.stringify({ command: 'ls -la' }), '')).toBe(false);
    expect(changesFiles('BashTool', JSON.stringify({ command: 'npm test' }), '')).toBe(false);
    expect(changesFiles('DocumentTool', '{}', 'Draft retained: 120 words')).toBe(false);
    expect(changesFiles('DocumentTool', '{}', 'Wrote report.pdf')).toBe(true);
  });
});

describe('CompletionCheckTool', () => {
  const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as any;

  test('is always sent to the model, since the engine tells the model to call it', () => {
    const tools = new ToolRegistry();
    tools.register(createCompletionCheckTool(governor));
    expect(tools.isSent('CompletionCheckTool', 'smart')).toBe(true);
  });

  test('sets a check and tells the user, who can change it', async () => {
    const checks = checksFor();
    __setCompletionChecks(checks);
    checks.beginTurn();
    const told = jest.fn();
    engineEvents.on('message', told);
    try {
      const result = await createCompletionCheckTool(governor).execute({ action: 'set', checks: [{ kind: 'command', command: 'npm test' }] });
      expect(result).toContain('The task is not done until it passes');
    } finally { engineEvents.off('message', told); }
    expect(told).toHaveBeenCalledWith(expect.objectContaining({ role: 'system', content: expect.stringContaining('Completion check: `npm test` exits 0') }));
    expect(checks.snapshot().state).toBe('pending');
  });

  test('refuses a malformed check with the reason', async () => {
    __setCompletionChecks(checksFor());
    await expect(createCompletionCheckTool(governor).execute({ action: 'set', checks: [{ kind: 'command' }] }))
      .rejects.toThrow(/check 1 needs kind "command" with a command/);
  });
});

describe('through the agent loop', () => {
  /** A model that plays the given rounds in order: a tool call, or text. */
  function scripted(rounds: Array<{ tool: string; args: object } | string>) {
    let round = 0;
    const seen: string[] = [];
    const llm = {
      userModel: 'test-model',
      async *chat(messages: any[]): AsyncGenerator<ChatEvent> {
        seen.push(String(messages[messages.length - 1]?.content ?? ''));
        const step = rounds[round++] ?? 'Done.';
        if (typeof step === 'string') yield { type: 'token', text: step } as any;
        else yield { type: 'tool_call', id: `c${round}`, name: step.tool, args: JSON.stringify(step.args) } as any;
        yield { type: 'done' } as any;
      },
    } as unknown as LLMProvider;
    return { llm, seen };
  }

  function registry(exitCodes: number[]) {
    const shell: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: 'WriteFileTool', description: 'write a file', isDestructive: true, isConcurrencySafe: false,
      schema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: async () => 'Wrote the file.',
    } as any);
    tools.register({
      name: 'BashTool', description: 'run a command', isDestructive: true, isConcurrencySafe: false,
      schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } } },
      execute: async (args: { command: string }, context: any) => {
        shell.push(args.command);
        const exitCode = exitCodes.shift() ?? 0;
        context?.reportOutcome?.({ status: 'ok', exitCode });
        return JSON.stringify({ stdout: exitCode ? 'FAIL charge.test.ts — rounds half a cent down' : 'PASS 12 tests', stderr: exitCode ? `[command exited with code ${exitCode}]` : '' });
      },
    } as any);
    tools.register(createCompletionCheckTool({ approveTaskExecution: async () => {} } as any));
    return { tools, shell };
  }

  async function run(loop: AgentLoop): Promise<string> {
    let out = '';
    for await (const chunk of loop.execute([{ role: 'user', content: 'Fix the rounding in billing/charge.ts.' }] as any, 'system', {})) out += chunk;
    return out;
  }

  test('a task that edits is asked for a check, fails it, fixes the cause and ends only when the engine sees it pass', async () => {
    const checks = checksFor();
    __setCompletionChecks(checks);
    checks.beginTurn();
    const { tools, shell } = registry([1, 0]);
    const { llm, seen } = scripted([
      { tool: 'WriteFileTool', args: { path: 'billing/charge.ts' } },
      'Done — rounding fixed.',
      { tool: 'CompletionCheckTool', args: { action: 'set', checks: [{ kind: 'command', command: 'npm test' }] } },
      'Done.',
      { tool: 'WriteFileTool', args: { path: 'billing/charge.ts' } },
      'Fixed the half-cent case.',
    ]);
    const out = await run(new AgentLoop(llm, tools));

    expect(seen).toContain(ASK_FOR_CHECK);
    expect(seen.some((text) => text.includes('rounds half a cent down') && text.includes('the task is not done'))).toBe(true);
    // The engine ran the check twice itself; the model never ran it.
    expect(shell).toEqual(['npm test', 'npm test']);
    expect(out).toContain('✓ Completion check passed: `npm test` exits 0');
    expect(checks.snapshot().state).toBe('passed');
  });

  test('a model that claims done without fixing anything ends the turn "not done"', async () => {
    const checks = checksFor('s1', 1);
    __setCompletionChecks(checks);
    checks.beginTurn();
    checks.set([{ kind: 'command', command: 'npm test' }]);
    const { tools, shell } = registry([1, 1, 1]);
    const { llm } = scripted([
      { tool: 'WriteFileTool', args: { path: 'billing/charge.ts' } },
      'All tests pass now.',
      'I am confident the tests pass.',
    ]);
    const out = await run(new AgentLoop(llm, tools));
    expect(shell).toEqual(['npm test', 'npm test']);
    expect(out).toContain('✕ Completion check failed 2 times, so this task is not done');
    expect(checks.snapshot().state).toBe('failed');
  });

  test('a question that changes nothing runs no check and is not asked for one', async () => {
    const checks = checksFor();
    __setCompletionChecks(checks);
    checks.beginTurn();
    const { tools, shell } = registry([]);
    const { llm, seen } = scripted(['charge.ts rounds half-up.']);
    const out = await run(new AgentLoop(llm, tools));
    expect(shell).toEqual([]);
    expect(seen).not.toContain(ASK_FOR_CHECK);
    expect(out).toBe('charge.ts rounds half-up.');
  });
});
