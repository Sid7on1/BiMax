import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changeHistory, laterDependents, undoBackTo, undoChange, type BinOps } from '../main/thread.undo';

/** Backlog FL4: a timeline of what a task changed, honest about what undo does, and undo of any change that stands alone. */

let root: string;
let state: string;
const journal = (...records: object[]): void => {
  fs.mkdirSync(path.join(state, '.bimax', 'undo'), { recursive: true });
  fs.appendFileSync(path.join(state, '.bimax', 'undo', 'journal.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
};
const put = (rel: string, text: string): string => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const bin = (): BinOps & { trashed: string[] } => {
  const trashed: string[] = [];
  return { trashed, async moveToBin(t) { trashed.push(t); fs.rmSync(t, { force: true }); return null; }, async restoreFromBin() { /* unused */ } };
};
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hist-root-')));
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-state-'));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); });

/** Three changes: rename a (1), create notes (2), then move the renamed file again (3) — 3 builds on 1. */
function threeChanges(): { a: string; b: string; c: string; notes: string } {
  const c = put('Sorted/a.txt', 'A');
  const notes = put('notes.md', 'N');
  const now = Date.now();
  journal(
    { type: 'change', id: 'one', at: now - 3000, title: 'Rename a.txt', tool: 'MoveTool', ops: [{ op: 'move', from: path.join(root, 'a.txt'), to: path.join(root, 'b.txt') }] },
    { type: 'change', id: 'two', at: now - 2000, title: 'Write notes.md', tool: 'WriteFileTool', ops: [{ op: 'create', path: notes }] },
    { type: 'change', id: 'three', at: now - 1000, title: 'File b.txt', tool: 'MoveTool', ops: [{ op: 'move', from: path.join(root, 'b.txt'), to: c }] },
  );
  return { a: path.join(root, 'a.txt'), b: path.join(root, 'b.txt'), c, notes };
}

test('the history is newest first, and says which changes stand alone', () => {
  threeChanges();
  const entries = changeHistory(state);
  expect(entries.map((e) => [e.id, e.dependents, e.reversibility, e.inPlace])).toEqual([
    ['three', 0, 'full', true],
    ['two', 0, 'full', true],
    ['one', 1, 'full', false], // its file moved on: the later move built on it
  ]);
});

test('a change that stands alone is undone without touching newer ones', async () => {
  const { c, notes } = threeChanges();
  const b = bin();
  expect((await undoChange(state, root, b, 'two')).title).toBe('Write notes.md');
  expect(b.trashed).toEqual([notes]);
  expect(fs.readFileSync(c, 'utf8')).toBe('A'); // the newer move is still in place
  expect(changeHistory(state).map((e) => e.id)).toEqual(['three', 'one']);
});

test('a change later ones built on refuses on its own, and "back to here" undoes them in order', async () => {
  const { a, c } = threeChanges();
  await expect(undoChange(state, root, bin(), 'one')).rejects.toThrow('1 later change used the same files');
  expect(fs.existsSync(c)).toBe(true);
  const result = await undoBackTo(state, root, bin(), 'one');
  expect(result).toEqual({ undone: ['File b.txt', 'Write notes.md', 'Rename a.txt'] });
  expect(fs.readFileSync(a, 'utf8')).toBe('A');
  expect(changeHistory(state)).toEqual([]);
  await expect(undoBackTo(state, root, bin(), 'one')).rejects.toThrow('already undone');
  await expect(undoChange(state, root, bin(), 'one')).rejects.toThrow('already undone');
});

test('"back to here" stops at the first change that refuses and says how far it got', async () => {
  const { c } = threeChanges();
  put('b.txt', 'someone else'); // the place "File b.txt" would move back to is taken
  const result = await undoBackTo(state, root, bin(), 'one');
  expect(result.undone).toEqual([]);
  expect(result.stoppedAt).toContain('already in');
  expect(fs.existsSync(c)).toBe(true);
});

test('a file created or replaced and then changed outside Bimax is flagged; its version goes to the Bin, not lost', () => {
  const now = Date.now();
  const made = put('report.md', 'Bimax wrote this');
  const moved = put('Moved/x.txt', 'X');
  journal(
    { type: 'change', id: 'made', at: now - 60_000, title: 'Write report.md', tool: 'WriteFileTool', ops: [{ op: 'create', path: made }] },
    { type: 'change', id: 'moved', at: now - 60_000, title: 'Move x.txt', tool: 'MoveTool', ops: [{ op: 'move', from: path.join(root, 'x.txt'), to: moved }] },
  );
  fs.utimesSync(made, new Date(), new Date()); // edited a minute later
  fs.utimesSync(moved, new Date(), new Date());
  const byId = Object.fromEntries(changeHistory(state).map((e) => [e.id, e.editedSince]));
  expect(byId).toEqual({ made: ['report.md'], moved: [] }); // a moved file carries its edits back with it
});

test('Bimax’s own later edit is a dependent, not someone else’s change', () => {
  const now = Date.now();
  const made = put('report.md', 'v2');
  journal(
    { type: 'change', id: 'v1', at: now - 60_000, title: 'Write report.md', tool: 'WriteFileTool', ops: [{ op: 'create', path: made }] },
    { type: 'change', id: 'v2', at: now - 1000, title: 'Edit report.md', tool: 'EditFileTool', ops: [{ op: 'restore', path: made, backup: path.join(state, '.bimax/undo/backups/v2/0-report.md') }] },
  );
  const v1 = changeHistory(state).find((e) => e.id === 'v1')!;
  expect(v1.editedSince).toEqual([]);
  expect(v1.dependents).toBe(1);
});

test('an item in the Bin at an unknown place can only partly be undone', () => {
  journal({ type: 'change', id: 't', at: Date.now(), title: 'Bin old.log', tool: 'DeleteTool', ops: [{ op: 'trash', path: path.join(root, 'old.log'), trashPath: null }] });
  expect(changeHistory(state)[0]!.reversibility).toBe('partial');
});

test('dependents are found through each other', () => {
  const change = (id: string, from: string, to: string) => ({ type: 'change' as const, id, at: 0, title: id, tool: 't', ops: [{ op: 'move' as const, from, to }] });
  const chain = [change('1', '/r/a', '/r/b'), change('2', '/r/x', '/r/y'), change('3', '/r/b', '/r/c'), change('4', '/r/c', '/r/d'), change('5', '/r/q', '/r/z')];
  expect(laterDependents(chain, '1')).toEqual(['3', '4']);
  expect(laterDependents(chain, '5')).toEqual([]);
  expect(laterDependents(chain, 'missing')).toEqual([]);
});

test('a file Bimax itself just wrote is not "changed since"', () => {
  const made = put('fresh.md', 'Bimax wrote this');
  const written = fs.statSync(made).mtimeMs;
  journal({ type: 'change', id: 'w', at: written - 500, title: 'Write fresh.md', tool: 'WriteFileTool', ops: [{ op: 'create', path: made }] });
  expect(changeHistory(state)[0]!.editedSince).toEqual([]);
});

test('"back to here" stops at the chosen change and leaves older ones alone', async () => {
  const { c } = threeChanges();
  expect(await undoBackTo(state, root, bin(), 'two')).toEqual({ undone: ['File b.txt', 'Write notes.md'] });
  expect(changeHistory(state).map((e) => e.id)).toEqual(['one']);
  expect(fs.existsSync(c)).toBe(false);
  expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('A');
});
