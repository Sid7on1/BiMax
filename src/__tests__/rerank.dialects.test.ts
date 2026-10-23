import { RemoteReranker, RerankTransport } from '../memory/rerank';
import { rerankURLFor, rerankDialectFor, NVIDIA_RERANK_URL } from '../memory/settings';

/**
 * Reranking must survive leaving NVIDIA.
 *
 * Reranking is the single most impactful stage in the pipeline — measured on T2-RAGBench, hybrid
 * retrieval goes Recall@5 0.695 -> 0.816 when it is added. This suite exists because that stage was
 * DEAD on every sovereign deployment and nothing said so: `rerankURLFor` returned `<base>/ranking`
 * for every provider, which is NVIDIA's path and nobody else's, so a local Ollama or vLLM 404'd and
 * `vector.store.ts` swallowed it with `.catch(() => null)`.
 *
 * The tests use an injected transport, so the suite stays offline and hermetic.
 */

type Call = { url: string; body: any };

function transportReturning(status: number, payload: unknown, calls: Call[]): RerankTransport {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
}

const credentials = (baseURL: string) => async () => ({
  apiKey: 'k', baseURL, rerankURL: rerankURLFor(baseURL),
});

const candidates = [
  { id: 'a', text: 'Measured minimum thickness 9.4 mm on shell course 1.' },
  { id: 'b', text: 'Measured minimum thickness 7.8 mm; engineering assessment required.' },
  { id: 'c', text: 'Unrelated: lubrication schedule for pump P-310A.' },
];

describe('the endpoint is resolved per provider, not assumed', () => {
  it('keeps NVIDIA on its retrieval host', () => {
    expect(rerankURLFor('https://integrate.api.nvidia.com/v1')).toBe(NVIDIA_RERANK_URL);
    expect(rerankDialectFor(NVIDIA_RERANK_URL)).toBe('nvidia');
  });

  it('sends a local OpenAI-compatible server to /rerank, NOT /ranking', () => {
    // The bug: every local provider got `<base>/ranking`, which none of them serve.
    for (const base of [
      'http://127.0.0.1:11434/v1',   // Ollama
      'http://127.0.0.1:8000/v1',    // vLLM
      'http://127.0.0.1:1234/v1',    // LM Studio
    ]) {
      const url = rerankURLFor(base);
      expect(url).toBe(`${base}/rerank`);
      expect(url).not.toContain('/ranking');
      expect(rerankDialectFor(url)).toBe('cohere');
    }
  });

  it('adds the version segment when the base URL has none', () => {
    expect(rerankURLFor('http://historian.plant.local:8080')).toBe('http://historian.plant.local:8080/v1/rerank');
  });

  it('an explicit override wins over every guess', () => {
    process.env.BIMAX_RERANK_URL = 'http://10.0.0.5:9000/rerank';
    try {
      expect(rerankURLFor('https://integrate.api.nvidia.com/v1')).toBe('http://10.0.0.5:9000/rerank');
    } finally { delete process.env.BIMAX_RERANK_URL; }
  });
});

describe('both wire dialects are spoken', () => {
  it('NVIDIA: sends passages objects and reads rankings/logit', async () => {
    const calls: Call[] = [];
    const reranker = new RemoteReranker({
      resolve: credentials('https://integrate.api.nvidia.com/v1'),
      transport: transportReturning(200, { rankings: [{ index: 1, logit: 9.1 }, { index: 0, logit: 2.0 }] }, calls),
    });
    const out = await reranker.rerank('minimum thickness', candidates);

    expect(calls[0].url).toBe(NVIDIA_RERANK_URL);
    expect(calls[0].body.query).toEqual({ text: 'minimum thickness' });
    expect(calls[0].body.passages[0]).toEqual({ text: candidates[0].text });
    expect(calls[0].body.truncate).toBe('END');
    expect(out?.map((h) => h.id)).toEqual(['b', 'a']);
  });

  it('Cohere/Jina: sends plain documents and reads results/relevance_score', async () => {
    const calls: Call[] = [];
    const reranker = new RemoteReranker({
      resolve: credentials('http://127.0.0.1:8000/v1'),
      transport: transportReturning(200, {
        results: [{ index: 1, relevance_score: 0.97 }, { index: 2, relevance_score: 0.11 }],
      }, calls),
    });
    const out = await reranker.rerank('minimum thickness', candidates);

    expect(calls[0].url).toBe('http://127.0.0.1:8000/v1/rerank');
    expect(calls[0].body.query).toBe('minimum thickness');          // a string, not {text}
    expect(calls[0].body.documents).toEqual(candidates.map((c) => c.text));
    expect(calls[0].body.top_n).toBe(3);
    expect(out?.map((h) => h.id)).toEqual(['b', 'c']);
  });

  it('orders by score descending whatever order the server replied in', async () => {
    const calls: Call[] = [];
    const reranker = new RemoteReranker({
      resolve: credentials('http://127.0.0.1:8000/v1'),
      transport: transportReturning(200, {
        results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.9 }],
      }, calls),
    });
    expect((await reranker.rerank('q', candidates))?.map((h) => h.id)).toEqual(['b', 'a']);
  });

  it('MUTANT — the NVIDIA body sent to a local server is what used to 422', async () => {
    // Documents why the dialect switch exists: the two shapes share no field names.
    const calls: Call[] = [];
    const reranker = new RemoteReranker({
      resolve: credentials('http://127.0.0.1:8000/v1'),
      transport: transportReturning(200, { results: [{ index: 0, relevance_score: 1 }] }, calls),
    });
    await reranker.rerank('q', candidates);
    expect(calls[0].body).not.toHaveProperty('passages');
    expect(calls[0].body).not.toHaveProperty('truncate');
    expect(calls[0].body).toHaveProperty('documents');
  });
});

describe('failure is loud, and never a silent reordering', () => {
  it('a 404 disables the reranker and names the endpoint it tried', async () => {
    const calls: Call[] = [];
    const reranker = new RemoteReranker({
      resolve: credentials('http://127.0.0.1:11434/v1'),
      transport: transportReturning(404, {}, calls),
    });
    expect(await reranker.rerank('q', candidates)).toBeNull();
    // The old message named only a status and a model, so an operator could not tell WHICH endpoint
    // had failed — the whole reason this went unnoticed on every sovereign install.
    expect(reranker.unavailableReason()).toContain('http://127.0.0.1:11434/v1/rerank');
    expect(reranker.unavailableReason()).toContain('404');
  });

  it('returns null rather than an order it did not compute', async () => {
    const calls: Call[] = [];
    // A response whose index points outside the window we sent means we are misreading the payload.
    const reranker = new RemoteReranker({
      resolve: credentials('http://127.0.0.1:8000/v1'),
      transport: transportReturning(200, { results: [{ index: 99, relevance_score: 1 }] }, calls),
    });
    expect(await reranker.rerank('q', candidates)).toBeNull();
  });

  it('an empty payload is null, not an empty ranking that would erase the fused order', async () => {
    const calls: Call[] = [];
    const reranker = new RemoteReranker({
      resolve: credentials('http://127.0.0.1:8000/v1'),
      transport: transportReturning(200, { results: [] }, calls),
    });
    expect(await reranker.rerank('q', candidates)).toBeNull();
  });

  it('stays disabled after a hard failure instead of retrying every query', async () => {
    const calls: Call[] = [];
    const reranker = new RemoteReranker({
      resolve: credentials('http://127.0.0.1:11434/v1'),
      transport: transportReturning(404, {}, calls),
    });
    await reranker.rerank('q', candidates);
    await reranker.rerank('q', candidates);
    expect(calls).toHaveLength(1);
  });
});
