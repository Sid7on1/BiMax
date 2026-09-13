import { StreamCoalescer, FlushReason } from '../renderer/src/stream.coalescer';
import { engineReducer, initialEngineState, EngineUiState } from '../renderer/src/engine.state';
import type { Outbound } from '../renderer/src/protocol';

/**
 * Coalescing is only permissible because the reducer folds these deltas with an associative
 * operation, so the strongest test is the direct one: run the same event sequence through the real
 * reducer with and without the coalescer and require the resulting state to be identical.
 */

const ev = (name: string, ...args: unknown[]): Outbound =>
  ({ t: 'event', name, args } as unknown as Outbound);

/** A frame scheduler the test drives by hand, so "one frame" is exact rather than timing-dependent. */
function frames() {
  let queued: (() => void)[] = [];
  return {
    schedule: (cb: () => void): (() => void) => {
      queued.push(cb);
      return () => { queued = queued.filter(q => q !== cb); };
    },
    tick(): void { const due = queued; queued = []; for (const cb of due) cb(); },
    pending(): number { return queued.length; },
  };
}

function reduceAll(msgs: Outbound[]): EngineUiState {
  return msgs.reduce((state, msg) => engineReducer(state, { type: 'outbound', msg }), initialEngineState);
}

describe('StreamCoalescer — the transcript is byte-identical', () => {
  it('produces the same reducer state as dispatching every delta individually', () => {
    const f = frames();
    const emitted: Outbound[] = [];
    const c = new StreamCoalescer({ emit: m => emitted.push(m), scheduleFrame: f.schedule, maxLatencyMs: 10_000 });

    const source: Outbound[] = [];
    for (const token of ['Hello', ', ', 'wor', 'ld', ' — ', '🚀', ' 日本語', '\n\n', 'done.']) {
      source.push(ev('stream_token', token));
    }
    for (const msg of source) c.push(msg);
    f.tick();

    // One dispatch instead of nine, and the same string in the same field.
    expect(emitted.length).toBe(1);
    expect(reduceAll(emitted).streaming).toBe(reduceAll(source).streaming);
    expect(reduceAll(emitted).streaming).toBe('Hello, world — 🚀 日本語\n\ndone.');
  });

  it('keeps multi-byte characters intact when they arrive split across deltas', () => {
    const f = frames();
    const emitted: Outbound[] = [];
    const c = new StreamCoalescer({ emit: m => emitted.push(m), scheduleFrame: f.schedule, maxLatencyMs: 10_000 });
    // A surrogate pair split across two deltas: concatenation must restore it, not two replacements.
    const rocket = '🚀';
    c.push(ev('stream_token', rocket.slice(0, 1)));
    c.push(ev('stream_token', rocket.slice(1)));
    f.tick();
    expect(reduceAll(emitted).streaming).toBe(rocket);
    expect(reduceAll(emitted).streaming).not.toContain('�');
  });

  it('matches the uncoalesced reducer over a long mixed sequence', () => {
    const f = frames();
    const emitted: Outbound[] = [];
    const c = new StreamCoalescer({ emit: m => emitted.push(m), scheduleFrame: f.schedule, maxLatencyMs: 10_000 });

    const source: Outbound[] = [];
    for (let i = 0; i < 40; i++) source.push(ev('thinking', `t${i} `));
    for (let i = 0; i < 200; i++) source.push(ev('stream_token', `w${i} `));
    source.push(ev('tool_call', { id: 'x', toolName: 'Read', input: 'a', output: '', status: 'success', startTime: '' }));
    for (let i = 0; i < 200; i++) source.push(ev('stream_token', `z${i} `));

    for (const msg of source) { c.push(msg); f.tick(); }
    c.flush();

    const batched = reduceAll(emitted);
    const direct = reduceAll(source);
    expect(batched.streaming).toBe(direct.streaming);
    expect(batched.thinking).toBe(direct.thinking);
    expect(batched.items).toEqual(direct.items);
  });
});

describe('StreamCoalescer — order is preserved', () => {
  it('flushes buffered text before a message that is not a delta', () => {
    const f = frames();
    const emitted: Outbound[] = [];
    const c = new StreamCoalescer({ emit: m => emitted.push(m), scheduleFrame: f.schedule, maxLatencyMs: 10_000 });

    c.push(ev('stream_token', 'partial answer'));
    c.push({ t: 'request', id: 1, kind: 'diff', question: 'Approve?', options: [] } as unknown as Outbound);

    // The approval is not delayed behind a batch, and the text it interrupts is not delayed past it.
    expect(emitted.map(m => (m as any).t)).toEqual(['event', 'request']);
    expect((emitted[0] as any).args[0]).toBe('partial answer');
    expect(c.snapshot().flushes.boundary).toBe(1);
  });

  it('flushes when the delta kind changes, so interleaving is not reordered', () => {
    const f = frames();
    const emitted: Outbound[] = [];
    const c = new StreamCoalescer({ emit: m => emitted.push(m), scheduleFrame: f.schedule, maxLatencyMs: 10_000 });

    c.push(ev('thinking', 'considering '));
    c.push(ev('stream_token', 'The answer '));
    c.push(ev('thinking', 'more thought'));
    c.flush();

    expect(emitted.map(m => (m as any).name)).toEqual(['thinking', 'stream_token', 'thinking']);
    expect(c.snapshot().flushes['kind-change']).toBe(2);
  });

  it('never delays a final assistant message behind the text it supersedes', () => {
    const f = frames();
    const emitted: Outbound[] = [];
    const c = new StreamCoalescer({ emit: m => emitted.push(m), scheduleFrame: f.schedule, maxLatencyMs: 10_000 });
    c.push(ev('stream_token', 'half a sen'));
    c.push(ev('message', { id: 'm1', role: 'assistant', content: 'half a sentence, finished', timestamp: '' }));
    f.tick();

    const state = reduceAll(emitted);
    expect(state.streaming).toBe('');                       // the final message cleared the buffer
    expect((state.items[0] as any).msg.content).toBe('half a sentence, finished');
  });

  it('passes non-delta messages through untouched and counts them', () => {
    const f = frames();
    const emitted: Outbound[] = [];
    const c = new StreamCoalescer({ emit: m => emitted.push(m), scheduleFrame: f.schedule });
    const passthrough = [
      { t: 'ready', protocol: 3 },
      ev('spinner_state', 'thinking', 'Thinking…'),
      ev('tool_call', { id: 'a' }),
      { t: 'queryResult', id: 1, items: [] },
    ] as unknown as Outbound[];
    for (const m of passthrough) c.push(m);
    expect(emitted).toEqual(passthrough);
    expect(c.snapshot().passthrough).toBe(4);
    expect(c.snapshot().batches).toBe(0);
  });
});

describe('StreamCoalescer — flush triggers', () => {
  it('emits once per frame, not once per delta', () => {
    const f = frames();
    const emitted: Outbound[] = [];
    const c = new StreamCoalescer({ emit: m => emitted.push(m), scheduleFrame: f.schedule, maxLatencyMs: 10_000 });
    for (let i = 0; i < 300; i++) c.push(ev('stream_token', `${i} `));
    expect(emitted.length).toBe(0); // nothing dispatched yet — still inside the frame
    f.tick();
    expect(emitted.length).toBe(1);
    const stats = c.snapshot();
    expect(stats.received).toBe(300);
    expect(stats.batches).toBe(1);
    expect(stats.dispatchesSaved).toBe(299);
    expect(stats.flushes.frame).toBe(1);
  });

  it('flushes on the maximum-latency timer when no frame ever arrives (a hidden window)', () => {
    jest.useFakeTimers();
    try {
      const emitted: Outbound[] = [];
      // A window that is not visible gets no frame callbacks at all: this scheduler never fires.
      const c = new StreamCoalescer({
        emit: m => emitted.push(m),
        scheduleFrame: () => () => { /* a hidden window is handed no frames */ },
        maxLatencyMs: 50,
      });
      c.push(ev('stream_token', 'still streaming'));
      expect(emitted.length).toBe(0);
      jest.advanceTimersByTime(49);
      expect(emitted.length).toBe(0);
      jest.advanceTimersByTime(1);
      expect(emitted.length).toBe(1);
      expect(c.snapshot().flushes['max-latency']).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('flushes on the size ceiling however slow the frames are', () => {
    const f = frames();
    const emitted: Outbound[] = [];
    const c = new StreamCoalescer({ emit: m => emitted.push(m), scheduleFrame: f.schedule, maxLatencyMs: 10_000, maxPendingChars: 100 });
    for (let i = 0; i < 30; i++) c.push(ev('stream_token', 'x'.repeat(10)));
    expect(emitted.length).toBe(3);
    expect(c.snapshot().flushes.size).toBe(3);
    expect(c.snapshot().pendingChars).toBe(0);
  });

  it('a flush with nothing pending emits nothing', () => {
    const f = frames();
    const emitted: Outbound[] = [];
    const c = new StreamCoalescer({ emit: m => emitted.push(m), scheduleFrame: f.schedule });
    c.flush();
    c.flush();
    expect(emitted).toEqual([]);
    expect(c.snapshot().batches).toBe(0);
  });
});

describe('StreamCoalescer — boundaries and retirement', () => {
  it('flushes pending text on dispose rather than losing it', () => {
    const f = frames();
    const emitted: Outbound[] = [];
    const c = new StreamCoalescer({ emit: m => emitted.push(m), scheduleFrame: f.schedule, maxLatencyMs: 10_000 });
    c.push(ev('stream_token', 'unflushed tail'));
    c.dispose();
    expect(reduceAll(emitted).streaming).toBe('unflushed tail');
    // And nothing is accepted afterwards.
    c.push(ev('stream_token', 'too late'));
    expect(emitted.length).toBe(1);
  });

  it('retire() drops buffered text for a discarded task and reports how much', () => {
    const f = frames();
    const emitted: Outbound[] = [];
    const c = new StreamCoalescer({ emit: m => emitted.push(m), scheduleFrame: f.schedule, maxLatencyMs: 10_000 });
    c.push(ev('stream_token', 'text from the old project'));
    expect(c.retire()).toBe('text from the old project'.length);
    f.tick();
    // The buffered text never reaches the reducer, and the timer it armed does not resurrect it.
    expect(emitted).toEqual([]);
    expect(c.snapshot().retiredChars).toBe('text from the old project'.length);
  });

  it('leaves nothing scheduled after a flush, a retire or a dispose', () => {
    jest.useFakeTimers();
    try {
      const f = frames();
      const emitted: Outbound[] = [];
      const c = new StreamCoalescer({ emit: m => emitted.push(m), scheduleFrame: f.schedule, maxLatencyMs: 50 });

      c.push(ev('stream_token', 'a'));
      expect(c.armed()).toBe(true);
      expect(f.pending()).toBe(1);
      c.flush();
      // A stream that has stopped must not keep a frame callback and a 50 ms timer alive behind it.
      expect(c.armed()).toBe(false);
      expect(f.pending()).toBe(0);

      c.push(ev('stream_token', 'b'));
      expect(c.armed()).toBe(true);
      c.retire();
      expect(c.armed()).toBe(false);

      c.push(ev('stream_token', 'c'));
      c.dispose();
      expect(c.armed()).toBe(false);

      // And nothing that was armed earlier fires a second time.
      const emittedAfter = emitted.length;
      f.tick();
      jest.advanceTimersByTime(1000);
      expect(emitted.length).toBe(emittedAfter);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('StreamCoalescer — what it reports', () => {
  it('counts saved dispatches as deltas received minus batches emitted', () => {
    const f = frames();
    const emitted: Outbound[] = [];
    const c = new StreamCoalescer({ emit: m => emitted.push(m), scheduleFrame: f.schedule, maxLatencyMs: 10_000 });
    for (let batch = 0; batch < 5; batch++) {
      for (let i = 0; i < 20; i++) c.push(ev('stream_token', 'x'));
      f.tick();
    }
    const stats = c.snapshot();
    expect(stats.received).toBe(100);
    expect(stats.batches).toBe(5);
    expect(stats.dispatchesSaved).toBe(95);
    const reasons = Object.entries(stats.flushes).filter(([, n]) => n > 0).map(([r]) => r as FlushReason);
    expect(reasons).toEqual(['frame']);
  });
});
