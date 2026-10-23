import { AgentLoop } from '../core/agent.loop';
import { ChatEvent, ChatOptions, LLMProvider, Message } from '../core/llm.provider';
import { ToolRegistry } from '../tools/tool.registry';

type BudgetedProvider = LLMProvider & { maxTokens: number };

async function run(loop: AgentLoop, maxIterations = 20): Promise<string> {
  let output = '';
  for await (const text of loop.execute(
    [{ role: 'user', content: 'Complete the task.' }],
    'system prompt',
    { contextMode: 'full', maxIterations },
  )) {
    output += text;
  }
  return output;
}

function pureReasoningTruncation(): ChatEvent[] {
  return [
    { type: 'thinking', text: 'Still reasoning without producing an answer.' },
    { type: 'truncated' },
    { type: 'done' },
  ];
}

describe('AgentLoop — scoped pure-reasoning output escalation', () => {
  const originalRecorder = process.env.BIMAX_RECORDER;
  const originalContinues = process.env.BIMAX_MAX_CONTINUES;
  const originalCeiling = process.env.BIMAX_MAX_OUTPUT_CEILING;

  beforeEach(() => {
    process.env.BIMAX_RECORDER = '0';
    process.env.BIMAX_MAX_CONTINUES = '1';
    process.env.BIMAX_MAX_OUTPUT_CEILING = '16384';
  });

  afterEach(() => {
    if (originalRecorder === undefined) delete process.env.BIMAX_RECORDER;
    else process.env.BIMAX_RECORDER = originalRecorder;
    if (originalContinues === undefined) delete process.env.BIMAX_MAX_CONTINUES;
    else process.env.BIMAX_MAX_CONTINUES = originalContinues;
    if (originalCeiling === undefined) delete process.env.BIMAX_MAX_OUTPUT_CEILING;
    else process.env.BIMAX_MAX_OUTPUT_CEILING = originalCeiling;
    jest.restoreAllMocks();
  });

  it('escalates 4096 → 8192 → 16384, caps there, and remains bounded', async () => {
    const requestedBudgets: Array<number | undefined> = [];
    let calls = 0;
    const llm: BudgetedProvider = {
      maxTokens: 4096,
      async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<ChatEvent> {
        calls++;
        requestedBudgets.push(options.maxTokens);
        for (const event of pureReasoningTruncation()) yield event;
      },
    };

    const output = await run(new AgentLoop(llm, new ToolRegistry(), null as any));
    const effectiveBudgets = requestedBudgets.map(budget => budget ?? llm.maxTokens);

    // Three escalation retries are allowed: the third is capped at 16k rather than exceeding it.
    // One existing bounded continuation then runs at the configured default before giving up.
    expect(effectiveBudgets).toEqual([4096, 8192, 16384, 16384, 4096]);
    expect(Math.max(...effectiveBudgets)).toBe(16384);
    expect(calls).toBe(5);
    expect(output).toContain('response hit the max output limit');
  });

  it('resets the one-call budget and escalation ladder after a tool-producing turn', async () => {
    const requestedBudgets: Array<number | undefined> = [];
    let calls = 0;
    let toolExecutions = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: 'noop',
      description: 'No-op tool',
      schema: {},
      isDestructive: false,
      isConcurrencySafe: true,
      execute: async () => {
        toolExecutions++;
        return 'tool completed';
      },
    } as any);
    const llm: BudgetedProvider = {
      maxTokens: 4096,
      async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<ChatEvent> {
        const call = calls++;
        requestedBudgets.push(options.maxTokens);
        const events: ChatEvent[] = call === 0
          ? pureReasoningTruncation()
          : call === 1
            ? [{ type: 'tool_call', id: 'tool-1', name: 'noop', args: '{}' }, { type: 'done' }]
            : call === 2
              ? pureReasoningTruncation()
              : [{ type: 'token', text: 'Finished normally.' }, { type: 'done' }];
        for (const event of events) yield event;
      },
    };

    const output = await run(new AgentLoop(llm, registry, null as any));

    // The post-tool call returns to the configured 4096 budget. Its next overflow therefore starts
    // a fresh ladder at 8192 instead of retaining the prior escalation and jumping to 16384.
    expect(requestedBudgets).toEqual([undefined, 8192, undefined, 8192]);
    expect(toolExecutions).toBe(1);
    expect(calls).toBe(4);
    expect(output).toContain('Finished normally.');
  });

  it('does not escalate a normal truncation that already produced visible content', async () => {
    const requestedBudgets: Array<number | undefined> = [];
    let calls = 0;
    const llm: BudgetedProvider = {
      maxTokens: 4096,
      async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<ChatEvent> {
        const call = calls++;
        requestedBudgets.push(options.maxTokens);
        const events: ChatEvent[] = call === 0
          ? [
            { type: 'token', text: 'Partial answer. ' },
            { type: 'truncated' },
            { type: 'done' },
          ]
          : [{ type: 'token', text: 'Finished answer.' }, { type: 'done' }];
        for (const event of events) yield event;
      },
    };

    const loop = new AgentLoop(llm, new ToolRegistry(), null as any);
    const output = await run(loop);

    expect(requestedBudgets).toEqual([undefined, undefined]);
    expect(calls).toBe(2);
    expect(output).toContain('Partial answer. Finished answer.');
    expect(loop.messages.some(message =>
      message.role === 'user' &&
      typeof message.content === 'string' &&
      message.content.includes('Continue from exactly where it stopped'),
    )).toBe(true);
  });
});

describe('AgentLoop — provider-required reasoning replay', () => {
  beforeEach(() => { process.env.BIMAX_RECORDER = '0'; });
  afterEach(() => { delete process.env.BIMAX_RECORDER; jest.restoreAllMocks(); });

  function registryWithNoop(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name: 'noop', description: 'No-op tool', schema: {}, isDestructive: false,
      isConcurrencySafe: true, execute: async () => 'tool completed',
    } as any);
    return registry;
  }

  it('replays Kimi-style reasoning_content with the assistant tool-call message', async () => {
    const calls: Message[][] = [];
    const llm: LLMProvider = {
      async *chat(messages: Message[]): AsyncGenerator<ChatEvent> {
        calls.push(messages.map((message) => ({ ...message })));
        if (calls.length === 1) {
          yield { type: 'thinking', text: 'provider reasoning', replay: true };
          yield { type: 'tool_call', id: 'tool-1', name: 'noop', args: '{}' };
        } else {
          yield { type: 'token', text: 'Finished.' };
        }
        yield { type: 'done' };
      },
    };

    await run(new AgentLoop(llm, registryWithNoop(), null as any));

    const replayed = calls[1].find((message) => message.role === 'assistant' && message.tool_calls?.length);
    expect(replayed).toEqual(expect.objectContaining({
      reasoning_content: 'provider reasoning',
      tool_calls: [expect.objectContaining({ id: 'tool-1' })],
    }));
  });

  it('does not persist ordinary hidden thinking when replay is not required', async () => {
    const calls: Message[][] = [];
    const llm: LLMProvider = {
      async *chat(messages: Message[]): AsyncGenerator<ChatEvent> {
        calls.push(messages.map((message) => ({ ...message })));
        if (calls.length === 1) {
          yield { type: 'thinking', text: 'private reasoning' };
          yield { type: 'tool_call', id: 'tool-1', name: 'noop', args: '{}' };
        } else {
          yield { type: 'token', text: 'Finished.' };
        }
        yield { type: 'done' };
      },
    };

    await run(new AgentLoop(llm, registryWithNoop(), null as any));

    const replayed = calls[1].find((message) => message.role === 'assistant' && message.tool_calls?.length);
    expect(replayed?.reasoning_content).toBeUndefined();
  });
});
