import { AgentLoop } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import { LLMProvider, ChatEvent, Message } from '../core/llm.provider';
import { cliEvents, ToolCallEntry } from '../cli/events';

/**
 * End-to-end: when the model writes a tool call as plain text instead of using the
 * function-calling API, the loop must recover it, execute the real tool, and carry
 * on to produce the follow-up answer.
 */
describe('AgentLoop — recovers and executes a text-emitted tool call', () => {
  it('parses the leaked JSON, runs the tool, and continues the loop', async () => {
    let executedWith: any = null;
    const registry = new ToolRegistry();
    registry.register({
      name: 'WriteFileTool',
      description: 'writes a file',
      schema: {},
      isDestructive: false,
      isConcurrencySafe: true,
      execute: async (args: any) => { executedWith = args; return 'OK: file written'; },
    } as any);

    // Turn 1: emit a tool call as text. Turn 2 (after the tool result): real answer.
    let call = 0;
    const mockLlm: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        call++;
        if (call === 1) {
          yield { type: 'token', text: 'The final answer is {"name": "WriteFileTool", "parameters": {"path": "/tmp/x", "content": "working"}}.' };
        } else {
          yield { type: 'token', text: 'Done — the file is written.' };
        }
        yield { type: 'done' };
      },
    };

    const loop = new AgentLoop(mockLlm, registry, null as any);
    let out = '';
    for await (const t of loop.execute([{ role: 'user', content: 'create the file' }], 'sys', { maxIterations: 5 })) {
      out += t;
    }

    // The recovered call actually executed with the parsed arguments.
    expect(executedWith).toEqual({ path: '/tmp/x', content: 'working' });
    // The loop continued past the tool result to the real answer.
    expect(out).toContain('Done');

    // History is well-formed and clean: an assistant tool_calls message, a tool
    // result, then the final assistant answer — and no raw tool JSON persisted.
    const assistantWithToolCalls = loop.messages.find(m => m.role === 'assistant' && m.tool_calls?.length);
    expect(assistantWithToolCalls?.tool_calls?.[0].function.name).toBe('WriteFileTool');
    expect(loop.messages.some(m => m.role === 'tool')).toBe(true);
    const finalAssistant = [...loop.messages].reverse().find(m => m.role === 'assistant');
    expect(finalAssistant?.content).toContain('Done');
    expect(loop.messages.some(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('"name"'))).toBe(false);
  });
});

/**
 * Tool-result ordering: when a turn mixes concurrency-safe (parallel) and unsafe (sequential)
 * tools, the pushed `tool` result messages must appear in the SAME order the model emitted the
 * tool_calls — not "all parallel first, then all sequential". Order-sensitive OpenAI-compatible
 * backends reject a mismatch, and every tool_call must be answered exactly once.
 */
describe('AgentLoop — tool results are pushed in tool_call order', () => {
  it('pairs each result to its call in emission order across parallel/sequential tools', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'WriteFileTool', description: 'writes', schema: {},
      isDestructive: true, isConcurrencySafe: false, // sequential
      execute: async () => 'WROTE',
    } as any);
    registry.register({
      name: 'ReadFileTool', description: 'reads', schema: {},
      isDestructive: false, isConcurrencySafe: true, // parallel
      execute: async () => 'READ',
    } as any);

    let call = 0;
    const mockLlm: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        call++;
        if (call === 1) {
          // Emission order: sequential tool FIRST, parallel tool SECOND.
          yield { type: 'tool_call', id: 'w1', name: 'WriteFileTool', args: '{"path":"/tmp/a","content":"x"}' };
          yield { type: 'tool_call', id: 'r1', name: 'ReadFileTool', args: '{"path":"/tmp/b"}' };
          yield { type: 'done' };
        } else {
          yield { type: 'token', text: 'Done.' };
          yield { type: 'done' };
        }
      },
    };

    const loop = new AgentLoop(mockLlm, registry, null as any);
    // eslint-disable-next-line no-empty
    for await (const _ of loop.execute([{ role: 'user', content: 'go' }], 'sys', { maxIterations: 3 })) {}

    const toolMsgs = loop.messages.filter(m => m.role === 'tool');
    // Both calls answered, in emission order (write result before read result).
    expect(toolMsgs.map(m => m.tool_call_id)).toEqual(['w1', 'r1']);
    // Each id answered exactly once — no gaps, no duplicates.
    const asst = loop.messages.find(m => m.role === 'assistant' && m.tool_calls?.length);
    const callIds = asst!.tool_calls!.map(tc => tc.id).sort();
    const resultIds = toolMsgs.map(m => m.tool_call_id).sort();
    expect(resultIds).toEqual(callIds);
  });
});

/**
 * C3 live tool-arg streaming: a `tool_call_partial` event must surface as a live "running" tool
 * entry on the UI bus (so the call shows as it forms) WITHOUT being executed — only the final
 * authoritative `tool_call` runs the tool.
 */
describe('AgentLoop — live tool-arg streaming (tool_call_partial)', () => {
  it('emits a running tool_call for the partial without executing it', async () => {
    let execCount = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: 'WriteFileTool', description: 'writes', schema: {},
      isDestructive: false, isConcurrencySafe: true,
      execute: async () => { execCount++; return 'OK'; },
    } as any);

    let call = 0;
    const mockLlm: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        call++;
        if (call === 1) {
          yield { type: 'tool_call_partial', id: 'tc1', name: 'WriteFileTool', args: '{"path":"/tmp/' };
          yield { type: 'tool_call_partial', id: 'tc1', name: 'WriteFileTool', args: '{"path":"/tmp/x","content":"hi"}' };
          yield { type: 'tool_call', id: 'tc1', name: 'WriteFileTool', args: '{"path":"/tmp/x","content":"hi"}' };
          yield { type: 'done' };
        } else {
          yield { type: 'token', text: 'Done.' };
          yield { type: 'done' };
        }
      },
    };

    const seen: ToolCallEntry[] = [];
    const onCall = (c: ToolCallEntry) => seen.push(c);
    cliEvents.on('tool_call', onCall);
    try {
      const loop = new AgentLoop(mockLlm, registry, null as any);
      // eslint-disable-next-line no-empty
      for await (const _ of loop.execute([{ role: 'user', content: 'go' }], 'sys', { maxIterations: 2 })) {}
    } finally {
      cliEvents.off('tool_call', onCall);
    }

    // The partials surfaced as running entries (live activity) with the growing args...
    const running = seen.filter(c => c.id === 'tc1' && c.status === 'running');
    expect(running.length).toBeGreaterThanOrEqual(2);
    expect(running.some(c => c.input === '{"path":"/tmp/')).toBe(true);
    // ...and the tool executed exactly once (driven by the final tool_call, not the partials).
    expect(execCount).toBe(1);
  });
});

/**
 * A turn that produces nothing visible — no streamed text, no tool call, not pure filler
 * (e.g. a coding model that emitted only `reasoning_content` then ended empty, or a model
 * that went silent right after a tool result) must not leave the user staring at a stopped
 * spinner. The loop nudges once for a direct answer; bounded so it can't spin.
 */
describe('AgentLoop — recovers from a silent empty turn', () => {
  it('nudges once when a turn is completely empty, then completes', async () => {
    let call = 0;
    const mockLlm: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        call++;
        if (call === 1) {
          // Only reasoning, no visible content, no tool call — collapses to empty.
          yield { type: 'thinking', text: 'hmm let me think' };
          yield { type: 'done' };
        } else {
          yield { type: 'token', text: 'Here is the actual answer.' };
          yield { type: 'done' };
        }
      },
    };

    const loop = new AgentLoop(mockLlm, new ToolRegistry(), null as any);
    let out = '';
    for await (const t of loop.execute([{ role: 'user', content: 'do it' }], 'sys', { maxIterations: 5 })) {
      out += t;
    }

    expect(call).toBe(2); // nudged exactly once
    expect(out).toContain('Here is the actual answer.');
    // The nudge was injected as a user message so the model re-answers.
    expect(loop.messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('empty response'))).toBe(true);
  });

  it('surfaces a visible note rather than dead silence if it stays empty', async () => {
    const mockLlm: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        // Always empty — exhausts the single empty-turn retry.
        yield { type: 'done' };
      },
    };

    const loop = new AgentLoop(mockLlm, new ToolRegistry(), null as any);
    let out = '';
    for await (const t of loop.execute([{ role: 'user', content: 'do it' }], 'sys', { maxIterations: 5 })) {
      out += t;
    }

    // Never silent — the user gets a note explaining no response came back.
    expect(out).toContain('No response was produced');
  });
});

describe('AgentLoop — required operation tool activation', () => {
  it('retries a silent/refusal turn with the required tool instead of asking for plain text', async () => {
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register({
      name: 'ComputerTool', description: 'desktop', schema: {},
      isDestructive: false, isConcurrencySafe: false,
      execute: async () => {
        executed++;
        return JSON.stringify({ ok: false, action: 'open', driver: 'bimax-computer-use', summary: 'permission denied' });
      },
    } as any);

    let call = 0;
    const seenSchemas: string[][] = [];
    const mockLlm: LLMProvider = {
      async *chat(messages: Message[], options?: any): AsyncGenerator<ChatEvent> {
        call++;
        seenSchemas.push((options?.tools || []).map((tool: any) => tool.name));
        if (call === 1) {
          yield { type: 'thinking', text: 'I cannot access personal apps' };
        } else if (call === 2) {
          expect(messages.some(message => message.role === 'user'
            && String(message.content).includes('[OPERATION ACTIVATION GATE]'))).toBe(true);
          yield { type: 'tool_call', id: 'open', name: 'ComputerTool', args: '{"action":"open","app":"Any App"}' };
        } else {
          yield { type: 'token', text: 'The operation is blocked by permission denial.' };
        }
        yield { type: 'done' };
      },
    };

    const loop = new AgentLoop(mockLlm, registry, null as any);
    let out = '';
    for await (const token of loop.execute(
      [{ role: 'user', content: 'operate the desktop' }],
      'system',
      {
        maxIterations: 4,
        contextMode: 'smart',
        requireTool: 'ComputerTool',
        toolNames: ['ComputerTool'],
        skipRepoMap: true,
      },
    )) out += token;

    expect(executed).toBe(1);
    expect(out).toBe('The operation is blocked by permission denial.');
    expect(out).not.toMatch(/cannot access personal apps/i);
    expect(seenSchemas.every(names => names.length === 1 && names[0] === 'ComputerTool')).toBe(true);
    expect(loop.messages.some(message => typeof message.content === 'string'
      && message.content.includes('empty response'))).toBe(false);
  });

  it('allows a preparatory checklist tool before the required operation tool', async () => {
    const registry = new ToolRegistry();
    const executed: string[] = [];
    for (const name of ['TodoWriteTool', 'ComputerTool']) {
      registry.register({
        name, description: name, schema: {}, isDestructive: false, isConcurrencySafe: false,
        execute: async () => {
          executed.push(name);
          return name === 'ComputerTool'
            ? JSON.stringify({ ok: false, driver: 'bimax-computer-use', summary: 'blocked' })
            : 'checklist created';
        },
      } as any);
    }

    let call = 0;
    const mockLlm: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        call++;
        if (call === 1) yield { type: 'tool_call', id: 'todo', name: 'TodoWriteTool', args: '{}' };
        else if (call === 2) yield { type: 'tool_call', id: 'computer', name: 'ComputerTool', args: '{"action":"observe"}' };
        else yield { type: 'token', text: 'Blocked by the observed runtime state.' };
        yield { type: 'done' };
      },
    };

    const loop = new AgentLoop(mockLlm, registry, null as any);
    let out = '';
    for await (const token of loop.execute(
      [{ role: 'user', content: 'operate the desktop' }], 'system',
      { maxIterations: 4, requireTool: 'ComputerTool', toolNames: ['TodoWriteTool', 'ComputerTool'] },
    )) out += token;

    expect(executed).toEqual(['TodoWriteTool', 'ComputerTool']);
    expect(out).toBe('Blocked by the observed runtime state.');
  });
});

/**
 * Cooperative cancellation: when the front-end interrupts a turn, the loop must stop at the next
 * safe boundary — it must not start the next tool batch and must not begin another iteration.
 */
describe('AgentLoop — honors an AbortSignal', () => {
  it('does not execute tools once the signal is aborted mid-stream', async () => {
    let execCount = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: 'WriteFileTool', description: 'writes', schema: {},
      isDestructive: false, isConcurrencySafe: true,
      execute: async () => { execCount++; return 'OK'; },
    } as any);

    const ctrl = new AbortController();
    const mockLlm: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        // The user interrupts while the model is still streaming its tool-call turn.
        yield { type: 'token', text: 'starting…' };
        ctrl.abort();
        yield { type: 'tool_call', id: 'tc1', name: 'WriteFileTool', args: '{"path":"/tmp/x","content":"hi"}' };
        yield { type: 'done' };
      },
    };

    const loop = new AgentLoop(mockLlm, registry, null as any);
    let out = '';
    for await (const t of loop.execute([{ role: 'user', content: 'go' }], 'sys', { maxIterations: 5, signal: ctrl.signal })) {
      out += t;
    }

    // The turn stopped before the tool ran, and the loop didn't spin into another iteration.
    expect(execCount).toBe(0);
    expect(out).toContain('starting…');
  });

  it('does not start a new iteration when aborted between turns', async () => {
    let calls = 0;
    const ctrl = new AbortController();
    const mockLlm: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        calls++;
        ctrl.abort(); // abort right after the first turn's stream opens
        yield { type: 'token', text: 'partial' };
        yield { type: 'done' };
      },
    };

    const loop = new AgentLoop(mockLlm, new ToolRegistry(), null as any);
    // eslint-disable-next-line no-empty
    for await (const _ of loop.execute([{ role: 'user', content: 'go' }], 'sys', { maxIterations: 5, signal: ctrl.signal })) {}

    expect(calls).toBe(1); // never looped back for a second model call
  });
});

/**
 * A transient provider/model error (stalled stream, 5xx, one malformed tool-call
 * emission) must not kill the task: the loop discards the partial turn and re-asks,
 * up to a bound. Past the bound it surfaces the error instead of spinning.
 */
describe('AgentLoop — retries transient errors then gives up', () => {
  it('re-asks after a transient error and completes on the next attempt', async () => {
    let call = 0;
    const mockLlm: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        call++;
        if (call === 1) {
          yield { type: 'error', message: '400 Unterminated string', recoverable: true, kind: 'transient' };
        } else {
          yield { type: 'token', text: 'Recovered and answered.' };
          yield { type: 'done' };
        }
      },
    };

    const loop = new AgentLoop(mockLlm, new ToolRegistry(), null as any);
    const statuses: string[] = [];
    const onStatus = (s: string) => statuses.push(String(s));
    cliEvents.on('status', onStatus);
    let out = '';
    try {
      for await (const t of loop.execute([{ role: 'user', content: 'hi' }], 'sys', { maxIterations: 5 })) {
        out += t;
      }
    } finally {
      cliEvents.off('status', onStatus);
    }

    expect(call).toBe(2); // retried exactly once
    // Recovery is narrated on the status channel, NEVER into the answer stream — the reply must
    // read as one uninterrupted voice.
    expect(out).not.toContain('retrying');
    expect(statuses.some(s => /retrying in \d+s \(1\/2\)/.test(s))).toBe(true);
    expect(out).toContain('Recovered and answered.');
  });

  it('aborts after exhausting the transient retry budget', async () => {
    let call = 0;
    const mockLlm: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        call++;
        yield { type: 'error', message: 'Stream read timeout', recoverable: true, kind: 'transient' };
      },
    };

    const loop = new AgentLoop(mockLlm, new ToolRegistry(), null as any);
    let out = '';
    for await (const t of loop.execute([{ role: 'user', content: 'hi' }], 'sys', { maxIterations: 10 })) {
      out += t;
    }

    // Initial attempt + 2 retries, then the fatal surface — never an infinite spin.
    expect(call).toBe(3);
    expect(out).toContain('The provider returned an error');
  });

  it('resets the transient budget after a clean turn — survives blips across a long run', async () => {
    // A noop tool keeps the loop iterating (a content-only turn would end execute()).
    const registry = new ToolRegistry();
    registry.register({
      name: 'noop', description: 'no-op', schema: {},
      isDestructive: false, isConcurrencySafe: true, execute: async () => 'ok',
    } as any);

    // transient → tool → transient → tool → transient → answer. With a LIFETIME budget of 2 the third
    // blip would exhaust it and surface "API Error". With a CONSECUTIVE budget (reset on each clean
    // turn) every blip is retry 1/2 and the run completes — the behavior a day-long loop needs.
    const script: ChatEvent[][] = [
      [{ type: 'error', message: 'blip 1', recoverable: true, kind: 'transient' }],
      [{ type: 'tool_call', id: 't1', name: 'noop', args: '{}' }],
      [{ type: 'error', message: 'blip 2', recoverable: true, kind: 'transient' }],
      [{ type: 'tool_call', id: 't2', name: 'noop', args: '{}' }],
      [{ type: 'error', message: 'blip 3', recoverable: true, kind: 'transient' }],
      [{ type: 'token', text: 'Done after surviving 3 blips.' }, { type: 'done' }],
    ];
    let call = 0;
    const mockLlm: LLMProvider = {
      async *chat(): AsyncGenerator<ChatEvent> {
        const events = script[Math.min(call, script.length - 1)];
        call++;
        for (const e of events) yield e;
      },
    };

    const loop = new AgentLoop(mockLlm, registry, null as any);
    let out = '';
    for await (const t of loop.execute([{ role: 'user', content: 'go' }], 'sys', { maxIterations: 20 })) {
      out += t;
    }

    expect(out).toContain('Done after surviving 3 blips.');
    expect(out).not.toContain('provider returned an error');
  }, 15000); // 3 transient backoffs (~1s each) of real wait
});


it('interrupts a 30-second provider backoff without another model request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const llm: LLMProvider = { async *chat(): AsyncGenerator<ChatEvent> {
    calls++;
    yield { type: 'error', message: 'rate limit', kind: 'transient', recoverable: true, retryAfterSecs: 30 };
  } };
  const onStatus = (status: string) => {
    if (status.includes('retrying in')) setImmediate(() => controller.abort());
  };
  cliEvents.on('status', onStatus);
  try {
    const loop = new AgentLoop(llm, new ToolRegistry(), null as any);
    for await (const _ of loop.execute([{ role: 'user', content: 'test' }], 'sys', {
      signal: controller.signal, maxIterations: 3,
    })) { /* drain */ }
    expect(controller.signal.aborted).toBe(true);
    expect(calls).toBe(1);
  } finally { cliEvents.off('status', onStatus); }
}, 1500);
