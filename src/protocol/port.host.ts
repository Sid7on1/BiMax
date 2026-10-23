import { EventEmitter } from 'events';
import { isMainThread, workerData } from 'node:worker_threads';
import { HostHandlers } from './host';
import { Inbound, Outbound } from './protocol';
import { WireQueueStats } from './wire.queue';
import { createQueuedHost } from './queued.host';
import { DEFAULT_PORT_WINDOW_BYTES, PORT_ACK, type EngineWorkerData, type PortAck } from '../engine/api';

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

// The acknowledgement and the window are the app's side of the contract too, so they are declared in the engine's
// public API (src/engine/api.ts); re-exported here for the engine's own code.
export { DEFAULT_PORT_WINDOW_BYTES, PORT_ACK };
export type { PortAck };

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

export type PortHostHandle = (() => void) & {
  stats: () => WireQueueStats;
  inFlightBytes: () => number;
  /** Send one of the engine's own messages (the heartbeat) on the same queue and window as everything else. */
  send: (msg: Outbound) => void;
};

/** Bytes posted on a port before its host existed; the host starts its window from them. */
const postedBeforeHost = new WeakMap<EnginePortLike, number>();
/** The live host's queue for a port, once there is one. */
const liveHostSend = new WeakMap<EnginePortLike, (msg: Outbound) => void>();

/**
 * Post a lifecycle message that may come before the host exists: the `boot` phases, reported while the engine is
 * still loading and there is no queue yet. They are few and small, so they need no queue — but the app acknowledges
 * them like any other output, so they are counted, and the host's window starts from that count. Uncounted, their
 * acknowledgement would later be taken for room the window never gave. Once the host is live, they take its queue.
 */
export function postLifecycle(port: EnginePortLike, msg: Outbound): void {
  const send = liveHostSend.get(port);
  if (send) { send(msg); return; }
  const frame = JSON.stringify(msg);
  port.postMessage(frame);
  postedBeforeHost.set(port, (postedBeforeHost.get(port) ?? 0) + frame.length);
}

export function startPortHost(opts: PortHostOptions): PortHostHandle {
  const { port } = opts;
  const windowBytes = opts.windowBytes ?? DEFAULT_PORT_WINDOW_BYTES;
  let inFlight = postedBeforeHost.get(port) ?? 0;
  postedBeforeHost.delete(port);
  const drainListeners = new Set<() => void>();

  const { host, dispose: disposeHost, stats, send } = createQueuedHost({
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
  liveHostSend.set(port, send);
  host.attach(opts.emitter);

  const dispose = (): void => {
    if (liveHostSend.get(port) === send) liveHostSend.delete(port);
    port.off('message', onMessage);
    port.off('close', onClose);
    drainListeners.clear();
    disposeHost();
  };
  return Object.assign(dispose, { stats, inFlightBytes: () => inFlight, send });
}

/** The port the app handed this engine worker, or null when the engine is hosted any other way. */
export function engineWorkerPort(): EnginePortLike | null {
  if (isMainThread) return null;
  const port = (workerData as Partial<EngineWorkerData> | null)?.bimaxEnginePort;
  return port && typeof (port as EnginePortLike).postMessage === 'function' ? (port as EnginePortLike) : null;
}
