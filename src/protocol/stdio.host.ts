import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import { HostHandlers } from './host';
import { LineDecoder, encode } from './codec';
import { Inbound } from './protocol';
import { WireQueueStats } from './wire.queue';
import { createQueuedHost } from './queued.host';

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
 * Bind the engine's protocol endpoint to process streams: events go out as NDJSON on stdout, the front-end's NDJSON
 * commands come in on stdin. Used when the engine runs as its own process (the utilityProcess and child-process
 * transports); the monolith's worker thread uses port.host.ts instead. The queue, notices and interrupt rule are
 * shared with it in queued.host.ts — this file is only the stream framing.
 *
 * Returns a disposer that detaches listeners and stops reading stdin, carrying `stats()`.
 */
export function startStdioHost(opts: StdioHostOptions): StdioHostHandle {
  const out = opts.output ?? process.stdout;
  const inp = opts.input ?? process.stdin;

  const { host, dispose: disposeHost, stats } = createQueuedHost({
    write: (chunk) => out.write(chunk),
    onDrain: (listener) => {
      out.on('drain', listener);
      return () => { out.off('drain', listener); };
    },
    // stderr is the only channel left once the queue refuses everything, and it is already how this module reports a
    // malformed inbound line.
    reportOverflow: (text) => {
      try { process.stderr.write(`[stdio.host] ${text}\n`); } catch { /* stderr closed too — nothing left to report on */ }
    },
  }, opts, encode);

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
    disposeHost();
  };
  return Object.assign(dispose, { stats });
}
