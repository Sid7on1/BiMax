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
import { CircuitBreaker, Outcome, BreakerOpen, serverConfig } from './circuit-breaker';
import { assertEgressAllowed } from '../security/egress.guard';
import { buildWireTools, renameHistoryToolCalls, schemaFlavorFor, ToolNameMap } from './tool.wire';
import { hedgedRequest, isLoopbackEndpoint } from './hedged.request';
import { ChatStreamReader, nextChunkWithin } from './chat.stream.reader';
import { ProviderStallError, errorStatus, isLocalNetworkError, isProviderFault, isRequestTimeout, isUserAbort, retryAfterSecs } from './llm.errors';
import { normalizeNvidiaMessages, normalizeProviderErrorResponse, requestUrlOf } from './provider.quirks';
// Re-exported: callers and tests import these from the adapter.
export { isProviderFault, normalizeNvidiaMessages, normalizeProviderErrorResponse };

export {
  markCacheBreakpoint, withCacheControl, applyCacheBreakpoints, applyToolCallDelta, finalizeToolCalls, classifyStreamError,
  ThinkTagFilter, stripThink, extractJson, chooseThinkStrategy, hasMeaningfulStreamPayload,
};
export type { ToolCallSlot };

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
  /** Logged once per engine: a tool list over the per-request cap (tool.wire.ts). */
  private warnedToolCap = false;
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
  // A request with no response headers after this long gets one backup copy on another key
  // (hedgedRequest). NIM grants in ~0.4–1.1 s; a held request was measured past 60 s. 0 turns it off.
  public hedgeAfterMs = parseInt(process.env.BGW_HEDGE_AFTER_MS || '8000', 10);
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
        // Quick and Vision are OPTIONAL slots: empty means "answer with the work model". Leaving a
        // dead id pinned there made the first quick call of every session fail on a provider that
        // does not serve it (after a provider switch the Quick pin is always the old provider's id).
        // Only the work slot has nothing to fall back to, so only it stays pinned for the user.
        if (slot !== 'work') {
          assign('');
          Logger.warn(`[LlmAdapter] ${slot} model "${current}" ${reason}; no curated replacement, so ${slot} answers with the work model this session.`);
          healed.push({ slot, from: current, to: '' });
          return;
        }
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
    // Waits (bounded) for a key with room in its per-minute budget, re-picking on every wake so a
    // key that another engine freed — or a faster sibling — is used instead of the one that was
    // soonest when the wait began. It used to sleep once and then send on that same key.
    let lastNotice = 0;
    const kr = await this.apiKeyManager.acquire({
      onWait: (waitSecs) => {
        Logger.warn(`[LlmAdapter] All keys cooling down (rate limit / transient). Sleeping ${waitSecs.toFixed(1)}s...`);
        // Say so where the person is looking, at most every 5s: a turn waiting on a rate limit
        // otherwise looks exactly like a turn that hung.
        if (Date.now() - lastNotice > 5_000) {
          lastNotice = Date.now();
          const keys = this.apiKeyManager.size();
          engineEvents.emit('status', `Rate limit — waiting ${Math.ceil(waitSecs)}s for a free ${keys > 1 ? `slot on ${keys} keys` : 'API slot'}`);
        }
      },
    });
    if (!kr.keyStr || kr.idx === null) throw new Error(`[LlmAdapter] FATAL: No API keys configured.`);
    // Request-path visibility (BIMAX_LLM_TRACE=1): which key each call lands on and why turns
    // stall is otherwise invisible — this one line made the sub-agent hang diagnosable.
    if (process.env.BIMAX_LLM_TRACE === '1') {
      Logger.info(`[LlmAdapter] → key #${(kr.idx ?? 0) + 1} (${kr.provider || '?'}) model=${this.userModel || this.defaultModel}`);
    }
    // Auth-dead pool: every key's last failure was 401/403. That is permanent for these key
    // strings — sleeping through the cooldown and re-sending the same key can never succeed, it
    // just made every turn feel hung (5s of silence per attempt). Fail fast and tell the user
    // exactly how to fix it. (A key repaired mid-session recovers via reportKeyResult on success.)
    if (kr.waitTimeSecs > 0 && this.apiKeyManager.allKeysAuthDead()) {
      throw new Error(
        `Provider rejected the API key (${kr.provider || 'active provider'}: unauthorized). ` +
        `The key is expired or invalid — update it in Settings → Models → Providers, then retry.`,
      );
    }
    return kr;
  }

  // Rough cost estimate at a flat $0.002 / 1K tokens. One place instead of the ~12 copies of this
  // arithmetic (and the bare 0.002) that used to be scattered through every API method below.
  private estCost(tokens: number): number {
    return (tokens / 1000) * 0.002;
  }

  /** See llm.errors.ts. Kept on the class because callers and tests ask the adapter. */
  static isLocalNetworkError(e: any): boolean {
    return isLocalNetworkError(e);
  }

  // Map an OpenAI/network error to the status the key pool counts (llm.errors.ts): local network → 0, timeout → 408,
  // else the API's status, else 500. Was copy-pasted verbatim in every method's catch block.
  private errorStatus(e: any): number {
    return errorStatus(e);
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

  /**
   * One non-streaming completion on the next key: the budget reserved, then settled with the provider's usage (or the
   * estimate when it sends none), or released on failure. The key is reported 200 the moment the provider answers — a
   * later client-side failure (parsing, bookkeeping) must never re-bill it: a malformed-but-200 response once threw at
   * `.choices[0]`, the catch reported 500, and the sole key sat out a cooldown the next call slept through (~4s of
   * self-inflicted latency per turn, measured live against a 120ms mock). A failure before that is reported with its
   * real status (429/408/…) and the provider's Retry-After, because rotation and backoff depend on it.
   *
   * Three methods used to carry their own copy of this, and the copies had drifted: one never settled a reservation
   * when the provider sent no usage, one reported every failure as a flat 5-second cooldown (flaw list E42).
   */
  private async completeOnce(
    estimatedTokens: number,
    build: (kr: KeyResult) => any,
    opts: { lite?: boolean; explainModelErrors?: boolean } = {},
  ): Promise<any> {
    const kr = await this.getKey();
    const client = this.createClient(kr);
    const estimatedCostUsd = this.estCost(estimatedTokens);
    if (this.budgetVeto) await this.budgetVeto.checkVeto(estimatedCostUsd);
    let keySettled = false;
    try {
      const response = await client.chat.completions.create(build(kr), { timeout: this.requestTimeout });
      this.apiKeyManager.reportKeyResult(kr.idx!, 200);
      keySettled = true;
      const usage = response.usage;
      if (this.budgetVeto) {
        const spentUsd = usage ? this.estCost(usage.prompt_tokens + usage.completion_tokens) : estimatedCostUsd;
        await this.budgetVeto.recordSpend(spentUsd, estimatedCostUsd, this.pickModel(kr));
      }
      return response;
    } catch (e: any) {
      if (this.budgetVeto) await this.budgetVeto.releaseReservation(estimatedCostUsd);
      if (!keySettled) this.apiKeyManager.reportKeyResult(kr.idx!, this.errorStatus(e), retryAfterSecs(e));
      if (opts.explainModelErrors) this.enrichModelNotFound(e, kr, opts.lite);
      throw e;
    }
  }

  /** A request that asks for a JSON object when the model can promise one (`extractJson` recovers it otherwise). */
  private jsonRequest(kr: KeyResult, systemContext: string, userPrompt: string): any {
    const req: any = {
      model: this.pickModel(kr),
      messages: [
        { role: 'system', content: systemContext },
        { role: 'user', content: userPrompt },
      ],
    };
    // Capability-gated: sending response_format to a model that lacks it 400s (e.g. the minimax default), so floor
    // models get the plain request and `extractJson` pulls the object out of fenced or prose output.
    if (this.capabilitiesForKey(kr).structuredOutputs) req.response_format = { type: 'json_object' };
    return req;
  }

  async generateTinyPlans(userPrompt: string, systemContext: string) {
    try {
      // ~100 tokens out, 50 in for a tiny plan.
      const response = await this.completeOnce(150, (kr) => this.jsonRequest(kr, systemContext, userPrompt));
      // Models often wrap the plan in a markdown fence or prose; extract the raw JSON before parsing.
      const content = extractJson(stripThink(response.choices?.[0]?.message?.content || ''));
      return { status: 200, data: JSON.parse(content || '{}'), retryAfter: null };
    } catch (error: any) {
      Logger.error(`[LlmAdapter] Network Error: ${error.message}`);
      const status = this.errorStatus(error);
      const retryAfter = retryAfterSecs(error) ?? (status === 429 ? 5 : null);
      return { status, data: null, retryAfter, error };
    }
  }

  async generateSemanticMetadata(nodeId: string, nodeName: string, type: string, codeSnippet: string) {
    const systemContext = `You are a structural semantic analyzer. Return a JSON object with:
    - purpose (string, max 15 words)
    - criticality (string: 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
    - riskScore (number: 0 to 100)
    Based on the following code snippet.`;
    const userPrompt = `Node ID: ${nodeId}\nNode Name: ${nodeName}\nType: ${type}\nCode:\n${codeSnippet}`;
    try {
      const response = await this.completeOnce(200, (kr) => this.jsonRequest(kr, systemContext, userPrompt));
      return JSON.parse(extractJson(stripThink(response.choices?.[0]?.message?.content || '')) || '{}');
    } catch {
      Logger.error(`[LlmAdapter] Failed semantic analysis for ${nodeId}`);
      return null;
    }
  }

  async chatCompletion(messages: any[], systemContext?: string, opts?: { lite?: boolean }): Promise<string> {
    const finalMessages = systemContext
      ? [{ role: 'system', content: systemContext }, ...messages]
      : messages;
    const response = await this.completeOnce(this.maxTokens || 4096, (kr) => {
      const chatModel = this.pickModel(kr, opts?.lite, LlmAdapter.messagesHaveImages(finalMessages));
      return {
        model: chatModel,
        messages: finalMessages,
        ...this.samplingFieldsFor(chatModel, this.temperature),
        max_tokens: this.maxTokens,
      };
    }, { lite: opts?.lite, explainModelErrors: true });
    return stripThink(response.choices?.[0]?.message?.content || '');
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
    // `let`: a hedged request (openStream) can be answered first on a second key, which then owns the stream.
    let kr = await this.getKey();
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
      const request = this.buildChatRequest(kr, messages, options, (picked) => { attemptedModel = picked; });
      const { model, caps } = request;

      // One reader per response: it turns chunks into tokens, reasoning and tool calls (chat.stream.reader.ts).
      const reader = new ChatStreamReader({
        model, caps, reasoners: this.detectedReasoners, implicitThink: this.implicitThink, wireNames: request.wireNames,
        debugStream: process.env.BGW_DEBUG_STREAM === '1' || process.env.BGW_DEBUG_STREAM === 'true',
        hadTools: !!(options.tools && options.tools.length),
      });

      // First-token budget. Reasoning/cold-start models legitimately take minutes, but a PLAIN model (llama et al)
      // answering in >1min means the provider is queueing/hanging THIS KEY server-side. When the pool can rotate (2+
      // keys), plain models get a tight budget so a hung key costs ~1min, gets benched (reportKeyHang), and the retry
      // lands on a fast key — instead of every sub-agent turn silently burning the full 180s. Explicit env wins.
      const capsSayReasoner = caps.inlineReasoning || caps.nativeThinking || reader.knownReasoner;
      const tightBudget = !process.env.BGW_FIRST_CHUNK_TIMEOUT_MS && !capsSayReasoner && this.apiKeyManager.size() > 1;
      const firstBudgetMs = tightBudget ? Math.min(this.firstChunkTimeoutMs, 60_000) : this.firstChunkTimeoutMs;

      const opened = await this.openStream(kr, client, request, options, firstBudgetMs);
      kr = opened.key;
      const { stream, startedAt: requestStartMs } = opened;

      const iterator: AsyncIterator<any> = stream[Symbol.asyncIterator]();
      let receivedFirstPayload = false;
      while (true) {
        // Guard against a silently stalled stream. The first chunk (time-to-first-token) gets a longer budget than later
        // chunks: a cold start is a legitimate long pause, a mid-stream gap is not. Empty role/usage preambles do not
        // consume the first-token phase; the deadline is absolute, though, so a server cannot keep the request alive
        // forever by dripping empty frames.
        const chunkTimeoutMs = receivedFirstPayload
          ? this.streamReadTimeoutMs
          : Math.max(1, firstBudgetMs - (Date.now() - requestStartMs));
        const phase = receivedFirstPayload ? 'mid-stream' : 'first token';
        const result = await nextChunkWithin(iterator, chunkTimeoutMs, () => {
          // Never assert "provider cold/slow" without evidence: probe the origin in the background so /perf can
          // attribute this stall (provider-side vs DNS vs network path).
          if (!receivedFirstPayload) attributeSlowWait(kr.baseURL || 'https://integrate.api.nvidia.com/v1', Date.now() - requestStartMs, true);
          return new ProviderStallError(model, phase, chunkTimeoutMs);
        }, () => (stream as any)?.controller?.abort?.());
        if (result.done) break;
        const chunk = result.value;
        // Many OpenAI-compatible streams open with an empty role-only delta. It proves the socket is alive, but says
        // nothing about model latency. Only the first meaningful payload teaches the key picker and closes /perf's
        // provider-wait phase; otherwise slow keys look instant and the model's wait is mislabeled as UI render time.
        if (!receivedFirstPayload && hasMeaningfulStreamPayload(chunk)) {
          markFirstRawChunk(); // perf: first meaningful provider payload, not an SSE preamble
          const waitedMs = Date.now() - requestStartMs;
          // Per-round record. markFirstRawChunk above is first-wins for the turn, so on a tool-using turn it only ever
          // describes round 1; this one lands for every round, which makes a slow later round attributable.
          recordProviderRound({ waitMs: waitedMs, model });
          // Latency feedback: teach the key picker which keys answer fast (NIM queues per-key).
          this.apiKeyManager.reportKeyLatency(kr.idx!, waitedMs);
          // Slow-but-successful first token: gather attribution evidence too, so /perf can say whether that long wait
          // was provider-side or a degraded local network path.
          if (waitedMs > SLOW_WAIT_THRESHOLD_MS) {
            attributeSlowWait(kr.baseURL || 'https://integrate.api.nvidia.com/v1', waitedMs, false);
          }
          receivedFirstPayload = true;
        }

        yield* reader.read(chunk);

        // Usage, if the stream reports it (requires stream_options on some models). Recorded once: a provider sending
        // more than one usage chunk would otherwise release the reservation repeatedly.
        if (chunk.usage && !usageRecorded) {
          yield* this.settleStreamUsage(chunk.usage, kr, estimatedCostUsd);
          usageRecorded = true;
        }
      }

      yield* reader.finish();
      yield { type: 'done' };

      // Only fall back to the estimate if the stream never reported real usage,
      // otherwise we would double-count the spend already recorded above.
      if (this.budgetVeto && !usageRecorded) {
        await this.budgetVeto.recordSpend(estimatedCostUsd, estimatedCostUsd, this.pickModel(kr)); // Rough fallback
      }
      this.apiKeyManager.reportKeyResult(kr.idx!, 200);
      this.providerBreaker.record(Outcome.Success);

    } catch (e: any) {
      // Only release if a mid-stream usage report hasn't already settled the
      // reservation, otherwise we would release it a second time.
      if (this.budgetVeto && !usageRecorded) await this.budgetVeto.releaseReservation(estimatedCostUsd);

      this.enrichModelNotFound(e, kr, options.lite, attemptedModel);
      // The QUICK model was just refused (NVIDIA lists ids it then 404s "for account"), and the work
      // model is a different, healthy id. `quickModel()` already routes every LATER quick call to the
      // work model, but this call used to surface as a failed turn — a greeting that errored while
      // the model the user picked was fine. Ask the loop to re-send it now; it lands on the work model.
      const quickRefused = !!options.lite && !!attemptedModel && attemptedModel === this.liteModel
        && this.isUnservable(attemptedModel) && (this.userModel || this.defaultModel) !== attemptedModel;
      if (quickRefused) {
        this.apiKeyManager.reportKeyResult(kr.idx!, 200); // the key worked; the model id did not
        engineEvents.emit('status', `Quick model ${attemptedModel!.split('/').pop()} is not served — answering with ${String(this.userModel || this.defaultModel).split('/').pop()}`);
        yield { type: 'error', message: e.message, recoverable: true, kind: 'transient', retryAfterSecs: 0 };
        return;
      }
      const { status, recoverable, kind, retryAfterSecs } = classifyStreamError(e);
      // The provider is holding THIS KEY's request (no headers, or no first token) — bench it so rotation stops feeding
      // the dead lane (reportKeyResult alone gives it a 2s cooldown, which put it right back in the mix).
      if (e instanceof ProviderStallError && e.keyIsHeld) this.apiKeyManager.reportKeyHang(kr.idx!);
      this.apiKeyManager.reportKeyResult(kr.idx!, status, retryAfterSecs ?? null);
      // Feed the provider breaker: count only provider-side faults (5xx/429/timeouts), so a client
      // error (400 bad request, 401 auth) — the provider responding fine — never trips the breaker.
      // USER CANCELLATION is not a provider fault at all: an aborted request (Ctrl+C/esc) has no
      // status and would otherwise count as a timeout — a user interrupting three long streams
      // must never open the breaker. Record nothing for aborts.
      if (!isUserAbort(e, options.signal)) this.providerBreaker.record(isProviderFault(status) ? Outcome.Failure : Outcome.Success);
      yield { type: 'error', message: e.message, recoverable, kind, retryAfterSecs };
    }
  }

  /**
   * The request one chat turn sends: the model resolved for this key and these messages, the messages in the shape
   * that provider accepts, sampling, tools under provider-safe names, reasoning effort, and the transport options.
   * Emits the `Vision → model` status when an image turn is rerouted.
   */
  private buildChatRequest(kr: KeyResult, messages: Message[], options: ChatOptions, onModel: (model: string) => void): {
    model: string; caps: ModelCapabilities; requestOptions: any; requestInit: any; wireNames: ToolNameMap;
  } {
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
    onModel(model);
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
    // Two breakpoints (system + conversation tail) so the WHOLE stable prefix caches, not just the
    // system prompt — the big win is each tool round within a turn re-reading the history from cache
    // instead of re-billing it. (Adapted from Claude Code's cache-aware hot path.)
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

    // Wire-name map for this request's tools; identity when no tool name needed rewriting.
    let wireNames: ToolNameMap = new ToolNameMap([]);
    if (options.tools && options.tools.length > 0) {
      // Provider-safe names and schemas (tool.wire.ts): one badly named MCP tool used to make the
      // provider refuse EVERY later request in the session.
      const wire = buildWireTools(options.tools, schemaFlavorFor(kr.provider, model));
      wireNames = wire.names;
      if (wire.dropped.length > 0 && !this.warnedToolCap) {
        this.warnedToolCap = true;
        Logger.warn(`[LlmAdapter] ${options.tools.length} tools exceed the ${wire.defs.length}-per-request limit; left out this turn: ${wire.dropped.slice(0, 8).join(', ')}${wire.dropped.length > 8 ? '…' : ''}`);
      }
      requestOptions.tools = wire.defs;
      requestOptions.messages = renameHistoryToolCalls(requestOptions.messages, wireNames);
      const forced = options.toolChoice?.function?.name;
      requestOptions.tool_choice = forced
        ? { type: 'function', function: { name: wireNames.toWire(forced) } }
        : 'auto';
      // Batched tool calls are faster, so they are on by default; backends that reject a multi-tool turn ("This model
      // only supports single tool-calls at once!", NVIDIA NIM and others) are constrained to one call per turn via
      // config / BGW_PARALLEL_TOOL_CALLS=false or their capability row.
      if (!this.parallelToolCalls || !caps.parallelToolCalls) {
        requestOptions.parallel_tool_calls = false;
      }
    }

    // Optional reasoning budget — sent only when configured, and only to a model that advertises the knob (several
    // backends 400 on an unknown field; unknowns can opt in with BGW_CAP_REASONING_EFFORT=true). Kimi K3 defaults to
    // maximum reasoning at the provider, a poor interactive default that exceeded the bounded first-token probes, so it
    // gets its documented low setting unless the user asks for another. Other families keep their old default.
    const effort = options.reasoningEffort ?? this.reasoningEffort
      ?? (caps.requiresReasoningReplay ? 'low' : undefined);
    if (effort && caps.reasoningEffortKnob) requestOptions.reasoning_effort = effort;
    // GPT-6 on Chat Completions accepts function calling ONLY with reasoning_effort "none"
    // (developers.openai.com/api/docs/models/gpt-6-sol, read 2026-09-28). Any other effort — or
    // the default, "medium" — makes a tool-bearing request fail, so every tool the model has
    // would be unusable. Reasoning still applies to tool-free turns.
    if (caps.toolsRequireNoReasoning && requestOptions.tools) requestOptions.reasoning_effort = 'none';

    // C6 — Anthropic beta-header features (1M context, token-efficient tools, interleaved
    // thinking). Host-gated to the genuine Anthropic endpoint and opt-in via BGW_ANTHROPIC_BETA,
    // so on every other backend (the default) this is undefined and the request is unchanged.
    const requestInit: any = { timeout: this.requestTimeout, signal: options.signal as any };
    const betaHeaders = anthropicBetaHeaders(kr.baseURL);
    if (betaHeaders) requestInit.headers = betaHeaders;

    return { model, caps, requestOptions, requestInit, wireNames };
  }

  /**
   * Send the request and wait for response headers, hedged across keys. Returns the stream, the key that answered
   * (a backup key may win), and when that key's request left the engine.
   *
   * NIM's per-key queue holds the RESPONSE HEADERS until the request is granted, so a hung key stalls create() itself —
   * before the stream iterator the chunk watchdog guards even exists. The header wait is therefore capped with the
   * first-token budget, and a timeout is raised as a {@link ProviderStallError} so the catch in chat() benches the key.
   */
  private async openStream(
    kr: KeyResult, client: OpenAI, request: { model: string; requestOptions: any; requestInit: any },
    options: ChatOptions, firstBudgetMs: number,
  ): Promise<{ stream: any; key: KeyResult; startedAt: number }> {
    // Perf: mark the exact instant the provider request leaves the engine. Everything before this
    // point is Bimax overhead (routing, context assembly); everything between here and the first
    // meaningful payload is provider wait. The wall-clock twin also feeds per-key latency, so it
    // deliberately starts BEFORE create(): some providers hold response headers while queued.
    // No-op when no turn timeline is active (classifier/critic/sub-agent calls, tests) and
    // idempotent within a turn (only the first streaming call of a turn counts).
    const startedAt = Date.now();
    markProviderRequest();
    const headerBudgetMs = Math.min(this.requestTimeout, firstBudgetMs);
    const { model, requestOptions, requestInit } = request;
    try {
      // Hedged: a request NIM is still holding after `hedgeAfterMs` gets one backup copy on another
      // key, and whichever answers first is used (see hedged.request.ts for the measurements). Never
      // for a loopback endpoint — a local server loading a model holds headers too, and a second copy
      // would only double its load.
      const startedKey = kr;
      const hedge = await hedgedRequest<KeyResult, any>({
        first: kr,
        budgetMs: headerBudgetMs,
        hedgeAfterMs: isLoopbackEndpoint(kr.baseURL) ? 0 : this.hedgeAfterMs,
        start: (legKey, budgetMs) => {
          const leg = new AbortController();
          const signal = options.signal ? AbortSignal.any([options.signal as AbortSignal, leg.signal]) : leg.signal;
          const legClient = legKey === startedKey ? client : this.createClient(legKey);
          return {
            promise: legClient.chat.completions.create(requestOptions, { ...requestInit, timeout: budgetMs, signal }),
            abort: () => leg.abort(),
          };
        },
        nextKey: async () => {
          if (options.signal?.aborted) return null;
          const backup = await this.apiKeyManager.getNextKey({ exclude: startedKey.idx ?? undefined });
          if (!backup.keyStr || backup.idx === null || backup.waitTimeSecs > 0 || backup.idx === startedKey.idx) return null;
          // Same provider, endpoint and model, or the backup would be a different request.
          if (backup.provider !== startedKey.provider || (backup.baseURL || '') !== (startedKey.baseURL || '')) return null;
          if ((backup.model || '') !== (startedKey.model || '')) return null;
          return backup;
        },
        onHedge: (backup) => {
          Logger.warn(`[LlmAdapter] KEY #${(startedKey.idx ?? 0) + 1} has not answered in ${Math.round(this.hedgeAfterMs / 1000)}s — sending a backup on key #${(backup.idx ?? 0) + 1}`);
          engineEvents.emit('status', 'Provider is slow — trying a second key');
        },
        onLoser: (loser, waitedMs, error) => {
          if (loser.idx === null) return;
          // Outraced, not failed: teach the picker this key was slow without benching it — the
          // queue is per request, so the same key often answers the next one at once.
          if (error === undefined) this.apiKeyManager.reportKeyLatency(loser.idx, waitedMs);
          else if (loser !== startedKey) this.apiKeyManager.reportKeyResult(loser.idx, classifyStreamError(error).status);
        },
      });
      return hedge.key !== startedKey
        ? { stream: hedge.value, key: hedge.key, startedAt: hedge.startedAt }
        : { stream: hedge.value, key: kr, startedAt };
    } catch (e: any) {
      // The SDK raises our header-wait cap as APIConnectionTimeoutError ("Request timed out"); make it the stall it is,
      // so the catch in chat() benches this key (reportKeyHang).
      if (isRequestTimeout(e)) {
        // Attribute from evidence, not assumption: probe the origin in the background so /perf
        // can say WHERE this stall happened (provider-side vs DNS vs network path).
        attributeSlowWait(kr.baseURL || 'https://integrate.api.nvidia.com/v1', firstBudgetMs, true);
        throw new ProviderStallError(model, 'response headers', firstBudgetMs, { cause: e });
      }
      throw e;
    }
  }

  /** Record a usage chunk: perf and telemetry, the `usage` event, and the spend it settles. */
  private async *settleStreamUsage(usage: any, kr: KeyResult, estimatedCostUsd: number): AsyncGenerator<ChatEvent> {
    // Coerce token counts to real numbers: several providers omit completion_tokens (or send
    // null) on mid-stream usage chunks, and `prompt + undefined` is NaN — which would poison
    // the context manager's token tracking AND the budget's currentDailySpend (NaN > cap is
    // always false, so the daily veto silently never fires again, and NaN gets persisted).
    const promptToks = Number(usage.prompt_tokens) || 0;
    const completionToks = Number(usage.completion_tokens) || 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreate = usage.cache_creation_input_tokens ?? 0;
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
      await this.budgetVeto.recordSpend(actualCostUsd, estimatedCostUsd, this.pickModel(kr));
    }
  }
}
