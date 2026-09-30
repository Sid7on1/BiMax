/**
 * How many Bimax Threads the sidebar lists before "Show more" (fix list item 6).
 *
 * The Threads section listed every thread, so it grew without bound and pushed Recents off the panel
 * ("expanding it to hell"). It now shows the first five, and the one you are in is always among them —
 * a list that hides the current thread behind "Show more" would lose your place in exchange for tidiness.
 */
export const THREADS_PAGE = 5;

export function visibleThreads<T extends { id: string }>(
  threads: readonly T[], activeId: string | null, expanded: boolean, page = THREADS_PAGE,
): { shown: T[]; hidden: number } {
  if (expanded || threads.length <= page) return { shown: [...threads], hidden: 0 };
  const first = threads.slice(0, page);
  const active = activeId ? threads.find((thread) => thread.id === activeId) : undefined;
  // The active thread past the fold takes the last visible slot; the list stays five long.
  const shown = active && !first.includes(active) ? [...first.slice(0, page - 1), active] : first;
  return { shown, hidden: threads.length - shown.length };
}
