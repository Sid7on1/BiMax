import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HISTORY_DAYS, SpendLedger } from '../governor/spend.ledger';
import { SafetyPolicy, configuredSpend } from '../governor/policy.engine';
import { numberSetting } from '../../app/src/renderer/src/components/SettingsDialog';

/**
 * Backlog N6: cost per task, per model and per day, and the limits in Settings. The ledger knew today's total and
 * each task's share; it forgot every day at midnight and never knew which model the money went to.
 */

const ledgerAt = (clock: { now: number }) => new SpendLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-spend-history-')), 'spend.json'), () => clock.now);
const DAY = 24 * 60 * 60 * 1000;

test('cost is kept by model, and a day that ends goes to the history instead of being forgotten', () => {
  const clock = { now: Date.UTC(2026, 8, 20, 10) };
  const ledger = ledgerAt(clock);
  ledger.recordSettled(0.30, 'thread-a', 'openai/gpt-oss-20b');
  ledger.recordSettled(0.05, 'thread-b', 'openai/gpt-oss-20b');
  ledger.recordSettled(1.10, 'thread-a', 'anthropic/claude-sonnet-5');
  expect(ledger.summary().models).toEqual([
    { model: 'anthropic/claude-sonnet-5', spent: 1.10 },
    { model: 'openai/gpt-oss-20b', spent: expect.closeTo(0.35, 10) },
  ]);

  clock.now += DAY;
  ledger.recordSettled(0.20, 'thread-a', 'openai/gpt-oss-20b');
  const { models, days } = ledger.summary();
  expect(models).toEqual([{ model: 'openai/gpt-oss-20b', spent: 0.20 }]);
  expect(days).toHaveLength(1);
  expect(days[0]).toMatchObject({ date: '2026-09-20', total: expect.closeTo(1.45, 10), scopes: { 'thread-a': expect.closeTo(1.40, 10) } });
  expect(ledger.read().total).toBeCloseTo(0.20, 10);
});

test(`history keeps ${HISTORY_DAYS} days, newest first, and skips days that spent nothing`, () => {
  const clock = { now: Date.UTC(2026, 7, 1, 10) };
  const ledger = ledgerAt(clock);
  for (let d = 0; d < HISTORY_DAYS + 5; d++) {
    // A recent day is opened (an engine read the ledger) but nothing is spent: it must not become a $0 history row.
    if (d === HISTORY_DAYS + 2) ledger.read(); else ledger.recordSettled(0.01 * (d + 1), 't', 'm');
    clock.now += DAY;
  }
  ledger.read();
  const days = ledger.summary().days;
  expect(days).toHaveLength(HISTORY_DAYS);
  expect(days[0].date > days[1].date).toBe(true);
  expect(days.some((day) => day.total === 0)).toBe(false);
});

test('a ledger written before N6 is read without losing its totals', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-spend-old-')), 'spend.json');
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(file, JSON.stringify({ version: 1, date, total: 2.5, scopes: { a: 2.5 } }));
  const ledger = new SpendLedger(file);
  expect(ledger.read('a')).toMatchObject({ total: 2.5, scopeTotal: 2.5 });
  expect(ledger.summary()).toEqual({ models: [], days: [] });
});

describe('the limits in Settings', () => {
  const config = require('../engine/config') as typeof import('../engine/config');
  let spy: jest.SpyInstance;
  const set = (values: Record<string, unknown>) => { spy = jest.spyOn(config, 'getConfig').mockReturnValue(values as any); };
  afterEach(() => { spy?.mockRestore(); delete process.env.MAX_DAILY_SPEND; });

  test('a cap set in Settings wins over MAX_DAILY_SPEND; unset, the environment and then $5 decide', () => {
    process.env.MAX_DAILY_SPEND = '20';
    set({ spendDailyCapUsd: 3 });
    expect(SafetyPolicy.maxDailySpendUsd).toBe(3);
    spy.mockRestore();
    set({ spendDailyCapUsd: null });
    expect(SafetyPolicy.maxDailySpendUsd).toBe(20);
    delete process.env.MAX_DAILY_SPEND;
    expect(SafetyPolicy.maxDailySpendUsd).toBe(5);
  });

  test('a cleared spending field is unset, never 0 — 0 would silently mean "no cap"', () => {
    expect(numberSetting('', true)).toBeNull();
    expect(numberSetting('', false)).toBe(0);
    expect(numberSetting('7.5', true)).toBe(7.5);
    set({ spendTaskShareUsd: null });
    expect(configuredSpend('spendTaskShareUsd')).toBeUndefined();
    spy.mockRestore();
    set({ spendTaskShareUsd: 0 });
    expect(configuredSpend('spendTaskShareUsd')).toBe(0);
  });
});
