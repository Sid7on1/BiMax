import * as fs from 'fs';
import * as path from 'path';
import { LlmAdapter } from '../core/llm.adapter';

/**
 * Healing may act on EVIDENCE only, never on a catalogue opinion.
 *
 * Regression (measured 2026-09-02): `isAvoidAutoSelect` was a third eviction reason, so the healer
 * replaced models that answered in 4-7s and called tools with models that timed out / 404'd —
 * purely because the working ones carried an `avoidAutoSelect` note ("GUI probes chose wrong
 * clicks", "task probe pending") and the broken ones did not. Every turn made zero tool calls.
 */
describe('healModels acts on evidence, not catalogue opinion', () => {
  const make = (served: string[], pinned: string) => {
    const a: any = new LlmAdapter({ getNextKey: async () => ({}) } as any);
    a.listProviderModels = async () => served;
    a.userModel = pinned;
    a.defaultModel = pinned;
    return a;
  };

  test('a served, avoidAutoSelect model the user pinned is left alone', async () => {
    // nemotron-3.5-lightning carries avoidAutoSelect; kimi-k3 does not.
    const a = make(['nvidia/nemotron-3.5-lightning-30b-a3b', 'moonshotai/kimi-k3'],
                   'nvidia/nemotron-3.5-lightning-30b-a3b');
    const healed = await a.healModels();
    expect(healed).toEqual([]);
    expect(a.userModel).toBe('nvidia/nemotron-3.5-lightning-30b-a3b');
  });

  test('a model the provider does not serve is still healed', async () => {
    const a = make(['moonshotai/kimi-k3'], 'stepfun-ai/step-3.7-flash');
    const healed = await a.healModels();
    expect(healed.length).toBeGreaterThan(0);
    expect(a.userModel).not.toBe('stepfun-ai/step-3.7-flash');
  });

  test('a model the provider rejected at call time is still healed', async () => {
    const a = make(['moonshotai/kimi-k3', 'mistralai/mistral-7b-instruct-v0.3'],
                   'mistralai/mistral-7b-instruct-v0.3');
    a.unservable = new Set(['mistralai/mistral-7b-instruct-v0.3']);
    const healed = await a.healModels();
    expect(healed.length).toBeGreaterThan(0);
    expect(a.userModel).toBe('moonshotai/kimi-k3');
  });

  test('an empty provider list never heals (cannot distinguish outage from removal)', async () => {
    const a = make([], 'moonshotai/kimi-k3');
    expect(await a.healModels()).toEqual([]);
  });
});


/**
 * The same rule at the OTHER two sites that choose a model on the user's behalf. Both are asserted
 * on source because reproducing a mid-turn provider failure in a unit test would test the mock.
 */
describe('failover obeys the same rule as healing', () => {
  const loop = (): string =>
    fs.readFileSync(path.resolve(__dirname, '..', 'core', 'agent.loop.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

  test('a configured fallback is not vetoed by a catalogue note', () => {
    expect(loop()).not.toMatch(/avoidAutoSelect/);
  });

  test('a derived failover model is never persisted over the user pick', () => {
    expect(loop()).not.toMatch(/saveConfig\(\s*\{\s*model/);
  });

  test('failover still happens (the fix must not remove the recovery)', () => {
    expect(loop()).toContain('fallbackModelFor');
    expect(loop()).toMatch(/applyConfig\?\.\(\{ model: fb \}\)/);
  });
});
