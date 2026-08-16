import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VectorStore } from '../memory/vector.store';
import { normalize, type EmbeddingBackend } from '../memory/embeddings';

/**
 * The store, graded on the one claim it makes: that it finds things a keyword search cannot.
 *
 * The store writes under `process.cwd()`, so each test runs in its own temp directory — otherwise
 * these would read and overwrite the developer's real memory file, which is both a wrong test and
 * a destructive one.
 */

let tmp: string;
let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-vec-'));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A backend with a hand-placed geometry, so "semantically close" is a fact of the fixture rather
 * than a hope about a real model. Texts are mapped to points on a circle; paraphrases are placed
 * next to each other and unrelated text on the far side.
 */
function fakeBackend(angles: Record<string, number>, id = 'fake@2'): EmbeddingBackend {
  return {
    id,
    dimensions: 2,
    async embed(texts, _role) {
      return texts.map((t) => {
        const angle = angles[t];
        if (angle === undefined) return normalize([0.01, 0.01]);
        return normalize([Math.cos(angle), Math.sin(angle)]);
      });
    },
  };
}

const CI_RED = 'CI is red on main';
const BUILD_FAILING = 'the build is failing';
const UNRELATED = 'sidebar corner radius interpolation';

const ANGLES = {
  [CI_RED]: 0.05,
  [BUILD_FAILING]: 0.0,     // paraphrase of CI_RED — adjacent
  [UNRELATED]: Math.PI,     // opposite side of the space
};

describe('hybrid retrieval', () => {
  test('finds a paraphrase that shares no words with the query', async () => {
    // The capability this whole change exists to add, and the one the previous store could not
    // have: "the build is failing" and "CI is red on main" have zero tokens in common.
    const store = new VectorStore(fakeBackend(ANGLES));
    await store.storeDocument('ci', CI_RED, []);
    await store.storeDocument('other', UNRELATED, []);

    const hits = await store.semanticSearch(BUILD_FAILING, 3, 0.25);
    expect(hits.map((h) => h.id)).toContain('ci');
    expect(store.lastSearchMode()).toBe('hybrid');
  });

  test('the same query finds nothing under lexical-only retrieval', async () => {
    // The control. Without embeddings this is exactly the old behaviour — which is the point: the
    // test above is measuring the new capability, not a change in the fixture.
    const store = new VectorStore(null);
    await store.storeDocument('ci', CI_RED, []);
    await store.storeDocument('other', UNRELATED, []);

    const hits = await store.semanticSearch(BUILD_FAILING, 3, 0.25);
    expect(hits.map((h) => h.id)).not.toContain('ci');
    expect(store.lastSearchMode()).toBe('lexical');
  });

  test('exact identifiers still win, which is what BM25 is carrying', async () => {
    // Dense retrieval is worst on tokens the model never saw. If adding embeddings had cost us
    // exact-match recall, the hybrid would be a downgrade dressed as an upgrade.
    const store = new VectorStore(fakeBackend({}));
    await store.storeDocument('err', 'AXError -25208 refused the background press', []);
    await store.storeDocument('noise', 'a note about panels and animation', []);

    const hits = await store.semanticSearch('-25208', 3, 0);
    expect(hits[0].id).toBe('err');
  });

  test('an embedding failure degrades to lexical rather than returning nothing', async () => {
    // Offline, no key, provider down. The store must get worse, not break — and must say so.
    const failing: EmbeddingBackend = {
      id: 'x@1',
      dimensions: 1,
      async embed() { return null; },
    };
    const store = new VectorStore(failing);
    await store.storeDocument('a', 'permission coach drag and drop', []);

    const hits = await store.semanticSearch('permission drag', 3, 0);
    expect(hits.map((h) => h.id)).toEqual(['a']);
    expect(store.lastSearchMode()).toBe('lexical');
  });

  test('vectors from another model are discarded, never compared', async () => {
    // Mixing two spaces yields similarity scores that look entirely plausible and mean nothing.
    const first = new VectorStore(fakeBackend(ANGLES, 'model-a@2'));
    await first.storeDocument('ci', CI_RED, []);

    const raw = JSON.parse(fs.readFileSync(path.join(tmp, '.breakglass/memory/vectors.json'), 'utf8'));
    expect(raw[0].space).toBe('model-a@2');

    // Reopen under a different model: the stale vector must not be used.
    const second = new VectorStore(fakeBackend(ANGLES, 'model-b@2'));
    await second.semanticSearch('anything', 3, 0);
    const reread = JSON.parse(fs.readFileSync(path.join(tmp, '.breakglass/memory/vectors.json'), 'utf8'));
    expect(reread[0].space === 'model-a@2' && reread[0].embedding).toBeTruthy();

    // …and a backfill under the new model re-embeds it into the new space.
    const result = await second.backfillEmbeddings();
    expect(result.embedded).toBe(1);
    const after = JSON.parse(fs.readFileSync(path.join(tmp, '.breakglass/memory/vectors.json'), 'utf8'));
    expect(after[0].space).toBe('model-b@2');
  });

  test('a document stored while embeddings are down is still stored, and backfills later', async () => {
    // Refusing the write because the network was down loses the memory entirely, which is far
    // worse than a memory that is briefly lexical-only.
    let online = false;
    const flaky: EmbeddingBackend = {
      id: 'flaky@2',
      dimensions: 2,
      async embed(texts) {
        return online ? texts.map(() => normalize([1, 0])) : null;
      },
    };
    const store = new VectorStore(flaky);
    await store.storeDocument('a', 'something worth remembering', []);

    let raw = JSON.parse(fs.readFileSync(path.join(tmp, '.breakglass/memory/vectors.json'), 'utf8'));
    expect(raw[0].embedding).toBeUndefined();
    expect(raw[0].metadata.content).toBe('something worth remembering');

    online = true;
    expect((await store.backfillEmbeddings()).embedded).toBe(1);
    raw = JSON.parse(fs.readFileSync(path.join(tmp, '.breakglass/memory/vectors.json'), 'utf8'));
    expect(raw[0].space).toBe('flaky@2');
  });

  test('backfill is idempotent', async () => {
    const store = new VectorStore(fakeBackend(ANGLES));
    await store.storeDocument('ci', CI_RED, []);
    expect((await store.backfillEmbeddings()).embedded).toBe(0);
  });

  test('an empty query returns nothing instead of the whole store', async () => {
    const store = new VectorStore(fakeBackend(ANGLES));
    await store.storeDocument('ci', CI_RED, []);
    expect(await store.semanticSearch('   ', 3, 0)).toEqual([]);
  });
});
