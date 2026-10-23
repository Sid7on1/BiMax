import * as fs from 'fs';
import * as path from 'path';
import { journalDir, recordBeforeChange, recordTrash } from '../tools/thread.journal';
import { planFileChange, planShellChange } from '../tools/thread.changes';

/** The undo journal lives in the thread's state folder and holds what the app needs to reverse each change. */
let root: string;
let state: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.thread-journal-root-'));
  state = fs.mkdtempSync(path.join(process.cwd(), '.thread-journal-state-'));
  process.env.BIMAX_THREAD_ROOT = root;
  process.env.BIMAX_STATE_DIR = state;
  fs.writeFileSync(path.join(root, 'notes.txt'), 'before');
  fs.mkdirSync(path.join(root, 'DEV'));
});
afterEach(() => {
  delete process.env.BIMAX_THREAD_ROOT;
  delete process.env.BIMAX_STATE_DIR;
  for (const dir of [root, state]) fs.rmSync(dir, { recursive: true, force: true });
});

const lines = (): any[] => fs.readFileSync(path.join(journalDir(), 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('the journal is written to the thread state folder, never into the thread folder', async () => {
  await recordBeforeChange(planShellChange('mv DEV 2026-09-13_DEV', root, root)!, 'BashTool');
  expect(journalDir()).toBe(path.join(state, '.bimax', 'undo'));
  expect(fs.existsSync(path.join(root, '.bimax'))).toBe(false);
  expect(lines()[0]).toMatchObject({
    type: 'change', title: 'Rename folder “DEV” to “2026-09-13_DEV”',
    ops: [{ op: 'move', from: path.join(root, 'DEV'), to: path.join(root, '2026-09-13_DEV') }],
  });
});

test('a replacement keeps a copy of the old contents; a Bin move records where the item went', async () => {
  const entry = await recordBeforeChange(planFileChange('FILE_WRITE', { tool: 'WriteFileTool', targetPath: path.join(root, 'notes.txt') }, root, root)!, 'WriteFileTool');
  const restore = entry!.ops[0] as { op: string; backup: string };
  expect(restore.op).toBe('restore');
  expect(fs.readFileSync(restore.backup, 'utf8')).toBe('before');
  await recordTrash('Move file “notes.txt” to the Bin', 'DeleteTool', [{ path: path.join(root, 'notes.txt'), trashPath: '/Users/me/.Trash/notes.txt' }]);
  expect(lines()[1].ops).toEqual([{ op: 'trash', path: path.join(root, 'notes.txt'), trashPath: '/Users/me/.Trash/notes.txt' }]);
});
