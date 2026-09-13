import { cleanRules, rulesEnvironment } from '../main/folder.rules';

test('folder rules keep their text and only protect real paths inside the folder', () => {
  const rules = cleanRules('/Users/me/Desktop', {
    text: '  Never rename anything in DEV.  ',
    protect: ['/Users/me/Desktop/DEV', '/Users/me/Desktop/DEV', '/Users/me/Desktop', '/Users/me/Documents/tax', 'relative/path', 42],
  });
  expect(rules).toEqual({ text: 'Never rename anything in DEV.', protect: ['/Users/me/Desktop/DEV'] });
  expect(cleanRules('/x', null)).toEqual({ text: '', protect: [] });
});

test('the engine gets the rules through its environment, and nothing when there are none', () => {
  expect(rulesEnvironment({ text: 'Ask first.', protect: ['/x/DEV'] })).toEqual({ BIMAX_THREAD_RULES: 'Ask first.', BIMAX_THREAD_PROTECTED: '["/x/DEV"]' });
  expect(rulesEnvironment({ text: '', protect: [] })).toEqual({});
  expect(rulesEnvironment(undefined)).toEqual({});
});
