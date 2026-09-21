import { ThreadManager } from '../main/thread.manager';
import { arrivalsSince, cleanBookmark, openTodos, whereWasI } from '../main/where.was.i';

/** Backlog FL7: "Where was I?" — a bookmark in your own words, and what happened since. */

const T0 = Date.UTC(2026, 8, 22, 9);
const msg = (role: string, content: string, at: number) => ({ kind: 'msg', msg: { id: String(at), role, content, timestamp: new Date(at).toISOString() } }) as any;
const todo = (todos: Array<{ content: string; status: string }>, status = 'success', parentId?: string) =>
  ({ kind: 'tool', call: { id: 't', toolName: 'TodoWriteTool', input: JSON.stringify({ todos }), output: '', status, startTime: '', ...(parentId ? { parentId } : {}) } }) as any;

test('a bookmark is one line in the person’s words', () => {
  expect(cleanBookmark('  waiting on\n Priya  ', T0)).toEqual({ note: 'waiting on Priya', at: T0 });
  expect(cleanBookmark('   ', T0)).toBeNull();
  expect(cleanBookmark(3, T0)).toBeNull();
  expect(cleanBookmark('x'.repeat(400), T0)!.note).toHaveLength(300);
});

test('what is still open comes from the task’s last checklist', () => {
  expect(openTodos([
    todo([{ content: 'old', status: 'pending' }]),
    todo([{ content: 'Compare quotes', status: 'completed' }, { content: 'Tax column', status: 'in_progress' }, { content: 'Send', status: 'pending' }]),
    todo([{ content: 'sub-agent list', status: 'pending' }], 'success', 'p1'),
    todo([{ content: 'failed write', status: 'pending' }], 'error'),
  ])).toEqual(['Tax column', 'Send']);
  expect(openTodos([])).toEqual([]);
});

test('what happened since: changes, answers and arrivals after the bookmark only', () => {
  const items = [msg('assistant', 'before the bookmark', T0 - 1000), msg('user', 'more', T0 + 1000), msg('assistant', 'First answer.', T0 + 2000), msg('assistant', 'Done: the  tax\ncolumn is filled.', T0 + 3000)];
  const where = whereWasI({
    bookmark: { note: 'waiting on Priya', at: T0 },
    items,
    changes: [{ title: 'old change', at: T0 - 5 }, { title: 'Edit a.csv', at: T0 + 10 }, { title: 'Edit b.csv', at: T0 + 20 }],
    arrivals: ['quote-3.pdf'],
  });
  expect(where).toEqual({
    note: 'waiting on Priya', at: T0, open: [],
    since: ['2 changes: Edit a.csv; Edit b.csv', '2 answers; the last: “Done: the tax column is filled.”', '1 new file in the folder: quote-3.pdf'],
  });
  expect(whereWasI({ bookmark: { note: 'n', at: T0 }, items: [], changes: [], arrivals: [] }).since).toEqual([]);
});

test('arrivals are visible files born after the bookmark, newest first', () => {
  expect(arrivalsSince([
    { name: 'old.pdf', born: T0 - 1, isFile: true },
    { name: 'a.pdf', born: T0 + 5, isFile: true },
    { name: 'b.pdf', born: T0 + 9, isFile: true },
    { name: '.DS_Store', born: T0 + 9, isFile: true },
    { name: 'New Folder', born: T0 + 9, isFile: false },
  ], T0)).toEqual(['b.pdf', 'a.pdf']);
});

test('a bookmark is kept with the task, survives a restart, and can be removed', () => {
  const saved: any[] = [];
  const deps = () => ({ engine: () => ({ sendFromRenderer: jest.fn(), dispose: jest.fn(), openProject: jest.fn() }), selected: jest.fn(), message: jest.fn(), approval: jest.fn(), save: (v: any) => saved.push(v), saveNow: (v: any) => saved.push(v), changed: jest.fn() }) as any;
  const first = new ThreadManager(deps(), []);
  const id = first.create('/Users/me/quotes', '');
  first.setBookmark(id, { note: 'waiting on Priya', at: T0 });
  const again = new ThreadManager(deps(), [saved[saved.length - 1]]);
  expect(again.summary(id).bookmark).toEqual({ note: 'waiting on Priya', at: T0 });
  again.setBookmark(id, null);
  expect(again.summary(id).bookmark).toBeUndefined();
});
