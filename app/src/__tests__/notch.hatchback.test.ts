import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { filesChangedSince, journalFile } from '../main/thread.undo';

/**
 * God's Land stage 3, the Hatchback: the files a notch task made or changed come back to the shelf. Read from the
 * thread's undo journal — what the engine recorded doing, not a guess from the folder.
 */
test('created, replaced and moved-to files come back; trashed, undone, older and vanished ones do not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-hatchback-'));
  try {
    const f = (name: string, content = 'x') => { const p = path.join(dir, name); fs.writeFileSync(p, content); return p; };
    const created = f('summary.md');
    const replaced = f('contract.md');
    const movedTo = f('renamed.csv');
    const vanished = path.join(dir, 'gone.txt');
    // Trashed by the task, then a new file put at the same path by someone else: not the task's result.
    const trashed = f('old.txt');
    const older = f('before.md');
    const lines = [
      { type: 'change', id: 'c0', at: 50, title: 'before', tool: 'Write', ops: [{ op: 'create', path: older }] },
      { type: 'change', id: 'c1', at: 100, title: 'write', tool: 'Write', ops: [{ op: 'create', path: created }, { op: 'create', path: vanished }] },
      { type: 'change', id: 'c2', at: 110, title: 'edit', tool: 'Edit', ops: [{ op: 'restore', path: replaced, backup: '/b' }] },
      { type: 'change', id: 'c3', at: 120, title: 'move', tool: 'Move', ops: [{ op: 'move', from: path.join(dir, 'data.csv'), to: movedTo }, { op: 'trash', path: trashed, trashPath: null }] },
      { type: 'change', id: 'c4', at: 130, title: 'undone', tool: 'Write', ops: [{ op: 'create', path: f('undone.md') }] },
      { type: 'undo', id: 'c4' },
      { type: 'change', id: 'c5', at: 140, title: 'again', tool: 'Edit', ops: [{ op: 'restore', path: created, backup: '/b2' }] },
    ];
    fs.mkdirSync(path.dirname(journalFile(dir)), { recursive: true });
    fs.writeFileSync(journalFile(dir), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(filesChangedSince(dir, 100)).toEqual([replaced, movedTo, created]);
    expect(filesChangedSince(dir, 1_000)).toEqual([]);
    expect(filesChangedSince(path.join(dir, 'no-journal'), 0)).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
