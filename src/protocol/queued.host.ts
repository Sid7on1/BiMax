import { EventEmitter } from 'events';
import { ProtocolHost, HostHandlers } from './host';
import { Outbound } from './protocol';
import { WireQueue, WireQueueStats, outboundClass } from './wire.queue';

/**
 * The engine's protocol endpoint over a bounded outbound queue — the part every transport shares.
 *
 * A transport supplies only a sink (`write` a serialized message, `onDrain` when it can take more) and a way to report
 * the one failure that cannot travel on the sink itself. Everything else is here once: the {@link WireQueue} with its
 * reserved capacity for approvals and lifecycle traffic, the visible notices when display output is withheld, and the
 * interrupt rule that discards queued display output for a cancelled turn so the stop is acknowledged promptly.
 * Before this, stdio.host.ts held it all; the MessagePort transport of the monolith (record 64, M3) is the second
 * user, and a second copy is how the two would drift.
 */
export interface QueuedHostOptions extends HostHandlers {
  emitter: EventEmitter;            // the engine's engineEvents
  maxQueuedBytes?: number;
  bulkHighWaterBytes?: number;
  bulkLowWaterBytes?: number;
}

export interface QueuedHostSink {
  /** Hand one serialized message to the transport. False: stop until `onDrain` fires. */
  write: (chunk: string) => boolean;
  onDrain: (listener: () => void) => () => void;
  /** The queue overflowed, so nothing more can be said on the sink; say it wherever the transport still can. */
  reportOverflow: (text: string) => void;
}

export interface QueuedHost {
  host: ProtocolHost;
  queue: WireQueue;
  /** Detach from the engine and say what was never delivered. */
  dispose: () => void;
  stats: () => WireQueueStats;
}

export function createQueuedHost(sink: QueuedHostSink, opts: QueuedHostOptions, serialize: (msg: Outbound) => string): QueuedHost {
  let transportBroken = false;

  /**
   * A transport notice. Enqueued as CRITICAL deliberately: it is the one `event` that must survive the condition it
   * describes — a notice about withheld output that is itself withheld tells the user nothing. It rides the existing
   * `log` event, so no protocol version changes.
   */
  const notice = (level: 'warn' | 'error' | 'info', text: string): void => {
    if (transportBroken) return;
    queue.enqueue(serialize({
      t: 'event',
      name: 'log',
      args: [{ id: Date.now(), level, text: `[transport] ${text}`, timestamp: new Date().toISOString() }],
    } as Outbound), 'critical');
  };

  const queue = new WireQueue({
    write: sink.write,
    onDrain: sink.onDrain,
    ...(opts.maxQueuedBytes !== undefined ? { maxQueuedBytes: opts.maxQueuedBytes } : {}),
    ...(opts.bulkHighWaterBytes !== undefined ? { bulkHighWaterBytes: opts.bulkHighWaterBytes } : {}),
    ...(opts.bulkLowWaterBytes !== undefined ? { bulkLowWaterBytes: opts.bulkLowWaterBytes } : {}),
    onBulkPaused: ({ queuedBytes }) => {
      notice('warn', `output paused — the front-end is not draining (${queuedBytes} bytes queued). ` +
        `Display output is being withheld; approvals and lifecycle messages are not.`);
    },
    onBulkResumed: ({ refused }) => {
      notice('info', `output resumed — ${refused} display message(s) were withheld while the front-end was behind.`);
    },
    onOverflow: ({ queuedBytes, maxQueuedBytes }) => {
      // Past this point the queue refuses everything, so the notice cannot go out on the channel it is about.
      transportBroken = true;
      sink.reportOverflow(
        `output queue overflowed at ${queuedBytes}/${maxQueuedBytes} bytes; ` +
        `the front-end stopped reading. No further protocol output will be produced.`,
      );
    },
  });

  const host = new ProtocolHost(
    (msg: Outbound) => {
      if (transportBroken) return;
      queue.enqueue(serialize(msg), outboundClass(msg));
    },
    {
      onInput: opts.onInput,
      // Cancellation on one ordered channel: a stop acknowledgement cannot overtake display output already queued
      // ahead of it, so when the channel is genuinely congested the only way to make stop responsive is to discard
      // the queued output for the work being cancelled. Uncongested, nothing is dropped.
      onInterrupt: () => {
        if (queue.congested()) {
          const dropped = queue.dropPendingBulk();
          if (dropped > 0) {
            notice('warn', `interrupted — ${dropped} queued display message(s) for the cancelled turn were discarded so the stop could be acknowledged.`);
          }
        }
        opts.onInterrupt?.();
      },
      onQuery: opts.onQuery,
      // F7: steering for the running turn. Handlers are passed by name, so a new one must be added here too.
      onSteer: opts.onSteer,
      onMenuSelect: opts.onMenuSelect, onConfigGet: opts.onConfigGet, onConfigSet: opts.onConfigSet,
      onCatalogGet: opts.onCatalogGet, onProviderSet: opts.onProviderSet,
      onResume: opts.onResume, onControls: opts.onControls,
    },
  );

  return {
    host,
    queue,
    stats: () => queue.snapshot(),
    dispose: () => {
      host.detach();
      const unsent = queue.dispose();
      if (unsent.unsentMessages > 0) {
        sink.reportOverflow(`disposed with ${unsent.unsentMessages} message(s) (${unsent.unsentBytes} bytes) never written.`);
      }
    },
  };
}
