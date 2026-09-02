// Curated model catalog for the /model picker. IDs follow the NVIDIA NIM `publisher/model` convention
// (the default provider). If your provider names a model differently, use the "Custom model id…" entry.
// `tier` groups them for the picker: 'coding' = strong agentic/coding models, 'lite' = fast/cheap ones.

import { capabilitiesFor } from '../core/capabilities';

export interface ModelEntry {
  label: string;
  value: string;
  desc: string;
  tier: 'coding' | 'vision' | 'lite' | 'other';
  /** Slots where this model is a recommendation. One model may intentionally serve several. */
  recommendedFor?: Array<'coding' | 'vision' | 'lite'>;
  /** Compact, source-backed product metadata shown in the graphical picker. */
  tags?: string[];
  parameters?: string;
  /** ISO release date. Omitted when NVIDIA/publisher metadata is not trustworthy enough. */
  releaseDate?: string;
  /**
   * Never pick this model AUTOMATICALLY (self-healing a stale pin). The user can still choose it
   * explicitly from the picker — this only bars the machine from choosing it on their behalf.
   * Set on every entry whose own description records a disqualifying behaviour: times out, needs a
   * long cold start, or cannot call tools. Auto-selecting one of those trades a visibly broken
   * model for an invisibly hanging one, which is a worse failure because it looks like a freeze.
   */
  avoidAutoSelect?: boolean;
}

// Recommendations combine the authenticated NVIDIA `/models` inventory with explicit evidence.
// Presence in `/models` means selectable, not qualified: current but unmeasured candidates remain
// opt-in (`avoidAutoSelect`), and the picker still appends every other live provider id as unvetted.
// The 2026-08-29 refresh removed every retired/unserved static NVIDIA id and made the owner-selected
// Kimi K3 route the Work/Vision default. See `npm run benchmark:models` for task-shaped probes.
export const MODEL_CATALOG: ModelEntry[] = [
  // The live `/models` endpoint supplies availability only. These rows supply the slot membership,
  // ordering and metadata NVIDIA's hosted endpoint does not return. One unique row can recommend a
  // model in several slots; Browse all still appends every other live id as unvetted.
  {
    label: 'Kimi K3',
    value: 'moonshotai/kimi-k3',
    tier: 'coding',
    recommendedFor: ['coding', 'vision'],
    desc: 'Default Work and Vision route · native multimodal agent with tools and 1M context; Bimax latency revalidation pending',
    tags: ['coding', 'agentic', 'vision', 'tools', 'reasoning'],
    parameters: '2.8T · 104B active',
    releaseDate: '2026-08-20',
  },
  {
    label: 'Mistral 7B Instruct',
    value: 'mistralai/mistral-7b-instruct-v0.3',
    tier: 'lite',
    recommendedFor: ['lite'],
    desc: 'Default Quick route · compact plain instruct model for short replies',
    tags: ['quick', 'instruct', 'plain'],
    parameters: '7B',
    releaseDate: '2024-05-22',
  },
  {
    label: 'Muse Glimmer 30B',
    value: 'meta/muse-glimmer-30b',
    tier: 'vision',
    recommendedFor: ['vision', 'coding'],
    desc: 'Native image input, reasoning and tool calls for multimodal agent work; Bimax task probe pending',
    tags: ['vision', 'agentic', 'tools', 'reasoning'],
    parameters: '29.6B',
    releaseDate: '2026-08-10',
    avoidAutoSelect: true,
  },
  {
    label: 'Gemma 3 4B Instruct',
    value: 'google/gemma-3-4b-it',
    tier: 'lite',
    recommendedFor: ['lite'],
    desc: 'Small instruction model suited to brief low-cost replies; Bimax latency probe pending',
    tags: ['quick', 'instruct', 'small'],
    parameters: '4B',
    releaseDate: '2025-03-12',
    avoidAutoSelect: true,
  },
  {
    label: 'Nemotron 3.5 Lightning',
    value: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    tier: 'coding',
    recommendedFor: ['coding'],
    desc: 'Fast 3B-active long-running agent model with 1M context; Bimax task probe pending',
    tags: ['coding', 'agentic', 'reasoning', 'tools'],
    parameters: '30B · 3B active',
    releaseDate: '2026-08-11',
    avoidAutoSelect: true,
  },
  {
    label: 'Granite 3.0 3B A800M',
    value: 'ibm/granite-3.0-3b-a800m-instruct',
    tier: 'lite',
    recommendedFor: ['lite'],
    desc: 'Compact mixture model for short instruction-following turns; Bimax latency probe pending',
    tags: ['quick', 'instruct', 'small'],
    parameters: '3B · 800M active',
    releaseDate: '2024-10-21',
    avoidAutoSelect: true,
  },
  {
    label: 'Laguna XS 2.1',
    value: 'poolside/laguna-xs-2.1',
    tier: 'coding',
    recommendedFor: ['coding'],
    desc: 'Agentic coding and long-horizon software-engineering model; Bimax route probe pending',
    tags: ['coding', 'agentic', 'tools'],
    parameters: '33B · 3B active',
    releaseDate: '2026-07-15',
    avoidAutoSelect: true,
  },
  {
    label: 'Zamba2 7B Instruct',
    value: 'zyphra/zamba2-7b-instruct',
    tier: 'lite',
    recommendedFor: ['lite'],
    desc: 'Compact hybrid instruct route for short replies; Bimax latency probe pending',
    tags: ['quick', 'instruct', 'small'],
    parameters: '7B',
    avoidAutoSelect: true,
  },
  {
    label: 'Nemotron 3 Ultra',
    value: 'nvidia/nemotron-3-ultra-550b-a55b',
    tier: 'coding',
    recommendedFor: ['coding'],
    desc: 'Frontier Nemotron agent route with 1M context; Bimax task probe pending',
    tags: ['coding', 'frontier', 'agentic', 'reasoning'],
    parameters: '550B · 55B active',
    releaseDate: '2026-06-04',
    avoidAutoSelect: true,
  },
  {
    label: 'Gemma 2B',
    value: 'google/gemma-2b',
    tier: 'lite',
    recommendedFor: ['lite'],
    desc: 'Very small text model for lightweight replies; compatibility probe pending',
    tags: ['quick', 'small'],
    parameters: '2B',
    releaseDate: '2024-02-21',
    avoidAutoSelect: true,
  },
  {
    label: 'Nemotron 3 Nano Omni',
    value: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    tier: 'vision',
    recommendedFor: ['vision', 'coding'],
    desc: 'Fast multimodal reasoner; prior grounded GUI probes chose wrong clicks, so intentional selection only',
    tags: ['vision', 'agentic', 'reasoning'],
    parameters: '30B · 3B active',
    releaseDate: '2026-04-28',
    avoidAutoSelect: true,
  },
  {
    label: 'Minitron 8B Instruct',
    value: 'nvidia/mistral-nemo-minitron-8b-8k-instruct',
    tier: 'lite',
    recommendedFor: ['lite'],
    desc: 'Compressed 8B instruct model for lightweight turns; only 8K context',
    tags: ['quick', 'instruct', 'small'],
    parameters: '8B',
    avoidAutoSelect: true,
  },
  {
    label: 'Nemotron 3 Super',
    value: 'nvidia/nemotron-3-super-120b-a12b',
    tier: 'coding',
    recommendedFor: ['coding'],
    desc: 'Balanced Nemotron agent route with 1M context; Bimax task probe pending',
    tags: ['coding', 'agentic', 'reasoning'],
    parameters: '120B · 12B active',
    avoidAutoSelect: true,
  },
  {
    label: 'DeepSeek Coder 6.7B',
    value: 'deepseek-ai/deepseek-coder-6.7b-instruct',
    tier: 'lite',
    recommendedFor: ['lite'],
    desc: 'Small code-focused instruct model for quick supporting steps; Bimax latency probe pending',
    tags: ['quick', 'coding', 'instruct'],
    parameters: '6.7B',
    releaseDate: '2024-01-08',
    avoidAutoSelect: true,
  },
  {
    label: 'Kimi K2.6',
    value: 'moonshotai/kimi-k2.6',
    tier: 'vision',
    recommendedFor: ['vision', 'coding'],
    desc: 'Multimodal long-horizon agent route; prior Bimax completion probe returned 404, so opt in only',
    tags: ['vision', 'coding', 'agentic', 'reasoning'],
    parameters: '1T',
    releaseDate: '2026-05-01',
    avoidAutoSelect: true,
  },
  {
    label: 'CodeGemma 7B',
    value: 'google/codegemma-7b',
    tier: 'lite',
    recommendedFor: ['lite'],
    desc: 'Compact code model for short code-support turns; Bimax route probe pending',
    tags: ['quick', 'coding'],
    parameters: '7B',
    releaseDate: '2024-04-09',
    avoidAutoSelect: true,
  },
  {
    label: 'Nemotron 3 Nano',
    value: 'nvidia/nemotron-3-nano-30b-a3b',
    tier: 'coding',
    recommendedFor: ['coding'],
    desc: 'Fast text/tool controller; image turns need the Vision slot',
    tags: ['coding', 'agentic', 'tools'],
    parameters: '30B · 3B active',
  },
  {
    label: 'Granite 3.0 8B Instruct',
    value: 'ibm/granite-3.0-8b-instruct',
    tier: 'lite',
    recommendedFor: ['lite'],
    desc: 'Compact general instruct model for quick supporting turns; Bimax latency probe pending',
    tags: ['quick', 'instruct'],
    parameters: '8B',
    releaseDate: '2024-10-21',
    avoidAutoSelect: true,
  },
  {
    label: 'Llama 3.2 90B Vision',
    value: 'meta/llama-3.2-90b-vision-instruct',
    tier: 'vision',
    recommendedFor: ['vision'],
    desc: 'Strong visual reasoning route, but clicked the unproven recipient in the safety trap',
    tags: ['vision', 'visual-grounding'],
    parameters: '90B',
    releaseDate: '2024-09-25',
    avoidAutoSelect: true,
  },
  {
    label: 'DeepSeek V4 Pro 0813',
    value: 'deepseek-ai/deepseek-v4-pro-0813',
    tier: 'coding',
    recommendedFor: ['coding'],
    desc: 'Current 1M-context coding route; Bimax latency and tool probe pending',
    tags: ['coding', 'agentic', 'reasoning'],
    releaseDate: '2026-08-26',
    avoidAutoSelect: true,
  },
  {
    label: 'Llama 3.2 11B Vision',
    value: 'meta/llama-3.2-11b-vision-instruct',
    tier: 'vision',
    recommendedFor: ['vision'],
    desc: 'Smaller visual QA and grounding route; Bimax tool-use probe pending',
    tags: ['vision', 'visual-grounding'],
    parameters: '11B',
    releaseDate: '2024-09-25',
    avoidAutoSelect: true,
  },
  {
    label: 'DeepSeek V4 Flash 0731',
    value: 'deepseek-ai/deepseek-v4-flash-0731',
    tier: 'coding',
    recommendedFor: ['coding'],
    desc: 'Current smaller V4 coding route; Bimax latency and tool probe pending',
    tags: ['coding', 'agentic', 'reasoning'],
    parameters: '284B · 13B active',
    releaseDate: '2026-08-19',
    avoidAutoSelect: true,
  },
  {
    label: 'Phi-3 Vision 128K',
    value: 'microsoft/phi-3-vision-128k-instruct',
    tier: 'vision',
    recommendedFor: ['vision'],
    desc: 'Compact image-and-text instruct model; Bimax grounding and tool probe pending',
    tags: ['vision', 'small'],
    parameters: '4.2B',
    releaseDate: '2024-05-21',
    avoidAutoSelect: true,
  },
  {
    label: 'GPT-OSS 120B',
    value: 'openai/gpt-oss-120b',
    tier: 'coding',
    recommendedFor: ['coding'],
    desc: 'Timed out on all four 60s probes (2026-07-29); opt in only',
    tags: ['coding', 'reasoning'],
    parameters: '120B',
    releaseDate: '2025-08-05',
    avoidAutoSelect: true,
  },
  {
    label: 'Fuyu 8B',
    value: 'adept/fuyu-8b',
    tier: 'vision',
    recommendedFor: ['vision'],
    desc: 'Compact multimodal understanding model; Bimax tool and grounding probe pending',
    tags: ['vision', 'small'],
    parameters: '8B',
    releaseDate: '2023-10-17',
    avoidAutoSelect: true,
  },
  {
    label: 'GPT-OSS 20B',
    value: 'openai/gpt-oss-20b',
    tier: 'coding',
    recommendedFor: ['coding'],
    desc: 'Smaller open reasoner; Bimax coding/tool qualification pending',
    tags: ['coding', 'reasoning'],
    parameters: '20B',
    releaseDate: '2025-08-05',
    avoidAutoSelect: true,
  },
  {
    label: 'NeVA 22B',
    value: 'nvidia/neva-22b',
    tier: 'vision',
    recommendedFor: ['vision'],
    desc: 'General NVIDIA vision-language route; Bimax tool and grounding probe pending',
    tags: ['vision'],
    parameters: '22B',
    avoidAutoSelect: true,
  },
  {
    label: 'MiniMax M3',
    value: 'minimaxai/minimax-m3',
    tier: 'coding',
    recommendedFor: ['coding', 'vision'],
    desc: 'Multimodal coding route with slow starts; Bimax grounding probe pending',
    tags: ['coding', 'vision', 'agentic'],
    releaseDate: '2026-06-12',
    avoidAutoSelect: true,
  },
  {
    label: 'VILA',
    value: 'nvidia/vila',
    tier: 'vision',
    recommendedFor: ['vision'],
    desc: 'NVIDIA vision-language route; Bimax tool and grounding probe pending',
    tags: ['vision'],
    avoidAutoSelect: true,
  },
  {
    label: 'Codestral 22B',
    value: 'mistralai/codestral-22b-instruct-v0.1',
    tier: 'coding',
    recommendedFor: ['coding'],
    desc: 'Code-specialized instruct model; Bimax agent tool probe pending',
    tags: ['coding', 'instruct'],
    parameters: '22B',
    releaseDate: '2024-05-29',
    avoidAutoSelect: true,
  },
  {
    label: 'Cosmos Reason2 8B',
    value: 'nvidia/cosmos-reason2-8b',
    tier: 'vision',
    recommendedFor: ['vision'],
    desc: 'Visual and physical-world reasoning model; not yet qualified for general GUI grounding',
    tags: ['vision', 'reasoning'],
    parameters: '8B',
    avoidAutoSelect: true,
  },
  {
    label: 'Mistral Large 2',
    value: 'mistralai/mistral-large-2-instruct',
    tier: 'coding',
    recommendedFor: ['coding'],
    desc: 'Large general coding/instruct route; Bimax tool qualification pending',
    tags: ['coding', 'instruct'],
    parameters: '123B',
    releaseDate: '2024-07-24',
    avoidAutoSelect: true,
  },
  {
    label: 'Ising Calibration 1.5',
    value: 'nvidia/ising-calibration-1.5-31b',
    tier: 'vision',
    recommendedFor: ['vision'],
    desc: 'Specialized visual analysis for calibration plots; use intentionally outside that domain',
    tags: ['vision', 'charts', 'specialized'],
    parameters: '31B',
    releaseDate: '2026-07-23',
    avoidAutoSelect: true,
  },

  // — Other providers (need their own API key; not probed) —
  { label: 'GPT-4o (OpenAI)', value: 'gpt-4o', desc: 'Needs OPENAI_API_KEY', tier: 'other' },
  {
    label: 'Claude 3.5 Sonnet (Anthropic)',
    value: 'claude-3-5-sonnet-20241022',
    desc: 'Needs ANTHROPIC_API_KEY',
    tier: 'other',
  },
  { label: 'Gemini 2.0 Flash (Google)', value: 'gemini-2.0-flash', desc: 'Needs a Google key', tier: 'other' },
];

/**
 * Slot defaults. These MUST equal `DEFAULTS` in cli/config.ts and MUST NOT be `avoidAutoSelect` —
 * both are enforced by `src/__tests__/models.test.ts`, because the two files drifted apart once
 * already: the catalog kept calling mistral-nemotron the default long after config.ts had moved
 * away from it for declaring no Function Calling, and the failover path reads the catalog.
 *
 * Kimi K3 is the owner-selected Work default and is currently served by NVIDIA. That is a routing
 * fact, not a Product-ready performance claim: re-measure with `npm run benchmark:models` before
 * upgrading its latency/reliability status.
 */
export const DEFAULT_CODING_MODEL = 'moonshotai/kimi-k3';
export const DEFAULT_LITE_MODEL = 'mistralai/mistral-7b-instruct-v0.3';
export const LEGACY_SAFE_LITE_MODEL = DEFAULT_LITE_MODEL;

export type RecommendationTier = 'coding' | 'vision' | 'lite';

/** Slot membership is many-to-many: Kimi K3, for example, is recommended for Work and Vision. */
export function isRecommendedFor(entry: ModelEntry, tier: RecommendationTier): boolean {
  return (entry.recommendedFor ?? (entry.tier === 'other' ? [] : [entry.tier])).includes(tier);
}

/**
 * Ordered auto-selection candidates for one slot, restricted to what the provider actually serves.
 * This is the policy the self-healer uses when a configured model has gone stale (a provider
 * rotated its catalog, or the config was copied from a different provider).
 *
 * Ranking, best first:
 *   1. curated models for this slot, excluding `avoidAutoSelect`
 *      — for the QUICK slot, plain models rank above reasoning models: a hidden 20-30s thinking
 *        phase behind "hi" defeats the entire point of that slot
 *   2. curated models from any other slot (a working model in the wrong slot still answers)
 *   3. nothing — the caller must leave the pin alone and ask the user to run /model
 *
 * Deliberately never falls back to "whatever the provider listed first". `/models` membership does
 * not imply the model serves chat/completions: on NVIDIA, `01-ai/yi-large` is listed and 404s, and
 * being alphabetically first is what made it the old healer's pick.
 */
/** True when the catalog bars this id from being chosen automatically on the user's behalf. */
export function isAvoidAutoSelect(id: string): boolean {
  return MODEL_CATALOG.some((m) => m.value === id && m.avoidAutoSelect);
}

export function autoSelectCandidates(slot: 'coding' | 'lite' | 'vision', servedIds: Iterable<string>): string[] {
  const served = new Set(servedIds);
  // Exclusion is model-wide, even when the same ID has rows in several slots. Otherwise a Work
  // row marked unsafe can sneak back into healing through its duplicate Quick/Vision row.
  const eligible = MODEL_CATALOG.filter(
    (m) => m.tier !== 'other' && !isAvoidAutoSelect(m.value) && served.has(m.value),
  );
  const inSlot = eligible.filter((m) => isRecommendedFor(m, slot)).map((m) => m.value);
  const ranked =
    slot === 'lite'
      ? [...inSlot.filter((id) => !isReasoningModel(id)), ...inSlot.filter((id) => isReasoningModel(id))]
      : inSlot;
  const others = eligible.filter((m) => !isRecommendedFor(m, slot)).map((m) => m.value);
  return [...new Set([...ranked, ...others])];
}

/**
 * True when `id` is a reasoning/thinking model (native channel, inline <think>, or opener-less
 * CoT). Used to keep such models OUT of the lite slot: quick replies and aux calls must never
 * sit behind a hidden reasoning phase there is no API switch to turn off.
 */
export function isReasoningModel(id: string): boolean {
  const caps = capabilitiesFor(null, id);
  return !!(caps.nativeThinking || caps.inlineReasoning || caps.openerlessReasoning);
}

// ONE vocabulary everywhere: Work · Quick · Vision. The banner, the /model hub, the pickers, and
// every confirmation use exactly these three words — "coding/lite/fast" survive only as internal
// keys and accepted command aliases, never as UI text. (This naming drift was the #1 recurring
// clutter complaint.)
const TIER_LABEL: Record<ModelEntry['tier'], string> = {
  coding: 'Work',
  vision: 'Vision',
  lite: 'Quick',
  other: 'Other (own key)',
};

/**
 * Slot-scoped picker rows: each slot's picker shows ONLY models that belong in that slot, as one
 * flat "Recommended" list (no tab groups to arrow through). Work → work-tier models; Quick →
 * plain non-thinking models only (a reasoner in the quick slot hides 20-30s of thought behind
 * "hi"); Vision → vision models. Everything else stays one hop away behind "Browse all…".
 */
export function slotModelMenuOptions(
  slot: 'work' | 'quick' | 'vision',
  liveIds: string[] | null,
  current?: string,
): { label: string; value: string; desc: string; category: string }[] {
  const served = liveIds && liveIds.length ? new Set(liveIds) : null;
  const tier: ModelEntry['tier'] = slot === 'work' ? 'coding' : slot === 'quick' ? 'lite' : 'vision';
  const rows = MODEL_CATALOG.filter((m) => isRecommendedFor(m, tier) && (!served || served.has(m.value))).map((m) => ({
    label: m.value === current ? `● ${m.label}` : m.label,
    value: m.value,
    desc: m.desc,
    category: 'Recommended',
  }));
  if (current && !rows.some((r) => r.value === current)) {
    rows.unshift({ label: `● ${current}`, value: current, desc: 'Your current pick', category: 'Recommended' });
  }
  return rows;
}

/** Menu options for a model picker, optionally annotated with which slot is current. */
export function modelMenuOptions(current?: string): { label: string; value: string; desc: string; category: string }[] {
  return MODEL_CATALOG.map((m) => ({
    label: m.value === current ? `● ${m.label}` : m.label,
    value: m.value,
    desc: m.desc,
    category: TIER_LABEL[m.tier],
  }));
}

// Build the picker from the IDs the provider ACTUALLY serves (LlmAdapter.listProviderModels()).
// A live ID that matches the curated catalog inherits its nice label/description/tier; anything
// else shows as its raw id under "Available on your provider". This is the fix for the 400s —
// you can only pick a model the provider confirms it has. Empty list → caller uses the static
// catalog instead (offline / no /models endpoint).
export function liveModelMenuOptions(
  liveIds: string[],
  current?: string,
): { label: string; value: string; desc: string; category: string }[] {
  const byId = new Map(MODEL_CATALOG.map((m) => [m.value, m]));
  return liveIds.map((id) => {
    const known = byId.get(id);
    return {
      label: id === current ? `● ${known?.label || id}` : known?.label || id,
      value: id,
      desc: known?.desc || id,
      category: known ? TIER_LABEL[known.tier] : 'Available on your provider',
    };
  });
}

/**
 * Clutter-free picker: ONLY the curated recommendations (filtered to what the provider actually
 * serves when we have its live list), never the raw multi-hundred-row catalog. The full list
 * stays one hop away behind a "Browse all…" row the caller wires to `__browse__`.
 */
export function curatedModelMenuOptions(
  liveIds: string[] | null,
  current?: string,
): { label: string; value: string; desc: string; category: string }[] {
  const served = liveIds && liveIds.length ? new Set(liveIds) : null;
  const mark = (v: string, label: string) => (v === current ? `● ${label}` : label);
  const rows = MODEL_CATALOG.filter((m) => m.tier !== 'other' && (!served || served.has(m.value))).map((m) => ({
    label: mark(m.value, m.label),
    value: m.value,
    desc: m.desc,
    category: TIER_LABEL[m.tier],
  }));
  // If the current model isn't in the curated set, surface it so "what am I on?" is always visible.
  if (current && !rows.some((r) => r.value === current)) {
    rows.unshift({ label: `● ${current}`, value: current, desc: 'Your current model', category: TIER_LABEL.coding });
  }
  return rows;
}
