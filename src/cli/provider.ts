import { KeyConfig } from '../credits/api.key.manager';

export interface LlmProvider {
  name: string;
  baseURL: string;
  apiKeyEnv: string;
  defaultModel: string;
}

const PROVIDERS: LlmProvider[] = [
  { name: 'nvidia', baseURL: 'https://integrate.api.nvidia.com/v1', apiKeyEnv: 'NVIDIA_API_KEY', defaultModel: 'moonshotai/kimi-k3' },
  { name: 'openai', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-4o' },
  { name: 'anthropic', baseURL: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-3-opus-20240229' },
  { name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', defaultModel: 'openai/gpt-4o' },
  { name: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat' },
  { name: 'google', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GOOGLE_API_KEY', defaultModel: 'gemini-2.0-flash' },
];

// Runtime override set by the /provider command; null means "fall through". Resolved lazily
// (not captured at module load) so the env var is read AFTER env files are loaded — otherwise import
// hoisting could snapshot it before loadGlobalEnv() runs and silently fall back to 'nvidia'.
let providerOverride: string | null = null;

/**
 * Precedence: a runtime `/provider` override, then the PERSISTED choice, then the env var, then
 * nvidia.
 *
 * The config read is why a provider picked in the UI survives a restart. Before it, this function
 * consulted only `providerOverride` and `BGW_PROVIDER`, so the choice lived in a module variable
 * that died with the process — the user picked a provider, it worked for that session, and every
 * later launch silently went back to nvidia while the settings screen still displayed their pick.
 *
 * Config is read lazily and defensively: this module is imported during startup, before
 * `loadConfig()` has necessarily run, and provider resolution must never be the thing that throws.
 */
function activeProviderName(): string {
  // Bimax for Mac owns Keychain-backed provider setup. Its launch-time override is intentionally
  // first: a stale Terminal config must not make Desktop send a Keychain credential to a different
  // provider namespace. Terminal never sets this variable.
  if (process.env.BIMAX_DESKTOP_PROVIDER) return process.env.BIMAX_DESKTOP_PROVIDER;
  if (providerOverride) return providerOverride;
  let configured = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    configured = String((require('./config') as typeof import('./config')).getConfig().provider || '').trim();
  } catch { /* config not loaded yet — env/default below still answers */ }
  return configured || process.env.BGW_PROVIDER || 'nvidia';
}

/** The endpoint the active provider should use, honouring a configured/env override. */
function activeBaseURL(provider: LlmProvider): string {
  if (process.env.BIMAX_DESKTOP_PROVIDER_BASE_URL) return process.env.BIMAX_DESKTOP_PROVIDER_BASE_URL;
  if (process.env.BGW_BASE_URL) return process.env.BGW_BASE_URL;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const configured = String((require('./config') as typeof import('./config')).getConfig().providerBaseURL || '').trim();
    // Only honour an override for the provider it was saved against; carrying a custom endpoint
    // across a provider switch points one provider's model namespace at another's server.
    if (configured && activeProviderName() === provider.name) return configured;
  } catch { /* config not loaded yet */ }
  return provider.baseURL;
}

export function getProviders(): LlmProvider[] {
  return [...PROVIDERS];
}

export function getProvider(name: string): LlmProvider | undefined {
  return PROVIDERS.find(p => p.name === name);
}

export function getCurrentProvider(): LlmProvider {
  return getProvider(activeProviderName()) || PROVIDERS[0];
}

export function setProvider(name: string): LlmProvider | undefined {
  const found = getProvider(name);
  if (found) providerOverride = found.name;
  return found;
}

function keysForProvider(provider: LlmProvider): KeyConfig[] {
  const envVal = process.env[provider.apiKeyEnv];
  if (!envVal) return [];
  return envVal.split(',').map(k => k.trim()).filter(Boolean).map((keyStr, i) => ({
    keyStr,
    model: process.env[`${provider.apiKeyEnv}_MODEL_${i + 1}`] || process.env[`${provider.apiKeyEnv}_MODEL`] || provider.defaultModel,
    // Escape hatch for local models, proxies, and test harnesses: point the ACTIVE provider's
    // OpenAI-compatible endpoint elsewhere without editing the provider table.
    baseURL: activeBaseURL(provider),
    provider: provider.name,
    label: `${provider.name} #${i + 1}`,
  }));
}

/**
 * Build the key rotation for the ACTIVE provider only (BGW_PROVIDER / the /provider command).
 *
 * Previously this pooled every provider that had a key into one rotation. That is broken with model
 * selection: a single chosen model id lives in one provider's namespace, so when a turn rotated to a
 * different provider's key it 400'd ("model not found") — the intermittent-400 bug. Keys stay
 * single-provider so the model namespace is consistent; switch providers with /provider. Falls back
 * to the first provider that has a key, so a misconfigured active provider never empties the pool.
 */
export function buildKeyPool(): KeyConfig[] {
  const active = keysForProvider(getCurrentProvider());
  if (active.length > 0) return active;
  // Bimax for Mac pins one exact model family and maps its wire id to the selected provider. If
  // that provider has no key, borrowing a key from another namespace sends (for example)
  // one provider's exact model id to a different namespace. That does not recover
  // the turn; it leaks the request to a provider the user did not select and produces a misleading
  // model-not-found error. Desktop therefore fails closed until the selected provider has a key.
  if (String(process.env.BIMAX_DESKTOP_STRICT_MODEL || '').trim()) return [];
  for (const provider of PROVIDERS) {
    const keys = keysForProvider(provider);
    if (keys.length > 0) return keys;
  }
  return [];
}
