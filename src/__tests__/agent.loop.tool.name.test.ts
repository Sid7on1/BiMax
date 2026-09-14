import { AgentLoop } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import { buildTool } from '../tools/tool.factory';

/**
 * Backlog Q1: gpt-oss can glue harmony tokens to a tool name (`EchoTool<|channel|>commentary`). The call runs under the
 * tool's real name, and the name that goes back into the model's own history is the clean one.
 */

const governor = { approveTaskExecution: async () => {} } as any;

test('a streamed tool call whose name carries a harmony token runs, and history keeps the clean name', async () => {
  const ran: unknown[] = [];
  const tools = new ToolRegistry();
  tools.register(buildTool({
    name: 'EchoTool', description: 'Echo the text back.', isDestructive: false,
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (args: { text: string }) => { ran.push(args); return `echo: ${args.text}`; },
  }, governor));

  let round = 0;
  const llm = {
    async *chat(_messages: unknown[], options: { system?: string } = {}) {
      if (options.system === undefined) { yield { type: 'token', text: '## Goal\nContinue.' }; return; }
      round++;
      if (round === 1) yield { type: 'tool_call', id: 'call-1', name: 'EchoTool<|channel|>commentary', args: '{"text":"hi"}' };
      else yield { type: 'token', text: 'Done: the tool echoed hi.' };
    },
  } as any;

  const loop = new AgentLoop(llm, tools, undefined, 128000);
  for await (const _ of loop.execute([{ role: 'user', content: 'Echo hi, please.' }], 'You are a test assistant.', { maxIterations: 3 })) { /* drain */ }

  expect(ran).toEqual([{ text: 'hi' }]);
  const calls = (loop as any).messages.flatMap((m: any) => m.tool_calls ?? []);
  expect(calls.map((call: any) => call.function.name)).toEqual(['EchoTool']);
});
