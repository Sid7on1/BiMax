import { shouldSubmitQuickPrompt } from '../renderer/src/quick.submit';

test('the ⌘2 bar keeps the main composer’s Enter, ⌘↩ and Ctrl+↩ send shortcuts', () => {
  expect(shouldSubmitQuickPrompt({ key: 'Enter', shiftKey: false })).toBe(true);
  expect(shouldSubmitQuickPrompt({ key: 'Enter', shiftKey: false, metaKey: true })).toBe(true);
  expect(shouldSubmitQuickPrompt({ key: 'Enter', shiftKey: false, ctrlKey: true })).toBe(true);
  expect(shouldSubmitQuickPrompt({ key: 'Enter', shiftKey: true })).toBe(false);
  expect(shouldSubmitQuickPrompt({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
  expect(shouldSubmitQuickPrompt({ key: 'a', shiftKey: false })).toBe(false);
});
