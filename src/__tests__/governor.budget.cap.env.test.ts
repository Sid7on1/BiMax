/**
 * The daily spend cap must be read LAZILY.
 *
 * `maxDailySpendUsd: parseFloat(process.env.MAX_DAILY_SPEND || '5.00')` as an object initializer
 * runs when the module is first imported, and imports are hoisted — so it ran before
 * `loadGlobalEnv()` at index.ts:20 had read ~/.breakglass/.env. The variable was always undefined
 * at that moment, the cap was always $5.00, and the veto's own advice ("raise it via
 * MAX_DAILY_SPEND") could not be followed through the documented file.
 *
 * Measured 2026-08-18: MAX_DAILY_SPEND=1000000 written to .env, engine started AFTER the write,
 * governor still loaded "$5.07 / $5.00" and vetoed the turn.
 */
import { SafetyPolicy } from '../governor/policy.engine';

const original = process.env.MAX_DAILY_SPEND;
afterEach(() => {
  if (original === undefined) delete process.env.MAX_DAILY_SPEND;
  else process.env.MAX_DAILY_SPEND = original;
  // Clear any policy.json-style override left by a test.
  SafetyPolicy.maxDailySpendUsd = undefined as unknown as number;
});

describe('daily spend cap', () => {
  it('reflects an env var set AFTER this module was imported', () => {
    process.env.MAX_DAILY_SPEND = '1000000';
    expect(SafetyPolicy.maxDailySpendUsd).toBe(1_000_000);
  });

  it('falls back to $5.00 when unset', () => {
    delete process.env.MAX_DAILY_SPEND;
    expect(SafetyPolicy.maxDailySpendUsd).toBe(5.00);
  });

  it('falls back to $5.00 rather than NaN on unparseable input', () => {
    process.env.MAX_DAILY_SPEND = 'lots';
    expect(SafetyPolicy.maxDailySpendUsd).toBe(5.00);
  });

  it('still lets policy.json override the environment', () => {
    process.env.MAX_DAILY_SPEND = '1000000';
    SafetyPolicy.maxDailySpendUsd = 12.5;
    expect(SafetyPolicy.maxDailySpendUsd).toBe(12.5);
  });

  it('a raised cap no longer vetoes the spend that blocked the live run', () => {
    process.env.MAX_DAILY_SPEND = '1000000';
    expect(5.07 > SafetyPolicy.maxDailySpendUsd).toBe(false);
  });
});
