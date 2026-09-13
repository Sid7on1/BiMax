import { describeSchedule, dueSchedules, newSchedule, nextRun } from '../main/schedules';

// September 2026: the 18th and 25th are Fridays.
const at = (day: number, hour: number, minute = 0): number => new Date(2026, 8, day, hour, minute).getTime();
const weekly = newSchedule({ id: 's', title: 'Clear old Downloads', root: '/x', prompt: 'move Downloads older than 30 days to the Bin', cadence: 'weekly', now: new Date(2026, 8, 18, 17, 0) });

test('a weekly schedule repeats on the weekday and at the time it was made', () => {
  expect(describeSchedule(weekly)).toBe('Every Friday at 17:00');
  expect(nextRun(weekly, weekly.createdAt)).toBe(at(25, 17));
});

test('weekdays skip the weekend; daily does not', () => {
  expect(nextRun({ ...weekly, cadence: 'weekdays' }, at(18, 17))).toBe(at(21, 17));
  expect(nextRun({ ...weekly, cadence: 'daily' }, at(18, 17))).toBe(at(19, 17));
  expect(describeSchedule({ ...weekly, cadence: 'weekdays', hour: 8, minute: 5 })).toBe('Every weekday at 08:05');
});

test('a run is due at its time; one missed by under a day still runs; older misses are skipped', () => {
  const ranLastFriday = { ...weekly, lastRunAt: at(18, 17) };
  expect(dueSchedules([ranLastFriday], at(25, 16, 59)).due).toEqual([]);
  expect(dueSchedules([ranLastFriday], at(25, 17)).due).toEqual([ranLastFriday]);
  expect(dueSchedules([ranLastFriday], at(26, 9)).due).toEqual([ranLastFriday]);
  expect(dueSchedules([ranLastFriday], at(28, 9))).toEqual({ due: [], skipped: [ranLastFriday] });
  expect(dueSchedules([{ ...ranLastFriday, enabled: false }], at(25, 17))).toEqual({ due: [], skipped: [] });
});
