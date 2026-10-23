import type { CatalogModelEntry } from '../../../protocol';
import { buildModelPickerGroups } from '../model.catalog.view';

const models: CatalogModelEntry[] = [
  {
    id: 'moonshotai/kimi-k3',
    label: 'Kimi K3',
    desc: 'multimodal agent',
    tier: 'coding',
    recommendedFor: ['coding', 'vision'],
    tags: ['vision', 'agentic'],
    parameters: '2.8T',
    releaseDate: '2026-08-20',
    served: true,
    curated: true,
  },
  {
    id: 'mistralai/mistral-7b-instruct-v0.3',
    label: 'Mistral 7B',
    desc: 'quick reply',
    tier: 'lite',
    recommendedFor: ['lite'],
    tags: ['quick'],
    parameters: '7B',
    releaseDate: '2024-05-22',
    served: true,
    curated: true,
  },
  {
    id: 'openai/gpt-oss-120b',
    label: 'GPT OSS 120B',
    desc: 'heavy reasoner',
    tier: 'coding',
    recommendedFor: ['coding'],
    tags: ['reasoning'],
    parameters: '120B',
    releaseDate: '2025-08-05',
    served: true,
    curated: true,
  },
  {
    id: 'provider/uncurated',
    label: 'provider/uncurated',
    desc: 'live provider model',
    tier: 'other',
    served: true,
    curated: false,
  },
];

describe('model catalogue picker projection', () => {
  test('the same unique model is recommended in Work and Vision', () => {
    expect(buildModelPickerGroups(models, 'coding', '', false).recommended.map((model) => model.id)).toContain(
      'moonshotai/kimi-k3',
    );
    expect(buildModelPickerGroups(models, 'vision', '', false).recommended.map((model) => model.id)).toEqual([
      'moonshotai/kimi-k3',
    ]);
  });

  test('Quick starts with fast recommendations and hides heavy models', () => {
    const groups = buildModelPickerGroups(models, 'lite', '', false);
    expect(groups.recommended.map((model) => model.id)).toEqual(['mistralai/mistral-7b-instruct-v0.3']);
    expect(groups.extra).toEqual([]);
    expect(groups.availableTotal).toBe(4);
  });

  test('Browse all reveals every other live model and search finds a heavy model immediately', () => {
    const browsed = buildModelPickerGroups(models, 'lite', '', true);
    expect(browsed.extra.map((model) => model.id)).toEqual(
      expect.arrayContaining(['moonshotai/kimi-k3', 'openai/gpt-oss-120b', 'provider/uncurated']),
    );

    const searched = buildModelPickerGroups(models, 'lite', '120b', false);
    expect(searched.extra.map((model) => model.id)).toEqual(['openai/gpt-oss-120b']);
  });
});
