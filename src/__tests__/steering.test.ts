import { AgentLoop } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import type { ChatEvent, LLMProvider } from '../core/llm.provider';
import { engineEvents } from '../engine/events';
import { HeadlessSession } from '../protocol/headless.session';
import { clearSteer, drainSteer, hasSteer, pushSteer, steerMessage } from '../core/steering';

/**
 * Backlog F7: words the user sends while a task works reach the running turn at its next step, instead of waiting in
 * the queue until the turn ends.
 */

afterEach(() => clearSteer());

function recording(rounds: Array<{ tool: string; args: object } | string>, during?: (round: number) => void) {
  let round = 0;
  const seen: any[][] = [];
  const llm = {
    userModel: 'test-model',
    async *chat(messages: any[]): AsyncGenerator<ChatEvent> {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      const step = rounds[round++] ?? 'Done.';
      during?.(round);
      if (typeof step === 'string') yield { type: 'token', text: step } as any;
      else yield { type: 'tool_call', id: `c${round}`, name: step.tool, args: JSON.stringify(step.args) } as any;
      yield { type: 'done' } as any;
    },
  } as unknown as LLMProvider;
  return { llm, seen };
}

function tools(onRun?: () => void) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'ReadFileTool', description: 'read a file', isDestructive: false, isConcurrencySafe: true,
    schema: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async () => { onRun?.(); return 'file contents'; },
  } as any);
  return registry;
}

async function drain(loop: AgentLoop): Promise<string> {
  let out = '';
  for await (const chunk of loop.execute([{ role: 'user', content: 'Refactor the parser.' }] as any, 'system', {})) out += chunk;
  return out;
}

test('words sent during a step reach the next model call, as the user’s own words, and are reported taken', async () => {
  const { llm, seen } = recording([{ tool: 'ReadFileTool', args: { path: 'parser.ts' } }, 'Refactored, and kept the old name exported.']);
  const steered = jest.fn();
  engineEvents.on('steered', steered);
  try { await drain(new AgentLoop(llm, tools(() => pushSteer('Keep the old function name exported too.')))); }
  finally { engineEvents.off('steered', steered); }
  const second = seen[1];
  expect(second[second.length - 1]).toEqual({ role: 'user', content: steerMessage('Keep the old function name exported too.') });
  // Not an engine tag: the continuation state keeps it as something the user said.
  expect(steerMessage('x')).not.toMatch(/^\[/);
  expect(steered).toHaveBeenCalledWith({ text: 'Keep the old function name exported too.' });
  expect(hasSteer()).toBe(false);
});

test('words that arrive while the model writes its final answer keep the turn going until they are read', async () => {
  const { llm, seen } = recording(['Done — the parser is refactored.', 'Also added the README note.'], (round) => {
    if (round === 1) pushSteer('Add a note to the README as well.');
  });
  const out = await drain(new AgentLoop(llm, tools()));
  expect(seen).toHaveLength(2);
  expect(seen[1][seen[1].length - 1].content).toBe(steerMessage('Add a note to the README as well.'));
  expect(out).toContain('Also added the README note.');
});

describe('the engine session', () => {
  function session(execute: (prompt: string, onToken: (t: string) => void) => Promise<string>) {
    const persona = { messages: [], execute: jest.fn(execute) } as any;
    const llmAdapter = { userModel: 'same-model', liteModel: 'same-model' } as any;
    return {
      persona,
      session: new HeadlessSession({ personas: { bimax: persona }, options: { llmAdapter, maxToolIterations: 5, governor: { mode: 'default' } }, graphStore: {} as any }),
    };
  }

  test('while a turn runs, steering is held for it; what it never took goes back before the turn ends', async () => {
    let release!: () => void;
    const { session: s } = session(() => new Promise((resolve) => { release = () => resolve(''); }));
    const events: Array<[string, unknown]> = [];
    const on = (name: string) => (value: unknown) => events.push([name, value]);
    const handlers = ['steer_queued', 'steer_unused', 'spinner_state'].map((name) => [name, on(name)] as const);
    handlers.forEach(([name, fn]) => engineEvents.on(name, fn));
    try {
      const turn = s.dispatchAutonomous('Refactor the parser.');
      await new Promise((resolve) => setImmediate(resolve));
      s.steer('Keep the old name exported.');
      expect(events).toContainEqual(['steer_queued', { text: 'Keep the old name exported.' }]);
      expect(hasSteer()).toBe(true);
      release();
      await turn;
    } finally {
      handlers.forEach(([name, fn]) => engineEvents.off(name, fn));
    }
    // The fake persona never ran the loop, so the words were never taken: handed back, and before idle.
    const unused = events.findIndex(([name]) => name === 'steer_unused');
    const idle = events.findIndex(([name, value]) => name === 'spinner_state' && value === 'idle');
    expect(events[unused]).toEqual(['steer_unused', { texts: ['Keep the old name exported.'] }]);
    expect(unused).toBeLessThan(idle);
    expect(hasSteer()).toBe(false);
  });

  test('Stop drops steering, as it drops queued messages', async () => {
    let release!: () => void;
    const { session: s } = session(() => new Promise((resolve) => { release = () => resolve(''); }));
    const turn = s.dispatchAutonomous('Refactor the parser.');
    await new Promise((resolve) => setImmediate(resolve));
    s.steer('Also rename the module.');
    s.interrupt();
    expect(drainSteer()).toEqual([]);
    release();
    await turn;
  });
});
