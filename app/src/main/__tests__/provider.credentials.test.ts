import { existsSync, readFileSync } from 'node:fs';

const isEncryptionAvailable = jest.fn(() => true);
// Reversible stand-in for Keychain encryption: base64 of "enc:<value>".
const encryptString = jest.fn((value: string) => Buffer.from(`enc:${value}`));
const decryptString = jest.fn((buf: Buffer) => {
  const text = buf.toString();
  return text.startsWith('enc:') ? text.slice(4) : 'secret';
});

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => require('node:path').join(require('node:os').tmpdir(), `bimax-provider-credentials-test-${process.pid}`)) },
  safeStorage: { isEncryptionAvailable, decryptString, encryptString },
}));

jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

describe('provider credential startup', () => {
  beforeEach(() => jest.clearAllMocks());

  test('does not touch Keychain when the remembered provider has no encrypted key', () => {
    (existsSync as jest.Mock).mockReturnValue(true);
    (readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      version: 1,
      activeProvider: 'nvidia',
      encrypted: {},
    }));
    let isolated!: typeof import('../provider.credentials');
    jest.isolateModules(() => { isolated = require('../provider.credentials'); });

    isolated.loadProviderCredentials();

    expect(isEncryptionAvailable).not.toHaveBeenCalled();
    expect(decryptString).not.toHaveBeenCalled();
  });

  test('offers NVIDIA for Kimi K3 and omits the retired StepFun route', () => {
    (existsSync as jest.Mock).mockReturnValue(false);
    let isolated!: typeof import('../provider.credentials');
    jest.isolateModules(() => { isolated = require('../provider.credentials'); });

    const statuses = isolated.providerCredentialStatuses();
    expect(statuses).toContainEqual({
      name: 'nvidia',
      hasKey: false,
      keyCount: 0,
      keyHints: [],
      storage: 'none',
      active: false,
    });
    expect(statuses.map((status) => status.name)).not.toContain('stepfun');
  });
});

describe('provider key pools', () => {
  const realFs = jest.requireActual('node:fs') as typeof import('node:fs');
  let store: typeof import('../provider.credentials');
  const disk = (): string => realFs.readFileSync((globalThis as any).__credFile, 'utf8');

  beforeEach(() => {
    jest.clearAllMocks();
    const dir = require('node:path').join(require('node:os').tmpdir(), `bimax-provider-credentials-test-${process.pid}`);
    realFs.rmSync(dir, { recursive: true, force: true });
    const file = require('node:path').join(dir, 'provider-credentials.v1.json');
    // Reads go to the real temp file, so a save → reload round trip is real; `written` mirrors it.
    Object.defineProperty(globalThis, '__credFile', { value: file, configurable: true });
    (existsSync as jest.Mock).mockImplementation((p: string) => realFs.existsSync(p));
    (readFileSync as jest.Mock).mockImplementation((p: string, enc: any) => realFs.readFileSync(p, enc));
    jest.isolateModules(() => { store = require('../provider.credentials'); });
  });
  afterEach(() => jest.restoreAllMocks());

  const reload = () => {
    let fresh!: typeof import('../provider.credentials');
    jest.isolateModules(() => { fresh = require('../provider.credentials'); });
    return fresh;
  };

  test('adding keys ADDS to the pool, splits a multi-line paste and ignores duplicates', () => {
    store.configureProviderCredential({ name: 'nvidia', apiKey: 'nvapi-first-key-0001' });
    store.configureProviderCredential({ name: 'nvidia', apiKey: 'nvapi-second-key-0002\nnvapi-third-key-0003, nvapi-first-key-0001' });
    const nvidia = store.providerCredentialStatuses().find((s) => s.name === 'nvidia')!;
    expect(nvidia.keyCount).toBe(3);
    expect(nvidia.keyHints).toEqual(['…0001', '…0002', '…0003']);
    expect(store.providerCredentialEnvironment().NVIDIA_API_KEY).toBe('nvapi-first-key-0001,nvapi-second-key-0002,nvapi-third-key-0003');
  });

  test('the pool and the per-minute limit survive a restart; only ciphertext is on disk', () => {
    store.configureProviderCredential({ name: 'openrouter', apiKey: 'sk-or-aaaaaaaaaaaa\nsk-or-bbbbbbbbbbbb', rpm: 20 });
    expect(disk()).not.toContain('sk-or-aaaaaaaaaaaa');
    expect(disk()).toContain('"rpm"');
    const fresh = reload();
    const env = fresh.providerCredentialEnvironment();
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-aaaaaaaaaaaa,sk-or-bbbbbbbbbbbb');
    expect(env.OPENROUTER_API_KEY_RPM).toBe('20');
    expect(env.BIMAX_DESKTOP_PROVIDER).toBe('openrouter');
  });

  test('removing one key leaves the others, and removing the last clears the provider', () => {
    store.configureProviderCredential({ name: 'anthropic', apiKey: 'sk-ant-key-one-1111\nsk-ant-key-two-2222' });
    store.removeProviderKey({ name: 'anthropic', index: 0 });
    expect(store.providerCredentialEnvironment().ANTHROPIC_API_KEY).toBe('sk-ant-key-two-2222');
    store.removeProviderKey({ name: 'anthropic', index: 0 });
    expect(store.providerCredentialEnvironment().ANTHROPIC_API_KEY).toBeUndefined();
    expect(() => store.removeProviderKey({ name: 'anthropic', index: 0 })).toThrow(/no longer saved/);
  });

  test('adding a key keeps the custom endpoint; switching provider drops it', () => {
    store.configureProviderCredential({ name: 'openai', apiKey: 'sk-first-aaaaaaaa', baseURL: 'https://proxy.example.com/v1' });
    store.configureProviderCredential({ name: 'openai', apiKey: 'sk-second-bbbbbbbb' });
    expect(store.providerCredentialEnvironment().BIMAX_DESKTOP_PROVIDER_BASE_URL).toBe('https://proxy.example.com/v1');
    store.configureProviderCredential({ name: 'anthropic', apiKey: 'sk-ant-cccccccc' });
    expect(store.providerCredentialEnvironment().BIMAX_DESKTOP_PROVIDER_BASE_URL).toBeUndefined();
  });

  test('removes exactly the key it was asked to remove', () => {
    store.configureProviderCredential({ name: 'deepseek', apiKey: 'ds-key-aaaaaaaa\nds-key-bbbbbbbb\nds-key-cccccccc' });
    store.removeProviderKey({ name: 'deepseek', index: 1 });
    expect(store.providerCredentialEnvironment().DEEPSEEK_API_KEY).toBe('ds-key-aaaaaaaa,ds-key-cccccccc');
  });

  test('a store written before key pools (one string per provider) still loads', () => {
    realFs.mkdirSync(require('node:path').dirname((globalThis as any).__credFile), { recursive: true });
    realFs.writeFileSync((globalThis as any).__credFile, JSON.stringify({ version: 1, activeProvider: 'nvidia', encrypted: { nvidia: Buffer.from('enc:nvapi-legacy-single-key').toString('base64') } }));
    const fresh = reload();
    expect(fresh.providerCredentialEnvironment().NVIDIA_API_KEY).toBe('nvapi-legacy-single-key');
    expect(fresh.providerCredentialStatuses().find((s) => s.name === 'nvidia')!.keyCount).toBe(1);
  });

  test('every provider can be given keys and selected — not only NVIDIA', () => {
    for (const name of ['openai', 'anthropic', 'openrouter', 'deepseek', 'google']) {
      store.configureProviderCredential({ name, apiKey: `${name}-key-abcdefgh` });
      expect(store.providerCredentialEnvironment().BIMAX_DESKTOP_PROVIDER).toBe(name);
    }
  });

  test('refuses a bad per-minute limit, a short key, and more than the pool can hold', () => {
    expect(() => store.configureProviderCredential({ name: 'nvidia', rpm: -1 })).toThrow(/whole number/);
    expect(() => store.configureProviderCredential({ name: 'nvidia', rpm: 1.5 })).toThrow(/whole number/);
    expect(() => store.configureProviderCredential({ name: 'nvidia', apiKey: 'short' })).toThrow(/length/);
    const many = Array.from({ length: store.MAX_KEYS_PER_PROVIDER + 1 }, (_, i) => `nvapi-key-number-${i}`).join('\n');
    expect(() => store.configureProviderCredential({ name: 'nvidia', apiKey: many })).toThrow(/at most/);
  });
});
