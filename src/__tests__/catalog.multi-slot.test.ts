import { buildModelEntries } from '../protocol/catalog.wire';

describe('provider catalog with multi-slot recommendations', () => {
  it('keeps one model row while exposing it in every recommended slot', () => {
    const models = buildModelEntries(
      {
        getProviders: () => [],
        activeProvider: () => ({ name: 'nvidia' }),
        catalog: () => [
          {
            label: 'Kimi K3',
            value: 'moonshotai/kimi-k3',
            desc: 'Multimodal agent model',
            tier: 'coding',
            recommendedFor: ['coding', 'vision'],
            tags: ['agentic', 'vision'],
            parameters: '2.8T · 104B active',
            releaseDate: '2026-08-20',
          },
        ],
        listServed: async () => [],
        capabilities: () => ({}),
        readEnv: () => undefined,
      },
      ['moonshotai/kimi-k3', 'openai/gpt-oss-120b'],
      'nvidia',
    );

    expect(models.map((model) => model.id)).toEqual(['moonshotai/kimi-k3', 'openai/gpt-oss-120b']);
    expect(models[0]).toMatchObject({
      recommendedFor: ['coding', 'vision'],
      tags: ['agentic', 'vision'],
      parameters: '2.8T · 104B active',
      releaseDate: '2026-08-20',
      served: true,
      curated: true,
    });
    expect(models[1]).toMatchObject({
      tier: 'other',
      served: true,
      curated: false,
    });
  });
});
