import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiKeyManager } from '../credits/api.key.manager';
import { FileKeyUsageStore, MemoryKeyUsageStore, RPM_WINDOW_MS, keyId, resolveKeyUsageStore } from '../credits/key.usage.ledger';
import { getProvider, rpmFor } from '../engine/provider';

/**
 * The key pool as the owner asked for it: several keys in one hybrid round robin that respects each
 * key's requests-per-minute limit across EVERY engine on the Mac, so a low-RPM provider is paced
 * instead of answered with 429s.
 */

function clock(start = 1_000_000_000) {
  const c = { t: start, now: () => c.t, advance: (ms: number) => { c.t += ms; } };
  return c;
}

const keys = (n: number, rpm: number) => Array.from({ length: n }, (_, i) => ({ keyStr: `key-${i + 1}-abcdefghijkl`, provider: 'nvidia', rpm }));

describe('hybrid round robin across keys', () => {
  beforeEach(() => jest.spyOn(Math, 'random').mockReturnValue(0));
  afterEach(() => jest.restoreAllMocks());

  test('spreads a burst across every key instead of draining one', async () => {
    const c = clock();
    const m = new ApiKeyManager(keys(3, 40), { store: new MemoryKeyUsageStore(), now: c.now });
    const used = [];
    for (let i = 0; i < 6; i++) { used.push((await m.getNextKey()).keyStr); c.advance(10); }
    expect(new Set(used.slice(0, 3)).size).toBe(3);
    expect(new Set(used).size).toBe(3);
  });

  test('never starts more requests on a key than its per-minute limit, then waits for the oldest to age out', async () => {
    const c = clock();
    const m = new ApiKeyManager(keys(1, 3), { store: new MemoryKeyUsageStore(), now: c.now });
    for (let i = 0; i < 3; i++) { expect((await m.getNextKey()).waitTimeSecs).toBe(0); c.advance(1_000); }
    const blocked = await m.getNextKey();
    // Starts at t=0s, 1s, 2s; now t=3s → the first slot frees at t=60s, i.e. in 57s.
    expect(blocked.waitTimeSecs).toBeCloseTo(57, 3);
    c.advance(57_000);
    expect((await m.getNextKey()).waitTimeSecs).toBe(0);
  });

  test('two engines sharing the ledger share one budget per key (the cross-process defect)', async () => {
    const c = clock();
    const store = new MemoryKeyUsageStore();
    const window = new ApiKeyManager(keys(1, 4), { store, now: c.now });
    const thread = new ApiKeyManager(keys(1, 4), { store, now: c.now });
    expect((await window.getNextKey()).waitTimeSecs).toBe(0);
    expect((await thread.getNextKey()).waitTimeSecs).toBe(0);
    expect((await window.getNextKey()).waitTimeSecs).toBe(0);
    expect((await thread.getNextKey()).waitTimeSecs).toBe(0);
    // Four starts on one key between them: the limit is spent for BOTH engines.
    expect((await window.getNextKey()).waitTimeSecs).toBeGreaterThan(0);
    expect((await thread.getNextKey()).waitTimeSecs).toBeGreaterThan(0);
  });

  test('a 429 in one engine steers the other engine off that key', async () => {
    const c = clock();
    const store = new MemoryKeyUsageStore();
    const a = new ApiKeyManager(keys(2, 0), { store, now: c.now });
    const b = new ApiKeyManager(keys(2, 0), { store, now: c.now });
    const first = await a.getNextKey();
    a.reportKeyResult(first.idx!, 429, 30);
    c.advance(2_000);
    for (let i = 0; i < 4; i++) {
      expect((await b.getNextKey()).keyStr).not.toBe(first.keyStr);
      c.advance(2_000);
    }
  });

  test('prefers the faster key, but a key that has spent most of its minute loses to a fresh one', async () => {
    const c = clock();
    const m = new ApiKeyManager(keys(2, 10), { store: new MemoryKeyUsageStore(), now: c.now });
    m.reportKeyLatency(0, 1_000); // key 1: fast
    m.reportKeyLatency(1, 1_800); // key 2: slower
    c.advance(5_000);
    const picks: number[] = [];
    for (let i = 0; i < 12; i++) { picks.push((await m.getNextKey()).idx!); c.advance(2_000); }
    // The fast key leads while it has headroom…
    expect(picks.slice(0, 7).every((idx) => idx === 0)).toBe(true);
    // …and hands over once 1000ms × (1 + load) passes 1800ms — before its limit, not at the 429.
    const firstSlow = picks.indexOf(1);
    expect(firstSlow).toBeGreaterThanOrEqual(7);
    expect(firstSlow).toBeLessThan(10);
    expect(picks.filter((idx) => idx === 0).length).toBeLessThanOrEqual(10);
  });

  test('acquire() waits for a free slot and then picks again rather than reusing the stale choice', async () => {
    const c = clock();
    const store = new MemoryKeyUsageStore();
    const m = new ApiKeyManager(keys(2, 1), { store, now: c.now });
    await m.getNextKey(); c.advance(100);
    await m.getNextKey(); c.advance(100);
    const waits: number[] = [];
    const kr = await m.acquire({
      sleep: async (ms) => { waits.push(ms); c.advance(ms); },
      onWait: () => undefined,
    });
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeCloseTo(RPM_WINDOW_MS - 200, -2);
    expect(kr.waitTimeSecs).toBe(0);
    // The slot it waited for is now TAKEN: both keys are inside their minute again, so the very next
    // request must wait. A pick that was not reserved would hand the same slot out twice.
    expect((await m.getNextKey()).waitTimeSecs).toBeGreaterThan(0);
  });

  test('acquire() re-picks after waking when another engine took the slot it waited for', async () => {
    const c = clock();
    const store = new MemoryKeyUsageStore();
    const mine = new ApiKeyManager(keys(2, 1), { store, now: c.now });
    const other = new ApiKeyManager(keys(2, 1), { store, now: c.now });
    const a = await mine.getNextKey(); c.advance(1_000);
    await mine.getNextKey(); c.advance(100); // both keys spent; key A frees first
    let wakes = 0;
    const kr = await mine.acquire({
      sleep: async (ms) => {
        c.advance(ms);
        // While this engine slept, another one grabbed key A the moment it freed.
        if (wakes++ === 0) expect((await other.getNextKey()).keyStr).toBe(a.keyStr);
      },
    });
    expect(kr.keyStr).not.toBe(a.keyStr);
    expect(wakes).toBe(2);
  });

  test('acquire() gives up waiting after its budget and lets the provider answer', async () => {
    const c = clock();
    const m = new ApiKeyManager(keys(1, 1), { store: new MemoryKeyUsageStore(), now: c.now });
    await m.getNextKey();
    let slept = 0;
    const kr = await m.acquire({ maxWaitMs: 5_000, sleep: async (ms) => { slept += ms; c.advance(ms); } });
    expect(slept).toBe(5_000);
    expect(kr.keyStr).not.toBeNull();
  });

  test('a single key with no limit behaves exactly as before: never waits', async () => {
    const c = clock();
    const m = new ApiKeyManager([{ keyStr: 'solo-key-abcdefgh' }], { store: new MemoryKeyUsageStore(), now: c.now });
    for (let i = 0; i < 100; i++) expect((await m.getNextKey()).waitTimeSecs).toBe(0);
  });
});

describe('the shared ledger file', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-keyledger-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('two stores on one file (two processes) see each other\'s requests', () => {
    const file = path.join(dir, 'key-usage.json');
    const a = new FileKeyUsageStore(file);
    const b = new FileKeyUsageStore(file);
    const id = keyId('some-real-looking-key-value');
    a.reserve([id], 1000, () => id);
    a.reserve([id], 1001, () => id);
    const seen = b.reserve([id], 1002, () => null).usage.get(id)!;
    expect(seen.recent).toBe(2);
  });

  test('stores a hash of each key, never the key', () => {
    const file = path.join(dir, 'key-usage.json');
    const secret = 'nvapi-THIS-MUST-NEVER-BE-WRITTEN-1234';
    const m = new ApiKeyManager([{ keyStr: secret, rpm: 5 }], { store: new FileKeyUsageStore(file) });
    return m.getNextKey().then(() => {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toContain(secret);
      expect(text).not.toContain('nvapi');
      expect(text).toContain(keyId(secret));
      expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    });
  });

  test('a corrupt ledger starts empty instead of stopping the turn', () => {
    const file = path.join(dir, 'key-usage.json');
    fs.writeFileSync(file, '{not json');
    const id = keyId('k');
    expect(new FileKeyUsageStore(file).reserve([id], 5, () => id).picked).toBe(id);
  });

  test('requests older than a minute stop counting', () => {
    const file = path.join(dir, 'key-usage.json');
    const s = new FileKeyUsageStore(file);
    const id = keyId('k');
    s.reserve([id], 0, () => id);
    expect(s.reserve([id], RPM_WINDOW_MS + 1, () => null).usage.get(id)!.recent).toBe(0);
  });

  test('an unusable ledger falls back to per-engine pacing, never a failed turn', async () => {
    const broken = { reserve: () => { throw new Error('disk full'); }, cooldown: () => { throw new Error('disk full'); } };
    const c = clock();
    const m = new ApiKeyManager(keys(1, 2), { store: broken, now: c.now });
    expect((await m.getNextKey()).waitTimeSecs).toBe(0);
    expect((await m.getNextKey()).waitTimeSecs).toBe(0);
    expect((await m.getNextKey()).waitTimeSecs).toBeGreaterThan(0);
  });

  test('BIMAX_KEY_LEDGER_PATH=memory keeps tests hermetic; a path selects that file', () => {
    expect(resolveKeyUsageStore({ BIMAX_KEY_LEDGER_PATH: 'memory' })).toBeInstanceOf(MemoryKeyUsageStore);
    const file = path.join(dir, 'x.json');
    expect((resolveKeyUsageStore({ BIMAX_KEY_LEDGER_PATH: file }) as FileKeyUsageStore).filePath).toBe(file);
  });
});

describe('per-provider request limits', () => {
  test('NVIDIA defaults to its documented 40 a minute; the env overrides it', () => {
    const nvidia = getProvider('nvidia')!;
    expect(rpmFor(nvidia, {})).toBe(40);
    expect(rpmFor(nvidia, { NVIDIA_API_KEY_RPM: '200' })).toBe(200);
    expect(rpmFor(nvidia, { BIMAX_KEY_RPM: '15' })).toBe(15);
    expect(rpmFor(nvidia, { NVIDIA_API_KEY_RPM: '0' })).toBe(0);
  });

  test('providers without a documented limit are not paced', () => {
    for (const name of ['openai', 'anthropic', 'openrouter', 'deepseek', 'google']) {
      expect(rpmFor(getProvider(name)!, {})).toBe(0);
    }
  });
});
