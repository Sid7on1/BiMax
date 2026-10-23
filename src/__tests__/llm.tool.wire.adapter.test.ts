import { LlmAdapter } from '../core/llm.adapter';
import { ApiKeyManager } from '../credits/api.key.manager';
import { MemoryKeyUsageStore } from '../credits/key.usage.ledger';
import type { ChatEvent } from '../core/llm.provider';

/**
 * What the adapter actually PUTS ON THE WIRE and reads back, driven through `chat()` with a fake
 * provider. Unit tests of tool.wire.ts prove the mapping; these prove the adapter uses it.
 */

function streamOf(chunks: any[]) {
  return { [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } };
}

function adapterFor(provider: string, model: string, respond: (req: any) => any[] | Error) {
  const manager = new ApiKeyManager([{ keyStr: 'test-key-abcdefghijk', provider, model }], { store: new MemoryKeyUsageStore() });
  const adapter = new LlmAdapter(manager);
  adapter.applyConfig({ model });
  const requests: any[] = [];
  (adapter as any).createClient = () => ({
    chat: {
      completions: {
        create: async (req: any) => {
          requests.push(JSON.parse(JSON.stringify(req)));
          const out = respond(req);
          if (out instanceof Error) throw out;
          return streamOf(out);
        },
      },
    },
  });
  return { adapter, requests };
}

async function collect(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const toolCallChunk = (name: string, args: string, extra?: unknown) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: args }, ...(extra ? { extra_content: extra } : {}) }] }, finish_reason: null }],
});
const stop = { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };

describe('the adapter sends provider-safe tools and reads the calls back', () => {
  test('an MCP tool with a dotted name is sent valid and the call comes back under its real name', async () => {
    const { adapter, requests } = adapterFor('openai', 'gpt-4.1', (req) => {
      const wire = req.tools[0].function.name;
      return [toolCallChunk(wire, '{"q":"x"}'), stop];
    });
    const events = await collect(adapter.chat(
      [{ role: 'user', content: 'search' },
        { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'mcp__docs.site__search', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'old', content: 'r' }],
      { tools: [{ name: 'mcp__docs.site__search', description: 'search', input_schema: { $schema: 'x', type: 'object', properties: { q: { type: 'string' } } } }] },
    ));
    const sent = requests[0];
    expect(sent.tools[0].function.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(sent.tools[0].function.parameters.$schema).toBeUndefined();
    // The earlier call in the history went out under the same valid spelling.
    const past = sent.messages.find((m: any) => m.role === 'assistant');
    expect(past.tool_calls[0].function.name).toBe(sent.tools[0].function.name);
    const call = events.find((e) => e.type === 'tool_call') as any;
    expect(call.name).toBe('mcp__docs.site__search');
  });

  test('GPT-6 tool requests are sent with reasoning off; tool-free requests are not', async () => {
    const { adapter, requests } = adapterFor('openai', 'gpt-6-sol', () => [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
    await collect(adapter.chat([{ role: 'user', content: 'hi' }], { tools: [{ name: 'ReadFileTool', input_schema: { type: 'object', properties: {} } }] }));
    await collect(adapter.chat([{ role: 'user', content: 'hi' }], {}));
    expect(requests[0].reasoning_effort).toBe('none');
    expect(requests[1].reasoning_effort).not.toBe('none');
    expect(requests[0].temperature).toBeUndefined();
  });

  test('provider data on a tool call (Gemini thought signature) comes back on the event', async () => {
    const sig = { google: { thought_signature: 'abc123' } };
    const { adapter } = adapterFor('google', 'gemini-3.8-flash', () => [toolCallChunk('ReadFileTool', '{}', sig), stop]);
    const events = await collect(adapter.chat([{ role: 'user', content: 'read' }], { tools: [{ name: 'ReadFileTool', input_schema: { type: 'object', properties: {} } }] }));
    expect((events.find((e) => e.type === 'tool_call') as any).extra).toEqual(sig);
  });

  test('a refused Quick model is retried at once instead of failing the turn', async () => {
    const { adapter, requests } = adapterFor('nvidia', 'moonshotai/kimi-k3', (req) => {
      if (req.model === 'mistralai/mistral-7b-instruct-v0.3') {
        const e: any = new Error("404 Function 'x': Not found for account 'y'. model not found");
        e.status = 404;
        return e;
      }
      return [{ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }];
    });
    adapter.applyConfig({ liteModel: 'mistralai/mistral-7b-instruct-v0.3' });
    const first = await collect(adapter.chat([{ role: 'user', content: 'hi' }], { lite: true }));
    const err = first.find((e) => e.type === 'error') as any;
    expect(err).toMatchObject({ recoverable: true, kind: 'transient', retryAfterSecs: 0 });
    // The loop's re-ask lands on the work model.
    const second = await collect(adapter.chat([{ role: 'user', content: 'hi' }], { lite: true }));
    expect(requests[requests.length - 1].model).toBe('moonshotai/kimi-k3');
    expect(second.some((e) => e.type === 'token')).toBe(true);
  });

  test('a refused WORK model is still a real error (nothing to fall back to here)', async () => {
    const { adapter } = adapterFor('nvidia', 'dead/model', () => {
      const e: any = new Error('model not found');
      e.status = 404;
      return e;
    });
    const events = await collect(adapter.chat([{ role: 'user', content: 'hi' }], {}));
    expect((events.find((e) => e.type === 'error') as any).recoverable).toBe(false);
  });
});
