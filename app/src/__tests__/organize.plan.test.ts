import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPlan, cleanFolder, keepFile, moveFile, moveGroup, orderMoves, planConflicts, previewTree, receivePlan, type OrganizePlan } from '../main/organize.plan';
import { journalFile, undoLast } from '../main/thread.undo';

/** Backlog FL2: a preview you can rearrange, applied in one step that ↶ Undo reverses as a whole. */

const R = '/Users/me/Downloads';
const plan = (): OrganizePlan => receivePlan({ id: 'p1', title: 'Sort Downloads', moves: [
  { from: `${R}/inv-a.pdf`, to: `${R}/Invoices/inv-a.pdf`, group: 'Invoices' },
  { from: `${R}/inv-b.pdf`, to: `${R}/Invoices/inv-b.pdf`, group: 'Invoices' },
  { from: `${R}/inv-c.pdf`, to: `${R}/Misc/inv-c.pdf`, group: 'Invoices' },
  { from: `${R}/IMG_1.jpg`, to: `${R}/Photos/IMG_1.jpg`, group: 'Photos' },
] }, 'thread-1', R)!;

test('the engine’s plan is re-checked: only moves inside the folder, and a group for each', () => {
  expect(receivePlan({ moves: [
    { from: `${R}/a.pdf`, to: '/elsewhere/a.pdf' },
    { from: `${R}/a.pdf`, to: `${R}/a.pdf` },
    { from: 'rel.pdf', to: `${R}/x/rel.pdf` },
    { from: `${R}/b.pdf`, to: R },
    { from: `${R}/c.pdf`, to: `${R}/x/c.pdf` },
  ] }, 't', R)).toEqual({ id: expect.any(String), threadId: 't', root: R, title: 'Organize 1 files', moves: [{ from: `${R}/c.pdf`, to: `${R}/x/c.pdf`, group: 'Other files' }] });
  expect(receivePlan({ moves: [] }, 't', R)).toBeNull();
  expect(receivePlan(null, 't', R)).toBeNull();
});

test('a relative path is never read against wherever Bimax happens to be running', () => {
  const here = process.cwd();
  expect(receivePlan({ moves: [{ from: 'a.pdf', to: `${here}/x/a.pdf` }, { from: `${here}/b.pdf`, to: 'x/b.pdf' }] }, 't', here)).toBeNull();
});

test('folders are listed by name whatever order the plan came in', () => {
  const p = receivePlan({ moves: [{ from: `${R}/z.txt`, to: `${R}/Zebra/z.txt` }, { from: `${R}/a.txt`, to: `${R}/Apple/a.txt` }] }, 't', R)!;
  expect(previewTree(p).map((f) => f.folder)).toEqual(['Apple', 'Zebra']);
});

test('the preview is the proposed tree, folder by folder', () => {
  expect(previewTree(plan())).toEqual([
    { folder: 'Invoices', files: [
      { name: 'inv-a.pdf', from: 'inv-a.pdf', group: 'Invoices', byYou: false },
      { name: 'inv-b.pdf', from: 'inv-b.pdf', group: 'Invoices', byYou: false },
    ] },
    { folder: 'Misc', files: [{ name: 'inv-c.pdf', from: 'inv-c.pdf', group: 'Invoices', byYou: false }] },
    { folder: 'Photos', files: [{ name: 'IMG_1.jpg', from: 'IMG_1.jpg', group: 'Photos', byYou: false }] },
  ]);
});

test('dragging one invoice moves it, and offers to move the other invoices that are elsewhere', () => {
  const moved = moveFile(plan(), `${R}/inv-a.pdf`, '2026/Paid')!;
  expect(moved.group).toBe('Invoices');
  expect(moved.others).toBe(2);
  expect(moved.plan.moves[0]).toEqual({ from: `${R}/inv-a.pdf`, to: `${R}/2026/Paid/inv-a.pdf`, group: 'Invoices', byYou: true });
  const all = moveGroup(moved.plan, 'Invoices', '2026/Paid');
  expect(previewTree(all).map((f) => [f.folder, f.files.length])).toEqual([['2026/Paid', 3], ['Photos', 1]]);
  expect(all.moves.filter((m) => m.byYou)).toHaveLength(3);
  expect(moveFile(plan(), `${R}/nope.pdf`, 'x')).toBeNull();
  expect(moveFile(plan(), `${R}/IMG_1.jpg`, 'Pics')!.others).toBe(0);
  // The other invoices already in Invoices are not offered again.
  expect(moveFile(plan(), `${R}/inv-c.pdf`, 'Invoices')!.others).toBe(0);
});

test('leaving a file where it is drops its move', () => {
  expect(keepFile(plan(), `${R}/IMG_1.jpg`).moves.map((m) => path.basename(m.from))).toEqual(['inv-a.pdf', 'inv-b.pdf', 'inv-c.pdf']);
});

test('a folder name typed or dropped on stays inside the folder', () => {
  expect(cleanFolder(' /Invoices/2026/ ')).toBe('Invoices/2026');
  expect(cleanFolder('')).toBe('');
  expect(cleanFolder('../out')).toBeNull();
  expect(cleanFolder('a/./b')).toBeNull();
  expect(cleanFolder('a\nb')).toBeNull();
  expect(cleanFolder(7)).toBeNull();
});

test('what blocks applying: two files onto one name, or onto a file that stays', () => {
  const clash = moveFile(plan(), `${R}/IMG_1.jpg`, 'Invoices')!.plan;
  const renamed = { ...clash, moves: clash.moves.map((m) => (m.from.endsWith('IMG_1.jpg') ? { ...m, to: `${R}/Invoices/INV-A.pdf` } : m)) };
  expect(planConflicts(renamed, () => false)).toEqual(['Two files would be named Invoices/INV-A.pdf']);
  expect(planConflicts(plan(), (f) => f === `${R}/Photos/IMG_1.jpg`)).toEqual(['Photos/IMG_1.jpg already exists']);
  expect(planConflicts(plan(), (f) => f === `${R}/inv-a.pdf`)).toEqual([]);
});

test('moves are ordered so a file can take a place another is leaving, and a swap goes through a temporary name', () => {
  const m = (from: string, to: string) => ({ from, to, group: 'g' });
  expect(orderMoves([m('/r/b', '/r/a'), m('/r/a', '/r/old/a')])).toEqual([{ from: '/r/a', to: '/r/old/a' }, { from: '/r/b', to: '/r/a' }]);
  const swap = orderMoves([m('/r/x', '/r/y'), m('/r/y', '/r/x')]);
  expect(swap).toEqual([{ from: '/r/x', to: '/r/x.bimax-swap-0' }, { from: '/r/y', to: '/r/x' }, { from: '/r/x.bimax-swap-0', to: '/r/y' }]);
});

describe('on a real disk', () => {
  let root: string;
  let state: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-organize-')));
    state = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-organize-state-'));
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); });
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const realFs = {
    exists: (f: string) => fs.existsSync(f),
    mkdirp: async (d: string) => { await fsp.mkdir(d, { recursive: true }); },
    rename: (a: string, b: string) => fsp.rename(a, b),
    journal: async (line: object) => { await fsp.mkdir(path.dirname(journalFile(state)), { recursive: true }); await fsp.appendFile(journalFile(state), `${JSON.stringify(line)}\n`); },
  };
  const bin = { moveToBin: async () => null, restoreFromBin: async () => undefined };

  test('apply a chain and a swap, then one ↶ Undo puts everything back', async () => {
    put('a.txt', 'A'); put('b.txt', 'B'); put('x.txt', 'X'); put('y.txt', 'Y');
    const p = receivePlan({ title: 'Tidy', moves: [
      { from: `${root}/b.txt`, to: `${root}/a.txt` },
      { from: `${root}/a.txt`, to: `${root}/old/a.txt` },
      { from: `${root}/x.txt`, to: `${root}/y.txt` },
      { from: `${root}/y.txt`, to: `${root}/x.txt` },
    ] }, 't', root)!;
    expect(await applyPlan(p, realFs, 1)).toEqual({ moved: 4, failed: [] });
    expect([read('a.txt'), read('old/a.txt'), read('x.txt'), read('y.txt')]).toEqual(['B', 'A', 'Y', 'X']);
    expect(fs.existsSync(path.join(root, 'b.txt'))).toBe(false);
    expect((await undoLast(state, root, bin)).title).toBe('Tidy (4 files)');
    expect([read('a.txt'), read('b.txt'), read('x.txt'), read('y.txt')]).toEqual(['A', 'B', 'X', 'Y']);
    expect(fs.readdirSync(root).sort()).toEqual(['a.txt', 'b.txt', 'old', 'x.txt', 'y.txt']);
  });

  test('a move that fails stops the plan, and ↶ Undo reverses exactly the moves that happened', async () => {
    put('1.txt', 'one'); put('2.txt', 'two');
    const p = receivePlan({ title: 'Half', moves: [{ from: `${root}/1.txt`, to: `${root}/d/1.txt` }, { from: `${root}/2.txt`, to: `${root}/d/2.txt` }] }, 't', root)!;
    let calls = 0;
    const flaky = { ...realFs, rename: async (a: string, b: string) => { if (++calls === 2) throw new Error('disk full'); await fsp.rename(a, b); } };
    const result = await applyPlan(p, flaky, 1);
    expect(result).toEqual({ moved: 1, failed: [{ from: `${root}/2.txt`, error: 'disk full' }] });
    expect((await undoLast(state, root, bin)).title).toBe('Half (partly: 1 moved)');
    expect(read('1.txt')).toBe('one');
    expect(read('2.txt')).toBe('two');
    await expect(undoLast(state, root, bin)).rejects.toThrow('nothing to undo');
  });

  test('a file that appears in a move’s place while the plan runs is never overwritten', async () => {
    put('a.txt', 'mine');
    const p = receivePlan({ title: 'Race', moves: [{ from: `${root}/a.txt`, to: `${root}/d/a.txt` }] }, 't', root)!;
    const racy = { ...realFs, mkdirp: async (d: string) => { await realFs.mkdirp(d); fs.writeFileSync(path.join(d, 'a.txt'), 'someone else'); } };
    const result = await applyPlan(p, racy, 1);
    expect(result.moved).toBe(0);
    expect(result.failed[0]!.error).toContain('already there');
    expect([read('a.txt'), read('d/a.txt')]).toEqual(['mine', 'someone else']);
  });

  test('after a failed move, the rest wait rather than run', async () => {
    put('1.txt', '1'); put('2.txt', '2'); put('3.txt', '3');
    const p = receivePlan({ title: 'Stop', moves: [1, 2, 3].map((n) => ({ from: `${root}/${n}.txt`, to: `${root}/d/${n}.txt` })) }, 't', root)!;
    let calls = 0;
    const flaky = { ...realFs, rename: async (a: string, b: string) => { if (++calls === 2) throw new Error('busy'); await fsp.rename(a, b); } };
    expect((await applyPlan(p, flaky, 1)).moved).toBe(1);
    expect(fs.existsSync(path.join(root, '3.txt'))).toBe(true);
  });

  test('a conflict refuses before anything moves or is journaled', async () => {
    put('a.txt', 'A'); put('keep/a.txt', 'K');
    const p = receivePlan({ moves: [{ from: `${root}/a.txt`, to: `${root}/keep/a.txt` }] }, 't', root)!;
    await expect(applyPlan(p, realFs, 1)).rejects.toThrow('keep/a.txt already exists');
    expect(read('a.txt')).toBe('A');
    expect(fs.existsSync(journalFile(state))).toBe(false);
  });

  test('undo still refuses when someone else took a file’s old place since', async () => {
    put('a.txt', 'A');
    await applyPlan(receivePlan({ title: 'One', moves: [{ from: `${root}/a.txt`, to: `${root}/d/a.txt` }] }, 't', root)!, realFs, 1);
    put('a.txt', 'someone else');
    await expect(undoLast(state, root, bin)).rejects.toThrow('already in');
  });
});
