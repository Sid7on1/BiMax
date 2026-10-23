import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  briefing, budgetNote, MAX_CONTINUATIONS, NIGHT_DONE, nightBranch, nightBudget, nightContinue, nightDeadline, nightNext, nightWords, spentBy, worktreeCommand,
} from '../main/night.shift';

/** Backlog FL5: "Work on this migration tonight, at most $12, a reviewable branch by morning." */

const at = (h: number, m = 0): number => new Date(2026, 8, 22, h, m).getTime();

test('the branch is named for the minute it started', () => {
  expect(nightBranch(new Date(2026, 8, 22, 23, 5))).toBe('bimax/night-2026-09-22-2305');
});

test('the morning time is the next one, at most 16 hours away', () => {
  expect(nightDeadline('07:00', at(23))).toBe(new Date(2026, 8, 23, 7, 0).getTime());
  expect(nightDeadline('23:30', at(23))).toBe(at(23, 30));
  expect(nightDeadline('22:00', at(23))).toBeNull(); // 23 hours away
  expect(nightDeadline('7am', at(23))).toBeNull();
  expect(nightDeadline('25:00', at(23))).toBeNull();
});

test('a budget is $1–$100, and a bigger one than the daily cap is said out loud', () => {
  expect(nightBudget('12')).toBe(12);
  expect(nightBudget(2.456)).toBe(2.46);
  expect(nightBudget(0.5)).toBeNull();
  expect(nightBudget(101)).toBeNull();
  expect(nightBudget('lots')).toBeNull();
  expect(budgetNote(12, 5)).toContain('stops at $5');
  expect(budgetNote(4, 5)).toBeNull();
  expect(budgetNote(50, 0)).toBeNull(); // 0 means no daily cap
});

test('the task is told how to work unattended', () => {
  const words = nightWords('Migrate to Vitest.', 'bimax/night-x', 12, at(7));
  expect(words.startsWith('Migrate to Vitest.')).toBe(true);
  for (const part of ['unattended', 'bimax/night-x', 'at most $12', 'milestone', 'Never push', 'NIGHT-QUESTIONS.md', NIGHT_DONE]) expect(words).toContain(part);
});

test('after each turn: continue until done, the budget, an error, the morning, or a stop', () => {
  const base = { now: at(1), until: at(7), spent: 2, budget: 12, answer: 'Milestone 1 done.', outcome: 'completed', continuations: 0 };
  expect(nightNext(base)).toBe('continue');
  expect(nightNext({ ...base, answer: `All migrated.\n${NIGHT_DONE}` })).toBe('finished');
  expect(nightNext({ ...base, spent: 12, outcome: 'failed' })).toBe('budget'); // the cap is why it failed
  expect(nightNext({ ...base, outcome: 'failed' })).toBe('failed');
  expect(nightNext({ ...base, now: at(6, 56) })).toBe('morning');
  expect(nightNext({ ...base, now: at(6, 56), outcome: 'interrupted' })).toBe('morning');
  expect(nightNext({ ...base, outcome: 'interrupted' })).toBe('stopped');
  expect(nightNext({ ...base, continuations: MAX_CONTINUATIONS })).toBe('finished');
  expect(nightContinue(90.4, 9.5)).toContain('About 90 minutes and $9.50 are left');
});

test('what a shift spent adds up its days since it started, across midnight UTC', () => {
  const ledger = { date: '2026-09-23', scopes: { t1: 1.5, other: 9 }, history: [
    { date: '2026-09-22', scopes: { t1: 2.25 } }, { date: '2026-09-21', scopes: { t1: 100 } },
  ] };
  expect(spentBy(ledger, 't1', '2026-09-22')).toBe(3.75);
  expect(spentBy(ledger, 'nobody', '2026-09-22')).toBe(0);
  expect(spentBy(null, 't1', '2026-09-22')).toBe(0);
});

test('the briefing says how it ended, what it did, and how to review or drop it', () => {
  const text = briefing({ goal: 'Migrate to Vitest.\nAll packages.', branch: 'bimax/night-x', repo: '/r', worktree: '/data/night/x', commits: ['abc123 milestone: core'], diffstat: ' 3 files changed', spentUsd: 3.2, budgetUsd: 12, check: 'passed', stoppedBy: 'morning', answer: 'Core done; cli left.', questions: '- Keep snapshots? Chose yes.' });
  expect(text).toContain('# Night shift: Migrate to Vitest.');
  expect(text).toContain('Stopped at the morning time · 1 commit on `bimax/night-x` · the check passed · $3.20 of $12');
  expect(text).toContain('- abc123 milestone: core');
  expect(text).toContain('## Questions it recorded\n- Keep snapshots? Chose yes.');
  expect(text).toContain('git log --oneline HEAD..bimax/night-x');
  expect(text).toContain('git worktree remove "/data/night/x" && git branch -D bimax/night-x');
  expect(briefing({ goal: 'g', branch: 'b', repo: '/r', worktree: '/w', commits: [], diffstat: '', spentUsd: null, budgetUsd: 5, check: 'failed', stoppedBy: 'budget', answer: '', questions: '' }))
    .toContain('Stopped at its budget · 0 commits on `b` · the check FAILED · spend unknown');
});

test('on a real repository: the shift’s checkout is separate, and its commits are on its own branch', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-night-repo-')));
  const tree = path.join(fs.realpathSync(os.tmpdir()), `bimax-night-tree-${process.pid}`);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  try {
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'mine');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'start');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, ...worktreeCommand(tree, 'bimax/night-test'));
    fs.writeFileSync(path.join(tree, 'a.txt'), 'the shift changed this');
    git(tree, 'commit', '-qam', 'milestone: change a');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('mine');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(tree, 'log', '--oneline', '--no-decorate', `${base}..HEAD`).trim()).toMatch(/^[0-9a-f]+ milestone: change a$/);
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)', 'bimax/night-test').trim()).toBe('bimax/night-test'); // on the repository's branch list
  } finally {
    try { git(repo, 'worktree', 'remove', '--force', tree); } catch { /* already gone */ }
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(tree, { recursive: true, force: true });
  }
});
