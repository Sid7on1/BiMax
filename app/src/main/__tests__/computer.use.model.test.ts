import { describe, expect, test } from '@jest/globals';
import { computerUseModelReadiness } from '../../renderer/src/computer.use.model';
import type { CatalogModelEntry, EngineCatalog, EngineConfig } from '../../renderer/src/protocol';

const work: CatalogModelEntry = {
  id: 'work', label: 'Work', desc: '', tier: 'coding', served: true, curated: true,
  capabilities: {
    visionInput: false, reasoningEffortKnob: true, thinking: true,
    structuredOutputs: true, parallelToolCalls: true, contextWindow: 100_000,
  },
};
const vision: CatalogModelEntry = {
  id: 'vision', label: 'Vision', desc: '', tier: 'vision', served: true, curated: true,
  capabilities: {
    visionInput: true, reasoningEffortKnob: false, thinking: false,
    structuredOutputs: false, parallelToolCalls: false, contextWindow: 32_000,
  },
};

function catalog(models = [work, vision], error?: string): EngineCatalog {
  return {
    providers: [{
      name: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY', hasKey: true, keyCount: 1, active: true,
    }],
    models,
    ...(error ? { error } : {}),
  };
}

describe('Control Mac model preflight', () => {
  const config: EngineConfig = { model: 'work', visionModel: 'vision' };

  test('accepts a served work route plus served vision route', () => {
    expect(computerUseModelReadiness(config, catalog()).ready).toBe(true);
  });

  test('fails closed when provider verification times out', () => {
    const result = computerUseModelReadiness(config, catalog([], 'provider timeout'));
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain('The active provider could not be verified.');
  });

  test('rejects an unserved work model before the task reaches the engine', () => {
    const result = computerUseModelReadiness(config, catalog([{ ...work, served: false }, vision]));
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain('Choose a Work model confirmed by this provider.');
  });

  test('rejects a served Vision model in the Work slot because serving images is not tool-use proof', () => {
    const visionAsWork = { ...vision, id: 'vision-work' };
    const result = computerUseModelReadiness(
      { model: 'vision-work' },
      catalog([visionAsWork]),
    );
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain('Choose a Work model verified for agent tool use.');
  });

  test('rejects an uncurated provider model for Control Mac until tool use is verified', () => {
    const unknown = { ...work, id: 'provider/model', curated: false };
    const result = computerUseModelReadiness(
      { model: 'provider/model', visionModel: 'vision' },
      catalog([unknown, vision]),
    );
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain('Choose a Work model verified for agent tool use.');
  });

  test('accepts an explicitly selected multimodal Work model even when duplicate slot rows end in Quick', () => {
    const stepWork: CatalogModelEntry = {
      ...work,
      id: 'stepfun-ai/step-3.7-flash',
      avoidAutoSelect: true,
      capabilities: { ...work.capabilities!, visionInput: true },
    };
    const stepVision: CatalogModelEntry = {
      ...stepWork,
      tier: 'vision',
    };
    const stepQuick: CatalogModelEntry = {
      ...stepWork,
      tier: 'lite',
    };

    const result = computerUseModelReadiness(
      {
        model: 'stepfun-ai/step-3.7-flash',
        visionModel: 'stepfun-ai/step-3.7-flash',
      },
      catalog([stepWork, stepVision, stepQuick]),
    );

    expect(result.ready).toBe(true);
    expect(result.work?.tier).toBe('coding');
    expect(result.vision?.capabilities?.visionInput).toBe(true);
  });

  test('allows one served multimodal work model to fill both roles', () => {
    const multimodal = { ...work, capabilities: { ...work.capabilities!, visionInput: true } };
    expect(computerUseModelReadiness({ model: 'work' }, catalog([multimodal])).ready).toBe(true);
  });
});
