import { underForbiddenPath } from '../governor/fs.veto';
import { SafetyPolicy } from '../governor/policy.engine';

/**
 * The forbidden-path rule matched substrings, so '/var' refused every edit in ~/Documents/various and '/system' every
 * edit in ~/code/system-design (found 2026-09-21). It now matches whole path segments.
 */
const refused = (file: string) => SafetyPolicy.forbiddenPaths.some((entry) => underForbiddenPath(file, entry));

test('system folders and .ssh are still refused, under any spelling macOS resolves them to', () => {
  for (const file of ['/etc/hosts', '/private/etc/hosts', '/var/log/system.log', '/private/var/folders/x/T/a.txt',
    '/System/Library/CoreServices/a', '/root/.bashrc', '/proc/1/status', '/Users/me/.ssh/config', '/Users/me/.ssh', '/var']) {
    expect([file, refused(file)]).toEqual([file, true]);
  }
});

test('a folder whose name only starts with a forbidden name is not refused', () => {
  for (const file of ['/Users/me/Documents/various/notes.md', '/Users/me/code/system-design/README.md', '/Users/me/variables.ts',
    '/Users/me/projects/etcetera/a.js', '/Users/me/rooted/a.txt', '/Users/me/process/a.txt', '/Users/me/.sshkeys-backup.txt']) {
    expect([file, refused(file)]).toEqual([file, false]);
  }
});
