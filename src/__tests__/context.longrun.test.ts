import { ContextManager } from '../memory/context.manager';
import { LLMProvider, Message, ChatEvent } from '../core/llm.provider';
import { encode } from 'gpt-tokenizer';

/**
 * Does the context stack actually HOLD over a long task?
 *
 * Every layer (capToolResults, microCompact, snip, compact) has its own unit test, and each one
 * passes in isolation. Nothing measured the four of them running together across a realistic
 * multi-hundred-call session — which is the only place the failure anyone actually reports lives:
 * "the first ten tool calls are fine, then it gets noisy and stops being useful."
 *
 * A layered scheme can pass every isolated test and still leak, because the leak is emergent: a
 * pass that trims 90% of the growth still grows without bound, just slower. Isolated tests cannot
 * see that. A curve over 200 rounds can.
 *
 * These tests assert PROPERTIES of the curve — bounded, plateauing, structurally valid — never a
 * specific token count. Pinning the number would make any legitimate prompt change a failure and
 * would tempt the next person to update the constant instead of investigating the growth.
 */

const summarizerLlm: LLMProvider = {
  async *chat(): AsyncGenerator<ChatEvent> {
    yield { type: 'token', text: 'Prior work summarized: files inspected, tests run.' } as ChatEvent;
  },
};

const tokensOf = (messages: Message[]): number =>
  messages.reduce((n, m) => n + encode(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).length, 0);

/** One realistic agent round: the model calls a tool, the tool returns a chunky result. */
function round(i: number): Message[] {
  const id = `call_${i}`;
  // ~4KB of plausible tool output — a file read or a test run, the two things that dominate a
  // real session's token spend.
  const body = Array.from({ length: 60 }, (_, l) => `  ${l}: const value${i}_${l} = compute(${i}, ${l});`).join('\n');
  return [
    {
      role: 'assistant',
      content: `Inspecting module ${i}.`,
      tool_calls: [{ id, type: 'function', function: { name: 'ReadFileTool', arguments: JSON.stringify({ path: `src/mod${i}.ts` }) } }],
    } as Message,
    { role: 'tool', tool_call_id: id, content: `src/mod${i}.ts\n${body}` } as Message,
  ];
}

/** Every `tool` message must answer a `tool_call` the assistant actually made, in order. */
function toolPairingIsIntact(messages: Message[]): boolean {
  const offered = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray((m as any).tool_calls)) {
      for (const c of (m as any).tool_calls) offered.add(c.id);
    }
    if (m.role === 'tool') {
      const id = (m as any).tool_call_id;
      if (!offered.has(id)) return false;
    }
  }
  return true;
}

describe('context stack over a long-running task', () => {
  // 200 rounds ≈ 400 messages ≈ 800KB of raw tool output against a 128k window: far past the point
  // where an unbounded history would have blown the context several times over.
  const ROUNDS = 200;
  const WINDOW = 128_000;

  /** Run the real stack round by round, sampling the token count each time. */
  async function runSession(mode: 'smart' | 'full'): Promise<{ curve: number[]; final: Message[] }> {
    const cm = new ContextManager(summarizerLlm, WINDOW);
    let messages: Message[] = [{ role: 'user', content: 'Audit this repository and fix what is broken.' }];
    const curve: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      messages.push(...round(i));
      messages = await cm.checkAndCompact(messages, mode);
      curve.push(tokensOf(messages));
    }
    return { curve, final: messages };
  }

  it('stays inside the window and plateaus instead of growing with the task', async () => {
    const { curve } = await runSession('smart');

    // 1. It never approaches the window. This is the failure the user sees as "it got dumb".
    expect(Math.max(...curve)).toBeLessThan(WINDOW * 0.7);

    // 2. It PLATEAUS. The real question is not "is it big" but "does it keep growing" — a session
    //    three times longer must not cost three times the context. Compare the last quarter of the
    //    run against the second quarter: a bounded stack shows no meaningful climb between them,
    //    while anything with a leak shows a steady one.
    const q = Math.floor(ROUNDS / 4);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const secondQuarter = mean(curve.slice(q, q * 2));
    const lastQuarter = mean(curve.slice(q * 3));
    expect(lastQuarter).toBeLessThan(secondQuarter * 1.5);

    // 3. It is not growing linearly with round count, which is what "info piles up" would look like.
    //    Unbounded growth over 200 rounds of ~1k-token results would be ~200k tokens.
    expect(curve[curve.length - 1]).toBeLessThan(curve[q] * 3);
  }, 120_000);

  it('never emits a tool message without its originating tool call', async () => {
    // Compaction that drops an assistant tool_call but keeps its `tool` reply produces a request
    // the provider rejects outright — the turn dies with a 400 rather than degrading. Cheap to
    // break when four passes edit the same array.
    const { final } = await runSession('smart');
    expect(toolPairingIsIntact(final)).toBe(true);
  }, 120_000);

  it('keeps the most recent work intact — compaction trims the past, not the present', async () => {
    // A stack that hits its budget by discarding what just happened is worse than one that grows:
    // the model loses the thread it is mid-way through. The newest tool result must survive whole.
    const { final } = await runSession('smart');
    const lastToolResult = [...final].reverse().find(m => m.role === 'tool');
    expect(lastToolResult).toBeDefined();
    expect(String(lastToolResult!.content)).toContain(`src/mod${ROUNDS - 1}.ts`);
    expect(String(lastToolResult!.content)).toContain(`value${ROUNDS - 1}_59`);
  }, 120_000);

  it('full mode is documented as unbounded — and measurably is', async () => {
    // Not a defect: full mode's contract is "send everything, recover reactively if the API says
    // no". Asserted so the difference stays a deliberate choice rather than an accident, and so
    // anyone reading the smart-mode plateau above knows what it is being compared against.
    const { curve } = await runSession('full');
    const q = Math.floor(ROUNDS / 4);
    expect(curve[curve.length - 1]).toBeGreaterThan(curve[q] * 3);
  }, 120_000);
});
