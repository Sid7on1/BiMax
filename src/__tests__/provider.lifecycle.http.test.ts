import * as http from 'node:http';
import OpenAI from 'openai';
import { LlmAdapter } from '../core/llm.adapter';
import { ApiKeyManager } from '../credits/api.key.manager';
import { MemoryKeyUsageStore } from '../credits/key.usage.ledger';
import { hedgedRequest } from '../core/hedged.request';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function endpoint(mode: 'headers' | 'stream' | 'success' | 'hedge') {
  const started = deferred<void>();
  const closed = deferred<void>();
  const requests: string[] = [];
  let closedCount = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push(req.url!);
      res.on('close', () => { closedCount += 1; if (closedCount === (mode === 'hedge' ? 2 : 1)) closed.resolve(); });
      started.resolve();
      if (mode === 'headers' || (mode === 'hedge' && req.url!.startsWith('/slow/'))) return;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'fixture reply' }, finish_reason: null }] }) + '\n\n');
      if (mode === 'stream') return;
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const manager = new ApiKeyManager([{ keyStr: 'local-fixture-key', provider: 'nvidia', baseURL: `${base}/v1`, model: 'meta/llama-3.3-70b-instruct' }], { store: new MemoryKeyUsageStore() });
  const adapter = new LlmAdapter(manager);
  adapter.applyConfig({ model: 'meta/llama-3.3-70b-instruct' });
  (adapter as any).implicitThink = false;
  return { base, adapter, manager, started, closed, requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('real SDK header Stop reaches the local server and preserves key health and configuration', async () => {
  const f = await endpoint('headers');
  const stop = new AbortController();
  const before = f.adapter.readEffective();
  const events: any[] = [];
  const report = jest.spyOn(f.manager, 'reportKeyResult');
  try {
    const run = (async () => { for await (const event of f.adapter.chat([{ role: 'user', content: 'hello' }], { signal: stop.signal })) events.push(event); })();
    await f.started.promise;
    stop.abort(new Error('local fixture Stop'));
    await run;
    await f.closed.promise;
    expect(events).toEqual([{ type: 'error', message: 'Request cancelled.', recoverable: false }]);
    expect(f.requests).toEqual(['/v1/chat/completions']);
    expect(report).not.toHaveBeenCalled();
    expect(f.adapter.readEffective()).toEqual(before);
  } finally { jest.restoreAllMocks(); await f.close(); }
});

test('real SDK mid-stream Stop closes the response without emitting done or retrying', async () => {
  const f = await endpoint('stream');
  const stop = new AbortController();
  const chat = f.adapter.chat([], { signal: stop.signal });
  try {
    expect((await chat.next()).value).toEqual({ type: 'token', text: 'fixture reply' });
    const pending = chat.next();
    stop.abort(new Error('Stop during response'));
    expect((await pending).value).toMatchObject({ type: 'error', recoverable: false });
    expect((await chat.next()).done).toBe(true);
    await f.closed.promise;
    expect(f.requests).toHaveLength(1);
    expect(f.manager.getStates()[0].fail).toBe(0);
  } finally { await chat.return(undefined); await f.close(); }
});

test('a real successful SSE response still emits exact text and one done', async () => {
  const f = await endpoint('success');
  try {
    const events = [];
    for await (const event of f.adapter.chat([], {})) events.push(event);
    await f.closed.promise;
    expect(events).toEqual([{ type: 'token', text: 'fixture reply' }, { type: 'done' }]);
    expect(f.requests).toHaveLength(1);
    expect(f.manager.getStates()[0].ok).toBe(1);
  } finally { await f.close(); }
});

test('real SDK hedge uses exactly two HTTP requests and closes its held loser', async () => {
  const f = await endpoint('hedge');
  try {
    const result = await hedgedRequest({ first: 'slow', budgetMs: 1500, hedgeAfterMs: 30, nextKey: async () => 'fast',
      start: (key, timeout) => {
        const controller = new AbortController();
        const client = new OpenAI({ apiKey: 'local-fixture-key', baseURL: `${f.base}/${key}/v1`, maxRetries: 0 });
        return { promise: client.chat.completions.create({ model: 'fixture', messages: [], stream: true }, { signal: controller.signal, timeout }), abort: () => controller.abort() };
      },
    });
    let text = '';
    for await (const chunk of result.value) text += chunk.choices[0]?.delta?.content ?? '';
    await f.closed.promise;
    expect(result.key).toBe('fast');
    expect(text).toBe('fixture reply');
    expect(f.requests).toEqual(['/slow/v1/chat/completions', '/fast/v1/chat/completions']);
  } finally { await f.close(); }
});

test('real SDK header deadline closes the held request and reports a stall instead of done', async () => {
  const f = await endpoint('headers');
  f.adapter.firstChunkTimeoutMs = 80;
  try {
    const events = [];
    for await (const event of f.adapter.chat([], {})) events.push(event);
    await f.closed.promise;
    expect(f.requests).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', recoverable: true, message: expect.stringContaining('no response headers') }));
    expect(events.some(event => event.type === 'done')).toBe(false);
    expect(f.manager.getStates()[0].hangs).toBe(1);
  } finally { await f.close(); }
});
