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
}
export interface ThreadSelection { id: string; state: EngineUiState }
export interface ThreadList { activeId: string | null; threads: ThreadSummary[]; shortcutAvailable: boolean }
export interface QuickContext { root: string | null; source: string; error?: string }
/** The thread the ⌘2 bar is showing, with its transcript state, so a reopened bar picks up where it was. */
export interface QuickThread { id: string; title: string; root: string; state: EngineUiState }
export interface ThreadApproval { threadId: string; title: string; root: string; request: RequestMsg; token: string }
