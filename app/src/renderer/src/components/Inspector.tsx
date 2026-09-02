import React from 'react';
import { ChevronDown, Code2, FolderTree, GitBranch, PanelRightClose, Search, TerminalSquare } from 'lucide-react';
import { cn } from '../lib/cn';
import type { InspectorTab, InspectorTabId } from '../inspector.model';
import type { ReviewSnapshot, UiSnapshotCheckpoint } from '../protocol';
import type { GitStatusResult } from '../global';
import { ReviewPanel } from './ReviewPanel';
import { FilesPanel } from './FilesPanel';
import { TerminalPanel } from './TerminalPanel';
import { GitHubPanel } from './GitHubPanel';

const LANE_META: Record<InspectorTabId, { description: string; icon: React.ReactNode }> = {
  files: { description: 'Project files and editor entry point', icon: <FolderTree size={15} /> },
  review: { description: 'Every uncommitted change, yours and Bimax\u2019s', icon: <Code2 size={15} /> },
  terminal: { description: 'A shell in this project folder', icon: <TerminalSquare size={15} /> },
  github: { description: 'Branch position, fetch, pull and push', icon: <GitBranch size={15} /> },
};

/** One contextual Evidence Studio. Lanes live in a picker instead of fighting for a tab strip. */
export function Inspector({
  tabs, active, onTab, onClose,
  review, gitStatus, checkpoints, onRefreshGit, onCommand,
  project, onOpenFile, activeFile,
}: {
  tabs: InspectorTab[];
  active: InspectorTabId | null;
  onTab: (tab: InspectorTabId) => void;
  onClose: () => void;
  review: ReviewSnapshot | null;
  gitStatus: GitStatusResult | null;
  checkpoints: UiSnapshotCheckpoint[] | undefined;
  onRefreshGit: () => void;
  onCommand: (cmd: string) => void;
  project: string;
  onOpenFile: (rel: string) => void;
  /** The file open in the editor, marked in the tree so the panel shows where you are. */
  activeFile?: string | null;
}): React.ReactElement {
  const activeTab = tabs.find((tab) => tab.id === active) ?? null;
  const meta = activeTab ? LANE_META[activeTab.id] : null;

  // No entrance animation of its own: App.tsx wraps this in a SeedRegion, which owns the transform.
  // A second animation on the same property is a race decided by declaration order.
  return (
    <aside className="evidence-studio glass-lens flex h-full min-w-0 flex-col border-l border-line" aria-label="Evidence Studio">
      <header className="evidence-studio-header">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="evidence-studio-icon" aria-hidden>{meta?.icon ?? <Search size={15} />}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[12.5px] font-semibold text-ink">{activeTab?.label ?? 'Evidence Studio'}</span>
              {activeTab?.count !== null && activeTab?.count !== undefined ? (
                <span className="evidence-count">{activeTab.count}</span>
              ) : null}
              {activeTab?.attention ? <span className="size-1.5 rounded-full bg-amber" aria-label="Needs attention" /> : null}
            </div>
            <div className="truncate text-[9.5px] text-faint">{meta?.description ?? 'Task context appears as Bimax produces it'}</div>
          </div>
        </div>

        <div className="relative shrink-0">
          <select
            aria-label="Choose evidence lane"
            value={active ?? ''}
            onChange={(event) => onTab(event.target.value as InspectorTabId)}
            className="evidence-lane-select"
          >
            {tabs.map((tab) => (
              <option key={tab.id} value={tab.id} disabled={!tab.available}>
                {tab.label}{tab.count !== null ? ` · ${tab.count}` : ''}{tab.available ? '' : ' · empty'}
              </option>
            ))}
          </select>
          <ChevronDown size={12} className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-faint" />
        </div>
        <button onClick={onClose} title="Hide the inspector (⌘J)" aria-label="Hide the inspector" className="evidence-close pressable">
          <PanelRightClose size={15} />
        </button>
      </header>

      <div
        role="tabpanel"
        aria-label={activeTab?.label ?? 'Evidence'}
        className={cn(
          'min-h-0 flex-1 text-[12.5px]',
          // Files, Review and Terminal manage their own scrolling and must fill the pane; padding
          // one of them would put a gutter inside a diff and shrink the shell.
          active === 'terminal' ? 'overflow-hidden p-0' : 'p-3',
          active === 'review' || active === 'files' || active === 'terminal' ? 'overflow-hidden' : 'overflow-y-auto',
        )}
      >
        {!activeTab || !activeTab.available ? (
          <div className="inspector-empty">
            <Search size={17} />
            <div>{activeTab?.emptyReason ?? 'Evidence appears here as the task produces it.'}</div>
          </div>
        ) : activeTab.id === 'review' ? (
          <ReviewPanel status={gitStatus} review={review} refresh={onRefreshGit} onCommand={onCommand} checkpoints={checkpoints} />
        ) : activeTab.id === 'files' ? (
          <FilesPanel project={project} onOpenFile={onOpenFile} activeFile={activeFile} />
        ) : activeTab.id === 'terminal' ? (
          <TerminalPanel project={project} visible={activeTab.id === 'terminal'} />
        ) : (
          <GitHubPanel />
        )}
      </div>
    </aside>
  );
}
