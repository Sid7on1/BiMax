import React from 'react';
import {
  AtSign, ChevronDown, ChevronLeft, ChevronRight, Circle, Code2, Compass, Eye, FileCode2, FolderTree,
  GitBranch, Maximize2, Minimize2, MoreHorizontal, PanelRightClose, Search, TerminalSquare, X,
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
import { SeedMenu, SeedMenuItem, SeedMenuLabel, SeedMenuSeparator } from './ui/morph/SeedMenu';

/**
 * The right panel: one workbench with one way in.
 *
 * It was two chromes in one slot — this component with an icon, a title, a subtitle and a `<select>`,
 * and `EditorPane` with a tab strip of its own — swapped by a mode flag. The merge into one tabbed
 * strip fixed the state and made the chrome worse: four lane chips plus a chip per open file is
 * eight controls fighting over 430pt, and the owner's verdict was the right one — the panel read as
 * cluttered, and the `<select>` it replaced had at least been calm.
 *
 * So: ONE picker, and everything is in it, grouped.
 *
 *   1. the picker — what the panel is showing, and the menu that changes it: the four lanes under
 *      Evidence, every open file under Open files. Plus the two panel controls, widen and hide.
 *   2. a contextual toolbar, for a file tab only: step, breadcrumb, save state, Source|Preview for
 *      markdown, find, and the secondary verbs behind one overflow.
 *   3. the content, flush to the panel's edges.
 *
 * The picker states the current view, so it is the panel's title as well as its control — which is
 * why there is no title block above it. See `front inspo/13-right-panel-applied.md`.
 */

const LANE_ICON: Record<InspectorTabId, React.ReactNode> = {
  files: <FolderTree size={13} />,
  review: <Code2 size={13} />,
  terminal: <TerminalSquare size={13} />,
  github: <GitBranch size={13} />,
};

/** What each lane is for, one line, shown under its name in the picker. */
const LANE_DESC: Record<InspectorTabId, string> = {
  files: 'Browse and open project files',
  review: 'Every uncommitted change, yours and Bimax’s',
  terminal: 'A shell in this project folder',
  github: 'Branch position, fetch, pull and push',
};

function isMarkdown(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'md' || ext === 'markdown';
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

function fileDir(path: string): string {
  return path.split('/').slice(0, -1).join(' › ');
}

/**
 * The picker's face: what the panel is showing right now.
 *
 * Same grammar as the composer's pills — rounded, quiet at rest, ember while its menu is open —
 * one size up, because here it is also the panel's title.
 */
function PickerTrigger({
  open, icon, label, count, attention, dirty, mono,
}: {
  open: boolean;
  icon: React.ReactNode;
  label: string;
  count?: number | null;
  attention?: boolean;
  dirty?: boolean;
  mono?: boolean;
}): React.ReactElement {
  return (
    <span
      className={cn(
        'flex min-w-0 max-w-[260px] items-center gap-2 overflow-hidden rounded-xl px-2.5 py-1.5 transition-colors',
        open ? 'bg-ember/12 text-ember' : 'text-ink hover:bg-hover',
      )}
    >
      <span className={cn('shrink-0', open ? 'text-ember' : 'text-faint')}>{icon}</span>
      <span className={cn('truncate text-[12.5px] font-medium', mono && 'font-mono text-[11.5px]')}>{label}</span>
      {count !== null && count !== undefined ? <span className="evidence-count shrink-0">{count}</span> : null}
      {attention ? <span className="size-1.5 shrink-0 rounded-full bg-amber" aria-label="Needs attention" /> : null}
      {dirty ? <Circle size={7} fill="currentColor" className="shrink-0 text-ember" aria-label="Unsaved changes" /> : null}
      <ChevronDown size={11} className={cn('shrink-0 transition-transform', open ? 'rotate-180 text-ember' : 'text-faint')} />
    </span>
  );
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
      says where you are — which an open-order guess gets wrong as soon as you change files. */
  lastFile: string | null;
  /** Open files, in the order they were opened — the picker's second group. */
  openFiles: string[];
  /** Which of them have unsaved edits. Drawn on the picker and in the menu. */
  dirtyFiles: ReadonlySet<string>;
  onCloseFile: (rel: string) => void;
  onDirty: (rel: string, dirty: boolean) => void;
  wide: boolean;
  onToggleWide: () => void;
}): React.ReactElement {
  const activeLane = active?.kind === 'lane' ? tabs.find((tab) => tab.id === active.id) ?? null : null;
  const activeFile = active?.kind === 'file' ? active.path : null;

  // Preview is per file: switching views must not carry one file's preview state onto another's
  // source. A file that is not markdown can never be in preview.
  const [previewing, setPreviewing] = React.useState<Set<string>>(new Set());
  const preview = activeFile !== null && isMarkdown(activeFile) && previewing.has(activeFile);
  const togglePreview = (path: string): void => setPreviewing((set) => {
    const next = new Set(set);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

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
      {/* --- Row 1: the picker, and the two controls that belong to the panel itself ---------- */}
      <div className="workbench-strip">
        <SeedMenu
          label="Choose what this panel shows"
          width={300}
          triggerClassName="min-w-0"
          trigger={(open) => (
            activeFile !== null ? (
              <PickerTrigger
                open={open}
                mono
                icon={<FileCode2 size={13} />}
                label={fileName(activeFile)}
                dirty={dirtyFiles.has(activeFile)}
              />
            ) : (
              <PickerTrigger
                open={open}
                icon={activeLane ? LANE_ICON[activeLane.id] : <Search size={13} />}
                label={activeLane?.label ?? 'Nothing to show'}
                count={activeLane?.count ?? null}
                attention={activeLane?.attention}
              />
            )
          )}
        >
          {(close) => (
            <>
              <SeedMenuLabel>Evidence</SeedMenuLabel>
              {tabs.map((tab) => (
                <SeedMenuItem
                  key={tab.id}
                  icon={LANE_ICON[tab.id]}
                  selected={active?.kind === 'lane' && active.id === tab.id}
                  disabled={!tab.available}
                  label={tab.label}
                  /* An unavailable lane stays on the list and says WHY it is empty, rather than
                     disappearing — a lane that vanishes when it has nothing to say reads as a bug.
                     See inspector.model.ts. */
                  desc={tab.available ? LANE_DESC[tab.id] : tab.emptyReason}
                  trailing={
                    tab.count !== null ? <span className="evidence-count">{tab.count}</span>
                      : tab.attention ? <span className="block size-1.5 rounded-full bg-amber" /> : null
                  }
                  onClick={() => { onTab({ kind: 'lane', id: tab.id }); close(); }}
                />
              ))}

              {openFiles.length > 0 && (
                <>
                  <SeedMenuSeparator />
                  <SeedMenuLabel>Open files</SeedMenuLabel>
                  {openFiles.map((path) => (
                    <SeedMenuItem
                      key={path}
                      icon={<FileCode2 size={13} />}
                      selected={sameTab(active, { kind: 'file', path })}
                      label={fileName(path)}
                      desc={fileDir(path) || 'project root'}
                      trailing={dirtyFiles.has(path)
                        ? <Circle size={7} fill="currentColor" className="text-ember" /> : null}
                      onClick={() => { onTab({ kind: 'file', path }); close(); }}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </SeedMenu>

        <span className="min-w-0 flex-1" />

        <button
          type="button"
          onClick={onToggleWide}
          title={wide ? 'Give the width back to the conversation' : 'Widen this panel'}
          aria-label={wide ? 'Restore the panel width' : 'Widen the panel'}
          aria-pressed={wide}
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
            title="Previous open file" aria-label="Previous open file" className="workbench-tool"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button" onClick={() => step(1)} disabled={index < 0 || index >= openFiles.length - 1}
            title="Next open file" aria-label="Next open file" className="workbench-tool"
          >
            <ChevronRight size={14} />
          </button>

          {/* Where the file lives, NOT what it is called: the picker beside it already states the
              name, and row 2 repeating it is how a two-row header starts to read as clutter. */}
          <span className="workbench-crumb min-w-0 flex-1 truncate pl-1 text-[11px] text-faint" title={activeFile}>
            {fileDir(activeFile) || 'project root'}
          </span>

          {/* Only while it is true. A permanent "saved" is a label that never means anything. */}
          {dirtyFiles.has(activeFile) && (
            <span className="shrink-0 text-[10px] text-ember">modified — ⌘S</span>
          )}

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

          {/* The secondary verbs, behind one control. They are real actions, not settings, so this
              menu declines the seed flight — see `SeedMenu`'s `motion` note. */}
          <SeedMenu
            label="More actions for this file"
            width={232}
            motion="standard"
            triggerClassName="shrink-0"
            trigger={(open) => (
              <span className={cn('workbench-tool', open && 'bg-hover text-ink')} title="More actions">
                <MoreHorizontal size={14} />
              </span>
            )}
          >
            {(close) => (
              <>
                <SeedMenuItem
                  icon={<AtSign size={13} />}
                  label="Insert @path"
                  desc="Reference this file in the composer"
                  onClick={() => { insertIntoComposer(`@${activeFile} `); close(); }}
                />
                <SeedMenuItem
                  icon={<Compass size={13} />}
                  label="Reveal in Finder"
                  onClick={() => { void window.bimax.files.reveal(activeFile); close(); }}
                />
                <SeedMenuSeparator />
                <SeedMenuItem
                  icon={<X size={13} />}
                  label="Close this file"
                  desc={dirtyFiles.has(activeFile) ? 'Unsaved changes will be lost' : undefined}
                  onClick={() => { onCloseFile(activeFile); close(); }}
                />
              </>
            )}
          </SeedMenu>
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
