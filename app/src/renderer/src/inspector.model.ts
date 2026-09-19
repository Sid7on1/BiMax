import type { ReviewSnapshot } from './protocol';
import type { GitStatusResult } from './global';

/**
 * The right panel's four lanes.
 *
 * This used to carry eight (Changes, Browser, Team, Runtime, Environment, Alchemist, Receipt,
 * Files). Six of them reported on the machine rather than on the work — runtime profiles, backend
 * readiness, agent rosters — so the panel spent most of its width telling you about itself, and
 * most lanes were unavailable most of the time. What a coding IDE's side panel is actually for is
 * the four things you reach for while working: the files, the diff, a shell, and the remote.
 *
 * `available: false` lanes are still returned with the reason they are empty. A lane that silently
 * disappears reads as a bug — but nothing may auto-open an unavailable lane.
 */

export type InspectorTabId = 'files' | 'review' | 'terminal' | 'github';

export interface InspectorTab {
  id: InspectorTabId;
  label: string;
  available: boolean;
  /** Why the lane is empty, in plain language. Shown as the lane's empty state. */
  emptyReason: string;
  /** Small count badge, when the evidence is countable. */
  count: number | null;
  /** Set when this lane needs the user's attention right now. */
  attention: boolean;
}

export interface InspectorInput {
  review: ReviewSnapshot | null;
  gitStatus: GitStatusResult | null;
  /** A project is open, so the file tree and a shell are meaningful. */
  hasProject: boolean;
  /** The folder is a git repository (the GitHub lane needs one). */
  isRepo?: boolean;
  /** Commits waiting to be pushed — the GitHub lane's badge. */
  ahead?: number;
  /** Commits waiting to be pulled; worth attention because local work may conflict. */
  behind?: number;
}

export function inspectorTabs(input: InspectorInput): InspectorTab[] {
  const changed = input.gitStatus?.files.length ?? 0;
  const reviewChanges = input.review?.changes.length ?? 0;
  const reviewCount = Math.max(changed, reviewChanges);
  const verificationFailed = input.review?.state === 'verification_failed';

  return [
    {
      id: 'files',
      label: 'Files',
      available: input.hasProject,
      emptyReason: 'Open a project to browse its files.',
      count: null,
      attention: false,
    },
    {
      id: 'review',
      label: 'Review',
      // The whole diff, not only what this task touched: reviewing your own edits next to the
      // agent's is the normal case, and a lane that hid yours was answering a narrower question
      // than the one being asked.
      available: input.hasProject,
      emptyReason: 'No uncommitted changes in this project.',
      count: reviewCount || null,
      attention: verificationFailed,
    },
    {
      id: 'terminal',
      label: 'Terminal',
      available: input.hasProject,
      emptyReason: 'Open a project to get a shell in it.',
      count: null,
      attention: false,
    },
    {
      id: 'github',
      label: 'GitHub',
      available: input.isRepo === true,
      emptyReason: 'This folder is not a git repository.',
      count: input.ahead || null,
      attention: (input.behind ?? 0) > 0,
    },
  ];
}

/**
 * Pick the lane to show.
 *
 * A user's explicit choice always wins while it is still available. Otherwise the lane that needs
 * attention wins, then the first available lane. Never returns an unavailable lane.
 */
export function resolveActiveTab(
  tabs: InspectorTab[],
  requested: InspectorTabId | null,
): InspectorTabId | null {
  const chosen = requested ? tabs.find(tab => tab.id === requested) : undefined;
  if (chosen?.available) return chosen.id;
  return tabs.find(tab => tab.available && tab.attention)?.id
    ?? tabs.find(tab => tab.available)?.id
    ?? null;
}

/**
 * What the workbench is showing.
 *
 * The right panel used to be two components in one slot, chosen by a mode flag
 * (`inspectorOpen && openFiles.length > 0 && activeFile !== null && requestedTab === null`). Four
 * conditions, one of them the ABSENCE of a lane request, which is why opening a file from the
 * Files lane looked like it did nothing: every other piece of state was right and the stale lane
 * request kept the tree on screen.
 *
 * A lane and an open file are the same kind of thing — a tab — so they are one type. Selecting a
 * tab is now the only state, and there is no flag left to disagree with it.
 */
export type WorkbenchTab =
  | { kind: 'lane'; id: InspectorTabId }
  | { kind: 'file'; path: string };

export function sameTab(a: WorkbenchTab | null, b: WorkbenchTab | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'lane' && b.kind === 'lane') return a.id === b.id;
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path;
  return false;
}

/**
 * Pick the tab to show.
 *
 * A file the user asked for wins while it is still open; a file that has been closed falls back to
 * the last one still open, so closing the tab you are looking at lands on its neighbour rather than
 * on an empty pane. With no live file request this is exactly `resolveActiveTab` — an explicit lane,
 * then the lane needing attention, then the first available one — and a file only takes over when
 * no lane at all is available, which is how a project-less window still shows something.
 */
export function resolveWorkbenchTab(
  tabs: InspectorTab[],
  requested: WorkbenchTab | null,
  openFiles: readonly string[],
): WorkbenchTab | null {
  if (requested?.kind === 'file') {
    if (openFiles.includes(requested.path)) return requested;
    const fallback = openFiles[openFiles.length - 1];
    if (fallback !== undefined) return { kind: 'file', path: fallback };
  }
  const lane = resolveActiveTab(tabs, requested?.kind === 'lane' ? requested.id : null);
  if (lane) return { kind: 'lane', id: lane };
  const last = openFiles[openFiles.length - 1];
  return last === undefined ? null : { kind: 'file', path: last };
}
