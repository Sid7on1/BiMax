import { LlmAdapter } from '../core/llm.adapter';
import { MODEL_CATALOG, autoSelectCandidates } from '../engine/models';

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

/**
 * A model the healer would actually pick for `slot`.
 *
 * This used to re-derive the rule as `m.tier === slot && !m.avoidAutoSelect`, which is NOT the
 * policy under test: slot membership is `recommendedFor`, not `tier` — Kimi K3 is `tier:'coding'`
 * and serves the Vision slot through `recommendedFor: ['coding','vision']`. With no catalogue row
 * whose *primary* tier is vision and which is auto-selectable, the old helper returned `undefined`
 * and five tests died on `Cannot read properties of undefined` — reading as a broken vision slot
 * when auto-selection was working correctly the whole time. Ask the policy instead of restating it.
 */
const pickable = (slot: 'coding' | 'lite' | 'vision') => {
  const id = autoSelectCandidates(slot, MODEL_CATALOG.map(m => m.value))[0];
  if (!id) throw new Error(`catalogue offers no auto-selectable model for the ${slot} slot`);
  return id;
};

/** A catalogue model barred from automatic selection, for the "served but unfit" cases. */
const avoided = (slot: 'coding' | 'lite' | 'vision') => {
  const auto = new Set(autoSelectCandidates(slot, MODEL_CATALOG.map(m => m.value)));
  const id = MODEL_CATALOG.find(m => m.tier === slot && !auto.has(m.value))?.value;
  if (!id) throw new Error(`catalogue offers no avoid-auto-select model for the ${slot} slot`);
  return id;
};

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

  it('leaves a served pin alone when the only complaint is avoidAutoSelect', async () => {
    // This asserted the OPPOSITE until 2026-09-02, and that assertion was the bug. `avoidAutoSelect`
    // is a catalogue OPINION about automatic picking, not evidence that a model cannot serve a turn.
    // Letting it evict an incumbent measurably replaced two WORKING models (answered in 4.0s/6.7s,
    // called tools) with two BROKEN ones (90s timeout; HTTP 404) — because the working pair carried
    // the flag and the broken pair did not. Result: zero tool calls on every turn.
    //
    // Eviction now requires real evidence, and the two kinds it accepts each have their own test
    // ("not served by the provider" above, "rejected at call time" below). This test exists to keep
    // the third, invalid reason from coming back.
    const avoidedVision = avoided('vision');
    const a = adapterServing(SERVED(avoidedVision, pickable('vision'), pickable('coding')));
    a.applyConfig({ model: pickable('coding'), visionModel: avoidedVision });

    expect(await a.healModels()).toEqual([]);
    expect(a.visionModel).toBe(avoidedVision);
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
