import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import { ProtocolHost, HostHandlers } from './host';
import { LineDecoder, encode } from './codec';
import { Inbound, Outbound } from './protocol';
import { WireQueue, WireQueueStats, outboundClass } from './wire.queue';

export interface StdioHostOptions extends HostHandlers {
  emitter: EventEmitter;            // the engine's engineEvents
  input?: NodeJS.ReadableStream;    // defaults to process.stdin
  output?: NodeJS.WritableStream;   // defaults to process.stdout
  /** Transport limits. Defaults live in WireQueue; tests and hosts with tighter budgets override. */
  maxQueuedBytes?: number;
  bulkHighWaterBytes?: number;
  bulkLowWaterBytes?: number;
}

/** A disposer that also reports what the transport did, for diagnostics and budget checks. */
export type StdioHostHandle = (() => void) & { stats: () => WireQueueStats };

/**
 * Bind a {@link ProtocolHost} to real process streams: engine events go out as NDJSON on stdout,
 * the front-end's NDJSON commands come in on stdin. This is the only place that touches the OS
 * pipes; everything above it is transport-agnostic and unit-tested. Activated solely in headless
 * mode (e.g. when the Go TUI spawns the engine) — never on the in-process Ink path.
 *
 * Outbound writes go through a {@link WireQueue}: bounded, strictly ordered, backpressure-aware,
 * and reserving capacity for lifecycle and approval traffic instead of pretending a later message
 * can overtake bytes already queued on the same pipe. Withheld and dropped output is announced on
 * the wire, so a truncated transcript is visibly truncated.
 *
 * Returns a disposer that detaches listeners and stops reading stdin, carrying `stats()`.
 */
export function startStdioHost(opts: StdioHostOptions): StdioHostHandle {
  const out = opts.output ?? process.stdout;
  const inp = opts.input ?? process.stdin;
  let transportBroken = false;

  /**
   * A transport notice. Enqueued as CRITICAL deliberately: it is the one `event` that must survive
   * the condition it describes — a notice about withheld output that is itself withheld tells the
   * user nothing. It rides the existing `log` event, so no protocol version or mirror changes.
   */
  const notice = (level: 'warn' | 'error' | 'info', text: string): void => {
    if (transportBroken) return;
    queue.enqueue(encode({
      t: 'event',
      name: 'log',
      args: [{ id: Date.now(), level, text: `[transport] ${text}`, timestamp: new Date().toISOString() }],
    } as Outbound), 'critical');
  };

  const queue = new WireQueue({
    write: (chunk) => out.write(chunk),
    onDrain: (listener) => {
      out.on('drain', listener);
      return () => { out.off('drain', listener); };
    },
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
      // Past this point the queue refuses everything, so the notice cannot go out on the wire it is
      // about. stderr is the only channel left, and it is already how this module reports a
      // malformed inbound line.
      transportBroken = true;
      try {
        process.stderr.write(
          `[stdio.host] output queue overflowed at ${queuedBytes}/${maxQueuedBytes} bytes; ` +
          `the front-end stopped reading. No further protocol output will be produced.\n`
        );
      } catch { /* stderr closed too — nothing left to report on */ }
    },
  });

  const host = new ProtocolHost(
    (msg: Outbound) => {
      if (transportBroken) return;
      queue.enqueue(encode(msg), outboundClass(msg));
    },
    {
      onInput: opts.onInput,
      // Cancellation on a single ordered pipe: a stop acknowledgement cannot overtake megabytes of
      // display output already queued ahead of it, so when the pipe is genuinely congested the only
      // way to make stop responsive is to discard the queued output for the work being cancelled.
      // Uncongested, nothing is dropped — the acknowledgement is already prompt.
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
      onMenuSelect: opts.onMenuSelect, onConfigGet: opts.onConfigGet, onConfigSet: opts.onConfigSet,
      onCatalogGet: opts.onCatalogGet, onProviderSet: opts.onProviderSet,
      onResume: opts.onResume, onControls: opts.onControls,
    },
  );

  const decoder = new LineDecoder<Inbound>((line, err) =>
    process.stderr.write(`[stdio.host] dropped malformed line: ${String(err)}\n`));

  // StringDecoder, NOT per-chunk Buffer.toString: a pipe read can split a multibyte UTF-8
  // character (emoji/CJK in a user message) across two chunks, and decoding each chunk
  // independently turns the split character into U+FFFD garbage. StringDecoder buffers the
  // partial sequence until the rest arrives.
  const utf8 = new StringDecoder('utf8');
  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : utf8.write(chunk);
    for (const msg of decoder.push(text)) host.ingest(msg);
  };

  inp.on('data', onData);
  if (typeof (inp as any).resume === 'function') (inp as any).resume();
  host.attach(opts.emitter);

  const dispose = (): void => {
    inp.off('data', onData);
    host.detach();
    const unsent = queue.dispose();
    if (unsent.unsentMessages > 0) {
      try {
        process.stderr.write(
          `[stdio.host] disposed with ${unsent.unsentMessages} message(s) (${unsent.unsentBytes} bytes) never written.\n`
        );
      } catch { /* stderr closed */ }
    }
  };
  return Object.assign(dispose, { stats: () => queue.snapshot() });
}
