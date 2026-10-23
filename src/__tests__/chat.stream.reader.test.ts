import { ChatStreamReader, nextChunkWithin } from '../core/chat.stream.reader';
import { capabilitiesFor } from '../core/capabilities';
import { ToolNameMap, buildWireTools, schemaFlavorFor } from '../core/tool.wire';
import { ProviderStallError, errorStatus, isRequestTimeout, isUserAbort } from '../core/llm.errors';
import { classifyStreamError } from '../core/llm.stream';
import { ApiKeyManager } from '../credits/api.key.manager';
import { MemoryKeyUsageStore } from '../credits/key.usage.ledger';

/**
 * The stream reader and the typed provider errors, split out of LlmAdapter.chat() (flaw list C15, E41). Driven with
 * chunks shaped like the OpenAI streaming contract; the last test goes through the real adapter.
 */

const plain = capabilitiesFor('nvidia', 'meta/llama-3.3-70b-instruct');
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ delta, finish_reason: finish }] });

function reader(overrides: Partial<ConstructorParameters<typeof ChatStreamReader>[0]> = {}) {
  return new ChatStreamReader({
    model: 'meta/llama-3.3-70b-instruct', caps: plain, reasoners: new Set(), implicitThink: false,
    wireNames: new ToolNameMap([]), ...overrides,
  });
}
const all = (r: ChatStreamReader, chunks: unknown[]) => [...chunks.flatMap((c) => [...r.read(c)]), ...r.finish()];

test('content streams as tokens, and <thinking> is treated as <think>', () => {
  const events = all(reader(), [chunk({ content: 'Hello ' }), chunk({ content: '<thinking>plan</thinking>world' }, 'stop')]);
  expect(events.filter((e) => e.type === 'token').map((e: any) => e.text).join('')).toBe('Hello world');
  expect(events.filter((e) => e.type === 'thinking').map((e: any) => e.text).join('')).toBe('plan');
  expect(events.some((e) => e.type === 'truncated')).toBe(false);
});

test('a reasoning channel is never the reply, and it teaches the shared reasoner set', () => {
  const reasoners = new Set<string>();
  const r = reader({ reasoners });
  const events = all(r, [chunk({ reasoning_content: 'let me think' }), chunk({ content: 'Answer.' }, 'stop')]);
  expect(events).toContainEqual({ type: 'thinking', text: 'let me think' });
  expect(events.filter((e) => e.type === 'token').map((e: any) => e.text).join('')).toBe('Answer.');
  expect(reasoners.has('meta/llama-3.3-70b-instruct')).toBe(true);
});

test('tool-call fragments become one call per index, under the model-facing name, only when the stream ends', () => {
  const wire = buildWireTools([{ name: 'mcp:files/read', description: '', parameters: {} }], schemaFlavorFor('nvidia', 'meta/llama-3.3-70b-instruct'));
  const wireName = wire.defs[0].function.name;
  const r = reader({ wireNames: wire.names });
  const mid = [
    ...r.read(chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: wireName, arguments: '{"pa' } }] })),
    // minimax/NIM repeat the id on every fragment; that must not start a new call.
    ...r.read(chunk({ tool_calls: [{ index: 0, id: 'c1', function: { arguments: 'th":"a.ts"}' } }] }, 'tool_calls')),
  ];
  expect(mid.filter((e) => e.type === 'tool_call')).toEqual([]);
  const calls = [...r.finish()].filter((e) => e.type === 'tool_call');
  expect(calls).toEqual([{ type: 'tool_call', id: 'c1', name: 'mcp:files/read', args: '{"path":"a.ts"}' }]);
});

test('cut off at the token ceiling: the answer is marked truncated, or else the last tool call is', () => {
  expect(all(reader(), [chunk({ content: 'half an ans' }, 'length')]).some((e) => e.type === 'truncated')).toBe(true);
  const withCall = all(reader(), [chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'Read', arguments: '{"pa' } }] }, 'length')]);
  expect(withCall.some((e) => e.type === 'truncated')).toBe(false);
  expect(withCall.find((e) => e.type === 'tool_call')).toEqual(expect.objectContaining({ truncated: true }));
});

test('live tool-arg partials are throttled to one per 80 ms', () => {
  let now = 1_000;
  const caps = { ...plain, partialJsonTools: true };
  const r = reader({ caps, now: () => now });
  const partials = (args: string) => [...r.read(chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'Write', arguments: args } }] }))]
    .filter((e) => e.type === 'tool_call_partial');
  expect(partials('{"a"')).toHaveLength(1);
  now += 10;
  expect(partials(':1')).toHaveLength(0);
  now += ChatStreamReader.PARTIAL_EMIT_MS;
  expect(partials('}')).toEqual([{ type: 'tool_call_partial', id: 'c', name: 'Write', args: '{"a":1}' }]);
});

test('a stalled stream: the watchdog error wins, the stream is aborted, and the orphaned read cannot crash the process', async () => {
  let rejectLater!: (e: Error) => void;
  const iterator = { next: () => new Promise<IteratorResult<unknown>>((_, reject) => { rejectLater = reject; }) };
  let aborted = false;
  const stall = new ProviderStallError('m', 'first token', 20);
  await expect(nextChunkWithin(iterator as AsyncIterator<unknown>, 20, () => stall, () => { aborted = true; })).rejects.toBe(stall);
  expect(aborted).toBe(true);
  const unhandled = jest.fn();
  process.on('unhandledRejection', unhandled);
  rejectLater(new Error('socket reset after the timeout'));
  await new Promise((r) => setTimeout(r, 20));
  process.off('unhandledRejection', unhandled);
  expect(unhandled).not.toHaveBeenCalled();
});

describe('typed provider errors (E41)', () => {
  test('a stall keeps the exact wording people and logs read, and says whether the key is held', () => {
    const headers = new ProviderStallError('kimi', 'response headers', 60_000);
    expect(headers.message).toBe("LLM stream timeout: model 'kimi' sent no response headers for 60s — benching this key and rotating (run /perf for network-path evidence)");
    expect(new ProviderStallError('kimi', 'first token', 180_000).message).toBe("LLM stream timeout: model 'kimi' sent no first token for 180s — not a tool error (run /perf for network-path evidence)");
    expect([headers.keyIsHeld, new ProviderStallError('k', 'first token', 1).keyIsHeld, new ProviderStallError('k', 'mid-stream', 1).keyIsHeld])
      .toEqual([true, true, false]);
    expect(classifyStreamError(headers)).toEqual({ status: 408, recoverable: true, kind: 'transient' });
    expect(errorStatus(headers)).toBe(408);
  });

  test('timeouts and aborts are recognised by type, not by wording', () => {
    expect(isRequestTimeout(Object.assign(new Error('anything'), { name: 'APIConnectionTimeoutError' }))).toBe(true);
    expect(isRequestTimeout(new Error('the answer mentions a timed out build'))).toBe(false);
    expect(isUserAbort(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isUserAbort(new Error('abort mission'), { aborted: false })).toBe(false);
    expect(isUserAbort(new Error('x'), { aborted: true })).toBe(true);
    expect(errorStatus(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(0);
    expect(errorStatus(Object.assign(new Error('x'), { status: 429 }))).toBe(429);
  });
});

describe('through the real adapter', () => {
  const { LlmAdapter } = require('../core/llm.adapter');
  const hungStream = () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => { /* never */ }) }) });

  async function run(firstChunks: unknown[]) {
    const manager = new ApiKeyManager([{ keyStr: 'only-key-abcdefghijklm', provider: 'nvidia' }], { store: new MemoryKeyUsageStore() });
    const hangs: number[] = [];
    const reportKeyHang = manager.reportKeyHang.bind(manager);
    manager.reportKeyHang = (idx: number) => { hangs.push(idx); reportKeyHang(idx); };
    const adapter = new LlmAdapter(manager);
    adapter.applyConfig({ model: 'meta/llama-3.3-70b-instruct' });
    adapter.firstChunkTimeoutMs = 60;
    adapter.streamReadTimeoutMs = 60;
    (adapter as any).createClient = () => ({ chat: { completions: { create: async () => {
      let i = 0;
      return { [Symbol.asyncIterator]: () => ({ next: () => (i < firstChunks.length
        ? Promise.resolve({ done: false, value: firstChunks[i++] })
        : hungStream()[Symbol.asyncIterator]().next()) }) };
    } } } });
    const events: any[] = [];
    for await (const e of adapter.chat([{ role: 'user', content: 'hi' }], {})) events.push(e);
    return { events, hangs };
  }

  test('no first token: the key is benched as held; a gap after the answer began does not bench it', async () => {
    const silent = await run([]);
    expect(silent.events.at(-1)).toEqual(expect.objectContaining({ type: 'error', recoverable: true }));
    expect(silent.events.at(-1).message).toMatch(/sent no first token/);
    expect(silent.hangs).toEqual([0]);

    const midway = await run([chunk({ content: 'Hel' })]);
    expect(midway.events.at(-1).message).toMatch(/sent no mid-stream/);
    expect(midway.hangs).toEqual([]);
  });
});
