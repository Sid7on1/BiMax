import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { insideFolder, parseBrowserOutput, parseFinderOutput, validAttachments, withContext } from '../main/quick.context';

/** What the person had open, or dropped on the ⌘2 bar, reaches the task as context — checked and described plainly. */
test('Finder output gives the folder first and the selected items after it', () => {
  expect(parseFinderOutput('/Users/me/Desktop/\n/Users/me/Desktop/a.pdf\n/Users/me/Desktop/DEV/\n')).toEqual({
    folder: '/Users/me/Desktop/', selection: ['/Users/me/Desktop/a.pdf', '/Users/me/Desktop/DEV/'],
  });
  expect(parseFinderOutput('\n/Users/me/x.txt')).toEqual({ folder: null, selection: ['/Users/me/x.txt'] });
  expect(parseFinderOutput('')).toEqual({ folder: null, selection: [] });
});

test('a browser page needs a real http(s) URL', () => {
  expect(parseBrowserOutput('https://example.com/a\nExample page\n')).toEqual({ url: 'https://example.com/a', title: 'Example page' });
  expect(parseBrowserOutput('favorites://\nFavourites')).toBeNull();
  expect(parseBrowserOutput('')).toBeNull();
});

test('the engine gets the context before the words; the words are unchanged', () => {
  const text = withContext('summarise these', [
    { kind: 'file', label: 'a.pdf', path: '/Users/me/Desktop/a.pdf' },
    { kind: 'page', label: 'Example', url: 'https://example.com' },
  ]);
  expect(text).toContain('- /Users/me/Desktop/a.pdf');
  expect(text).toContain('“Example” <https://example.com>');
  expect(text.endsWith('\n\nsummarise these')).toBe(true);
  expect(withContext('hi', [])).toBe('hi');
});

test('attachments from the bar are re-checked; a folder contains itself and its children only', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quick-context-')));
  const file = path.join(dir, 'notes.txt');
  fs.writeFileSync(file, 'x');
  try {
    const checked = await validAttachments([
      { kind: 'file', label: 'whatever', path: file },
      { kind: 'file', label: 'gone', path: path.join(dir, 'missing.txt') },
      { kind: 'page', label: '', url: 'javascript:alert(1)' },
      { kind: 'page', label: 'Docs', url: 'https://example.com/docs' },
      { kind: 'script', path: file },
      'nonsense',
    ]);
    expect(checked).toEqual([{ kind: 'file', label: 'notes.txt', path: file }, { kind: 'page', label: 'Docs', url: 'https://example.com/docs' }]);
    expect(insideFolder(dir, file)).toBe(true);
    expect(insideFolder(dir, dir)).toBe(true);
    expect(insideFolder(dir, path.dirname(dir))).toBe(false);
    expect(insideFolder(dir, `${dir}-sibling/x`)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
