import { constrainCatalogToStrictModel } from '../protocol/catalog.wire';

function catalog(served: boolean, error?: string): any {
  return {
    t: 'catalogResult',
    id: 1,
    providers: [
      {
        name: 'nvidia', label: 'NVIDIA NIM', baseURL: 'https://integrate.api.nvidia.com/v1',
        apiKeyEnv: 'NVIDIA_API_KEY', active: true, hasKey: true, keyCount: 1,
      },
      {
        name: 'stepfun', label: 'StepFun', baseURL: 'https://api.stepfun.ai/v1',
        apiKeyEnv: 'STEPFUN_API_KEY', active: false, hasKey: false, keyCount: 0,
      },
      {
        name: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'OPENROUTER_API_KEY', active: false, hasKey: false, keyCount: 0,
      },
      {
        name: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY', active: false, hasKey: true, keyCount: 1,
      },
    ],
    models: [
      { id: 'stepfun-ai/step-3.7-flash', label: 'Step 3.7 Flash', desc: '', tier: 'coding', served, curated: true },
      { id: 'another/model', label: 'Other', desc: '', tier: 'other', served: true, curated: false },
    ],
    ...(error ? { error } : {}),
  };
}

describe('constrainCatalogToStrictModel', () => {
  it('keeps only the exact desktop model and explains a retired provider route', () => {
    const result = constrainCatalogToStrictModel(catalog(false), 'stepfun-ai/step-3.7-flash');
    expect(result.models.map(model => model.id)).toEqual(['stepfun-ai/step-3.7-flash']);
    expect(result.providers.map(provider => provider.name)).toEqual(['nvidia', 'stepfun', 'openrouter']);
    expect(result.error).toMatch(/not currently served by NVIDIA NIM/i);
    expect(result.error).toMatch(/StepFun or OpenRouter API key/i);
  });

  it('does not invent an error when the selected provider serves the exact model', () => {
    const result = constrainCatalogToStrictModel(catalog(true), 'stepfun-ai/step-3.7-flash');
    expect(result.error).toBeUndefined();
  });

  it('preserves a more specific catalog failure', () => {
    const result = constrainCatalogToStrictModel(
      catalog(false, 'No API key is set for this provider.'),
      'stepfun-ai/step-3.7-flash',
    );
    expect(result.error).toBe('No API key is set for this provider.');
  });
});
