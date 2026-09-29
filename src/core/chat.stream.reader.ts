import * as fs from 'fs';
import * as path from 'path';
import type { ChatEvent } from './llm.provider';
import type { ModelCapabilities } from './capabilities';
import type { ToolNameMap } from './tool.wire';
import { applyToolCallDelta, finalizeToolCalls, chooseThinkStrategy, ThinkTagFilter } from './llm.stream';
import { stateDir } from '../utils/state.dir';

/**
 * Turns one streamed chat completion into Bimax's chat events: the answer's tokens, reasoning on its own channel,
 * tool calls assembled from their fragments, and a truncation signal. Split out of `LlmAdapter.chat()` (flaw list C15),
 * which kept this and the request, the key pool, the budget and the error handling in one 530-line generator.
 *
 * The adapter still owns everything that talks to the outside: timing the provider, the key pool, spend and usage.
 * This class sees only chunks, so it is tested with chunks.
 *
 * Per chunk the order is fixed and matters: the stop reason, the debug capture, the reasoning channel, the content
 * channel, then tool-call fragments.
 */
export class ChatStreamReader {
  /** The provider's stop reason; the last non-null value is authoritative (`length` = cut off at the token ceiling). */
  finishReason: string | null = null;
  /** True when this model is known to reason (table or earlier behaviour); the adapter sizes its first-token wait on it. */
  readonly knownReasoner: boolean;

  private readonly thinkFilter: ThinkTagFilter;
  // Accumulate streamed tool calls keyed by their delta `index` — the OpenAI streaming contract: the first delta for an
  // index carries id+name+the start of the args, later deltas append more args. minimax/NIM (and others) repeat `id` on
  // every delta, so keying off the presence of `tc.id` mis-fired a "new call" each chunk and emitted truncated args.
  // One slot per index, yielded only once the stream is complete.
  private readonly toolAcc = new Map<number, { id: string; name: string; args: string }>();
  private lastActiveIdx = -1;
  private lastPartialAt = 0;
  private readonly debug: { content: string; reasoning: string; deltaKeys: Set<string> } | null;

  /**
   * Throttle live tool-arg partials (C3): a big tool call streams hundreds of arg fragments, and one partial per
   * fragment would drive a UI re-render each time. At most one partial every PARTIAL_EMIT_MS; the final authoritative
   * tool_call always fires regardless.
   */
  static readonly PARTIAL_EMIT_MS = 80;

  constructor(private readonly opts: {
    model: string;
    caps: ModelCapabilities;
    /** Models seen to reason — the adapter's set, shared across requests, which this reader both reads and teaches. */
    reasoners: Set<string>;
    /** The adapter's implicit-think default (BGW implicit mode). */
    implicitThink: boolean;
    wireNames: ToolNameMap;
    /** BGW_DEBUG_STREAM: capture raw channels and append them to logs/stream-debug.log at the end. */
    debugStream?: boolean;
    hadTools?: boolean;
    now?: () => number;
  }) {
    const { caps, model, reasoners } = opts;
    // Seed the runtime reasoner set from the table so the preamble cap is placed correctly on the FIRST turn
    // (openerless models emit long CoT then a `</think>`; capping early would slice it). Detection also runs per chunk,
    // so a model NOT in the table self-corrects the moment it reveals its behaviour.
    if (caps.inlineReasoning || caps.nativeThinking) reasoners.add(model);
    this.knownReasoner = reasoners.has(model);
    // chooseThinkStrategy is the single source of truth (see llm.stream.ts): opener-based/native reasoners stream a
    // tag-free answer from token 1; only opener-less and unknown models buffer the ambiguous leading region.
    const strategy = chooseThinkStrategy(caps, opts.implicitThink, this.knownReasoner);
    this.thinkFilter = new ThinkTagFilter(strategy.implicit, /* capPreamble */ strategy.capBounded);
    this.debug = opts.debugStream ? { content: '', reasoning: '', deltaKeys: new Set() } : null;
  }

  /** Events for one chunk. Usage is not read here: the adapter settles spend with it. */
  *read(chunk: any): Generator<ChatEvent> {
    const { model, caps, reasoners, wireNames } = this.opts;
    if (chunk.choices?.[0]?.finish_reason) this.finishReason = chunk.choices[0].finish_reason;

    if (this.debug) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta && typeof delta === 'object') {
        for (const k of Object.keys(delta)) this.debug.deltaKeys.add(k);
        if (typeof delta.content === 'string') this.debug.content += delta.content;
        if (typeof delta.reasoning_content === 'string') this.debug.reasoning += delta.reasoning_content;
        // Some providers use `reasoning` instead of `reasoning_content`; capture it too.
        if (typeof delta.reasoning === 'string') this.debug.reasoning += delta.reasoning;
      }
    }

    // Reasoning channel (DeepSeek-R1 / o-series style): never surface as the reply. Its mere presence PROVES this model
    // reasons out-of-band, so the content channel is the answer — learn it (future turns skip buffering) and release
    // anything the filter held tentatively.
    const reasoning = chunk.choices?.[0]?.delta?.reasoning_content ?? chunk.choices?.[0]?.delta?.reasoning;
    if (reasoning) {
      if (!reasoners.has(model)) {
        reasoners.add(model);
        const released = this.thinkFilter.releaseAsAnswer();
        if (released) yield { type: 'token', text: released };
      }
      yield { type: 'thinking', text: reasoning, ...(caps.requiresReasoningReplay ? { replay: true } : {}) };
    }

    // Tokens, with inline <think> spans diverted to the thinking channel. <thinking>/</thinking> (step-3.7, QwQ, …) is
    // normalised to <think>/</think> so the filter handles both tag variants uniformly.
    const rawToken = chunk.choices?.[0]?.delta?.content;
    if (rawToken) {
      const token = rawToken.replace(/<thinking>/g, '<think>').replace(/<\/thinking>/g, '</think>');
      // A `</think>` in the content channel PROVES this model reasons inline — learn it so later turns lift the
      // preamble cap (wait for the closer instead of capping → no reasoning leak).
      if (token.includes('</think>')) reasoners.add(model);
      const { text, thinking } = this.thinkFilter.process(token);
      if (thinking) yield { type: 'thinking', text: thinking };
      if (text) yield { type: 'token', text };
    }

    const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      // The turn is producing a tool call, so any leading content-channel text was reasoning (the answer is the call).
      // Divert whatever the filter still holds tentatively to the thinking channel — covers models that reason inline
      // then jump straight to a tool call without a `</think>`. Idempotent: a no-op after it first fires.
      const stray = this.thinkFilter.drainPending();
      if (stray) yield { type: 'thinking', text: stray };
      for (const tc of toolCalls) this.lastActiveIdx = applyToolCallDelta(this.toolAcc, tc);
      // C3 — live tool-arg streaming: the most recently updated call (name + args so far) as it forms, display-only;
      // the authoritative `tool_call`s fire once at the end. Never emitted when caps.partialJsonTools is false.
      if (caps.partialJsonTools && this.lastActiveIdx >= 0) {
        const now = (this.opts.now ?? Date.now)();
        if (now - this.lastPartialAt >= ChatStreamReader.PARTIAL_EMIT_MS) {
          this.lastPartialAt = now;
          const slot = this.toolAcc.get(this.lastActiveIdx)!;
          yield { type: 'tool_call_partial', id: slot.id || `idx-${this.lastActiveIdx}`, name: wireNames.fromWire(slot.name), args: slot.args };
        }
      }
    }
  }

  /** The stream ended: what the filter still holds, every tool call in index order, and a truncation signal. */
  *finish(): Generator<ChatEvent> {
    this.writeDebugRecord();

    const tail = this.thinkFilter.flush();
    if (tail.thinking) yield { type: 'thinking', text: tail.thinking };
    if (tail.text) yield { type: 'token', text: tail.text };

    // "each one's arguments are whole" holds only when the model chose to stop. If it hit the output-token ceiling, the
    // call it was still writing is cut mid-JSON — observed live as `{"action": "click", "elementIndex": 14, "frameId":
    // "f20-65050-67`, which the loop reported as the model's fault. Only the LAST call can be the partial one, so it is
    // marked and the loop gives advice that matches the real cause. (Slots opened with no name are skipped.)
    for (const slot of finalizeToolCalls(this.toolAcc, this.finishReason)) {
      yield {
        type: 'tool_call',
        id: slot.id || `call-${Date.now()}-${slot.name}`,
        name: this.opts.wireNames.fromWire(slot.name),
        args: slot.args,
        ...(slot.truncated ? { truncated: true } : {}),
        ...(slot.extra !== undefined ? { extra: slot.extra } : {}),
      };
    }

    // Output-limit truncation with no tool call at all: the answer itself is cut off. Signalled separately because the
    // loop's recovery differs — it auto-continues the reply rather than reporting a tool failure.
    if (this.finishReason === 'length' && this.toolAcc.size === 0) yield { type: 'truncated' };
  }

  /**
   * BGW_DEBUG_STREAM: the exact `content`/`reasoning_content` bytes and every delta key the provider sent, to a file of
   * their own (never the console) — how the exact reasoning delimiter of a model is learned without guessing.
   */
  private writeDebugRecord(): void {
    if (!this.debug || !(this.debug.content || this.debug.reasoning)) return;
    try {
      const dir = path.join(stateDir('.breakglass'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const rec = {
        ts: new Date().toISOString(),
        model: this.opts.model,
        hadTools: !!this.opts.hadTools,
        deltaKeys: [...this.debug.deltaKeys],
        reasoningLen: this.debug.reasoning.length,
        contentLen: this.debug.content.length,
        content: this.debug.content.slice(0, 4000),
        reasoning_content: this.debug.reasoning.slice(0, 2000),
      };
      fs.appendFileSync(path.join(dir, 'stream-debug.log'), JSON.stringify(rec) + '\n', 'utf-8');
    } catch { /* diagnostic only — never break the stream */ }
  }
}

/**
 * The next chunk, or a rejection when none comes within `timeoutMs`. On a timeout the HTTP stream is aborted, so the
 * socket is released instead of lingering until the provider closes it, and the timer is always cleared, or every chunk
 * would leak one. The pending `next()` left behind cannot become an unhandled rejection even if it later fails (a socket
 * reset on a dead stream): `Promise.race` has already subscribed to it. The explicit `catch` below only says so —
 * measured 2026-09-30, removing it changes nothing (chat.stream.reader.test.ts).
 */
export async function nextChunkWithin<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  onTimeout: () => Error,
  abortStream: () => void,
): Promise<IteratorResult<T>> {
  const nextPromise = iterator.next();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([nextPromise, timeoutPromise]);
  } catch (raceErr) {
    nextPromise.catch(() => { /* orphaned after timeout — already handled via raceErr */ });
    try { abortStream(); } catch { /* best-effort close */ }
    throw raceErr;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
