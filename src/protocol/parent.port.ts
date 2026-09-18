import { Readable } from 'node:stream';

/**
 * The engine's transport when the desktop hosts it as an Electron `utilityProcess` instead of an
 * OS child process.
 *
 * ## Why inbound moves and outbound does not
 *
 * `utilityProcess.fork()` refuses to give its child a stdin: Electron accepts only `'ignore'` for
 * `stdio[0]` and errors on anything else. So the front-end's commands cannot arrive on a pipe any
 * more and come over the MessagePort that `process.parentPort` exposes.
 *
 * Outbound is deliberately left where it is — NDJSON on a piped stdout. A MessagePort has no
 * backpressure: `postMessage` always accepts, so a front-end that stopped draining would be
 * invisible, and `WireQueue`'s whole bounded-and-announced design rests on `write()` returning
 * false and a later `'drain'`. Keeping outbound on the stream keeps that behaviour byte-identical
 * to the child-process transport, and keeps stderr going to engine.log exactly as before. Only the
 * direction that Electron forces us to move actually moves.
 */

/** True when this process was started by Electron's `utilityProcess` (only then is there a port). */
export function underUtilityProcess(): boolean {
  return !!(process as unknown as { parentPort?: unknown }).parentPort;
}

/**
 * Inbound protocol lines, as a stream `startStdioHost` can consume in place of `process.stdin`.
 *
 * The host reads this in flowing mode and does its own line framing, so whole-chunk fidelity is all
 * that is required here: each message is pushed as it arrives, in order. `read()` is a no-op
 * because nothing is pulled — the port is the only producer.
 */
export function parentPortInput(): NodeJS.ReadableStream {
  const port = (process as unknown as { parentPort: NodeJS.EventEmitter & { start?: () => void } }).parentPort;
  const input = new Readable({ read() { /* pushed by the port listener below */ } });

  port.on('message', (event: { data?: unknown }) => {
    const data = event?.data;
    // Strings are the wire format. A non-string is coerced rather than dropped so a framing bug
    // surfaces as the host's own "dropped malformed line" on stderr, which names the payload,
    // instead of vanishing here with no record that anything arrived.
    const text = typeof data === 'string' ? data : data === undefined || data === null ? '' : String(data);
    if (text) input.push(text);
  });

  // Electron's ParentPort begins queued; Node's MessagePort needs an explicit start. Guarded
  // because only one of the two shapes has it.
  port.start?.();

  return input as unknown as NodeJS.ReadableStream;
}
