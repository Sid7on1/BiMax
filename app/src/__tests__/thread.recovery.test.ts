import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadManager, type SavedThread } from '../main/thread.manager';
import { changesSince, journalFile } from '../main/thread.undo';

/**
 * Backlog F6: recovery before retry. A turn cut off by a crash or a quit is never sent again on its own (F1), but when
 * the user sends it again the task starts over, and can repeat what it had already done — move a file twice, append a
 * line twice. The undo journal records every change a thread makes, so the task is now told which changes the cut-off
 * turn had made, each checked on disk, before it acts again.
 */

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-recovery-'))); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function journal(entries: object[]): void {
  fs.mkdirSync(path.dirname(journalFile(dir)), { recursive: true });
  fs.writeFileSync(journalFile(dir), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const file = (name: string, text = name) => { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };

test('the journal says what a thread did since a moment, and the disk says whether each change is still in place', () => {
  const t = 1_000_000;
  const moved = file('Invoices/a.pdf');
  const backupChanged = file('.bimax/undo/backups/r1/0-notes.md', 'old notes');
  const notes = file('notes.md', 'old notes\ndeploy checked\n');
  const backupSame = file('.bimax/undo/backups/r2/0-todo.md', 'same');
  const todo = file('todo.md', 'same');
  journal([
    { type: 'change', id: 'before', at: t - 1, title: 'Earlier turn', tool: 'BashTool', ops: [{ op: 'create', path: file('old.txt') }] },
    { type: 'change', id: 'm1', at: t, title: 'Move a.pdf to Invoices', tool: 'BashTool', ops: [{ op: 'move', from: path.join(dir, 'a.pdf'), to: moved }] },
    { type: 'change', id: 'm2', at: t + 1, title: 'Move b.pdf to Invoices', tool: 'BashTool', ops: [{ op: 'move', from: file('b.pdf'), to: path.join(dir, 'Invoices/b.pdf') }] },
    { type: 'change', id: 'e1', at: t + 2, title: 'Edit notes.md', tool: 'EditFileTool', ops: [{ op: 'restore', path: notes, backup: backupChanged }] },
    { type: 'change', id: 'e2', at: t + 3, title: 'Edit todo.md', tool: 'EditFileTool', ops: [{ op: 'restore', path: todo, backup: backupSame }] },
    { type: 'change', id: 'u1', at: t + 4, title: 'Create draft.md', tool: 'WriteFileTool', ops: [{ op: 'create', path: path.join(dir, 'draft.md') }] },
    { type: 'undo', id: 'u1', at: t + 5 },
  ]);
  expect(changesSince(dir, t)).toEqual([
    { title: 'Move a.pdf to Invoices', at: t, inPlace: true },
    // The journal is written before a change runs: this move never happened — b.pdf is still where it was.
    { title: 'Move b.pdf to Invoices', at: t + 1, inPlace: false },
    { title: 'Edit notes.md', at: t + 2, inPlace: true },
    { title: 'Edit todo.md', at: t + 3, inPlace: false },
  ]);
  expect(changesSince(path.join(dir, 'nothing-here'), 0)).toEqual([]);
});

function fixture(saved: SavedThread[], made: Array<{ title: string; inPlace: boolean | null }>) {
  const engines = new Map<string, { sendFromRenderer: jest.Mock; dispose: jest.Mock; openProject: jest.Mock }>();
  const disk = new Map<string, SavedThread>();
  const madeSince = jest.fn(() => made);
  const manager = new ThreadManager({
    engine: (id) => { const e = { sendFromRenderer: jest.fn(), dispose: jest.fn(), openProject: jest.fn() }; engines.set(id, e); return e; },
    save: (value) => { disk.set(value.summary.id, JSON.parse(JSON.stringify(value))); },
    saveNow: (value) => { disk.set(value.summary.id, JSON.parse(JSON.stringify(value))); },
    selected: jest.fn(), message: jest.fn(), approval: jest.fn(), changed: jest.fn(), madeSince,
  }, saved);
  const notes = (id: string) => manager.get(id).state.items
    .filter((item: any) => item.kind === 'msg' && item.msg.role === 'system').map((item: any) => String(item.msg.content)).join('\n');
  return { manager, engines, disk, notes, madeSince };
}

test('a turn cut off when Bimax closed is reported with what it had already done, and the task is told before it acts again', () => {
  const first = fixture([], []);
  const id = first.manager.create('/fixture/Downloads', 'Sort the invoices into Invoices/');
  first.manager.receive(id, { t: 'ready', protocol: 3 } as any);
  const sent = first.disk.get(id)!.inputs!.find((input) => input.state === 'sent')!;
  expect(typeof sent.sentAt).toBe('number');
  // It waited a minute in the queue behind another turn; what that turn changed is not this message's doing.
  sent.at = sent.sentAt! - 60_000;

  // Bimax closes mid-turn; the next start reads the journal from the moment the message was sent.
  const reloaded = fixture([first.disk.get(id)!], [
    { title: 'Move a.pdf to Invoices', inPlace: true },
    { title: 'Move b.pdf to Invoices', inPlace: false },
  ]);
  expect(reloaded.madeSince).toHaveBeenCalledWith(expect.objectContaining({ id }), sent.sentAt);
  expect(reloaded.notes(id)).toContain('Before it stopped it had already made 2 changes: Move a.pdf to Invoices; Move b.pdf to Invoices (not in place now).');

  reloaded.manager.submit(id, 'Sort the invoices into Invoices/');
  reloaded.manager.start(id);
  reloaded.manager.receive(id, { t: 'ready', protocol: 3 } as any);
  const [[first_message]] = reloaded.engines.get(id)!.sendFromRenderer.mock.calls;
  expect(first_message.text).toMatch(/^\[Before this message: the request “Sort the invoices into Invoices\/” was cut off when Bimax closed, and before that it had already made these changes \(checked on disk just now\): Move a\.pdf to Invoices; Move b\.pdf to Invoices \(not in place now\)\. Check what is already done before doing any of it again, and do not repeat a change that is still in place\.\]\n\nSort the invoices into Invoices\/$/);

  // Told once: the next message carries no note.
  reloaded.manager.receive(id, { t: 'event', name: 'spinner_state', args: ['idle', ''] } as any);
  reloaded.manager.submit(id, 'Thanks.');
  expect(reloaded.engines.get(id)!.sendFromRenderer.mock.calls[1][0].text).toBe('Thanks.');
});

test('a cut-off turn that changed nothing is reported as before, with no note for the task', () => {
  const first = fixture([], []);
  const id = first.manager.create('/fixture/a', 'Explain the build');
  first.manager.receive(id, { t: 'ready', protocol: 3 } as any);
  const reloaded = fixture([first.disk.get(id)!], []);
  expect(reloaded.notes(id)).toContain('It was not sent again: “Explain the build”. Send it again if it still needs doing.');
  reloaded.manager.submit(id, 'Explain the build');
  reloaded.manager.start(id);
  reloaded.manager.receive(id, { t: 'ready', protocol: 3 } as any);
  expect(reloaded.engines.get(id)!.sendFromRenderer.mock.calls[0][0].text).toBe('Explain the build');
});

test('an engine restart mid-turn reads the journal the same way', () => {
  const f = fixture([], [{ title: 'Edit notes.md', inPlace: true }]);
  const id = f.manager.create('/fixture/b', 'Add the deploy line');
  f.manager.receive(id, { t: 'ready', protocol: 3 } as any);
  f.manager.lifecycle(id, 'restarting', 'Engine restarting');
  expect(f.notes(id)).toContain('when the engine restarted, so it may have partly run. It was not sent again: “Add the deploy line”. Before it stopped it had already made 1 change: Edit notes.md.');
});
