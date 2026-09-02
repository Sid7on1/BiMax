import { app, safeStorage } from 'electron';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Provider credentials owned by Bimax for Mac.
 *
 * Only ciphertext is written to Application Support. On macOS Electron's safeStorage key is held
 * by Keychain, so a renderer compromise cannot read a plaintext secrets file and the key never
 * crosses the engine's NDJSON protocol. The decrypted values live only in main-process memory and
 * are copied into a newly spawned engine's environment.
 */

const PROVIDER_ENV: Record<string, string> = {
  nvidia: 'NVIDIA_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GOOGLE_API_KEY',
};

interface StoredProviderCredentials {
  version: 1;
  activeProvider?: string;
  baseURL?: string;
  encrypted: Record<string, string>;
}

export interface ProviderCredentialStatus {
  name: string;
  hasKey: boolean;
  keyHint?: string;
  storage: 'keychain' | 'none';
  active: boolean;
}

let loaded = false;
let activeProvider = '';
let activeBaseURL = '';
const keys = new Map<string, string>();

function storePath(): string {
  return path.join(app.getPath('userData'), 'provider-credentials.v1.json');
}

function assertProvider(name: string): string {
  const normalized = String(name || '').trim().toLowerCase();
  if (!PROVIDER_ENV[normalized]) throw new Error(`Unsupported provider "${name}".`);
  return normalized;
}

function keyHint(value: string): string | undefined {
  return value.length >= 12 ? `…${value.slice(-4)}` : undefined;
}

/** Load once after Electron is ready. A corrupt/unreadable store fails closed with no secrets. */
export function loadProviderCredentials(): void {
  if (loaded) return;
  loaded = true;
  const file = storePath();
  if (!existsSync(file)) return;
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredProviderCredentials;
    if (stored.version !== 1 || !stored.encrypted || typeof stored.encrypted !== 'object') return;
    activeProvider = PROVIDER_ENV[String(stored.activeProvider || '')] ? String(stored.activeProvider) : '';
    activeBaseURL = typeof stored.baseURL === 'string' ? stored.baseURL : '';
    const encrypted = Object.entries(stored.encrypted)
      .filter(([name, encoded]) => !!PROVIDER_ENV[name] && typeof encoded === 'string');
    // An empty store still remembers the selected provider, but has nothing to decrypt. Calling
    // safeStorage.isEncryptionAvailable() here asks Keychain for Electron's storage key anyway.
    // After an ad-hoc local update macOS can block that lookup behind an authorization exchange
    // before Bimax has created a window, which looks exactly like an app that never launched.
    // Avoid Keychain entirely until ciphertext actually exists.
    if (encrypted.length === 0) return;
    if (!safeStorage.isEncryptionAvailable()) return;
    for (const [name, encoded] of encrypted) {
      if (!PROVIDER_ENV[name] || typeof encoded !== 'string') continue;
      const value = safeStorage.decryptString(Buffer.from(encoded, 'base64')).trim();
      if (value) keys.set(name, value);
    }
  } catch {
    keys.clear();
    activeProvider = '';
    activeBaseURL = '';
  }
}

function persist(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('macOS Keychain is unavailable. Bimax did not save the API key.');
  }
  const file = storePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { chmodSync(path.dirname(file), 0o700); } catch { /* best effort on non-POSIX volumes */ }
  const encrypted: Record<string, string> = {};
  for (const [name, value] of keys) {
    encrypted[name] = safeStorage.encryptString(value).toString('base64');
  }
  const payload: StoredProviderCredentials = {
    version: 1,
    ...(activeProvider ? { activeProvider } : {}),
    ...(activeBaseURL ? { baseURL: activeBaseURL } : {}),
    encrypted,
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
  renameSync(tmp, file);
}

export function configureProviderCredential(input: { name: string; apiKey?: string; baseURL?: string }): void {
  loadProviderCredentials();
  const name = assertProvider(input.name);
  const apiKey = String(input.apiKey || '').trim();
  const baseURL = String(input.baseURL || '').trim();
  if (apiKey && (apiKey.length < 8 || apiKey.length > 8192)) throw new Error('The API key length is invalid.');
  if (baseURL && !/^https:\/\/[^\s]+$/i.test(baseURL)) throw new Error('Custom provider endpoints must use HTTPS.');
  if (apiKey) keys.set(name, apiKey);
  activeProvider = name;
  activeBaseURL = baseURL;
  persist();
}

/** Decrypted only at the engine spawn boundary; never returned through IPC. */
export function providerCredentialEnvironment(): Record<string, string> {
  loadProviderCredentials();
  const env: Record<string, string> = {};
  for (const [name, value] of keys) env[PROVIDER_ENV[name]] = value;
  if (activeProvider) env.BIMAX_DESKTOP_PROVIDER = activeProvider;
  if (activeBaseURL) env.BIMAX_DESKTOP_PROVIDER_BASE_URL = activeBaseURL;
  return env;
}

export function providerCredentialStatuses(): ProviderCredentialStatus[] {
  loadProviderCredentials();
  return Object.keys(PROVIDER_ENV).map((name) => {
    const value = keys.get(name) || '';
    return {
      name,
      hasKey: !!value,
      ...(value ? { keyHint: keyHint(value) } : {}),
      storage: value ? 'keychain' : 'none',
      active: name === activeProvider,
    };
  });
}
