import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commonFolder, installQuickAction, openedFilesContext, quickActionFiles, quickActionPath } from '../main/finder.action';

/** Backlog N3: Finder's "Ask Bimax" Quick Action opens the ⌘2 bar with the selected files attached. */

let home: string;
beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-n3-'))); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
const make = (relative: string, folder = false): string => {
  const full = path.join(home, relative);
  fs.mkdirSync(folder ? full : path.dirname(full), { recursive: true });
  if (!folder) fs.writeFileSync(full, 'x');
  return full;
};

test('the workflow is a Finder service for any item that hands them to Bimax', () => {
  const files = quickActionFiles('ai.bimax.app');
  const info = files['Contents/Info.plist']!;
  const document = files['Contents/document.wflow']!;
  expect(info).toContain('<string>com.apple.finder</string>');
  expect(info).toContain('<key>NSSendFileTypes</key><array><string>public.item</string></array>');
  expect(info).toContain('<key>NSMenuItem</key><dict><key>default</key><string>Ask Bimax</string></dict>');
  expect(document).toContain('<string>/usr/bin/open -b ai.bimax.app &quot;$@&quot;\n</string>');
  expect(document).toContain('<key>inputMethod</key><integer>1</integer>');
  expect(document).toContain('<string>com.apple.Automator.servicesMenu</string>');
});

(process.platform === 'darwin' ? test : test.skip)('macOS reads both files as property lists', () => {
  const dir = path.join(home, 'w');
  for (const [relative, content] of Object.entries(quickActionFiles('ai.bimax.app'))) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
  }
  const read = (file: string, key: string): string => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(dir, file)], { encoding: 'utf8' }).replace(/\n$/, ''); // plutil ends its output with a newline
  expect(read('Contents/document.wflow', 'actions.0.action.ActionParameters.COMMAND_STRING')).toBe('/usr/bin/open -b ai.bimax.app "$@"\n');
  expect(read('Contents/Info.plist', 'NSServices.0.NSMessage')).toBe('runWorkflowAsService');
});

test('a bundle id that could break out of the shell command is refused', () => {
  expect(() => quickActionFiles('ai.bimax.app"; rm -rf ~; "')).toThrow('Not a bundle id');
  expect(() => quickActionFiles('ai.bimax.app $(id)')).toThrow('Not a bundle id');
  expect(() => quickActionFiles('bimax')).toThrow('Not a bundle id');
});

test('the shared folder of several items', () => {
  expect(commonFolder(['/a/b/c.txt', '/a/b/d.txt'])).toBe('/a/b');
  expect(commonFolder(['/a/b/c.txt', '/a/bb/d.txt'])).toBe('/a');
  expect(commonFolder(['/a/b/c/x.txt', '/a/b/y.txt'])).toBe('/a/b');
  expect(commonFolder(['/x.txt', '/a/y.txt'])).toBe('/');
});

test('one folder becomes the task’s folder; files are attached in theirs', async () => {
  const folder = make('work/invoices', true);
  expect(await openedFilesContext([folder], home)).toEqual({ root: folder, source: 'Finder Quick Action' });
  const a = make('work/invoices/a.pdf');
  const b = make('work/invoices/2026/b.pdf');
  expect(await openedFilesContext([a, b, a], home)).toEqual({
    root: folder, source: 'Finder Quick Action',
    attachments: [{ kind: 'file', label: 'a.pdf', path: a }, { kind: 'file', label: 'b.pdf', path: b }],
  });
});

test('items spread across the home folder make the person choose; vanished items are dropped', async () => {
  const a = make('one/a.txt');
  const b = make('two/b.txt');
  const context = await openedFilesContext([a, b, path.join(home, 'gone.txt')], home);
  expect(context.root).toBeNull();
  expect(context.error).toMatch(/Choose the folder/);
  expect(context.attachments?.map((item) => item.label)).toEqual(['a.txt', 'b.txt']);
  expect(await openedFilesContext([path.join(home, 'gone.txt')], home)).toMatchObject({ root: null, error: expect.stringMatching(/no longer there/) });
});

test('installing writes the bundle once and never overwrites one already there', async () => {
  const first = await installQuickAction(home, 'ai.bimax.app');
  expect(first).toEqual({ path: quickActionPath(home), added: true });
  expect(fs.readFileSync(path.join(first.path, 'Contents/Info.plist'), 'utf8')).toContain('Ask Bimax');
  expect(fs.readdirSync(path.dirname(first.path))).toEqual(['Ask Bimax.workflow']);
  fs.writeFileSync(path.join(first.path, 'Contents/document.wflow'), 'my own edit');
  expect(await installQuickAction(home, 'ai.bimax.app')).toEqual({ path: first.path, added: false });
  expect(fs.readFileSync(path.join(first.path, 'Contents/document.wflow'), 'utf8')).toBe('my own edit');
});

test('at most 50 items are attached', async () => {
  const many = Array.from({ length: 60 }, (_, i) => make(`work/f${i}.txt`));
  expect((await openedFilesContext(many, home)).attachments).toHaveLength(50);
});
