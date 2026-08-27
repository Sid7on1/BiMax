import { AgentLoop, terminalCapabilityBlocker } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import { LLMProvider, ChatEvent } from '../core/llm.provider';

/**
 * The operation completion gate.
 *
 * `requireTool` proves the model REACHED the capability — `requiredToolUsed` flips on the first
 * call of any kind. It never proved the operation was attempted, so a single target-acquisition
 * verb satisfied it and the turn was free to end on narration.
 *
 * Measured live 2026-08-18 on "send hi to my mom using Messages": the model called
 * {action:"open", app:"Messages"}, received a 44-element observation, and then answered with a
 * missed-call notice copied out of that very observation. Nothing was typed and nothing was sent,
 * yet the turn reported as complete.
 */
const TOOL = 'mcp__bimax-mac__mac_control';

function registryWithCapability() {
  const calls: any[] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: TOOL,
    description: 'capability',
    schema: { type: 'object', properties: {} },
    isDestructive: true,
    isConcurrencySafe: false,
    execute: async (args: any) => { calls.push(args); return JSON.stringify({ ok: true }); },
  } as any);
  return { registry, calls };
}


/** A capability whose calls fail — the honest end is the blocker, not another nudge. */
function registryWithFailingCapability() {
  const calls: any[] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: TOOL,
    description: 'capability',
    schema: { type: 'object', properties: {} },
    isDestructive: true,
    isConcurrencySafe: false,
    execute: async (args: any) => {
      calls.push(args);
      return JSON.stringify({ ok: false, summary: 'blocked by permission denial' });
    },
  } as any);
  return { registry, calls };
}

/** A model that emits the given capability actions on successive rounds, then narrates forever. */
function scriptedLlm(actions: string[]) {
  let round = 0;
  return {
    userModel: 'test-model',
    async *chat(): AsyncGenerator<ChatEvent> {
      const action = actions[round++];
      if (action) {
        yield {
          type: 'tool_call',
          id: `c${round}`,
          name: TOOL,
          args: JSON.stringify({ action, app: 'Messages' }),
        } as any;
      } else {
        yield { type: 'token', text: 'Dear Customer, you have a missed call from +91 97019 52447.' };
      }
      yield { type: 'done' } as any;
    },
  } as unknown as LLMProvider;
}

async function drain(loop: AgentLoop, system: string, opts: any): Promise<string> {
  let out = '';
  for await (const chunk of loop.execute([] as any, system, opts)) out += chunk;
  return out;
}

describe('AgentLoop — a prepared turn is not a completed operation', () => {
  it('classifies native stop receipts but preserves named snapshot recovery', () => {
    expect(terminalCapabilityBlocker(JSON.stringify({
      ok: false, blocked: true, executor: 'stop',
      code: 'native_logical_action_unavailable', reason: 'focus is unavailable',
    }))).toBe('native_logical_action_unavailable: focus is unavailable');
    expect(terminalCapabilityBlocker(JSON.stringify({
      ok: false, blocked: true, executor: 'stop',
      code: 'native_snapshot_required', reason: 'observe first',
    }))).toBeNull();
  });

  it('turns a terminal native stop into an enforced answer-only round', async () => {
    const calls: any[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: TOOL, description: 'capability', schema: { type: 'object', properties: {} },
      isDestructive: true, isConcurrencySafe: false,
      execute: async (args: any) => {
        calls.push(args);
        return JSON.stringify({
          ok: false, blocked: true, executor: 'stop',
          code: 'foreground_activation_unverified', reason: 'Messages did not become frontmost',
        });
      },
    } as any);
    let round = 0;
    const seenToolCounts: number[] = [];
    const llm = {
      userModel: 'test-model',
      async *chat(_messages: any[], options: any): AsyncGenerator<ChatEvent> {
        seenToolCounts.push((options?.tools || []).length);
        round++;
        if (round === 1) {
          yield { type: 'tool_call', id: 'open', name: TOOL, args: '{"action":"open","app":"Messages"}' } as any;
        } else {
          yield { type: 'token', text: 'Messages could not be verified as frontmost, so I stopped.' };
        }
        yield { type: 'done' } as any;
      },
    } as unknown as LLMProvider;
    const loop = new AgentLoop(llm, registry, undefined, 128_000);
    const out = await drain(loop, 'sys', {
      requireTool: TOOL, toolNames: [TOOL], maxIterations: 5,
    });

    expect(calls).toHaveLength(1);
    expect(seenToolCounts).toEqual([1, 0]);
    expect(out).toContain('could not be verified as frontmost');
    expect(loop.messages.some(message => typeof message.content === 'string'
      && message.content.includes('[OPERATION BLOCKED — ANSWER ONLY]'))).toBe(true);
  });

  it('does not let a lone open end the turn, and re-asks for the real action', async () => {
    const { registry, calls } = registryWithCapability();
    // The live shape: open, then narrate instead of acting. The gate must interrupt that and the
    // model then performs the action it had skipped.
    const loop = new AgentLoop(scriptedLlm(['open', '', 'type']), registry, undefined, 128_000);
    await drain(loop, 'sys', { requireTool: TOOL, toolNames: [TOOL], maxIterations: 8 });

    const actions = calls.map(c => c.action);
    expect(actions).toContain('open');
    expect(actions).toContain('type');
    const nudge = (loop.messages as any[]).find(m =>
      typeof m?.content === 'string' && m.content.includes('[OPERATION COMPLETION GATE]'));
    expect(nudge).toBeTruthy();
    expect(String(nudge.content)).toMatch(/never repeat text read off the screen/i);
  });

  it('terminates instead of looping when the model will not advance', async () => {
    const { registry, calls } = registryWithCapability();
    // Only ever prepares: open, observe, then narration forever.
    const loop = new AgentLoop(scriptedLlm(['open', 'observe']), registry, undefined, 128_000);
    const out = await drain(loop, 'sys', { requireTool: TOOL, toolNames: [TOOL], maxIterations: 12 });

    // Bounded: the gate nudges twice at most and then lets the turn end honestly.
    expect(calls.every(c => ['open', 'observe'].includes(c.action))).toBe(true);
    expect(typeof out).toBe('string');
  });

  it('leaves a turn that really acted alone', async () => {
    const { registry, calls } = registryWithCapability();
    const loop = new AgentLoop(scriptedLlm(['open', 'click']), registry, undefined, 128_000);
    await drain(loop, 'sys', { requireTool: TOOL, toolNames: [TOOL], maxIterations: 8 });

    expect(calls.map(c => c.action)).toEqual(['open', 'click']);
    const nudged = (loop.messages as any[]).some(m =>
      typeof m?.content === 'string' && m.content.includes('[OPERATION COMPLETION GATE]'));
    expect(nudged).toBe(false);
  });
  /**
   * The over-refusing direction, which the first version of this gate got wrong: it nudged twice
   * even when the preparatory call had FAILED, so a model correctly reporting a concrete blocker
   * had its answer emitted three times. A failed call is a legitimate place to stop.
   */
  it('does not nudge when the preparatory call failed and the model reports the blocker', async () => {
    const { registry, calls } = registryWithFailingCapability();
    const loop = new AgentLoop(scriptedLlm(['open', '', 'type']), registry, undefined, 128_000);
    await drain(loop, 'sys', { requireTool: TOOL, toolNames: [TOOL], maxIterations: 8 });

    expect(calls.map(c => c.action)).toEqual(['open']);
    const nudged = (loop.messages as any[]).some(m =>
      typeof m?.content === 'string' && m.content.includes('[OPERATION COMPLETION GATE]'));
    expect(nudged).toBe(false);
  });
});
