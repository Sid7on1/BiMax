import { ThreadManager } from '../main/thread.manager';
import {
  applyReport, cleanGoal, filesToCheck, forgetGone, outcomeEnvironment, outcomeQueue, outcomeTaskWords, queueLine, validOutcomes,
  type FolderOutcome,
} from '../main/folder.outcomes';

/** Backlog FL1 part 2: "keep this folder ready for my accountant", with a queue of what is ready and what needs you. */

const root = '/Users/me/receipts';
const blank = (): FolderOutcome => ({ root, goal: 'Receipts as dated PDFs by month.', createdAt: 1, triggerId: 't1', items: {} });

test('a run’s report becomes the queue: needs-you oldest first with the reason, ready by name', () => {
  let o = applyReport(blank(), [
    { path: `${root}/scan 12.jpg`, state: 'needs-you', reason: 'No date — which month?' },
    { path: `${root}/2026-09/2026-09-03 Cafe.pdf`, state: 'ready' },
  ], 'thread-a', 100);
  o = applyReport(o, [
    { path: `${root}/b.png`, state: 'needs-you', reason: 'Blurry; rescan it.' },
    { path: `${root}/2026-08/2026-08-01 Bus.pdf`, state: 'ready', reason: 'ignored for ready' },
  ], 'thread-b', 200);
  expect(outcomeQueue(o)).toEqual({
    needsYou: [{ path: 'scan 12.jpg', reason: 'No date — which month?' }, { path: 'b.png', reason: 'Blurry; rescan it.' }],
    ready: ['2026-08/2026-08-01 Bus.pdf', '2026-09/2026-09-03 Cafe.pdf'],
  });
  expect(o.items['2026-08/2026-08-01 Bus.pdf']).toEqual({ state: 'ready', at: 200, threadId: 'thread-b' });
  expect(queueLine(outcomeQueue(o))).toBe('2 need you · 2 ready');
  // A later report for the same file replaces the earlier one.
  o = applyReport(o, [{ path: `${root}/scan 12.jpg`, state: 'ready' }], 'thread-c', 300);
  expect(queueLine(outcomeQueue(o))).toBe('1 needs you · 3 ready');
});

test('reports about other places, the folder itself, or with a bad state are ignored', () => {
  const o = applyReport(blank(), [
    { path: '/Users/me/other/a.pdf', state: 'ready' },
    { path: root, state: 'ready' },
    { path: `${root}/../x.pdf`, state: 'ready' },
    { path: 'relative.pdf', state: 'ready' },
    { path: `${root}/a.pdf`, state: 'done' },
    { path: 7, state: 'ready' },
  ], 't', 1);
  expect(o.items).toEqual({});
  expect(queueLine(outcomeQueue(o))).toBe('Nothing checked yet');
});

test('files that are gone leave the queue', () => {
  const o = applyReport(blank(), [{ path: `${root}/a.pdf`, state: 'ready' }, { path: `${root}/b.pdf`, state: 'needs-you', reason: 'x' }], 't', 1);
  const kept = forgetGone(o, (file) => file === `${root}/a.pdf`);
  expect(Object.keys(kept.items)).toEqual(['a.pdf']);
  expect(forgetGone(o, () => true)).toBe(o);
});

test('the engine gets the outcome, and each run is told to report every file with the tool', () => {
  expect(outcomeEnvironment(blank())).toEqual({ BIMAX_FOLDER_OUTCOME: 'Receipts as dated PDFs by month.' });
  expect(outcomeEnvironment(undefined)).toEqual({});
  const words = outcomeTaskWords('Receipts as dated PDFs by month.');
  expect(words).toContain('Keep this folder ready: Receipts as dated PDFs by month.');
  expect(words).toContain('FolderStatusTool');
  expect(words).toContain('ask before changing anything');
  expect(cleanGoal('  my\n accountant  ')).toBe('my accountant');
  expect(cleanGoal('x'.repeat(700))).toHaveLength(600);
  expect(cleanGoal(3)).toBe('');
});

test('saved outcomes are re-checked', () => {
  const good = applyReport(blank(), [{ path: `${root}/a.pdf`, state: 'ready' }], 't', 5);
  expect(validOutcomes({
    [root]: good,
    '/Users/me': { ...good, root: '/Users/me' },
    '/': { ...good, root: '/' },
    '/elsewhere': { ...good },
    '/Users/me/nogoal': { ...good, root: '/Users/me/nogoal', goal: '  ' },
    '/Users/me/notrigger': { ...good, root: '/Users/me/notrigger', triggerId: '' },
    '/Users/me/items': { ...good, root: '/Users/me/items', items: { '../x': { state: 'ready', at: 1 }, 'ok.pdf': { state: 'odd', at: 1 }, 'b.pdf': { state: 'needs-you', reason: 'r', at: 2 } } },
  }, '/Users/me')).toEqual({
    [root]: good,
    '/Users/me/items': { ...good, root: '/Users/me/items', items: { 'b.pdf': { state: 'needs-you', reason: 'r', at: 2 } } },
  });
  expect(validOutcomes(null, '/Users/me')).toEqual({});
});

test('a first check looks at visible files directly in the folder, at most 50', () => {
  expect(filesToCheck(['b.pdf', '.DS_Store', '~$draft.docx', 'a.pdf'], root)).toEqual([`${root}/a.pdf`, `${root}/b.pdf`]);
  expect(filesToCheck(Array.from({ length: 60 }, (_, i) => `f${i}.pdf`), root)).toHaveLength(50);
});

test('the thread manager hands a task’s report to the app', () => {
  const folderStatus = jest.fn();
  const manager = new ThreadManager({
    engine: () => ({ sendFromRenderer: jest.fn(), dispose: jest.fn(), openProject: jest.fn() }) as any,
    selected: jest.fn(), message: jest.fn(), approval: jest.fn(), save: jest.fn(), saveNow: jest.fn(), changed: jest.fn(), folderStatus,
  } as any, []);
  const id = manager.create(root, 'Receipts');
  manager.receive(id, { t: 'ready', protocol: 3 } as any);
  const items = [{ path: `${root}/a.pdf`, state: 'ready' }];
  manager.receive(id, { t: 'event', name: 'folder_status', args: [{ items }] } as any);
  manager.receive(id, { t: 'event', name: 'folder_status', args: [{ items: 'nope' }] } as any);
  expect(folderStatus).toHaveBeenCalledTimes(1);
  expect(folderStatus).toHaveBeenCalledWith(id, items);
});

test('needs-you waits in the order it was reported, whatever order the files were written in', () => {
  let o = applyReport(blank(), [{ path: `${root}/late.pdf`, state: 'needs-you', reason: 'second' }], 't', 300);
  o = applyReport(o, [{ path: `${root}/early.pdf`, state: 'needs-you', reason: 'first' }], 't', 100);
  expect(outcomeQueue(o).needsYou.map((item) => item.path)).toEqual(['early.pdf', 'late.pdf']);
});

test('a relative path is never read against wherever Bimax happens to be running', () => {
  const here = { ...blank(), root: process.cwd() };
  expect(applyReport(here, [{ path: 'relative.pdf', state: 'ready' }], 't', 1).items).toEqual({});
});
