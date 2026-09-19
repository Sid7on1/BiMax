import React from 'react';
import {
  AtSign, ChevronLeft, ChevronRight, Circle, Code2, Compass, Eye, FileCode2, FolderTree, GitBranch,
  Maximize2, Minimize2, PanelRightClose, Search, TerminalSquare, X,
} from 'lucide-react';
import { cn } from '../lib/cn';
import type { InspectorTab, InspectorTabId, WorkbenchTab } from '../inspector.model';
import { sameTab } from '../inspector.model';
import type { ReviewSnapshot, UiSnapshotCheckpoint } from '../protocol';
import type { GitStatusResult } from '../global';
import { ReviewPanel } from './ReviewPanel';
import { FilesPanel, insertIntoComposer } from './FilesPanel';
import { TerminalPanel } from './TerminalPanel';
import { GitHubPanel } from './GitHubPanel';
import { EditorPane, openEditorSearch } from './EditorPane';

/**
 * The right panel: one tabbed workbench.
 *
 * It used to be two chromes in one slot — this component with an icon, a title, a subtitle and a
 * `<select>` lane picker, and `EditorPane` with a tab strip of its own — swapped by a mode flag.
 * Two mental models for one piece of screen, and ~54pt of the panel's height spent on a title that
 * the selected tab already states.
 *
 * Now there are three rows and only the third scrolls, which is the shape measured on Cursor's
 * right panel (`front inspo/10-cursor`, plan `12-right-panel-plan.md`):
 *
 *   1. one tab strip — the lanes and every open file, side by side, as chips;
 *   2. a contextual toolbar for the selected tab;
 *   3. the content, flush to the panel's edges.
 *
 * The active chip IS the title. Nothing else names the panel.
 */

const LANE_ICON: Record<InspectorTabId, React.ReactNode> = {
  files: <FolderTree size={12} />,
  review: <Code2 size={12} />,
  terminal: <TerminalSquare size={12} />,
  github: <GitBranch size={12} />,
};

function isMarkdown(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'md' || ext === 'markdown';
}

export function Inspector({
  tabs, active, onTab, onClose,
  review, gitStatus, checkpoints, onRefreshGit, onCommand,
  project, onOpenFile, lastFile,
  openFiles, dirtyFiles, onCloseFile, onDirty,
  wide, onToggleWide,
}: {
  tabs: InspectorTab[];
  active: WorkbenchTab | null;
  onTab: (tab: WorkbenchTab) => void;
  onClose: () => void;
  review: ReviewSnapshot | null;
  gitStatus: GitStatusResult | null;
  checkpoints: UiSnapshotCheckpoint[] | undefined;
  onRefreshGit: () => void;
  onCommand: (cmd: string) => void;
  project: string;
  onOpenFile: (rel: string) => void;
  /** The last file this panel showed. The Files tree marks it, so switching to that lane still
      says where you are — which an open-order guess gets wrong as soon as you change chips. */
  lastFile: string | null;
  /** Open files, in the order they were opened — the second half of the tab strip. */
  openFiles: string[];
  /** Which of them have unsaved edits. Drawn as the chip's dot, and as row 2's save state. */
  dirtyFiles: ReadonlySet<string>;
  onCloseFile: (rel: string) => void;
  onDirty: (rel: string, dirty: boolean) => void;
  wide: boolean;
  onToggleWide: () => void;
}): React.ReactElement {
  const activeLane = active?.kind === 'lane' ? tabs.find((tab) => tab.id === active.id) ?? null : null;
  const activeFile = active?.kind === 'file' ? active.path : null;
  // Preview is per file: switching tabs must not carry one file's preview state onto another's
  // source. A file that is not markdown can never be in preview.
  const [previewing, setPreviewing] = React.useState<Set<string>>(new Set());
  const preview = activeFile !== null && isMarkdown(activeFile) && previewing.has(activeFile);
  const togglePreview = (path: string): void => setPreviewing((set) => {
    const next = new Set(set);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  // The selected chip must be ON SCREEN, which a horizontally scrolling strip does not guarantee:
  // opening the eighth file left the strip showing the first four.
  const activeChip = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    activeChip.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeFile, activeLane?.id]);

  const index = activeFile ? openFiles.indexOf(activeFile) : -1;
  const step = (delta: number): void => {
    const next = openFiles[index + delta];
    if (next !== undefined) onTab({ kind: 'file', path: next });
  };

  // No entrance animation of its own: App.tsx wraps this in a SeedRegion, which owns the transform.
  // A second animation on the same property is a race decided by declaration order.
  return (
    <aside /* Neither the lens ring nor the left border: both drew a line down the join with the
        canvas. See TaskSidebar for the ring, and styles.css for why value alone separates panes now. */
    className="evidence-studio flex h-full min-w-0 flex-col" aria-label="Workbench">
      {/* --- Row 1: every open thing, as one strip ------------------------------------------- */}
      {/*
        `data-files` is what the container query keys off (styles.css): four labelled lane chips
        plus file chips do not fit a 430pt panel, which is the width this one opens at — measured in
        `app/design-preview#workbench`, where the file chips were scrolled clean off the end. Narrow
        AND competing for the room is the condition, so an inactive lane sheds its label only then.
        The selected lane keeps its name because it is the panel's title, and a file always keeps
        its name because the name is the only thing that tells two files apart.
      */}
      <div className="workbench-strip" data-files={openFiles.length > 0 ? '' : undefined}>
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist" aria-label="Workbench tabs">
          {tabs.map((tab) => {
            const isActive = active?.kind === 'lane' && active.id === tab.id;
            return (
              <button
                key={tab.id}
                ref={(node) => { if (isActive) activeChip.current = node; }}
                role="tab"
                type="button"
                aria-selected={isActive}
                disabled={!tab.available}
                title={tab.available ? tab.label : tab.emptyReason}
                /* The label can disappear; the name must not. */
                aria-label={tab.label}
                onClick={() => onTab({ kind: 'lane', id: tab.id })}
                className="workbench-chip"
                data-active={isActive ? '' : undefined}
              >
                <span className="shrink-0 opacity-80" aria-hidden>{LANE_ICON[tab.id]}</span>
                <span className="workbench-chip-label truncate">{tab.label}</span>
                {tab.count !== null ? <span className="evidence-count">{tab.count}</span> : null}
                {tab.attention ? <span className="size-1.5 shrink-0 rounded-full bg-amber" aria-label="Needs attention" /> : null}
              </button>
            );
          })}

          {openFiles.length > 0 && <span className="workbench-strip-divider" aria-hidden />}

          {openFiles.map((path) => {
            const name = path.split('/').pop() ?? path;
            const isActive = sameTab(active, { kind: 'file', path });
            const isDirty = dirtyFiles.has(path);
            return (
              <span
                key={path}
                ref={(node) => { if (isActive) activeChip.current = node; }}
                className="workbench-chip group"
                data-active={isActive ? '' : undefined}
                title={path}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => onTab({ kind: 'file', path })}
                  className="flex min-w-0 cursor-pointer items-center gap-1.5"
                >
                  <FileCode2 size={12} className={cn('shrink-0', isActive ? 'text-ember' : 'text-faint')} />
                  <span className="max-w-[150px] truncate font-mono">{name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onCloseFile(path)}
                  title={isDirty ? 'Close (unsaved changes will be lost)' : 'Close'}
                  aria-label={`Close ${name}`}
                  className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-faint hover:bg-line hover:text-ink"
                >
                  {isDirty ? (
                    <>
                      <Circle size={7} fill="currentColor" className="text-ember group-hover:hidden" />
                      <X size={11} className="hidden group-hover:block" />
                    </>
                  ) : <X size={11} />}
                </button>
              </span>
            );
          })}
        </div>

        <span className="flex shrink-0 items-center gap-0.5 pl-1">
          <button
            type="button"
            onClick={onToggleWide}
            title={wide ? 'Give the width back to the conversation' : 'Widen this panel'}
            aria-label={wide ? 'Restore the panel width' : 'Widen the panel'}
            className="evidence-close pressable"
          >
            {wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            onClick={onClose}
            title="Hide the panel (⌘J)"
            aria-label="Hide the panel"
            className="evidence-close pressable"
          >
            <PanelRightClose size={15} />
          </button>
        </span>
      </div>

      {/* --- Row 2: the selected tab's own controls ------------------------------------------
          A file tab only. The four lanes already carry their controls inside their panels —
          Files its filter, Review its refresh and branch row, Terminal its restart, GitHub its
          fetch/pull/push — and lifting them into a second bar would DUPLICATE them, which is the
          opposite of what deleting the title block was for. See `13-right-panel-applied.md`. */}
      {activeFile !== null && (
        <div className="workbench-toolbar">
          <button
            type="button" onClick={() => step(-1)} disabled={index <= 0}
            title="Previous file" aria-label="Previous file" className="workbench-tool"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button" onClick={() => step(1)} disabled={index < 0 || index >= openFiles.length - 1}
            title="Next file" aria-label="Next file" className="workbench-tool"
          >
            <ChevronRight size={14} />
          </button>

          <span className="min-w-0 flex-1 truncate pl-1 text-[11px] text-faint">
            {activeFile.split('/').slice(0, -1).map((part, i) => (
              <React.Fragment key={i}>{part}<span className="px-1 opacity-50">›</span></React.Fragment>
            ))}
            <span className="font-medium text-dim">{activeFile.split('/').pop()}</span>
          </span>

          <span className="shrink-0 text-[10px] text-faint">
            {dirtyFiles.has(activeFile) ? 'modified — ⌘S' : 'saved'}
          </span>

          {isMarkdown(activeFile) && (
            <span className="workbench-segment">
              <button
                type="button" onClick={() => { if (preview) togglePreview(activeFile); }}
                data-active={preview ? undefined : ''} title="Show the source"
              >
                Source
              </button>
              <button
                type="button" onClick={() => { if (!preview) togglePreview(activeFile); }}
                data-active={preview ? '' : undefined} title="Render the markdown"
              >
                <Eye size={11} /> Preview
              </button>
            </span>
          )}

          <button
            type="button" onClick={() => openEditorSearch()} disabled={preview}
            title="Find in this file (⌘F)" aria-label="Find in this file" className="workbench-tool"
          >
            <Search size={13} />
          </button>
          <button
            type="button" onClick={() => insertIntoComposer(`@${activeFile} `)}
            title="Insert @path into the composer" aria-label="Insert path into the composer" className="workbench-tool"
          >
            <AtSign size={13} />
          </button>
          <button
            type="button" onClick={() => void window.bimax.files.reveal(activeFile)}
            title="Reveal in Finder" aria-label="Reveal in Finder" className="workbench-tool"
          >
            <Compass size={13} />
          </button>
        </div>
      )}

      {/* --- Row 3: the content, flush ------------------------------------------------------- */}
      <div
        role="tabpanel"
        aria-label={activeFile ?? activeLane?.label ?? 'Workbench'}
        className={cn(
          'min-h-0 flex-1 text-[12.5px]',
          // Files, Review, Terminal and the editor manage their own scrolling and must fill the
          // pane; padding one of them would put a gutter inside a diff and shrink the shell.
          activeFile !== null || active?.kind === 'lane' && active.id === 'terminal' ? 'overflow-hidden p-0' : 'p-3',
          active?.kind === 'lane' && (active.id === 'review' || active.id === 'files') ? 'overflow-hidden' : '',
          activeLane && !['review', 'files', 'terminal'].includes(activeLane.id) ? 'overflow-y-auto' : '',
        )}
      >
        {activeFile !== null ? (
          <EditorPane
            active={activeFile}
            project={project}
            onClose={onCloseFile}
            onDirty={onDirty}
            preview={preview}
          />
        ) : !activeLane || !activeLane.available ? (
          <div className="inspector-empty">
            <Search size={17} />
            <div>{activeLane?.emptyReason ?? 'Evidence appears here as the task produces it.'}</div>
          </div>
        ) : activeLane.id === 'review' ? (
          <ReviewPanel status={gitStatus} review={review} refresh={onRefreshGit} onCommand={onCommand} checkpoints={checkpoints} />
        ) : activeLane.id === 'files' ? (
          <FilesPanel project={project} onOpenFile={onOpenFile} activeFile={lastFile} />
        ) : activeLane.id === 'terminal' ? (
          <TerminalPanel project={project} visible />
        ) : (
          <GitHubPanel />
        )}
      </div>
    </aside>
  );
}
