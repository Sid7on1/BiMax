// Curated model catalog for the /model picker. IDs follow the NVIDIA NIM `publisher/model` convention
// (the default provider). If your provider names a model differently, use the "Custom model id…" entry.
// `tier` groups them for the picker: 'coding' = strong agentic/coding models, 'lite' = fast/cheap ones.

import { capabilitiesFor } from '../core/capabilities';

export interface ModelEntry {
  label: string;
  value: string;
  desc: string;
  tier: 'coding' | 'vision' | 'lite' | 'other';
  /**
   * Never pick this model AUTOMATICALLY (self-healing a stale pin). The user can still choose it
   * explicitly from the picker — this only bars the machine from choosing it on their behalf.
   * Set on every entry whose own description records a disqualifying behaviour: times out, needs a
   * long cold start, or cannot call tools. Auto-selecting one of those trades a visibly broken
   * model for an invisibly hanging one, which is a worse failure because it looks like a freeze.
   */
  avoidAutoSelect?: boolean;
}

// Recommendations are task-shaped live probes, not model-card guesses. The 2026-07-29 round used
// the current provider catalog and bounded checks for exact replies, tool calling, and grounded
// image interpretation. See `npm run benchmark:models`.
export const MODEL_CATALOG: ModelEntry[] = [
  // — Work: does the real coding and agentic work — (tier 'coding' internal key)
  // avoidAutoSelect: fast on raw latency, but its NIM card declares Reasoning ONLY — no Function
  // Calling. That is disqualifying for the Work slot, whose whole job is calling tools: the observed
  // failure is bare tool JSON printed as prose (the reason src/core/tool.args.ts exists) and
  // "invalid action arguments" refusals. This row previously called it the default and carried no
  // flag, which is how the failover path in agent.loop.ts kept selecting it on the user's behalf.
  { label: 'Mistral Nemotron', value: 'mistralai/mistral-nemotron', desc: 'Fast replies but declares no Function Calling — prints bare tool JSON instead of calling tools', tier: 'coding', avoidAutoSelect: true },
  { label: 'Nemotron 3 Nano Omni', value: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', desc: 'Fast multimodal reasoner, but chose wrong clicks in both grounded GUI probes', tier: 'coding', avoidAutoSelect: true },
  { label: 'Nemotron 3 Nano', value: 'nvidia/nemotron-3-nano-30b-a3b', desc: 'Fast text/tool controller (~0.9s); image turns need the Vision slot', tier: 'coding' },
  { label: 'Mistral Small 4', value: 'mistralai/mistral-small-4-119b-2603', desc: 'Previously fast + multimodal; not advertised to this NIM account on 2026-07-29', tier: 'coding', avoidAutoSelect: true },
  // Served and correct, but 46-88s per call even warm — a minute per agent step. Opt-in only.
  { label: 'Mistral Medium 3.5', value: 'mistralai/mistral-medium-3.5-128b', desc: 'Calls tools correctly but 46-88s per call on NIM (2026-07-27) — too slow to drive a loop', tier: 'coding', avoidAutoSelect: true },
  { label: 'Qwen 3.5 397B', value: 'qwen/qwen3.5-397b-a17b', desc: 'Bigger reasoner — reliable tools but slow (15-37s/step)', tier: 'coding' },
  // avoidAutoSelect: probed 2026-07-27 on this NIM key — glm-5.2 is listed by /models but sent no
  // response headers for 180s. The other two carry documented cold-start stalls. All three remain
  // one click away in the picker; none may be chosen for the user by the healer.
  { label: 'GLM 5.2', value: 'z-ai/glm-5.2', desc: 'Coding + reasoning — UNAVAILABLE on some NIM keys (times out; probe before defaulting)', tier: 'coding', avoidAutoSelect: true },
  { label: 'DeepSeek V4 Pro', value: 'deepseek-ai/deepseek-v4-pro', desc: '1M context, terminal + coding — very slow NIM cold-start; opt in', tier: 'coding', avoidAutoSelect: true },
  { label: 'GPT-OSS 120B', value: 'openai/gpt-oss-120b', desc: 'Timed out on all four 60s probes (2026-07-29); opt in only', tier: 'coding', avoidAutoSelect: true },
  { label: 'MiniMax M3', value: 'minimaxai/minimax-m3', desc: 'Strong coder — slow to start', tier: 'coding', avoidAutoSelect: true },
  { label: 'Step 3.7 Flash', value: 'stepfun-ai/step-3.7-flash', desc: 'Exact Mac model family — NVIDIA route retired 2026-08-28; use StepFun or OpenRouter', tier: 'coding', avoidAutoSelect: true },

  // — Vision: sees screenshots and images. Probed 2026-07-19 on a real image; only VLMs that
  //   ANSWERED correctly are listed. The default work model already sees, so this slot is a
  //   fallback for when work is switched to a text-only model. —
  // A vision candidate must read the frame AND emit the next tool call in the same response.
  { label: 'Nemotron Nano 12B VL', value: 'nvidia/nemotron-nano-12b-v2-vl', desc: 'Default Vision — grounded composer action; safely refused the unproven-recipient trap', tier: 'vision' },
  { label: 'Nemotron 3 Nano Omni', value: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', desc: 'Chose a wrong click for both selected-contact and recipient-trap frames', tier: 'vision', avoidAutoSelect: true },
  { label: 'Mistral Small 4', value: 'mistralai/mistral-small-4-119b-2603', desc: 'Previously fast + multimodal; not advertised to this NIM account on 2026-07-29', tier: 'vision', avoidAutoSelect: true },
  // 400s on tools+image requests makes it unsuitable for iterative visual work.
  { label: 'Step 3.7 Flash', value: 'stepfun-ai/step-3.7-flash', desc: 'Exact Mac multimodal model family — NVIDIA route retired; use StepFun or OpenRouter', tier: 'vision', avoidAutoSelect: true },
  // Listed by /models yet every completion 404s — the exact trap `unservable` exists for. Kept in
  // the picker (other keys do serve it) but barred from automatic selection.
  { label: 'Kimi K2.6', value: 'moonshotai/kimi-k2.6', desc: 'Multimodal — listed on NIM but 404s on completion (2026-07-27)', tier: 'vision', avoidAutoSelect: true },
  { label: 'Llama 3.2 90B Vision', value: 'meta/llama-3.2-90b-vision-instruct', desc: 'Fast and tool-capable (2.5s), but clicked the unproven recipient in the safety trap', tier: 'vision', avoidAutoSelect: true },

  // — Quick: instant small replies (never a thinking model) — (tier 'lite' kept as the internal key)
  { label: 'Llama 3.1 8B', value: 'meta/llama-3.1-8b-instruct', desc: 'Default — exact reply 0.61s, valid tool call 0.56s live', tier: 'lite' },
  { label: 'Qwen 3.5 122B', value: 'qwen/qwen3.5-122b-a10b', desc: 'Previously sub-second; not advertised to this NIM account on 2026-07-29', tier: 'lite', avoidAutoSelect: true },
  { label: 'Step 3.7 Flash', value: 'stepfun-ai/step-3.7-flash', desc: 'Exact Mac model family — NVIDIA route retired 2026-08-28; use StepFun or OpenRouter', tier: 'lite', avoidAutoSelect: true },
  { label: 'Mistral Small 4', value: 'mistralai/mistral-small-4-119b-2603', desc: 'Previously fast; not advertised to this NIM account on 2026-07-29', tier: 'lite', avoidAutoSelect: true },
  { label: 'Sarvam M', value: 'sarvamai/sarvam-m', desc: 'Multilingual alternative', tier: 'lite' },

  // — Other providers (need their own API key; not probed) —
  { label: 'GPT-4o (OpenAI)', value: 'gpt-4o', desc: 'Needs OPENAI_API_KEY', tier: 'other' },
  { label: 'Claude 3.5 Sonnet (Anthropic)', value: 'claude-3-5-sonnet-20241022', desc: 'Needs ANTHROPIC_API_KEY', tier: 'other' },
  { label: 'Gemini 2.0 Flash (Google)', value: 'gemini-2.0-flash', desc: 'Needs a Google key', tier: 'other' },
];

/**
 * Slot defaults. These MUST equal `DEFAULTS` in cli/config.ts and MUST NOT be `avoidAutoSelect` —
 * both are enforced by `src/__tests__/models.test.ts`, because the two files drifted apart once
 * already: the catalog kept calling mistral-nemotron the default long after config.ts had moved
 * away from it for declaring no Function Calling, and the failover path reads the catalog.
 *
 * The Work pick is the fastest catalog entry that is tool-capable AND carries no disqualifying
 * probe result. Re-measure with `npm run benchmark:models` — that script, not this comment, is the
 * authority.
 */
export const DEFAULT_CODING_MODEL = 'nvidia/nemotron-3-nano-30b-a3b';
export const DEFAULT_LITE_MODEL = 'meta/llama-3.1-8b-instruct';
export const LEGACY_SAFE_LITE_MODEL = 'meta/llama-3.1-8b-instruct';

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
  return MODEL_CATALOG.some(m => m.value === id && m.avoidAutoSelect);
}

export function autoSelectCandidates(
  slot: 'coding' | 'lite' | 'vision',
  servedIds: Iterable<string>,
): string[] {
  const served = new Set(servedIds);
  // Exclusion is model-wide, even when the same ID has rows in several slots. Otherwise a Work
  // row marked unsafe can sneak back into healing through its duplicate Quick/Vision row.
  const eligible = MODEL_CATALOG.filter(m => m.tier !== 'other' && !isAvoidAutoSelect(m.value) && served.has(m.value));
  const inSlot = eligible.filter(m => m.tier === slot).map(m => m.value);
  const ranked = slot === 'lite'
    ? [...inSlot.filter(id => !isReasoningModel(id)), ...inSlot.filter(id => isReasoningModel(id))]
    : inSlot;
  const others = eligible.filter(m => m.tier !== slot).map(m => m.value);
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
  coding: 'Work', vision: 'Vision', lite: 'Quick', other: 'Other (own key)',
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
  const rows = MODEL_CATALOG
    .filter(m => m.tier === tier && (!served || served.has(m.value)))
    .map(m => ({
      label: m.value === current ? `● ${m.label}` : m.label,
      value: m.value,
      desc: m.desc,
      category: 'Recommended',
    }));
  if (current && !rows.some(r => r.value === current)) {
    rows.unshift({ label: `● ${current}`, value: current, desc: 'Your current pick', category: 'Recommended' });
  }
  return rows;
}

/** Menu options for a model picker, optionally annotated with which slot is current. */
export function modelMenuOptions(current?: string): { label: string; value: string; desc: string; category: string }[] {
  return MODEL_CATALOG.map(m => ({
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
export function liveModelMenuOptions(liveIds: string[], current?: string): { label: string; value: string; desc: string; category: string }[] {
  const byId = new Map(MODEL_CATALOG.map(m => [m.value, m]));
  return liveIds.map(id => {
    const known = byId.get(id);
    return {
      label: id === current ? `● ${known?.label || id}` : (known?.label || id),
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
  const rows = MODEL_CATALOG
    .filter(m => m.tier !== 'other' && (!served || served.has(m.value)))
    .map(m => ({
      label: mark(m.value, m.label),
      value: m.value,
      desc: m.desc,
      category: TIER_LABEL[m.tier],
    }));
  // If the current model isn't in the curated set, surface it so "what am I on?" is always visible.
  if (current && !rows.some(r => r.value === current)) {
    rows.unshift({ label: `● ${current}`, value: current, desc: 'Your current model', category: TIER_LABEL.coding });
  }
  return rows;
}
