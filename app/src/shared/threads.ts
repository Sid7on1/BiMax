import type { EngineUiState } from '../renderer/src/engine.state';
import type { RequestMsg } from '../renderer/src/protocol';

export interface ThreadSummary {
  id: string;
  title: string;
  root: string;
  updatedAt: number;
  status: 'idle' | 'starting' | 'working' | 'needs-you' | 'stopped';
  peers: string[];
  sessionId?: string;
  /** Where the thread came from: the ⌘2 bar, or a project opened in the main window. Absent on threads saved before origins existed. */
  origin?: 'quick' | 'project';
  /** The model this task answers with, when it is not Bimax's own (the ⌘2 model menu, "Retry with…"). */
  model?: string;
  /** A talk-mode task (the ⌘2 bar's spoken conversation): its engine writes replies to be read aloud. */
  voice?: boolean;
  /** How the last turn ended (backlog N12). Cleared when the next turn starts. */
  outcome?: 'completed' | 'failed' | 'interrupted';
  /** Messages accepted and not yet sent to the engine. Filled in for lists; never saved. */
  queued?: number;
  /** Why queued messages wait: another task holds the folder, the engine is not ready, or the task is stopped. Never saved. */
  waiting?: 'folder' | 'engine' | 'resume';
}
export interface ThreadSelection { id: string; state: EngineUiState }
/** The tallest the ⌘2 bar may grow, as a share of its screen's work area (main clamps, the bar follows text at it). */
export const QUICK_BAR_MAX_HEIGHT_SHARE = 0.72;
export interface ThreadList {
  activeId: string | null;
  threads: ThreadSummary[];
  shortcutAvailable: boolean;
  /** How many threads are archived (backlog N11); absent from older main processes. */
  archivedCount?: number;
}
/** Something the person had open when they pressed ⌘2, or dropped on the bar, offered to the task as context. */
export interface QuickAttachment { kind: 'file' | 'page' | 'document'; label: string; path?: string; url?: string }
export interface QuickContext { root: string | null; source: string; error?: string; attachments?: QuickAttachment[] }
/** The thread the ⌘2 bar is showing, with its transcript state, so a reopened bar picks up where it was. */
export interface QuickThread {
  id: string;
  title: string;
  root: string;
  state: EngineUiState;
  /** Messages the task has queued, and what the footer says instead of the folder name (backlog N12). */
  queued?: number;
  notice?: string | null;
}
export interface ThreadApproval { threadId: string; title: string; root: string; request: RequestMsg; token: string }

/**
 * A ⌘2 task (or a thread saved before origins existed), as opposed to a project opened in the main window. A project
 * runs as a thread too, but it belongs in Recents: only these are listed in the Threads section and the menu bar.
 */
export function isQuickThread(thread: Pick<ThreadSummary, 'origin'>): boolean {
  return thread.origin !== 'project';
}

type ActivityFields = Pick<ThreadSummary, 'status' | 'outcome' | 'queued' | 'waiting'>;

/**
 * A thread's state in plain words (backlog N12): `label` for the sidebar, and `short` after a title in the menu bar
 * (empty when there is nothing to add). A task with queued work used to show "idle"; now it says what it waits for.
 */
export function threadActivity(t: ActivityFields): { label: string; short: string } {
  const n = t.queued ?? 0;
  const queued = `${n} message${n === 1 ? '' : 's'} queued`;
  const also = (label: string): string => (n ? `${label} · ${queued}` : label);
  if (t.status === 'working') return { label: also('Working'), short: 'working' };
  if (t.status === 'needs-you') return { label: also('Needs your decision'), short: 'needs you' };
  if (t.status === 'starting') return { label: also('Starting'), short: 'working' };
  if (t.waiting === 'resume') return { label: `Stopped · ${queued}, sent when it resumes`, short: 'messages kept' };
  if (t.waiting === 'folder') return { label: `Waiting for another task in this folder · ${queued}`, short: 'waiting for its folder' };
  if (n) return { label: `Waiting to start · ${queued}`, short: 'waiting' };
  if (t.outcome === 'failed') return { label: 'Failed', short: 'failed' };
  if (t.outcome === 'interrupted') return { label: 'Interrupted', short: 'interrupted' };
  if (t.status === 'stopped') return { label: 'Stopped', short: '' };
  return { label: t.outcome === 'completed' ? 'Done' : 'Idle', short: '' };
}

/** What the ⌘2 bar's footer says in place of the folder name, or null when the bar's own working and question states say it. */
export function threadNotice(t: ActivityFields): string | null {
  if (t.status === 'working' || t.status === 'needs-you') return null;
  if (!t.queued && t.outcome !== 'failed' && t.outcome !== 'interrupted') return null;
  return threadActivity(t).label;
}
