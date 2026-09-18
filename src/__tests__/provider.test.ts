// Guards the model-400 root-cause fix: the key pool must be single-provider (the active one), the
// active provider must be read from BGW_PROVIDER lazily, and /provider (setProvider) must override.
const KEY_VARS = [
  'NVIDIA_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY',
  'BGW_PROVIDER', 'BIMAX_DESKTOP_STRICT_MODEL',
];

function freshProvider(env: Record<string, string | undefined>) {
  jest.resetModules();
  for (const k of KEY_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  return require('../engine/provider');
}

afterEach(() => { for (const k of KEY_VARS) delete process.env[k]; });

describe('buildKeyPool — single active provider', () => {
  it('pools only the active provider, even when other providers also have keys', () => {
    const { buildKeyPool } = freshProvider({
      NVIDIA_API_KEY: 'nv1,nv2',
      OPENROUTER_API_KEY: 'or1',
      BGW_PROVIDER: 'openrouter',
    });
    const pool = buildKeyPool();
    expect(pool).toHaveLength(1);
    expect(pool.every((k: any) => k.provider === 'openrouter')).toBe(true);
    expect(pool[0].baseURL).toContain('openrouter');
  });

  it('includes every comma-separated key for the active provider', () => {
    const { buildKeyPool } = freshProvider({ NVIDIA_API_KEY: 'a,b,c', BGW_PROVIDER: 'nvidia' });
    expect(buildKeyPool()).toHaveLength(3);
  });

  it('falls back to a provider that has a key when the active one has none', () => {
    // Active = openrouter, but only an NVIDIA key exists → never return an empty pool.
    const { buildKeyPool } = freshProvider({ NVIDIA_API_KEY: 'nv1', BGW_PROVIDER: 'openrouter' });
    const pool = buildKeyPool();
    expect(pool).toHaveLength(1);
    expect(pool[0].provider).toBe('nvidia');
  });

  it('returns an empty pool when no provider has a key', () => {
    const { buildKeyPool } = freshProvider({ BGW_PROVIDER: 'nvidia' });
    expect(buildKeyPool()).toHaveLength(0);
  });

  it('uses Kimi K3 as the NVIDIA provider default', () => {
    const { buildKeyPool } = freshProvider({ NVIDIA_API_KEY: 'nv-secret', BGW_PROVIDER: 'nvidia' });
    expect(buildKeyPool()).toEqual([expect.objectContaining({
      keyStr: 'nv-secret',
      provider: 'nvidia',
      model: 'moonshotai/kimi-k3',
    })]);
  });

  it('never borrows another provider key for a strict desktop model', () => {
    const { buildKeyPool } = freshProvider({
      NVIDIA_API_KEY: 'nv1',
      BGW_PROVIDER: 'openrouter',
      BIMAX_DESKTOP_STRICT_MODEL: 'moonshotai/kimi-k3',
    });
    expect(buildKeyPool()).toEqual([]);
  });
});

describe('active provider resolution', () => {
  it('reads BGW_PROVIDER lazily (defaults to nvidia when unset)', () => {
    const { getCurrentProvider } = freshProvider({});
    expect(getCurrentProvider().name).toBe('nvidia');
  });

  it('honors BGW_PROVIDER', () => {
    const { getCurrentProvider } = freshProvider({ BGW_PROVIDER: 'openrouter' });
    expect(getCurrentProvider().name).toBe('openrouter');
  });

  it('lets setProvider (/provider) override the env', () => {
    const p = freshProvider({ BGW_PROVIDER: 'nvidia' });
    p.setProvider('openrouter');
    expect(p.getCurrentProvider().name).toBe('openrouter');
  });
});
