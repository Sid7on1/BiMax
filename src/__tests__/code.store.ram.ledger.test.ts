import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VectorStore } from '../memory/vector.store';
import { SqliteCodeVectorStore } from '../memory/sqlite.code.store';
import { RemoteEmbeddingBackend, type EmbeddingTransport } from '../memory/embeddings';

/**
 * The RAM ledger — the number the SQLite store exists to move.
 *
 * The JSON VectorStore keeps every document text and every float vector resident: correct at 500
 * memories, catastrophic for a code index (6 KB of boxed floats per chunk). The SQLite store
 * keeps only a tag map (~100 bytes/doc) and streams everything else from disk. This test
 * measures both stores over the SAME synthetic corpus and asserts the gap, plus the structural
 * invariant (zero chunk text/vector resident) that holds even where a noisy heap delta might not.
 */

const credentials = async () => ({ apiKey: 'k', baseURL: 'https://example.invalid/v1' });

/** Deterministic 768-dim-ish vectors: text hash seeds a few nonzero dims — ranking is irrelevant here. */
const transport: EmbeddingTransport = async (_url, init) => {
  const body = JSON.parse(init.body);
  const vec = (text: string): number[] => {
    const v = new Array(64).fill(0);
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    for (let i = 0; i < 8; i++) v[Math.abs(h + i * 7) % 64] = 1 / 8;
    return v;
  };
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: body.input.map((t: string, i: number) => ({ embedding: vec(t), index: i })) }),
  };
};

const backend = () => new RemoteEmbeddingBackend({ resolve: credentials, transport });

function corpus(n: number): { id: string; text: string; tags: string[] }[] {
  const out: { id: string; text: string; tags: string[] }[] = [];
  for (let i = 0; i < n; i++) {
    const filler = Array.from({ length: 40 }, (_, j) => `token${i}_${j} line of source`).join('\n');
    out.push({ id: `code:src/f${i}.ts:L1`, text: `src/f${i}.ts :: fn${i} (lines 1-40)\n${filler}`, tags: ['code', `file:src/f${i}.ts`] });
  }
  return out;
}

function heapUsed(): number {
  global.gc?.();
  return process.memoryUsage().heapUsed;
}

let tmp: string;
let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-ramledger-'));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('RAM ledger: JSON vs SQLite code store', () => {
  jest.setTimeout(120_000);
  const N = 4_000; // ~4k chunks: today's real scale, already past where JSON wants to live

  test('SQLite holds a fraction of the heap, and no chunk text or vector is resident', async () => {
    const docs = corpus(N);

    const before = heapUsed();
    const jsonStore = new VectorStore(backend(), null, {
      storePath: path.join(tmp, 'json-store.json'),
      dedup: false,
      chunker: (id, text) => [{ id, text }],
      maxVectors: 100_000,
    });
    await jsonStore.storeDocuments(docs);
    const jsonDelta = heapUsed() - before;

    const beforeSql = heapUsed();
    const sqliteStore = new SqliteCodeVectorStore(backend(), null, {
      storePath: path.join(tmp, 'sqlite-store.db'),
      maxVectors: 100_000,
    });
    await sqliteStore.storeDocuments(docs);
    const sqliteDelta = heapUsed() - beforeSql;

    // eslint-disable-next-line no-console
    console.log(
      `\n  RAM ledger over ${N} chunks (heap-used deltas):` +
      `\n    JSON store      ${(jsonDelta / 1e6).toFixed(1)} MB resident` +
      `\n    SQLite store    ${(sqliteDelta / 1e6).toFixed(1)} MB resident` +
      `\n    SQLite tag map  ${(sqliteStore.residentBytes() / 1e6).toFixed(2)} MB (the only per-doc state)` +
      `\n    index on disk   ${(sqliteStore.stats().indexBytes / 1e6).toFixed(1)} MB\n`,
    );

    // The structural invariant: per-document resident state is the tag map — no texts, no
    // vectors. N docs × ~1.6 KB of text alone would exceed this bound, never mind the vectors.
    expect(sqliteStore.residentBytes()).toBeLessThan(N * 200);

    // And the measured gap: SQLite must hold clearly less heap than JSON over the same corpus.
    //
    // `jsonDelta * 0.75` IS a ratio, despite the comment this replaces claiming otherwise, and it
    // inverts when the baseline is negative. A negative jsonDelta means GC ran between the two
    // `heapUsed()` reads, so the JSON store's cost was never measured — the heap simply ended lower
    // than it started. Comparing against it then demands `sqliteDelta < -34 MB`, which nothing can
    // satisfy. Measured on an 8 GB box under memory pressure: the run reported jsonDelta ≈ -34 MB
    // and failed, while the structural invariant above (the real claim) passed untouched.
    //
    // An unusable measurement is not evidence of a regression, so it must not be reported as one.
    // The invariant that does not depend on GC timing is asserted unconditionally above.
    if (jsonDelta > 0) {
      expect(sqliteDelta).toBeLessThan(jsonDelta * 0.75);
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `  [ram-ledger] skipping the comparative bound: GC ran during the JSON baseline ` +
        `(jsonDelta ${(jsonDelta / 1e6).toFixed(1)} MB). The structural invariant still ran.`,
      );
    }

    // Same pipeline, same answers: both stores return the same top hit for a lexical query.
    const jsonHits = await jsonStore.semanticSearch('fn377', 1, 0, { tags: ['code'] });
    const sqliteHits = await sqliteStore.semanticSearch('fn377', 1, 0, { tags: ['code'] });
    expect(sqliteHits[0]?.id).toBe(jsonHits[0]?.id);
    expect(sqliteHits[0]?.id).toBe('code:src/f377.ts:L1');
  });

  test('quantized vectors keep ranking order (int8 is ranking-safe)', async () => {
    // SIGNED values, on purpose: quantization is q = v/scale + 127 — a decode that drops the
    // −127 offset turns negatives positive and reranks everything confidently. The first version
    // of this test used all-positive vectors and passed while the decode was wrong.
    const near = 'alpha shared topic words appear here';
    const far = 'zzzz unrelated material nothing alike';
    const signedTransport: EmbeddingTransport = async (_u, init) => {
      const body = JSON.parse(init.body);
      const vec = (text: string): number[] => {
        const v = new Array(64).fill(0);
        let h = 0;
        for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
        for (let i = 0; i < 10; i++) v[Math.abs(h + i * 7) % 64] = (i % 2 ? -1 : 1) / 10;
        return v;
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: body.input.map((t: string, i: number) => ({ embedding: vec(t), index: i })) }),
      };
    };
    const signedBackend = new RemoteEmbeddingBackend({ resolve: credentials, transport: signedTransport });
    const store = new SqliteCodeVectorStore(signedBackend, null, { storePath: path.join(tmp, 'q.db') });
    await store.storeDocuments([
      { id: 'code:a.ts:L1', text: near, tags: ['code'] },
      { id: 'code:b.ts:L1', text: far, tags: ['code'] },
    ]);
    const hits = await store.semanticSearch('alpha shared topic', 2, 0);
    expect(hits[0]?.id).toBe('code:a.ts:L1');
    expect(store.stats().embedded).toBe(2);
  });
});
