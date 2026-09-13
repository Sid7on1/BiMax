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
}
export interface ThreadSelection { id: string; state: EngineUiState }
/** The tallest the ⌘2 bar may grow, as a share of its screen's work area (main clamps, the bar follows text at it). */
export const QUICK_BAR_MAX_HEIGHT_SHARE = 0.72;
export interface ThreadList { activeId: string | null; threads: ThreadSummary[]; shortcutAvailable: boolean }
/** Something the person had open when they pressed ⌘2, or dropped on the bar, offered to the task as context. */
export interface QuickAttachment { kind: 'file' | 'page' | 'document'; label: string; path?: string; url?: string }
export interface QuickContext { root: string | null; source: string; error?: string; attachments?: QuickAttachment[] }
/** The thread the ⌘2 bar is showing, with its transcript state, so a reopened bar picks up where it was. */
export interface QuickThread { id: string; title: string; root: string; state: EngineUiState }
export interface ThreadApproval { threadId: string; title: string; root: string; request: RequestMsg; token: string }

/**
 * A ⌘2 task (or a thread saved before origins existed), as opposed to a project opened in the main window. A project
 * runs as a thread too, but it belongs in Recents: only these are listed in the Threads section and the menu bar.
 */
export function isQuickThread(thread: Pick<ThreadSummary, 'origin'>): boolean {
  return thread.origin !== 'project';
}
