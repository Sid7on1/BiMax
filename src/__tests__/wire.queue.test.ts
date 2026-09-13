import { EventEmitter } from 'events';
import { Writable } from 'stream';
import { WireQueue, outboundClass } from '../protocol/wire.queue';
import { startStdioHost } from '../protocol/stdio.host';
import { Outbound } from '../protocol/protocol';

/**
 * The transport slice of F04. Two properties carry the weight:
 *
 *  - order is absolute (nothing overtakes bytes already queued on the same pipe), so critical
 *    delivery is bought with reserved capacity rather than with priority;
 *  - what is withheld or discarded is counted and announced, never silently lost.
 */

/** A sink you drive by hand: it records what it was given and decides when to accept more. */
function sink() {
  const written: string[] = [];
  const drainListeners: (() => void)[] = [];
  let accept = true;
  let throwOnWrite = false;
  return {
    written,
    setAccept(value: boolean) { accept = value; },
    setThrow(value: boolean) { throwOnWrite = value; },
    drain() { for (const l of [...drainListeners]) l(); },
    options: {
      write: (chunk: string): boolean => {
        if (throwOnWrite) throw new Error('EPIPE');
        written.push(chunk);
        return accept;
      },
      onDrain: (listener: () => void): (() => void) => {
        drainListeners.push(listener);
        return () => {
          const i = drainListeners.indexOf(listener);
          if (i >= 0) drainListeners.splice(i, 1);
        };
      },
    },
  };
}

const line = (n: number, size = 10) => `${String(n).padStart(4, '0')}${'x'.repeat(Math.max(0, size - 5))}\n`;

describe('outboundClass', () => {
  it('treats display events as bulk and everything else as critical', () => {
    expect(outboundClass({ t: 'event', name: 'log', args: [] } as unknown as Outbound)).toBe('bulk');
    for (const msg of [
      { t: 'hello' }, { t: 'ready' }, { t: 'request', id: 1 }, { t: 'pong', id: 1 },
      { t: 'queryResult', id: 1, items: [] }, { t: 'configResult', id: 1, config: {} },
      { t: 'catalogResult', id: 1, providers: [], models: [] },
    ] as unknown as Outbound[]) {
      expect(outboundClass(msg)).toBe('critical');
    }
  });
});

describe('WireQueue — order is absolute', () => {
  it('writes in enqueue order regardless of class', () => {
    const s = sink();
    const q = new WireQueue({ ...s.options, maxQueuedBytes: 10_000, bulkHighWaterBytes: 5_000, bulkLowWaterBytes: 1_000 });
    q.enqueue('bulk-1\n', 'bulk');
    q.enqueue('critical-1\n', 'critical');
    q.enqueue('bulk-2\n', 'bulk');
    // A "priority lane" would have moved critical-1 to the front. On one pipe that is not possible,
    // and pretending otherwise is the failure this design refuses to make.
    expect(s.written).toEqual(['bulk-1\n', 'critical-1\n', 'bulk-2\n']);
  });

  it('preserves order across a backpressure pause and the drain that follows', () => {
    const s = sink();
    const q = new WireQueue({ ...s.options, maxQueuedBytes: 10_000, bulkHighWaterBytes: 5_000, bulkLowWaterBytes: 4_000 });
    s.setAccept(false);
    q.enqueue('a\n', 'bulk');          // handed over, sink says "no more"
    q.enqueue('b\n', 'critical');      // queued behind it
    q.enqueue('c\n', 'bulk');
    expect(s.written).toEqual(['a\n']);
    expect(q.snapshot().backpressureEvents).toBe(1);

    s.setAccept(true);
    s.drain();
    expect(s.written).toEqual(['a\n', 'b\n', 'c\n']);
    expect(q.snapshot().queuedMessages).toBe(0);
  });

  it('writes multi-byte content through byte-for-byte and measures it in bytes', () => {
    const s = sink();
    const q = new WireQueue({ ...s.options, maxQueuedBytes: 10_000, bulkHighWaterBytes: 5_000, bulkLowWaterBytes: 1_000 });
    const unicode = JSON.stringify({ t: 'event', name: 'log', args: ['🚀 日本語 café'] }) + '\n';
    s.setAccept(false);
    q.enqueue(unicode, 'bulk');
    q.enqueue(unicode, 'bulk');
    expect(s.written[0]).toBe(unicode);
    // Byte length, not character length: a UTF-8 budget counted in characters under-counts by ~3x
    // on this content and would let the queue run past its ceiling.
    expect(q.snapshot().queuedBytes).toBe(Buffer.byteLength(unicode, 'utf8'));
    expect(q.snapshot().queuedBytes).toBeGreaterThan(unicode.length);
  });
});

describe('WireQueue — capacity is reserved before saturation', () => {
  it('stops admitting bulk at the high-water mark and keeps admitting critical', () => {
    const s = sink();
    const paused: unknown[] = [];
    const q = new WireQueue({
      ...s.options, maxQueuedBytes: 1_000, bulkHighWaterBytes: 300, bulkLowWaterBytes: 100,
      onBulkPaused: info => paused.push(info),
    });
    s.setAccept(false);
    let admittedBulk = 0;
    for (let i = 0; i < 100; i++) {
      if (q.enqueue(line(i, 50), 'bulk').admitted) admittedBulk++;
    }
    expect(admittedBulk).toBeGreaterThan(0);
    expect(q.snapshot().bulkPaused).toBe(true);
    expect(paused.length).toBe(1); // announced once, not once per refusal
    expect(q.snapshot().refusedBulk).toBe(100 - admittedBulk);
    expect(q.snapshot().queuedBytes).toBeLessThanOrEqual(300);

    // The reserve above the high-water mark is what makes this possible.
    expect(q.enqueue('{"t":"request","id":1}\n', 'critical')).toEqual({ admitted: true });
    expect(q.snapshot().refusedCritical).toBe(0);
  });

  it('resumes bulk only after draining below the low-water mark, and reports what was withheld', () => {
    const s = sink();
    const resumed: { refused: number }[] = [];
    const q = new WireQueue({
      ...s.options, maxQueuedBytes: 1_000, bulkHighWaterBytes: 300, bulkLowWaterBytes: 100,
      onBulkResumed: info => resumed.push(info),
    });
    s.setAccept(false);
    for (let i = 0; i < 50; i++) q.enqueue(line(i, 50), 'bulk');
    expect(q.snapshot().bulkPaused).toBe(true);
    const withheld = q.snapshot().refusedBulk;
    expect(withheld).toBeGreaterThan(0);

    s.setAccept(true);
    s.drain();
    expect(q.snapshot().bulkPaused).toBe(false);
    expect(resumed).toEqual([expect.objectContaining({ refused: withheld })]);
    expect(q.enqueue(line(999, 50), 'bulk')).toEqual({ admitted: true });
  });

  it('reports overflow once when the reserve itself fills, then stops growing', () => {
    const s = sink();
    const overflows: unknown[] = [];
    const q = new WireQueue({
      ...s.options, maxQueuedBytes: 500, bulkHighWaterBytes: 200, bulkLowWaterBytes: 100,
      onOverflow: info => overflows.push(info),
    });
    s.setAccept(false);
    for (let i = 0; i < 200; i++) q.enqueue(line(i, 50), 'critical');

    expect(overflows.length).toBe(1);
    expect(q.snapshot().overflowed).toBe(true);
    // Bounded: the queue never exceeded its ceiling, and refuses everything afterwards rather than
    // growing without limit while pretending the messages were delivered.
    expect(q.snapshot().peakQueuedBytes).toBeLessThanOrEqual(500);
    expect(q.enqueue('late\n', 'critical')).toEqual({ admitted: false, reason: 'overflow' });
    expect(q.enqueue('late\n', 'bulk')).toEqual({ admitted: false, reason: 'overflow' });
  });

  it('treats a throwing sink as terminal rather than waiting for a drain that never comes', () => {
    const s = sink();
    const overflows: unknown[] = [];
    const q = new WireQueue({
      ...s.options, maxQueuedBytes: 400, bulkHighWaterBytes: 200, bulkLowWaterBytes: 100,
      onOverflow: info => overflows.push(info),
    });
    s.setThrow(true);
    q.enqueue(line(1, 50), 'critical');
    expect(q.snapshot().writtenMessages).toBe(0);
    expect(q.isSinkFailed()).toBe(true);
    // The unwritten line is still queued; continued production fills the queue and reports the
    // dead consumer instead of losing messages quietly.
    for (let i = 0; i < 50; i++) q.enqueue(line(i, 50), 'critical');
    expect(overflows.length).toBe(1);
  });

  it('refuses watermarks that cannot reserve anything', () => {
    const s = sink();
    expect(() => new WireQueue({ ...s.options, maxQueuedBytes: 100, bulkHighWaterBytes: 100, bulkLowWaterBytes: 50 }))
      .toThrow(/watermarks must satisfy/);
    expect(() => new WireQueue({ ...s.options, maxQueuedBytes: 100, bulkHighWaterBytes: 50, bulkLowWaterBytes: 80 }))
      .toThrow(/watermarks must satisfy/);
  });
});

describe('WireQueue — cancellation', () => {
  it('drops queued bulk and keeps every critical message, counting the drop', () => {
    const s = sink();
    const q = new WireQueue({ ...s.options, maxQueuedBytes: 10_000, bulkHighWaterBytes: 5_000, bulkLowWaterBytes: 1_000 });
    s.setAccept(false);
    q.enqueue('first\n', 'bulk');           // handed to the sink already
    q.enqueue('bulk-a\n', 'bulk');
    q.enqueue('critical-a\n', 'critical');
    q.enqueue('bulk-b\n', 'bulk');
    q.enqueue('critical-b\n', 'critical');

    expect(q.dropPendingBulk()).toBe(2);
    expect(q.snapshot().droppedBulkOnCancel).toBe(2);

    s.setAccept(true);
    s.drain();
    expect(s.written).toEqual(['first\n', 'critical-a\n', 'critical-b\n']);
  });

  it('reports congestion against the low-water mark', () => {
    const s = sink();
    const q = new WireQueue({ ...s.options, maxQueuedBytes: 1_000, bulkHighWaterBytes: 400, bulkLowWaterBytes: 100 });
    expect(q.congested()).toBe(false);
    s.setAccept(false);
    for (let i = 0; i < 5; i++) q.enqueue(line(i, 50), 'bulk');
    expect(q.congested()).toBe(true);
  });

  it('reports what was never written when disposed', () => {
    const s = sink();
    const q = new WireQueue({ ...s.options, maxQueuedBytes: 10_000, bulkHighWaterBytes: 5_000, bulkLowWaterBytes: 1_000 });
    s.setAccept(false);
    q.enqueue('a\n', 'bulk');
    q.enqueue('b\n', 'bulk');
    q.enqueue('c\n', 'critical');
    const unsent = q.dispose();
    expect(unsent.unsentMessages).toBe(2);
    expect(unsent.unsentBytes).toBe(Buffer.byteLength('b\nc\n', 'utf8'));
    expect(q.enqueue('d\n', 'critical')).toEqual({ admitted: false, reason: 'disposed' });
  });
});

/** A real stream that accepts one write and then never drains, i.e. a front-end that stopped reading. */
class StalledStream extends Writable {
  lines: string[] = [];
  private release: (() => void) | null = null;
  constructor() { super({ highWaterMark: 1, decodeStrings: false }); }
  _write(chunk: any, _enc: string, cb: () => void): void {
    this.lines.push(String(chunk));
    this.release = cb;
  }
  /** Let the single in-flight write complete, which produces a 'drain'. */
  releaseOne(): void { const cb = this.release; this.release = null; cb?.(); }
}

describe('stdio host — a front-end that stops reading', () => {
  it('delivers the handshake, withholds bulk, and says so on the wire', async () => {
    const emitter = new EventEmitter();
    const output = new StalledStream();
    const dispose = startStdioHost({
      emitter, output,
      input: Object.assign(new EventEmitter(), { off: EventEmitter.prototype.off }) as any,
      maxQueuedBytes: 4_000, bulkHighWaterBytes: 1_500, bulkLowWaterBytes: 500,
    });

    // hello + ready are critical and go out before anything else can congest the pipe.
    const first = output.lines.map(l => JSON.parse(l).t);
    expect(first[0]).toBe('hello');

    for (let i = 0; i < 500; i++) emitter.emit('log', { id: i, level: 'info', text: 'x'.repeat(200) });

    const stats = dispose.stats();
    expect(stats.bulkPaused).toBe(true);
    expect(stats.refusedBulk).toBeGreaterThan(0);
    expect(stats.queuedBytes).toBeLessThanOrEqual(4_000);

    // The notice about withheld output is itself delivered — enqueued as critical, because a
    // warning that gets withheld by the condition it describes is useless. Drain the stalled
    // stream one write at a time until the queue empties.
    for (let i = 0; i < 500 && dispose.stats().queuedMessages > 0; i++) {
      output.releaseOne();
      await new Promise(r => setImmediate(r));
    }
    expect(dispose.stats().queuedMessages).toBe(0);
    const texts = output.lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(m => m?.name === 'log')
      .map(m => String(m.args?.[0]?.text ?? ''));
    expect(texts.some(t => t.includes('[transport] output paused'))).toBe(true);

    dispose();
  });

  it('discards queued display output on interrupt only when the pipe is congested', async () => {
    const emitter = new EventEmitter();
    const input = new EventEmitter() as any;
    input.off = EventEmitter.prototype.off;
    const output = new StalledStream();
    let interrupted = 0;

    const dispose = startStdioHost({
      emitter, output, input,
      onInterrupt: () => { interrupted++; },
      maxQueuedBytes: 8_000, bulkHighWaterBytes: 3_000, bulkLowWaterBytes: 500,
    });

    for (let i = 0; i < 40; i++) emitter.emit('log', { id: i, level: 'info', text: 'y'.repeat(100) });
    expect(dispose.stats().queuedBytes).toBeGreaterThan(500);

    input.emit('data', Buffer.from(JSON.stringify({ t: 'interrupt' }) + '\n', 'utf8'));

    // The stop is acknowledged AND the cancelled turn's queued output is gone, which is the only
    // way a stop stays responsive on a pipe that already has megabytes queued ahead of it.
    expect(interrupted).toBe(1);
    expect(dispose.stats().droppedBulkOnCancel).toBeGreaterThan(0);
    dispose();
  });

  it('keeps queued output on an interrupt when the pipe is NOT congested', () => {
    const emitter = new EventEmitter();
    const input = new EventEmitter() as any;
    input.off = EventEmitter.prototype.off;
    // Stalled, so output really does queue — but the watermarks are far above what is queued, so
    // the stop acknowledgement is already prompt and there is no reason to throw work away.
    const output = new StalledStream();
    let interrupted = 0;
    const dispose = startStdioHost({
      emitter, output, input,
      onInterrupt: () => { interrupted++; },
      maxQueuedBytes: 200_000, bulkHighWaterBytes: 100_000, bulkLowWaterBytes: 50_000,
    });

    for (let i = 0; i < 3; i++) emitter.emit('log', { id: i, level: 'info', text: 'a short line' });
    const queuedBefore = dispose.stats().queuedMessages;
    expect(queuedBefore).toBeGreaterThan(0);   // there IS something that could be discarded
    expect(dispose.stats().queuedBytes).toBeLessThan(50_000);

    input.emit('data', Buffer.from(JSON.stringify({ t: 'interrupt' }) + '\n', 'utf8'));

    expect(interrupted).toBe(1);
    expect(dispose.stats().droppedBulkOnCancel).toBe(0);
    expect(dispose.stats().queuedMessages).toBe(queuedBefore);
    dispose();
  });

  it('leaves a healthy transport with nothing withheld and nothing queued', () => {
    const emitter = new EventEmitter();
    const input = new EventEmitter() as any;
    input.off = EventEmitter.prototype.off;
    const written: string[] = [];
    const output = new Writable({ write(chunk, _e, cb) { written.push(String(chunk)); cb(); } });
    const dispose = startStdioHost({ emitter, output, input });

    for (let i = 0; i < 200; i++) emitter.emit('log', { id: i, level: 'info', text: `line ${i}` });
    const stats = dispose.stats();
    expect(stats.refusedBulk).toBe(0);
    expect(stats.bulkPaused).toBe(false);
    expect(stats.overflowed).toBe(false);
    expect(stats.queuedMessages).toBe(0);
    expect(written.length).toBe(stats.writtenMessages);
    dispose();
  });
});
