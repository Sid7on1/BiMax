import { RemoteEmbeddingBackend, EmbeddingTransport, withInstruction } from '../memory/embeddings';
import { embeddingDialectFor, DEFAULT_QUERY_INSTRUCTION } from '../memory/settings';

/**
 * Embeddings must survive leaving NVIDIA — the half of the sovereign repair that never landed.
 *
 * `rerankURLFor` was written because reranking 404'd on every local deployment and `vector.store.ts`
 * swallowed it. The embeddings backend had the identical bug one layer over: it sends `input_type`,
 * `truncate` and `dimensions` on every call, none of which are in the OpenAI embeddings schema, so
 * vLLM/Ollama/LM Studio answer 400 — and 400 is in this module's terminal list. One query latched
 * `unavailable` for the whole session and the store fell back to BM25 while reporting nothing worse
 * than "no matches".
 *
 * The tests use an injected transport, so the suite stays offline and hermetic.
 */

type Call = { url: string; body: any };

function transportReturning(status: number, payload: unknown, calls: Call[]): EmbeddingTransport {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
}

/** A well-formed response of `count` vectors, each `dims` wide. */
function vectors(count: number, dims: number) {
  return {
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: Array.from({ length: dims }, (_, i) => (i === index % dims ? 1 : 0)),
    })),
  };
}

const credentials = (baseURL: string) => async () => ({ apiKey: 'k', baseURL });

const LOCAL_SERVERS = [
  'http://127.0.0.1:11434/v1',   // Ollama
  'http://127.0.0.1:8000/v1',    // vLLM
  'http://127.0.0.1:1234/v1',    // LM Studio
  'http://127.0.0.1:8080/v1',    // llama.cpp
];

afterEach(() => {
  delete process.env.BIMAX_EMBED_DIALECT;
  delete process.env.BIMAX_EMBED_QUERY_INSTRUCTION;
});

describe('the body is chosen by where the endpoint lives', () => {
  it('sends the minimal OpenAI body to every local server', () => {
    for (const base of LOCAL_SERVERS) expect(embeddingDialectFor(base)).toBe('openai');
  });

  it('treats a LAN GPU box as local too — a sovereign install is rarely loopback', () => {
    expect(embeddingDialectFor('http://10.0.0.5:8000/v1')).toBe('openai');
    expect(embeddingDialectFor('http://192.168.1.40:8000/v1')).toBe('openai');
    expect(embeddingDialectFor('http://gpu01.plant.internal:8000/v1')).toBe('openai');
  });

  it('leaves hosted providers on the body they already accept', () => {
    expect(embeddingDialectFor('https://integrate.api.nvidia.com/v1')).toBe('nvidia');
  });

  it('an unparseable base is treated as remote, never assumed safe to strip fields for', () => {
    expect(embeddingDialectFor('')).toBe('nvidia');
  });

  it('an explicit override wins over the guess', () => {
    process.env.BIMAX_EMBED_DIALECT = 'openai';
    expect(embeddingDialectFor('https://integrate.api.nvidia.com/v1')).toBe('openai');
    process.env.BIMAX_EMBED_DIALECT = 'nvidia';
    expect(embeddingDialectFor('http://127.0.0.1:8000/v1')).toBe('nvidia');
  });
});

describe('both wire dialects are spoken', () => {
  it('MUTANT — the local body carries none of the fields that used to 400', async () => {
    const calls: Call[] = [];
    const backend = new RemoteEmbeddingBackend({
      resolve: credentials('http://127.0.0.1:8000/v1'),
      transport: transportReturning(200, vectors(1, 1024), calls),
    });
    await backend.embed(['shell course thickness'], 'passage');

    // These three are the whole bug.
    expect(calls[0].body).not.toHaveProperty('input_type');
    expect(calls[0].body).not.toHaveProperty('truncate');
    expect(calls[0].body).not.toHaveProperty('dimensions');
    expect(calls[0].body).toMatchObject({ encoding_format: 'float' });
    expect(calls[0].url).toBe('http://127.0.0.1:8000/v1/embeddings');
  });

  it('REGRESSION — the hosted body is unchanged, byte for byte', async () => {
    const calls: Call[] = [];
    const backend = new RemoteEmbeddingBackend({
      resolve: credentials('https://integrate.api.nvidia.com/v1'),
      dimensions: 768,
      transport: transportReturning(200, vectors(1, 768), calls),
    });
    await backend.embed(['shell course thickness'], 'query');

    expect(calls[0].body.input_type).toBe('query');
    expect(calls[0].body.truncate).toBe('END');
    expect(calls[0].body.dimensions).toBe(768);
    // The hosted dialect carries asymmetry in `input_type`, so the text must NOT be rewritten.
    expect(calls[0].body.input[0]).toBe('shell course thickness');
  });
});

describe('asymmetry survives the loss of input_type', () => {
  it('instructs the query side only', async () => {
    const calls: Call[] = [];
    const backend = new RemoteEmbeddingBackend({
      resolve: credentials('http://127.0.0.1:8000/v1'),
      transport: transportReturning(200, vectors(1, 1024), calls),
    });

    await backend.embed(['minimum thickness'], 'query');
    await backend.embed(['minimum thickness'], 'passage');

    expect(calls[0].body.input[0]).toBe(`Instruct: ${DEFAULT_QUERY_INSTRUCTION}\nQuery:minimum thickness`);
    // The passage stays bare — that is what lets the instruction change without re-indexing.
    expect(calls[1].body.input[0]).toBe('minimum thickness');
  });

  it('an empty instruction disables the prefix, for a symmetric model', () => {
    expect(withInstruction('q', { BIMAX_EMBED_QUERY_INSTRUCTION: '' } as NodeJS.ProcessEnv)).toBe('q');
  });

  it('a custom instruction is used verbatim', () => {
    const env = { BIMAX_EMBED_QUERY_INSTRUCTION: 'Retrieve refinery inspection findings' } as NodeJS.ProcessEnv;
    expect(withInstruction('q', env)).toBe('Instruct: Retrieve refinery inspection findings\nQuery:q');
  });
});

describe('the vector space is stamped with what the server actually emits', () => {
  it('adopts the observed width when nothing asked for a size', async () => {
    const calls: Call[] = [];
    const backend = new RemoteEmbeddingBackend({
      resolve: credentials('http://127.0.0.1:8000/v1'),
      model: 'Qwen/Qwen3-Embedding-0.6B',
      dimensions: 768,             // the settings default, which a local server never honours
      transport: transportReturning(200, vectors(1, 1024), calls),
    });

    await backend.embed(['x'], 'passage');

    // Had the id kept claiming 768, `dot()` would score 1024-wide vectors over a 768 prefix.
    expect(backend.dimensions).toBe(1024);
    expect(backend.id).toBe('Qwen/Qwen3-Embedding-0.6B@1024');
  });

  it('refuses when the server changes width mid-session', async () => {
    const calls: Call[] = [];
    let dims = 1024;
    const backend = new RemoteEmbeddingBackend({
      resolve: credentials('http://127.0.0.1:8000/v1'),
      transport: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => vectors(1, dims) };
      },
    });

    expect(await backend.embed(['x'], 'passage')).not.toBeNull();
    dims = 768;                    // a reload onto a different model behind the same id
    expect(await backend.embed(['y'], 'passage')).toBeNull();
    expect(backend.unavailableReason()).toContain('changed embedding width');
  });
});

describe('failure names the real cause', () => {
  it('a 400 reports the endpoint and the body shape, not just a status', async () => {
    const calls: Call[] = [];
    const backend = new RemoteEmbeddingBackend({
      resolve: credentials('https://integrate.api.nvidia.com/v1'),
      transport: transportReturning(400, {}, calls),
    });

    expect(await backend.embed(['x'], 'query')).toBeNull();
    const why = backend.unavailableReason() || '';
    expect(why).toContain('https://integrate.api.nvidia.com/v1/embeddings');
    expect(why).toContain('400');
    expect(why).toContain('nvidia body');
  });

  it('stays disabled after a terminal failure instead of retrying every query', async () => {
    const calls: Call[] = [];
    const backend = new RemoteEmbeddingBackend({
      resolve: credentials('http://127.0.0.1:8000/v1'),
      transport: transportReturning(400, {}, calls),
    });
    await backend.embed(['x'], 'query');
    await backend.embed(['y'], 'query');
    expect(calls).toHaveLength(1);
  });

  it('a 429 is transient and does NOT latch', async () => {
    const calls: Call[] = [];
    const backend = new RemoteEmbeddingBackend({
      resolve: credentials('http://127.0.0.1:8000/v1'),
      transport: transportReturning(429, {}, calls),
    });
    await backend.embed(['x'], 'query');
    await backend.embed(['y'], 'query');
    expect(calls).toHaveLength(2);
    expect(backend.unavailableReason()).toBeNull();
  });
});
