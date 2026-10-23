import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { includeKept, isRevision, keepManual, manualEdits, receivePlan, revisionHint, type AppliedPlan } from '../main/organize.plan';

/** Backlog FL3: "Actually…" revises a finished result from the current state, and keeps what the person moved by hand. */

test('what counts as revising what was just done', () => {
  for (const text of ['Actually, by project', 'actually keep invoices together', 'Instead, sort by year', 'Rather by client', 'On second thought, by month', 'Hmm, actually by project', 'ok actually no']) {
    expect(isRevision(text)).toBe(true);
  }
  for (const text of ['No, use ACME for this client', 'Sort by project', 'What did you actually move?', 'factually']) {
    expect(isRevision(text)).toBe(false);
  }
});

test('the task is told to revise from where the files are now', () => {
  const hint = revisionHint({ root: '/r', threadId: 't', at: 1, title: 'Sort Downloads', placements: [] });
  expect(hint).toContain('This revises “Sort Downloads”');
  expect(hint).toContain('where the files are now');
  expect(hint).toContain('OrganizePlanTool');
  expect(hint).toContain('kept where they put them');
});

test('a file no longer where the plan put it was moved by hand; it is found again by its inode', () => {
  const applied: AppliedPlan = { root: '/r', threadId: 't', at: 1, title: 'x', placements: [
    { path: '/r/A/a.pdf', ino: 11 }, { path: '/r/B/b.pdf', ino: 22 }, { path: '/r/C/c.pdf', ino: 33 }, { path: '/r/D/d.pdf', ino: 44 },
  ] };
  const inodes: Record<string, number> = { '/r/A/a.pdf': 11, '/r/B/b.pdf': 99, '/r/mine/c.pdf': 33 };
  const found: Record<number, string> = { 33: '/r/mine/c.pdf' };
  expect(manualEdits(applied, (f) => inodes[f] ?? null, (ino) => found[ino] ?? null)).toEqual([
    { placed: '/r/B/b.pdf', now: null },
    { placed: '/r/C/c.pdf', now: '/r/mine/c.pdf' },
    { placed: '/r/D/d.pdf', now: null },
  ]);
});

test('a revision keeps hand-placed files out until the person includes them', () => {
  const plan = receivePlan({ moves: [
    { from: '/r/mine/c.pdf', to: '/r/Projects/X/c.pdf', group: 'Invoices' },
    { from: '/r/A/a.pdf', to: '/r/Projects/Y/a.pdf', group: 'Invoices' },
  ] }, 't', '/r')!;
  const kept = keepManual(plan, new Set(['/r/mine/c.pdf']));
  expect(kept.moves.map((m) => m.from)).toEqual(['/r/A/a.pdf']);
  expect(kept.kept).toEqual([{ from: '/r/mine/c.pdf', to: '/r/Projects/X/c.pdf', group: 'Invoices' }]);
  expect(keepManual(plan, new Set())).toBe(plan);
  const back = includeKept(kept, '/r/mine/c.pdf');
  expect(back.moves.map((m) => m.from)).toEqual(['/r/A/a.pdf', '/r/mine/c.pdf']);
  expect(back.kept).toEqual([]);
  expect(includeKept(kept, '/r/nope')).toBe(kept);
});

test('on a real disk: a rename by hand keeps the inode, and a new file in the old place is not mistaken for it', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-revise-')));
  try {
    fs.mkdirSync(path.join(root, 'A'));
    fs.writeFileSync(path.join(root, 'A/a.pdf'), 'a');
    fs.writeFileSync(path.join(root, 'A/b.pdf'), 'b');
    const ino = (f: string): number | null => { try { return fs.statSync(f).ino; } catch { return null; } };
    const applied: AppliedPlan = { root, threadId: 't', at: 1, title: 'x', placements: [
      { path: path.join(root, 'A/a.pdf'), ino: ino(path.join(root, 'A/a.pdf'))! },
      { path: path.join(root, 'A/b.pdf'), ino: ino(path.join(root, 'A/b.pdf'))! },
    ] };
    fs.mkdirSync(path.join(root, 'Mine'));
    fs.renameSync(path.join(root, 'A/a.pdf'), path.join(root, 'Mine/renamed.pdf'));
    fs.writeFileSync(path.join(root, 'A/a.pdf'), 'a new file with the old name');
    const locate = (target: number): string | null => {
      for (const dir of ['A', 'Mine']) for (const name of fs.readdirSync(path.join(root, dir))) if (ino(path.join(root, dir, name)) === target) return path.join(root, dir, name);
      return null;
    };
    expect(manualEdits(applied, ino, locate)).toEqual([{ placed: path.join(root, 'A/a.pdf'), now: path.join(root, 'Mine/renamed.pdf') }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
