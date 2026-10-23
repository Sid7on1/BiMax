import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Bm25Index, type Bm25Document } from '../memory/bm25';
import { BoundedTopK } from '../utils/bounded.top.k';
import { CircuitBreaker, Outcome, serverConfig } from '../core/circuit-breaker';
import { FileStateCache } from '../memory/file-state-cache';

// Frozen first-party implementation from before record 88, not another implementation of the
// new data structures. Compare public results, including score bits, state and restoration rows.
function baseline<T>(relative: string): T {
  const file = path.join(__dirname, '../../docs/product-reset/evidence/2026-10-12-algorithm-upgrade/baseline', relative);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function('exports', 'require', js)(exports, require);
  return exports as T;
}

function rng(seed: number): () => number {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
}

describe('exact bounded top-k', () => {
  const compare = (a: { score: number; id: string }, b: { score: number; id: string }) =>
    b.score - a.score || a.id.localeCompare(b.id);

  test.each([0, 1, 2, 3, 64, 1000])('matches full stable sorting at capacity %i', capacity => {
    const random = rng(42);
    const values = Array.from({ length: 700 }, (_, ordinal) => ({
      score: Math.floor(random() * 15), id: `id-${Math.floor(random() * 30)}`, ordinal,
    }));
    for (const input of [values, [...values].reverse(), [...values].sort(compare)]) {
      const heap = new BoundedTopK(capacity, compare);
      for (const value of input) {
        heap.add(value);
        expect(heap.size).toBeLessThanOrEqual(capacity);
      }
      expect(heap.sorted()).toEqual([...input].sort(compare).slice(0, capacity));
    }
  });

  test('equal candidates retain input order across replacement and snapshot boundaries', () => {
    const heap = new BoundedTopK<{ score: number; ordinal: number }>(3, (a, b) => b.score - a.score);
    const values = [0, 1, 2, 3, 4].map(ordinal => ({ score: 1, ordinal }));
    values.forEach(value => heap.add(value));
    const snapshot = heap.sorted();
    expect(snapshot.map(v => v.ordinal)).toEqual([0, 1, 2]);
    snapshot.pop();
    heap.add({ score: 2, ordinal: 5 });
    expect(heap.sorted().map(v => v.ordinal)).toEqual([5, 0, 1]);
    expect(heap.sorted().map(v => v.ordinal)).toEqual([5, 0, 1]);
  });

  test('normalizes retrieval depths like slice and accepts an unbounded depth', () => {
    for (const capacity of [NaN, 0.5, 2.9, Infinity]) {
      const heap = new BoundedTopK<number>(capacity, (a, b) => b - a);
      [1, 4, 2, 3].forEach(value => heap.add(value));
      expect(heap.sorted()).toEqual([4, 3, 2, 1].slice(0, capacity));
    }
  });

  test('selection comparisons grow with k rather than a full random ranking', () => {
    const random = rng(7);
    const values = Array.from({ length: 20_000 }, () => random());
    let heapComparisons = 0;
    let sortComparisons = 0;
    const heap = new BoundedTopK<number>(64, (a, b) => { heapComparisons++; return b - a; });
    values.forEach(value => heap.add(value));
    const actual = heap.sorted();
    const expected = [...values].sort((a, b) => { sortComparisons++; return b - a; }).slice(0, 64);
    expect(actual).toEqual(expected);
    expect(heap.size).toBe(64);
    expect(heapComparisons).toBeLessThan(sortComparisons / 3);
  });
});

describe('BM25 inverted postings preserve the full-scan contract', () => {
  const OldIndex = baseline<{ Bm25Index: typeof Bm25Index }>('src/memory/bm25.ts').Bm25Index;

  test('exact scores and ranking match for multilingual, numeric, repeated and absent terms', () => {
    const random = rng(19);
    const words = ['alpha', 'beta', 'gamma', 'clipPath', 'HTTPError', '25208', 'नमस्ते', '東京', 'the', '42'];
    const docs: Bm25Document[] = Array.from({ length: 350 }, (_, i) => ({
      id: `doc-${i % 17}`, // Duplicate IDs are legal; the index must keep documents distinct.
      text: Array.from({ length: Math.floor(random() * 35) }, () => words[Math.floor(random() * words.length)]).join(' '),
    }));
    const before = new OldIndex(docs);
    const after = new Bm25Index(docs);
    for (const query of ['', 'the is a', 'missing', ...words, 'clipPath beta नमस्ते', 'gamma gamma 東京', 'HTTPError 25208 42']) {
      expect(after.search(query)).toEqual(before.search(query));
    }
    for (const term of [...words, 'clippath', 'absent']) expect(after.idf(term)).toBe(before.idf(term));
    expect(after.size).toBe(docs.length);
  });

  test('rebuild removes old postings and recomputes statistics through empty corpora', () => {
    const after = new Bm25Index([{ id: 'old', text: 'alpha alpha beta' }]);
    const before = new OldIndex([{ id: 'old', text: 'alpha alpha beta' }]);
    for (const docs of [[], [{ id: 'blank', text: '' }], [{ id: 'new', text: 'gamma' }, { id: 'also', text: 'gamma alpha' }]]) {
      before.build(docs);
      after.build(docs);
      for (const query of ['alpha', 'beta', 'gamma alpha']) expect(after.search(query)).toEqual(before.search(query));
      expect(after.size).toBe(before.size);
      expect(after.idf('gamma')).toBe(before.idf('gamma'));
    }
  });

  test('sparse term returns only its actual documents in a large unrelated corpus', () => {
    const docs = Array.from({ length: 10_000 }, (_, i) => ({ id: String(i), text: i === 777 ? 'rareIdentifier 25208' : 'ordinary filler' }));
    expect(new Bm25Index(docs).search('rareIdentifier 25208')).toEqual(new OldIndex(docs).search('rareIdentifier 25208'));
    expect(new Bm25Index(docs).search('rareIdentifier').map(h => h.id)).toEqual(['777']);
  });
});

describe('circular breaker windows preserve time and capacity semantics', () => {
  const OldBreaker = baseline<{ CircuitBreaker: typeof CircuitBreaker }>('src/core/circuit-breaker.ts').CircuitBreaker;

  test('rates match a frozen reference over repeated wraps, partial expiry and complete expiry', () => {
    let now = 0;
    const config = { ...serverConfig(), minSamples: 20_000, windowDurationMs: 1000 };
    const before = new OldBreaker(config, { clock: () => now });
    const after = new CircuitBreaker(config, { clock: () => now });
    for (let i = 0; i < 45_000; i++) {
      if (i % 11_000 === 0) now += 1001;
      else if (i % 41 === 0) now++;
      const outcome = i % 7 < 3 ? Outcome.Failure : Outcome.Success;
      before.record(outcome);
      after.record(outcome);
      if (i % 101 === 0) {
        expect(after.errorRate()).toBe(before.errorRate());
        expect(after.state()).toBe(before.state());
      }
    }
    now += 1001;
    expect(after.errorRate()).toBe(0);
    after.record(Outcome.Failure);
    expect(after.errorRate()).toBe(1);
  });

  test('capacity eviction subtracts dropped failures while boundary timestamps stay live', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ ...serverConfig(), minSamples: 20_000, windowDurationMs: 10 }, { clock: () => now });
    expect(() => {
      for (let i = 0; i < 10_000; i++) breaker.record(Outcome.Failure);
      for (let i = 0; i < 10_000; i++) breaker.record(Outcome.Success);
    }).not.toThrow();
    expect(breaker.errorRate()).toBe(0);
    breaker.record(Outcome.Failure);
    expect(breaker.errorRate()).toBe(1 / 10_000);
    now = 10;
    expect(breaker.errorRate()).toBe(1 / 10_000);
    now = 11;
    expect(breaker.errorRate()).toBe(0);
  });
});

describe('access-ordered file cache preserves restoration and eviction', () => {
  const OldCache = baseline<{ FileStateCache: typeof FileStateCache }>('src/memory/file-state-cache.ts').FileStateCache;

  test('touch, overwrite and capacity eviction produce identical public reads and restoration rows', () => {
    const before = new OldCache();
    const after = new FileStateCache();
    const random = rng(9);
    for (let i = 0; i < 3000; i++) {
      const file = `/fixture/file-${Math.floor(random() * 110)}`;
      const offset = i % 3;
      const choice = Math.floor(random() * 5);
      for (const cache of [before, after]) {
        if (choice < 2) cache.set(file, i % 2, `body-${i}`, offset, 10, { stamp: `s-${i % 2}`, fileHash: 'fixture-hash' });
        else if (choice === 2) cache.invalidate(file);
        else if (choice === 3) cache.markEvicted(file);
      }
      if (choice === 4) expect(after.get(file, i % 2, offset, 10, `s-${i % 2}`)).toBe(before.get(file, i % 2, offset, 10, `s-${i % 2}`));
      if (i % 37 === 0) expect(after.getRecentReads()).toEqual(before.getRecentReads());
    }
  });

  test('touch promotes a range, protects it at capacity and never restores explicitly freed content', () => {
    const cache = new FileStateCache();
    for (let i = 0; i < 100; i++) cache.set(`/f${i}`, 1, `body-${i}`);
    expect(cache.get('/f0', 1)).toBe('body-0');
    cache.set('/overflow', 1, 'new');
    expect(cache.get('/f1', 1)).toBeNull();
    expect(cache.get('/f0', 1)).toBe('body-0');
    expect(cache.getRecentReads()[0].path).toBe('/f0');
    cache.markEvicted('/f0');
    expect(cache.getRecentReads().some(r => r.path === '/f0')).toBe(false);
    expect(cache.get('/f0', 1)).toContain('[FileStateCache]');
    cache.set('/f0', 1, 'slice', 3, 7);
    expect(cache.getRecentReads()[0]).toMatchObject({ path: '/f0', content: 'slice', offset: 3, limit: 7, complete: false });
    cache.invalidate('/f0');
    expect(cache.get('/f0', 1, 3, 7)).toBeNull();
  });
});
