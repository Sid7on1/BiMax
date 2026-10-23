import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VectorStore, type VectorDocument } from '../memory/vector.store';
import { recallForTurn } from '../memory/recall';

let dir: string, serial = 0;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-rag-sprint-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
afterEach(() => jest.restoreAllMocks());
const embeddings = { id: 'fixture-space', dimensions: 2, embed: async (texts: string[], role: 'query' | 'passage') =>
  texts.map(text => role === 'query' || text.includes('report observation') ? [1, 0] : [0.8, 0.6]) };

async function corpus(dense = false) {
  const storePath = path.join(dir, `store-${serial++}.json`);
  const store = new VectorStore(dense ? embeddings : null, null, {
    storePath, maxVectors: 1000, dedup: false,
    chunker: (id, text) => text.split('\n').map((line, i) => ({ id: `${id}#${i}`, text: line })),
  });
  await store.storeDocuments([
    { id: 'long-report', text: Array.from({ length: 150 }, (_, i) => `quartz quartz quartz report observation ${i}`).join('\n'), tags: ['allowed'] },
    { id: 'checksum', text: `quartz checksum rule is CHECKSUM-SENTINEL ${'additional background '.repeat(30)}`, tags: ['allowed'] },
    { id: 'approval', text: `quartz approval rule is APPROVAL-SENTINEL ${'additional context '.repeat(30)}`, tags: ['allowed'] },
    { id: 'private', text: 'quartz quartz private private private', tags: ['private'] },
  ]);
  return { store, storePath };
}

describe('RAG evidence coverage', () => {
  test.each(['lexical', 'dense', 'hybrid'] as const)('%s does not let a long document crowd out other source documents', async (mode) => {
    const { store } = await corpus(mode !== 'lexical');
    const docs = await store.semanticSearch('quartz', 3, 0, { mode, excludeTags: ['private'], passages: true });
    expect(docs.map((doc) => doc.id).sort()).toEqual(['approval', 'checksum', 'long-report']);
    expect(docs.every((doc) => doc.matchedChunks?.length)).toBe(true);
    expect(docs[0].id).toBe('long-report');
  });

  test('backfilled evidence obeys tag and subtree scope before consuming places', async () => {
    const { store } = await corpus();
    const docs = await store.semanticSearch('quartz', 3, 0, { tags: ['allowed'], where: (tags) => !tags.includes('private') });
    expect(docs.map((doc) => doc.id).sort()).toEqual(['approval', 'checksum', 'long-report']);
    expect(docs.some((doc) => doc.id === 'private')).toBe(false);
  });

  test('backfill does not bypass the lexical relevance floor', async () => {
    const { store } = await corpus();
    const docs = await store.semanticSearch('quartz', 3, 0.1, { excludeTags: ['private'] });
    expect(docs.map((doc) => doc.id)).toEqual(['long-report']);
  });

  test('a smaller document result limit does not change the existing winning prefix', async () => {
    const { store } = await corpus();
    const first = await store.semanticSearch('quartz', 1, 0, { excludeTags: ['private'] });
    const three = await store.semanticSearch('quartz', 3, 0, { excludeTags: ['private'] });
    expect(three[0].id).toBe(first[0].id);
    expect(three).toHaveLength(3);
  });

  test('bounded reranking keeps its original request and cannot hide tail documents', async () => {
    const storePath = path.join(dir, `rerank-${serial++}.json`);
    const seen: number[] = [];
    const store = new VectorStore(null, { model: 'fixture', unavailableReason: () => null,
      rerank: async (_query, candidates) => { seen.push(candidates.length); return null; } }, {
      storePath, dedup: false, chunker: (id, text) => text.split('\n').map((line, i) => ({ id: `${id}#${i}`, text: line })),
    });
    await store.storeDocuments([
      { id: 'dominant', text: 'quartz quartz quartz\n'.repeat(150).trim(), tags: [] },
      { id: 'other', text: 'quartz additional evidence', tags: [] },
    ]);
    const docs = await store.semanticSearch('quartz', 2, 0);
    expect(docs.map((doc) => doc.id)).toEqual(['dominant', 'other']);
    expect(seen).toEqual([64]);
  });
});

describe('RAG prompt assembly', () => {
  const doc = (id: string, text: string): VectorDocument => {
    const chunk = { id: `${id}#0`, text };
    return { id, metadata: { content: text, tags: [] }, chunks: [chunk], matchedChunks: [chunk] };
  };
  test('a long first source leaves room for the other required evidence', async () => {
    const docs = [
      doc('retry', `${'ordinary engineering context\n'.repeat(200)}quartz upload retry limit = RETRY-7`),
      doc('checksum', 'quartz upload checksum rule = CHECKSUM-42'),
      doc('approval', 'quartz upload approval policy = APPROVAL-9'),
    ];
    const result = await recallForTurn({ semanticSearch: async () => docs } as any, 'quartz upload retry checksum approval', { maxChars: 900 });
    expect(result?.ids).toEqual(['retry', 'checksum', 'approval']);
    for (const fact of ['RETRY-7', 'CHECKSUM-42', 'APPROVAL-9']) expect(result?.text).toContain(fact);
    expect(result!.text.split('\n').slice(1).join('\n').length).toBeLessThanOrEqual(900);
    for (const span of result!.evidence) expect(result!.text).toContain(span.text);
  });

  test('a tiny prompt budget still preserves the best source and truthful partial evidence', async () => {
    const docs = [doc('best', 'quartz retry limit = 7; '.repeat(80)), doc('other', 'quartz secondary rule')];
    const result = await recallForTurn({ semanticSearch: async () => docs } as any, 'quartz retry limit', { maxChars: 100 });
    expect(result?.ids[0]).toBe('best');
    expect(result!.evidence[0].locator).toMatchObject({ kind: 'memory', partial: true });
    expect(result!.text).toContain(result!.evidence[0].text);
  });
});

describe('RAG warm-path work', () => {
  test('candidate resolution does not rescan a long document chunk array', async () => {
    const store = new VectorStore(null, null, { storePath: path.join(dir, `lookup-${serial++}.json`), dedup: false,
      chunker: (id, text) => text.split('\n').map((line, i) => ({ id: `${id}#${i}`, text: line })) });
    await store.storeDocument('large', [...Array.from({ length: 1500 }, (_, i) => `background${i}`), ...Array.from({ length: 64 }, (_, i) => `needle exact passage ${i}`)].join('\n'), []);
    await store.semanticSearch('needle', 1, 0);
    const find = jest.spyOn(Array.prototype, 'find');
    const docs = await store.semanticSearch('needle', 1, 0, { passages: true });
    const rescans = find.mock.instances.filter((receiver) => Array.isArray(receiver) && receiver.length > 1000);
    find.mockRestore();
    expect(docs[0].matchedChunks).toHaveLength(64);
    expect(rescans).toHaveLength(0);
  });

  test('unknown-term checks probe query terms rather than deleting every corpus term', async () => {
    const store = new VectorStore(null, null, { storePath: path.join(dir, `vocab-${serial++}.json`), dedup: false });
    await store.storeDocument('large', Array.from({ length: 2000 }, (_, i) => `vocabulary${i}`).join(' '), []);
    store.unknownTerms(['missing']); // warm the existing content-versioned vocabulary cache
    const remove = jest.spyOn(Set.prototype, 'delete');
    const absent = store.unknownTerms(['missing', 'absent']);
    const calls = remove.mock.calls.length; remove.mockRestore();
    expect(absent).toEqual(['missing', 'absent']); expect(calls).toBe(0);
  });

  test('replacement and deletion rebuild chunk lookup without serving stale evidence', async () => {
    const { store, storePath } = await corpus();
    await store.storeDocument('checksum', 'olduniquechecksum', ['allowed']);
    expect((await store.semanticSearch('olduniquechecksum', 1, 0))[0].metadata.content).toBe('olduniquechecksum');
    await store.storeDocument('checksum', 'replacementuniquerule', ['allowed']);
    expect(await store.semanticSearch('olduniquechecksum', 1, 0)).toEqual([]);
    expect((await store.semanticSearch('replacementuniquerule', 1, 0))[0].id).toBe('checksum');
    const saved = JSON.parse(fs.readFileSync(storePath, 'utf8')).filter((doc: VectorDocument) => doc.id !== 'checksum');
    fs.writeFileSync(storePath, JSON.stringify(saved));
    expect(await store.semanticSearch('replacementuniquerule', 1, 0)).toEqual([]);
  });

  test('unchanged-file warm searches do not copy the full recency map', async () => {
    const storePath = path.join(dir, `recency-${serial++}.json`);
    fs.writeFileSync(storePath, JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({
      id: `doc${i}`, metadata: { content: i ? 'background' : 'uniquequery', tags: [] },
      chunks: [{ id: `doc${i}#0`, text: i ? 'background' : 'uniquequery' }],
    }))));
    const store = new VectorStore(null, null, { storePath, maxVectors: 2000 });
    await store.semanticSearch('uniquequery', 1, 0);
    const map = jest.spyOn(Array.prototype, 'map');
    const docs = await store.semanticSearch('uniquequery', 1, 0);
    const copies = map.mock.instances.filter(receiver => Array.isArray(receiver) && receiver.length === 2000);
    map.mockRestore();
    expect(docs.map(doc => doc.id)).toEqual(['doc0']); expect(copies).toHaveLength(0);
  });

  test('unknown-term cache follows content replacement and current tag scope', async () => {
    const { store } = await corpus();
    expect(store.unknownTerms(['checksum'], { excludeTags: ['private'] })).toEqual([]);
    await store.storeDocument('checksum', 'new fresh vocabulary', ['allowed']);
    expect(store.unknownTerms(['checksum'], { excludeTags: ['private'] })).toEqual(['checksum']);
    expect(store.unknownTerms(['private'], { tags: ['allowed'] })).toEqual(['private']);
  });
});
