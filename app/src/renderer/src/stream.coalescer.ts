import type { Outbound } from './protocol';

/**
 * Coalesce adjacent streaming deltas into one dispatch per frame.
 *
 * Every `stream_token` used to run a full reducer pass and re-render everything subscribed to the
 * engine state. A model emitting a few hundred tokens a second therefore drove a few hundred React
 * commits a second, all to append text to one string — which is what makes typing, scrolling and
 * switching tasks stutter while output is flowing.
 *
 * Coalescing is safe here for one specific reason: the reducer folds these deltas with an
 * **associative** operation. `streaming + a + b` and `streaming + (a + b)` are the same string, so
 * merging adjacent deltas cannot change the transcript by a single byte. That is the whole licence
 * for this class, and it is why nothing else is merged.
 *
 * What is NOT coalesced, and why:
 *
 *  - **Anything that is not an adjacent same-kind text delta.** A `message`, `tool_call`, `request`,
 *    `clear` or engine-state change forces a flush FIRST and is then emitted, so the order the
 *    engine produced is the order the reducer sees. An approval that arrives during a stream is
 *    never delayed behind a batch, and a final message never overtakes the text it supersedes.
 *  - **Two different delta kinds.** `thinking` and `stream_token` write different fields, and their
 *    interleaving is meaningful, so a change of kind flushes.
 *
 * Flush triggers, whichever comes first: the next frame, a maximum-latency timer (a hidden window
 * gets no frames at all, and buffering until it is shown again would be a silent stall), a pending
 * buffer past its character ceiling, or an explicit boundary — a final message, an interrupt, or
 * disposal.
 */

export type CoalescableEvent = 'stream_token' | 'thinking';

const COALESCABLE = new Set<string>(['stream_token', 'thinking']);

export type FlushReason =
  | 'frame'
  | 'max-latency'
  | 'size'
  | 'boundary'      // a non-coalescable message arrived, so ordering demands the buffer goes first
  | 'kind-change'
  | 'explicit'      // interrupt, final message, or a caller-driven flush
  | 'dispose';

export interface CoalescerStats {
  /** Messages handed to `push`. */
  received: number;
  /** Deltas that were merged into a batch. */
  coalesced: number;
  /** Batches emitted (one dispatch each). */
  batches: number;
  /** Messages emitted unchanged. */
  passthrough: number;
  /** Characters currently held. */
  pendingChars: number;
  /** Characters discarded by `retire()`, e.g. when the whole task was thrown away. */
  retiredChars: number;
  flushes: Record<FlushReason, number>;
  /**
   * Dispatches saved: deltas received minus batches emitted. This is the number the slice exists
   * for, and it is a count of reducer passes avoided — not a claim about time.
   */
  dispatchesSaved: number;
}

export interface StreamCoalescerOptions {
  /** Where a batch or a passthrough message goes. Called in strict arrival order. */
  emit: (msg: Outbound) => void;
  /**
   * Schedule a callback for the next frame; returns a cancel function. Defaults to
   * `requestAnimationFrame` when present. A hidden window never calls this back, which is what the
   * maximum-latency timer is for.
   */
  scheduleFrame?: (cb: () => void) => () => void;
  /** Ceiling on how long a delta may be held. Default 50 ms. */
  maxLatencyMs?: number;
  /** Flush once the buffer reaches this many characters, whatever the frame cadence. Default 8192. */
  maxPendingChars?: number;
}

function defaultScheduleFrame(cb: () => void): () => void {
  const raf = (globalThis as { requestAnimationFrame?: (fn: () => void) => number }).requestAnimationFrame;
  const caf = (globalThis as { cancelAnimationFrame?: (h: number) => void }).cancelAnimationFrame;
  if (typeof raf === 'function') {
    const handle = raf(cb);
    return () => { if (typeof caf === 'function') caf(handle); };
  }
  const timer = setTimeout(cb, 16);
  return () => clearTimeout(timer);
}

interface Pending {
  name: CoalescableEvent;
  text: string;
  /** How many separate deltas are in this batch, for the saved-dispatch count. */
  parts: number;
}

export class StreamCoalescer {
  private readonly emit: (msg: Outbound) => void;
  private readonly scheduleFrame: (cb: () => void) => () => void;
  private readonly maxLatencyMs: number;
  private readonly maxPendingChars: number;

  private pending: Pending | null = null;
  private cancelFrame: (() => void) | null = null;
  private latencyTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private stats: CoalescerStats = {
    received: 0, coalesced: 0, batches: 0, passthrough: 0,
    pendingChars: 0, retiredChars: 0, dispatchesSaved: 0,
    flushes: { frame: 0, 'max-latency': 0, size: 0, boundary: 0, 'kind-change': 0, explicit: 0, dispose: 0 },
  };

  constructor(options: StreamCoalescerOptions) {
    this.emit = options.emit;
    this.scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;
    this.maxLatencyMs = options.maxLatencyMs ?? 50;
    this.maxPendingChars = options.maxPendingChars ?? 8192;
  }

  /** Offer one message. Order in is order out; only adjacent same-kind text deltas are merged. */
  push(msg: Outbound): void {
    if (this.disposed) return;
    this.stats.received++;

    const delta = this.asDelta(msg);
    if (!delta) {
      // Ordering wins over batching: whatever is buffered was produced before this message, so it
      // has to reach the reducer before it does.
      this.flush('boundary');
      this.stats.passthrough++;
      this.emit(msg);
      return;
    }

    if (this.pending && this.pending.name !== delta.name) this.flush('kind-change');

    if (this.pending) {
      this.pending.text += delta.text;
      this.pending.parts++;
      this.stats.coalesced++;
    } else {
      this.pending = { name: delta.name, text: delta.text, parts: 1 };
    }
    this.stats.pendingChars = this.pending.text.length;

    if (this.pending.text.length >= this.maxPendingChars) { this.flush('size'); return; }
    this.arm();
  }

  private asDelta(msg: Outbound): { name: CoalescableEvent; text: string } | null {
    if ((msg as { t?: string }).t !== 'event') return null;
    const event = msg as unknown as { name?: string; args?: unknown[] };
    if (!event.name || !COALESCABLE.has(event.name)) return null;
    return { name: event.name as CoalescableEvent, text: String(event.args?.[0] ?? '') };
  }

  private arm(): void {
    if (this.cancelFrame === null) {
      this.cancelFrame = this.scheduleFrame(() => { this.cancelFrame = null; this.flush('frame'); });
    }
    if (this.latencyTimer === null) {
      // A hidden window is handed no frames, so without this the buffer would sit until the window
      // came back — a stall the user would read as the engine having stopped.
      this.latencyTimer = setTimeout(() => { this.latencyTimer = null; this.flush('max-latency'); }, this.maxLatencyMs);
    }
  }

  private disarm(): void {
    this.cancelFrame?.();
    this.cancelFrame = null;
    if (this.latencyTimer !== null) { clearTimeout(this.latencyTimer); this.latencyTimer = null; }
  }

  /** Emit whatever is buffered, as one event. Safe to call when nothing is pending. */
  flush(reason: FlushReason = 'explicit'): void {
    this.disarm();
    const pending = this.pending;
    this.pending = null;
    this.stats.pendingChars = 0;
    if (!pending) return;
    this.stats.flushes[reason]++;
    this.stats.batches++;
    this.stats.dispatchesSaved += pending.parts - 1;
    this.emit({ t: 'event', name: pending.name, args: [pending.text] } as unknown as Outbound);
  }

  /**
   * Discard buffered text without emitting it. For a task or project that has been thrown away —
   * NOT for an interrupt, where the text already arrived and the user should see it (the caller
   * flushes there instead). Returns the characters dropped, so the loss is countable.
   */
  retire(): number {
    this.disarm();
    const dropped = this.pending?.text.length ?? 0;
    this.pending = null;
    this.stats.pendingChars = 0;
    this.stats.retiredChars += dropped;
    return dropped;
  }

  /**
   * True while a frame callback or the latency timer is still scheduled. Exposed because "nothing
   * is emitted twice" and "nothing is left scheduled" are different guarantees: a flush that only
   * empties the buffer leaves a timer holding the event loop open after the stream has stopped.
   */
  armed(): boolean { return this.cancelFrame !== null || this.latencyTimer !== null; }

  snapshot(): CoalescerStats {
    return { ...this.stats, flushes: { ...this.stats.flushes } };
  }

  /** Flush what is held, then stop accepting anything. */
  dispose(): void {
    if (this.disposed) return;
    this.flush('dispose');
    this.disposed = true;
    this.disarm();
  }
}
