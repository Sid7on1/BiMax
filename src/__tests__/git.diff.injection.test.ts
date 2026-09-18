import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { gitDiff, gitLog } from '../engine/git';

// Security regression: gitDiff/gitLog used to build a shell string with the caller's value
// interpolated (`git diff -- "${file}"`). GitTool feeds `file` straight from the model's `paths`
// argument, so a crafted path like `x"; touch PWNED #` achieved arbitrary command execution,
// bypassing the Bash sandbox. Both now run through execFile with an argv array (no shell).
describe('git diff/log are not shell-injectable via a model-supplied path', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-gitinj-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a malicious pathspec does NOT execute a command', () => {
    const marker = path.join(dir, 'PWNED');
    // Was: `git diff -- "a.txt"; touch PWNED #"` → the touch would run. With execFile it's a
    // single (nonexistent) pathspec, so git just returns nothing and the marker is never created.
    gitDiff(dir, `a.txt"; touch "${marker}`);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('gitLog tolerates a non-integer count without a shell', () => {
    const out = gitLog(dir, '5; touch PWNED2' as unknown as number);
    expect(fs.existsSync(path.join(dir, 'PWNED2'))).toBe(false);
    expect(out).toContain('init'); // still returns the real log
  });
});
