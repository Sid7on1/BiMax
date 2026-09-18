import { execSync, execFileSync } from 'child_process';

/**
 * True if `cwd` is inside a git work tree. Unlike getGitStatus, this works on a freshly
 * `git init`-ed repo with no commits yet (unborn HEAD), so it's the right repo-existence
 * check for the GitTool / auto-commit.
 */
export function isGitRepo(cwd: string): boolean {
  try {
    return execSync('git rev-parse --is-inside-work-tree', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim() === 'true';
  } catch {
    return false;
  }
}

export interface GitStatus {
  branch: string;
  modified: string[];
  added: string[];
  deleted: string[];
  unstaged: string[];
  ahead: number;
  behind: number;
}

export function getGitStatus(cwd: string): GitStatus | null {
  // Repo detection first: a non-repo directory is a supported, QUIET state. Without this guard the
  // status calls below spill `fatal: not a git repository` to the engine's stderr on every snapshot
  // build (the non-repo launch noise). isGitRepo already silences its own stderr.
  if (!isGitRepo(cwd)) return null;
  try {
    // stderr is silenced ('ignore') so a transient git error (detached HEAD mid-rebase, unborn HEAD)
    // never leaks a `fatal:` line to the terminal — we handle failure via the null return instead.
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    const statusOut = execSync('git status --porcelain', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    const modified: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];
    const unstaged: string[] = [];
    for (const line of statusOut.split('\n').filter(Boolean)) {
      const staged = line[0];
      const file = line.slice(3);
      if (staged === 'M') modified.push(file);
      else if (staged === 'A') added.push(file);
      else if (staged === 'D') deleted.push(file);
      else if (line[1] !== ' ') unstaged.push(file);
    }
    // Ahead/behind only exist when the branch has an upstream; a local-only repo has none,
    // so isolate this lookup — its failure must not void the whole status.
    let ahead = 0, behind = 0;
    try {
      const branchOut = execSync('git rev-list --left-right --count HEAD...@{upstream}', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      if (branchOut.includes('\t')) [ahead, behind] = branchOut.split('\t').map(Number);
    } catch { /* no upstream — leave ahead/behind at 0 */ }
    return { branch, modified, added, deleted, unstaged, ahead, behind };
  } catch { return null; }
}

export function gitLog(cwd: string, count = 10): string {
  try {
    // execFile (argv array, no shell): a non-integer `count` can't inject shell metacharacters.
    const n = Math.max(1, Math.floor(Number(count) || 10));
    return execFileSync('git', ['log', '--oneline', `-${n}`], { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch { return '(not a git repo)'; }
}

export function gitDiff(cwd: string, file?: string): string {
  try {
    // execFile with an argv array — NOT a shell string — so a model-supplied `file` (GitTool's
    // `paths` arg) can't break out of the quoting and inject a command (`x"; rm -rf ~ #`). The
    // pathspec is passed as a discrete argv element, shell-metacharacter-safe by construction.
    const args = file ? ['diff', '--', file] : ['diff'];
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch { return '(diff failed)'; }
}
