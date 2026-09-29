import { hedgedRequest, isLoopbackEndpoint, HedgeLeg } from '../core/hedged.request';
import { ApiKeyManager } from '../credits/api.key.manager';
import { MemoryKeyUsageStore } from '../credits/key.usage.ledger';

/**
 * "hi" took 46 s in the installed app: NVIDIA held the request's response headers and the app waited out
 * its 45 s budget before retrying. Measured the same night: four of five keys held past 60 s while one
 * answered at 14.7 s, and minutes later all five answered in 0.4 s — the stall is per request. A held
 * request now gets one backup on another key and the first answer wins; the first request is never
 * abandoned, because heavy models legitimately queue for minutes.
 */

/** A leg the test resolves or rejects by hand, recording whether it was aborted. */
function manualLeg() {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  const state = { aborted: false, budgetMs: 0 };
  const leg: HedgeLeg<string> = { promise, abort: () => { state.aborted = true; } };
  return { leg, resolve, reject, state };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness(opts: { hedgeAfterMs?: number; backup?: string | null } = {}) {
  const legs = new Map<string, ReturnType<typeof manualLeg>>();
  const losers: { key: string; error?: unknown }[] = [];
  const hedged: string[] = [];
  let nextKeyCalls = 0;
  const run = hedgedRequest<string, string>({
    first: 'A',
    budgetMs: 10_000,
    hedgeAfterMs: opts.hedgeAfterMs ?? 20,
    start: (key, budgetMs) => { const l = manualLeg(); l.state.budgetMs = budgetMs; legs.set(key, l); return l.leg; },
    nextKey: async () => { nextKeyCalls += 1; return opts.backup === undefined ? 'B' : opts.backup; },
    onHedge: (key) => hedged.push(key),
    onLoser: (key, _waited, error) => losers.push({ key, error }),
  });
  run.catch(() => undefined);
  return { run, legs, losers, hedged, nextKeyCalls: () => nextKeyCalls };
}

test('an answer before the hedge delay sends no backup', async () => {
  const h = harness();
  h.legs.get('A')!.resolve('from A');
  await expect(h.run).resolves.toMatchObject({ key: 'A', value: 'from A' });
  await tick(40);
  expect(h.nextKeyCalls()).toBe(0);
  expect(h.legs.has('B')).toBe(false);
  expect(h.losers).toEqual([]);
});

test('a held request gets a backup on another key, and the backup\'s answer wins', async () => {
  const h = harness();
  await tick(40);
  expect(h.hedged).toEqual(['B']);
  // The backup gets what is left of the overall header budget, not a fresh one.
  expect(h.legs.get('B')!.state.budgetMs).toBeLessThanOrEqual(10_000 - 20);
  h.legs.get('B')!.resolve('from B');
  await expect(h.run).resolves.toMatchObject({ key: 'B', value: 'from B' });
  // The held first request is cancelled and reported as slow, not failed.
  expect(h.legs.get('A')!.state.aborted).toBe(true);
  expect(h.losers).toEqual([{ key: 'A', error: undefined }]);
});

test('the first request answering after the backup was sent still wins, and the backup is cancelled', async () => {
  const h = harness();
  await tick(40);
  h.legs.get('A')!.resolve('from A');
  await expect(h.run).resolves.toMatchObject({ key: 'A', value: 'from A' });
  expect(h.legs.get('B')!.state.aborted).toBe(true);
  expect(h.losers).toEqual([{ key: 'B', error: undefined }]);
});

test('with no other key free, the first request is simply awaited', async () => {
  const h = harness({ backup: null });
  await tick(40);
  expect(h.nextKeyCalls()).toBe(1);
  expect(h.hedged).toEqual([]);
  h.legs.get('A')!.resolve('from A');
  await expect(h.run).resolves.toMatchObject({ key: 'A' });
});

test('a fast failure is not hedged: it goes straight to the caller\'s retry path', async () => {
  const h = harness();
  const refused = Object.assign(new Error('404 Not found for account'), { status: 404 });
  h.legs.get('A')!.reject(refused);
  await expect(h.run).rejects.toBe(refused);
  await tick(40);
  expect(h.nextKeyCalls()).toBe(0);
});

test('a backup that fails does not end the race while the first can still answer', async () => {
  const h = harness();
  await tick(40);
  const backupError = new Error('503');
  h.legs.get('B')!.reject(backupError);
  await tick(5);
  h.legs.get('A')!.resolve('from A');
  await expect(h.run).resolves.toMatchObject({ key: 'A' });
  expect(h.losers).toEqual([{ key: 'B', error: backupError }]);
});

test('when both fail, the first request\'s error is thrown and each leg is accounted once', async () => {
  const h = harness();
  await tick(40);
  const first = new Error('Request timed out.');
  const second = new Error('Request timed out (backup).');
  h.legs.get('A')!.reject(first);
  await tick(5);
  h.legs.get('B')!.reject(second);
  await expect(h.run).rejects.toBe(first);
  // The caller benches A from the thrown error; only B is reported here.
  expect(h.losers).toEqual([{ key: 'B', error: second }]);
});

test('hedging off (0) never asks for a second key', async () => {
  const h = harness({ hedgeAfterMs: 0 });
  await tick(40);
  expect(h.nextKeyCalls()).toBe(0);
  h.legs.get('A')!.resolve('from A');
  await expect(h.run).resolves.toMatchObject({ key: 'A' });
});

test('a server on this Mac is loopback; hosted providers are not', () => {
  expect(isLoopbackEndpoint('http://localhost:11434/v1')).toBe(true);
  expect(isLoopbackEndpoint('http://127.0.0.1:1234/v1')).toBe(true);
  expect(isLoopbackEndpoint('http://[::1]:8080/v1')).toBe(true);
  expect(isLoopbackEndpoint('https://integrate.api.nvidia.com/v1')).toBe(false);
  expect(isLoopbackEndpoint('https://localhost.example.com/v1')).toBe(false);
  expect(isLoopbackEndpoint(null)).toBe(false);
  expect(isLoopbackEndpoint('not a url')).toBe(false);
});

test('the key picker never offers the key a hedge is already waiting on', async () => {
  const keys = Array.from({ length: 2 }, (_, i) => ({ keyStr: `key-${i + 1}-abcdefghijkl`, provider: 'nvidia', rpm: 40 }));
  let t = 1_000_000_000;
  const m = new ApiKeyManager(keys, { store: new MemoryKeyUsageStore(), now: () => t });
  for (let i = 0; i < 6; i++) {
    t += 5_000;
    const picked = await m.getNextKey({ exclude: 0 });
    expect(picked.idx).toBe(1);
  }
  // A one-key pool has no second key: the picker can only name the excluded key again, which the
  // adapter's backup check refuses (same index), so a solo pool never hedges onto its own queue.
  const solo = new ApiKeyManager(keys.slice(0, 1), { store: new MemoryKeyUsageStore(), now: () => t });
  expect((await solo.getNextKey({ exclude: 0 })).idx).toBe(0);
});

describe('through the real adapter', () => {
  // Imported here so the unit tests above stay independent of the adapter's module graph.
  const { LlmAdapter } = require('../core/llm.adapter');

  function streamOf(chunks: any[]) {
    return { [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } };
  }

  test('a key NVIDIA holds is raced by a second key, and the reply arrives from the second', async () => {
    const manager = new ApiKeyManager(
      [{ keyStr: 'held-key-abcdefghijk', provider: 'nvidia' }, { keyStr: 'fast-key-abcdefghijk', provider: 'nvidia' }],
      { store: new MemoryKeyUsageStore() },
    );
    const adapter = new LlmAdapter(manager);
    adapter.applyConfig({ model: 'openai/gpt-oss-20b' });
    adapter.hedgeAfterMs = 30;
    let heldAborted = false;
    // Whichever key is asked FIRST is the one NVIDIA holds. The pool starts its rotation at a random key on purpose
    // (parallel sub-agents must not all pile onto key #1), so this test must not assume which key that is: it used to
    // hold key #1 only, and failed whenever the random start picked key #2 first — there was then nothing to race.
    let heldKey: string | null = null;
    (adapter as any).createClient = (kr: any) => ({
      chat: { completions: { create: (_req: any, init: any) => new Promise((resolve, reject) => {
        heldKey ??= kr.keyStr;
        if (kr.keyStr !== heldKey) {
          resolve(streamOf([{ choices: [{ delta: { content: 'Hello from the fast key' }, finish_reason: 'stop' }] }]));
          return;
        }
        // Holds its headers until cancelled, like the measured stall.
        init.signal.addEventListener('abort', () => { heldAborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      }) } },
    });
    const started = Date.now();
    const events: any[] = [];
    for await (const e of adapter.chat([{ role: 'user', content: 'hi' }], {})) events.push(e);
    const text = events.filter((e) => e.type === 'token').map((e) => e.text).join('');
    // The reply came back well inside the 45 s the app used to wait.
    expect(text).toContain('Hello from the fast key');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    // The held request was cancelled once the fast key answered, not left open.
    expect(heldAborted).toBe(true);
  });
});
