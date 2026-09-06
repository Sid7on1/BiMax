import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeIndex, chunkSource } from '../memory/code.index';
import { SqliteCodeVectorStore } from '../memory/sqlite.code.store';
import { RemoteEmbeddingBackend, type EmbeddingTransport } from '../memory/embeddings';
import { RemoteReranker, type RerankTransport, type RerankCandidate } from '../memory/rerank';

/**
 * The code index, graded on the properties that make it an index rather than a file dump:
 * symbol-shaped chunks with honest headers, incremental sync that neither misses changes nor
 * re-embeds the world, deletion that leaves no orphans, and search that scopes by subtree.
 */

const credentials = async () => ({ apiKey: 'k', baseURL: 'https://example.invalid/v1' });

/** Keyword-axis stand-in: text about keys → [1,0], text about rendering → [0,1]. */
const axisTransport: EmbeddingTransport = async (_url, init) => {
  const body = JSON.parse(init.body);
  const vec = (text: string): number[] => {
    const keys = /key|rotate|rotation|credential|pool|token/i.test(text) ? 1 : 0;
    const render = /render|paint|frame|animat|pixel|canvas/i.test(text) ? 1 : 0;
    return keys && !render ? [1, 0] : render && !keys ? [0, 1] : [keys, render];
  };
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: body.input.map((t: string, i: number) => ({ embedding: vec(t), index: i })) }),
  };
};

const backend = (model = 'fixture/a') => new RemoteEmbeddingBackend({ resolve: credentials, transport: axisTransport, model, dimensions: 2 });

function reranker(): RemoteReranker {
  // Pass-through order (identity): the rerank STAGE is graded by the memory eval; here it only
  // needs to not corrupt the pipeline when present.
  const transport: RerankTransport = async (_u, init) => {
    const body = JSON.parse(init.body) as { passages: RerankCandidate[] };
    return { ok: true, status: 200, json: async () => ({ rankings: body.passages.map((p, i) => ({ index: i, logit: 1 })) }) };
  };
  return new RemoteReranker({ resolve: credentials, transport });
}

let tmp: string;
let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-codeidx-'));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SAMPLE_TS = `import { Logger } from '../utils';

const DEFAULT_MODEL = 'x';

export function rotateKey(pool: string[]): string {
  return pool[0];
}

export class KeyManager {
  private keys: string[] = [];
  pick(): string { return rotateKey(this.keys); }
}

const longTail = 1;
`;

describe('chunkSource', () => {
  test('chunks begin at declarations and carry the contextual header', () => {
    const chunks = chunkSource('src/credits/keys.ts', SAMPLE_TS, true);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // The header rides into BOTH retrievers — that is the technique under test.
    expect(chunks[0].text.startsWith('src/credits/keys.ts :: ')).toBe(true);
    const fn = chunks.find((c) => c.symbol === 'rotateKey');
    expect(fn).toBeTruthy();
    expect(fn!.text).toContain('export function rotateKey');
    // Line tags are honest: the chunk's id line matches its declared start.
    expect(fn!.id).toBe(`code:src/credits/keys.ts:L${fn!.startLine}`);
  });

  test('headers can be switched off (the A/B position)', () => {
    const chunks = chunkSource('a.ts', 'function foo() {}\n', false);
    expect(chunks[0].text).not.toContain(' :: ');
  });

  test('consecutive chunks overlap so a seam never eats a declaration', () => {
    const lines = Array.from({ length: 300 }, (_, i) => (i % 40 === 0 ? `function f${i}() {` : `  // line ${i}`)).join('\n');
    const chunks = chunkSource('big.ts', lines, true);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine + 1);
    }
  });
});

describe('CodeIndex sync', () => {
  test('a fresh nested store path indexes on first launch and survives restart', async () => {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'fresh.ts'), 'export const FIRST_LAUNCH_SENTINEL = true;\n');
    const storePath = path.join(tmp, '.breakglass', 'memory', 'code-index.db');

    const firstIndex = new CodeIndex(null, null, { root: tmp, storePath });
    expect(await firstIndex.sync(100)).toMatchObject({ indexed: 1, pending: 0 });
    expect(firstIndex.stats().documents).toBeGreaterThan(0);
    expect((await firstIndex.search('FIRST_LAUNCH_SENTINEL', 3, undefined, 'lexical'))[0]?.path).toBe('src/fresh.ts');

    const restarted = new CodeIndex(null, null, { root: tmp, storePath });
    expect(await restarted.sync(100)).toMatchObject({ indexed: 0, pending: 0 });
    expect(restarted.stats().documents).toBe(firstIndex.stats().documents);
    expect((await restarted.search('FIRST_LAUNCH_SENTINEL', 3, undefined, 'lexical'))[0]?.path).toBe('src/fresh.ts');
  });

  test('a refused capacity write remains pending instead of poisoning the manifest', async () => {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export const one = 1;\n');
    fs.writeFileSync(path.join(tmp, 'src', 'b.ts'), 'export const two = 2;\n');
    const storePath = path.join(tmp, 'limited.db');
    const limited = new CodeIndex(null, null, { root: tmp, storePath, maxVectors: 1 });
    const refused = await limited.sync(100);
    expect(refused.indexed).toBe(0);
    expect(refused.pending).toBe(2);

    const roomier = new CodeIndex(null, null, { root: tmp, storePath, maxVectors: 10 });
    const retried = await roomier.sync(100);
    expect(retried.indexed).toBe(2);
    expect(retried.pending).toBe(0);
  });

  test('commits in slices and yields, so timer-driven liveness survives a big batch', async () => {
    // A bounded batch is not a non-blocking one. Committing the whole budget in a single pass held
    // the event loop for ~15s on a 200-file batch, which stops every timer in the process — and
    // the engine's protocol heartbeat IS a timer, so the desktop supervisor killed the engine as
    // "unresponsive" mid-boot and then did it again on every restart. Two properties, together:
    // rows land WHILE the sync is still running, and a timer gets to run while it does.
    fs.mkdirSync(path.join(tmp, 'src'));
    for (let i = 0; i < 6; i += 1) {
      fs.writeFileSync(path.join(tmp, 'src', `f${i}.ts`), `export const value${i} = ${i};\n`);
    }
    const index = new CodeIndex(null, null, {
      root: tmp,
      storePath: path.join(tmp, 'sliced.db'),
      sliceBudgetMs: 0, // yield after every file — the boundary under test, not the 250ms default
    });

    const midFlight: number[] = [];
    const ticker = setInterval(() => midFlight.push(index.stats().documents), 1);
    let result: Awaited<ReturnType<typeof index.sync>>;
    try {
      result = await index.sync(100);
    } finally {
      clearInterval(ticker);
    }

    // The timer ran at all (the loop was never held for the whole sync) AND saw a partial index
    // (the commit is incremental, not one write at the end).
    expect(midFlight.length).toBeGreaterThan(0);
    expect(midFlight.some((n) => n > 0 && n < index.stats().documents)).toBe(true);

    // Slicing must not cost correctness: every file lands, and a re-sync is still a no-op.
    expect(result).toMatchObject({ indexed: 6, pending: 0 });
    expect((await index.search('value4', 3, undefined, 'lexical'))[0]?.path).toBe('src/f4.ts');
    expect(await index.sync(100)).toMatchObject({ indexed: 0, pending: 0 });
  });

  test('a slice that fails to store leaves its files pending and keeps the old rows', async () => {
    // Per-slice all-or-nothing. `rescanned` drives the stale-row sweep, so a file whose
    // replacement never committed must not contribute its tag — otherwise the sweep deletes the
    // rows the failed write was supposed to replace and the file is left indexed by nothing.
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export const alpha = 1;\n');
    const storePath = path.join(tmp, 'partial.db');

    const seeded = new CodeIndex(null, null, { root: tmp, storePath, sliceBudgetMs: 0 });
    expect(await seeded.sync(100)).toMatchObject({ indexed: 1 });
    const before = seeded.stats().documents;
    expect(before).toBeGreaterThan(0);

    // Re-open at a capacity that refuses every write, and change the file so it is a candidate.
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export const alpha = 2;\nexport const beta = 3;\n');
    const refusing = new CodeIndex(null, null, { root: tmp, storePath, maxVectors: 1, sliceBudgetMs: 0 });
    const refused = await refusing.sync(100);
    expect(refused.indexed).toBe(0);
    expect(refused.pending).toBe(1);
    expect(refusing.stats().documents).toBe(before); // old rows intact, nothing swept
  });

  test('indexes, then re-indexes only what changed, then forgets deletions', async () => {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export const keyPool = rotate(creds);\n');
    fs.writeFileSync(path.join(tmp, 'src', 'b.ts'), 'export function paint(frame: number): void {}\n');

    const index = new CodeIndex(backend(), null, { storePath: path.join(tmp, 'idx.json') });
    const first = await index.sync(100);
    expect(first.indexed).toBe(2);
    expect(first.pending).toBe(0);
    expect(index.stats().documents).toBeGreaterThanOrEqual(2);

    // Unchanged tree → nothing to do.
    const second = await index.sync(100);
    expect(second.indexed).toBe(0);

    // A touch re-indexes exactly that file, not its neighbour.
    const later = Date.now() / 1000 + 5;
    fs.utimesSync(path.join(tmp, 'src', 'a.ts'), later, later);
    const third = await index.sync(100);
    expect(third.indexed).toBe(1);

    // Deleting the file removes its chunks — orphaned code outranks real code in every search.
    fs.rmSync(path.join(tmp, 'src', 'b.ts'));
    const fourth = await index.sync(100);
    expect(fourth.removed).toBeGreaterThanOrEqual(1);
    const hits = await index.search('paint frame', 10);
    expect(hits.every((h) => h.path !== 'src/b.ts')).toBe(true);
  });

  test('one embedding batch for a whole sync (not one HTTP call per file)', async () => {
    fs.mkdirSync(path.join(tmp, 'src'));
    let calls = 0;
    const countingBackend = new RemoteEmbeddingBackend({
      resolve: credentials,
      transport: async (u, init) => {
        calls++;
        return axisTransport(u, init);
      },
    });
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmp, 'src', `f${i}.ts`), `export function rotate${i}(keys: string[]) { return keys; }\n`);
    }
    const index = new CodeIndex(countingBackend, null, { storePath: path.join(tmp, 'idx.json') });
    await index.sync(100);
    expect(calls).toBe(1); // 5 files, 5 chunks, one batch
  });

  test('similar files are NOT merged (dedup is off for code)', async () => {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'one.ts'), 'export function rotateKey(pool: string[]) { return pool[0]; }\n');
    fs.writeFileSync(path.join(tmp, 'src', 'two.ts'), 'export function rotateKey(pool: string[]) { return pool[0]; }\n');
    const index = new CodeIndex(backend(), null, { storePath: path.join(tmp, 'idx.json') });
    await index.sync(100);
    const both = await index.search('rotate key pool', 10);
    const paths = new Set(both.map((h) => h.path));
    expect(paths.has('src/one.ts')).toBe(true);
    expect(paths.has('src/two.ts')).toBe(true);
  });

  test('semantic search finds intent phrasings with no shared token, pathPrefix scopes', async () => {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.mkdirSync(path.join(tmp, 'app'));
    fs.writeFileSync(path.join(tmp, 'src', 'creds.ts'), 'export function pickFromPool(): string { /* credential rotation */ return ""; }\n');
    fs.writeFileSync(path.join(tmp, 'app', 'ui.ts'), 'export function repaint(): void { /* render frame */ }\n');

    const index = new CodeIndex(backend(), reranker(), { storePath: path.join(tmp, 'idx.json') });
    await index.sync(100);

    // "swap the token" shares no token with the file (which says credential/pool/rotate) — the
    // dense stage must carry it. 'token' lights the credentials axis of the fixture space only.
    const hits = await index.search('where do we swap the token before each request', 3);
    expect(hits[0]?.path).toBe('src/creds.ts');
    expect(index.stats().lastMode.dense).toBe(true);

    // Scoped search cannot leak outside its subtree.
    const scoped = await index.search('secret swap', 5, 'app');
    expect(scoped.every((h) => h.path.startsWith('app'))).toBe(true);
  });

  test('keyless lexical search returns an exact identifier inside a long chunk', async () => {
    fs.mkdirSync(path.join(tmp, 'src'));
    const filler = Array.from({ length: 65 }, (_, i) => `const filler${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(tmp, 'src', 'long.ts'), `${filler}\nexport const UNIQUE_SENTINEL_XYZ = true;\n`);
    const index = new CodeIndex(null, null, { root: tmp, storePath: path.join(tmp, 'lexical.db') });
    await index.sync(100);
    const hits = await index.search('UNIQUE_SENTINEL_XYZ', 3, undefined, 'lexical');
    expect(hits[0]?.path).toBe('src/long.ts');
  });
});

describe('SQLite embedding-space integrity', () => {
  test('changing the embedding model backfills every chunk into the active space', async () => {
    const storePath = path.join(tmp, 'space.db');
    const oldStore = new SqliteCodeVectorStore(backend('fixture/old'), null, { storePath });
    expect(await oldStore.storeDocuments([
      { id: 'code:src/a.ts:L1', text: 'rotate credential pool', tags: ['code'] },
    ])).toBe(true);
    expect(oldStore.stats()).toMatchObject({ embedded: 1, pending: 0 });

    const migrated = new SqliteCodeVectorStore(backend('fixture/new'), null, { storePath });
    expect(migrated.stats()).toMatchObject({ embedded: 0, pending: 1 });
    expect(await migrated.backfillPending(10)).toEqual({ embedded: 1, pending: 0 });
    expect(migrated.stats()).toMatchObject({ embedded: 1, pending: 0 });
  });

  test('dense-only search abstains when every cosine is below the configured floor', async () => {
    const store = new SqliteCodeVectorStore(backend(), null, {
      storePath: path.join(tmp, 'abstain.db'),
      minDenseScore: 0.2,
    });
    await store.storeDocuments([
      { id: 'code:src/a.ts:L1', text: 'rotate credential pool', tags: ['code'] },
    ]);
    expect(await store.semanticSearch('completely unrelated astronomy', 3, 0, { mode: 'dense' })).toEqual([]);
    expect(store.lastSearchMode().dense).toBe(false);
  });
});

describe('graph expansion and retrieval modes', () => {
  test('the HitExpander attaches structural neighbours to the top hits, and survives failure', async () => {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export function rotateToken(pool: string[]): string { return pool[0]; }\n');
    let fail = false;
    const index = new CodeIndex(backend(), null, {
      storePath: path.join(tmp, 'idx.json'),
      expandHit: async (hit) => {
        if (fail) throw new Error('graph exploded');
        return [`src/other.ts · caller (${hit.symbol})`];
      },
    });
    await index.sync(100);
    const hits = await index.search('rotate the token pool', 3);
    expect(hits[0]?.related).toEqual(['src/other.ts · caller (rotateToken)']);
    // A dead graph must cost the annotation, never the hit.
    fail = true;
    const still = await index.search('rotate the token pool', 3);
    expect(still[0]?.path).toBe('src/a.ts');
    expect(still[0]?.related).toEqual([]);
  });

  test('mode: lexical makes zero embedding calls; dense skips BM25; hybrid runs both', async () => {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export function rotateToken(pool: string[]): string { return pool[0]; }\n');
    let embedCalls = 0;
    const counting = new RemoteEmbeddingBackend({
      resolve: credentials,
      transport: async (u, init) => { embedCalls++; return axisTransport(u, init); },
    });
    const index = new CodeIndex(counting, null, { storePath: path.join(tmp, 'idx.json') });
    await index.sync(100); // the sync's own embeds
    const afterSync = embedCalls;

    await index.search('rotate the token pool', 3, undefined, 'lexical');
    expect(embedCalls).toBe(afterSync); // no query embed — the point of the mode

    await index.search('rotate the token pool', 3, undefined, 'dense');
    expect(embedCalls).toBe(afterSync + 1);

    await index.search('rotate the token pool', 3, undefined, 'hybrid');
    expect(embedCalls).toBe(afterSync + 2);
  });
});
