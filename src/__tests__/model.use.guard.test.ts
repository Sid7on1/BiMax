import { createModelManageTool } from '../tools/implementations/model.tool';

/**
 * An unserved model id must never become the stored work model.
 *
 * Measured 2026-09-02: the stored model was found set to `nvidia/nemotron-3-nano-30b-a3b`, which
 * the provider does not serve — so every launch began with a guaranteed 404 and the user's own
 * choice was gone with nothing on screen saying what replaced it. `action:"use"` persisted whatever
 * id it was handed, and it is agent-reachable.
 */
const governor: any = { approveTaskExecution: async () => true, mode: 'bypass' };

function adapter(served: string[]): any {
  return {
    listProviderModels: async () => served,
    applyConfig: () => {},
    readEffective: () => ({}),
  };
}

describe('ModelManageTool refuses an unserved model', () => {
  const run = (llm: any, args: Record<string, unknown>): Promise<string> =>
    createModelManageTool(governor, llm).execute(args, { cwd: process.cwd() }) as Promise<string>;

  test('a switch to a model the provider does not serve is refused', async () => {
    const out = await run(adapter(['moonshotai/kimi-k3']), { action: 'use', model: 'nvidia/nemotron-3-nano-30b-a3b' });
    expect(out).toMatch(/Refusing to switch/i);
    expect(out).toContain('not served');
  });

  test('the refusal suggests near matches from what IS served', async () => {
    const out = await run(
      adapter(['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'moonshotai/kimi-k3']),
      { action: 'use', model: 'nvidia/nemotron-3-nano-30b-a3b' },
    );
    expect(out).toMatch(/Did you mean/i);
  });

  test('an outage (empty list) does not block a deliberate switch', async () => {
    const out = await run(adapter([]), { action: 'use', model: 'anything/at-all' });
    expect(out).not.toMatch(/Refusing/i);
  });
});
