import { nextQuickThread, trayEntries, trayTitle, trayTooltip } from '../main/thread.tray';
import type { ThreadSummary } from '../shared/threads';

const thread = (id: string, status: ThreadSummary['status'], updatedAt: number, extra: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({ id, title: `Task ${id}`, root: '/x', updatedAt, status, peers: [], ...extra });

test('the menu bar says how many tasks are running and how many wait for a decision', () => {
  expect(trayTitle([thread('a', 'idle', 1), thread('b', 'stopped', 2)])).toBe('⌘2');
  expect(trayTitle([thread('a', 'working', 1), thread('b', 'idle', 2)])).toBe('⌘2 1');
  expect(trayTitle([thread('a', 'working', 1), thread('b', 'needs-you', 2)])).toBe('⌘2 2 · 1 waiting');
  expect(trayTooltip([thread('a', 'needs-you', 1)])).toBe('Bimax — 1 task running, 1 waiting for your decision');
});

test('the menu lists the newest tasks first with their state', () => {
  const entries = trayEntries([thread('old', 'idle', 1), thread('new', 'needs-you', 3), thread('mid', 'working', 2)]);
  expect(entries.map((e) => e.id)).toEqual(['new', 'mid', 'old']);
  expect(entries[0].label).toBe('● Task new — needs you');
  expect(entries[1].label).toBe('◐ Task mid — working');
  expect(entries[2].label).toBe('○ Task old');
});

test('⌘[ goes to older bar tasks and ⌘] to newer ones, skipping projects', () => {
  const list = [thread('p', 'idle', 5, { origin: 'project' }), thread('q3', 'idle', 4, { origin: 'quick' }), thread('q2', 'idle', 3), thread('q1', 'idle', 2, { origin: 'quick' })];
  expect(nextQuickThread(list, null, 'older')).toBe('q3');
  expect(nextQuickThread(list, 'q3', 'older')).toBe('q2');
  expect(nextQuickThread(list, 'q2', 'newer')).toBe('q3');
  expect(nextQuickThread(list, 'q3', 'newer')).toBeNull();
  expect(nextQuickThread(list, 'q1', 'older')).toBeNull();
  expect(nextQuickThread([], null, 'older')).toBeNull();
});
