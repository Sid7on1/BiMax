import { Outbound } from './protocol';

/**
 * Bounded, strictly ordered outbound queue for the NDJSON protocol pipe.
 *
 * The sink used to be `out.write(encode(msg))` with the return value discarded. `write()` returning
 * false is Node telling you the kernel buffer is full and it is now buffering in the process's own
 * heap; ignoring it means a front-end that stops reading turns engine output into unbounded memory
 * growth, and nothing upstream ever learns that the consumer is gone.
 *
 * ## Ordering is not negotiable, so priority is not the mechanism
 *
 * Everything here shares one pipe. Bytes already handed to `write()` are ahead of anything enqueued
 * afterwards, and no amount of prioritisation can pull a later message in front of them — a
 * "high-priority" lane on a single stream is a comforting lie. An approval request cannot overtake a
 * megabyte of streamed tokens that is already queued.
 *
 * So delivery of critical messages is guaranteed by **reserving capacity before saturation**, not by
 * reordering after it:
 *
 *   0 ────────────── bulkHighWater ──────────── maxQueuedBytes
 *   │  bulk + critical admitted   │  critical only (the reserve)  │
 *
 * Bulk output stops being admitted at the high-water mark, well below the ceiling, which keeps the
 * gap between the two marks free for lifecycle and approval traffic. Hysteresis (`bulkLowWater`)
 * stops the producer flapping. If the reserve itself fills, the consumer is not draining at all:
 * the queue reports overflow once, refuses everything after it, and the caller is expected to stop
 * producing and surface a disconnected consumer rather than pretend the message got through.
 *
 * ## What may and may not be lost
 *
 * A refused bulk message is **counted and reported**, never silently discarded — the caller emits a
 * visible notice, so a truncated transcript is visibly truncated. A critical message is never
 * refused while the queue is below its ceiling, and never dropped by this queue at all.
 *
 * Nothing here inspects message content, so no prompt, source or credential text is retained: the
 * queue holds already-encoded lines and their byte lengths.
 */

export type MessageClass = 'critical' | 'bulk';

/**
 * Which messages must get through.
 *
 * Critical: the handshake, correlated answers a front-end is blocking on, approval requests, and
 * the liveness pong. Losing any of these strands a front-end waiting for a reply that will never
 * come. Everything else — the forwarded display events, which is where stream tokens live — is
 * bulk: it is what floods, and it is what a paused consumer can be told it missed.
 */
export function outboundClass(msg: Outbound): MessageClass {
  switch (msg.t) {
    case 'event':
      return msg.name === 'message' && (msg.args?.[0] as any)?.payload?.capabilityStatus ? 'critical' : 'bulk';
    default:
      return 'critical';
  }
}

export interface WireQueueOptions {
  /** The underlying sink. Returns false when the consumer is not keeping up (Node's contract). */
  write: (chunk: string) => boolean;
  /** Subscribe to the sink's drain signal. Returns an unsubscribe function. */
  onDrain: (listener: () => void) => () => void;
  /** Hard ceiling on queued bytes. Past this the consumer is treated as gone. */
  maxQueuedBytes?: number;
  /** Bulk admission stops at or above this. Must be below `maxQueuedBytes`. */
  bulkHighWaterBytes?: number;
  /** Bulk admission resumes at or below this. Must be below the high-water mark. */
  bulkLowWaterBytes?: number;
  /** Bulk was refused; the caller should stop producing and say so visibly. */
  onBulkPaused?: (info: { queuedBytes: number }) => void;
  /** Bulk is welcome again; `refused` counts what was turned away during the pause. */
  onBulkResumed?: (info: { queuedBytes: number; refused: number; refusedBytes: number }) => void;
  /** The reserve filled: critical delivery can no longer be guaranteed. Fires at most once. */
  onOverflow?: (info: { queuedBytes: number; maxQueuedBytes: number }) => void;
}

export interface WireQueueStats {
  queuedBytes: number;
  queuedMessages: number;
  /** Peak `queuedBytes` seen, for a budget to be checked against. */
  peakQueuedBytes: number;
  enqueuedCritical: number;
  enqueuedBulk: number;
  refusedBulk: number;
  refusedBulkBytes: number;
  refusedCritical: number;
  /** Times the sink asked us to stop writing. */
  backpressureEvents: number;
  bulkPaused: boolean;
  overflowed: boolean;
  /** Bulk messages discarded by an explicit `dropPendingBulk` call, e.g. on interrupt. */
  droppedBulkOnCancel: number;
  writtenMessages: number;
  writtenBytes: number;
}

export type AdmissionResult =
  | { admitted: true }
  | { admitted: false; reason: 'bulk-paused' | 'overflow' | 'disposed' };

const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const DEFAULT_BULK_HIGH_WATER = 4 * 1024 * 1024;
const DEFAULT_BULK_LOW_WATER = 1 * 1024 * 1024;

interface QueuedLine {
  chunk: string;
  bytes: number;
  cls: MessageClass;
}

export class WireQueue {
  private readonly opts: Required<Pick<WireQueueOptions, 'write' | 'onDrain'>> & WireQueueOptions;
  private readonly maxQueuedBytes: number;
  private readonly bulkHighWaterBytes: number;
  private readonly bulkLowWaterBytes: number;

  private queue: QueuedLine[] = [];
  private queuedBytes = 0;
  private flushing = false;
  private waitingForDrain = false;
  private offDrain: (() => void) | null = null;
  private disposed = false;
  /** A sink that threw (EPIPE) is terminal: there is no drain event coming for a dead pipe. */
  private sinkFailed = false;

  private stats: WireQueueStats = {
    queuedBytes: 0, queuedMessages: 0, peakQueuedBytes: 0,
    enqueuedCritical: 0, enqueuedBulk: 0,
    refusedBulk: 0, refusedBulkBytes: 0, refusedCritical: 0,
    backpressureEvents: 0, bulkPaused: false, overflowed: false,
    droppedBulkOnCancel: 0, writtenMessages: 0, writtenBytes: 0,
  };

  constructor(options: WireQueueOptions) {
    this.opts = options as Required<Pick<WireQueueOptions, 'write' | 'onDrain'>> & WireQueueOptions;
    this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    this.bulkHighWaterBytes = options.bulkHighWaterBytes ?? Math.min(DEFAULT_BULK_HIGH_WATER, Math.floor(this.maxQueuedBytes / 2));
    this.bulkLowWaterBytes = options.bulkLowWaterBytes ?? Math.min(DEFAULT_BULK_LOW_WATER, Math.floor(this.bulkHighWaterBytes / 2));
    if (!(this.bulkLowWaterBytes <= this.bulkHighWaterBytes && this.bulkHighWaterBytes < this.maxQueuedBytes)) {
      throw new Error(
        `[WireQueue] watermarks must satisfy low <= high < max; got ${this.bulkLowWaterBytes}, ` +
        `${this.bulkHighWaterBytes}, ${this.maxQueuedBytes}`
      );
    }
  }

  /**
   * Offer one already-encoded line. FIFO: an admitted message goes behind everything already
   * queued, whatever its class. Class decides ADMISSION, never position.
   */
  enqueue(chunk: string, cls: MessageClass): AdmissionResult {
    if (this.disposed) return { admitted: false, reason: 'disposed' };
    const bytes = Buffer.byteLength(chunk, 'utf8');

    if (cls === 'bulk') {
      if (this.stats.overflowed) { this.refuseBulk(bytes); return { admitted: false, reason: 'overflow' }; }
      if (this.stats.bulkPaused || this.queuedBytes + bytes > this.bulkHighWaterBytes) {
        if (!this.stats.bulkPaused) {
          this.stats.bulkPaused = true;
          this.opts.onBulkPaused?.({ queuedBytes: this.queuedBytes });
        }
        this.refuseBulk(bytes);
        return { admitted: false, reason: 'bulk-paused' };
      }
      this.stats.enqueuedBulk++;
    } else {
      if (this.stats.overflowed) { this.stats.refusedCritical++; return { admitted: false, reason: 'overflow' }; }
      if (this.queuedBytes + bytes > this.maxQueuedBytes) {
        // The reserve is exhausted: the consumer is not reading at all. Say so once, refuse
        // everything after it, and let the caller tear the connection down visibly. Continuing to
        // queue would trade a visible failure for unbounded memory growth.
        this.stats.overflowed = true;
        this.stats.refusedCritical++;
        this.opts.onOverflow?.({ queuedBytes: this.queuedBytes, maxQueuedBytes: this.maxQueuedBytes });
        return { admitted: false, reason: 'overflow' };
      }
      this.stats.enqueuedCritical++;
    }

    this.queue.push({ chunk, bytes, cls });
    this.queuedBytes += bytes;
    if (this.queuedBytes > this.stats.peakQueuedBytes) this.stats.peakQueuedBytes = this.queuedBytes;
    this.syncCounters();
    this.flush();
    return { admitted: true };
  }

  private refuseBulk(bytes: number): void {
    this.stats.refusedBulk++;
    this.stats.refusedBulkBytes += bytes;
  }

  /**
   * Write until the sink pushes back or the queue empties. Re-entrancy is guarded because a sink
   * can call back synchronously.
   */
  private flush(): void {
    if (this.flushing || this.waitingForDrain || this.disposed) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const line = this.queue[0];
        let accepted: boolean;
        try {
          accepted = this.opts.write(line.chunk);
        } catch {
          // A dead pipe (EPIPE) throws, and a dead pipe never drains. Stop writing and leave the
          // line queued: continued production then fills the queue and reports overflow, which is
          // how the caller learns the consumer is gone. Pretending the write succeeded would lose
          // the message silently.
          this.sinkFailed = true;
          this.waitingForDrain = true;
          break;
        }
        // The line was handed over either way: `false` means "buffered, stop sending more", not
        // "rejected". Removing it is correct; what changes is that we stop the loop.
        this.queue.shift();
        this.queuedBytes -= line.bytes;
        this.stats.writtenMessages++;
        this.stats.writtenBytes += line.bytes;
        if (!accepted) {
          this.stats.backpressureEvents++;
          this.waitingForDrain = true;
          this.offDrain?.();
          this.offDrain = this.opts.onDrain(() => {
            this.offDrain?.();
            this.offDrain = null;
            this.waitingForDrain = false;
            this.flush();
          });
          break;
        }
      }
      this.syncCounters();
      this.maybeResumeBulk();
    } finally {
      this.flushing = false;
    }
  }

  private maybeResumeBulk(): void {
    if (!this.stats.bulkPaused || this.stats.overflowed) return;
    if (this.queuedBytes > this.bulkLowWaterBytes) return;
    const refused = this.stats.refusedBulk;
    const refusedBytes = this.stats.refusedBulkBytes;
    this.stats.bulkPaused = false;
    this.opts.onBulkResumed?.({ queuedBytes: this.queuedBytes, refused, refusedBytes });
  }

  /**
   * Discard queued bulk. Used when a turn is cancelled: its remaining display output describes work
   * the user stopped. Critical messages are never touched, and the count is reported so the drop is
   * visible rather than silent.
   */
  dropPendingBulk(): number {
    const before = this.queue.length;
    const kept: QueuedLine[] = [];
    let bytes = 0;
    for (const line of this.queue) {
      if (line.cls === 'bulk') continue;
      kept.push(line);
      bytes += line.bytes;
    }
    const dropped = before - kept.length;
    this.queue = kept;
    this.queuedBytes = bytes;
    this.stats.droppedBulkOnCancel += dropped;
    this.syncCounters();
    this.maybeResumeBulk();
    return dropped;
  }

  private syncCounters(): void {
    this.stats.queuedBytes = this.queuedBytes;
    this.stats.queuedMessages = this.queue.length;
  }

  /**
   * True when enough is queued that a message enqueued now would sit behind a meaningful backlog.
   * Callers use it to decide whether cancelling needs to discard queued bulk to stay responsive.
   */
  congested(): boolean { return this.queuedBytes > this.bulkLowWaterBytes; }

  /** True once the sink threw. No drain is coming; the queue only reports from here. */
  isSinkFailed(): boolean { return this.sinkFailed; }

  snapshot(): WireQueueStats { return { ...this.stats }; }

  /** Lines still queued when the transport was disposed, so a caller can report what never went. */
  dispose(): { unsentMessages: number; unsentBytes: number } {
    this.disposed = true;
    this.offDrain?.();
    this.offDrain = null;
    const unsent = { unsentMessages: this.queue.length, unsentBytes: this.queuedBytes };
    this.queue = [];
    this.queuedBytes = 0;
    this.syncCounters();
    return unsent;
  }
}
