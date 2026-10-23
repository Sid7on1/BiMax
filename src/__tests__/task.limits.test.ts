import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentLoop } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import type { ChatEvent, LLMProvider } from '../core/llm.provider';
import { engineEvents } from '../engine/events';
import { CONFIG_WIRE_KEYS } from '../protocol/config.wire';
import { FORWARDED_EVENTS } from '../protocol/protocol';
import { CompletionChecks } from '../outcome/completion.check';

/**
 * Backlog F5, the two limits still open: retries and wall-clock time per task. Spend and concurrency were done
 * 2026-09-19.
 */

/** A model that calls a long-running tool every round. */
function slowWork(): { loop: (maxMinutes?: number) => AgentLoop; ran: { calls: number; aborted: number } } {
  const ran = { calls: 0, aborted: 0 };
  const tools = new ToolRegistry();
  tools.register({
    name: 'BashTool', description: 'run a command', isDestructive: true, isConcurrencySafe: false,
    schema: { type: 'object', properties: { command: { type: 'string' } } },
    execute: (_args: unknown, context: any) => new Promise((resolve, reject) => {
      ran.calls++;
      const done = setTimeout(() => resolve('{"stdout":"step done","stderr":""}'), 10_000);
      context?.signal?.addEventListener('abort', () => { clearTimeout(done); ran.aborted++; reject(Object.assign(new Error('Command interrupted'), { name: 'AbortError' })); });
    }),
  } as any);
  let round = 0;
  const llm = {
    userModel: 'test-model',
    async *chat(): AsyncGenerator<ChatEvent> {
      round++;
      yield { type: 'tool_call', id: `c${round}`, name: 'BashTool', args: JSON.stringify({ command: `step ${round}` }) } as any;
      yield { type: 'done' } as any;
    },
  } as unknown as LLMProvider;
  return { loop: () => new AgentLoop(llm, tools), ran };
}

async function drain(loop: AgentLoop, options: any): Promise<string> {
  let out = '';
  for await (const chunk of loop.execute([{ role: 'user', content: 'Work through the steps.' }] as any, 'system', options)) out += chunk;
  return out;
}

describe('the time limit', () => {
  test('stops a run at its limit, even mid-command, and says it was the limit', async () => {
    const { loop, ran } = slowWork();
    const limits = jest.fn();
    engineEvents.on('turn_limit', limits);
    const started = Date.now();
    let out: string;
    try { out = await drain(loop(), { maxMinutes: 0.003, maxIterations: 50 }); } finally { engineEvents.off('turn_limit', limits); }
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ran.aborted).toBe(1);
    expect(out).toContain('⏱ Stopped: this run reached its time limit of 0.003 minutes');
    expect(limits).toHaveBeenCalledWith({ kind: 'time', minutes: 0.003 });
  });

  test('stops at the limit when the app also passes its Stop signal, as it always does', async () => {
    const { loop, ran } = slowWork();
    const stop = new AbortController();
    const out = await drain(loop(), { maxMinutes: 0.003, signal: stop.signal, maxIterations: 50 });
    expect(ran.aborted).toBe(1);
    expect(stop.signal.aborted).toBe(false);
    expect(out).toContain('⏱ Stopped: this run reached its time limit');
  });

  test('a Stop from the user is not reported as the time limit', async () => {
    const { loop } = slowWork();
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const limits = jest.fn();
    engineEvents.on('turn_limit', limits);
    let out: string;
    try { out = await drain(loop(), { maxMinutes: 5, signal: stop.signal, maxIterations: 50 }); } finally { engineEvents.off('turn_limit', limits); }
    expect(out).not.toContain('time limit');
    expect(limits).not.toHaveBeenCalled();
  });

  test('no limit set means no timer: the run is untouched', async () => {
    const tools = new ToolRegistry();
    const llm = { userModel: 'm', async *chat(): AsyncGenerator<ChatEvent> { yield { type: 'token', text: 'Answer.' } as any; yield { type: 'done' } as any; } } as unknown as LLMProvider;
    expect(await drain(new AgentLoop(llm, tools), {})).toBe('Answer.');
  });
});

describe('the retry limit', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-limits-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.BIMAX_TASK_MAX_RETRIES; });

  /** How many times a check that always fails runs before the turn ends. */
  async function runsBeforeGivingUp(checks: CompletionChecks): Promise<number> {
    let runs = 0;
    const run = async () => { runs++; return { exitCode: 1, output: 'failed' }; };
    checks.beginTurn();
    checks.set([{ kind: 'command', command: 'npm test' }]);
    for (let i = 0; i < 20; i++) if ('end' in await checks.settle(run, dir)) break;
    return runs;
  }

  test('comes from Settings, a per-task override beats Settings, and the default is two retries', async () => {
    const make = (configured?: number) => new CompletionChecks({ sessionId: () => 's', directory: () => dir, configuredRetries: () => configured });
    expect(await runsBeforeGivingUp(make(undefined))).toBe(3);
    expect(await runsBeforeGivingUp(make(4))).toBe(5);
    process.env.BIMAX_TASK_MAX_RETRIES = '0';
    expect(await runsBeforeGivingUp(make(4))).toBe(1);
    process.env.BIMAX_TASK_MAX_RETRIES = '';
    expect(await runsBeforeGivingUp(make(1))).toBe(2);
  });
});

test('both limits can be read and written from Settings, and the stop reaches the app', () => {
  expect(CONFIG_WIRE_KEYS).toEqual(expect.arrayContaining(['taskCheckRetries', 'taskMaxMinutes']));
  expect(FORWARDED_EVENTS).toEqual(expect.arrayContaining(['turn_limit', 'completion_check']));
});
