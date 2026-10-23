import { hedgedRequest, HedgeLeg } from '../core/hedged.request';
import { LlmAdapter } from '../core/llm.adapter';
import { ApiKeyManager } from '../credits/api.key.manager';
import { MemoryKeyUsageStore } from '../credits/key.usage.ledger';
import { getEventListeners } from 'node:events';
import { nextChunkWithin } from '../core/chat.stream.reader';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function observed<T>(promise: Promise<T>) {
  const result: { value?: T; error?: unknown; settled: boolean } = { settled: false };
  promise.then(value => { result.value = value; result.settled = true; }, error => { result.error = error; result.settled = true; });
  return result;
}

function raceFixture(signal?: AbortSignal, budgetMs = 100) {
  const primary = deferred<string>();
  const backup = deferred<string>();
  const key = deferred<string | null>();
  const abortA = jest.fn();
  const abortB = jest.fn();
  const start = jest.fn((name: string): HedgeLeg<string> => ({ promise: name === 'A' ? primary.promise : backup.promise, abort: name === 'A' ? abortA : abortB }));
  const run = hedgedRequest({ first: 'A', start, nextKey: () => key.promise, budgetMs, hedgeAfterMs: 10, signal } as Parameters<typeof hedgedRequest<string, string>>[0]);
  const result = observed(run);
  return { primary, backup, key, abortA, abortB, start, run, result };
}

function adapterFixture(rpm = 0) {
  const manager = new ApiKeyManager([{ keyStr: 'fixture-key-abcdefghijkl', provider: 'nvidia', rpm }], { store: new MemoryKeyUsageStore() });
  const adapter = new LlmAdapter(manager);
  adapter.applyConfig({ model: 'meta/llama-3.3-70b-instruct' });
  (adapter as any).implicitThink = false;
  return { manager, adapter };
}

describe('provider lifetime under delayed or uncooperative work', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

  test('primary headers return while backup key selection is still pending, without a late backup', async () => {
    const h = raceFixture();
    try {
      await jest.advanceTimersByTimeAsync(10);
      h.primary.resolve('primary response');
      await jest.advanceTimersByTimeAsync(0);
      expect(h.result.value).toMatchObject({ key: 'A', value: 'primary response' });
      h.key.resolve('B');
      await jest.advanceTimersByTimeAsync(0);
      expect(h.start).toHaveBeenCalledTimes(1);
    } finally { h.key.resolve(null); h.primary.resolve('cleanup'); h.backup.resolve('cleanup'); await h.run.catch(() => undefined); }
  });

  test('header deadline bounds delayed key lookup and refuses a backup after expiry', async () => {
    const h = raceFixture(undefined, 50);
    try {
      await jest.advanceTimersByTimeAsync(60);
      expect(h.result.error).toMatchObject({ name: 'APIConnectionTimeoutError' });
      expect(h.abortA).toHaveBeenCalledTimes(1);
      h.key.resolve('B');
      await jest.advanceTimersByTimeAsync(0);
      expect(h.start).toHaveBeenCalledTimes(1);
    } finally { h.key.resolve(null); h.primary.resolve('cleanup'); h.backup.resolve('cleanup'); await h.run.catch(() => undefined); }
  });

  test('Stop bounds uncooperative header promises and cancels every launched request', async () => {
    const stop = new AbortController();
    const h = raceFixture(stop.signal);
    const reason = new Error('fixture Stop');
    try {
      h.key.resolve('B');
      await jest.advanceTimersByTimeAsync(10);
      stop.abort(reason);
      await jest.advanceTimersByTimeAsync(0);
      expect(h.result.error).toBe(reason);
      expect(h.abortA).toHaveBeenCalledTimes(1);
      expect(h.abortB).toHaveBeenCalledTimes(1);
    } finally { h.primary.resolve('cleanup'); h.backup.resolve('cleanup'); await h.run.catch(() => undefined); }
  });

  test('an already stopped header request never dispatches', async () => {
    const stop = new AbortController();
    stop.abort(new Error('already stopped'));
    const h = raceFixture(stop.signal);
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(h.start).not.toHaveBeenCalled();
      expect(h.result.error).toBe(stop.signal.reason);
    } finally { h.primary.resolve('cleanup'); h.key.resolve(null); await h.run.catch(() => undefined); }
  });

  test('a synchronous backup launch failure leaves the primary eligible to win', async () => {
    const primary = deferred<string>();
    const failure = new Error('backup setup failed');
    const loser = jest.fn();
    const run = hedgedRequest({ first: 'A', budgetMs: 100, hedgeAfterMs: 10, nextKey: async () => 'B', onLoser: loser,
      start: name => { if (name === 'B') throw failure; return { promise: primary.promise, abort: jest.fn() }; } });
    const result = observed(run);
    await jest.advanceTimersByTimeAsync(10);
    primary.resolve('primary response');
    await jest.advanceTimersByTimeAsync(0);
    expect(result.value).toMatchObject({ key: 'A', value: 'primary response' });
    expect(loser).toHaveBeenCalledWith('B', expect.any(Number), failure);
  });

  test('Stop interrupts rate-limit waiting without acquiring another slot or sending HTTP', async () => {
    const { manager, adapter } = adapterFixture(1);
    await manager.getNextKey();
    const pick = jest.spyOn(manager, 'getNextKey');
    const create = jest.fn();
    (adapter as any).createClient = () => ({ chat: { completions: { create } } });
    const stop = new AbortController();
    const chat = adapter.chat([{ role: 'user', content: 'hello' }], { signal: stop.signal });
    const next = chat.next();
    const result = observed(next);
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(pick).toHaveBeenCalledTimes(1);
      stop.abort(new Error('stop during cooldown'));
      await jest.advanceTimersByTimeAsync(0);
      expect(result.settled).toBe(true);
      expect(create).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(120_000);
      expect(pick).toHaveBeenCalledTimes(1);
    } finally { await jest.advanceTimersByTimeAsync(120_000); await next.catch(() => undefined); await chat.return(undefined); }
  });

  test('an already stopped chat does not reserve an API slot', async () => {
    const { manager, adapter } = adapterFixture();
    const pick = jest.spyOn(manager, 'getNextKey');
    const stop = new AbortController();
    stop.abort(new Error('already stopped'));
    const create = jest.fn(async () => ({ [Symbol.asyncIterator]: async function* () {} }));
    (adapter as any).createClient = () => ({ chat: { completions: { create } } });
    const chat = adapter.chat([], { signal: stop.signal });
    await chat.next().catch(() => undefined);
    await chat.return(undefined);
    expect(pick).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  test('Stop interrupts an uncooperative chunk read and disposes the stream', async () => {
    const { adapter } = adapterFixture();
    const pending = deferred<IteratorResult<any>>();
    const abort = jest.fn();
    const close = jest.fn(async () => ({ done: true as const, value: undefined }));
    (adapter as any).createClient = () => ({ chat: { completions: { create: async () => ({ controller: { abort },
      [Symbol.asyncIterator]: () => ({ next: () => pending.promise, return: close }),
    }) } } });
    const stop = new AbortController();
    const chat = adapter.chat([], { signal: stop.signal });
    const next = chat.next();
    const result = observed(next);
    try {
      await jest.advanceTimersByTimeAsync(0);
      stop.abort(new Error('Stop at chunk read'));
      await jest.advanceTimersByTimeAsync(0);
      expect(result.value).toMatchObject({ value: { type: 'error', recoverable: false } });
    } finally { pending.resolve({ done: true, value: undefined }); await next; await chat.return(undefined); }
    expect(abort).toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('Stop before buffered tool finalization emits neither an executable call nor done', async () => {
    const { adapter } = adapterFixture();
    (adapter as any).createClient = () => ({ chat: { completions: { create: async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'visible reply', tool_calls: [{ index: 0, id: 'call-1', function: { name: 'write_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
      },
    }) } } });
    const stop = new AbortController();
    const chat = adapter.chat([], { signal: stop.signal });
    expect((await chat.next()).value).toMatchObject({ type: 'token' });
    stop.abort(new Error('Stop before call'));
    const rest = [];
    for await (const event of chat) rest.push(event);
    expect(rest.some(event => event.type === 'tool_call' || event.type === 'done')).toBe(false);
    expect(rest).toContainEqual(expect.objectContaining({ type: 'error', recoverable: false }));
  });

  test('cancelled streaming is neutral for API key health and never requests a retry', async () => {
    const { manager, adapter } = adapterFixture();
    const report = jest.spyOn(manager, 'reportKeyResult');
    const breaker = jest.spyOn((adapter as any).providerBreaker, 'record');
    const stop = new AbortController();
    (adapter as any).createClient = () => ({ chat: { completions: { create: async () => ({
      [Symbol.asyncIterator]: async function* () { yield { choices: [{ delta: { content: 'before Stop' } }] }; stop.abort(new Error('person stopped')); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
    }) } } });
    const events = [];
    for await (const event of adapter.chat([], { signal: stop.signal })) events.push(event);
    expect(report).not.toHaveBeenCalled();
    expect(breaker).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', recoverable: false }));
    expect(events.some(event => event.type === 'done')).toBe(false);
  });

  test('hedging disabled still bounds an uncooperative header request', async () => {
    const pending = deferred<string>();
    const abort = jest.fn();
    const run = hedgedRequest({ first: 'A', budgetMs: 30, hedgeAfterMs: 0, nextKey: async () => null,
      start: () => ({ promise: pending.promise, abort }) });
    const result = observed(run);
    await jest.advanceTimersByTimeAsync(31);
    expect(result.error).toMatchObject({ name: 'APIConnectionTimeoutError' });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    pending.resolve('late answer');
    await jest.advanceTimersByTimeAsync(0);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  test('loser abort and telemetry exceptions cannot strand the winner', async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const run = hedgedRequest({ first: 'A', budgetMs: 100, hedgeAfterMs: 10, nextKey: async () => 'B',
      onLoser: () => { throw new Error('telemetry failed'); },
      start: name => ({ promise: name === 'A' ? a.promise : b.promise, abort: () => { throw new Error('abort failed'); } }) });
    await jest.advanceTimersByTimeAsync(10);
    b.resolve('winner');
    await expect(run).resolves.toMatchObject({ key: 'B', value: 'winner' });
    a.reject(new Error('late loser failure'));
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('Stop during synchronous request setup still closes the returned leg', async () => {
    const stop = new AbortController();
    const abort = jest.fn();
    const pending = deferred<string>();
    const run = hedgedRequest({ first: 'A', budgetMs: 100, hedgeAfterMs: 0, signal: stop.signal, nextKey: async () => null,
      start: () => { stop.abort(new Error('synchronous Stop')); return { promise: pending.promise, abort }; } });
    await expect(run).rejects.toBe(stop.signal.reason);
    expect(abort).toHaveBeenCalledTimes(1);
    pending.reject(new Error('late rejection'));
    await jest.advanceTimersByTimeAsync(0);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });

  test('successful headers release their deadline, hedge timer and Stop listener', async () => {
    const stop = new AbortController();
    const h = raceFixture(stop.signal);
    h.primary.resolve('success');
    await h.run;
    expect(jest.getTimerCount()).toBe(0);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
    stop.abort();
    expect(h.abortA).not.toHaveBeenCalled();
  });

  test('chunk reads release Stop listeners and timers on both success and cancellation', async () => {
    const stop = new AbortController();
    for (let i = 0; i < 20; i++) {
      await expect(nextChunkWithin({ next: async () => ({ value: i, done: false }) }, 100, () => new Error('timeout'), jest.fn(), stop.signal))
        .resolves.toEqual({ value: i, done: false });
      expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    }
    const pending = deferred<IteratorResult<number>>();
    const abort = jest.fn();
    const run = nextChunkWithin({ next: () => pending.promise }, 100, () => new Error('timeout'), abort, stop.signal);
    const result = observed(run);
    stop.abort(new Error('Stop pending read'));
    await jest.advanceTimersByTimeAsync(0);
    expect(result.error).toBe(stop.signal.reason);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
    pending.reject(new Error('late chunk failure'));
  });

  test('Stop between finalized tool calls suppresses every remaining executable call', async () => {
    const { adapter } = adapterFixture();
    (adapter as any).createClient = () => ({ chat: { completions: { create: async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { tool_calls: [0, 1].map(index => ({ index, id: `call-${index}`, function: { name: `tool_${index}`, arguments: '{}' } })) }, finish_reason: 'tool_calls' }] };
      },
    }) } } });
    const stop = new AbortController();
    const chat = adapter.chat([], { signal: stop.signal });
    let first: any;
    do { first = (await chat.next()).value; } while (first.type !== 'tool_call');
    expect(first.id).toBe('call-0');
    stop.abort(new Error('Stop between calls'));
    const rest = [];
    for await (const event of chat) rest.push(event);
    expect(rest.some(event => event.type === 'tool_call' || event.type === 'done')).toBe(false);
    expect(rest).toContainEqual(expect.objectContaining({ type: 'error', recoverable: false }));
  });

  test('a connection error arriving at the absolute deadline remains a header timeout', async () => {
    let now = 0;
    const pending = deferred<string>();
    const run = hedgedRequest({ first: 'A', budgetMs: 100, hedgeAfterMs: 0, now: () => now, nextKey: async () => null,
      start: () => ({ promise: pending.promise, abort: jest.fn() }) });
    now = 100;
    pending.reject(new Error('Connection error.'));
    await expect(run).rejects.toMatchObject({ name: 'APIConnectionTimeoutError' });
    expect(jest.getTimerCount()).toBe(0);
  });
});
