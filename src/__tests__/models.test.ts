import {
  MODEL_CATALOG,
  modelMenuOptions,
  DEFAULT_CODING_MODEL,
  DEFAULT_LITE_MODEL,
  autoSelectCandidates,
  isReasoningModel,
  isRecommendedFor,
  slotModelMenuOptions,
} from '../engine/models';

describe('model catalog', () => {
  it('includes the current curated NVIDIA agent routes across tiers', () => {
    const ids = MODEL_CATALOG.map((m) => m.value);
    expect(ids).toEqual(
      expect.arrayContaining([
        'moonshotai/kimi-k3',
        'nvidia/nemotron-3.5-lightning-30b-a3b',
        'nvidia/nemotron-3-ultra-550b-a55b',
        'nvidia/nemotron-3-super-120b-a12b',
        'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
        'nvidia/nemotron-3-nano-30b-a3b',
        'deepseek-ai/deepseek-v4-pro-0813',
        'deepseek-ai/deepseek-v4-flash-0731',
        'openai/gpt-oss-120b',
        'minimaxai/minimax-m3',
        'mistralai/mistral-7b-instruct-v0.3',
        'moonshotai/kimi-k2.6',
      ]),
    );
    expect(ids.some((id) => /stepfun|step-3\./i.test(id))).toBe(false);
    expect(MODEL_CATALOG.some((m) => m.tier === 'coding')).toBe(true);
    expect(MODEL_CATALOG.some((m) => m.tier === 'lite')).toBe(true);
    expect(MODEL_CATALOG.some((m) => m.tier === 'vision')).toBe(true);
  });

  it('has one unique row per model id and supports recommendations in several slots', () => {
    const ids = MODEL_CATALOG.map((model) => model.value);
    expect(ids).toHaveLength(new Set(ids).size);

    const kimi = MODEL_CATALOG.find((model) => model.value === 'moonshotai/kimi-k3')!;
    expect(isRecommendedFor(kimi, 'coding')).toBe(true);
    expect(isRecommendedFor(kimi, 'vision')).toBe(true);
    expect(isRecommendedFor(kimi, 'lite')).toBe(false);
  });

  it('keeps Quick recommendations plain and lets heavy models remain browse/search choices', () => {
    const quick = MODEL_CATALOG.filter((model) => isRecommendedFor(model, 'lite'));
    expect(quick.length).toBeGreaterThan(2);
    expect(quick.every((model) => !isReasoningModel(model.value))).toBe(true);

    const menu = slotModelMenuOptions(
      'quick',
      MODEL_CATALOG.map((model) => model.value),
    );
    expect(menu.some((option) => option.value === 'openai/gpt-oss-120b')).toBe(false);
    expect(MODEL_CATALOG.some((model) => model.value === 'openai/gpt-oss-120b')).toBe(true);
  });

  it('carries parameters, dates, or an explicit publisher-unknown state for recommended rows', () => {
    const recommendations = MODEL_CATALOG.filter((model) => model.recommendedFor?.length);
    expect(recommendations.length).toBeGreaterThan(10);
    expect(recommendations.every((model) => !!model.tags?.length)).toBe(true);
    expect(recommendations.some((model) => model.parameters && model.releaseDate)).toBe(true);
  });

  it('uses current dated DeepSeek ids and omits retired or stale NVIDIA recommendations', () => {
    const ids = MODEL_CATALOG.map((m) => m.value);
    expect(ids).toContain('deepseek-ai/deepseek-v4-pro-0813');
    expect(ids).toContain('deepseek-ai/deepseek-v4-flash-0731');
    for (const bad of ['deepseek-ai/deepseek-v4-pro', 'deepseek-ai/deepseek-v4-flash', 'stepfun-ai/step-3.7-flash']) {
      expect(ids).not.toContain(bad);
    }
    expect(ids).toContain('moonshotai/kimi-k2.6');
  });

  it('defaults are valid catalog entries', () => {
    const ids = MODEL_CATALOG.map((m) => m.value);
    expect(ids).toContain(DEFAULT_CODING_MODEL);
    expect(ids).toContain(DEFAULT_LITE_MODEL);
  });

  it('no default points at a model the healer is forbidden to choose', () => {
    // A default that is avoidAutoSelect is self-contradictory: it ships every new config pointing
    // at a model we have already decided is too unreliable to select on a user's behalf.
    const avoided = new Set(MODEL_CATALOG.filter((m) => m.avoidAutoSelect).map((m) => m.value));
    expect(avoided.has(DEFAULT_CODING_MODEL)).toBe(false);
    expect(avoided.has(DEFAULT_LITE_MODEL)).toBe(false);
  });

  it('the shipped config defaults ARE the catalog defaults, and are all selectable', () => {
    // Defaults and recommendations have drifted before; keep every shipped role synchronized with
    // a selectable, non-avoided current catalog row.
    //
    // That drift is not cosmetic. The failover path (core/agent.loop.ts fallbackModelFor) consults
    // the CATALOG to decide whether a model is safe to select automatically, so a default the
    // catalog silently disagrees with is handed to every new user while the guard reports itself
    // satisfied. Asserting the agreement is what keeps one of these edits from moving alone.
    const { DEFAULTS } = require('../engine/config') as typeof import('../engine/config');
    const avoided = new Set(MODEL_CATALOG.filter((m) => m.avoidAutoSelect).map((m) => m.value));

    expect(DEFAULTS.model).toBe(DEFAULT_CODING_MODEL);
    expect(DEFAULTS.liteModel).toBe(DEFAULT_LITE_MODEL);

    for (const [slot, id] of Object.entries({
      model: DEFAULTS.model,
      liteModel: DEFAULTS.liteModel,
      visionModel: DEFAULTS.visionModel,
    })) {
      expect(MODEL_CATALOG.map((m) => m.value)).toContain(id); // a default must be a real catalog id
      expect({ slot, avoided: avoided.has(id) }).toEqual({ slot, avoided: false });
    }
  });

  it('the quick-slot default is a plain model, never a reasoner', () => {
    // The slot exists to answer "hi" instantly. This is the rule the catalog states for itself;
    // it regressed once already when the default was set to a reasoning model.
    expect(isReasoningModel(DEFAULT_LITE_MODEL)).toBe(false);
  });

  it('modelMenuOptions marks the current model and carries category labels', () => {
    const opts = modelMenuOptions('moonshotai/kimi-k3');
    const cur = opts.find((o) => o.value === 'moonshotai/kimi-k3');
    expect(cur!.label.startsWith('●')).toBe(true);
    expect(opts.every((o) => typeof o.category === 'string' && o.category.length > 0)).toBe(true);
  });
});

// The auto-selection policy the self-healer uses when a configured model has gone stale. Every
// case here is a property of the policy, not a pinned model id, so re-probing the catalog and
// changing which models are recommended cannot silently invalidate these.
describe('autoSelectCandidates — what the healer is allowed to pick for you', () => {
  const allIds = MODEL_CATALOG.map((m) => m.value);

  it('only ever offers models the provider actually serves', () => {
    const served = ['openai/gpt-oss-120b', 'moonshotai/kimi-k3'];
    for (const slot of ['coding', 'lite', 'vision'] as const) {
      expect(autoSelectCandidates(slot, served).every((id) => served.includes(id))).toBe(true);
    }
  });

  it('never auto-picks a model flagged avoidAutoSelect, even when it is the only one served', () => {
    const avoided = MODEL_CATALOG.filter((m) => m.avoidAutoSelect).map((m) => m.value);
    expect(avoided.length).toBeGreaterThan(0); // guard: the flag must actually be in use
    for (const slot of ['coding', 'lite', 'vision'] as const) {
      expect(autoSelectCandidates(slot, avoided)).toEqual([]);
    }
  });

  it('returns nothing rather than picking an arbitrary provider id', () => {
    // The regression this encodes: the old healer used servedIds[0], which on NVIDIA is
    // "01-ai/yi-large" — listed by /models but a 404 on chat/completions. An empty result is the
    // correct answer, so the caller can leave the pin alone and tell the user to run /model.
    expect(autoSelectCandidates('coding', ['01-ai/yi-large', 'some/unknown-model'])).toEqual([]);
    expect(autoSelectCandidates('coding', [])).toEqual([]);
  });

  it('prefers a model from the requested slot over one borrowed from another slot', () => {
    const visionOnly = MODEL_CATALOG.find(
      (m) => isRecommendedFor(m, 'lite') && !isRecommendedFor(m, 'coding') && !m.avoidAutoSelect,
    )!.value;
    const codingOnly = MODEL_CATALOG.find(
      (m) => isRecommendedFor(m, 'coding') && !isRecommendedFor(m, 'vision') && !m.avoidAutoSelect,
    )!.value;
    expect(autoSelectCandidates('coding', [visionOnly, codingOnly])[0]).toBe(codingOnly);
  });

  it('still borrows from another slot rather than leaving a slot unhealed', () => {
    const visionOnly = MODEL_CATALOG.find(
      (m) => isRecommendedFor(m, 'lite') && !isRecommendedFor(m, 'coding') && !m.avoidAutoSelect,
    )!.value;
    expect(autoSelectCandidates('coding', [visionOnly])).toEqual([visionOnly]);
  });

  it('ranks plain models above reasoning models within the quick slot', () => {
    // The quick slot exists to answer "hi" instantly; a reasoner there hides 20-30s of thought.
    // The ordering guarantee applies to the slot's OWN models — models borrowed from another slot
    // are a last resort and keep catalog order, so they are excluded here.
    const inSlot = new Set(MODEL_CATALOG.filter((m) => isRecommendedFor(m, 'lite')).map((m) => m.value));
    const quick = autoSelectCandidates('lite', allIds).filter((id) => inSlot.has(id));
    const firstReasoner = quick.findIndex(isReasoningModel);
    const lastPlain = quick.map(isReasoningModel).lastIndexOf(false);
    if (firstReasoner !== -1 && lastPlain !== -1) expect(lastPlain).toBeLessThan(firstReasoner);
  });

  it('a served plain quick model outranks a served quick reasoner', () => {
    const plain = MODEL_CATALOG.find(
      (m) => isRecommendedFor(m, 'lite') && !m.avoidAutoSelect && !isReasoningModel(m.value),
    )?.value;
    const reasoner = MODEL_CATALOG.find(
      (m) => isRecommendedFor(m, 'lite') && !m.avoidAutoSelect && isReasoningModel(m.value),
    )?.value;
    if (plain && reasoner) expect(autoSelectCandidates('lite', [reasoner, plain])[0]).toBe(plain);
  });

  it('produces no duplicates', () => {
    const out = autoSelectCandidates('coding', allIds);
    expect(out.length).toBe(new Set(out).size);
  });
});
