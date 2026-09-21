import { shouldSpeakUpdate, spokenUpdate } from '../main/spoken.updates';

/** Backlog N9: "Your Downloads cleanup is done, 6 GB freed." */

test('the line names the task, says how it ended, and gives the first sentence of the answer', () => {
  expect(spokenUpdate({ title: 'Tidy Downloads', outcome: 'completed' }, '**Moved 30 files** and freed 6 GB.\n\n- a.pdf\n- b.pdf'))
    .toBe('Tidy Downloads is done. Moved 30 files and freed 6 GB.');
  expect(spokenUpdate({ title: 'Fix tests', outcome: 'completed', check: 'failed' }, '')).toBe('Fix tests finished, but its check failed.');
  expect(spokenUpdate({ title: 'Migrate', outcome: 'time-limit' }, 'Got halfway.')).toBe('Migrate stopped at its time limit. Got halfway.');
  expect(spokenUpdate({ title: 'Build', outcome: 'failed' }, '')).toBe('Build failed.');
  expect(spokenUpdate({ title: 'Build', outcome: 'interrupted' }, '')).toBe('Build was interrupted.');
  expect(spokenUpdate({ title: '  ' }, '')).toBe('A task is done.');
});

test('a long answer is cut at a sentence, well short of a speech', () => {
  const said = spokenUpdate({ title: 'Report' }, `${'The numbers changed a little today. '.repeat(10)}`);
  expect(said.length).toBeLessThan(180);
  expect(said.endsWith('today.')).toBe(true);
});

test('only when turned on, not on screen, and not over talk mode or listening', () => {
  const base = { enabled: true, onScreen: false, talking: false, listening: false };
  expect(shouldSpeakUpdate(base)).toBe(true);
  expect(shouldSpeakUpdate({ ...base, enabled: false })).toBe(false);
  expect(shouldSpeakUpdate({ ...base, onScreen: true })).toBe(false);
  expect(shouldSpeakUpdate({ ...base, talking: true })).toBe(false);
  expect(shouldSpeakUpdate({ ...base, listening: true })).toBe(false);
});
