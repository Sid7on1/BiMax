import { LlmAdapter } from '../core/llm.adapter';

describe('LlmAdapter provider-gone recovery', () => {
  const previousStrict = process.env.BIMAX_DESKTOP_STRICT_MODEL;

  afterEach(() => {
    if (previousStrict === undefined) delete process.env.BIMAX_DESKTOP_STRICT_MODEL;
    else process.env.BIMAX_DESKTOP_STRICT_MODEL = previousStrict;
  });

  it('turns a Step 3.7 410 into a provider-specific Settings instruction', async () => {
    process.env.BIMAX_DESKTOP_STRICT_MODEL = 'stepfun-ai/step-3.7-flash';
    const manager = {
      getNextKey: async () => ({
        keyStr: 'secret', model: 'stepfun-ai/step-3.7-flash',
        baseURL: 'https://integrate.api.nvidia.com/v1', provider: 'nvidia', idx: 0, waitTimeSecs: 0,
      }),
      reportKeyResult: jest.fn(),
      allKeysAuthDead: () => false,
    } as any;
    const adapter = new LlmAdapter(manager);
    const error: any = new Error("The model 'stepfun-ai/step-3.7-flash' has reached its end of life.");
    error.status = 410;
    (adapter as any).createClient = () => ({
      chat: { completions: { create: async () => { throw error; } } },
    });

    await expect(adapter.chatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /Settings → Models → Providers.*StepFun or OpenRouter key/i,
    );
    expect(manager.reportKeyResult).toHaveBeenCalledWith(0, 410);
  });
});
