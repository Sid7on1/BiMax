import OpenAI from 'openai';
import type { ModelCapabilities } from './capabilities';

/**
 * Decide how the streaming `ThinkTagFilter` should treat this model's content channel. Pure so the
 * routing logic (the fix for "short replies don't stream") is unit-testable without a live stream.
 *
 *  - `implicit: false` — stream visible text from the first token. Correct for:
 *      • plainContent models (never reason inline), and
 *      • native out-of-band reasoners (reasoning arrives on `reasoning_content`; content is answer), and
 *      • OPENER-based inline reasoners (step-3.7): their reasoning is always wrapped `<think>…</think>`,
 *        which the explicit filter path hides, so a tag-free answer can stream immediately.
 *  - `implicit: true` — buffer the leading region until a `</think>` closer (or the bounded cap, or a
 *      tool call) resolves it. Required ONLY for OPENER-LESS reasoners and for UNKNOWN models, where
 *      un-tagged leading text is genuinely ambiguous between reasoning and answer.
 *
 * `capBounded` says whether the implicit buffer is bounded (the "bounded hybrid"): true until the
 * model is a CONFIRMED reasoner (table-seeded or runtime-detected), after which the cap lifts so long
 * opener-less CoT isn't sliced and leaked before its closer. Ignored when `implicit` is false.
 */
export function chooseThinkStrategy(
  caps: Pick<ModelCapabilities, 'plainContent' | 'nativeThinking' | 'inlineReasoning' | 'openerlessReasoning'>,
  implicitThinkEnabled: boolean,
  knownReasoner: boolean,
): { implicit: boolean; capBounded: boolean } {
  const needsImplicit =
    !caps.plainContent &&
    !caps.nativeThinking &&
    (caps.openerlessReasoning || !caps.inlineReasoning);
  return { implicit: implicitThinkEnabled && needsImplicit, capBounded: !knownReasoner };
}

// Streaming & response-parsing helpers for the LLM adapter, extracted from llm.adapter.ts to keep
// that file focused on the adapter class. Pure/self-contained (only depends on the OpenAI error
// types + process.env) so every function here is unit-testable in isolation. Re-exported from
// llm.adapter.ts for backward compatibility with existing importers.

/**
 * Mark a chat message's content as a prompt-cache breakpoint (Anthropic `cache_control`,
 * forwarded by OpenRouter / native Anthropic / Bedrock for Claude models). Converts the plain
 * string content into the single-text-part array form the cache marker requires. Pure; only ever
 * called when the active model advertises `promptCaching`, so non-capable models keep plain
 * string content untouched. Returns a NEW message (no mutation of the caller's array).
 */
export function markCacheBreakpoint(msg: any): any {
  if (!msg || typeof msg.content !== 'string' || msg.content.length === 0) return msg;
  return {
    ...msg,
    content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }],
  };
}

/**
 * Attach a `cache_control` breakpoint to a message regardless of content shape — string content is
 * lifted into a single text part; array content gets the marker on its LAST part. Returns the SAME
 * reference when there is nothing markable (empty / tool-call-only content), so callers can detect
 * "couldn't place a breakpoint here" by identity. Pure; never mutates the input.
 */
export function withCacheControl(msg: any): any {
  if (!msg) return msg;
  if (typeof msg.content === 'string') {
    if (msg.content.length === 0) return msg;
    return { ...msg, content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }] };
  }
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    const parts = msg.content.map((p: any) => ({ ...p }));
    parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: { type: 'ephemeral' } };
    return { ...msg, content: parts };
  }
  return msg;
}

/**
 * Place prompt-cache breakpoints so the WHOLE stable prefix is cached, not just the system prompt.
 * Anthropic caches everything up to a `cache_control` marker, so we set two (well under the 4-max):
 *   1. the first message  — the static system prompt (reused every turn of the session).
 *   2. the last markable message — the conversation-so-far, so the NEXT turn AND each tool round
 *      within THIS turn read the accumulated history from cache instead of re-billing it in full.
 * Previously only (1) was marked, leaving the growing conversation — the bulk of a long session — at
 * the uncached rate. No-op-safe: returns a new array; unmarkable tails simply skip breakpoint 2.
 */
export function applyCacheBreakpoints(messages: any[]): any[] {
  if (!messages || messages.length === 0) return messages;
  const out = messages.slice();
  out[0] = withCacheControl(out[0]);
  // Walk from the tail to the first message that can actually hold a breakpoint (skip empty /
  // tool-call-only assistant turns). Stop at index 1 so we never double-mark message[0].
  for (let i = out.length - 1; i >= 1; i--) {
    const marked = withCacheControl(out[i]);
    if (marked !== out[i]) { out[i] = marked; break; }
  }
  return out;
}

/** One accumulated streaming tool call: stable id, name, and the concatenated arguments JSON. */
export interface ToolCallSlot {
  id: string; name: string; args: string;
  /**
   * Provider data attached to the call that must travel back with it on the next request —
   * Gemini 3 carries its thought signature here (`extra_content.google.thought_signature`) and
   * refuses a function-calling continuation without it. Opaque to Bimax; only ever echoed.
   */
  extra?: unknown;
}

/**
 * Whether a streamed completion chunk contains provider output that can advance the turn.
 *
 * OpenAI-compatible servers commonly emit an initial `{ role: "assistant" }` delta before they
 * have generated any content. Treating that transport preamble as the first token makes a slow
 * model look fast, teaches the key picker the wrong latency, and moves the real model wait into
 * `/perf`'s render bucket. Usage-only frames are bookkeeping too. Content, reasoning, tool-call
 * fragments, and a terminal finish reason are the first meaningful payloads.
 */
export function hasMeaningfulStreamPayload(chunk: any): boolean {
  const choice = chunk?.choices?.[0];
  if (!choice) return false;
  const delta = choice.delta;
  if (typeof delta?.content === 'string' && delta.content.length > 0) return true;
  if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) return true;
  if (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0) return true;
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) return true;
  return choice.finish_reason !== undefined && choice.finish_reason !== null;
}

/**
 * Apply ONE streaming `delta.tool_calls[]` entry to an index-keyed accumulator and return its index.
 *
 * The OpenAI streaming contract keys tool-call fragments by `index`: the first delta for an index
 * carries id + name + the start of the arguments; later deltas append more `arguments`. Some
 * providers (minimax/NIM) repeat `id` on every delta, so logic that treated "id present" as "new
 * call" mis-fired a fresh call per chunk and surfaced truncated args (`{"query": "`). Keying off
 * `index` (falling back to 0 when absent) accumulates correctly. Pure — exported for testing.
 *
 * Verified against NVIDIA NIM on 2026-07-27: distinct calls DO get distinct indices (0, then 1),
 * and each call's arguments reassemble into valid JSON on their own. Partial-looking tool arguments
 * in the UI are the `tool_call_partial` activity events, which are incomplete by design — not a
 * decoding fault here.
 */
export function applyToolCallDelta(acc: Map<number, ToolCallSlot>, tc: { index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown }): number {
  const i = typeof tc.index === 'number' ? tc.index : 0;
  let slot = acc.get(i);
  if (!slot) { slot = { id: '', name: '', args: '' }; acc.set(i, slot); }
  if (tc.id) slot.id = tc.id;
  if (tc.extra_content && typeof tc.extra_content === 'object') slot.extra = tc.extra_content;
  if (tc.function?.name) slot.name = tc.function.name;
  if (tc.function?.arguments) slot.args += tc.function.arguments;
  return i;
}

/**
 * Put the accumulated tool calls in emission order and mark the one the output ceiling cut off.
 *
 * `finish_reason: 'length'` means the model stopped because it ran out of output budget, not
 * because it was done. If that happened while it was writing a tool call, that call's arguments are
 * cut mid-JSON — seen live as `{"action": "click", "elementIndex": 14, "frameId": "f20-65050-67`,
 * which the agent loop then reported as "Failed to parse arguments", blaming the model for our
 * limit. Only the LAST call can be the partial one: earlier calls were completed before the model
 * moved on to it.
 *
 * Pure — exported for testing.
 */
export function finalizeToolCalls(
  acc: Map<number, ToolCallSlot>,
  finishReason: string | null | undefined,
): Array<ToolCallSlot & { truncated?: boolean }> {
  const named = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, slot]) => slot)
    .filter(slot => slot.name);
  if (finishReason !== 'length' || named.length === 0) return named;
  return named.map((slot, i) => (i === named.length - 1 ? { ...slot, truncated: true } : slot));
}

/**
 * Classify an error thrown while streaming a chat completion so the agent loop knows
 * whether — and how — to recover. Pure (no side effects) so it can be unit-tested.
 *
 * - `context`  : the prompt overflowed the model window → compact and retry.
 * - `transient`: a stalled/timed-out stream, a 5xx, or the provider rejecting a single
 *   bad model emission (malformed tool-call JSON, multiple tool calls, out-of-range arg).
 *   A fresh attempt (new key, re-sampled output) almost always succeeds.
 * - otherwise  : fatal (auth, malformed request, …) — surface and stop.
 */
export function classifyStreamError(e: any): { status: number; recoverable: boolean; kind?: 'context' | 'transient'; retryAfterSecs?: number } {
  const msg = String(e?.message ?? '');
  let status = 500;
  if (e instanceof OpenAI.APIConnectionTimeoutError || e?.code === 'ECONNABORTED' || /timeout/i.test(msg)) {
    status = 408;
  } else if (e?.status) {
    status = e.status;
  }

  // Context overflow: recoverable by compaction.
  if (/maximum context length/i.test(msg) || e?.code === 'context_length_exceeded' || status === 413) {
    return { status, recoverable: true, kind: 'context' };
  }

  // Rate limited (429): recoverable, but the loop must BACK OFF before retrying (honor Retry-After
  // if the provider sent one) — retrying immediately just deepens the limit.
  if (status === 429) {
    const ra = e?.headers?.['retry-after'] ?? e?.retryAfterSecs;
    const n = ra != null ? parseFloat(String(ra)) : NaN;
    return { status, recoverable: true, kind: 'transient', retryAfterSecs: isNaN(n) ? undefined : n };
  }

  // Transient: stalled streams, server errors, or a one-off bad model emission the
  // provider rejected. Bounded by the loop's retry cap, so this can be liberal.
  const transientMsg = /Unterminated string|Expecting value|is out of range|single tool-call|tool call/i.test(msg);
  // NVIDIA's edge occasionally returns a bare 410 while the same model remains listed and accepts
  // an identical request moments later. Retry only the body-less form; a descriptive 410 still
  // means the resource is genuinely gone and must remain fatal.
  const transientNvidiaEdge410 = status === 410 && /no body/i.test(msg);
  if (status === 408 || status >= 500 || transientMsg || transientNvidiaEdge410) {
    return { status, recoverable: true, kind: 'transient' };
  }

  return { status, recoverable: false };
}

/**
 * Streaming filter that separates <think>...</think> spans from visible content.
 * Reasoning models (MiniMax, DeepSeek, step-3.5, QwQ...) interleave thinking inside the
 * content channel; without this the internal monologue leaks into the user-facing reply.
 *
 * Two emission shapes are handled:
 *  - Paired:   `<think>reasoning</think>answer` — divert the span between the tags.
 *  - Opener-less: `reasoning</think>answer` — several models (step-3.5, minimax on NIM)
 *    emit the reasoning first and ONLY a closing tag. The old filter, looking for `<think>`
 *    first, treated all the reasoning as the answer and leaked it. So in "implicit" mode the
 *    filter buffers leading content silently until it can tell which it is: a `</think>`
 *    proves the buffer was reasoning (divert it); the stream ending with no closer proves it
 *    was the answer (emit it). This never leaks reasoning, at the cost of the answer from a
 *    NON-reasoning model arriving in one burst at stream end — acceptable since the product's
 *    default models are reasoning models; disable with implicit=false for plain models.
 */
export class ThinkTagFilter {
  private pending = '';
  private inThink = false;
  private seenOpen = false; // a real <think> opener has appeared this turn
  private decided = false;  // leading region resolved → subsequent content streams visibly
  private preamble = '';    // leading content held back while still tentative (implicit mode)
  private static readonly OPEN = '<think>';
  private static readonly CLOSE = '</think>';
  // Upper bound on tentative preamble buffering (implicit mode). Opener-less reasoning
  // is always short and front-loaded; if this much leading content arrives with no
  // `</think>` closer in sight, it is the answer, not reasoning — stop holding it back and
  // stream it live. Without this cap, a model that never emits a closer (most coding models)
  // would buffer its ENTIRE reply and only reveal it in one burst at stream end, which looks
  // like a hang ("spinner rolls forever, no text"). Override with BGW_IMPLICIT_THINK_CAP.
  private static readonly MAX_PREAMBLE = parseInt(process.env.BGW_IMPLICIT_THINK_CAP || '240', 10);
  // Time bound on the same tentative buffer. The char cap alone still bursts every reply SHORTER
  // than the cap (a greeting is ~50 chars — it sat buffered until stream end, the exact symptom the
  // cap exists to prevent). Reasoning tags arrive in the first token or two, so if we have been
  // holding visible-channel content this long with no tag in sight, it is the answer: release it
  // and stream. Same leak tradeoff the char cap already accepts for unknown opener-less reasoners
  // (runtime detection then lifts the cap from the next turn). Override with
  // BGW_IMPLICIT_THINK_TIME_CAP_MS; known reasoners are exempt (capPreamble=false → no bounds).
  private static readonly MAX_PREAMBLE_MS = parseInt(process.env.BGW_IMPLICIT_THINK_TIME_CAP_MS || '250', 10);
  private firstHeldAt = 0; // wall-clock ms when the tentative preamble first became non-empty
  // Effective cap for THIS filter. Inline-reasoning models (caps.inlineReasoning) stream long CoT
  // before a tool call and reliably close it with `</think>`, so the cap is lifted (Infinity): we
  // wait for the closer instead of leaking the reasoning as the reply. A tool call (drainPending)
  // or the stream-end flush still bounds the wait, so there's no plain-model "hang" regression.
  private readonly maxPreamble: number;
  private readonly maxPreambleMs: number;

  constructor(private implicit: boolean = true, capPreamble: boolean = true) {
    this.maxPreamble = capPreamble ? ThinkTagFilter.MAX_PREAMBLE : Number.POSITIVE_INFINITY;
    this.maxPreambleMs = capPreamble ? ThinkTagFilter.MAX_PREAMBLE_MS : Number.POSITIVE_INFINITY;
  }

  /**
   * A tool call has started, which proves this turn's content-channel text (if any) was reasoning,
   * not the answer — the answer IS the call. Divert whatever the filter is still holding tentatively
   * (opener-less reasoning not yet terminated by `</think>`, or text mid-`<think>` block) to the
   * thinking channel so it can never surface as the reply. No-op once the leading region is resolved
   * or the filter is already streaming visible text. Returns the diverted thinking text.
   */
  drainPending(): string {
    if (this.inThink) {
      const t = this.preamble + this.pending;
      this.preamble = '';
      this.pending = '';
      return t;
    }
    if (this.implicit && !this.seenOpen && !this.decided) {
      const t = this.preamble + this.pending;
      this.preamble = '';
      this.pending = '';
      this.decided = true;
      return t;
    }
    return '';
  }

  /**
   * The provider sent reasoning out-of-band via the structured `reasoning_content` channel — so this
   * turn's CONTENT channel is the ANSWER, not opener-less reasoning. Stop tentatively buffering and
   * RELEASE whatever leading content we were holding as visible text (the opposite of drainPending,
   * which diverts to thinking). Idempotent. This is how reasoning is detected at runtime instead of
   * from a static per-model flag — the moment a `reasoning_content` delta arrives, we know.
   */
  releaseAsAnswer(): string {
    if (this.decided || this.inThink) return '';
    this.implicit = false;
    this.decided = true;
    const t = this.preamble;
    this.preamble = '';
    return t;
  }

  /** Returns visible text and thinking text extracted from this token. */
  process(token: string): { text: string; thinking: string } {
    this.pending += token;
    // Normalize <thinking>/<\/thinking> (step-3.7, QwQ, etc.) to <think>/<\/think> INSIDE
    // the pending buffer — so split tags that straddle two chunks are also normalized once
    // the second chunk assembles the full tag in pending. Outer per-token normalization in
    // chat() handles the common single-token case; this catches the rest.
    this.pending = this.pending.replace(/<thinking>/g, '<think>').replace(/<\/thinking>/g, '</think>');
    let text = '';
    let thinking = '';

    for (;;) {
      if (this.inThink) {
        const idx = this.pending.indexOf(ThinkTagFilter.CLOSE);
        if (idx !== -1) {
          thinking += this.pending.slice(0, idx);
          this.pending = this.pending.slice(idx + ThinkTagFilter.CLOSE.length);
          this.inThink = false;
          this.decided = true;
          continue;
        }
        const hold = this.partialTagSuffix(this.pending, ThinkTagFilter.CLOSE);
        thinking += this.pending.slice(0, this.pending.length - hold);
        this.pending = this.pending.slice(this.pending.length - hold);
        break;
      }

      const openIdx = this.pending.indexOf(ThinkTagFilter.OPEN);

      // Tentative leading region (implicit mode, before any tag): could be opener-less
      // reasoning or just the answer. Resolve only on a definite signal.
      if (this.implicit && !this.seenOpen && !this.decided) {
        const closeIdx = this.pending.indexOf(ThinkTagFilter.CLOSE);
        if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
          // Opener-less closer: everything buffered + up to the tag was reasoning.
          thinking += this.preamble + this.pending.slice(0, closeIdx);
          this.preamble = '';
          this.pending = this.pending.slice(closeIdx + ThinkTagFilter.CLOSE.length);
          this.seenOpen = true;
          this.decided = true;
          continue;
        }
        if (openIdx !== -1) {
          // A real opener: the buffered preamble was answer text preceding an explicit block.
          text += this.preamble + this.pending.slice(0, openIdx);
          this.preamble = '';
          this.pending = this.pending.slice(openIdx + ThinkTagFilter.OPEN.length);
          this.inThink = true;
          this.seenOpen = true;
          this.decided = true;
          continue;
        }
        // No full tag yet — buffer, holding back any suffix that could be a split tag.
        const hold = Math.max(
          this.partialTagSuffix(this.pending, ThinkTagFilter.OPEN),
          this.partialTagSuffix(this.pending, ThinkTagFilter.CLOSE),
        );
        this.preamble += this.pending.slice(0, this.pending.length - hold);
        this.pending = this.pending.slice(this.pending.length - hold);
        if (this.preamble.length > 0 && this.firstHeldAt === 0) this.firstHeldAt = Date.now();
        // Cap reached without any closer — by SIZE or by TIME: this is the answer, not
        // opener-less reasoning. Resolve the tentative region now and emit what we held so the
        // reply streams live instead of arriving in one burst at stream end (reads as a hang).
        // The time cap is what lets replies SHORTER than the char cap (greetings) stream too.
        if (
          this.preamble.length >= this.maxPreamble ||
          (this.firstHeldAt !== 0 && Date.now() - this.firstHeldAt >= this.maxPreambleMs)
        ) {
          text += this.preamble;
          this.preamble = '';
          this.decided = true;
        }
        break;
      }

      // Visible streaming region: emit text, but a new <think> block may still open.
      if (openIdx !== -1) {
        text += this.pending.slice(0, openIdx);
        this.pending = this.pending.slice(openIdx + ThinkTagFilter.OPEN.length);
        this.inThink = true;
        this.seenOpen = true;
        continue;
      }
      // Strip a spurious </think> closer that arrived without a matching opener (e.g.
      // minimax on NIM sometimes leaks a bare </think> or </thinking> in the content
      // channel alongside reasoning_content). Also prevents split-tag fragments like
      // `</thin` from being flushed as visible text before `king>` arrives.
      const closeIdx = this.pending.indexOf(ThinkTagFilter.CLOSE);
      if (closeIdx !== -1) {
        text += this.pending.slice(0, closeIdx);
        this.pending = this.pending.slice(closeIdx + ThinkTagFilter.CLOSE.length);
        continue;
      }
      const hold = Math.max(
        this.partialTagSuffix(this.pending, ThinkTagFilter.OPEN),
        this.partialTagSuffix(this.pending, ThinkTagFilter.CLOSE),
      );
      text += this.pending.slice(0, this.pending.length - hold);
      this.pending = this.pending.slice(this.pending.length - hold);
      break;
    }

    return { text, thinking };
  }

  /** Flush whatever is held back (call when the stream ends). */
  flush(): { text: string; thinking: string } {
    const rest = this.pending;
    this.pending = '';
    if (this.inThink) return { text: '', thinking: this.preamble + rest };
    // Tentative buffer never resolved → the stream had no closing tag, so the leading
    // region was the answer all along. Emit it as visible text.
    if (!this.decided && this.preamble) {
      const t = this.preamble + rest;
      this.preamble = '';
      return { text: t, thinking: '' };
    }
    return { text: rest, thinking: '' };
  }

  private partialTagSuffix(s: string, tag: string): number {
    const max = Math.min(s.length, tag.length - 1);
    for (let len = max; len > 0; len--) {
      if (s.endsWith(tag.slice(0, len))) return len;
    }
    return 0;
  }
}

/** Remove <think>/<thinking> spans from a complete (non-streamed) response. */
export function stripThink(content: string): string {
  return content
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^[\s\S]*<\/thinking>/, '') // opener-less </thinking>
    .replace(/^[\s\S]*<\/think>/, '')    // opener-less </think>
    .trim();
}

/**
 * Pull a JSON value out of a model response that may wrap it in a markdown code
 * fence or surrounding prose (e.g. "Here's a JSON array: ```json [...] ```").
 * Returns the first balanced array/object found, or the trimmed input unchanged.
 */
export function extractJson(content: string): string {
  let s = content.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) s = fenced[1].trim();
  const start = s.search(/[[{]/);
  if (start === -1) return s;
  const open = s[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return s.slice(start, i + 1);
  }
  return s.slice(start);
}
