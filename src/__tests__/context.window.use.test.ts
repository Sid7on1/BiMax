import { ContextManager, boundSummaryInput } from '../memory/context.manager';
import { LLMProvider, Message, ChatEvent } from '../core/llm.provider';
import { encode } from 'gpt-tokenizer';

/**
 * Does a long session actually USE the window the user configured?
 *
 * `context.longrun.test.ts` proves the stack stays bounded. Bounded is necessary and was never the
 * whole contract: a stack that throws everything away is also bounded. This file covers the other
 * side — that the bound tracks the window, and that the one pass which preserves meaning across a
 * compaction is reachable at all.
 *
 * Measured before the fix, on one identical 150-round session:
 *
 *     window      final tokens   used     snips   summarizer calls
 *      32,000         9,660      30.2%      5            0
 *     128,000        52,143      40.7%      5            0
 *     200,000        52,143      26.1%      5            0
 *   1,000,000        52,143       5.2%      5            0
 *
 * A 31x range of windows produced one identical session, because snip() fired on a MESSAGE COUNT
 * and nothing else ever got the chance to run. On a 1M window that discarded ~205 messages to stay
 * inside 5% of what the user was paying for, and compact() — the pass that writes the
 * goal/progress/decisions note — was never called once in any of the four.
 *
 * These assert properties, never the numbers above (`bimax-perf-constants-pinned-by-tests`).
 */

const summarizer: LLMProvider = {
  async *chat(): AsyncGenerator<ChatEvent> {
    yield { type: 'token', text: '## Goal\nPort the parser.\n## Progress\n- inspected modules' } as ChatEvent;
  },
};

const tokensOf = (messages: Message[]): number =>
  messages.reduce((n, m) => n + encode(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).length, 0);

/** One realistic round: a tool call and a chunky result. */
function round(i: number): Message[] {
  const id = `call_${i}`;
  return [
    {
      role: 'assistant',
      content: `Inspecting module ${i}.`,
      tool_calls: [{ id, type: 'function', function: { name: 'ReadFileTool', arguments: JSON.stringify({ path: `src/mod${i}.ts` }) } }],
    } as Message,
    { role: 'tool', tool_call_id: id, content: `src/mod${i}.ts\n${'const value = compute();\n'.repeat(340)}` } as Message,
  ];
}

async function session(window: number, rounds: number): Promise<{ peak: number; final: Message[] }> {
  const cm = new ContextManager(summarizer, window);
  let messages: Message[] = [{ role: 'user', content: 'Port the parser and keep every test green.' }];
  let peak = 0;
  for (let i = 0; i < rounds; i++) {
    messages.push(...round(i));
    messages = await cm.checkAndCompact(messages, 'smart');
    peak = Math.max(peak, tokensOf(messages));
  }
  return { peak, final: messages };
}

describe('a long session uses the window it was given', () => {
  it('reaches a materially higher peak on a large window than on a small one', async () => {
    // The point of configuring a bigger window is that more history survives. Before the fix these
    // two were byte-identical. A ratio, not a count, so the numbers above stay un-pinned.
    const small = await session(32_000, 120);
    const large = await session(256_000, 120);
    expect(large.peak).toBeGreaterThan(small.peak * 2);
  }, 240_000);

  it('still never exceeds the window it was given', async () => {
    // The bound that context.longrun.test.ts protects. Using the window is not overrunning it.
    const { peak } = await session(128_000, 120);
    expect(peak).toBeLessThan(128_000);
  }, 240_000);

  it('reaches the summarizer when the CONVERSATION is what fills the window', async () => {
    // Order matters in the ladder. A tool-heavy session is correctly handled by microCompact,
    // which stubs old tool results and archives them retrievably — the summarizer is not needed
    // and not calling it is right. But when it is the user and assistant turns themselves that
    // fill the window, microCompact has nothing to stub and compact() is the ONLY pass that can
    // carry the goal, the decisions and the next step across. Before the fix, snip() reached the
    // message count first and threw those turns away without ever writing a summary.
    let calls = 0;
    const counting: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        calls++;
        yield { type: 'token', text: '## Goal\nPort the parser.' } as ChatEvent;
      },
    };
    const cm = new ContextManager(counting, 64_000);
    let messages: Message[] = [{ role: 'user', content: 'Port the parser.' }];
    for (let i = 0; i < 150; i++) {
      messages.push({ role: 'assistant', content: `Analysis ${i}: ${'the parser rewrites each node in place. '.repeat(60)}` } as Message);
      messages.push({ role: 'user', content: `Follow-up ${i}: ${'what about the nested case? '.repeat(60)}` } as Message);
      messages = await cm.checkAndCompact(messages, 'smart');
    }
    expect(calls).toBeGreaterThan(0);
  }, 240_000);

  it('does not snip below its pressure threshold', async () => {
    // snip() is documented as "a blunt guard for runaway sessions". It was firing on ordinary
    // ones, which is how a quarter-full window still lost ~205 messages. A session that stays
    // well inside its window must keep every turn it started with.
    const cm = new ContextManager(summarizer, 1_000_000);
    let messages: Message[] = [{ role: 'user', content: 'MARKER-FIRST-TURN: port the parser.' }];
    for (let i = 0; i < 150; i++) {
      messages.push({ role: 'assistant', content: `Step ${i}` } as Message);
      messages.push({ role: 'user', content: `Next ${i}` } as Message);
      messages = await cm.checkAndCompact(messages, 'smart');
    }
    expect(messages.some(m => String(m.content).includes('MARKER-FIRST-TURN'))).toBe(true);
    expect(messages.filter(m => m.role !== 'system').length).toBeGreaterThan(200);
  }, 240_000);
});

describe('the summarizer input is bounded', () => {
  const messages = (n: number, size: number) =>
    Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i} ${'x'.repeat(size)}` }));

  it('is byte-identical to JSON.stringify when it fits', () => {
    const ms = messages(5, 10);
    expect(boundSummaryInput(ms, 100_000)).toBe(JSON.stringify(ms));
  });

  it('honours the limit when it does not fit', () => {
    // The backlog handed to compact() is ~70% of the MAIN model's window, and it is sent to the
    // LITE model. Unbounded, a 200k main model paired with a 32k lite model failed every
    // compaction on a long session and discarded the whole narrative in the catch.
    const out = boundSummaryInput(messages(400, 500), 20_000);
    expect(out.length).toBeLessThanOrEqual(20_000);
  });

  it('keeps BOTH ends, because the goal is at one and the next step is at the other', () => {
    const out = boundSummaryInput(messages(400, 500), 20_000);
    expect(out).toContain('"m0 ');
    expect(out).toContain('"m399 ');
    expect(out).toContain('omitted from this summarization input');
  });

  it('stays parseable, so the summarizer is never handed a severed object', () => {
    const parsed = JSON.parse(boundSummaryInput(messages(400, 500), 20_000));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(2);
  });
});
