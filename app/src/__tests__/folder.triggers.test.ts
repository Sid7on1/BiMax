import path from 'node:path';
import {
  BUSY_RETRY_MS, FolderTriggers, MAX_FILES_PER_RUN, MAX_RUNS_PER_HOUR, RESCAN_MS, arrivalMatches, changeListNote,
  changesDuring, describeTrigger, newTrigger, runMessage, triggerFolderProblem, validTriggers, type TriggerDeps,
} from '../main/folder.triggers';

/**
 * Backlog FL1 (record 53): a folder trigger runs a ⌘2 task on files that arrive in its folder, and must never feed
 * itself. The folder, the watch, the clock and the journal are fakes; the triggers under test are the real ones.
 */

const ROOT = '/Users/me/Downloads';
const inRoot = (name: string): string => path.join(ROOT, name);
const pdfTrigger = newTrigger({ id: 't1', title: 'File invoices', root: ROOT, prompt: 'Rename it by date and move it into Invoices', kind: 'pdf', now: 0 });

function harness() {
  let now = 1_000_000;
  let nextIno = 100;
  let busy = false;
  let unreadable = false;
  let changed: (() => void) | null = null;
  const files = new Map<string, { ino: number; size: number; mtimeMs: number }>();
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const journal: Array<{ at: number; title: string; paths: string[] }> = [];
  const started: Array<{ files: string[]; followUp: boolean; threadId: string }> = [];
  const paused: Array<{ reason: string; files: string[] }> = [];
  const reports: Array<{ threadId: string; titles: string[] }> = [];
  const active = new Set<string>();
  const deps: TriggerDeps = {
    list: () => {
      if (unreadable) throw new Error('Operation not permitted');
      return [...files].map(([name, file]) => ({ name, ...file }));
    },
    watch: (_root, fn) => { changed = fn; return () => { changed = null; }; },
    timer: (fn, ms) => { const timer = { at: now + ms, fn, live: true }; timers.push(timer); return () => { timer.live = false; }; },
    now: () => now,
    start: (_trigger, list, followUp) => {
      if (busy) return 'busy';
      const threadId = `run-${started.length + 1}`;
      started.push({ files: list, followUp, threadId });
      active.add(threadId);
      return { threadId };
    },
    active: (id) => active.has(id),
    changes: (_trigger, from, to) => {
      const inside = journal.filter((entry) => entry.at >= from && entry.at <= to);
      return { titles: inside.map((entry) => entry.title), paths: new Set(inside.flatMap((entry) => entry.paths)) };
    },
    report: (threadId, titles) => { reports.push({ threadId, titles }); },
    paused: (_trigger, reason, list) => { paused.push({ reason, files: list }); },
  };
  const triggers = new FolderTriggers(deps, 'darwin');
  const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const touch = (): void => { changed?.(); };
  return {
    triggers, started, paused, reports,
    setBusy: (value: boolean) => { busy = value; },
    setUnreadable: (value: boolean) => { unreadable = value; },
    add(name: string, size = 10) { files.set(name, { ino: nextIno++, size, mtimeMs: now }); touch(); },
    /** A new file given a deleted file's inode, as HFS+ and some external disks do. */
    addWithInode(name: string, ino: number) { files.set(name, { ino, size: 10, mtimeMs: now }); touch(); },
    inode: (name: string): number => files.get(name)!.ino,
    remove(name: string) { files.delete(name); touch(); },
    grow(name: string, size: number) { files.set(name, { ...files.get(name)!, size, mtimeMs: now }); touch(); },
    rename(from: string, to: string) { const file = files.get(from)!; files.delete(from); files.set(to, file); touch(); },
    /** The run records a change in the folder's undo journal. */
    journal(title: string, names: string[]) { journal.push({ at: now, title, paths: names.map(inRoot) }); },
    /** The run's task ends its turn. */
    finish(threadId: string) { active.delete(threadId); triggers.finished(threadId); },
    /** The run's task is stopped: no turn ends, it just stops being active. */
    stopQuietly(threadId: string) { active.delete(threadId); },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        await flush();
        const due = timers.filter((timer) => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        now = Math.max(now, due.at);
        due.fn();
      }
      now = end;
      await flush();
    },
  };
}

test('an arrival is a finished, visible file of the trigger’s kind', () => {
  expect(arrivalMatches('Invoice.PDF', 'pdf')).toBe(true);
  expect(arrivalMatches('photo.heic', 'image')).toBe(true);
  expect(arrivalMatches('notes.docx', 'pdf')).toBe(false);
  expect(arrivalMatches('notes.docx', 'document')).toBe(true);
  expect(arrivalMatches('archive.zip', 'any')).toBe(true);
  for (const name of ['.DS_Store', '~$report.docx', 'Invoice.pdf.crdownload', 'movie.mp4.part', 'big.iso.download', 'x.tmp']) {
    expect(arrivalMatches(name, 'any')).toBe(false);
  }
});

test('files already in the folder never run; a new PDF runs once it stops growing; other kinds and empty placeholders do not', async () => {
  const h = harness();
  h.add('old.pdf');
  await h.triggers.sync([pdfTrigger]);
  await h.advance(RESCAN_MS * 3);
  expect(h.started).toEqual([]);

  h.add('notes.docx');
  h.add('placeholder.pdf', 0);
  h.add('Invoice.pdf', 100);
  await h.advance(2_000);
  h.grow('Invoice.pdf', 500);
  await h.advance(3_500);
  expect(h.started).toEqual([]);
  await h.advance(1_000);
  expect(h.started).toEqual([{ files: [inRoot('Invoice.pdf')], followUp: false, threadId: 'run-1' }]);
});

test('renaming a file in place is not an arrival, but a download that finishes is', async () => {
  const h = harness();
  h.add('scan.pdf');
  h.add('Report.pdf.crdownload', 50);
  await h.triggers.sync([pdfTrigger]);
  h.rename('scan.pdf', '2026-09-14 scan.pdf');
  await h.advance(RESCAN_MS);
  expect(h.started).toEqual([]);

  h.rename('Report.pdf.crdownload', 'Report.pdf');
  await h.advance(RESCAN_MS);
  expect(h.started.map((run) => run.files)).toEqual([[inRoot('Report.pdf')]]);
});

test('a download that grows for over a minute is not taken while it grows, and does not hold back a ready file', async () => {
  const h = harness();
  await h.triggers.sync([pdfTrigger]);
  h.add('big.pdf', 1);
  h.add('small.pdf', 10);
  for (let size = 2; size <= 40; size++) {
    await h.advance(2_000);
    h.grow('big.pdf', size);
  }
  expect(h.started.map((run) => run.files)).toEqual([[inRoot('small.pdf')]]);
  h.finish('run-1');
  await h.advance(RESCAN_MS);
  expect(h.started.map((run) => run.files)).toEqual([[inRoot('small.pdf')], [inRoot('big.pdf')]]);
  expect(h.started[1].followUp).toBe(false);
});

test('a new file that reuses a deleted file’s inode still counts as an arrival', async () => {
  const h = harness();
  h.add('old.pdf');
  await h.triggers.sync([pdfTrigger]);
  const ino = h.inode('old.pdf');
  h.remove('old.pdf');
  await h.advance(RESCAN_MS);
  h.addWithInode('new.pdf', ino);
  await h.advance(RESCAN_MS);
  expect(h.started.map((run) => run.files)).toEqual([[inRoot('new.pdf')]]);
});

test('a run’s journaled output never runs; other new files make one follow-up, and a follow-up that leaves more pauses', async () => {
  const h = harness();
  await h.triggers.sync([pdfTrigger]);
  h.add('a.pdf');
  await h.advance(10_000);
  expect(h.started).toHaveLength(1);

  // The run renames the file in place, writes a summary through Bimax (journaled, named in another case), and a
  // shell command leaves an OCR copy (not journaled).
  h.rename('a.pdf', 'Invoice 2026-09.pdf');
  h.journal('Create file “Summary.pdf”', ['SUMMARY.pdf']);
  h.add('summary.pdf');
  h.add('a.ocr.pdf');
  await h.advance(10_000);
  expect(h.started).toHaveLength(1);

  h.finish('run-1');
  await h.advance(10_000);
  expect(h.reports[0]).toEqual({ threadId: 'run-1', titles: ['Create file “Summary.pdf”'] });
  expect(h.started[1]).toEqual({ files: [inRoot('a.ocr.pdf')], followUp: true, threadId: 'run-2' });

  h.add('a.ocr.ocr.pdf');
  h.finish('run-2');
  await h.advance(RESCAN_MS * 2);
  expect(h.started).toHaveLength(2);
  expect(h.paused).toEqual([{ reason: expect.stringContaining('may be starting itself'), files: [inRoot('a.ocr.ocr.pdf')] }]);
  expect(h.triggers.watching()).toEqual([]);
});

test(`at most ${MAX_RUNS_PER_HOUR} runs an hour: the next one pauses the trigger and names the file it did not take`, async () => {
  const h = harness();
  await h.triggers.sync([pdfTrigger]);
  for (let i = 1; i <= MAX_RUNS_PER_HOUR + 1; i++) {
    h.add(`${i}.pdf`);
    await h.advance(10_000);
    h.finish(`run-${i}`);
    await h.advance(5_000);
  }
  expect(h.started).toHaveLength(MAX_RUNS_PER_HOUR);
  expect(h.started.every((run) => !run.followUp)).toBe(true);
  expect(h.paused).toEqual([{ reason: `It already ran ${MAX_RUNS_PER_HOUR} times in the last hour.`, files: [inRoot(`${MAX_RUNS_PER_HOUR + 1}.pdf`)] }]);
});

test('while Bimax is busy nothing starts; the files wait and go in one run with files that arrive meanwhile', async () => {
  const h = harness();
  await h.triggers.sync([pdfTrigger]);
  h.setBusy(true);
  h.add('a.pdf');
  await h.advance(BUSY_RETRY_MS * 2);
  expect(h.started).toEqual([]);

  h.setBusy(false);
  h.add('b.pdf');
  await h.advance(BUSY_RETRY_MS);
  expect(h.started.map((run) => run.files)).toEqual([[inRoot('a.pdf'), inRoot('b.pdf')]]);
});

test(`a run takes at most ${MAX_FILES_PER_RUN} files; the rest go in the next run, which is not a follow-up`, async () => {
  const h = harness();
  await h.triggers.sync([{ ...pdfTrigger, kind: 'any' }]);
  for (let i = 0; i < MAX_FILES_PER_RUN + 10; i++) h.add(`f${String(i).padStart(2, '0')}.txt`);
  await h.advance(10_000);
  expect(h.started).toHaveLength(1);
  expect(h.started[0].files).toHaveLength(MAX_FILES_PER_RUN);
  expect(h.started[0].files[0]).toBe(inRoot('f00.txt'));

  h.finish('run-1');
  await h.advance(10_000);
  expect(h.started[1].files).toEqual(Array.from({ length: 10 }, (_, i) => inRoot(`f${MAX_FILES_PER_RUN + i}.txt`)));
  expect(h.started[1].followUp).toBe(false);
  expect(h.paused).toEqual([]);
});

test('a run whose task was stopped without finishing frees the trigger at the next look', async () => {
  const h = harness();
  await h.triggers.sync([pdfTrigger]);
  h.add('a.pdf');
  await h.advance(10_000);
  h.stopQuietly('run-1');
  h.add('b.pdf');
  await h.advance(RESCAN_MS * 2);
  expect(h.started.map((run) => run.threadId)).toEqual(['run-1', 'run-2']);
  expect(h.reports.map((report) => report.threadId)).toEqual(['run-1']);
});

test('a paused trigger stops watching; resuming counts from now; an unreadable folder pauses with a reason', async () => {
  const h = harness();
  await h.triggers.sync([pdfTrigger]);
  expect(h.triggers.watching()).toEqual(['t1']);
  await h.triggers.sync([{ ...pdfTrigger, enabled: false }]);
  expect(h.triggers.watching()).toEqual([]);
  h.add('while-paused.pdf');
  await h.advance(RESCAN_MS);
  await h.triggers.sync([pdfTrigger]);
  await h.advance(RESCAN_MS * 2);
  expect(h.started).toEqual([]);
  await h.triggers.sync([]);
  expect(h.triggers.watching()).toEqual([]);

  const locked = harness();
  locked.setUnreadable(true);
  await locked.triggers.sync([pdfTrigger]);
  expect(locked.paused).toEqual([{ reason: 'Bimax can’t read Downloads: Operation not permitted', files: [] }]);
  expect(locked.triggers.watching()).toEqual([]);
});

test('what the person sees: the trigger, the run’s message and its change list', () => {
  expect(describeTrigger(pdfTrigger)).toBe('When a new PDF arrives in Downloads');
  const one = runMessage(pdfTrigger, [inRoot('a.pdf')]);
  expect(one.display).toBe('Rename it by date and move it into Invoices\n\nNew in Downloads: a.pdf');
  expect(one.text).toBe('Rename it by date and move it into Invoices\n\n[Folder trigger: this file just arrived in Downloads. Work on it only, not on other files in the folder.]\n- /Users/me/Downloads/a.pdf');
  const seven = runMessage(pdfTrigger, ['1', '2', '3', '4', '5', '6', '7'].map((n) => inRoot(`${n}.pdf`)));
  expect(seven.display).toBe('Rename it by date and move it into Invoices\n\nNew in Downloads: 1.pdf, 2.pdf, 3.pdf, 4.pdf, 5.pdf and 2 more');
  expect(seven.text).toContain('these 7 files just arrived in Downloads. Work on them only');
  expect(changeListNote([])).toBe('This run made no changes that ↶ Undo can reverse.');
  expect(changeListNote(['Move “a.pdf” to Invoices'])).toBe('What this run changed (↶ Undo reverses them one at a time, newest first): Move “a.pdf” to Invoices.');
});

test('the journal gives the titles and paths a run changed, only inside the run’s time', () => {
  const journal = [
    { type: 'change', id: 'early', at: 5, title: 'Earlier', tool: 'x', ops: [{ op: 'create', path: '/d/early.pdf' }] },
    { type: 'change', id: 'm', at: 10, title: 'Move', tool: 'x', ops: [{ op: 'move', from: '/d/a.pdf', to: '/d/Invoices/a.pdf' }] },
    { type: 'change', id: 'c', at: 20, title: 'Copy', tool: 'x', ops: [{ op: 'create', path: '/d/b copy.pdf' }, { op: 'restore', path: '/d/c.pdf', backup: '/s/c' }] },
    { type: 'change', id: 'late', at: 21, title: 'Later', tool: 'x', ops: [{ op: 'create', path: '/d/late.pdf' }] },
    { type: 'undo', id: 'm', at: 21 },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\nnot json\n';
  const changes = changesDuring(journal, 10, 20);
  expect(changes.titles).toEqual(['Move', 'Copy']);
  expect([...changes.paths].sort()).toEqual(['/d/Invoices/a.pdf', '/d/b copy.pdf', '/d/c.pdf']);
});

test('saved triggers are re-checked, and a trigger never watches the whole disk or home folder', () => {
  expect(triggerFolderProblem('/Users/me', '/Users/me')).toContain('specific folder');
  expect(triggerFolderProblem('/', '/Users/me')).toContain('specific folder');
  expect(triggerFolderProblem('/Users/me/Downloads', '/Users/me')).toBeNull();
  const saved = [
    pdfTrigger, { ...pdfTrigger, id: 'home', root: '/Users/me/' }, { ...pdfTrigger, id: 'relative', root: 'Downloads' },
    { ...pdfTrigger, id: 'kind', kind: 'video' }, { ...pdfTrigger, id: 'blank', prompt: '  ' }, null, 'x',
  ];
  expect(validTriggers(saved, '/Users/me')).toEqual([pdfTrigger]);
  expect(validTriggers({ not: 'a list' }, '/Users/me')).toEqual([]);
});
