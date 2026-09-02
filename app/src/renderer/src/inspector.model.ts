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
