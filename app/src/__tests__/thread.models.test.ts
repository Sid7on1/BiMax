import { modelMenuItems } from '../main/thread.models';

const models = [
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', tier: 'coding', served: true, recommendedFor: ['coding'], capabilities: { thinking: true } },
  { id: 'meta/llama-3.3-70b-instruct', tier: 'coding', served: true, recommendedFor: ['lite'] },
  { id: 'mistralai/mistral-7b-instruct-v0.3', tier: 'lite', served: false },
  { id: 'someone/needs-its-own-key', tier: 'other', served: true },
];
const times = { 'meta/llama-3.3-70b-instruct': { avgMs: 4000, turns: 3 }, 'nvidia/nemotron-3.5-lightning-30b-a3b': { avgMs: 36000, turns: 2 } };

test('the model menu lists Bimax first, then the quickest measured models; unserved and other-key models are left out', () => {
  const items = modelMenuItems({ models, current: null, bimaxModel: 'nvidia/nemotron-3.5-lightning-30b-a3b', quickDefault: null, times, mode: 'switch' });
  expect(items[1]).toEqual({ kind: 'model', label: 'Same as Bimax — nemotron-3.5-lightning-30b-a3b', model: null, checked: true });
  const listed = items.filter((i) => i.kind === 'model' && i.model).map((i) => (i as { label: string }).label);
  expect(listed).toEqual(['llama-3.3-70b-instruct — about 4s a turn', 'nemotron-3.5-lightning-30b-a3b — about 36s a turn · thinks first']);
  expect(items[items.length - 1]).toMatchObject({ kind: 'default', checked: true });
});

test('a task on its own model shows it checked, and can make it the default for new ⌘2 tasks', () => {
  const items = modelMenuItems({ models, current: 'meta/llama-3.3-70b-instruct', bimaxModel: 'nvidia/nemotron-3.5-lightning-30b-a3b', quickDefault: null, times, mode: 'switch' });
  expect(items.find((i) => i.kind === 'model' && i.model === 'meta/llama-3.3-70b-instruct')).toMatchObject({ checked: true });
  expect(items[items.length - 1]).toEqual({ kind: 'default', label: 'Use this model for new ⌘2 tasks', model: 'meta/llama-3.3-70b-instruct', checked: false });
});

test('retry offers every other model, never the one that just answered', () => {
  const onBimax = modelMenuItems({ models, current: null, bimaxModel: 'nvidia/nemotron-3.5-lightning-30b-a3b', quickDefault: null, times: {}, mode: 'retry' });
  expect(onBimax.map((i) => ('model' in i ? i.model : i.kind))).toEqual(['header', 'meta/llama-3.3-70b-instruct']);
  const onLlama = modelMenuItems({ models, current: 'meta/llama-3.3-70b-instruct', bimaxModel: 'nvidia/nemotron-3.5-lightning-30b-a3b', quickDefault: null, times: {}, mode: 'retry' });
  expect(onLlama.map((i) => ('model' in i ? i.model : i.kind))).toEqual(['header', null, 'nvidia/nemotron-3.5-lightning-30b-a3b']);
});
