import * as fs from 'fs';
import * as path from 'path';
import { approvalCard, deletesOutsideBin, planFileChange, planShellChange } from '../tools/thread.changes';

/**
 * Approval cards in plain language. Measured 2026-09-13: `cd …/Desktop && mv "DEV" "2026-09-13_DEV"` was shown as
 * the raw command and allowed in under four seconds; the card now says what will happen, lists every item, and
 * says whether it can be undone.
 */
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.thread-changes-test-'));
  fs.mkdirSync(path.join(root, 'DEV'));
  fs.mkdirSync(path.join(root, 'Screenshots'));
  for (const name of ['a.png', 'b.png', 'notes.txt', 'My File.txt']) fs.writeFileSync(path.join(root, name), 'x');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('the Desktop rename reads as a rename, lists the folder and can be undone', () => {
  const plan = planShellChange(`cd ${root} && mv "DEV" "2026-09-13_DEV"`, '/', root)!;
  expect(plan.title).toBe('Rename folder “DEV” to “2026-09-13_DEV”');
  expect(plan.preview).toEqual(['DEV/ → 2026-09-13_DEV']);
  expect(plan.moves).toEqual([{ from: path.join(root, 'DEV'), to: path.join(root, '2026-09-13_DEV') }]);
  const card = approvalCard(plan, 'OS_COMMAND', { command: 'mv "DEV" "2026-09-13_DEV"' });
  expect(card.question).toBe('Rename folder “DEV” to “2026-09-13_DEV”');
  expect(card.body).toContain('You can undo this');
  expect(card.body).toContain('Command: mv "DEV" "2026-09-13_DEV"');
});

test('a bulk move expands a same-folder wildcard into every file it will move', () => {
  const plan = planShellChange('mv *.png Screenshots/', root, root)!;
  expect(plan.title).toBe('Move 2 items to “Screenshots”');
  expect(plan.preview).toEqual(['a.png → Screenshots/a.png', 'b.png → Screenshots/b.png']);
});

test('rm becomes a Bin move, and deletes that cannot go to the Bin are recognised', () => {
  const plan = planShellChange("rm -rf 'My File.txt' DEV", root, root)!;
  expect(plan.kind).toBe('trash');
  expect(plan.title).toBe('Move 2 items to the Bin');
  expect(plan.trash).toEqual([path.join(root, 'My File.txt'), path.join(root, 'DEV')]);
  expect(deletesOutsideBin('rm notes.txt', root)).toBe(false);
  expect(deletesOutsideBin('find . -name "*.png" -delete', root)).toBe(true);
  expect(deletesOutsideBin('rm a.png && echo done', root)).toBe(true);
  expect(deletesOutsideBin('mv "rm notes" x', root)).toBe(false);
});

test('read-only commands need no card; anything unparsed is described honestly as not undoable', () => {
  expect(planShellChange('ls -la', root, root)).toBeNull();
  const plan = planShellChange("sed -i '' 's/a/b/' notes.txt", root, root)!;
  expect(plan.kind).toBe('command');
  expect(plan.undoable).toBe(false);
  expect(approvalCard(plan, 'OS_COMMAND', { command: "sed -i '' 's/a/b/' notes.txt" }).body).toContain('can’t be undone');
});

test('file tools: a new file is a creation, an existing one a replacement, a delete a Bin move', () => {
  expect(planFileChange('FILE_WRITE', { tool: 'WriteFileTool', targetPath: path.join(root, 'new.txt') }, root, root)!.kind).toBe('create');
  const write = planFileChange('FILE_WRITE', { tool: 'WriteFileTool', targetPath: path.join(root, 'notes.txt') }, root, root)!;
  expect(write.title).toBe('Replace the contents of “notes.txt”');
  expect(write.overwrites).toEqual([path.join(root, 'notes.txt')]);
  expect(planFileChange('FILE_DELETE', { tool: 'DeleteTool', targetPath: path.join(root, 'DEV') }, root, root)!.title).toBe('Move folder “DEV” to the Bin');
});
