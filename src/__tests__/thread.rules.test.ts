import * as fs from 'fs';
import * as path from 'path';
import { folderRulesSection, protectedPaths, protectedTouchedBy } from '../tools/thread.rules';
import { planFileChange, planShellChange } from '../tools/thread.changes';

/** Folder rules from the Bimax app: the words reach the prompt, and protected items are enforced, not requested. */
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.thread-rules-test-'));
  fs.mkdirSync(path.join(root, 'DEV'));
  fs.mkdirSync(path.join(root, 'api keys'));
  fs.writeFileSync(path.join(root, 'DEV', 'app.ts'), 'x');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
  process.env.BIMAX_THREAD_PROTECTED = JSON.stringify([path.join(root, 'DEV'), path.join(root, 'api keys')]);
  process.env.BIMAX_THREAD_RULES = 'Ask before renaming anything.';
});
afterEach(() => {
  delete process.env.BIMAX_THREAD_PROTECTED;
  delete process.env.BIMAX_THREAD_RULES;
  fs.rmSync(root, { recursive: true, force: true });
});

test('the prompt carries the rules in the user’s words and names every protected item', () => {
  const section = folderRulesSection(root);
  expect(section).toContain('Ask before renaming anything.');
  expect(section).toContain('- DEV');
  expect(section).toContain('- api keys');
});

test('a change touching a protected item, or the folder holding one, is caught; everything else is not', () => {
  const guarded = protectedPaths();
  const shell = (command: string) => protectedTouchedBy(planShellChange(command, root, root), command, guarded, root);
  expect(shell('mv DEV 2026-09-13_DEV')).toBe(path.join(root, 'DEV'));
  expect(shell('rm DEV/app.ts')).toBe(path.join(root, 'DEV'));
  expect(shell("sed -i '' s/a/b/ DEV/app.ts")).toBe(path.join(root, 'DEV'));
  expect(protectedTouchedBy(planFileChange('FILE_WRITE', { tool: 'WriteFileTool', targetPath: path.join(root, 'api keys', 'new.txt') }, root, root), '', guarded, root)).toBe(path.join(root, 'api keys'));
  expect(shell('mv notes.txt notes-old.txt')).toBeNull();
  expect(shell('ls DEV')).toBeNull();
  if (process.platform === 'darwin') {
    expect(shell('mv dev old-dev')).toBe(path.join(root, 'DEV'));
    expect(shell("sed -i '' s/a/b/ Dev/app.ts")).toBe(path.join(root, 'DEV'));
  }
});
