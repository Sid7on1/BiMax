import { MAX_LINK_PROMPT, linkConfirmation, parseTaskLink } from '../main/bimax.link';

/**
 * Backlog N2: `bimax://task` links start a ⌘2 task in a folder, with a prompt, only after the person confirms it.
 */

const HOME = '/Users/me';

test('a task link gives its folder and prompt; ~ is the home folder, and both URL forms work', () => {
  expect(parseTaskLink('bimax://task?folder=/Users/me/Downloads&prompt=Sort%20the%20PDFs%20by%20month', HOME))
    .toEqual({ ok: true, folder: '/Users/me/Downloads', prompt: 'Sort the PDFs by month' });
  expect(parseTaskLink('bimax:task?folder=~/Desktop', HOME)).toEqual({ ok: true, folder: '/Users/me/Desktop', prompt: '' });
  expect(parseTaskLink('bimax://task?folder=~/Projects/../Downloads&prompt=hi', HOME)).toMatchObject({ ok: true, folder: '/Users/me/Downloads' });
  // A folder with spaces and a prompt over several lines are ordinary, not control characters.
  expect(parseTaskLink('bimax://task?folder=/Users/me/My%20Files&prompt=First%0ASecond%09tabbed', HOME))
    .toEqual({ ok: true, folder: '/Users/me/My Files', prompt: 'First\nSecond\ttabbed' });
});

test('anything that is not a task in a specific folder is refused with a reason', () => {
  const refused = (raw: string) => {
    const link = parseTaskLink(raw, HOME);
    return link.ok ? 'ACCEPTED' : link.error;
  };
  expect(refused('https://task?folder=/tmp')).toContain('not a Bimax link');
  expect(refused('bimax://run?folder=/tmp&prompt=rm')).toContain('can only start a task');
  expect(refused('bimax://task?prompt=hello')).toContain('which folder');
  expect(refused('bimax://task?folder=Downloads')).toContain('full path');
  expect(refused('bimax://task?folder=~')).toContain('whole home folder');
  expect(refused('bimax://task?folder=/')).toContain('whole home folder');
  expect(refused(`bimax://task?folder=/tmp/x&prompt=${'a'.repeat(MAX_LINK_PROMPT + 1)}`)).toContain('longer than');
  expect(refused('bimax://task?folder=/tmp/x&prompt=hi%1Bthere')).toContain('control characters');
  expect(refused('not a link')).toContain('not a valid link');
});

test('parameters other than folder and prompt are ignored, never acted on', () => {
  expect(parseTaskLink('bimax://task?folder=/tmp/x&prompt=Tidy&approve=all&model=anything&run=now', HOME))
    .toEqual({ ok: true, folder: '/tmp/x', prompt: 'Tidy' });
});

test('the confirmation shows the whole prompt and folder, and Cancel is the default and the Escape answer', () => {
  const { options, startIndex } = linkConfirmation('/Users/me/Downloads', 'Sort the PDFs by month');
  expect(options.buttons[startIndex]).toBe('Start');
  expect(options.defaultId).not.toBe(startIndex);
  expect(options.buttons[options.defaultId]).toBe('Cancel');
  expect(options.buttons[options.cancelId]).toBe('Cancel');
  expect(options.message).toBe('Start a task in “Downloads”?');
  expect(options.detail).toContain('Folder: /Users/me/Downloads');
  expect(options.detail).toContain('Prompt:\nSort the PDFs by month');
  expect(options.detail).toContain('Nothing runs until you click Start');
  expect(linkConfirmation('/Users/me/Downloads', '').options.message).toBe('Open a new ⌘2 task in “Downloads”?');
});
