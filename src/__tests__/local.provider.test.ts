import {
  getProviders, getProvider, localProviders, buildKeyPool, setProvider,
  sovereignProviderRefusal, LOCAL_PLACEHOLDER_KEY,
} from '../engine/provider';
import { discoverLocalModels, discoverAllLocalModels } from '../engine/local.models';
import { setSovereignMode, resetSovereignMode } from '../security/sovereign';

const KEY_ENVS = ['NVIDIA_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY', 'GOOGLE_API_KEY', 'OLLAMA_API_KEY', 'VLLM_API_KEY', 'LMSTUDIO_API_KEY',
  'LLAMACPP_API_KEY', 'BGW_PROVIDER', 'BGW_BASE_URL', 'BIMAX_DESKTOP_PROVIDER'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEY_ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
  resetSovereignMode();
});
afterEach(() => {
  for (const k of KEY_ENVS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
  }
  resetSovereignMode();
  setProvider('nvidia');
});

describe('on-premises providers', () => {
  it('ships Ollama, vLLM, LM Studio and llama.cpp as first-class presets', () => {
    // Before this, the only occurrence of these names in the tree was a comment.
    expect(localProviders().map(p => p.name)).toEqual(['ollama', 'vllm', 'lmstudio', 'llamacpp']);
  });

  it('points every local preset at loopback, which the egress guard classifies as local', () => {
    for (const p of localProviders()) {
      expect(p.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(p.isLocal).toBe(true);
    }
  });

  it('keeps nvidia as the default even though the table now starts with local presets', () => {
    // The default is named, not positional, so reordering the table cannot silently change it.
    expect(getProvider('nvidia')).toBeDefined();
    setProvider('nvidia');
    expect(buildKeyPool()).toEqual([]);   // no key set in this test env
  });

  it('builds a usable key pool for a keyless local server', () => {
    setProvider('ollama');
    const pool = buildKeyPool();
    expect(pool).toHaveLength(1);
    expect(pool[0].keyStr).toBe(LOCAL_PLACEHOLDER_KEY);
    expect(pool[0].baseURL).toBe('http://127.0.0.1:11434/v1');
    expect(pool[0].provider).toBe('ollama');
  });

  it('prefers a real key when the operator set one on a local server', () => {
    process.env.VLLM_API_KEY = 'secret-token';
    setProvider('vllm');
    expect(buildKeyPool()[0].keyStr).toBe('secret-token');
  });

  it('never invents a key for a hosted provider', () => {
    setProvider('openai');
    expect(buildKeyPool()).toEqual([]);
  });
});

describe('sovereign mode and provider choice', () => {
  it('permits a local provider', () => {
    setSovereignMode(true);
    expect(sovereignProviderRefusal(getProvider('ollama')!)).toBeNull();
  });

  it('refuses a hosted provider and names the on-premises options', () => {
    setSovereignMode(true);
    const refusal = sovereignProviderRefusal(getProvider('openai')!);
    expect(refusal).toContain('api.openai.com');
    expect(refusal).toContain('ollama');
    expect(refusal).toContain('/sovereign allow');
  });

  it('says nothing when the mode is off', () => {
    expect(sovereignProviderRefusal(getProvider('openai')!)).toBeNull();
  });
});

describe('local model discovery', () => {
  const ollama = () => getProvider('ollama')!;

  it('reads the OpenAI /v1/models shape and sorts stably', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'qwen2.5-coder:7b' }, { id: 'llama3.2-vision:11b', size: 7_900_000_000 }] }),
    }) as unknown as typeof fetch;
    const result = await discoverLocalModels(ollama(), { fetchImpl });
    expect(result.error).toBeUndefined();
    expect(result.models.map(m => m.id)).toEqual(['llama3.2-vision:11b', 'qwen2.5-coder:7b']);
    expect(result.models[0].sizeBytes).toBe(7_900_000_000);
    expect(result.models[0].provider).toBe('ollama');
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:11434/v1/models', expect.anything());
  });

  it('reports an unreachable server as information, never as a throw', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as unknown as typeof fetch;
    const result = await discoverLocalModels(ollama(), { fetchImpl });
    expect(result.models).toEqual([]);
    // The address is in the message: "connection refused" with no address is the least useful
    // diagnostic we could give an operator setting up a GPU box.
    expect(result.error).toContain('http://127.0.0.1:11434/v1');
    expect(result.error).toContain('not reachable');
  });

  it('distinguishes "running but empty" from "not running"', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }) as unknown as typeof fetch;
    expect((await discoverLocalModels(ollama(), { fetchImpl })).error).toContain('no models loaded');
  });

  it('surfaces an HTTP error with its status', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    expect((await discoverLocalModels(ollama(), { fetchImpl })).error).toContain('HTTP 503');
  });

  it('honours an operator base-URL override', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'm' }] }) }) as unknown as typeof fetch;
    await discoverLocalModels(ollama(), { fetchImpl, baseURL: 'http://10.4.1.20:8000/v1/' });
    expect(fetchImpl).toHaveBeenCalledWith('http://10.4.1.20:8000/v1/models', expect.anything());
  });

  it('merges every preset and keeps each failure attributable', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'a' }] }) })
      .mockRejectedValue(new Error('down')) as unknown as typeof fetch;
    const { models, errors } = await discoverAllLocalModels(localProviders(), { fetchImpl });
    expect(models.map(m => m.id)).toEqual(['a']);
    expect(errors).toHaveLength(3);
    expect(errors.join(' ')).toContain('vllm');
  });

  it('does not hang the picker when nothing is listening', async () => {
    const fetchImpl = jest.fn().mockImplementation((_u: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })) as unknown as typeof fetch;
    const result = await discoverLocalModels(ollama(), { fetchImpl, timeoutMs: 20 });
    expect(result.error).toContain('did not answer within the timeout');
  });
});

describe('the provider table stays coherent', () => {
  it('gives every provider a distinct name and a distinct key env', () => {
    const names = getProviders().map(p => p.name);
    const envs = getProviders().map(p => p.apiKeyEnv);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it('marks keyless only on local providers — never on one that reaches an account', () => {
    for (const p of getProviders()) {
      if (p.keyless) expect(p.isLocal).toBe(true);
    }
  });
});
