import type { CatalogModelEntry, CatalogResultMsg, ProviderEntry } from './protocol';

/**
 * The provider + model catalogue behind protocol `catalogGet` / `providerSet`.
 *
 * Why this exists as a wire message rather than a static list in the front-end: a model id is only
 * meaningful against a provider. The curated catalogue in cli/models.ts is a *recommendation*,
 * while the provider's `/models` endpoint is what will actually be accepted, and the two disagree
 * constantly (NVIDIA lists ids it then 404s; a rotated catalogue silently orphans a saved pin).
 * A picker built from either one alone is wrong in a way the user cannot see, so both cross the
 * wire and the front-end shows the difference.
 *
 * Credential rule, enforced here rather than trusted to callers: a key value NEVER leaves this
 * module. `hasKey`, `keyCount`, and a 4-character display tail are the only things reported.
 */

/** The engine seams this needs. Structural so tests can drive it without a container. */
export interface CatalogDeps {
  getProviders: () => Array<{ name: string; baseURL: string; apiKeyEnv: string; defaultModel: string }>;
  /** The provider currently in use. */
  activeProvider: () => { name: string };
  /** Curated recommendations. */
  catalog: () => Array<{
    label: string;
    value: string;
    desc: string;
    tier: 'coding' | 'vision' | 'lite' | 'other';
    avoidAutoSelect?: boolean;
    recommendedFor?: Array<'coding' | 'vision' | 'lite'>;
    tags?: string[];
    parameters?: string;
    releaseDate?: string;
  }>;
  /** Ids the ACTIVE provider currently serves. Rejects/throws when offline or unkeyed. */
  listServed: (refresh: boolean) => Promise<string[]>;
  /** Resolved capabilities for one model id. */
  capabilities: (provider: string | null, id: string) => Record<string, any>;
  /** Raw value of an environment variable — read only, never reported. */
  readEnv: (name: string) => string | undefined;
}

const PROVIDER_LABEL: Record<string, string> = {
  nvidia: 'NVIDIA NIM',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  google: 'Google AI',
};

/**
 * Describe one provider's credential state WITHOUT disclosing it.
 *
 * A key may be a comma-separated rotation, so the count is reported too — "1 key" vs "3 keys" is
 * the difference between a rate limit being fatal and being routine, and the user cannot otherwise
 * tell what the engine loaded.
 */
function describeKeys(raw: string | undefined): { hasKey: boolean; keyCount: number; keyHint?: string } {
  const keys = String(raw || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (keys.length === 0) return { hasKey: false, keyCount: 0 };
  const last = keys[keys.length - 1];
  // A 4-character tail identifies a key to the person who owns it and to nobody else. Short keys
  // get no hint at all rather than a hint that is most of the secret.
  const keyHint = last.length >= 12 ? `…${last.slice(-4)}` : undefined;
  return { hasKey: true, keyCount: keys.length, keyHint };
}

export function buildProviderEntries(deps: CatalogDeps): ProviderEntry[] {
  const active = deps.activeProvider().name;
  return deps.getProviders().map((provider) => ({
    name: provider.name,
    label: PROVIDER_LABEL[provider.name] || provider.name,
    baseURL: provider.baseURL,
    apiKeyEnv: provider.apiKeyEnv,
    active: provider.name === active,
    ...describeKeys(deps.readEnv(provider.apiKeyEnv)),
  }));
}

/**
 * Join the curated catalogue with what the provider actually serves.
 *
 * Both directions of the mismatch are preserved deliberately:
 *   - curated but NOT served → kept, `served: false`. Hiding it is what makes a stale pin
 *     undiagnosable: the user's configured model would simply vanish from the picker with no
 *     explanation, which is precisely the "I can't find my model" report.
 *   - served but NOT curated → appended, `curated: false`. These are real, selectable ids we have
 *     no measurement for; the front-end presents them as unvetted rather than recommended.
 */
export function buildModelEntries(
  deps: CatalogDeps,
  servedIds: string[],
  provider: string | null,
): CatalogModelEntry[] {
  const served = new Set(servedIds);
  const curated = deps.catalog();
  const seen = new Set<string>();

  const capabilitiesFor = (id: string): CatalogModelEntry['capabilities'] => {
    try {
      const caps = deps.capabilities(provider, id) || {};
      return {
        visionInput: !!caps.visionInput,
        reasoningEffortKnob: !!caps.reasoningEffortKnob,
        thinking: !!(caps.nativeThinking || caps.inlineReasoning || caps.openerlessReasoning),
        structuredOutputs: !!caps.structuredOutputs,
        parallelToolCalls: !!caps.parallelToolCalls,
        contextWindow: Number(caps.contextWindow) || 0,
      };
    } catch {
      return undefined;
    }
  };

  const rows: CatalogModelEntry[] = curated.map((entry) => {
    seen.add(entry.value);
    return {
      id: entry.value,
      label: entry.label,
      desc: entry.desc,
      tier: entry.tier,
      ...(entry.recommendedFor ? { recommendedFor: entry.recommendedFor } : {}),
      ...(entry.tags ? { tags: entry.tags } : {}),
      ...(entry.parameters ? { parameters: entry.parameters } : {}),
      ...(entry.releaseDate ? { releaseDate: entry.releaseDate } : {}),
      // With no live list at all (offline / no key), "not served" would be a lie about every model.
      // Report served:false only when we genuinely have a list to have been absent from.
      served: served.size === 0 ? false : served.has(entry.value),
      curated: true,
      ...(entry.avoidAutoSelect ? { avoidAutoSelect: true } : {}),
      capabilities: capabilitiesFor(entry.value),
    };
  });

  for (const id of servedIds) {
    if (seen.has(id)) continue;
    rows.push({
      id,
      label: id,
      desc: 'Served by this provider — not measured by us',
      tier: 'other',
      served: true,
      curated: false,
      capabilities: capabilitiesFor(id),
    });
  }

  return rows;
}

/** Assemble one `catalogResult`. Never throws: a failed model fetch becomes `error`, not a hang. */
export async function buildCatalog(deps: CatalogDeps, id: number, refresh = false): Promise<CatalogResultMsg> {
  const providers = buildProviderEntries(deps);
  const active = deps.activeProvider().name;

  let servedIds: string[] = [];
  let error: string | undefined;
  try {
    servedIds = (await deps.listServed(refresh)) || [];
    if (servedIds.length === 0) {
      const hasKey = providers.find((p) => p.active)?.hasKey;
      error = hasKey
        ? 'This provider returned no model list. The curated models below are unverified against it.'
        : 'No API key is set for this provider, so its model list could not be read.';
    }
  } catch (e: any) {
    error = String(e?.message || e || 'The provider’s model list could not be read.');
  }

  return {
    t: 'catalogResult',
    id,
    providers,
    models: buildModelEntries(deps, servedIds, active),
    ...(error ? { error } : {}),
  };
}
