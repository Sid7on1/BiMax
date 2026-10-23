import { AgentLoop } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import { buildTool } from '../tools/tool.factory';
import { outcomeError } from '../tools/outcome';
import { engineEvents } from '../engine/events';
import { capabilitySnapshot, resetCapabilityStatus } from '../core/capability.status';
import type { LLMProvider } from '../core/llm.provider';

beforeEach(() => resetCapabilityStatus());
afterEach(() => resetCapabilityStatus());

test('model ignoring explicit Word delivery cannot end with a silent successful answer', async () => {
  const registry = new ToolRegistry();
  registry.register(buildTool({ name: 'DocumentTool', description: 'export', schema: {}, execute: async () => 'unexpected' }, { approveTaskExecution: async () => {} }));
  let rounds = 0;
  const llm = { async *chat() { rounds++; yield { type: 'token', text: 'Done, your document is ready.' }; yield { type: 'done' }; } } as LLMProvider;
  const loop = new AgentLoop(llm, registry);
  let visible = '';
  for await (const text of loop.execute([{ role: 'user', content: 'Produce a Word document summarising our findings.' }], '', { maxIterations: 5 })) visible += text;
  expect(rounds).toBe(3);
  expect(visible).not.toContain('your document is ready');
  expect(visible).toContain('operation was not performed');
  expect(capabilitySnapshot().find(s => s.id === 'tool-activation')?.state).toBe('unavailable');
});

test('typed tool error is painted as error, not a successful tool call', async () => {
  const registry = new ToolRegistry();
  registry.register(buildTool({ name: 'FixtureTool', description: '', schema: { type: 'object', properties: {} },
    execute: async () => outcomeError('io', 'Failed to write fixture') }, { approveTaskExecution: async () => {} }));
  let round = 0;
  const llm = { async *chat() {
    if (!round++) yield { type: 'tool_call', id: 'failed-call', name: 'FixtureTool', args: '{}' };
    else yield { type: 'token', text: 'The operation failed.' };
    yield { type: 'done' };
  } } as LLMProvider;
  const calls: any[] = []; const capture = (call: any) => calls.push(call);
  engineEvents.on('tool_call_result', capture);
  try {
    for await (const _ of new AgentLoop(llm, registry).execute([{ role: 'user', content: 'Run the fixture.' }], '', { maxIterations: 3 })) { /* drain */ }
    expect(calls.find(call => call.id === 'failed-call')).toMatchObject({ status: 'error', outcome: 'error', errorClass: 'io' });
  } finally { engineEvents.off('tool_call_result', capture); }
});
