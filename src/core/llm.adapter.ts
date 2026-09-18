import { stateDir } from '../utils/state.dir';
import OpenAI from 'openai';
import { Logger } from '../utils';
import { ApiKeyManager, KeyResult } from '../credits/api.key.manager';
import { LLMProvider, Message, ChatOptions, ChatEvent } from './llm.provider';
import { capabilitiesFor, ModelCapabilities, anthropicBetaHeaders } from './capabilities';
import { contentToText } from './multimodal';
import { globalTelemetry } from '../telemetry/telemetry';
import { engineEvents } from '../engine/events';
import { autoSelectCandidates } from '../engine/models';

// Streaming & response-parsing helpers now live in ./llm.stream (extracted to keep this file
// focused on the adapter class). Imported for internal use and re-exported so existing importers
// and tests (which import these from ./llm.adapter) keep working unchanged.
import {
  markCacheBreakpoint, withCacheControl, applyCacheBreakpoints, applyToolCallDelta, finalizeToolCalls, classifyStreamError,
  ThinkTagFilter, stripThink, extractJson, chooseThinkStrategy, hasMeaningfulStreamPayload,
} from './llm.stream';
import type { ToolCallSlot } from './llm.stream';
import { markProviderRequest, markFirstRawChunk, recordProviderRound, attachRoundUsage } from '../telemetry/perf';
import { providerUsage } from '../telemetry/measure';
import { attributeSlowWait, SLOW_WAIT_THRESHOLD_MS } from '../telemetry/netprobe';
import { CircuitBreaker, Outcome, BreakerOpen, RetryPolicy, serverConfig } from './circuit-breaker';
import { assertEgressAllowed } from '../security/egress.guard';

/**
 * The URL a `fetch` call is actually aimed at. The SDK may hand us a string, a `URL`, or a
 * `Request`, and the guard must classify the real destination rather than the configured base —
 * they differ whenever the SDK builds a path or a caller passes an absolute override. Falls back
 * to the base URL only when the argument carries no usable URL at all.
 */
function requestUrlOf(input: unknown, fallback: string): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  const url = (input as { url?: unknown } | null)?.url;
  return typeof url === 'string' && url ? url : fallback;
}

// Provider-fault classification for the LLM circuit breaker. The per-key ApiKeyManager already
// rotates and cools individual keys; the breaker sits ABOVE that to catch a whole-provider outage,
// where every rotated key fails and the agent loop would otherwise hot-retry chat() with no pause.
const LLM_RETRY_POLICY = RetryPolicy.server(); // 429 + any 5xx are transient provider faults
export function isProviderFault(status: number | null | undefined): boolean {
  // No status = a timeout / dropped stream (a provider fault for outage purposes); 408 likewise.
  if (status == null || status === 0 || status === 408) return true;
  return LLM_RETRY_POLICY.shouldRetry(status);
}
export {
  markCacheBreakpoint, withCacheControl, applyCacheBreakpoints, applyToolCallDelta, finalizeToolCalls, classifyStreamError,
  ThinkTagFilter, stripThink, extractJson, chooseThinkStrategy, hasMeaningfulStreamPayload,
};
export type { ToolCallSlot };

/**
 * NVIDIA NIM chat templates accept one system block at the beginning and reject system roles
 * later in the conversation. They also require a completed assistant turn between a tool result
 * and a fresh user turn. Normalize those provider-specific constraints at the final wire boundary
 * so context injectors cannot accidentally create another role-order 400.
 */
export function normalizeNvidiaMessages(messages: Message[]): Message[] {
  const systems = messages.filter(m => m.role === 'system');
  const conversation = messages.filter(m => m.role !== 'system');
  const out: Message[] = [];

  if (systems.length > 0) {
    out.push({
      role: 'system',
      content: systems.map(m => contentToText(m.content as any)).filter(Boolean).join('\n\n'),
    });
  }

  for (const message of conversation) {
    if (out[out.length - 1]?.role === 'tool' && message.role === 'user') {
      out.push({
        role: 'assistant',
        content: 'Tool results received. I will use the new user-provided context to continue.',
      });
    }
    out.push(message);
  }
  return out;
}

/**
 * OpenAI's SDK expects JSON errors to be shaped as `{ error: { message } }`. NVIDIA's API gateway
 * returns RFC 7807 problem documents instead (`{ title, status, detail }`). The SDK discards that
 * top-level document and constructs `410 status code (no body)`, hiding the one field that explains
 * the failure. Normalize only failed JSON/problem responses, keep the body bounded, and leave every
 * successful/unknown response byte-for-byte untouched.
 */
export async function normalizeProviderErrorResponse(response: Response): Promise<Response> {
  if (response.ok) return response;
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('json') && !contentType.includes('problem')) return response;

    let text: string;
  try { text = await response.clone().text(); } catch { return response; }
  if (!text || text.length > 16_384) return response;

  let problem: any;
  try { problem = JSON.parse(text); } catch { return response; }
  if (!problem || typeof problem !== 'object' || problem.error) return response;
  const detail = typeof problem.detail === 'string' ? problem.detail.trim() : '';
  const title = typeof problem.title === 'string' ? problem.title.trim() : '';
  const message = detail || title;
  if (!message) return response;

  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  return new Response(JSON.stringify({
    error: {
      message,
      ...(title ? { type: title.toLowerCase().replace(/\s+/g, '_') } : {}),
      ...(response.status === 410 ? { code: 'model_gone' } : {}),
    },
  }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Pure request router, exported so image-slot behavior stays regression-testable. */
export function selectRequestModel(
  primary: string,
  visionModel: string | undefined,
  hasImages: boolean,
  provider?: string | null,
): string {
  if (hasImages && visionModel && !capabilitiesFor(provider, primary).visionInput) return visionModel;
  return primary;
}

export class LlmAdapter implements LLMProvider {
  public readonly strictModel = String(process.env.BIMAX_DESKTOP_STRICT_MODEL || '').trim();
  public defaultModel = process.env.BGW_MODEL || 'moonshotai/kimi-k3';
  public requestTimeout = parseInt(process.env.BGW_TIMEOUT || '120000', 10);
  public temperature: number = parseFloat(process.env.BGW_TEMPERATURE || '0.1');
  // Nucleus sampling cap. Clipping the low-probability tail is what actually curbs the
  // "dropped a tool argument / fabricated a path" failures on reasoning models — far more
  // than lowering temperature, which on a tuned MoE just pushes it off-distribution. Default
  // 0.95 (minimax model card + opencode's provider/transform.ts).
  public topP: number = parseFloat(process.env.BGW_TOP_P || '0.95');
  public maxTokens: number = parseInt(process.env.BGW_MAX_TOKENS || '4096', 10);
  // Inter-chunk stall timeout: how long to wait for the NEXT streamed chunk once the stream
  // is already flowing, before assuming it stalled.
  public streamReadTimeoutMs = parseInt(process.env.BGW_STREAM_TIMEOUT_MS || '60000', 10);
  // Time-to-first-token budget. Cold starts on slow reasoning models (minimax) routinely run
  // 60–90s before the first token while later chunks arrive quickly, so the first chunk gets a
  // longer budget than the inter-chunk one — a real cold start isn't killed as a "stall," but a
  // genuinely dead stream is still caught. Default 180s: NVIDIA NIM queues a cold heavy reasoning
  // model (minimax-m3) well past 120s before the first token, which surfaced as a spurious
  // "stream timeout" + retry loop. Also covers the whole reasoning phase (see chat()).
  public firstChunkTimeoutMs = parseInt(process.env.BGW_FIRST_CHUNK_TIMEOUT_MS || '180000', 10);
  // Optional reasoning budget for thinking models (e.g. minimax). Off by default —
  // when set ('low'|'medium'|'high'), sent as reasoning_effort to trade depth for speed.
  public reasoningEffort?: string = process.env.BGW_REASONING_EFFORT || undefined;
  // Handle opener-less reasoning (`reasoning</think>answer`, no leading <think>) by buffering
  // leading content until a closer proves it was thinking. On for the default reasoning models;
  // set BGW_IMPLICIT_THINK=false for plain models so their answers stream token-by-token.
  public implicitThink: boolean = process.env.BGW_IMPLICIT_THINK !== 'false';
  // RUNTIME reasoning detection (so think-vs-non-think is figured out automatically, per model, with
  // NO static config to get wrong when you switch models). A model id is added here the first time it
  // proves it reasons — by emitting a `reasoning_content` delta or a `</think>` closer in content.
  // Once learned, later turns of that model lift the preamble cap (wait for the closer instead of
  // capping → no reasoning leak). Unknown/plain models stay capped, so their answers stream normally.
  private detectedReasoners = new Set<string>();
  // Allow the model to emit several tool calls in ONE turn (batched reads/greps run concurrently in
  // the loop → far faster investigation). Default ON; disable for backends that reject multi-tool
  // turns (e.g. NVIDIA NIM) via config or BGW_PARALLEL_TOOL_CALLS=false.
  public parallelToolCalls: boolean = process.env.BGW_PARALLEL_TOOL_CALLS !== 'false';
  // The LITE model — used for cheap auxiliary calls (history summaries, self-critic, ask-user
  // auto-decisions). Falls back to the main (coding) model when unset. Set via /model lite.
  public liteModel?: string = process.env.BGW_LITE_MODEL || undefined;
  // The VISION model — used ONLY for calls whose messages carry images when the primary model is
  // text-only. Picking a vision model must never displace the user's coding model (that swap is
  // exactly what made "vision" confusing); this slot routes the image turns and nothing else.
  public visionModel?: string = process.env.BGW_VISION_MODEL || undefined;
  // The model the user EXPLICITLY chose (config.model / /model). Takes precedence over a key's
  // provider-default model so the picker actually changes the model. Unset = use the key/default.
  public userModel?: string = process.env.BGW_MODEL || undefined;

  private budgetVeto?: any; // Will be typed as BudgetVeto but avoiding circular imports or just use any here

  constructor(private apiKeyManager: ApiKeyManager) {
    if (this.strictModel) {
      this.defaultModel = this.strictModel;
      this.userModel = this.strictModel;
      this.liteModel = this.strictModel;
      this.visionModel = this.strictModel;
    }
  }

  public setBudgetVeto(budgetVeto: any) {
    this.budgetVeto = budgetVeto;
  }

  /**
   * Swap the key pool live (the /keys command calls this after saving a new key). Clears the
   * per-key client cache and the live-models cache so the next request/picker uses the new key —
   * previously a key added mid-session only took effect after a restart.
   */
  public setKeys(keys: import('../credits/api.key.manager').KeyConfig[]): void {
    this.apiKeyManager.setKeys(keys);
    this.clientCache.clear();
    this.liveModelsCache = null;
  }

  /** Live per-key pool health (ok/fail counts, cooldown) — read-only, for the /keys UI (WS1.5). */
  public getKeyStates() {
    return this.apiKeyManager.getStates();
  }

  /**
   * What this adapter will ACTUALLY send on the next request.
   *
   * A settings surface that reads the config file is reading the wrong thing: the file is what was
   * requested, this is what is loaded. They diverge whenever a write lands somewhere that does not
   * also reach the adapter — which is exactly how "I changed the model and it never changed" stayed
   * invisible for so long (the desktop's silent `configSet` path saved the file, reported the file
   * back, and left `userModel` pinned to whatever booted). Every read-back should compare against
   * this, never against `getConfig()`.
   */
  public readEffective(): {
    model: string; liteModel: string; visionModel: string; reasoningEffort: string;
    temperature: number; topP: number; maxTokens: number; timeout: number; parallelToolCalls: boolean;
  } {
    return {
      model: this.userModel || this.defaultModel || '',
      liteModel: this.liteModel || '',
      visionModel: this.visionModel || '',
      reasoningEffort: this.reasoningEffort || '',
      temperature: this.temperature,
      topP: this.topP,
      maxTokens: this.maxTokens,
      timeout: this.requestTimeout,
      parallelToolCalls: this.parallelToolCalls,
    };
  }

  public applyConfig(cfg: { model?: string; timeout?: number; temperature?: number; topP?: number; maxTokens?: number; reasoningEffort?: string; parallelToolCalls?: boolean; liteModel?: string; visionModel?: string }) {
    if (!this.strictModel && cfg.model) { this.defaultModel = cfg.model; this.userModel = cfg.model; }
    if (cfg.timeout) this.requestTimeout = cfg.timeout;
    if (cfg.temperature !== undefined) this.temperature = cfg.temperature;
    if (cfg.topP !== undefined) this.topP = cfg.topP;
    if (cfg.maxTokens) this.maxTokens = cfg.maxTokens;
    if (cfg.reasoningEffort !== undefined) this.reasoningEffort = cfg.reasoningEffort || undefined;
    if (cfg.parallelToolCalls !== undefined) this.parallelToolCalls = cfg.parallelToolCalls;
    if (!this.strictModel && cfg.liteModel !== undefined) this.liteModel = cfg.liteModel || undefined;
    if (!this.strictModel && cfg.visionModel !== undefined) this.visionModel = cfg.visionModel || undefined;
    if (this.strictModel) {
      this.defaultModel = this.strictModel;
      this.userModel = this.strictModel;
      this.liteModel = this.strictModel;
      this.visionModel = this.strictModel;
    }
  }

  // Reuse one OpenAI client per (baseURL, key) instead of constructing a fresh one — with its own
  // connection pool — on every request. Keep-alive then survives across calls (faster, fewer TLS
  // handshakes). Per-request options like timeout are still passed at call time, so this is safe.
  private clientCache = new Map<string, OpenAI>();
  private createClient(keyResult: KeyResult): OpenAI {
    const apiKey = keyResult.keyStr || '';
    const baseURL = keyResult.baseURL || 'https://integrate.api.nvidia.com/v1';
    const cacheKey = `${baseURL}${apiKey}`;
    let client = this.clientCache.get(cacheKey);
    if (!client) {
      // maxRetries MUST be 0: retries belong to OUR loop, which rotates to a different key.
      // The SDK's built-in retry re-sends to the SAME key — under NIM's per-key server-side
      // queueing that stacked up to 4×timeout (8 minutes) of invisible dead air per call,
      // which is exactly the "sub-agents are hell of slow" hang.
      // Sovereignty is enforced HERE, at the one call every model request passes through, rather
      // than where the base URL is configured. A check at configuration time proves what was
      // intended; a check at the fetch proves what was sent — including a request the SDK aimed
      // somewhere the config never named. In sovereign mode an external destination throws before
      // any bytes are written, and the attempt is recorded either way.
      const providerFetch: typeof fetch = async (...args) => {
        assertEgressAllowed({
          target: requestUrlOf(args[0], baseURL),
          subsystem: 'LlmAdapter',
          purpose: 'model request',
        });
        return normalizeProviderErrorResponse(await fetch(...args));
      };
      client = new OpenAI({ apiKey, baseURL, maxRetries: 0, fetch: providerFetch });
      this.clientCache.set(cacheKey, client);
    }
    return client;
  }

  // The IDs the provider ACTUALLY serves, fetched from its OpenAI-compatible `/models` endpoint.
  // This kills the "400 — not a valid model ID" class of bug at the root: the picker offers real
  // IDs instead of a hand-typed catalog that drifts out of sync with the provider. Cached for the
  // session (refresh=true to re-fetch). Empty array on any failure — callers fall back to the
  // static catalog, so a provider without a /models endpoint degrades to the old behaviour.
  private liveModelsCache: string[] | null = null;
  public async listProviderModels(refresh = false): Promise<string[]> {
    if (this.liveModelsCache && !refresh) return this.liveModelsCache.filter(id => !this.unservable.has(id));
    try {
      const keyResult = await this.apiKeyManager.getNextKey();
      if (!keyResult.keyStr) return [];
      const client = this.createClient(keyResult);
      // A catalogue is setup UI, not a model turn. It must fail quickly and explicitly when a
      // provider is offline or an endpoint black-holes the request; otherwise the model window is
      // stuck on “Fetching…” while the SDK waits on its much longer turn timeout.
      const page = await client.models.list({
        timeout: 7_000,
        signal: AbortSignal.timeout(7_000),
      });
      const ids = (page.data || []).map(m => m.id).filter(Boolean).sort();
      this.liveModelsCache = ids;
      return ids.filter(id => !this.unservable.has(id));
    } catch (e: any) {
      Logger.warn(`[LlmAdapter] listProviderModels failed (${e?.message}); falling back to static catalog.`);
      return [];
    }
  }

  // Models the provider LISTS but does not actually serve. Being in `/models` is not proof that
  // chat/completions will accept the id: NVIDIA lists `01-ai/yi-large` and then 404s every
  // completion for it. That gap is what let a "healed" config stay broken — the healer saw the id
  // in the list, called the slot healthy, and never touched it again.
  //
  // Populated from real API rejections (see markUnservable), so it records what the provider did,
  // not what it advertised. Session-scoped: a genuinely transient outage is forgotten on restart.
  private readonly unservable = new Set<string>();

  /** Record that the provider rejected this model id outright, so nothing picks it again. */
  public markUnservable(model: string): void {
    if (!model || this.unservable.has(model)) return;
    this.unservable.add(model);
    Logger.warn(`[LlmAdapter] Provider rejected model "${model}" as unavailable; excluding it from selection this session.`);
  }

  /** True when the provider has rejected this id during this session. */
  public isUnservable(model: string): boolean { return this.unservable.has(model); }

  /**
   * The quick slot, unless the provider has rejected it this session. A rejected quick model used to stay
   * selected: every short question re-sent the id NVIDIA had just 404'd, and the turn failed with "the
   * provider rejected the current model id" while the work model was healthy. Quick calls now fall back
   * to the work model once that happens.
   */
  private quickModel(): string | undefined {
    return this.liteModel && !this.unservable.has(this.liteModel) ? this.liteModel : undefined;
  }

  // If a configured model isn't one the provider actually serves, switch it to a valid one so turns
  // don't 400/404/410 forever (the classic symptom: a config.json pinned to a model from a different
  // provider — e.g. an NVIDIA id while the key is OpenRouter).
  //
  // Heals ALL THREE slots, not just the work model. Healing only the work slot was a silent-death
  // bug: a greeting routes to the QUICK slot, so a stale liteModel meant every "hi" hit an unserved
  // model and the turn ended with no reply at all while the work model looked healthy.
  //
  // The replacement is always drawn from the curated catalog (filtered to what the provider serves),
  // never from `ids[0]`. Alphabetical order carries no meaning: on NVIDIA it picks `01-ai/yi-large`,
  // which IS in /models but 404s on chat/completions — healing to it just moved the failure. When no
  // curated model for a slot is served, the pin is left alone and the caller tells the user to run
  // /model; a wrong automatic pick is worse than an honest prompt.
  //
  // Returns one entry per slot actually changed (empty = nothing to do). Best-effort: a provider
  // without a /models endpoint returns [] above, so we leave every slot untouched.
  public async healModels(): Promise<Array<{ slot: 'work' | 'quick' | 'vision'; from: string; to: string }>> {
    // The Desktop lock is an intentional product/user choice. `avoidAutoSelect` is advice for an
    // automatic picker, never authority to veto that choice or silently rewrite it.
    if (this.strictModel) return [];
    const ids = await this.listProviderModels();
    if (ids.length === 0) return [];
    const served = new Set(ids);

    // The key's own provider default, if the provider genuinely serves it.
    let keyDefault: string | undefined;
    try {
      const kr = await this.apiKeyManager.getNextKey();
      if (kr.model && served.has(kr.model)) keyDefault = kr.model;
    } catch { /* optional */ }

    // Ranking policy lives with the catalog (models.ts:autoSelectCandidates) — it is catalog
    // knowledge, not adapter knowledge, and is unit-tested there. The key's own default is
    // consulted only if the curated policy has nothing to offer.
    const replacementFor = (tier: 'coding' | 'lite' | 'vision'): string | undefined =>
      autoSelectCandidates(tier, served)[0] ?? keyDefault;

    const healed: Array<{ slot: 'work' | 'quick' | 'vision'; from: string; to: string }> = [];
    const heal = (
      slot: 'work' | 'quick' | 'vision',
      current: string | undefined,
      tier: 'coding' | 'lite' | 'vision',
      assign: (to: string) => void,
    ) => {
      // An unset optional slot is not broken — it just falls back to the work model at call time.
      if (!current) return;
      // A pin is broken only on EVIDENCE, of which there are exactly two kinds:
      //   1. the provider does not list it at all;
      //   2. the provider lists it but has actually rejected it this session (`unservable`).
      //
      // `isAvoidAutoSelect` used to be a third reason, and it inverted this function. That flag is
      // a catalogue OPINION, not evidence, and it is already applied where it belongs — in
      // autoSelectCandidates(), which is what "avoid AUTO select" names. Using it to EVICT an
      // incumbent meant a deliberately chosen model was thrown out for a merely-unvalidated note.
      //
      // Measured on this account 2026-09-02: the healer replaced `nemotron-3-nano-omni…-reasoning`
      // (answers in 4.0s, calls tools) with `moonshotai/kimi-k3` (90s timeout, no response), and
      // `nemotron-3.5-lightning-30b-a3b` (6.7s, calls tools) with `mistral-7b-instruct-v0.3`
      // (HTTP 404) — because the two working models carry `avoidAutoSelect` while the two broken
      // ones do not. Their notes read "GUI probes chose wrong clicks" (a Computer Use finding, and
      // CU is no longer part of this product) and "task probe pending" (simply unbenchmarked).
      // Neither says "cannot serve a coding turn". The result was zero tool calls on every turn.
      //
      // This mirrors the rule already stated for the Desktop lock above: advice for an automatic
      // picker is never authority to veto the user's choice or silently rewrite it.
      const reason = !served.has(current) ? 'is not served by the provider'
        : this.unservable.has(current) ? 'was rejected by the provider at call time'
        : null;
      if (!reason) return;
      const to = replacementFor(tier);
      if (!to || to === current) {
        Logger.warn(`[LlmAdapter] ${slot} model "${current}" ${reason}, but no curated replacement is available; leaving it pinned.`);
        return;
      }
      assign(to);
      Logger.warn(`[LlmAdapter] ${slot} model "${current}" ${reason}; switched to "${to}".`);
      healed.push({ slot, from: current, to });
    };

    heal('work', this.userModel || this.defaultModel, 'coding', to => { this.userModel = to; this.defaultModel = to; });
    heal('quick', this.liteModel, 'lite', to => { this.liteModel = to; });
    heal('vision', this.visionModel, 'vision', to => { this.visionModel = to; });
    return healed;
  }

  /**
   * Resolve the sampling regime for a model. Reasoning MoE models are tuned for a specific
   * temperature/top_p and go pathological off it: minimax's own model card specifies
   * temperature 1.0 + top_p 0.95, and a blanket 0.7-with-no-top_p (the prior default) measurably
   * increased dropped tool arguments, fabricated paths, and run-to-run variance. So minimax is
   * pinned to its recommended regime; everything else uses the configured temperature. In all
   * cases we apply the top_p tail-clip, which is the real lever against those failures. An
   * explicit per-call `temperature` (e.g. the deterministic aux callers) always wins. Mirrors
   * opencode's provider/transform.ts.
   */
  /**
   * Reasoning models must not run at the plain default temperature.
   *
   * The default here is 0.1 (BGW_TEMPERATURE), which is tuned for plain instruct models. A
   * reasoning MoE sampled that cold goes degenerate: it collapses into a token loop and emits the
   * same fragment forever ("ellsellsells…"), which reaches the user as a stalled turn that never
   * calls a tool. minimax was already pinned to 1.0 for exactly this reason — that pin was the
   * single-model version of this rule, and it is kept verbatim because it comes from minimax's own
   * model card. REASONING_FLOOR generalises it to every model the capability layer identifies as a
   * reasoner, rather than waiting to discover each one the same painful way.
   *
   * An EXPLICIT temperature always wins: `override` (a per-call choice) and a user-set
   * `temperature` above the floor are both respected, so this can only ever raise a value that was
   * never chosen for a reasoning model in the first place. Settings → temperature still overrides
   * it outright.
   */
  public resolveSampling(model: string, override?: number): { temperature: number; top_p: number } {
    const id = (model || '').toLowerCase();
    if (id.includes('minimax')) return { temperature: override ?? 1.0, top_p: this.topP };
    if (override !== undefined) return { temperature: override, top_p: this.topP };

    const REASONING_FLOOR = 0.6;
    const caps = capabilitiesFor(null, model);
    const isReasoner = !!(caps.nativeThinking || caps.inlineReasoning || caps.openerlessReasoning);
    const temperature = isReasoner ? Math.max(this.temperature, REASONING_FLOOR) : this.temperature;
    return { temperature, top_p: this.topP };
  }

  /**
   * WS1.4 — sampling fields for the aux (non-chat) request sites, as a spreadable partial.
   * Models with `fixedSampling` (o-series/gpt-5) 400 on any temperature/top_p override, so for
   * them this returns `{}` and the field is omitted; every other model sends exactly what it
   * sent before. Aux sites historically send only `temperature` (no top_p), and that stays true.
   */
  private samplingFieldsFor(model: string, temperature: number): { temperature?: number } {
    return capabilitiesFor(undefined, model).fixedSampling ? {} : { temperature };
  }

  private pickModel(keyResult: KeyResult, lite?: boolean, hasImages?: boolean): string {
    if (this.strictModel) return this.strictModel;
    const quick = lite ? this.quickModel() : undefined;
    const chosen = quick
      ? quick
      // The user's explicit choice (set via /model → applyConfig) must win. Previously the key's
      // baked-in provider default (keyResult.model) shadowed it, so /model appeared to do nothing.
      : (this.userModel || keyResult.model || this.defaultModel);
    // Image turns silently reroute to the vision slot when the chosen model can't see — the ONLY
    // condition under which visionModel is used. A vision-capable primary keeps its own turn.
    return selectRequestModel(chosen, this.visionModel, !!hasImages, keyResult.provider);
  }

  /** Any message carrying an OpenAI image_url content part → this call needs a vision-capable model. */
  private static messagesHaveImages(messages: Array<{ content?: unknown }>): boolean {
    return messages.some(m => Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some(p => p?.type === 'image_url'));
  }

  /**
   * Can the NEXT image-bearing turn actually be seen by a model? True when the active model has
   * vision, or a dedicated vision slot is configured. The attach/drop gates key off this — NOT off
   * the primary model's caps — so setting a vision model is sufficient to enable screenshots.
   */
  public canSeeImages(): boolean {
    const primary = this.userModel || this.defaultModel;
    if (capabilitiesFor(undefined, primary).visionInput) return true;
    return !!(this.visionModel && capabilitiesFor(undefined, this.visionModel).visionInput);
  }

  /**
   * Resolve the capability descriptor for the model THIS call will actually use. Critically this
   * keys off `pickModel(...)`, not a global env var: a key-pool can map different keys to
   * different models (`<ENV>_MODEL_<n>`), so the model a call lands on — and thus what it
   * supports — is only known per-call. Conservative FLOOR for anything unrecognised, so a model
   * the table doesn't know behaves exactly as before the capability layer existed.
   */
  public capabilitiesForKey(keyResult: KeyResult, lite?: boolean): ModelCapabilities {
    return capabilitiesFor(keyResult.provider, this.pickModel(keyResult, lite));
  }

  /** Best-effort capabilities for the currently-configured model — for UI/status surfacing. */
  public async activeCapabilities(lite?: boolean): Promise<ModelCapabilities> {
    const model = this.userModel || this.defaultModel;
    const quick = lite ? this.quickModel() : undefined;
    if (quick) return capabilitiesFor(undefined, quick);
    return capabilitiesFor(undefined, model);
  }

  private async getKey(): Promise<KeyResult> {
    const kr = await this.apiKeyManager.getNextKey();
    if (!kr.keyStr || kr.idx === null) throw new Error(`[LlmAdapter] FATAL: No API keys configured.`);
    // Request-path visibility (BIMAX_LLM_TRACE=1): which key each call lands on and why turns
    // stall is otherwise invisible — this one line made the sub-agent hang diagnosable.
    if (process.env.BIMAX_LLM_TRACE === '1') {
      Logger.info(`[LlmAdapter] → key #${(kr.idx ?? 0) + 1} (${kr.provider || '?'}) model=${this.userModel || this.defaultModel}`);
    }
    if (kr.waitTimeSecs > 0) {
      // Auth-dead pool: every key's last failure was 401/403. That is permanent for these key
      // strings — sleeping through the cooldown and re-sending the same key can never succeed, it
      // just made every turn feel hung (5s of silence per attempt). Fail fast and tell the user
      // exactly how to fix it. (A key repaired mid-session recovers via reportKeyResult on success.)
      if (this.apiKeyManager.allKeysAuthDead()) {
        throw new Error(
          `Provider rejected the API key (${kr.provider || 'active provider'}: unauthorized). ` +
          `The key is expired or invalid — update it with /keys or in ~/.breakglass/.env, then retry.`,
        );
      }
      Logger.warn(`[LlmAdapter] All keys cooling down (rate limit / transient). Sleeping ${kr.waitTimeSecs.toFixed(1)}s...`);
      await new Promise(resolve => setTimeout(resolve, kr.waitTimeSecs * 1000));
    }
    return kr;
  }

  // Rough cost estimate at a flat $0.002 / 1K tokens. One place instead of the ~12 copies of this
  // arithmetic (and the bare 0.002) that used to be scattered through every API method below.
  private estCost(tokens: number): number {
    return (tokens / 1000) * 0.002;
  }

  // A failure that happened on THIS machine's network path — DNS refused to resolve, the socket
  // never connected, or it reset before the provider said anything. The provider never saw the
  // request, so the API key must not be blamed: cooling/benching the key for a local blip is how
  // one DNS hiccup snowballed into "all keys cooling down" minutes (observed live on a 1-key
  // pool, and this Mac's DNS genuinely drops out intermittently — same family as its git-fetch
  // hangs). These report as status 0, which the key manager treats as neutral.
  static isLocalNetworkError(e: any): boolean {
    const codes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
    for (let err = e; err; err = err.cause) {
      if (err?.code && codes.has(String(err.code))) return true;
      if (/getaddrinfo|nodename nor servname|socket hang up|other side closed/i.test(String(err?.message || ''))) return true;
    }
    // OpenAI SDK connection errors with no HTTP status = the request never reached the API.
    return e instanceof OpenAI.APIConnectionError && !(e instanceof OpenAI.APIConnectionTimeoutError) && e?.status == null;
  }

  // Map an OpenAI/network error to a status code: local network failure → 0 (neutral — never
  // bills the key), timeout → 408, otherwise the API-reported status, else 500. Was copy-pasted
  // verbatim in every method's catch block.
  private errorStatus(e: any): number {
    if (LlmAdapter.isLocalNetworkError(e)) return 0;
    if (e instanceof OpenAI.APIConnectionTimeoutError || e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message || '')) return 408;
    return e?.status || 500;
  }

  // WS1.3 (MASTER_REBUILD_PLAN): a 400 "model not found" must name WHICH provider rejected WHICH
  // model and how to fix it — not just dump the raw API error. The key pool is single-provider by
  // design (provider.ts:buildKeyPool), so this mismatch always means "the configured model id
  // isn't in the active provider's namespace". Rewrites e.message in place when it matches;
  // no-op for every other error, so existing classification/retry behavior is untouched.
  private enrichModelNotFound(e: any, kr: KeyResult, lite?: boolean, attemptedModel?: string): void {
    if (![400, 404, 410].includes(e?.status ?? 0)) return;
    const raw = String(e?.message || '');
    const model = attemptedModel || this.pickModel(kr, lite);
    const provider = kr.provider || 'the active provider';
    if ((e?.status ?? 0) === 410) {
      this.markUnservable(model);
      const strictKimiK3 = !!this.strictModel && /kimi-k3/i.test(model);
      const recovery = strictKimiK3
        ? 'Open Bimax Settings → Models → Providers and add or select an NVIDIA API key for Kimi K3.'
        : `Switch to a provider that still serves this model.`;
      e.message = `Model "${model}" is not served by provider "${provider}" (HTTP 410 Gone). ${recovery} ` +
        `(API said: ${raw.trim() || 'the model endpoint is gone'})`;
      return;
    }
    if ((e?.status ?? 0) !== 404 && e?.code !== 'model_not_found' &&
        !(/model/i.test(raw) && /not.{0,4}found|not.{0,4}a.{0,4}valid|does not exist|invalid|unknown|no such|unavailable/i.test(raw))) return;
    // The provider just told us this id is not real. Record it so /models membership can no longer
    // vouch for it: NVIDIA lists ids it then 404s, and trusting the listing is what let a healed
    // config stay permanently broken.
    this.markUnservable(model);
    e.message = `Model "${model}" is not served by provider "${provider}". ` +
      `Run /model to pick an id ${provider} serves, or /provider to switch to the provider that has it. ` +
      `(API said: ${raw.trim()})`;
  }

  async generateTinyPlans(userPrompt: string, systemContext: string) {
    const kr = await this.getKey();
    const client = this.createClient(kr);
    
    // Budget checking heuristics: ~100 tokens out, 50 in for tiny plans
    const estimatedTokens = 150;
    const estimatedCostUsd = this.estCost(estimatedTokens); // Very rough estimate
    if (this.budgetVeto) {
      await this.budgetVeto.checkVeto(estimatedCostUsd);
    }
    
    try {
      // Native fast-path: a model with constrained-output support is told to emit a JSON object,
      // so the plan comes back well-formed instead of wrapped in prose/fences. `extractJson` below
      // remains the universal fallback (and handles models that ignore the hint), so floor models —
      // for whom this field is omitted — are unaffected.
      const planReq: any = {
        model: this.pickModel(kr),
        messages: [
          { role: 'system', content: systemContext },
          { role: 'user', content: userPrompt }
        ]
      };
      if (this.capabilitiesForKey(kr).structuredOutputs) {
        planReq.response_format = { type: 'json_object' };
      }
      const response = await client.chat.completions.create(planReq, { timeout: this.requestTimeout });

      const usage = response.usage;
      if (this.budgetVeto && usage) {
        const actualCostUsd = this.estCost(usage.prompt_tokens + usage.completion_tokens);
        await this.budgetVeto.recordSpend(actualCostUsd, estimatedCostUsd);
      }

      this.apiKeyManager.reportKeyResult(kr.idx!, 200);
      // Models often wrap the plan in a markdown fence or prose; extract the raw JSON before parsing.
      const content = extractJson(stripThink(response.choices?.[0]?.message?.content || ""));
      return { status: 200, data: JSON.parse(content || "{}"), retryAfter: null };
    } catch (error: any) {
      if (this.budgetVeto) {
        await this.budgetVeto.releaseReservation(estimatedCostUsd);
      }
      Logger.error(`[LlmAdapter] Network Error: ${error.message}`);
      const status = this.errorStatus(error);
      let retryAfter: number | null = null;
      if (error.headers?.['retry-after']) retryAfter = parseFloat(error.headers['retry-after']);
      else if (status === 429) retryAfter = 5;
      this.apiKeyManager.reportKeyResult(kr.idx!, status, retryAfter);
      return { status, data: null, retryAfter, error };
    }
  }

  async generateXmlCompletion(userPrompt: string, systemContext: string, maxTokens: number = 64) {
    const kr = await this.getKey();
    const client = this.createClient(kr);
    const estimatedCostUsd = this.estCost(maxTokens);
    if (this.budgetVeto) await this.budgetVeto.checkVeto(estimatedCostUsd);

    try {
      const response = await client.chat.completions.create({
        model: this.pickModel(kr),
        messages: [
          { role: 'system', content: systemContext },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: maxTokens,
        ...this.samplingFieldsFor(this.pickModel(kr), 0.0)
      }, { timeout: this.requestTimeout });
      this.apiKeyManager.reportKeyResult(kr.idx!, 200);
      const usage = response.usage;
      if (this.budgetVeto && usage) {
        const actualCostUsd = this.estCost(usage.prompt_tokens + usage.completion_tokens);
        await this.budgetVeto.recordSpend(actualCostUsd, estimatedCostUsd);
      } else if (this.budgetVeto) {
        await this.budgetVeto.recordSpend(estimatedCostUsd, estimatedCostUsd);
      }
      return { status: 200, content: stripThink(response.choices?.[0]?.message?.content || ""), retryAfter: null };
    } catch (error: any) {
      if (this.budgetVeto) await this.budgetVeto.releaseReservation(estimatedCostUsd);
      Logger.error(`[LlmAdapter] Network Error: ${error.message}`);
      const status = this.errorStatus(error);
      this.apiKeyManager.reportKeyResult(kr.idx!, status);
      return { status, content: "", retryAfter: null, error };
    }
  }

  async generateChatResponse(messages: any[], systemContext: string) {
    const kr = await this.getKey();
    const client = this.createClient(kr);
    const estimatedTokens = this.maxTokens || 4096;
    const estimatedCostUsd = this.estCost(estimatedTokens);
    if (this.budgetVeto) await this.budgetVeto.checkVeto(estimatedCostUsd);

    try {
      const response = await client.chat.completions.create({
        model: this.pickModel(kr),
        messages: [
          { role: 'system', content: systemContext },
          ...messages
        ],
        ...this.samplingFieldsFor(this.pickModel(kr), this.temperature),
        max_tokens: this.maxTokens,
      }, { timeout: this.requestTimeout });
      this.apiKeyManager.reportKeyResult(kr.idx!, 200);
      const usage = response.usage;
      if (usage) {
        Logger.info(`[LlmAdapter] Token Usage - Prompt: ${usage.prompt_tokens} | Completion: ${usage.completion_tokens} | Total: ${usage.total_tokens}`);
        if (this.budgetVeto) {
          const actualCostUsd = this.estCost(usage.prompt_tokens + usage.completion_tokens);
          await this.budgetVeto.recordSpend(actualCostUsd, estimatedCostUsd);
        }
      } else if (this.budgetVeto) {
        await this.budgetVeto.recordSpend(estimatedCostUsd, estimatedCostUsd);
      }
      return { status: 200, content: stripThink(response.choices?.[0]?.message?.content || ""), retryAfter: null };
    } catch (error: any) {
      if (this.budgetVeto) await this.budgetVeto.releaseReservation(estimatedCostUsd);
      Logger.error(`[LlmAdapter] Network Error: ${error.message}`);
      const status = this.errorStatus(error);
      this.apiKeyManager.reportKeyResult(kr.idx!, status);
      return { status, content: "", retryAfter: null, error };
    }
  }

  async generateSemanticMetadata(nodeId: string, nodeName: string, type: string, codeSnippet: string) {
    const systemContext = `You are a structural semantic analyzer. Return a JSON object with:
    - purpose (string, max 15 words)
    - criticality (string: 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
    - riskScore (number: 0 to 100)
    Based on the following code snippet.`;
    const userPrompt = `Node ID: ${nodeId}\nNode Name: ${nodeName}\nType: ${type}\nCode:\n${codeSnippet}`;
    const kr = await this.getKey();
    const client = this.createClient(kr);
    const estimatedCostUsd = this.estCost(200);
    if (this.budgetVeto) await this.budgetVeto.checkVeto(estimatedCostUsd);

    try {
      // Capability-gated structured output: only ask for a JSON object when the model supports it
      // (sending response_format to a model that lacks it 400s — e.g. the minimax default). extractJson
      // below is the universal fallback that recovers JSON from fenced/prose output for the rest.
      const metaReq: any = {
        model: this.pickModel(kr),
        messages: [
          { role: 'system', content: systemContext },
          { role: 'user', content: userPrompt }
        ],
      };
      if (this.capabilitiesForKey(kr).structuredOutputs) {
        metaReq.response_format = { type: "json_object" };
      }
      const response = await client.chat.completions.create(metaReq, { timeout: this.requestTimeout });
      this.apiKeyManager.reportKeyResult(kr.idx!, 200);
      const usage = response.usage;
      if (this.budgetVeto && usage) {
        const actualCostUsd = this.estCost(usage.prompt_tokens + usage.completion_tokens);
        await this.budgetVeto.recordSpend(actualCostUsd, estimatedCostUsd);
      } else if (this.budgetVeto) {
        await this.budgetVeto.recordSpend(estimatedCostUsd, estimatedCostUsd);
      }
      return JSON.parse(extractJson(stripThink(response.choices?.[0]?.message?.content || "")) || "{}");
    } catch (e: any) {
      if (this.budgetVeto) await this.budgetVeto.releaseReservation(estimatedCostUsd);
      this.apiKeyManager.reportKeyResult(kr.idx!, this.errorStatus(e));
      Logger.error(`[LlmAdapter] Failed semantic analysis for ${nodeId}`);
      return null;
    }
  }

  async chatCompletion(messages: any[], systemContext?: string, opts?: { lite?: boolean }): Promise<string> {
    const kr = await this.getKey();
    const client = this.createClient(kr);
    const estimatedTokens = this.maxTokens || 4096;
    const estimatedCostUsd = this.estCost(estimatedTokens);
    if (this.budgetVeto) await this.budgetVeto.checkVeto(estimatedCostUsd);

    // Once the provider has ANSWERED, the key did its job — a later client-side failure (response
    // parsing, budget bookkeeping) must never re-bill the key as a server error. Without this flag
    // a malformed-but-200 response threw at `.choices[0]`, the catch reported 500, and the sole
    // key went on a 5s cooldown the NEXT call slept out ("All keys cooling down… Sleeping 2.8s"):
    // ~4s of self-inflicted first-token latency per turn, measured live against a 120ms mock.
    let keySettled = false;
    try {
      const finalMessages = systemContext
        ? [{ role: 'system', content: systemContext }, ...messages]
        : messages;
      const chatModel = this.pickModel(kr, opts?.lite, LlmAdapter.messagesHaveImages(finalMessages));
      const response = await client.chat.completions.create({
        model: chatModel,
        messages: finalMessages,
        ...this.samplingFieldsFor(chatModel, this.temperature),
        max_tokens: this.maxTokens,
      }, { timeout: this.requestTimeout });
      this.apiKeyManager.reportKeyResult(kr.idx!, 200);
      keySettled = true;
      const usage = response.usage;
      if (this.budgetVeto && usage) {
        const actualCostUsd = this.estCost(usage.prompt_tokens + usage.completion_tokens);
        await this.budgetVeto.recordSpend(actualCostUsd, estimatedCostUsd);
      } else if (this.budgetVeto) {
        await this.budgetVeto.recordSpend(estimatedCostUsd, estimatedCostUsd);
      }
      return stripThink(response.choices?.[0]?.message?.content || "");
    } catch (e: any) {
      if (this.budgetVeto) await this.budgetVeto.releaseReservation(estimatedCostUsd);
      // Report the REAL status (429/408/…), not a blanket 500 — the key manager's rotation
      // and backoff decisions depend on it (a 429 key should cool down, not be marked broken).
      if (!keySettled) this.apiKeyManager.reportKeyResult(kr.idx!, this.errorStatus(e));
      this.enrichModelNotFound(e, kr, opts?.lite);
      throw e;
    }
  }

  async *generateChatResponseStream(
    messages: any[],
    systemContext?: string,
  ): AsyncGenerator<string> {
    const kr = await this.getKey();
    const client = this.createClient(kr);
    const estimatedTokens = this.maxTokens || 4096;
    const estimatedCostUsd = this.estCost(estimatedTokens);
    if (this.budgetVeto) await this.budgetVeto.checkVeto(estimatedCostUsd);

    try {
      const finalMessages = systemContext
        ? [{ role: 'system', content: systemContext }, ...messages]
        : messages;
      const stream = await client.chat.completions.create({
        model: this.pickModel(kr),
        messages: finalMessages,
        stream: true,
        ...this.samplingFieldsFor(this.pickModel(kr), this.temperature),
        max_tokens: this.maxTokens,
      }, { timeout: this.requestTimeout });
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content || '';
        if (token) yield token;
      }
      if (this.budgetVeto) await this.budgetVeto.recordSpend(estimatedCostUsd, estimatedCostUsd);
      this.apiKeyManager.reportKeyResult(kr.idx!, 200);
    } catch (e: any) {
      if (this.budgetVeto) await this.budgetVeto.releaseReservation(estimatedCostUsd);
      const status = this.errorStatus(e);
      this.apiKeyManager.reportKeyResult(kr.idx!, status);
      this.enrichModelNotFound(e, kr);
      throw e;
    }
  }

  /**
   * Provider-level circuit breaker. The ApiKeyManager already breaks/rotates PER KEY; this sits
   * above it to detect a whole-provider outage (every key failing) and force a short cool-down so
   * the agent loop backs off instead of hot-retrying chat() into a dead provider. Tuned loose so it
   * only trips on a sustained aggregate failure: 8 samples over 60s, 70% failure rate, 5s cool-down.
   * Disable with BGW_LLM_BREAKER=false. (Ported from Grok Build's xai-circuit-breaker.)
   */
  private readonly providerBreaker = new CircuitBreaker({
    ...serverConfig(),
    minSamples: 8,
    errorRateThreshold: 0.7,
    windowDurationMs: 60_000,
    openDurationMs: 5_000,
    enabled: process.env.BGW_LLM_BREAKER !== 'false',
  });

  async *chat(messages: Message[], options: ChatOptions): AsyncGenerator<ChatEvent> {
    // Shed BEFORE acquiring a key or hitting the wire: if the provider has been failing across keys,
    // yield a recoverable error so the agent loop waits out the cool-down instead of hammering.
    try {
      this.providerBreaker.check();
    } catch (e) {
      if (e instanceof BreakerOpen) {
        const retryAfterSecs = Math.ceil(e.retryAfterMs / 1000);
        yield { type: 'error', message: `LLM provider is failing across all keys — backing off ${retryAfterSecs}s before retrying.`, recoverable: true, kind: 'transient', retryAfterSecs };
        return;
      }
      throw e;
    }
    const kr = await this.getKey();
    const client = this.createClient(kr);
    const estimatedTokens = options.maxTokens || this.maxTokens || 4096;
    const estimatedCostUsd = this.estCost(estimatedTokens);
    if (this.budgetVeto) await this.budgetVeto.checkVeto(estimatedCostUsd);
    // Declared outside the try so the catch can tell whether the reservation was
    // already settled by a mid-stream usage report — otherwise an error after the
    // usage chunk would release the same reservation twice (under-counting spend).
    let usageRecorded = false;
    let attemptedModel: string | undefined;

    try {
      let finalMessages: any[] = options.system
        ? [{ role: 'system', content: options.system }, ...messages]
        : messages;

      if (kr.provider === 'nvidia' || String(kr.baseURL || '').includes('api.nvidia.com')) {
        finalMessages = normalizeNvidiaMessages(finalMessages);
      }

      // Resolve the model BEFORE any image handling: an image-bearing turn is exactly what
      // reroutes to the dedicated vision slot (pickModel), so the images must still be present
      // when the pick happens. Deriving caps from the RESOLVED model also keeps every knob below
      // (sampling, reasoning, caching) aligned with the model actually called.
      const model = this.pickModel(kr, options.lite, LlmAdapter.messagesHaveImages(finalMessages));
      attemptedModel = model;
      const caps = capabilitiesFor(kr.provider, model);
      const primary = (options.lite && this.quickModel()) || this.userModel || kr.model || this.defaultModel;
      if (LlmAdapter.messagesHaveImages(finalMessages) && model !== primary) {
        engineEvents.emit('status', `Vision → ${model}`);
      }

      // Vision safety net: only if the RESOLVED model (after any vision-slot reroute) still can't
      // see images do we flatten image_url parts to a "[image]" text placeholder — never send
      // multimodal content to a model that would 400 on it. Ordering bug fixed 2026-07-17: this
      // used to run on the PRIMARY model's caps before the reroute, silently eating the screenshot
      // the vision slot existed to see.
      if (!caps.visionInput && finalMessages.some(m => Array.isArray(m.content))) {
        finalMessages = finalMessages.map(m => Array.isArray(m.content) ? { ...m, content: contentToText(m.content) } : m);
      }

      // Native fast-path: prompt caching. When the active model supports Anthropic `cache_control`
      // (Claude, via OpenRouter/native/Bedrock), mark the large stable system prompt as a cache
      // breakpoint so repeated turns in a session re-bill it at the cheap cached rate. For every
      // other model this branch is skipped and messages stay as plain strings (FLOOR = unchanged).
      // BiMax's universal answer to the same problem is the graph-native context engine (send less),
      // which runs regardless — caching simply stacks on top when the model can do it.
      // Two breakpoints (system + conversation tail) so the WHOLE stable prefix caches, not just the
      // system prompt — the big win is each tool round within a turn re-reading the history from cache
      // instead of re-billing it. (Adapted from Claude Code's cache-aware hot path; see
      // docs/ENGINE_TUI_COMPARISON.md §A4.)
      if (caps.promptCaching && options.system && finalMessages.length > 0) {
        finalMessages = applyCacheBreakpoints(finalMessages);
      }

      const sampling = this.resolveSampling(model, options.temperature);
      const requestOptions: any = {
        model,
        messages: finalMessages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: options.maxTokens ?? this.maxTokens,
      };
      // WS1.4 — per-provider request shaping: o-series/gpt-5 reject temperature/top_p overrides
      // (400 "Unsupported value"). Only attach sampling when the model accepts it; every other
      // model gets exactly the fields it got before.
      if (!caps.fixedSampling) {
        requestOptions.temperature = sampling.temperature;
        requestOptions.top_p = sampling.top_p;
      }

      if (options.tools && options.tools.length > 0) {
        requestOptions.tools = options.tools.map((t: any) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema || t.parameters
          }
        }));
        requestOptions.tool_choice = options.toolChoice || 'auto';
        // NVIDIA NIM and several other OpenAI-compatible backends reject any
        // assistant turn that emits more than one tool call ("This model only
        // supports single tool-calls at once!"), which hard-aborts the task.
        // The agent loop already executes tool calls sequentially, so constrain
        // the model to one call per turn by default. Opt back in with
        // BGW_PARALLEL_TOOL_CALLS=true for providers that support it.
        // Default ON now (batched tool calls = faster). Only constrain to single-call for backends
        // that reject multi-tool turns, via config / BGW_PARALLEL_TOOL_CALLS=false.
        if (!this.parallelToolCalls || !caps.parallelToolCalls) {
          requestOptions.parallel_tool_calls = false;
        }
      }

      // Optional reasoning budget — only sent when explicitly configured, so default
      // behavior is unchanged. Lets thinking models (minimax) trade depth for speed.
      // Only send reasoning_effort to a model that advertises the knob — several backends 400 on an
      // unknown sampling field. Reasoning models (o-series, deepseek-r1, minimax) are flagged in the
      // table; unknowns can opt in with BGW_CAP_REASONING_EFFORT=true.
      // Kimi K3 defaults to maximum reasoning at the provider, which is a poor interactive default
      // and exceeded the bounded local first-token probes. Prefer its documented low setting unless
      // the user explicitly asks for another effort. Other model families retain their old default.
      const effort = options.reasoningEffort ?? this.reasoningEffort
        ?? (caps.requiresReasoningReplay ? 'low' : undefined);
      if (effort && caps.reasoningEffortKnob) requestOptions.reasoning_effort = effort;

      // C6 — Anthropic beta-header features (1M context, token-efficient tools, interleaved
      // thinking). Host-gated to the genuine Anthropic endpoint and opt-in via BGW_ANTHROPIC_BETA,
      // so on every other backend (the default) this is undefined and the request is unchanged.
      const requestInit: any = { timeout: this.requestTimeout, signal: options.signal as any };
      const betaHeaders = anthropicBetaHeaders(kr.baseURL);
      if (betaHeaders) requestInit.headers = betaHeaders;

      // Perf: mark the exact instant the provider request leaves the engine. Everything before this
      // point is Bimax overhead (routing, context assembly); everything between here and the first
      // meaningful payload is provider wait. The wall-clock twin also feeds per-key latency, so it
      // deliberately starts BEFORE create(): some providers hold response headers while queued.
      // No-op when no turn timeline is active (classifier/critic/sub-agent calls, tests) and
      // idempotent within a turn (only the first streaming call of a turn counts).
      const requestStartMs = Date.now();
      markProviderRequest();
      // NIM's per-key queue holds the RESPONSE HEADERS until the request is granted, so a hung key
      // stalls create() itself — before the stream iterator our chunk watchdog guards even exists.
      // Cap the header wait with the same first-token budget (plain models / multi-key pools get
      // the tight one) so a hung key is benched and the retry rotates instead of waiting minutes.
      const capsSayReasoner = caps.inlineReasoning || caps.nativeThinking || this.detectedReasoners.has(model);
      const createBudgetMs = (!process.env.BGW_FIRST_CHUNK_TIMEOUT_MS && !capsSayReasoner && this.apiKeyManager.size() > 1)
        ? Math.min(this.firstChunkTimeoutMs, 60_000)
        : this.firstChunkTimeoutMs;
      requestInit.timeout = Math.min(this.requestTimeout, createBudgetMs);
      let stream: any;
      try {
        stream = await client.chat.completions.create(requestOptions, requestInit);
      } catch (e: any) {
        // The SDK surfaces our header-wait cap as APIConnectionTimeoutError ("Request timed out").
        // Normalize it to the watchdog's message so the catch below benches the key (reportKeyHang).
        if (e?.name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(String(e?.message))) {
          // Attribute from evidence, not assumption: probe the origin in the background so /perf
          // can say WHERE this stall happened (provider-side vs DNS vs network path).
          attributeSlowWait(kr.baseURL || 'https://integrate.api.nvidia.com/v1', createBudgetMs, true);
          throw new Error(`LLM stream timeout: model '${model}' sent no response headers for ${Math.round(createBudgetMs / 1000)}s — benching this key and rotating (run /perf for network-path evidence)`, { cause: e });
        }
        throw e;
      }

      // Accumulate streamed tool calls keyed by their delta `index` — the OpenAI streaming contract:
      // the first delta for an index carries id+name+the start of the args, later deltas append more
      // args. The previous code keyed off the PRESENCE of `tc.id`, assuming it appears only on the
      // first delta; minimax/NIM (and others) repeat `id` on every delta, so that mis-fired a "new
      // call" each chunk and emitted truncated args (`{"query": "`, `richest person`, …) that then
      // failed to parse. One slot per index, yielded only once the stream is complete, fixes it.
      const toolAcc = new Map<number, { id: string; name: string; args: string }>();
      let lastActiveIdx = -1;
      // Throttle live tool-arg partials (C3): a big tool call streams hundreds of arg fragments, and
      // emitting one partial per fragment would drive a UI re-render each time. Coalesce to at most
      // one partial every PARTIAL_EMIT_MS; the final authoritative tool_call always fires regardless.
      const PARTIAL_EMIT_MS = 80;
      let lastPartialAt = 0;
      // Track the provider's stop reason so we can detect a response cut off at the output-token
      // ceiling (finish_reason === 'length') — otherwise a truncated answer is silently presented as
      // if it were complete. Captured per-chunk; the last non-null value is authoritative.
      let finishReason: string | null = null;
      // Native-thinking fast-path: a model with a structured reasoning channel (Claude, o-series,
      // DeepSeek-R1, minimax) delivers its reasoning out-of-band via `reasoning_content`; the
      // content channel is the answer, with no opener-less `</think>` to guard against. Implicit
      // mode buffers leading content until a closer proves it was reasoning — for these models that
      // closer never comes, so it only adds latency (the answer arrives in one burst at stream end).
      // Disable implicit mode when the capability is present so the answer streams token-by-token.
      // FLOOR (caps.nativeThinking=false) leaves this exactly as before: `this.implicitThink`.
      //
      // Also disable it for CONFIRMED non-reasoning models (caps.plainContent, e.g. minimax): their
      // content channel is always the answer, with no opener-less `</think>` closer to wait for. In
      // implicit mode the filter would hold the leading content tentatively (up to the preamble cap)
      // before releasing it — a visible head-of-reply stall that read as "minimax is very very slow".
      // Streaming from token 1 cannot leak reasoning for these models (they don't reason inline).
      // Seed the runtime reasoner set from the table so the preamble cap is placed correctly on the
      // FIRST turn (openerless models emit long CoT then a `</think>`; capping early would slice it).
      // Detection also runs at runtime below, so a model NOT in the table self-corrects the moment it
      // reveals its behaviour.
      if (caps.inlineReasoning || caps.nativeThinking) this.detectedReasoners.add(model);
      const knownReasoner = this.detectedReasoners.has(model);
      // chooseThinkStrategy is the single source of truth (see llm.stream.ts). OPENER-based inline
      // opener-based/native reasoners get implicit=false → a tag-free answer streams from token 1
      // while `<think>…</think>` reasoning is still hidden by the explicit filter path. Only genuinely
      // OPENER-LESS reasoners (step-3.5) and UNKNOWN models buffer the ambiguous leading region.
      const strategy = chooseThinkStrategy(caps, this.implicitThink, knownReasoner);
      const thinkFilter = new ThinkTagFilter(strategy.implicit, /* capPreamble */ strategy.capBounded);

      // Raw-stream capture. Records the exact `content`/`reasoning_content` bytes plus every delta
      // field key the provider sent, then writes them to a dedicated debug file at stream end. This
      // is how we learn the EXACT reasoning delimiter/channel a model uses (e.g. minimax's closer)
      // without guessing. OPT-IN only — set BGW_DEBUG_STREAM=1 to enable. (It does sync disk writes
      // at stream end, so leaving it on by default added I/O to every single turn.)
      const debugStream = process.env.BGW_DEBUG_STREAM === '1' || process.env.BGW_DEBUG_STREAM === 'true';
      let dbgContent = '';
      let dbgReasoning = '';
      const dbgDeltaKeys = new Set<string>();

      const iterator = stream[Symbol.asyncIterator]();
      let receivedFirstPayload = false;
      // First-token budget. Reasoning/cold-start models legitimately take minutes, but a PLAIN
      // model (llama et al) answering in >1min means the provider is queueing/hanging THIS KEY
      // server-side. When the pool can rotate (2+ keys), give plain models a tight budget so a
      // hung key costs ~1min, gets benched (reportKeyHang), and the retry lands on a fast key —
      // instead of every sub-agent turn silently burning the full 180s. Explicit env wins.
      let firstBudgetMs = this.firstChunkTimeoutMs;
      if (!process.env.BGW_FIRST_CHUNK_TIMEOUT_MS && !knownReasoner && !capsSayReasoner && this.apiKeyManager.size() > 1) {
        firstBudgetMs = Math.min(firstBudgetMs, 60_000);
      }
      while (true) {
        const nextPromise = iterator.next();
        // Guard against a silently stalled stream. The first chunk (time-to-first-token) gets a
        // longer budget than later chunks: a cold start is a legitimate long pause, a mid-stream
        // gap is not. The timer MUST be cleared once the chunk arrives, or every chunk leaks a
        // timer (and a later unhandled rejection) — a long reasoning stream would spawn hundreds.
        // Empty role/usage preambles do not consume the first-token phase. Use an absolute deadline,
        // though, so a server cannot keep the request alive forever by dripping empty frames.
        const firstPayloadRemaining = Math.max(1, firstBudgetMs - (Date.now() - requestStartMs));
        const chunkTimeoutMs = receivedFirstPayload ? this.streamReadTimeoutMs : firstPayloadRemaining;
        const phase = receivedFirstPayload ? 'mid-stream' : 'first token';
        let timeoutHandle: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<any>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            // Never assert "provider cold/slow" without evidence: probe the origin in the
            // background so /perf can attribute this stall (provider-side vs DNS vs network path).
            if (!receivedFirstPayload) attributeSlowWait(kr.baseURL || 'https://integrate.api.nvidia.com/v1', Date.now() - requestStartMs, true);
            reject(new Error(`LLM stream timeout: model '${model}' sent no ${phase} for ${Math.round(chunkTimeoutMs / 1000)}s — not a tool error (run /perf for network-path evidence)`));
          }, chunkTimeoutMs);
        });

        let result: any;
        try {
          result = await Promise.race([nextPromise, timeoutPromise]);
        } catch (raceErr) {
          // The stall timer (or the stream itself) rejected. If the timer won, `nextPromise` is now
          // an ORPHAN — if the underlying iterator later rejects (socket reset on a dead stream),
          // that becomes an unhandledRejection, which kills the whole process on modern Node.
          // Silence the orphan and abort the HTTP stream so the socket is actually released
          // instead of lingering until the provider closes it.
          nextPromise.catch(() => { /* orphaned after timeout — already handled via raceErr */ });
          try { (stream as any)?.controller?.abort?.(); } catch { /* best-effort close */ }
          throw raceErr;
        } finally {
          clearTimeout(timeoutHandle!);
        }
        if (result.done) break;
        const chunk = result.value;
        // Many OpenAI-compatible streams open with an empty role-only delta. It proves the socket is
        // alive, but says nothing about model latency. Only the first meaningful payload teaches the
        // key picker and closes /perf's provider-wait phase; otherwise slow keys look instant and the
        // model's wait is mislabeled as UI render time.
        if (!receivedFirstPayload && hasMeaningfulStreamPayload(chunk)) {
          markFirstRawChunk(); // perf: first meaningful provider payload, not an SSE preamble
          const waitedMs = Date.now() - requestStartMs;
          // Per-round record. markFirstRawChunk above is first-wins for the turn, so on a tool-using
          // turn it only ever describes round 1; this one lands for every round, which is what makes
          // a slow later round attributable instead of averaged away.
          recordProviderRound({ waitMs: waitedMs, model });
          // Latency feedback: teach the key picker which keys answer fast (NIM queues per-key).
          this.apiKeyManager.reportKeyLatency(kr.idx!, waitedMs);
          // Slow-but-successful first token: gather attribution evidence too, so /perf can say
          // whether that long wait was provider-side or a degraded local network path.
          if (waitedMs > SLOW_WAIT_THRESHOLD_MS) {
            attributeSlowWait(kr.baseURL || 'https://integrate.api.nvidia.com/v1', waitedMs, false);
          }
          receivedFirstPayload = true;
        }
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;

        if (debugStream) {
          const delta = chunk.choices?.[0]?.delta;
          if (delta && typeof delta === 'object') {
            for (const k of Object.keys(delta)) dbgDeltaKeys.add(k);
            if (typeof delta.content === 'string') dbgContent += delta.content;
            if (typeof delta.reasoning_content === 'string') dbgReasoning += delta.reasoning_content;
            // Some providers use `reasoning` instead of `reasoning_content`; capture it too.
            if (typeof (delta as any).reasoning === 'string') dbgReasoning += (delta as any).reasoning;
          }
        }

        // Reasoning channel (DeepSeek-R1 / o-series style): never surface as the reply. Its mere
        // presence PROVES this model reasons out-of-band, so the content channel is the answer —
        // learn it (future turns skip buffering) and release anything the filter held tentatively.
        const reasoning = chunk.choices[0]?.delta?.reasoning_content ?? (chunk.choices[0]?.delta as any)?.reasoning;
        if (reasoning) {
          if (!this.detectedReasoners.has(model)) {
            this.detectedReasoners.add(model);
            const released = thinkFilter.releaseAsAnswer();
            if (released) yield { type: 'token', text: released };
          }
          yield { type: 'thinking', text: reasoning, ...(caps.requiresReasoningReplay ? { replay: true } : {}) };
        }

        // Yield tokens, with inline <think> spans diverted to the thinking channel.
        // Normalize <thinking>/<\/thinking> (step-3.7, QwQ, etc.) to the canonical
        // <think>/<\/think> form so the filter handles both tag variants uniformly.
        const rawToken = chunk.choices[0]?.delta?.content;
        if (rawToken) {
          const token = rawToken.replace(/<thinking>/g, '<think>').replace(/<\/thinking>/g, '</think>');
          // A `</think>` in the content channel PROVES this model reasons inline — learn it so later
          // turns lift the preamble cap (wait for the closer instead of capping → no reasoning leak).
          if (token.includes('</think>')) this.detectedReasoners.add(model);
          const { text, thinking } = thinkFilter.process(token);
          if (thinking) yield { type: 'thinking', text: thinking };
          if (text) yield { type: 'token', text };
        }

        // Handle tool calls streaming
        const toolCalls = chunk.choices[0]?.delta?.tool_calls;
        if (toolCalls && toolCalls.length > 0) {
          // The turn is producing a tool call, so any leading content-channel text the model emitted
          // was reasoning (the answer is the call). Divert whatever the filter still holds tentatively
          // to the thinking channel — covers models that reason inline then jump straight to a tool
          // call without ever emitting a `</think>` closer. Idempotent: a no-op after it first fires.
          const stray = thinkFilter.drainPending();
          if (stray) yield { type: 'thinking', text: stray };
          for (const tc of toolCalls) {
            lastActiveIdx = applyToolCallDelta(toolAcc, tc);
          }
          // C3 — live tool-arg streaming. When the model streams partial-JSON tool args, surface the
          // most-recently-updated call (name + args-so-far) as it forms so the UI shows activity before
          // the turn finishes. Display-only: the authoritative `tool_call`(s) fire once at the end.
          // FLOOR (caps.partialJsonTools=false) never emits this, so behavior is unchanged. Throttled
          // so a large tool call doesn't flood the UI with a re-render per arg fragment.
          if (caps.partialJsonTools && lastActiveIdx >= 0) {
            const now = Date.now();
            if (now - lastPartialAt >= PARTIAL_EMIT_MS) {
              lastPartialAt = now;
              const slot = toolAcc.get(lastActiveIdx)!;
              yield { type: 'tool_call_partial', id: slot.id || `idx-${lastActiveIdx}`, name: slot.name, args: slot.args };
            }
          }
        }
        
        // Handle usage if present in the stream (requires stream_options in some models).
        // Guard against a provider sending more than one usage chunk: record once, or
        // the reservation would be released repeatedly.
        if (chunk.usage && !usageRecorded) {
          // Coerce token counts to real numbers: several providers omit completion_tokens (or send
          // null) on mid-stream usage chunks, and `prompt + undefined` is NaN — which would poison
          // the context manager's token tracking AND the budget's currentDailySpend (NaN > cap is
          // always false, so the daily veto silently never fires again, and NaN gets persisted).
          const promptToks = Number(chunk.usage.prompt_tokens) || 0;
          const completionToks = Number(chunk.usage.completion_tokens) || 0;
          const cacheRead = chunk.usage.cache_read_input_tokens ?? 0;
          const cacheCreate = chunk.usage.cache_creation_input_tokens ?? 0;
          // The provider told us; record it as provider-sourced usage. Rounds with no usage chunk
          // stay `unavailable` rather than being back-filled from a character count.
          attachRoundUsage(providerUsage({
            inputTokens: promptToks,
            outputTokens: completionToks,
            cachedInputTokens: Number(cacheRead) || 0,
            cacheCreationTokens: Number(cacheCreate) || 0,
          }));
          globalTelemetry.recordUsage(promptToks, cacheRead, cacheCreate);
          yield { type: 'usage', prompt: promptToks, completion: completionToks };
          if (this.budgetVeto) {
            const actualCostUsd = this.estCost(promptToks + completionToks);
            await this.budgetVeto.recordSpend(actualCostUsd, estimatedCostUsd);
          }
          usageRecorded = true;
        }
      }

      if (debugStream && (dbgContent || dbgReasoning)) {
        // Write to a dedicated file (not console/Logger) so the TUI is never corrupted. JSON.stringify
        // shows whitespace/special tokens literally, so the exact reasoning delimiter is visible.
        try {
          const fs = require('fs');
          const path = require('path');
          const dir = path.join(stateDir('.breakglass'), 'logs');
          fs.mkdirSync(dir, { recursive: true });
          const rec = {
            ts: new Date().toISOString(),
            model,
            hadTools: !!(options.tools && options.tools.length),
            deltaKeys: [...dbgDeltaKeys],
            reasoningLen: dbgReasoning.length,
            contentLen: dbgContent.length,
            content: dbgContent.slice(0, 4000),
            reasoning_content: dbgReasoning.slice(0, 2000),
          };
          fs.appendFileSync(path.join(dir, 'stream-debug.log'), JSON.stringify(rec) + '\n', 'utf-8');
        } catch { /* diagnostic only — never break the stream */ }
      }

      // Flush any text held back by the think-tag filter
      const tail = thinkFilter.flush();
      if (tail.thinking) yield { type: 'thinking', text: tail.thinking };
      if (tail.text) yield { type: 'token', text: tail.text };

      // Yield every accumulated tool call, in index order, now that the stream is complete.
      // (Skips empty slots a provider may have opened without a name.)
      //
      // "each one's arguments are whole" holds only when the model chose to stop. If it hit the
      // output-token ceiling instead, the call it was still writing is cut mid-JSON — observed live
      // as `{"action": "click", "elementIndex": 14, "frameId": "f20-65050-67`, which the agent loop
      // reported as "Failed to parse arguments", i.e. as the model's fault. Only the LAST call can
      // be the partial one, so mark it and let the loop give advice that matches the real cause.
      for (const slot of finalizeToolCalls(toolAcc, finishReason)) {
        yield {
          type: 'tool_call',
          id: slot.id || `call-${Date.now()}-${slot.name}`,
          name: slot.name,
          args: slot.args,
          ...(slot.truncated ? { truncated: true } : {}),
        };
      }

      // Output-limit truncation with no tool call at all: the answer itself is cut off. Signalled
      // separately because the loop's recovery differs — it auto-continues the reply rather than
      // reporting a tool failure.
      if (finishReason === 'length' && toolAcc.size === 0) {
        yield { type: 'truncated' };
      }

      yield { type: 'done' };

      // Only fall back to the estimate if the stream never reported real usage,
      // otherwise we would double-count the spend already recorded above.
      if (this.budgetVeto && !usageRecorded) {
        await this.budgetVeto.recordSpend(estimatedCostUsd, estimatedCostUsd); // Rough fallback
      }
      this.apiKeyManager.reportKeyResult(kr.idx!, 200);
      this.providerBreaker.record(Outcome.Success);

    } catch (e: any) {
      // Only release if a mid-stream usage report hasn't already settled the
      // reservation, otherwise we would release it a second time.
      if (this.budgetVeto && !usageRecorded) await this.budgetVeto.releaseReservation(estimatedCostUsd);

      this.enrichModelNotFound(e, kr, options.lite, attemptedModel);
      const { status, recoverable, kind, retryAfterSecs } = classifyStreamError(e);
      // A first-token timeout means the provider is queueing/hanging THIS key — bench it so
      // rotation stops feeding the dead lane (reportKeyResult alone gives it a 2s cooldown,
      // which put it right back in the mix). Message text is the watchdog's own, matched here.
      if (typeof e?.message === 'string' && /sent no (first token|response headers)/.test(e.message)) {
        this.apiKeyManager.reportKeyHang(kr.idx!);
      }
      this.apiKeyManager.reportKeyResult(kr.idx!, status, retryAfterSecs ?? null);
      // Feed the provider breaker: count only provider-side faults (5xx/429/timeouts), so a client
      // error (400 bad request, 401 auth) — the provider responding fine — never trips the breaker.
      // USER CANCELLATION is not a provider fault at all: an aborted request (Ctrl+C/esc) has no
      // status and would otherwise count as a timeout — a user interrupting three long streams
      // must never open the breaker. Record nothing for aborts.
      const userAborted = options.signal?.aborted || e?.name === 'AbortError' || /abort/i.test(String(e?.message || ''));
      if (!userAborted) this.providerBreaker.record(isProviderFault(status) ? Outcome.Failure : Outcome.Success);
      yield { type: 'error', message: e.message, recoverable, kind, retryAfterSecs };
    }
  }
}
