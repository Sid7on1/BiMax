import { AgentLoop } from '../core/agent.loop';
import { ChatEvent, LLMProvider, Message } from '../core/llm.provider';
import { ContextManager } from '../memory/context.manager';
import { ToolRegistry } from '../tools/tool.registry';

const contextError: ChatEvent = {
  type: 'error',
  message: 'Request Entity Too Large',
  recoverable: true,
  kind: 'context',
};

function toolExchange(id: string, result: string): Message[] {
  return [
    {
      role: 'assistant',
      tool_calls: [{ id, type: 'function', function: { name: 'noop', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: id, content: result },
  ];
}

function drainableHistory(trailingUsers = 0): Message[] {
  return [
    { role: 'system', content: 'Keep this system instruction.' },
    { role: 'user', content: 'Complete the long-running task.' },
    ...Array.from({ length: 10 }).flatMap((_, index) =>
      toolExchange(`old-${index}`, `tool result ${index}: ${'payload '.repeat(120)}`),
    ),
    ...Array.from({ length: trailingUsers }).map((_, index) => ({
      role: 'user' as const,
      content: `recent turn ${index}: ${'detail '.repeat(40)}`,
    })),
  ];
}

function nonDrainableHistory(): Message[] {
  return [
    { role: 'system', content: 'Keep this system instruction.' },
    ...Array.from({ length: 12 }).map((_, index) => ({
      role: 'user' as const,
      content: `history turn ${index}: ${'detail '.repeat(80)}`,
    })),
  ];
}

async function run(loop: AgentLoop, messages: Message[], maxIterations = 10): Promise<string> {
  let output = '';
  for await (const text of loop.execute(messages, 'system prompt', {
    contextMode: 'full',
    maxIterations,
  })) {
    output += text;
  }
  return output;
}

describe('AgentLoop — bounded graded context recovery', () => {
  afterEach(() => jest.restoreAllMocks());

  it('runs the cheap reactive drain first, retries, and completes after one context error', async () => {
    const drain = jest.spyOn(ContextManager.prototype, 'reactiveDrain');
    let calls = 0;
    const llm: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        calls++;
        if (calls === 1) yield contextError;
        else {
          yield { type: 'token', text: 'Recovered cheaply.' };
          yield { type: 'done' };
        }
      },
    };

    const loop = new AgentLoop(llm, new ToolRegistry(), null as any);
    const output = await run(loop, drainableHistory());

    expect(drain).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    expect(output).toContain('Recovered cheaply.');
    expect(loop.messages.some(message => String(message.content).startsWith('[tool result cleared to save context'))).toBe(true);
  });

  it('advances through tiers 0, 1, and 2, then stops at the terminal bound', async () => {
    const drain = jest.spyOn(ContextManager.prototype, 'reactiveDrain');
    const compact = jest.spyOn(ContextManager.prototype, 'reactiveCompact');
    let calls = 0;
    const llm: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        calls++;
        yield contextError;
      },
    };

    const loop = new AgentLoop(llm, new ToolRegistry(), null as any);
    const output = await run(loop, nonDrainableHistory(), 20);

    expect(drain).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledTimes(1);
    // Tier 0 cannot change this tool-free history, so tier 1 runs in the same error handling.
    // Only tiers 1 and 2 earn retries; the third model rejection reaches the terminal bound.
    expect(calls).toBe(3);
    expect(output).toContain(
      'The task context stayed over the model\'s limit after draining, summarizing, and truncating — stopping this turn to avoid a compaction loop.',
    );
    expect(output).not.toContain('Stopped after 20 rounds');
  });

  it('resets the recovery ladder after a clean tool-call turn', async () => {
    const drain = jest.spyOn(ContextManager.prototype, 'reactiveDrain');
    const compact = jest.spyOn(ContextManager.prototype, 'reactiveCompact');
    const registry = new ToolRegistry();
    registry.register({
      name: 'noop',
      description: 'No-op tool',
      schema: {},
      isDestructive: false,
      isConcurrencySafe: true,
      execute: async () => 'new result',
    } as any);

    const script: ChatEvent[][] = [
      [contextError],
      [{ type: 'tool_call', id: 'new-tool', name: 'noop', args: '{}' }, { type: 'done' }],
      [contextError],
      [{ type: 'token', text: 'Finished after both recoveries.' }, { type: 'done' }],
    ];
    let calls = 0;
    const llm: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        const events = script[calls++] ?? script[script.length - 1];
        for (const event of events) yield event;
      },
    };

    const loop = new AgentLoop(llm, registry, null as any);
    const output = await run(loop, drainableHistory());

    expect(calls).toBe(4);
    expect(drain).toHaveBeenCalledTimes(2);
    expect(compact).not.toHaveBeenCalled();
    expect(output).toContain('Finished after both recoveries.');
  });

  it('strictly reduces the existing token estimate at every retry tier', async () => {
    const sent: Message[][] = [];
    let calls = 0;
    const llm: LLMProvider = {
      async *chat(messages: Message[]): AsyncGenerator<ChatEvent> {
        sent.push(messages);
        calls++;
        if (calls <= 3) yield contextError;
        else {
          yield { type: 'token', text: 'Completed after the ladder.' };
          yield { type: 'done' };
        }
      },
    };

    const loop = new AgentLoop(llm, new ToolRegistry(), null as any);
    const output = await run(loop, drainableHistory(6));
    const manager = (loop as any).contextManager as ContextManager;
    const estimates = sent.map(messages => manager.estimateTokens(messages));

    expect(estimates).toHaveLength(4);
    expect(estimates[1]).toBeLessThan(estimates[0]); // tier 0: cheap drain
    expect(estimates[2]).toBeLessThan(estimates[1]); // tier 1: reactive compact
    expect(estimates[3]).toBeLessThan(estimates[2]); // tier 2: recent-turn truncation
    expect(output).toContain('Completed after the ladder.');
  });
});
