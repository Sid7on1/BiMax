import { AgentLoop } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import { LLMProvider, ChatEvent, Message } from '../core/llm.provider';
import { observeToolOutcome } from '../core/tool.outcome.observers';
import { __resetFailureMemoryForTests } from '../core/failure.memory';

/**
 * Three behaviours of the agent loop that no test pinned before its 1,230-line execute() was split into phases (flaw
 * list C14): removing any of them left the whole suite green. Each is a user-visible promise.
 */

function scripted(rounds: ChatEvent[][]) {
  const requests: Message[][] = [];
  const llm = {
    userModel: 'scripted-model',
    applyConfig() {},
    async *chat(messages: Message[]): AsyncGenerator<ChatEvent> {
      requests.push(messages.map((m) => ({ ...m })));
      const round = rounds[Math.min(requests.length - 1, rounds.length - 1)];
      for (const event of round) yield event;
    },
  };
  return { llm: llm as unknown as LLMProvider, requests };
}

const lastUser = (messages: Message[]) => [...messages].reverse().find((m) => m.role === 'user')?.content;

test('a reply that is only a remark about tool usage is re-asked once, as that — not as an empty reply', async () => {
  const { llm, requests } = scripted([
    [{ type: 'token', text: 'I will now call the search tool.' }, { type: 'done' }],
    [{ type: 'token', text: 'Paris is the capital of France.' }, { type: 'done' }],
  ]);
  const loop = new AgentLoop(llm, new ToolRegistry(), null as any);
  let out = '';
  for await (const t of loop.execute([{ role: 'user', content: 'capital of France?' }], 'sys', { maxIterations: 5 })) out += t;
  expect(out).toContain('Paris is the capital of France.');
  expect(requests).toHaveLength(2);
  expect(String(lastUser(requests[1]))).toMatch(/only a remark about tool usage/);
});

test('an interrupt between tool batches still answers every call the model made, so the next request is valid', async () => {
  const stop = new AbortController();
  const registry = new ToolRegistry();
  const ran: string[] = [];
  for (const name of ['FirstTool', 'SecondTool']) {
    registry.register({
      name, description: name, schema: { type: 'object', properties: {} }, isDestructive: true, isConcurrencySafe: false,
      execute: async () => { ran.push(name); if (name === 'FirstTool') stop.abort(); return 'done'; },
    } as any);
  }
  const { llm } = scripted([[
    { type: 'tool_call', id: 'c1', name: 'FirstTool', args: '{}' },
    { type: 'tool_call', id: 'c2', name: 'SecondTool', args: '{}' },
    { type: 'done' },
  ]]);
  const loop = new AgentLoop(llm, registry, null as any);
  for await (const _ of loop.execute([{ role: 'user', content: 'do both' }], 'sys', { maxIterations: 5, signal: stop.signal })) { /* drain */ }
  expect(ran).toEqual(['FirstTool']);
  const results = loop.messages.filter((m) => m.role === 'tool');
  expect(results.map((m) => m.tool_call_id)).toEqual(['c1', 'c2']);
  expect(results[1].content).toBe('Tool call interrupted before it ran.');
});

test('the same failing action, repeated, is answered with a note to change strategy once its budget is spent', () => {
  __resetFailureMemoryForTests();
  const failing = {
    call: { id: 'x', name: 'ReadFileTool', args: '{"path":"missing.txt"}' },
    result: 'ENOENT: no such file or directory', isError: true, durationMs: 1,
    span: { setAttribute() {}, addEvent() {}, context: {} } as any, cwd: process.cwd(), background: false,
  };
  const seen = [observeToolOutcome(failing), observeToolOutcome(failing), observeToolOutcome(failing)];
  expect(seen[0]).toBe(failing.result);
  expect(seen.some((r) => r.includes('⟳'))).toBe(true);
  expect(seen.filter((r) => r.includes('⟳')).every((r) => r.startsWith(failing.result))).toBe(true);
});
