import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastUndoable, threadStateEnvironment, threadStateRoot, undoLast, type BinOps } from '../main/thread.undo';

/**
 * "↶ Undo" in the ⌘2 bar. The engine journals each change a thread makes (src/tools/thread.journal.ts); the app
 * reverses the newest one — checking every path and conflict before anything moves.
 */
let root: string;
let state: string;

const journal = (...records: object[]): void => {
  fs.mkdirSync(path.join(state, '.bimax', 'undo'), { recursive: true });
  fs.appendFileSync(path.join(state, '.bimax', 'undo', 'journal.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

function fakeBin(): BinOps & { trashed: string[]; restored: string[] } {
  const trashed: string[] = [];
  const restored: string[] = [];
  return {
    trashed, restored,
    async moveToBin(target) { trashed.push(target); fs.rmSync(target, { recursive: true, force: true }); return null; },
    async restoreFromBin(_trashPath, original) { restored.push(original); fs.writeFileSync(original, 'from the Bin'); },
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'undo-root-')));
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'undo-state-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
});

test('a ⌘2 thread keeps its state under the app data folder; a project keeps it in the repository', () => {
  const quick = threadStateRoot('/data', '/Users/me/Desktop', 'quick');
  expect(path.dirname(quick)).toBe(path.join('/data', 'thread-state'));
  expect(threadStateRoot('/data', '/Users/me/Desktop', undefined)).toBe(quick);
  expect(threadStateEnvironment('/data', '/Users/me/Desktop', 'quick')).toEqual({ BIMAX_STATE_DIR: quick });
  expect(threadStateRoot('/data', '/Users/me/repo', 'project')).toBe('/Users/me/repo');
  expect(threadStateEnvironment('/data', '/Users/me/repo', 'project')).toEqual({});
});

test('undo renames the folder back, and the next undo is the change before it', async () => {
  fs.mkdirSync(path.join(root, '2026-09-13_DEV'));
  journal(
    { type: 'change', id: 'a', at: 1, title: 'Create file “x”', tool: 'WriteFileTool', ops: [{ op: 'create', path: path.join(root, 'x') }] },
    { type: 'change', id: 'b', at: 2, title: 'Rename folder “DEV” to “2026-09-13_DEV”', tool: 'BashTool', ops: [{ op: 'move', from: path.join(root, 'DEV'), to: path.join(root, '2026-09-13_DEV') }] },
  );
  expect(lastUndoable(state)?.title).toBe('Rename folder “DEV” to “2026-09-13_DEV”');
  await expect(undoLast(state, root, fakeBin())).resolves.toEqual({ title: 'Rename folder “DEV” to “2026-09-13_DEV”' });
  expect(fs.existsSync(path.join(root, 'DEV'))).toBe(true);
  expect(fs.existsSync(path.join(root, '2026-09-13_DEV'))).toBe(false);
  expect(lastUndoable(state)?.title).toBe('Create file “x”');
});

test('a replaced file gets its old contents back, and the version being undone goes to the Bin first', async () => {
  const target = path.join(root, 'notes.txt');
  fs.writeFileSync(target, 'after');
  const backup = path.join(state, '.bimax', 'undo', 'backups', 'c', '0-notes.txt');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, 'before');
  journal({ type: 'change', id: 'c', at: 1, title: 'Replace the contents of “notes.txt”', tool: 'WriteFileTool', ops: [{ op: 'restore', path: target, backup }] });
  const bin = fakeBin();
  await undoLast(state, root, bin);
  expect(fs.readFileSync(target, 'utf8')).toBe('before');
  expect(bin.trashed).toEqual([target]);
});

test('a Bin move is put back; a conflict changes nothing and says why', async () => {
  const item = path.join(root, 'old.txt');
  journal({ type: 'change', id: 'd', at: 1, title: 'Move file “old.txt” to the Bin', tool: 'DeleteTool', ops: [{ op: 'trash', path: item, trashPath: path.join(os.homedir(), '.Trash', 'old.txt') }] });
  fs.writeFileSync(item, 'someone made a new one');
  await expect(undoLast(state, root, fakeBin())).rejects.toThrow('already exists');
  expect(lastUndoable(state)?.title).toBe('Move file “old.txt” to the Bin');
  fs.rmSync(item);
  const bin = fakeBin();
  await undoLast(state, root, bin);
  expect(bin.restored).toEqual([item]);
  expect(lastUndoable(state)).toBeNull();
});

test('an item from an iCloud Drive folder, like a synced Desktop, is put back from iCloud Drive’s Bin', async () => {
  // MEASURED 2026-09-14: Finder's delete of a file on the iCloud-synced Desktop lands in
  // ~/Library/Mobile Documents/.Trash, and undo refused it as "not in the Bin".
  const item = path.join(root, 'Agents.docx');
  const trashPath = path.join(os.homedir(), 'Library', 'Mobile Documents', '.Trash', 'Agents.docx');
  journal({ type: 'change', id: 'i', at: 1, title: 'Move file “Agents.docx” to the Bin', tool: 'DeleteTool', ops: [{ op: 'trash', path: item, trashPath }] });
  const bin = fakeBin();
  await expect(undoLast(state, root, bin)).resolves.toEqual({ title: 'Move file “Agents.docx” to the Bin' });
  expect(bin.restored).toEqual([item]);
});

test('a Bin place outside every Bin is refused before anything moves', async () => {
  const item = path.join(root, 'old.txt');
  for (const trashPath of [
    path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'old.txt'),
    path.join(os.homedir(), 'Library', 'Mobile Documents', '.Trash', '..', 'old.txt'),
    '/tmp/.Trash/old.txt',
  ]) {
    fs.rmSync(path.join(state, '.bimax', 'undo', 'journal.jsonl'), { force: true });
    journal({ type: 'change', id: 'o', at: 1, title: 'Move file “old.txt” to the Bin', tool: 'DeleteTool', ops: [{ op: 'trash', path: item, trashPath }] });
    const bin = fakeBin();
    await expect(undoLast(state, root, bin)).rejects.toThrow('not in the Bin');
    expect(bin.restored).toEqual([]);
  }
});

test('a journal naming a path outside the thread folder is refused before anything moves', async () => {
  journal({ type: 'change', id: 'e', at: 1, title: 'Rename', tool: 'BashTool', ops: [{ op: 'move', from: '/etc/hosts', to: path.join(root, 'hosts') }] });
  await expect(undoLast(state, root, fakeBin())).rejects.toThrow('outside');
});
