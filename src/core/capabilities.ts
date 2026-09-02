/**
 * Model capability layer.
 *
 * BiMax is model-agnostic: one OpenAI-compatible seam (`LlmAdapter`) drives NVIDIA, OpenAI,
 * Anthropic, OpenRouter, DeepSeek, Google and local endpoints. A handful of powerful features
 * only exist on *some* models — prompt caching (Anthropic), structured/JSON-schema outputs
 * (OpenAI, Gemini), reliable parallel tool calls, native reasoning channels, vision input.
 *
 * Rather than assume one provider and bolt the rest on, BiMax declares each power as a
 * **capability flag** and resolves the flags for the *currently selected* model. Callers then
 * light up a native fast-path when the capability is present and fall back to a universal path
 * (which BiMax already ships for most of these) when it is not. The golden rule:
 *
 *   The conservative FLOOR (everything off) must reproduce today's behavior byte-for-byte.
 *   A capability only ever *adds* an optimization; it never removes a fallback.
 *
 * Resolution is a curated table, not runtime probing: probing costs a request and is flaky,
 * whereas a table keyed by well-known model-id substrings is deterministic and free. The long
 * tail (a proxy that secretly supports caching, a self-hosted vision model) is covered by an
 * explicit override (`BGW_CAP_*` env or config), so nothing is permanently locked off.
 */

export interface ModelCapabilities {
  /** Anthropic ephemeral prompt caching (`cache_control`). Big cost/latency win on long, stable prefixes. */
  promptCaching: boolean;
  /** Model emits a structured reasoning channel; we don't need to scrape `<think>` text out of content. */
  nativeThinking: boolean;
  /**
   * Model streams chain-of-thought INLINE in the content channel (opener-less `</think>` or
   * `<think>` tags), typically before a tool call, and reliably terminates it with a closer. Tells
   * the streaming think-filter to WAIT for that closer instead of applying the short preamble cap
   * that only exists to stop PLAIN models from buffering-then-bursting. Without this, long
   * pre-tool-call reasoning trips the cap and leaks into the visible reply (the classic "thinking
   * leaks as real tokens when a tool is called" bug). Independent of `nativeThinking`: minimax/step
   * on NIM emit inline CoT even while also exposing a reasoning channel.
   */
  inlineReasoning: boolean;
  /**
   * The model's inline reasoning is OPENER-LESS — it streams raw chain-of-thought first and
   * terminates it with only a `</think>` closer, no leading `<think>` opener (step-3.5, some
   * minimax variants). This is the ONE case where the streaming filter cannot tell reasoning from a
   * direct answer at stream start (both are un-tagged leading text), so it must buffer the leading
   * region until the closer proves the intent — a bounded hold (see MAX_PREAMBLE). FLOOR is false
   * because an OPENER-based reasoner (step-3.7 `<thinking>…</thinking>`) needs no such buffering: the
   * opener itself hides the reasoning while a tag-free answer streams from the first token. Only set
   * this for a model CONFIRMED to emit opener-less reasoning; setting it on an opener-based model
   * re-introduces the "short answer buffers to one end-of-stream burst" latency bug.
   */
  openerlessReasoning: boolean;
  /** Tool arguments stream as partial-JSON deltas (can render live) vs arriving in one blob at block end. */
  partialJsonTools: boolean;
  /** Model reliably emits more than one tool call per turn (some backends, e.g. NVIDIA NIM, reject it). */
  parallelToolCalls: boolean;
  /** JSON-schema-constrained output (`response_format`/`json_schema`); removes the parse-from-prose risk. */
  structuredOutputs: boolean;
  /** Accepts a `reasoning_effort` knob (thinking models); sending it to a model that lacks it can 400. */
  reasoningEffortKnob: boolean;
  /** Prior assistant reasoning_content must be replayed with tool calls on the next request. */
  requiresReasoningReplay: boolean;
  /**
   * Model REJECTS sampling control — `temperature`/`top_p` must be left at the provider default or
   * the request 400s ("Unsupported value: 'temperature' does not support …"). True for OpenAI's
   * o-series and gpt-5 reasoning models. When set, the adapter omits both fields (WS1.4). FLOOR is
   * false, so every other model still sends them exactly as before.
   */
  fixedSampling: boolean;
  /**
   * CONFIRMED non-reasoning model: its content channel is ALWAYS the answer — it never emits an
   * opener-less `</think>` closer or an out-of-band reasoning channel. Tells the streaming filter to
   * skip implicit think-buffering entirely and stream from the very first token, instead of holding
   * the leading content tentatively (up to the preamble cap) waiting for a closer that never comes.
   * Without this, a plain model buffers its head-of-reply and reveals it in one delayed chunk — the
   * "spinner spins, no text → feels very slow / hangs" symptom. Only set it when truly certain the
   * model never reasons inline, or its genuine reasoning WOULD leak as the reply.
   */
  plainContent: boolean;
  /** Image input. */
  visionInput: boolean;
  /** Approximate context window in tokens — compaction thresholds scale to this. */
  contextWindow: number;
}

/**
 * The conservative floor: assume nothing. This is exactly BiMax's behavior before the
 * capability layer existed, so any model not in the table (or any endpoint we can't identify)
 * keeps working precisely as it did — only with the universal fallbacks engaged.
 */
export const FLOOR: ModelCapabilities = {
  promptCaching: false,
  nativeThinking: false,
  inlineReasoning: false,
  openerlessReasoning: false,
  partialJsonTools: false,
  parallelToolCalls: false,
  structuredOutputs: false,
  reasoningEffortKnob: false,
  requiresReasoningReplay: false,
  fixedSampling: false,
  plainContent: false,
  visionInput: false,
  contextWindow: 32_000,
};

/** A capability family — a set of overrides applied on top of FLOOR when a model matches. */
interface CapabilityRule {
  /** Lower-cased substrings; the rule fires when ANY is found in the model id. */
  match: string[];
  caps: Partial<ModelCapabilities>;
}

/**
 * Curated rules, evaluated top-to-bottom; the FIRST match wins (so put specific families before
 * broad ones). Keyed off model-id substrings because that is what every provider actually puts in
 * the `model` field, regardless of which base URL routes it (direct, OpenRouter, Bedrock proxy…).
 */
const RULES: CapabilityRule[] = [
  // --- Anthropic Claude (3.x + 4.x): the only family with prompt caching + native thinking. ---
  {
    match: ['claude', 'anthropic'],
    caps: {
      promptCaching: true,
      nativeThinking: true,
      partialJsonTools: true,
      parallelToolCalls: true,
      structuredOutputs: false, // Claude does tools, not OpenAI-style response_format json_schema
      reasoningEffortKnob: false,
      visionInput: true,
      contextWindow: 200_000,
    },
  },
  // --- OpenAI o-series reasoning models: structured outputs + reasoning_effort, no temp control. ---
  {
    match: ['o1', 'o3', 'o4-', 'gpt-5'],
    caps: {
      structuredOutputs: true,
      reasoningEffortKnob: true,
      fixedSampling: true, // o-series/gpt-5 reject temperature/top_p overrides → 400
      parallelToolCalls: true,
      partialJsonTools: true,
      nativeThinking: true,
      visionInput: true,
      contextWindow: 200_000,
    },
  },
  // --- OpenAI GPT-4o / 4.1 family. ---
  {
    match: ['gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'chatgpt-4o'],
    caps: {
      structuredOutputs: true,
      parallelToolCalls: true,
      partialJsonTools: true,
      visionInput: true,
      contextWindow: 128_000,
    },
  },
  // --- Google Gemini 1.5 / 2.x. ---
  {
    match: ['gemini-2', 'gemini-1.5', 'gemini-exp'],
    caps: {
      structuredOutputs: true,
      parallelToolCalls: true,
      partialJsonTools: true,
      visionInput: true,
      contextWindow: 1_000_000,
    },
  },
  // --- DeepSeek reasoner (R1-style): native reasoning channel, effort knob; no structured outputs. ---
  {
    match: ['deepseek-reasoner', 'deepseek-r1', 'r1'],
    caps: {
      nativeThinking: true,
      reasoningEffortKnob: true,
      contextWindow: 64_000,
    },
  },
  // --- DeepSeek V4: 1M context and a structured reasoning channel. It remains opt-in because
  //     NVIDIA NIM did not produce a first token within 35s on five prompt sizes (2026-07-23). ---
  {
    match: ['deepseek-v4'],
    caps: {
      nativeThinking: true,
      contextWindow: 1_000_000,
    },
  },
  // --- Current compact Quick recommendations: direct-content instruct routes. These exact ids
  //     are intentionally ahead of broad model-family rules so the picker can promise immediate
  //     visible output without guessing that every future family member is plain. ---
  {
    match: [
      'gemma-3-4b-it',
      'google/gemma-2b',
      'granite-3.0-3b-a800m-instruct',
      'granite-3.0-8b-instruct',
      'zamba2-7b-instruct',
      'mistral-nemo-minitron-8b-8k-instruct',
      'deepseek-coder-6.7b-instruct',
      'codegemma-7b',
    ],
    caps: {
      plainContent: true,
      contextWindow: 32_000,
    },
  },
  // --- Muse Glimmer: NVIDIA documents native image input, tool calling, separate reasoning and
  //     a 131K context window. ---
  {
    match: ['muse-glimmer-30b'],
    caps: {
      nativeThinking: true,
      reasoningEffortKnob: true,
      parallelToolCalls: false,
      visionInput: true,
      contextWindow: 131_072,
    },
  },
  // --- Nemotron 3.5 Lightning: text-only long-running agent with optional reasoning and 1M
  //     context. Its hosted parameter contract is model-specific, so generic structured-output
  //     and parallel-tool flags stay conservative. ---
  {
    match: ['nemotron-3.5-lightning-30b-a3b'],
    caps: {
      nativeThinking: true,
      parallelToolCalls: false,
      contextWindow: 1_048_576,
    },
  },
  // --- Laguna XS 2.1: coding/tool model with optional reasoning and 262K context. ---
  {
    match: ['laguna-xs-2.1'],
    caps: {
      nativeThinking: true,
      parallelToolCalls: false,
      contextWindow: 262_144,
    },
  },
  // --- Additional NVIDIA-hosted visual-language recommendations. These accept image input; tool
  //     behavior remains conservative until task-shaped Bimax probes pass. ---
  {
    match: [
      'phi-3-vision-128k',
      'adept/fuyu-8b',
      'nvidia/neva-22b',
      'nvidia/vila',
      'cosmos-reason2-8b',
      'ising-calibration-1.5-31b',
    ],
    caps: {
      parallelToolCalls: false,
      visionInput: true,
      contextWindow: 128_000,
    },
  },
  // --- NVIDIA Nemotron Omni: purpose-built for GUI/browser agents. The hosted model accepts
  // image/video/audio/text, emits inline reasoning, supports tools, and advertises a 256K window.
  // Keep parallel tools and response_format conservative because NIM deployments vary. ---
  {
    match: ['nemotron-3-nano-omni'],
    caps: {
      inlineReasoning: true,
      parallelToolCalls: false,
      visionInput: true,
      contextWindow: 256_000,
    },
  },
  // --- NVIDIA's compact document/visual model. Reasoning is prompt-controlled; leave the
  // reasoning flags off so ordinary instruct responses stream without an implicit think buffer. ---
  {
    match: ['nemotron-nano-12b-v2-vl'],
    caps: {
      parallelToolCalls: false,
      visionInput: true,
      contextWindow: 128_000,
    },
  },
  // --- Ministral 3 Instruct VLM: native function calling, up to ten images, and 256K context. ---
  {
    match: ['ministral-14b-instruct-2512', 'ministral-3-14b-instruct'],
    caps: {
      parallelToolCalls: false,
      visionInput: true,
      contextWindow: 256_000,
    },
  },
  // --- Meta Llama 3.2 Vision endpoints on NVIDIA NIM. These are perception models first; keep
  // structured/parallel tool flags conservative and let the BIMAX tool loop sequence actions. ---
  {
    match: ['llama-3.2-11b-vision', 'llama-3.2-90b-vision'],
    caps: {
      parallelToolCalls: false,
      visionInput: true,
      contextWindow: 128_000,
    },
  },
  // --- MiniMax (NIM): NOT a reasoning model (confirmed by the user who runs it) — it streams its
  // answer directly, with no reasoning_content channel and no inline </think>. So inlineReasoning AND
  // reasoningEffortKnob are FALSE (sending reasoning_effort to a non-reasoning model risks a 400, and
  // the old inlineReasoning:true buffered the whole answer into one end-of-stream burst). The runtime
  // reasoning detector (llm.adapter) still auto-handles it correctly if a future variant DOES reason.
  {
    match: ['minimax'],
    caps: {
      parallelToolCalls: true,
      visionInput: true,
      // Confirmed non-reasoning on NIM: stream the answer from token 1, never buffer it waiting for a
      // `</think>` closer that never arrives (that head-of-reply hold is what made minimax feel "very
      // very slow" — the spinner span with no visible text while the filter sat on the leading chunk).
      plainContent: true,
      // NIM-hosted minimax serves a 128k effective window — not the 1M the model card advertises.
      // The prior 1M made the token-meter bar read ~1% (useless) AND let ContextManager defer
      // compaction to ~700k, well past what the NIM endpoint accepts (→ overflow/API errors).
      contextWindow: 128_000,
    },
  },
  // --- StepFun step-3.5: OPENER-LESS reasoner — emits raw CoT then only a `</think>` closer. The
  //     filter can't distinguish that from a direct answer at stream start, so it must buffer the
  //     leading region (bounded) until the closer. Matched BEFORE the general step rule below. ---
  {
    match: ['step-3.5', 'step-3.6'],
    caps: {
      inlineReasoning: true,
      openerlessReasoning: true,
      contextWindow: 32_000,
    },
  },
  // --- StepFun 3.7: NVIDIA streams reasoning out-of-band in reasoning_content. It accepts image
  //     input and advertises a 262K context window, so it can drive grounded image turns. ---
  {
    match: ['step-3.7'],
    caps: {
      nativeThinking: true,
      visionInput: true,
      contextWindow: 262_000,
    },
  },
  // --- Other StepFun step-3.x variants use inline reasoning tags. ---
  {
    match: ['stepfun', 'step-3'],
    caps: {
      inlineReasoning: true,
      contextWindow: 32_000,
    },
  },
  // --- GLM (Zhipu AI): strong agentic model family. ---
  {
    match: ['glm-'],
    caps: {
      parallelToolCalls: false,
      contextWindow: 128_000,
    },
  },
  // --- Kimi K3: current NVIDIA default. Native multimodal agent with tools, structured outputs,
  //     configurable reasoning and a 1M window. NVIDIA requires the complete assistant message,
  //     including reasoning_content, to be replayed across tool rounds. The hosted endpoint fixes
  //     top_p and related sampling controls, so omit Bimax's generic sampling fields. ---
  {
    match: ['kimi-k3'],
    caps: {
      nativeThinking: true,
      structuredOutputs: true,
      reasoningEffortKnob: true,
      requiresReasoningReplay: true,
      fixedSampling: true,
      parallelToolCalls: false,
      visionInput: true,
      contextWindow: 1_048_576,
    },
  },
  // --- Kimi K2.6: multimodal agent model used for screenshot-bearing turns. ---
  {
    match: ['kimi-k2.6', 'kimi-k2-6'],
    caps: {
      parallelToolCalls: false,
      visionInput: true,
      contextWindow: 256_000,
    },
  },
  // --- Qwen 3.5 (NIM): fast plain (no reasoning channel, no <think>) with working tool calls, used
  //     as the Quick default. visionInput is FALSE despite the endpoint accepting image parts: on
  //     the 2026-07-19 probe both 397b (timeout) and 122b (empty answer) FAILED a real-image
  //     question, so image turns must reroute to the vision slot rather than silently return
  //     nothing. Parallel tools stay conservative for NIM. ---
  {
    match: ['qwen3.5', 'qwen3-5'],
    caps: {
      plainContent: true,
      parallelToolCalls: false,
      visionInput: false,
      contextWindow: 128_000,
    },
  },
  // --- OpenAI gpt-oss (NIM): open-weight reasoner with a NATIVE reasoning_content channel that
  //     honors reasoning_effort (unlike step-3.7). Fast (~2s warm on the 2026-07-19 probe). ---
  {
    match: ['gpt-oss'],
    caps: {
      nativeThinking: true,
      reasoningEffortKnob: true,
      parallelToolCalls: false,
      contextWindow: 128_000,
    },
  },
  // --- Mistral Small 4 (NIM): fast VLM — tools + image input probed working 2026-07-19. Listed
  //     BEFORE the generic mistral rule so it keeps its vision flag. ---
  {
    match: ['mistral-small-4'],
    caps: {
      plainContent: true,
      parallelToolCalls: false,
      visionInput: true,
      contextWindow: 128_000,
    },
  },
  // --- Mistral 7B Instruct: current NVIDIA Quick route; plain text, compact context. ---
  {
    match: ['mistral-7b-instruct-v0.3'],
    caps: {
      plainContent: true,
      contextWindow: 32_000,
    },
  },
  // --- Mistral Medium / Large: good coding, large context. ---
  {
    match: ['mistral'],
    caps: {
      contextWindow: 128_000,
    },
  },
  // --- Llama 3.1 8B Instruct (NIM): verified direct-content quick model. Keep this specific rule
  //     before the generic Llama family so the streaming filter never waits for reasoning tags the
  //     model does not emit. Text-only: screenshot turns reroute to the configured Vision slot. ---
  {
    match: ['llama-3.1-8b-instruct'],
    caps: {
      plainContent: true,
      parallelToolCalls: false,
      visionInput: false,
      contextWindow: 128_000,
    },
  },
  // --- Llama 3.x (NVIDIA NIM and others): large-ish window, but NIM rejects multi-tool turns. ---
  {
    match: ['llama-3', 'llama3'],
    caps: {
      parallelToolCalls: false,
      contextWindow: 128_000,
    },
  },
];

/** A single env override, e.g. BGW_CAP_PROMPT_CACHING=true. Returns undefined when unset. */
function envFlag(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === 'true' || v === '1';
}

/**
 * Apply user overrides from the environment on top of a resolved descriptor. This is the escape
 * hatch for endpoints the table can't know about (a proxy that does support caching, a local
 * vision model, a backend that genuinely allows parallel tools). Each flag is independent.
 */
function applyOverrides(caps: ModelCapabilities): ModelCapabilities {
  const out = { ...caps };
  const pc = envFlag('BGW_CAP_PROMPT_CACHING');
  if (pc !== undefined) out.promptCaching = pc;
  const nt = envFlag('BGW_CAP_NATIVE_THINKING');
  if (nt !== undefined) out.nativeThinking = nt;
  const ir = envFlag('BGW_CAP_INLINE_REASONING');
  if (ir !== undefined) out.inlineReasoning = ir;
  const ol = envFlag('BGW_CAP_OPENERLESS_REASONING');
  if (ol !== undefined) out.openerlessReasoning = ol;
  const pj = envFlag('BGW_CAP_PARTIAL_JSON_TOOLS');
  if (pj !== undefined) out.partialJsonTools = pj;
  const pt = envFlag('BGW_CAP_PARALLEL_TOOL_CALLS');
  if (pt !== undefined) out.parallelToolCalls = pt;
  const so = envFlag('BGW_CAP_STRUCTURED_OUTPUTS');
  if (so !== undefined) out.structuredOutputs = so;
  const re = envFlag('BGW_CAP_REASONING_EFFORT');
  if (re !== undefined) out.reasoningEffortKnob = re;
  const fs = envFlag('BGW_CAP_FIXED_SAMPLING');
  if (fs !== undefined) out.fixedSampling = fs;
  const pl = envFlag('BGW_CAP_PLAIN_CONTENT');
  if (pl !== undefined) out.plainContent = pl;
  const vi = envFlag('BGW_CAP_VISION');
  if (vi !== undefined) out.visionInput = vi;
  const cw = process.env.BGW_CAP_CONTEXT_WINDOW;
  if (cw && !Number.isNaN(parseInt(cw, 10))) out.contextWindow = parseInt(cw, 10);
  return out;
}

/**
 * Resolve capabilities for a specific (provider, model). `provider` is accepted for future
 * provider-scoped rules but resolution is currently driven by the model id, which is the field
 * every backend populates regardless of routing. Always returns a complete descriptor (FLOOR for
 * unknowns) so callers never deal with undefined.
 */
export function capabilitiesFor(
  provider: string | null | undefined,
  model: string | null | undefined,
): ModelCapabilities {
  const id = (model || '').toLowerCase();
  let resolved: ModelCapabilities = { ...FLOOR };
  for (const rule of RULES) {
    if (rule.match.some((m) => id.includes(m))) {
      resolved = { ...FLOOR, ...rule.caps };
      break;
    }
  }
  return applyOverrides(resolved);
}

/** True only for the genuine first-party Anthropic API host — where `anthropic-beta` is honored. */
export function isFirstPartyAnthropic(baseURL: string | null | undefined): boolean {
  if (!baseURL) return false;
  try {
    return new URL(baseURL).hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

/**
 * Resolve the `anthropic-beta` request header for Anthropic's beta-gated features (1M context,
 * token-efficient tools, interleaved thinking). These are Messages-API betas that only the genuine
 * Anthropic endpoint understands and several are model/tier-gated (sending `context-1m` to an
 * ineligible model/tier 400s), so this is deliberately:
 *   1. host-gated — never emitted unless the call targets api.anthropic.com, so the header can't
 *      leak to OpenRouter/Bedrock/NIM and break an unrelated request; and
 *   2. opt-in — the exact, version-stamped beta tokens come from `BGW_ANTHROPIC_BETA` (comma-
 *      separated), because the safe set depends on the user's specific model + account tier and
 *      must not be guessed. Unset → undefined → no header → today's behavior, unchanged.
 * Returns the header map or undefined.
 */
export function anthropicBetaHeaders(baseURL: string | null | undefined): Record<string, string> | undefined {
  if (!isFirstPartyAnthropic(baseURL)) return undefined;
  const raw = (process.env.BGW_ANTHROPIC_BETA || '').trim();
  if (!raw) return undefined;
  const betas = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (betas.length === 0) return undefined;
  return { 'anthropic-beta': betas.join(',') };
}

/**
 * A compact glyph cluster for the footer/status line, showing what the active model unlocks.
 * Empty string when nothing notable is on (a floor model), so the footer stays quiet.
 */
export function capabilityGlyphs(caps: ModelCapabilities): string {
  const parts: string[] = [];
  if (caps.promptCaching) parts.push('⚡cache');
  if (caps.nativeThinking) parts.push('⊹think');
  if (caps.structuredOutputs) parts.push('{}json');
  if (caps.visionInput) parts.push('◉vision');
  return parts.join(' ');
}
