import { LlmAdapter } from '../core/llm.adapter';

/**
 * A reasoning model sampled at the plain 0.1 default degenerates into a token loop, which reaches
 * the user as a stalled turn that never calls a tool. An explicit choice must still win.
 */
describe('reasoning models get a temperature floor', () => {
  const adapter = (): any => new LlmAdapter({ getNextKey: async () => ({}) } as any);

  test('a reasoning model is lifted off the cold default', () => {
    const a = adapter();
    a.temperature = 0.1;
    expect(a.resolveSampling('moonshotai/kimi-k3').temperature).toBeGreaterThanOrEqual(0.6);
  });

  test('a plain instruct model keeps the configured temperature', () => {
    const a = adapter();
    a.temperature = 0.1;
    expect(a.resolveSampling('mistralai/mistral-7b-instruct-v0.3').temperature).toBe(0.1);
  });

  test('an explicit per-call override always wins, even below the floor', () => {
    const a = adapter();
    a.temperature = 0.1;
    expect(a.resolveSampling('moonshotai/kimi-k3', 0.2).temperature).toBe(0.2);
  });

  test('a user temperature above the floor is not lowered', () => {
    const a = adapter();
    a.temperature = 0.9;
    expect(a.resolveSampling('moonshotai/kimi-k3').temperature).toBe(0.9);
  });

  test("minimax keeps its own model-card pin", () => {
    const a = adapter();
    a.temperature = 0.1;
    expect(a.resolveSampling('minimax/minimax-m3').temperature).toBe(1.0);
  });
});
