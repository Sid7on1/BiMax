import { remember, stepHistory } from '../renderer/src/quick.history';

test('prompts are remembered newest last, without repeats or blanks', () => {
  let history: string[] = [];
  history = remember(history, 'list files');
  history = remember(history, '  ');
  history = remember(history, 'sort by date');
  history = remember(history, 'list files');
  expect(history).toEqual(['sort by date', 'list files']);
});

test('↑ walks back through earlier prompts and ↓ returns to what was being typed', () => {
  const history = ['first', 'second', 'third'];
  let step = stepHistory(history, null, 'back', 'draft');
  expect(step).toEqual({ cursor: 2, text: 'third' });
  step = stepHistory(history, step.cursor, 'back', 'draft');
  expect(step).toEqual({ cursor: 1, text: 'second' });
  step = stepHistory(history, 0, 'back', 'draft');
  expect(step).toEqual({ cursor: 0, text: 'first' });
  step = stepHistory(history, 1, 'forward', 'draft');
  expect(step).toEqual({ cursor: 2, text: 'third' });
  expect(stepHistory(history, 2, 'forward', 'draft')).toEqual({ cursor: null, text: 'draft' });
  expect(stepHistory([], null, 'back', 'draft')).toEqual({ cursor: null, text: 'draft' });
});
