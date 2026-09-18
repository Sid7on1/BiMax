import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VectorStore } from '../memory/vector.store';
import { RemoteEmbeddingBackend, type EmbeddingTransport } from '../memory/embeddings';
import { resolveMemorySettings, DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from '../memory/settings';
import { DEFAULTS } from '../engine/config';

/**
 * Store-level behaviours added with the second retrieval pass: dedup-before-store, tag scoping
 * applied before depth, recency that survives a restart (coalesced), and a readout for /retrieval.
 * Each test is written against the failure mode the feature exists to prevent.
 */

const credentials = async () => ({ apiKey: 'k', baseURL: 'https://example.invalid/v1' });

/** Keyword-axis space: text about keyboards → [1,0], text about colour → [0,1]. */
const axisTransport: EmbeddingTransport = async (_url, init) => {
  const body = JSON.parse(init.body);
  const vec = (text: string): number[] => {
    const kb = /key|qwerty|keyboard|typing|input|shortcut/i.test(text) ? 1 : 0;
    const colour = /colou?r|palette|hue|tint/i.test(text) ? 1 : 0;
    return kb && !colour ? [1, 0] : colour && !kb ? [0, 1] : [kb, colour];
  };
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: body.input.map((text: string, index: number) => ({ embedding: vec(text), index })) }),
  };
};

const backend = () => new RemoteEmbeddingBackend({ resolve: credentials, transport: axisTransport });

let tmp: string;
let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-store-'));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('near-duplicate merging on write', () => {
  test('a near-verbatim restatement updates the existing memory instead of appending', async () => {
    const store = new VectorStore(null);
    await store.storeDocument('a', 'the permission coach polls once per second on the main thread', []);
    await store.storeDocument('b', 'The permission coach polls once per second on the main thread.', []);
    const hits = await store.semanticSearch('permission coach polling', 5, 0);
    const ids = hits.map((h) => h.id);
    expect(ids).toContain('a');
    expect(ids).not.toContain('b'); // merged into a — one fact, one entry, newest phrasing
  });

  test('a different fact about the same topic is NOT merged', async () => {
    const store = new VectorStore(null);
    await store.storeDocument('a', 'the permission coach polls once per second on the main thread', []);
    await store.storeDocument('b', 'the permission coach dialog is styled by the Trust Center layer', []);
    const hits = await store.semanticSearch('permission', 5, 0);
    expect(hits.map((h) => h.id).sort()).toEqual(['a', 'b']);
  });

  test('embedding agreement alone cannot merge — a coarse space must not delete distinct memories', async () => {
    // The failure this guards against, found on this repo's own eval fixture: two DIFFERENT facts
    // whose centroids collide above the threshold (easy in a low-dimension space) would have their
    // older copy silently deleted by a cosine-only rule. Lexical corroboration is required.
    const store = new VectorStore(backend());
    // Both texts land on the SAME axis → centroid cosine 1.0, but they share almost no words.
    await store.storeDocument('keyboard-nav', 'QWERTY remapping intercepts hardware key events early', []);
    await store.storeDocument('keyboard-crt', 'Shortcut cheat-sheet colours follow the palette tint rules', []);
    const raw = JSON.parse(fs.readFileSync('.breakglass/memory/vectors.json', 'utf8'));
    expect(raw.map((d: any) => d.id).sort()).toEqual(['keyboard-crt', 'keyboard-nav']);
  });

  test('a true paraphrase with embeddings merges', async () => {
    const store = new VectorStore(backend());
    await store.storeDocument('old', 'QWERTY remapping intercepts the hardware key events before the app sees them', []);
    await store.storeDocument('new', 'QWERTY remapping intercepts the hardware key events before the app receives them', []);
    const raw = JSON.parse(fs.readFileSync('.breakglass/memory/vectors.json', 'utf8'));
    expect(raw).toHaveLength(1);
    expect(raw[0].metadata.content).toContain('receives'); // newest phrasing wins
    expect(raw[0].id).toBe('old'); // the id survives so retrieval history does too
  });
});

describe('tag scoping', () => {
  test('tags filter BEFORE depth: the best tagged memory wins even when an untagged one matches harder', async () => {
    const store = new VectorStore(null);
    await store.storeDocument('untagged-exact', 'AXError -25208 on a Notes row', []);
    await store.storeDocument('tagged-loose', 'background press delivery is refused per control', ['project-memory']);

    // The exact-token doc would rank first unscoped; scoped, it is not a candidate at all —
    // not "returned second", absent.
    const scoped = await store.semanticSearch('AXError -25208 background press refusal', 1, 0, { tags: ['project-memory'] });
    expect(scoped.map((h) => h.id)).toEqual(['tagged-loose']);
  });

  test('excludeTags keeps the two injection paths from showing one memory twice', async () => {
    const store = new VectorStore(null);
    await store.storeDocument('convention', 'always run the build after edits in this repo', ['project-memory']);
    await store.storeDocument('episode', 'the build was broken by a stale dist artifact last week', []);

    const both = await store.semanticSearch('the build after edits', 2, 0);
    expect(both.map((h) => h.id).sort()).toEqual(['convention', 'episode']);

    const recallOnly = await store.semanticSearch('the build after edits', 2, 0, { excludeTags: ['project-memory'] });
    expect(recallOnly.map((h) => h.id)).toEqual(['episode']);
  });
});

describe('recency persistence', () => {
  test('a coalesced flush survives retrieval-only sessions, and never blocks the read', async () => {
    // Short real window via the env knob rather than fake timers: the flush rides the store's
    // async mutex, and faking the clock wedges that chain for no insight.
    process.env.BIMAX_RECENCY_FLUSH_MS = '50';
    try {
      const store = new VectorStore(null);
      await store.storeDocument('used', 'AXError -25208 background press refusal', []);
      await store.storeDocument('unused', 'something else entirely about typography', []);
      // Wall-clock granularity: without this the retrieval lands in the same millisecond as the
      // write and the comparison is a coin flip (see the eviction test for the same trap).
      await new Promise((r) => setTimeout(r, 5));

      const results = await store.semanticSearch('AXError -25208', 1, 0);
      expect(results[0]?.id).toBe('used');

      // Before the window closes, the file does not know about the retrieval: the timestamp it
      // holds is the one from the WRITE (storeDocument), not the read.
      const rawBefore = JSON.parse(fs.readFileSync('.breakglass/memory/vectors.json', 'utf8'));
      const usedBefore = rawBefore.find((d: any) => d.id === 'used').lastUsedAt;

      // …after the window it does, without any write having happened.
      await new Promise((r) => setTimeout(r, 250));
      const raw = JSON.parse(fs.readFileSync('.breakglass/memory/vectors.json', 'utf8'));
      expect(raw.find((d: any) => d.id === 'used').lastUsedAt).toBeGreaterThan(usedBefore);
    } finally {
      delete process.env.BIMAX_RECENCY_FLUSH_MS;
    }
  });

  test('multiple searches inside one flush window preserve every recency update', async () => {
    process.env.BIMAX_RECENCY_FLUSH_MS = '50';
    try {
      const store = new VectorStore(null);
      await store.storeDocument('first', 'FIRST_RECENCY_SENTINEL', []);
      await store.storeDocument('second', 'SECOND_RECENCY_SENTINEL', []);
      const before = JSON.parse(fs.readFileSync('.breakglass/memory/vectors.json', 'utf8'));
      const beforeById = new Map<string, number>(before.map((d: any) => [d.id, Number(d.lastUsedAt)]));
      await new Promise((r) => setTimeout(r, 5));

      expect((await store.semanticSearch('FIRST_RECENCY_SENTINEL', 1, 0))[0]?.id).toBe('first');
      await new Promise((r) => setTimeout(r, 5));
      expect((await store.semanticSearch('SECOND_RECENCY_SENTINEL', 1, 0))[0]?.id).toBe('second');
      await new Promise((r) => setTimeout(r, 250));

      const after = JSON.parse(fs.readFileSync('.breakglass/memory/vectors.json', 'utf8'));
      expect(after.find((d: any) => d.id === 'first').lastUsedAt).toBeGreaterThan(beforeById.get('first')!);
      expect(after.find((d: any) => d.id === 'second').lastUsedAt).toBeGreaterThan(beforeById.get('second')!);
    } finally {
      delete process.env.BIMAX_RECENCY_FLUSH_MS;
    }
  });
});

describe('stats', () => {
  test('counts documents, chunks and pending embeddings for the /retrieval readout', async () => {
    const store = new VectorStore(backend());
    await store.storeDocument('embedded', 'QWERTY remapping for key events', []);
    const stats = store.stats();
    expect(stats.documents).toBe(1);
    expect(stats.chunks).toBeGreaterThanOrEqual(1);
    expect(stats.embedded).toBe(stats.chunks);
    expect(stats.pending).toBe(0);
  });

  test('chunks stored without a backend count as pending, not embedded', async () => {
    const store = new VectorStore(null);
    await store.storeDocument('bare', 'a note written while embeddings were off', []);
    const stats = store.stats();
    expect(stats.embedded).toBe(0);
    expect(stats.pending).toBe(stats.chunks);
  });
});

describe('memory model settings', () => {
  test('remote source-code embeddings require explicit consent', () => {
    expect(DEFAULTS.codeIndexEnabled).toBe(true);
    expect(DEFAULTS.codeIndexRemoteEmbeddings).toBe(false);
  });

  test('defaults when nothing is set', () => {
    const s = resolveMemorySettings({}, {});
    expect(s.embeddingModel).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(s.embeddingDimensions).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
  });

  test('config keys beat defaults; env beats config', () => {
    const s = resolveMemorySettings(
      { memoryEmbeddingModel: 'config/model', memoryEmbeddingDimensions: 1024, memoryRerankModel: 'config/rerank' },
      { BIMAX_EMBED_MODEL: 'env/model' },
    );
    expect(s.embeddingModel).toBe('env/model'); // env wins
    expect(s.embeddingDimensions).toBe(1024); // config: env var absent
    expect(s.rerankModel).toBe('config/rerank');
  });

  test('a dimension the model cannot emit resolves to the default rather than disabling embeddings', () => {
    const s = resolveMemorySettings({ memoryEmbeddingDimensions: 777 }, {});
    expect(s.embeddingDimensions).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
  });
});
