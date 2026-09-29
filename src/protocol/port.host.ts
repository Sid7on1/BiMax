import { EventEmitter } from 'events';
import { isMainThread, workerData } from 'node:worker_threads';
import { HostHandlers } from './host';
import { Inbound, Outbound } from './protocol';
import { WireQueueStats } from './wire.queue';
import { createQueuedHost } from './queued.host';

/**
 * The engine's protocol endpoint over a MessagePort — the monolith's transport (record 64, M3).
 *
 * When the engine is a worker thread inside the app's process there is no pipe to frame: each protocol message is one
 * port message. Outbound, a message is serialized once (JSON, so the queue can count its bytes exactly) and posted as
 * one string; inbound, the app posts the protocol object itself and it arrives already structured — no line decoder,
 * no UTF-8 chunk reassembly, no malformed partial lines.
 *
 * ## Flow control
 *
 * `postMessage` always accepts, so on its own a port has no backpressure and a stalled consumer would turn engine
 * output into unbounded memory. The window restores it: at most `windowBytes` may be posted and not yet acknowledged.
 * The app acknowledges what it has handled (`{ t: '__ack', bytes }`); until it does, the shared {@link WireQueue} holds
 * further output with its usual bounds, reserved capacity for approvals and lifecycle traffic, and visible notices.
 * So the guarantees the stdio transport had survive the change of channel.
 *
 * The app closing its end of the port is the engine's signal to shut down, as the end of stdin was.
 */

/** What this host needs from a port: Node's `MessagePort` satisfies it. */
export interface EnginePortLike {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (value: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  off(event: 'message', listener: (value: unknown) => void): unknown;
  off(event: 'close', listener: () => void): unknown;
  start?(): void;
}

/** The acknowledgement the app posts for output it has handled. Not a protocol message: the host consumes it. */
export interface PortAck { t: '__ack'; bytes: number }

export const PORT_ACK = '__ack';
/** Unacknowledged output allowed in flight, in bytes (UTF-16 code units, as the queue counts them). */
export const DEFAULT_PORT_WINDOW_BYTES = 1024 * 1024;

export interface PortHostOptions extends HostHandlers {
  emitter: EventEmitter;
  port: EnginePortLike;
  windowBytes?: number;
  maxQueuedBytes?: number;
  bulkHighWaterBytes?: number;
  bulkLowWaterBytes?: number;
  /** The app closed its end: time to shut down. */
  onClose?: () => void;
}

export type PortHostHandle = (() => void) & { stats: () => WireQueueStats; inFlightBytes: () => number };

export function startPortHost(opts: PortHostOptions): PortHostHandle {
  const { port } = opts;
  const windowBytes = opts.windowBytes ?? DEFAULT_PORT_WINDOW_BYTES;
  let inFlight = 0;
  const drainListeners = new Set<() => void>();

  const { host, dispose: disposeHost, stats } = createQueuedHost({
    write: (chunk) => {
      port.postMessage(chunk);
      inFlight += chunk.length;
      return inFlight < windowBytes;
    },
    onDrain: (listener) => {
      drainListeners.add(listener);
      return () => { drainListeners.delete(listener); };
    },
    reportOverflow: (text) => {
      try { process.stderr.write(`[port.host] ${text}\n`); } catch { /* nothing left to report on */ }
    },
  }, opts, (msg: Outbound) => JSON.stringify(msg));

  const onMessage = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      try { process.stderr.write(`[port.host] dropped a non-object message (${typeof value})\n`); } catch { /* ignore */ }
      return;
    }
    const message = value as { t?: unknown; bytes?: unknown };
    if (message.t === PORT_ACK) {
      const bytes = typeof message.bytes === 'number' && message.bytes > 0 ? message.bytes : 0;
      inFlight = Math.max(0, inFlight - bytes);
      if (inFlight < windowBytes) for (const listener of [...drainListeners]) listener();
      return;
    }
    if (typeof message.t !== 'string') {
      try { process.stderr.write('[port.host] dropped a message with no type\n'); } catch { /* ignore */ }
      return;
    }
    host.ingest(value as Inbound);
  };
  const onClose = (): void => { opts.onClose?.(); };

  port.on('message', onMessage);
  port.on('close', onClose);
  port.start?.();
  host.attach(opts.emitter);

  const dispose = (): void => {
    port.off('message', onMessage);
    port.off('close', onClose);
    drainListeners.clear();
    disposeHost();
  };
  return Object.assign(dispose, { stats, inFlightBytes: () => inFlight });
}

/** The port the app handed this engine worker, or null when the engine is hosted any other way. */
export function engineWorkerPort(): EnginePortLike | null {
  if (isMainThread) return null;
  const port = (workerData as { bimaxEnginePort?: unknown } | null)?.bimaxEnginePort;
  return port && typeof (port as EnginePortLike).postMessage === 'function' ? (port as EnginePortLike) : null;
}
