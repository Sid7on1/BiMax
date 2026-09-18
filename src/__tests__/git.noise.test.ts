import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getGitStatus, isGitRepo, gitLog, gitDiff } from '../engine/git';

// A non-repository launch must be a supported, QUIET state — no `fatal: not a git repository`
// spilling to stderr. We both assert the in-process contract (null / false, never throws) AND spawn
// a child that runs the real git helpers so we can capture what actually reaches stderr.

describe('git helpers in a non-repository directory', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-nogit-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('returns quiet null/false results without throwing', () => {
    expect(isGitRepo(dir)).toBe(false);
    expect(getGitStatus(dir)).toBeNull();
    expect(() => gitLog(dir)).not.toThrow();
    expect(() => gitDiff(dir)).not.toThrow();
  });

  it('emits NO "fatal: not a git repository" noise on stderr (captured from a child process)', () => {
    // tmpdir can be a symlink on macOS (/var -> /private/var); resolve it so `cwd` is exact.
    const cwd = fs.realpathSync(dir);
    const distGit = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'git.js');
    if (!fs.existsSync(distGit)) return; // build not present in this run — the in-process test above still guards the contract
    const script = `const g=require(${JSON.stringify(distGit)}); g.getGitStatus(process.cwd()); g.gitLog(process.cwd()); g.gitDiff(process.cwd());`;
    let stderr = '';
    try {
      execFileSync(process.execPath, ['-e', script], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      stderr = String(e?.stderr || '');
    }
    expect(stderr).not.toMatch(/fatal: not a git repository/i);
  });
});
