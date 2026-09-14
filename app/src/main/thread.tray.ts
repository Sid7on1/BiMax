import { isQuickThread, threadActivity, type ThreadSummary } from '../shared/threads';

/**
 * The menu bar item and the bar's task switching. Pure, so the wording and the ordering can be tested without
 * Electron: how many threads are running or waiting, which recent ones the menu lists, and which task ⌘[ / ⌘]
 * move to. Only ⌘2 tasks count: projects opened in the main window live in Recents.
 */
const ACTIVE = new Set<ThreadSummary['status']>(['working', 'starting', 'needs-you']);

function counts(threads: readonly ThreadSummary[]): { active: number; waiting: number } {
  const quick = threads.filter(isQuickThread);
  return { active: quick.filter((t) => ACTIVE.has(t.status)).length, waiting: quick.filter((t) => t.status === 'needs-you').length };
}

export function trayTitle(threads: readonly ThreadSummary[]): string {
  const { active, waiting } = counts(threads);
  if (!active) return '⌘2';
  return waiting ? `⌘2 ${active} · ${waiting} waiting` : `⌘2 ${active}`;
}

export function trayTooltip(threads: readonly ThreadSummary[]): string {
  const { active, waiting } = counts(threads);
  if (!active) return 'Bimax — no tasks running. Press ⌘2 anywhere to start one.';
  return `Bimax — ${active} task${active === 1 ? '' : 's'} running${waiting ? `, ${waiting} waiting for your decision` : ''}`;
}

const GLYPH: Record<ThreadSummary['status'], string> = { working: '◐', starting: '◐', 'needs-you': '●', idle: '○', stopped: '○' };

/** The most recent threads for the menu, newest first, each with a status glyph and a short title. */
export function trayEntries(threads: readonly ThreadSummary[], limit = 8): Array<{ id: string; label: string }> {
  return threads.filter(isQuickThread).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map((t) => {
    const title = t.title.length > 44 ? `${t.title.slice(0, 43)}…` : t.title;
    const { short } = threadActivity(t);
    return { id: t.id, label: `${GLYPH[t.status]} ${title}${short ? ` — ${short}` : ''}` };
  });
}

/**
 * ⌘[ and ⌘] in the bar: step through the bar's own recent tasks (not projects opened in the main window), newest
 * first. `older` moves down the list and `newer` up; with no current task, `older` picks the newest.
 */
export function nextQuickThread(threads: readonly ThreadSummary[], currentId: string | null, direction: 'older' | 'newer'): string | null {
  const quick = threads.filter(isQuickThread).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!quick.length) return null;
  const index = currentId ? quick.findIndex((t) => t.id === currentId) : -1;
  const next = index === -1 ? (direction === 'older' ? 0 : -1) : index + (direction === 'older' ? 1 : -1);
  return next >= 0 && next < quick.length ? quick[next].id : null;
}
