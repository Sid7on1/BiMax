import { AdaptiveRuntimePolicy, renderingPolicy, replayPolicy, type RuntimeSignals } from '../adaptive.policy';

const base = (at: number, overrides: Partial<RuntimeSignals> = {}): RuntimeSignals => ({
  observedAt: at, architecture: 'arm64', cpuCount: 8, availableMemoryMb: 12_000, totalMemoryMb: 16_384,
  thermal: 'nominal', memoryPressure: 'normal', powerSource: 'ac', lowPowerMode: false,
  network: 'normal', activeInteraction: false, reduceMotion: false,
  simulatorReservationMb: 0, localModelReservationMb: 0, ...overrides,
});

describe('Phase 9 adaptive runtime and rendering (S29-F)', () => {
  test('canaries only background concurrency and constrains immediately during interaction', () => {
    let now = 0;
    const policy = new AdaptiveRuntimePolicy({ canaryEnabled: true, now: () => now, minimumResidenceMs: 1000, interactionCooldownMs: 100 });
    expect(policy.decide(base(now)).selected).toBe(4);
    now = 10;
    const interaction = policy.decide(base(now, { activeInteraction: true }));
    expect(interaction).toMatchObject({ decisionClass: 'background-concurrency', selected: 1, automatic: true });
    expect(policy.engineEnvironment(interaction)).toEqual(expect.objectContaining({ BIMAX_MAX_CONCURRENT_SUBAGENTS: '1' }));
  });

  test('hysteresis prevents immediate relaxation after a thermal transition', () => {
    let now = 0;
    const policy = new AdaptiveRuntimePolicy({ canaryEnabled: true, now: () => now, minimumResidenceMs: 1000 });
    policy.decide(base(now));
    now = 10;
    expect(policy.decide(base(now, { thermal: 'serious' })).selected).toBe(1);
    now = 20;
    expect(policy.decide(base(now, { thermal: 'nominal' })).selected).toBe(1);
    now = 1020;
    expect(policy.decide(base(now, { thermal: 'nominal' })).selected).toBe(4);
  });

  test('shadow mode publishes a decision but cannot mutate engine environment', () => {
    const policy = new AdaptiveRuntimePolicy({ canaryEnabled: false, now: () => 0 });
    const decision = policy.decide(base(0, { thermal: 'critical' }));
    expect(decision.automatic).toBe(false);
    expect(decision.selected).toBeGreaterThanOrEqual(1);
    expect(decision.selected).toBeLessThanOrEqual(4);
    expect(policy.engineEnvironment(decision)).toEqual({});
  });

  test('Reduce Motion always removes nonessential animation even with unlimited headroom', () => {
    expect(renderingPolicy(base(0, { reduceMotion: true }), false)).toMatchObject({
      mode: 'reduced-motion', nonessentialAnimation: false, automatic: true,
    });
  });

  test('trace replay keeps transition count bounded under noisy states', () => {
    let now = 0;
    const policy = new AdaptiveRuntimePolicy({ canaryEnabled: true, now: () => now, minimumResidenceMs: 1000 });
    const trace = [base(0), base(1, { thermal: 'fair' }), base(2), base(3, { thermal: 'fair' })];
    const result = replayPolicy(policy, trace.map((row, index) => { now = index * 10; return row; }));
    expect(result.transitions).toBeLessThanOrEqual(2);
    expect(result.minimumSelected).toBeGreaterThanOrEqual(1);
  });
});
