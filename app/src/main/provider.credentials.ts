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
 *
 * A provider may hold SEVERAL keys. The engine rotates them as one pool (hybrid round robin,
 * `src/credits/api.key.manager.ts`), which is how a low per-key rate limit stops being fatal. They
 * reach the engine as the comma-separated `<PROVIDER>_API_KEY` the engine has always accepted, with
 * the provider's per-key requests-per-minute limit beside it as `<PROVIDER>_API_KEY_RPM`.
 */

const PROVIDER_ENV: Record<string, string> = {
  nvidia: 'NVIDIA_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GOOGLE_API_KEY',
};

/** More keys than this is a paste gone wrong, not a pool. */
export const MAX_KEYS_PER_PROVIDER = 32;
/** The largest per-key limit anyone will type; beyond it pacing is meaningless. */
const MAX_RPM = 100_000;

interface StoredProviderCredentials {
  version: 1;
  activeProvider?: string;
  baseURL?: string;
  /** One ciphertext per key. A plain string is the single-key form written before key pools. */
  encrypted: Record<string, string | string[]>;
  /** Per-provider requests-per-minute limit for EACH key; absent = the engine's default. */
  rpm?: Record<string, number>;
}

export interface ProviderCredentialStatus {
  name: string;
  hasKey: boolean;
  /** Number of keys in this provider's pool. */
  keyCount: number;
  /** Last four characters of each key, in pool order, for telling them apart. */
  keyHints: string[];
  /** The last key's hint — kept for callers written before key pools. */
  keyHint?: string;
  /** The saved per-key limit, when the person set one. */
  rpm?: number;
  storage: 'keychain' | 'none';
  active: boolean;
}

let loaded = false;
let activeProvider = '';
let activeBaseURL = '';
const keys = new Map<string, string[]>();
const rpmLimits = new Map<string, number>();

function storePath(): string {
  return path.join(app.getPath('userData'), 'provider-credentials.v1.json');
}

function assertProvider(name: string): string {
  const normalized = String(name || '').trim().toLowerCase();
  if (!PROVIDER_ENV[normalized]) throw new Error(`Unsupported provider "${name}".`);
  return normalized;
}

function keyHint(value: string): string {
  return value.length >= 12 ? `…${value.slice(-4)}` : '…';
}

/**
 * Split a paste into keys. People paste one key, or several separated by newlines, commas or
 * spaces; a key itself never contains any of those (and the engine splits on commas).
 */
export function splitKeys(raw: string): string[] {
  return String(raw || '').split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);
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
    if (stored.rpm && typeof stored.rpm === 'object') {
      for (const [name, value] of Object.entries(stored.rpm)) {
        if (PROVIDER_ENV[name] && Number.isInteger(value) && value >= 0 && value <= MAX_RPM) rpmLimits.set(name, value);
      }
    }
    const encrypted = Object.entries(stored.encrypted)
      .map(([name, value]) => [name, (Array.isArray(value) ? value : [value]).filter((v) => typeof v === 'string')] as const)
      .filter(([name, values]) => !!PROVIDER_ENV[name] && values.length > 0);
    // An empty store still remembers the selected provider, but has nothing to decrypt. Calling
    // safeStorage.isEncryptionAvailable() here asks Keychain for Electron's storage key anyway.
    // After an ad-hoc local update macOS can block that lookup behind an authorization exchange
    // before Bimax has created a window, which looks exactly like an app that never launched.
    // Avoid Keychain entirely until ciphertext actually exists.
    if (encrypted.length === 0) return;
    if (!safeStorage.isEncryptionAvailable()) return;
    for (const [name, values] of encrypted) {
      const decrypted = values
        .map((encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64')).trim())
        .filter(Boolean);
      if (decrypted.length) keys.set(name, [...new Set(decrypted)].slice(0, MAX_KEYS_PER_PROVIDER));
    }
  } catch {
    keys.clear();
    rpmLimits.clear();
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
  const encrypted: Record<string, string[]> = {};
  for (const [name, values] of keys) {
    encrypted[name] = values.map((value) => safeStorage.encryptString(value).toString('base64'));
  }
  const payload: StoredProviderCredentials = {
    version: 1,
    ...(activeProvider ? { activeProvider } : {}),
    ...(activeBaseURL ? { baseURL: activeBaseURL } : {}),
    encrypted,
    ...(rpmLimits.size ? { rpm: Object.fromEntries(rpmLimits) } : {}),
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
  renameSync(tmp, file);
}

/**
 * Select a provider and optionally ADD keys to its pool (never replaces the keys already saved),
 * set its custom endpoint, and set its per-key requests-per-minute limit (0 = no limit).
 */
export function configureProviderCredential(input: { name: string; apiKey?: string; baseURL?: string; rpm?: number }): void {
  loadProviderCredentials();
  const name = assertProvider(input.name);
  const added = splitKeys(String(input.apiKey || ''));
  const baseURL = String(input.baseURL || '').trim();
  for (const key of added) {
    if (key.length < 8 || key.length > 8192) throw new Error('An API key length is invalid.');
  }
  if (baseURL && !/^https:\/\/[^\s]+$/i.test(baseURL)) throw new Error('Custom provider endpoints must use HTTPS.');
  if (input.rpm !== undefined && !(Number.isInteger(input.rpm) && input.rpm >= 0 && input.rpm <= MAX_RPM)) {
    throw new Error(`Requests per minute must be a whole number from 0 to ${MAX_RPM}.`);
  }
  if (added.length) {
    const pool = [...new Set([...(keys.get(name) ?? []), ...added])];
    if (pool.length > MAX_KEYS_PER_PROVIDER) throw new Error(`A provider can hold at most ${MAX_KEYS_PER_PROVIDER} keys.`);
    keys.set(name, pool);
  }
  if (input.rpm !== undefined) rpmLimits.set(name, input.rpm);
  // A custom endpoint belongs to one provider. Adding a key or changing the limit must not erase
  // the endpoint already set for it; switching provider (or sending an endpoint) replaces it.
  if (input.baseURL !== undefined || name !== activeProvider) activeBaseURL = baseURL;
  activeProvider = name;
  persist();
}

/** Remove one key from a provider's pool by its position in `keyHints`. */
export function removeProviderKey(input: { name: string; index: number }): void {
  loadProviderCredentials();
  const name = assertProvider(input.name);
  const pool = keys.get(name) ?? [];
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= pool.length) {
    throw new Error('That key is no longer saved.');
  }
  const next = pool.filter((_, i) => i !== input.index);
  if (next.length) keys.set(name, next);
  else keys.delete(name);
  persist();
}

/** Decrypted only at the engine spawn boundary; never returned through IPC. */
export function providerCredentialEnvironment(): Record<string, string> {
  loadProviderCredentials();
  const env: Record<string, string> = {};
  for (const [name, values] of keys) env[PROVIDER_ENV[name]] = values.join(',');
  for (const [name, rpm] of rpmLimits) env[`${PROVIDER_ENV[name]}_RPM`] = String(rpm);
  if (activeProvider) env.BIMAX_DESKTOP_PROVIDER = activeProvider;
  if (activeBaseURL) env.BIMAX_DESKTOP_PROVIDER_BASE_URL = activeBaseURL;
  return env;
}

export function providerCredentialStatuses(): ProviderCredentialStatus[] {
  loadProviderCredentials();
  return Object.keys(PROVIDER_ENV).map((name) => {
    const pool = keys.get(name) ?? [];
    const hints = pool.map(keyHint);
    return {
      name,
      hasKey: pool.length > 0,
      keyCount: pool.length,
      keyHints: hints,
      ...(hints.length ? { keyHint: hints[hints.length - 1] } : {}),
      ...(rpmLimits.has(name) ? { rpm: rpmLimits.get(name)! } : {}),
      storage: pool.length ? 'keychain' : 'none',
      active: name === activeProvider,
    };
  });
}
