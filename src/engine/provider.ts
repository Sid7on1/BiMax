import { KeyConfig } from '../credits/api.key.manager';

export interface LlmProvider {
  name: string;
  baseURL: string;
  apiKeyEnv: string;
  defaultModel: string;
  /**
   * Does this provider serve from the operator's own machine or LAN? The distinction is the whole
   * product claim for an air-gapped deployment, so it is a declared property of the provider rather
   * than something inferred from a URL at each call site.
   */
  isLocal?: boolean;
  /**
   * May this provider run with no API key? A local inference server has no account and no key, but
   * the OpenAI SDK refuses to construct without a non-empty string, so a keyless provider is given
   * a placeholder. Never set this on a provider that reaches a real account.
   */
  keyless?: boolean;
  /** Shown in the picker so an operator can tell a local preset from a cloud one at a glance. */
  label?: string;
}

/**
 * The placeholder sent as the bearer token for a keyless local server.
 *
 * Ollama, vLLM and LM Studio all ignore the Authorization header, but the OpenAI SDK throws at
 * construction time on an empty key. This is a syntactic filler, not a credential — there is
 * nothing to leak, and it must never be used for a provider that reaches an account.
 */
export const LOCAL_PLACEHOLDER_KEY = 'local-no-key-required';

const PROVIDERS: LlmProvider[] = [
  // --- On-premises inference servers. First in the list because a sovereign deployment is the
  // point of the product; a cloud provider is the exception a user opts into, not the default
  // shape of the table. Every one of these speaks the OpenAI chat-completions API, which is why
  // the adapter needs no per-provider fork.
  { name: 'ollama', label: 'Ollama (local)', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'OLLAMA_API_KEY', defaultModel: 'qwen2.5-coder:7b', isLocal: true, keyless: true },
  { name: 'vllm', label: 'vLLM (local/LAN)', baseURL: 'http://127.0.0.1:8000/v1', apiKeyEnv: 'VLLM_API_KEY', defaultModel: 'Qwen/Qwen2.5-Coder-7B-Instruct', isLocal: true, keyless: true },
  { name: 'lmstudio', label: 'LM Studio (local)', baseURL: 'http://127.0.0.1:1234/v1', apiKeyEnv: 'LMSTUDIO_API_KEY', defaultModel: 'qwen2.5-coder-7b-instruct', isLocal: true, keyless: true },
  { name: 'llamacpp', label: 'llama.cpp server (local)', baseURL: 'http://127.0.0.1:8080/v1', apiKeyEnv: 'LLAMACPP_API_KEY', defaultModel: 'local-model', isLocal: true, keyless: true },
  // --- Hosted providers.
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
  return configured || process.env.BGW_PROVIDER || DEFAULT_PROVIDER;
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

/** The historical default, named rather than positional so reordering the table cannot change it. */
const DEFAULT_PROVIDER = 'nvidia';

export function getCurrentProvider(): LlmProvider {
  return getProvider(activeProviderName()) || getProvider(DEFAULT_PROVIDER) || PROVIDERS[0];
}

/** The on-premises presets, for the picker and for sovereign-mode refusal messages. */
export function localProviders(): LlmProvider[] {
  return PROVIDERS.filter(p => p.isLocal);
}

/**
 * Why a cloud provider is refused under sovereign mode rather than merely failing.
 *
 * The egress perimeter would refuse the connection anyway, so this is not the enforcement — it is
 * the explanation. Without it an operator who picks OpenAI in air-gap mode gets a refusal at the
 * first token, one turn later, phrased as a network event. Refusing at selection says what is
 * actually wrong and names the presets that would work.
 */
export function sovereignProviderRefusal(provider: LlmProvider): string | null {
  // Required lazily: this module is imported during boot, and provider resolution must never be
  // the thing that throws.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isSovereign } = require('../security/sovereign') as typeof import('../security/sovereign');
  if (!isSovereign() || provider.isLocal) return null;
  const presets = localProviders().map(p => `${p.name} (${p.baseURL})`).join(', ');
  return `Sovereign mode is on, so "${provider.name}" cannot be selected: it serves from `
    + `${new URL(provider.baseURL).host}, which is not on this machine or its local network. `
    + `On-premises options: ${presets}. If your organisation runs an OpenAI-compatible server under `
    + `an ordinary name, select the closest preset and point it there with BGW_BASE_URL, then add `
    + `the host with "/sovereign allow <host>".`;
}

export function setProvider(name: string): LlmProvider | undefined {
  const found = getProvider(name);
  if (found) providerOverride = found.name;
  return found;
}

function keysForProvider(provider: LlmProvider): KeyConfig[] {
  const envVal = process.env[provider.apiKeyEnv];
  // A local server has no account and therefore no key. Returning an empty pool here is what used
  // to make the local path unusable without an undocumented env var: the rotation was empty, so
  // every turn failed before it reached the endpoint that would happily have answered it.
  if (!envVal && provider.keyless) {
    return [{
      keyStr: LOCAL_PLACEHOLDER_KEY,
      model: process.env[`${provider.apiKeyEnv}_MODEL`] || provider.defaultModel,
      baseURL: activeBaseURL(provider),
      provider: provider.name,
      label: `${provider.name} (keyless)`,
    }];
  }
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
    // A keyless local preset must never RESCUE a different provider. It always has a usable pool by
    // construction, so without this guard selecting an unkeyed cloud provider would silently serve
    // the turn from whatever the local server happens to hold — a provider swap the user did not
    // choose, in a different model namespace, reported as a model-not-found error one turn later.
    // A keyless pool is only ever valid for the provider that was actually selected.
    if (provider.keyless && !process.env[provider.apiKeyEnv]) continue;
    const keys = keysForProvider(provider);
    if (keys.length > 0) return keys;
  }
  return [];
}
