import fs from 'node:fs';
import path from 'node:path';
import { copyText } from '../renderer/src/copy.text';

/**
 * Every Copy button did nothing (owner report, 2026-09-30). They called `navigator.clipboard.writeText`, which needs a
 * permission the app refuses to every page (security.ts isAllowedPermission is false, and must stay so), so the call
 * rejected, nobody caught it, and nothing was copied or said. Copying now goes through the app's own channel.
 */

const global_ = globalThis as unknown as { window?: unknown };
afterEach(() => { delete global_.window; });

test('copyText writes through the app and says true only when the text is on the clipboard', async () => {
  const writeText = jest.fn(async () => true);
  global_.window = { bimax: { clipboard: { writeText } } };
  await expect(copyText('npm test')).resolves.toBe(true);
  expect(writeText).toHaveBeenCalledWith('npm test');

  global_.window = { bimax: { clipboard: { writeText: async () => false } } };
  await expect(copyText('refused')).resolves.toBe(false);
  global_.window = { bimax: { clipboard: { writeText: async () => { throw new Error('no channel'); } } } };
  await expect(copyText('broken')).resolves.toBe(false);
  // A renderer bundle running against an older main process has no clipboard bridge at all.
  global_.window = { bimax: {} };
  await expect(copyText('old main')).resolves.toBe(false);
});

test('no renderer code writes the clipboard through the page API, which the app refuses', () => {
  const roots = ['../renderer', '../phase9'].map((dir) => path.join(__dirname, dir));
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(entry.name) && !full.endsWith('copy.text.ts')
        && /navigator\.clipboard\.write/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(path.join(__dirname, '..'), full));
    }
  };
  for (const root of roots) if (fs.existsSync(root)) walk(root);
  expect(offenders).toEqual([]);
});

test('the main process answers the copy channel, and the ⌘2 bar, which shows code blocks, may use it', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main/index.ts'), 'utf8');
  expect(main).toMatch(/secureHandle\('clipboard:write-text'/);
  const barChannels = main.slice(main.indexOf('event.sender.id === quickWindow?.webContents.id'), main.indexOf(': event.sender.id === organizeWebContentsId()'));
  expect(barChannels).toContain("'clipboard:write-text'");
});
