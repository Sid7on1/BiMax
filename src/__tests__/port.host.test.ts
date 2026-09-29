import { EventEmitter } from 'events';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { startPortHost, PORT_ACK } from '../protocol/port.host';
import { INBOUND_FIXTURES } from '../protocol/schema/fixtures';

/**
 * The monolith's protocol transport (record 64, M3), the only one since M4: one protocol message per port message, and
 * the bounds the old stdio transport had kept by an acknowledged window. Driven through a real MessageChannel.
 */

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function open(options: { windowBytes?: number; handlers?: Record<string, unknown>; onClose?: () => void } = {}) {
  const { port1, port2 } = new MessageChannel();
  const emitter = new EventEmitter();
  const received: string[] = [];
  port2.on('message', (value: unknown) => { received.push(value as string); });
  const handle = startPortHost({ emitter, port: port1, windowBytes: options.windowBytes, onClose: options.onClose, ...(options.handlers as object) });
  const parsed = () => received.map((frame) => JSON.parse(frame) as { t: string; [k: string]: unknown });
  return { app: port2 as MessagePort, engine: port1 as MessagePort, emitter, handle, received, parsed, close: () => { handle(); port1.close(); port2.close(); } };
}

test('one protocol message per port message: a ping is answered with a pong, framed by nothing', async () => {
  const c = open();
  c.app.postMessage({ t: 'ping', id: 5 });
  await tick();
  expect(c.parsed().find((m) => m.t === 'pong')).toEqual(expect.objectContaining({ t: 'pong', id: 5 }));
  expect(c.received.every((frame) => typeof frame === 'string' && !frame.endsWith('\n'))).toBe(true);
  c.close();
});

test('each inbound kind reaches its handler through the port host (host.handlers.test.ts checks every kind)', async () => {
  const called = new Set<string>();
  const names = ['onInput', 'onInterrupt', 'onSteer', 'onQuery', 'onMenuSelect', 'onConfigGet', 'onConfigSet', 'onCatalogGet', 'onProviderSet', 'onResume', 'onControls'];
  const handlers = Object.fromEntries(names.map((name) => [name, () => { called.add(name); return name === 'onQuery' ? [] : name === 'onConfigGet' || name === 'onConfigSet' ? {} : undefined; }]));
  const c = open({ handlers });
  for (const frame of INBOUND_FIXTURES) c.app.postMessage(frame);
  await tick(50);
  expect(called.has('onSteer')).toBe(true);
  expect(called.has('onInput')).toBe(true);
  expect(called.size).toBeGreaterThanOrEqual(8);
  c.close();
});

test('output beyond the window waits for the app to acknowledge it, then flows', async () => {
  const c = open({ windowBytes: 600 });
  for (let i = 0; i < 20; i++) c.emitter.emit('status', `line ${i} ${'x'.repeat(80)}`);
  await tick();
  const first = c.received.length;
  expect(first).toBeGreaterThan(0);
  expect(first).toBeLessThan(20);                    // the window held the rest back
  expect(c.handle.inFlightBytes()).toBeGreaterThanOrEqual(600);
  expect(c.handle.stats().backpressureEvents).toBeGreaterThan(0);
  const bytes = c.received.reduce((sum, frame) => sum + frame.length, 0);
  c.app.postMessage({ t: PORT_ACK, bytes });
  await tick();
  expect(c.received.length).toBeGreaterThan(first);   // the acknowledgement released more
  c.close();
});

test('an acknowledgement and junk are never taken for protocol messages', async () => {
  const onInput = jest.fn();
  const c = open({ handlers: { onInput } });
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  c.app.postMessage({ t: PORT_ACK, bytes: 10 });
  c.app.postMessage('input hello');
  c.app.postMessage({ text: 'no type' });
  c.app.postMessage({ t: 'input', text: 'real' });
  await tick();
  expect(onInput).toHaveBeenCalledTimes(1);
  expect(onInput).toHaveBeenCalledWith('real');
  expect(stderr.mock.calls.map(([line]) => String(line)).filter((l) => l.includes('[port.host]'))).toHaveLength(2);
  stderr.mockRestore();
  c.close();
});

test('the app closing its end of the port is the engine\'s signal to shut down', async () => {
  const onClose = jest.fn();
  const c = open({ onClose });
  c.app.close();
  await tick(50);
  expect(onClose).toHaveBeenCalledTimes(1);
  c.handle();
});

test('congested and interrupted: queued display output for the cancelled turn is dropped, and the stop is acknowledged', async () => {
  const onInterrupt = jest.fn();
  const c = open({ windowBytes: 100, handlers: { onInterrupt } });
  // Never acknowledged: the window stays shut and the queue fills with display output.
  for (let i = 0; i < 400; i++) c.emitter.emit('stream_token', 'y'.repeat(20_000));
  await tick();
  expect(c.handle.stats().queuedBytes).toBeGreaterThan(1_000_000);
  c.app.postMessage({ t: 'interrupt' });
  await tick();
  expect(onInterrupt).toHaveBeenCalledTimes(1);
  expect(c.handle.stats().droppedBulkOnCancel).toBeGreaterThan(0);
  c.close();
});

// ─── the engine's own lifecycle messages (record 64, M3 follow-up) ──────────────────────────────────────────────────
// The heartbeat and the boot phases used to be written straight to stdout. Over the port stdout is only a log, so the
// supervisor never saw a heartbeat — and its hang detection only arms on the first one — nor a single boot phase.

test('the heartbeat goes out on the port, through the queue, like every other message', async () => {
  const c = open();
  c.handle.send({ t: 'health', uptimeMs: 1, rssMb: 2, heapMb: 3, eventLoopDelayMs: 4, activeTurn: false, phase: 'ready' });
  await tick();
  expect(c.parsed().find((m) => m.t === 'health')).toEqual(expect.objectContaining({ t: 'health', heapMb: 3, activeTurn: false }));
  expect(c.handle.stats().enqueuedCritical).toBeGreaterThan(0);
  c.close();
});

test('boot phases posted before the host exists are counted, so acknowledging them opens no room the window never gave', async () => {
  const { postLifecycle } = await import('../protocol/port.host');
  const { port1, port2 } = new MessageChannel();
  const received: string[] = [];
  port2.on('message', (value: unknown) => { received.push(value as string); });
  postLifecycle(port1, { t: 'boot', phase: 'booting', pid: 1 });
  postLifecycle(port1, { t: 'boot', phase: 'loading_tools', pid: 1, detail: 'container ready' });
  await tick();
  expect(received.map((frame) => JSON.parse(frame).t)).toEqual(['boot', 'boot']);
  const bootBytes = received.reduce((sum, frame) => sum + frame.length, 0);

  const handle = startPortHost({ emitter: new EventEmitter(), port: port1 });
  await tick();
  const hostBytes = received.slice(2).reduce((sum, frame) => sum + frame.length, 0);
  expect(hostBytes).toBeGreaterThan(0);                               // the handshake
  expect(handle.inFlightBytes()).toBe(bootBytes + hostBytes);
  port2.postMessage({ t: PORT_ACK, bytes: bootBytes });              // the app acknowledges the boot frames only
  await tick();
  expect(handle.inFlightBytes()).toBe(hostBytes);                     // exactly what the host itself has in flight
  handle();
  port1.close();
  port2.close();
});

test('a lifecycle message posted once the host is live takes its queue, not a side door', async () => {
  const { postLifecycle } = await import('../protocol/port.host');
  const c = open();
  await tick();
  const before = c.handle.stats().enqueuedCritical;
  postLifecycle(c.engine, { t: 'boot', phase: 'restoring_session', pid: 1 });
  await tick();
  expect(c.handle.stats().enqueuedCritical).toBe(before + 1);
  expect(c.parsed().filter((m) => m.t === 'boot')).toHaveLength(1);
  c.close();
});
