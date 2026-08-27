import { LlmAdapter } from '../core/llm.adapter';
import { MODEL_CATALOG } from '../cli/models';

// Regression suite for the silent-no-reply bug: a config pinned to models the provider no longer
// serves. Healing only the WORK slot left the QUICK slot pointing at a dead model, and because a
// greeting routes to the quick slot, every "hi" hit that dead model and the turn ended with no
// output at all — no reply, no error, cost 0.

const SERVED = (...ids: string[]) => ids;

/** An adapter whose provider serves exactly `ids`, with no network and no key lookup. */
function adapterServing(ids: string[]): LlmAdapter {
  const a = new LlmAdapter({ getNextKey: async () => ({ keyStr: 'k', provider: 'test' }) } as any);
  jest.spyOn(a, 'listProviderModels').mockResolvedValue(ids);
  return a;
}

const pickable = (tier: 'coding' | 'lite' | 'vision') =>
  MODEL_CATALOG.find(m => m.tier === tier && !m.avoidAutoSelect)!.value;

describe('LlmAdapter.healModels', () => {
  it('never heals or replaces an intentional Desktop strict model', async () => {
    const previous = process.env.BIMAX_DESKTOP_STRICT_MODEL;
    process.env.BIMAX_DESKTOP_STRICT_MODEL = 'stepfun-ai/step-3.7-flash';
    try {
      const a = adapterServing(SERVED(pickable('coding')));
      a.applyConfig({ model: 'another/model', liteModel: 'another/lite', visionModel: 'another/vision' });

      expect(await a.healModels()).toEqual([]);
      expect(a.readEffective()).toMatchObject({
        model: 'stepfun-ai/step-3.7-flash',
        liteModel: 'stepfun-ai/step-3.7-flash',
        visionModel: 'stepfun-ai/step-3.7-flash',
      });
    } finally {
      if (previous === undefined) delete process.env.BIMAX_DESKTOP_STRICT_MODEL;
      else process.env.BIMAX_DESKTOP_STRICT_MODEL = previous;
    }
  });

  it('heals the quick and vision slots, not just the work model', () => {
    // THE bug. The work model is fine, so the old healer reported "nothing wrong" and returned —
    // while every greeting kept routing to an unserved quick model and answering with silence.
    const work = pickable('coding');
    const a = adapterServing(SERVED(work, pickable('lite'), pickable('vision')));
    a.applyConfig({ model: work, liteModel: 'dead/quick-model', visionModel: 'dead/vision-model' });

    return a.healModels().then(healed => {
      expect(healed.map(h => h.slot).sort()).toEqual(['quick', 'vision']);
      expect(a.liteModel).not.toBe('dead/quick-model');
      expect(a.visionModel).not.toBe('dead/vision-model');
      expect(a.userModel).toBe(work); // a healthy slot is left alone
    });
  });

  it('heals every slot at once when the whole config is stale', async () => {
    const a = adapterServing(SERVED(pickable('coding'), pickable('lite'), pickable('vision')));
    a.applyConfig({ model: 'dead/work', liteModel: 'dead/quick', visionModel: 'dead/vision' });

    const healed = await a.healModels();

    expect(healed.map(h => h.slot).sort()).toEqual(['quick', 'vision', 'work']);
    for (const h of healed) expect(h.from).not.toBe(h.to);
  });

  it('leaves a stale pin alone rather than switching to an arbitrary served id', async () => {
    // The old healer took servedIds[0]. On NVIDIA that is "01-ai/yi-large", which /models lists but
    // chat/completions 404s — so healing swapped a broken model for a differently broken one and
    // reported success. Doing nothing is correct: the caller then tells the user to run /model.
    const a = adapterServing(SERVED('01-ai/yi-large', 'some/unknown-model'));
    a.applyConfig({ model: 'dead/work' });

    expect(await a.healModels()).toEqual([]);
    expect(a.userModel).toBe('dead/work');
  });

  it('never heals to a model flagged avoidAutoSelect', async () => {
    const avoided = MODEL_CATALOG.filter(m => m.avoidAutoSelect).map(m => m.value);
    const a = adapterServing(avoided);
    a.applyConfig({ model: 'dead/work', liteModel: 'dead/quick', visionModel: 'dead/vision' });

    expect(await a.healModels()).toEqual([]);
    for (const id of [a.userModel, a.liteModel, a.visionModel]) expect(avoided).not.toContain(id);
  });

  it('heals a slot pinned to a served-but-unfit model', async () => {
    // THE computer-use break. The vision slot was pinned to a model the provider happily lists and
    // serves, but which 400s on every tools+image request — i.e. on every computer-use step. Being
    // "served" was enough to make the old check call the slot healthy, so it never got fixed.
    const unfit = MODEL_CATALOG.find(m => m.tier === 'vision' && m.avoidAutoSelect)!.value;
    const good = MODEL_CATALOG.find(m => m.tier === 'vision' && !m.avoidAutoSelect)!.value;
    const a = adapterServing(SERVED(unfit, good, pickable('coding')));
    a.applyConfig({ model: pickable('coding'), visionModel: unfit });

    const healed = await a.healModels();

    expect(healed.map(h => h.slot)).toEqual(['vision']);
    expect(a.visionModel).toBe(good);
  });

  it('heals a slot the provider rejected at call time even though /models lists it', async () => {
    const work = pickable('coding');
    const a = adapterServing(SERVED('01-ai/yi-large', work));
    a.applyConfig({ model: '01-ai/yi-large' });

    expect(await a.healModels()).toEqual([]); // listed and not yet disproven — nothing to do
    a.markUnservable('01-ai/yi-large');       // …then a real completion 404s
    const healed = await a.healModels();

    expect(healed.map(h => h.slot)).toEqual(['work']);
    expect(a.userModel).toBe(work);
  });

  it('does nothing when every configured slot is served', async () => {
    const [w, l, v] = [pickable('coding'), pickable('lite'), pickable('vision')];
    const a = adapterServing(SERVED(w, l, v));
    a.applyConfig({ model: w, liteModel: l, visionModel: v });

    expect(await a.healModels()).toEqual([]);
  });

  it('does not invent a pin for a slot the user left unset', async () => {
    // An unset quick/vision slot is not broken — it falls back to the work model at call time.
    const w = pickable('coding');
    const a = adapterServing(SERVED(w, pickable('lite'), pickable('vision')));
    a.applyConfig({ model: w });

    expect(await a.healModels()).toEqual([]);
    expect(a.liteModel).toBeUndefined();
    expect(a.visionModel).toBeUndefined();
  });

  it('leaves the config untouched when the provider has no /models endpoint', async () => {
    const a = adapterServing([]);
    a.applyConfig({ model: 'dead/work', liteModel: 'dead/quick' });

    expect(await a.healModels()).toEqual([]);
    expect(a.userModel).toBe('dead/work');
    expect(a.liteModel).toBe('dead/quick');
  });

  it('reports each change as {slot, from, to} so the caller can persist the right config key', async () => {
    const a = adapterServing(SERVED(pickable('coding')));
    a.applyConfig({ model: 'dead/work' });

    const [healed] = await a.healModels();

    expect(healed.slot).toBe('work');
    expect(healed.from).toBe('dead/work');
    expect(healed.to).toBe(pickable('coding'));
  });
});
