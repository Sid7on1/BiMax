import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VectorStore } from '../memory/vector.store';
import { BoundedTopK } from '../utils/bounded.top.k';
import * as embeddingOps from '../memory/embeddings';

const backend = { id: 'resource-fixture', dimensions: 2, embed: async (texts: string[]) => texts.map(() => [1, 0]) };
let dir: string, serial = 0;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-rag-resources-')); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => jest.restoreAllMocks());
async function store(docs: any[]) {
  const storePath = path.join(dir, `${serial++}.json`);
  fs.writeFileSync(storePath, JSON.stringify(docs));
  const result = new VectorStore(backend, null, { storePath, maxVectors: 10000, dedup: false });
  await result.semanticSearch('initializationnomatch', 1, 0, { mode: 'lexical' });
  return result;
}
function doc(id: string, chunks: Array<{ id: string; text: string; embedding: number[] }>) {
  return { id, metadata: { content: chunks.map(chunk => chunk.text).join('\n'), tags: [] as string[] },
    chunks: chunks.map(chunk => ({ ...chunk, space: backend.id })) };
}

test('ordinary dense search uses only the original chunk heap', async () => {
  const s = await store(Array.from({ length: 50 }, (_, i) => {
    const id = `d${String(i).padStart(3, '0')}`;
    return doc(id, [{ id: `${id}#0`, text: 'quartz source', embedding: [1, 0] }]);
  }));
  const add = jest.spyOn(BoundedTopK.prototype, 'add');
  const result = await s.semanticSearch('quartz', 3, 0, { mode: 'dense' });
  const additions = add.mock.calls.length; add.mockRestore();
  expect(result.map(doc => doc.id)).toEqual(['d000', 'd001', 'd002']);
  expect(additions).toBe(50);
});

test('crowding backfill reuses the strongest long-document score', async () => {
  const s = await store([
    doc('large', Array.from({ length: 150 }, (_, i) => ({ id: `large#${i}`, text: 'quartz source', embedding: [1, 0] }))),
    doc('checksum', [{ id: 'checksum#0', text: 'quartz checksum 42', embedding: [0.9, Math.sqrt(0.19)] }]),
    doc('approval', [{ id: 'approval#0', text: 'quartz approval 9', embedding: [0.8, 0.6] }]),
  ]);
  const dot = jest.spyOn(embeddingOps, 'dot');
  const result = await s.semanticSearch('quartz', 3, 0, { mode: 'dense' });
  const largeScorings = dot.mock.calls.filter(([, vector]) => vector[0] === 1).length; dot.mockRestore();
  expect(result.map(doc => doc.id)).toEqual(['large', 'checksum', 'approval']);
  expect(largeScorings).toBe(150);
});

test('normal chunk lookup retains primitive positions instead of per-chunk containers', async () => {
  const s = await store([doc('large', Array.from({ length: 10000 }, (_, i) => ({ id: `large#${i}`, text: `quartz ${i}`, embedding: [1, 0] })))]);
  const entries: Map<string, unknown> = (s as any).chunkOwner;
  expect(entries.size).toBe(10000);
  expect([...entries.values()].filter(value => typeof value !== 'number').length).toBe(0);
  const result = await s.semanticSearch('9999', 1, 0, { mode: 'lexical', passages: true });
  expect(result[0].matchedChunks?.[0].text).toBe('quartz 9999');
});

test('zero addresses and positions in multiple documents resolve exact source chunks', async () => {
  const s = await store(Array.from({ length: 17 }, (_, d) => doc(`d${d}`, Array.from({ length: d + 1 }, (_, c) => ({
    id: `opaque-${d}-${c}`, text: `uniquefact${d}position${c}`, embedding: [1, 0],
  })))));
  for (const [d, c] of [[0, 0], [1, 1], [7, 4], [16, 16]]) {
    const result = await s.semanticSearch(`uniquefact${d}position${c}`, 1, 0, { mode: 'lexical', passages: true });
    expect(result[0]?.id).toBe(`d${d}`);
    expect(result[0]?.matchedChunks?.[0].id).toBe(`opaque-${d}-${c}`);
  }
});

test('duplicate chunk IDs retain first-chunk last-owner behavior and exact backfill', async () => {
  const s = await store([
    doc('a', Array.from({ length: 150 }, () => ({ id: 'shared', text: 'original', embedding: [1, 0] }))),
    doc('b', [{ id: 'shared', text: 'last owner first chunk', embedding: [0.2, Math.sqrt(0.96)] },
      { id: 'shared', text: 'last owner second chunk', embedding: [0.1, Math.sqrt(0.99)] }]),
    doc('c', [{ id: 'c#0', text: 'third source', embedding: [0.9, Math.sqrt(0.19)] }]),
    doc('d', [{ id: 'd#0', text: 'fourth source', embedding: [0.8, 0.6] }]),
  ]);
  const result = await s.semanticSearch('quartz', 3, 0, { mode: 'dense', passages: true });
  expect(result.map(doc => doc.id)).toEqual(['b', 'c', 'd']);
  expect(result[0].matchedChunks?.every(chunk => chunk.text === 'last owner first chunk')).toBe(true);
});

test('document-count changes rebuild positional addresses after append and deletion', async () => {
  const s = await store([doc('first', [{ id: 'first#0', text: 'firstuniquefact', embedding: [1, 0] }])]);
  await s.storeDocument('second', 'seconduniquefact', []);
  expect((await s.semanticSearch('seconduniquefact', 1, 0, { mode: 'lexical' }))[0].id).toBe('second');
  await s.deleteWhere(doc => doc.id === 'first');
  const result = await s.semanticSearch('seconduniquefact', 1, 0, { mode: 'lexical', passages: true });
  expect(result[0].matchedChunks?.[0].text).toBe('seconduniquefact');
  expect(await s.semanticSearch('firstuniquefact', 1, 0, { mode: 'lexical' })).toEqual([]);
});

test('cached dense tie recency follows current owners and later scoped retrievals', async () => {
  const older = doc('older', [{ id: 'older#0', text: 'quartz', embedding: [1, 0] }]);
  const newer = doc('newer', [{ id: 'newer#0', text: 'quartz', embedding: [1, 0] }]);
  older.metadata.tags = ['older']; newer.metadata.tags = ['newer'];
  const s = await store([{ ...older, lastUsedAt: 1 }, { ...newer, lastUsedAt: 2 }]);
  const now = jest.spyOn(Date, 'now').mockReturnValue(100);
  expect((await s.semanticSearch('quartz', 1, 0, { mode: 'dense' })).map(doc => doc.id)).toEqual(['newer']);
  now.mockReturnValue(200);
  await s.semanticSearch('quartz', 1, 0, { mode: 'dense', tags: ['older'] });
  expect((await s.semanticSearch('quartz', 1, 0, { mode: 'dense' })).map(doc => doc.id)).toEqual(['older']);
});
