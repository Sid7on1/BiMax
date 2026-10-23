import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import { createGitTool } from '../tools/implementations/git.tool';
import { setGitAutoCommitEnabled, gitAutoCommitHook } from '../tools/git.autocommit';
import { IGovernor } from '../core/interfaces';

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-git-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}
function lastLog(dir: string): string {
  try { return execFileSync('git', ['log', '--oneline', '-1'], { cwd: dir, encoding: 'utf-8' }).trim(); }
  catch { return ''; }
}

describe('GitTool (B1)', () => {
  let dir: string;
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('commits with a message and reports status', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    const tool = createGitTool(governor);

    const status = await tool.execute({ action: 'status' }, { cwd: dir });
    expect(status).toMatch(/untracked \?1|modified|On /);

    const res = await tool.execute({ action: 'commit', message: 'feat: add a.txt' }, { cwd: dir });
    expect(res).not.toMatch(/failed|Error/i);
    expect(lastLog(dir)).toContain('feat: add a.txt');
  });

  it('rejects commit without a message', async () => {
    const tool = createGitTool(governor);
    const res = await tool.execute({ action: 'commit', message: '  ' }, { cwd: dir });
    expect(res).toMatch(/requires a non-empty/);
  });

  it('errors politely outside a git repo', async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-norepo-'));
    const tool = createGitTool(governor);
    const res = await tool.execute({ action: 'status' }, { cwd: nonRepo });
    expect(res).toMatch(/not a git repository/);
    fs.rmSync(nonRepo, { recursive: true, force: true });
  });
});

describe('gitAutoCommitHook (B1)', () => {
  let dir: string;
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => { setGitAutoCommitEnabled(false); fs.rmSync(dir, { recursive: true, force: true }); });

  it('commits after an edit when enabled', async () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
    setGitAutoCommitEnabled(true);
    await gitAutoCommitHook('EditFileTool', { path: 'f.txt' }, 'Edited f.txt (1 replacement)', { cwd: dir });
    expect(lastLog(dir)).toContain('bimax auto: EditFileTool');
  });

  it('does nothing when disabled', async () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
    setGitAutoCommitEnabled(false);
    await gitAutoCommitHook('EditFileTool', { path: 'f.txt' }, 'Edited f.txt', { cwd: dir });
    expect(lastLog(dir)).not.toContain('bimax auto');
  });

  it('commits only the file the edit wrote, never the user\'s other uncommitted work', async () => {
    // It was `git add -A`: whatever the user was halfway through went into a "bimax auto" commit.
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'my own work in progress\n');
    setGitAutoCommitEnabled(true);
    await gitAutoCommitHook('EditFileTool', { path: 'f.txt' }, 'Edited f.txt (1 replacement)', { cwd: dir });
    expect(lastLog(dir)).toContain('bimax auto: EditFileTool f.txt');
    const committed = execSync('git show --name-only --format= HEAD', { cwd: dir }).toString().split('\n').filter(Boolean);
    expect(committed).toEqual(['f.txt']);
    // Untouched: not committed, and not even staged — the user's index is theirs.
    expect(execSync('git status --porcelain', { cwd: dir }).toString()).toContain('?? mine.txt');
  });

  it('leaves what the user had already staged staged, not committed', async () => {
    fs.writeFileSync(path.join(dir, 'staged.txt'), 'ready for my own commit\n');
    execSync('git add staged.txt', { cwd: dir });
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
    setGitAutoCommitEnabled(true);
    await gitAutoCommitHook('EditFileTool', { path: 'f.txt' }, 'Edited f.txt', { cwd: dir });
    const committed = execSync('git show --name-only --format= HEAD', { cwd: dir }).toString().split('\n').filter(Boolean);
    expect(committed).toEqual(['f.txt']);
    expect(execSync('git status --porcelain', { cwd: dir }).toString()).toContain('A  staged.txt');
  });

  it('commits every file a multi-file edit wrote', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    setGitAutoCommitEnabled(true);
    await gitAutoCommitHook('MultiEditTool', { edits: [{ path: 'a.txt' }, { path: 'b.txt' }, { path: 'a.txt' }] }, 'Applied 3 edits', { cwd: dir });
    const committed = execSync('git show --name-only --format= HEAD', { cwd: dir }).toString().split('\n').filter(Boolean).sort();
    expect(committed).toEqual(['a.txt', 'b.txt']);
  });

  it('skips when the edit result indicates failure', async () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
    setGitAutoCommitEnabled(true);
    await gitAutoCommitHook('EditFileTool', { path: 'f.txt' }, 'Edit to f.txt rejected by user. No changes were made.', { cwd: dir });
    expect(lastLog(dir)).not.toContain('bimax auto');
  });
});
