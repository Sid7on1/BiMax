import { EventEmitter } from 'events';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { startPortHost, PORT_ACK } from '../protocol/port.host';
import { INBOUND_FIXTURES } from '../protocol/schema/fixtures';

/**
 * The monolith's protocol transport (record 64, M3): one protocol message per port message, and the stdio transport's
 * bounds kept by an acknowledged window. Driven through a real MessageChannel.
 */

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function open(options: { windowBytes?: number; handlers?: Record<string, unknown>; onClose?: () => void } = {}) {
  const { port1, port2 } = new MessageChannel();
  const emitter = new EventEmitter();
  const received: string[] = [];
  port2.on('message', (value: unknown) => { received.push(value as string); });
  const handle = startPortHost({ emitter, port: port1, windowBytes: options.windowBytes, onClose: options.onClose, ...(options.handlers as object) });
  const parsed = () => received.map((frame) => JSON.parse(frame) as { t: string; [k: string]: unknown });
  return { app: port2 as MessagePort, emitter, handle, received, parsed, close: () => { handle(); port1.close(); port2.close(); } };
}

test('one protocol message per port message: a ping is answered with a pong, framed by nothing', async () => {
  const c = open();
  c.app.postMessage({ t: 'ping', id: 5 });
  await tick();
  expect(c.parsed().find((m) => m.t === 'pong')).toEqual(expect.objectContaining({ t: 'pong', id: 5 }));
  expect(c.received.every((frame) => typeof frame === 'string' && !frame.endsWith('\n'))).toBe(true);
  c.close();
});

test('each inbound kind reaches its handler through the port host (the stdio host has the same test)', async () => {
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

test('the same engine events produce the same messages over the port as over stdio', async () => {
  const { PassThrough } = await import('stream');
  const { startStdioHost } = await import('../protocol/stdio.host');
  const script = (emitter: EventEmitter) => {
    emitter.emit('status', 'Indexing…');
    emitter.emit('message', { id: 'm1', role: 'assistant', content: 'héllo — 你好 🙂', timestamp: '2026-09-29T00:00:00.000Z' });
    emitter.emit('stream_token', 'tok');
  };

  const stdioEmitter = new EventEmitter();
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  output.on('data', (chunk: Buffer) => lines.push(...chunk.toString('utf8').split('\n').filter(Boolean)));
  const disposeStdio = startStdioHost({ emitter: stdioEmitter, input, output });
  script(stdioEmitter);
  input.write(JSON.stringify({ t: 'ping', id: 1 }) + '\n');

  const c = open();
  script(c.emitter);
  c.app.postMessage({ t: 'ping', id: 1 });
  await tick(50);

  const strip = (m: Record<string, unknown>) => JSON.parse(JSON.stringify(m, (k, v) => (k === 'ts' || k === 'pid' || k === 'uptimeMs' ? undefined : v)));
  expect(c.parsed().map(strip)).toEqual(lines.map((line) => strip(JSON.parse(line))));
  expect(lines.length).toBeGreaterThanOrEqual(4);
  disposeStdio();
  c.close();
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
