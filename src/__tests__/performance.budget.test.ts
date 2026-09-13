import { performanceBudgetReport, assertPerformanceBudgets } from '../telemetry/performance.budget';
import { PerfSnapshot } from '../telemetry/perf';

function snap(over?: Partial<PerfSnapshot>): PerfSnapshot {
  return {
    coldStartMs: 1200, uptimeMs: 2000, rssMb: 512, heapMb: 100, turns: 0,
    firstTokenP50: 0, firstTokenP95: 0, lastTurn: null,
    overheadP50: 0, overheadP95: 0, providerWaitP50: 0, providerWaitP95: 0,
    renderP95: 0, liteOverheadP95: 0, lastBreakdown: null,
    providerRounds: 0, roundWaitP50: 0, roundWaitP95: 0, roundsWithUsage: 0,
    providerInputTokens: null, providerOutputTokens: null, providerCachedInputTokens: null,
    ...over,
  };
}

describe('performance budgets', () => {
  it('distinguishes passing, over-budget, and unmeasured metrics', () => {
    const checks = performanceBudgetReport(snap({ rssMb: 2048 }));
    expect(checks.find(c => c.metric === 'cold_start')).toMatchObject({ measured: true, pass: true });
    expect(checks.find(c => c.metric === 'rss')).toMatchObject({ measured: true, pass: false });
    expect(checks.find(c => c.metric === 'first_token_p95')).toMatchObject({ measured: false, pass: false });
  });

  it('greeting-overhead gate passes under 250ms and fails over it', () => {
    expect(performanceBudgetReport(snap({ liteOverheadP95: 180 })).find(c => c.metric === 'greeting_overhead_p95'))
      .toMatchObject({ measured: true, pass: true });
    expect(performanceBudgetReport(snap({ liteOverheadP95: 900 })).find(c => c.metric === 'greeting_overhead_p95'))
      .toMatchObject({ measured: true, pass: false });
  });

  it('render gate (raw→visible) passes under 100ms and fails over it', () => {
    expect(performanceBudgetReport(snap({ renderP95: 40 })).find(c => c.metric === 'render_p95'))
      .toMatchObject({ measured: true, pass: true });
    expect(performanceBudgetReport(snap({ renderP95: 350 })).find(c => c.metric === 'render_p95'))
      .toMatchObject({ measured: true, pass: false });
  });

  it('assertPerformanceBudgets THROWS on a measured regression (a gate, not a report)', () => {
    expect(() => assertPerformanceBudgets(snap({ liteOverheadP95: 900 }))).toThrow(/greeting_overhead_p95/);
    // Healthy numbers do not throw; unmeasured metrics never fail a gate.
    expect(() => assertPerformanceBudgets(snap({ liteOverheadP95: 100, renderP95: 30 }))).not.toThrow();
  });
});
