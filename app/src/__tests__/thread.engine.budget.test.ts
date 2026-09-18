import { maxLiveEngines, MAX_LIVE_ENGINES } from '../main/thread.manager';

const GB = 1024 ** 3;

/**
 * How many threads may hold a live engine, from measured free memory.
 *
 * This was a bare `4` sitting beside supervisor/resources.ts, which has computed a memory-aware
 * profile per launch for a long time and describes itself as "adaptive, not hardcoded". The cap
 * consulted none of it, so on a machine with room for two engines the user could start four and
 * discover the limit as swapping.
 *
 * These assert the SHAPE of the budget — monotonic, floored at 1, ceilinged at the product's 4 —
 * rather than the constants. Pinning "8 GB gives 4" would lock in today's engine footprint and turn
 * a future measurement into a test failure instead of a new answer.
 */
describe('live-engine budget follows measured memory', () => {
  test('never exceeds the product ceiling, however much memory there is', () => {
    expect(maxLiveEngines(64 * GB)).toBe(MAX_LIVE_ENGINES);
    expect(maxLiveEngines(512 * GB)).toBe(MAX_LIVE_ENGINES);
  });

  test('never drops below one — refusing every thread is worse than starting one', () => {
    expect(maxLiveEngines(0)).toBe(1);
    expect(maxLiveEngines(-1 * GB)).toBe(1);
    expect(maxLiveEngines(100 * 1024 * 1024)).toBe(1);
  });

  test('a constrained machine gets fewer than the ceiling', () => {
    // Enough for the reserve and one or two engines, not four.
    expect(maxLiveEngines(1.5 * GB)).toBeLessThan(MAX_LIVE_ENGINES);
    expect(maxLiveEngines(1.5 * GB)).toBeGreaterThanOrEqual(1);
  });

  test('more memory never means fewer engines', () => {
    let previous = 0;
    for (const gb of [0.5, 1, 1.5, 2, 3, 4, 6, 8, 16]) {
      const n = maxLiveEngines(gb * GB);
      expect(n).toBeGreaterThanOrEqual(previous);
      previous = n;
    }
  });

  test('the reserve is real — memory is not handed out down to the last byte', () => {
    // Whatever the per-engine budget is, some headroom is kept for Electron and the OS, so the
    // answer at N gigabytes is strictly fewer than N gigabytes divided by one engine.
    const naive = Math.floor((4 * GB) / (320 * 1024 * 1024));
    expect(maxLiveEngines(4 * GB)).toBeLessThan(naive);
  });
});
