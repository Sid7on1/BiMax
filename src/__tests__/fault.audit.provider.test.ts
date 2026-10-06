import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LlmAdapter } from '../core/llm.adapter';
import { ApiKeyManager } from '../credits/api.key.manager';
import { MemoryKeyUsageStore } from '../credits/key.usage.ledger';
import { createRunBudget, inRunBudget, reserveRun } from '../core/run.budget';
import { SubAgentManager } from '../core/subagent.manager';

function fixture() {
  const adapter = new LlmAdapter(new ApiKeyManager([
    { keyStr: 'synthetic-audit-key', provider: 'deepseek', model: 'deepseek-flash' },
  ], { store: new MemoryKeyUsageStore() }));
  adapter.applyConfig({ model: 'deepseek-flash' });
  const create = jest.fn(async () => ({
    [Symbol.asyncIterator]: async function* () {
      yield { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 500 } } };
    },
  }));
  (adapter as any).createClient = () => ({ chat: { completions: { create } } });
  return { adapter, create };
}

it('denies the actual adapter request before sending when prompt plus output exceeds the run cap', async () => {
  const { adapter, create } = fixture();
  const buffer = createRunBudget({ BIMAX_RUN_MAX_TOKENS: '100', BIMAX_RUN_MAX_USD: '5' });
  await expect(inRunBudget(buffer, async () => {
    for await (const _ of adapter.chat([{ role: 'user', content: 'x'.repeat(1000) }], { maxTokens: 50 })) {}
  })).rejects.toThrow(/token ceiling/);
  expect(create).not.toHaveBeenCalled();
});

it('settles split usage and cached input on the actual route, including generator cancellation at usage', async () => {
  const { adapter } = fixture();
  const budget = { checkVeto: jest.fn(), recordSpend: jest.fn(), releaseReservation: jest.fn() };
  adapter.setBudgetVeto(budget);
  const buffer = createRunBudget({ BIMAX_RUN_MAX_TOKENS: '10000', BIMAX_RUN_MAX_USD: '5' });
  await inRunBudget(buffer, async () => {
    for await (const event of adapter.chat([{ role: 'user', content: 'hello' }], { maxTokens: 1000 })) {
      if (event.type === 'usage') break;
    }
  });
  expect(budget.recordSpend).toHaveBeenCalledTimes(1);
  expect(budget.recordSpend.mock.calls[0][0]).toBeCloseTo(0.000393, 9);
  expect(budget.recordSpend.mock.calls[0][2]).toBe('deepseek-flash');
  expect(new BigInt64Array(buffer)[0]).toBe(1200n);
  expect(budget.releaseReservation).not.toHaveBeenCalled();
});

it('passes the same run counters through the real sub-agent worker transport', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-run-worker-'));
  const script = path.join(dir, 'worker.js');
  fs.writeFileSync(script, `const {parentPort,workerData}=require('worker_threads');
    const counters=new BigInt64Array(workerData.runBudget);
    if(counters.length!==4) throw Error('missing parent budget');
    Atomics.add(counters,0,60n);
    parentPort.postMessage({type:'success',result:'counted'});`);
  const manager = new SubAgentManager({ workerScriptPath: script, timeoutMs: 5000 });
  const buffer = createRunBudget({ BIMAX_RUN_MAX_TOKENS: '100', BIMAX_RUN_MAX_USD: '5' });
  try {
    await inRunBudget(buffer, () => manager.spawnWorker('audit-budget-worker', { agentType: 'BiMax', prompt: 'x', cwd: dir, parentMode: 'interactive' }));
    inRunBudget(buffer, () => expect(() => reserveRun(41, 0)).toThrow(/token ceiling/));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


it('nonstreaming completions reserve input/output before the wire and settle actual cached usage once', async () => {
  const { adapter, create } = fixture();
  create.mockImplementation(async () => ({ choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 500 } },
  } as any));
  const budget = { checkVeto: jest.fn(), recordSpend: jest.fn(), releaseReservation: jest.fn() };
  adapter.setBudgetVeto(budget);
  const small = createRunBudget({ BIMAX_RUN_MAX_TOKENS: '100', BIMAX_RUN_MAX_USD: '5' });
  await expect(inRunBudget(small, () => adapter.chatCompletion([{ role: 'user', content: 'x'.repeat(1000) }])))
    .rejects.toThrow(/token ceiling/);
  expect(create).not.toHaveBeenCalled();
  const buffer = createRunBudget({ BIMAX_RUN_MAX_TOKENS: '10000', BIMAX_RUN_MAX_USD: '5' });
  expect(await inRunBudget(buffer, () => adapter.chatCompletion([{ role: 'user', content: 'hello' }]))).toBe('ok');
  expect(new BigInt64Array(buffer)[0]).toBe(1200n);
  expect(budget.recordSpend).toHaveBeenCalledTimes(1);
  expect(budget.recordSpend.mock.calls[0][0]).toBeCloseTo(0.000393, 9);
  expect(budget.releaseReservation).not.toHaveBeenCalled();
});


it('the run-budget generator preserves injected-error cleanup and propagation', async () => {
  const { AgentLoop } = require('../core/agent.loop');
  const { ToolRegistry } = require('../tools/tool.registry');
  const llm = { async *chat() { yield { type: 'token', text: 'a complete sentence with enough text to stream immediately.' }; } };
  const loop = new AgentLoop(llm as any, new ToolRegistry());
  const iterator = loop.execute([{ role: 'user', content: 'reply' }], 'sys');
  await iterator.next();
  const stopped = new Error('audit injected stop');
  await expect(iterator.throw(stopped)).rejects.toBe(stopped);
  expect((await iterator.next()).done).toBe(true);
});
