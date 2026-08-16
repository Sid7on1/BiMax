import { Bm25Index, tokenize } from '../memory/bm25';
import { reciprocalRankFusion, RRF_K } from '../memory/fusion';
import { RemoteEmbeddingBackend, normalize, dot, type EmbeddingTransport } from '../memory/embeddings';

/**
 * The retrieval layer, graded on the properties that make it retrieval rather than grep.
 *
 * Every test here is written against a failure the previous implementation actually had, or a trap
 * the new one can silently fall into. "It returns some documents" is not one of them: the store it
 * replaces returned documents too, and returned the wrong ones.
 */

describe('BM25 ranking', () => {
  const corpus = [
    { id: 'a', text: 'the permission flow is broken and the permission dialog is broken' },
    { id: 'b', text: 'permission granted for accessibility on macOS' },
    { id: 'c', text: 'the sidebar animation clips the panel instead of resizing it' },
    { id: 'd', text: 'permission permission permission permission permission permission' },
  ];

  test('a rare term outranks a common one', () => {
    // The defect TF-cosine could not express. "accessibility" appears once in the corpus and
    // identifies exactly one document; "permission" is in three of four and identifies nothing.
    const index = new Bm25Index(corpus);
    const hits = index.search('permission accessibility');
    expect(hits[0].id).toBe('b');
  });

  test('term frequency saturates instead of scaling linearly', () => {
    // Document d says "permission" six times and nothing else. Under TF cosine it is the single
    // best match for the word by a wide margin. Under BM25 the sixth mention is nearly free, so a
    // document that says it twice *in context* is not buried by pure repetition.
    const index = new Bm25Index(corpus);
    const hits = index.search('permission');
    const d = hits.find((h) => h.id === 'd')!;
    const a = hits.find((h) => h.id === 'a')!;
    // Six mentions vs two: a linear model would put d at 3x. Saturation keeps it well under.
    expect(d.score / a.score).toBeLessThan(1.6);
  });

  test('IDF never goes negative, so a ubiquitous term cannot penalise a document', () => {
    // The textbook formula returns a negative weight once a term is in more than half the corpus,
    // which makes containing the query's own word *lower* the score. On a corpus this small that is
    // not an edge case — it is most common words.
    const index = new Bm25Index([
      { id: '1', text: 'alpha beta' },
      { id: '2', text: 'alpha gamma' },
      { id: '3', text: 'alpha delta' },
    ]);
    expect(index.idf('alpha')).toBeGreaterThanOrEqual(0);
    expect(index.search('alpha').every((h) => h.score >= 0)).toBe(true);
  });

  test('length normalisation stops a long document winning by being long', () => {
    const index = new Bm25Index([
      { id: 'short', text: 'clip path bug' },
      { id: 'long', text: `clip path bug ${'filler word here '.repeat(60)}` },
    ]);
    expect(index.search('clip path bug')[0].id).toBe('short');
  });

  test('digits survive tokenisation', () => {
    // Error codes and version numbers are the most searchable tokens in this corpus. A tokenizer
    // that dropped them would lose exactly what someone types when something has broken.
    expect(tokenize('AXError -25208 in driver 0.12.3')).toEqual(
      expect.arrayContaining(['axerror', '25208', 'driver', '12']),
    );
  });

  test('an empty or stopword-only query returns nothing rather than everything', () => {
    const index = new Bm25Index(corpus);
    expect(index.search('')).toEqual([]);
    expect(index.search('the is a to')).toEqual([]);
  });
});

describe('reciprocal rank fusion', () => {
  test('agreement between two retrievers beats one retriever’s enthusiasm', () => {
    // The property that makes fusion worth doing. `both` is 3rd and 3rd; `one` is 1st and absent.
    const fused = reciprocalRankFusion({
      lexical: { ids: ['one', 'x', 'both'] },
      dense: { ids: ['y', 'z', 'both'] },
    });
    expect(fused[0].id).toBe('both');
  });

  test('a missing list degrades to the other list’s exact order', () => {
    // What makes an offline run safe: with no dense results the output must be the BM25 ranking,
    // in order — not a blend of a real ranking with an absent one.
    const fused = reciprocalRankFusion({
      lexical: { ids: ['a', 'b', 'c'] },
      dense: { ids: [] },
    });
    expect(fused.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  test('scores are rank-derived, so an outlier score cannot rescale the ranking', () => {
    // The reason we fuse ranks and not scores: BM25 is unbounded and corpus-dependent, cosine is
    // bounded. Here the top hit's contribution is fixed by k and its rank alone.
    const fused = reciprocalRankFusion({ lexical: { ids: ['a'] } });
    expect(fused[0].score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  test('ties break deterministically', () => {
    const once = reciprocalRankFusion({ l: { ids: ['b', 'a'] }, d: { ids: ['a', 'b'] } });
    const twice = reciprocalRankFusion({ l: { ids: ['b', 'a'] }, d: { ids: ['a', 'b'] } });
    expect(once.map((f) => f.id)).toEqual(twice.map((f) => f.id));
  });

  test('ranks are reported, so a surprising order can be explained', () => {
    const fused = reciprocalRankFusion({ lexical: { ids: ['a'] }, dense: { ids: ['b', 'a'] } });
    expect(fused.find((f) => f.id === 'a')!.ranks).toEqual({ lexical: 1, dense: 2 });
  });
});

describe('embedding backend', () => {
  const credentials = async () => ({ apiKey: 'k', baseURL: 'https://example.invalid/v1' });

  function capturingTransport(vectors: number[][]): { transport: EmbeddingTransport; bodies: any[] } {
    const bodies: any[] = [];
    const transport: EmbeddingTransport = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: vectors.map((embedding, index) => ({ embedding, index })) }),
      };
    };
    return { transport, bodies };
  }

  test('a query and a passage are sent with different input_type', async () => {
    // The asymmetric half, and the one that fails silently. These models have separate query and
    // passage encoders; embedding a query as a passage lands it in the wrong region of the space
    // and produces quietly worse recall with no error anywhere.
    const { transport, bodies } = capturingTransport([[1, 0]]);
    const backend = new RemoteEmbeddingBackend({ resolve: credentials, transport });

    await backend.embed(['hello'], 'query');
    await backend.embed(['hello'], 'passage');

    expect(bodies[0].input_type).toBe('query');
    expect(bodies[1].input_type).toBe('passage');
  });

  test('truncate is END, because the provider default NONE is an error', async () => {
    const { transport, bodies } = capturingTransport([[1, 0]]);
    await new RemoteEmbeddingBackend({ resolve: credentials, transport }).embed(['x'], 'passage');
    expect(bodies[0].truncate).toBe('END');
  });

  test('vectors come back unit length, so cosine is a dot product', async () => {
    const { transport } = capturingTransport([[3, 4]]);
    const backend = new RemoteEmbeddingBackend({ resolve: credentials, transport });
    const [vector] = (await backend.embed(['x'], 'passage'))!;
    expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
    expect(dot(vector, vector)).toBeCloseTo(1, 10);
  });

  test('out-of-order responses are re-ordered by index', async () => {
    // The spec permits any order. Trusting arrival order attaches every vector to the wrong
    // document, which produces a store that returns confident, entirely unrelated results.
    const transport: EmbeddingTransport = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0, 1], index: 1 }, { embedding: [1, 0], index: 0 }] }),
    });
    const vectors = await new RemoteEmbeddingBackend({ resolve: credentials, transport })
      .embed(['first', 'second'], 'passage');
    expect(vectors![0]).toEqual([1, 0]);
    expect(vectors![1]).toEqual([0, 1]);
  });

  test('oversized inputs are split into batches, not rejected', async () => {
    const { transport, bodies } = capturingTransport([[1, 0], [0, 1]]);
    const backend = new RemoteEmbeddingBackend({ resolve: credentials, transport, batchSize: 2 });
    const out = await backend.embed(['a', 'b', 'c', 'd'], 'passage');
    expect(bodies).toHaveLength(2);
    expect(out).toHaveLength(4);
  });

  test('no key returns null — never a fabricated vector', async () => {
    // The whole point of the module. A hashed stand-in would let the store rank on noise while
    // reporting a semantic score, which is the failure this replaces.
    const backend = new RemoteEmbeddingBackend({ resolve: async () => null });
    expect(await backend.embed(['x'], 'query')).toBeNull();
    expect(backend.unavailableReason()).toMatch(/no API key/i);
  });

  test('a 404 latches off; a 429 does not', async () => {
    // A provider that serves no embeddings will not start to. A rate limit will pass. Latching the
    // second would silently disable semantic search for the rest of the session.
    let status = 404;
    const transport: EmbeddingTransport = async () => ({ ok: false, status, json: async () => ({}) });
    const dead = new RemoteEmbeddingBackend({ resolve: credentials, transport });
    await dead.embed(['x'], 'query');
    expect(dead.unavailableReason()).toContain('404');

    status = 429;
    const throttled = new RemoteEmbeddingBackend({ resolve: credentials, transport });
    await throttled.embed(['x'], 'query');
    expect(throttled.unavailableReason()).toBeNull();
  });

  test('the space id changes with the model or the dimensions', async () => {
    // Vectors are only comparable within one space. If this id failed to move, a model swap would
    // compare two spaces and produce plausible-looking nonsense.
    const a = new RemoteEmbeddingBackend({ resolve: credentials, model: 'm1', dimensions: 768 });
    const b = new RemoteEmbeddingBackend({ resolve: credentials, model: 'm2', dimensions: 768 });
    const c = new RemoteEmbeddingBackend({ resolve: credentials, model: 'm1', dimensions: 384 });
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });

  test('normalize leaves a zero vector alone rather than producing NaN', () => {
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});
