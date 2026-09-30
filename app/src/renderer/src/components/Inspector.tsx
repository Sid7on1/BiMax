import React from 'react';
import {
  AtSign, ChevronDown, Circle, Code2, Compass, Eye, FolderTree,
  GitBranch, Maximize2, Minimize2, MoreHorizontal, PanelRightClose, Search, TerminalSquare, X,
} from 'lucide-react';
import { cn } from '../lib/cn';
import type { InspectorTab, InspectorTabId, WorkbenchTab } from '../inspector.model';
import { sameTab } from '../inspector.model';
import { filesToClose, tabLabel } from '../workbench.tabs';
import { FileIcon } from './FileIcon';
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
 *      Evidence, every open file under Open files. Plus the two panel controls, enlarge (fill the window) and hide.
 *   2. the file tabs (UI fix list item 8, 2026-09-30), in the Files lane only: a tree button, then one
 *      tab per open file. Files only — the owner's words were "tabs, but they are files"; the lanes stay
 *      in the picker, because mixing the two is what was rejected. See `FileTabs`.
 *   3. a contextual toolbar, for a file tab only: the folder (one click back to the tree), save state,
 *      Source|Preview for markdown, find, and the secondary verbs behind one overflow.
 *   4. the content, flush to the panel's edges.
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
      {attention ? <span className="size-1.5 shrink-0 rounded-full bg-amber" role="img" aria-label="Needs attention" title="Needs attention" /> : null}
      {dirty ? <Circle size={7} fill="currentColor" className="shrink-0 text-ember" aria-label="Unsaved changes" /> : null}
      <ChevronDown size={11} className={cn('shrink-0 transition-transform', open ? 'rotate-180 text-ember' : 'text-faint')} />
    </span>
  );
}

/**
 * The file tabs (UI fix list item 8): Cursor's editor strip, for a panel 430pt wide.
 *
 * - The tree is the first thing in the strip, always one click away — it used to take two, the picker and then
 *   Files — and going there costs nothing: the tabs stay, and the tree opens on the file you were in.
 * - One tab per open file, in the order opened: its icon, its name, a folder hint only when two open files share a
 *   name. The ✕ shows on the active tab and on hover; an unsaved tab shows a dot that turns into the ✕ under the
 *   pointer. Middle-click closes; right-click is the native Close / Close Others / Close to the Right / Close All.
 * - Tabs shrink to a floor, then the strip scrolls sideways, and the active tab is kept in view.
 *
 * Closing asks first when there are unsaved edits (App.tsx `closeFiles`), so a stray click on a ✕ cannot lose work.
 */
function FileTabs({
  openFiles, activeFile, treeActive, dirtyFiles, onTree, onSelect, onClose, onMenu,
}: {
  openFiles: string[];
  activeFile: string | null;
  treeActive: boolean;
  dirtyFiles: ReadonlySet<string>;
  onTree: () => void;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onMenu: (path: string) => void;
}): React.ReactElement {
  const listRef = React.useRef<HTMLDivElement>(null);
  // Which edges have more tabs past them, for the fades (styles.css `.workbench-tab-list`).
  const [more, setMore] = React.useState({ left: false, right: false });
  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const update = (): void => setMore((was) => {
      const left = list.scrollLeft > 1;
      const right = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
      return was.left === left && was.right === right ? was : { left, right };
    });
    update();
    list.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(list);
    return () => { list.removeEventListener('scroll', update); observer?.disconnect(); };
  }, [openFiles.length]);
  // A file opened from the tree lands at the END of the strip, which may be scrolled off: bring the
  // active tab into view whenever it changes, by the least movement.
  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeFile, openFiles.length]);

  const move = (from: string, delta: 1 | -1): void => {
    const next = openFiles[openFiles.indexOf(from) + delta];
    if (next === undefined) return;
    onSelect(next);
    // Arrow keys move the selection AND the focus, as a tablist should (WAI-ARIA tabs pattern).
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
  };

  return (
    <div className="workbench-tabs">
      <button
        type="button"
        onClick={onTree}
        data-active={treeActive || undefined}
        aria-pressed={treeActive}
        title="Show the project’s files"
        aria-label="Show the project’s files"
        className="workbench-tree"
      >
        <FolderTree size={13} />
      </button>
      <div
        ref={listRef}
        role="tablist"
        aria-label="Open files"
        className="workbench-tab-list"
        data-more-left={more.left || undefined}
        data-more-right={more.right || undefined}
        // A mouse wheel scrolls the strip sideways, as it does in a browser's tab bar: most wheels only turn one way.
        onWheel={(event) => {
          if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
        }}
      >
        {openFiles.map((path) => {
          const { name, hint } = tabLabel(openFiles, path);
          const selected = path === activeFile;
          const dirty = dirtyFiles.has(path);
          return (
            <div
              key={path}
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              title={path}
              data-active={selected || undefined}
              data-dirty={dirty || undefined}
              className="workbench-tab"
              onClick={() => onSelect(path)}
              // Middle button: close. The mousedown is swallowed too, or Chromium starts its autoscroll.
              onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
              onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(path); } }}
              onContextMenu={(event) => { event.preventDefault(); onMenu(path); }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') { event.preventDefault(); move(path, 1); }
                else if (event.key === 'ArrowLeft') { event.preventDefault(); move(path, -1); }
                else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(path); }
              }}
            >
              <FileIcon name={name} size={12} />
              <span className="workbench-tab-name">{name}</span>
              {hint ? <span className="workbench-tab-hint">{hint}</span> : null}
              <button
                type="button"
                tabIndex={-1}
                onClick={(event) => { event.stopPropagation(); onClose(path); }}
                title={dirty ? 'Unsaved changes — close' : 'Close (⌘W)'}
                aria-label={dirty ? `Close ${name}, which has unsaved changes` : `Close ${name}`}
                className="workbench-tab-close hit-24"
              >
                <Circle size={7} fill="currentColor" className="workbench-tab-dot" aria-hidden />
                <X size={11} className="workbench-tab-x" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Inspector({
  tabs, active, onTab, onClose,
  review, gitStatus, checkpoints, onRefreshGit, onCommand,
  project, onOpenFile, lastFile,
  openFiles, dirtyFiles, onCloseFile, onCloseFiles, onDirty,
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
  /** Close at once, no questions: a file the editor cannot show (binary, unreadable). */
  onCloseFile: (rel: string) => void;
  /** Close as the user asked to — a tab's ✕, its menu, ⌘W — which asks first about unsaved edits. */
  onCloseFiles: (paths: string[]) => void;
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

  const inFiles = activeFile !== null || (active?.kind === 'lane' && active.id === 'files');

  /**
   * A lane from the picker. Files is where the tabs live, so coming back to it from another lane
   * returns to the file you were in rather than to the tree — "opening the tree never costs you your
   * place" (item 8) works in both directions. Chosen while already in Files, it is the tree.
   */
  const chooseLane = (id: InspectorTabId): void => {
    if (id === 'files' && !inFiles && lastFile !== null && openFiles.includes(lastFile)) {
      onTab({ kind: 'file', path: lastFile });
      return;
    }
    onTab({ kind: 'lane', id });
  };

  const tabMenu = (path: string): void => {
    const index = openFiles.indexOf(path);
    void window.bimax.files.tabMenu?.(openFiles.length > 1, index >= 0 && index < openFiles.length - 1).then((action) => {
      if (action === 'mention') insertIntoComposer(`@${path} `);
      else if (action === 'reveal') void window.bimax.files.reveal(path);
      else if (action) onCloseFiles(filesToClose(openFiles, path, action));
    });
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
            // A file belongs to Files, and its tab below already names it — so the picker states the
            // lane, as it does everywhere else, instead of repeating the file's name a row above it.
            activeFile !== null ? (
              <PickerTrigger
                open={open}
                icon={LANE_ICON.files}
                label="Files"
                dirty={dirtyFiles.size > 0}
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
                  selected={tab.id === 'files' ? inFiles : active?.kind === 'lane' && active.id === tab.id}
                  disabled={!tab.available}
                  label={tab.label}
                  /* An unavailable lane stays on the list and says WHY it is empty, rather than
                     disappearing — a lane that vanishes when it has nothing to say reads as a bug.
                     See inspector.model.ts. */
                  desc={tab.available ? LANE_DESC[tab.id] : tab.emptyReason}
                  trailing={
                    tab.count !== null ? <span className="evidence-count">{tab.count}</span>
                      : tab.attention ? <span className="block size-1.5 rounded-full bg-amber" role="img" aria-label="Needs attention" title="Needs attention" /> : null
                  }
                  onClick={() => { chooseLane(tab.id); close(); }}
                />
              ))}

              {openFiles.length > 0 && (
                <>
                  <SeedMenuSeparator />
                  <SeedMenuLabel>Open files</SeedMenuLabel>
                  {openFiles.map((path) => (
                    <SeedMenuItem
                      key={path}
                      icon={<FileIcon name={fileName(path)} />}
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
          title={wide ? 'Bring the conversation back' : 'Fill the window with this panel'}
          aria-label={wide ? 'Bring the conversation back' : 'Fill the window with this panel'}
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

      {/* --- Row 2: the file tabs, in Files only ---------------------------------------------
          Terminal, Review and GitHub keep their full height: from there the picker's Open files
          group is the way to a file, and choosing Files returns to the one you were in. */}
      {inFiles && openFiles.length > 0 && (
        <FileTabs
          openFiles={openFiles}
          activeFile={activeFile}
          treeActive={activeFile === null}
          dirtyFiles={dirtyFiles}
          onTree={() => onTab({ kind: 'lane', id: 'files' })}
          onSelect={(path) => onTab({ kind: 'file', path })}
          onClose={(path) => onCloseFiles([path])}
          onMenu={tabMenu}
        />
      )}

      {/* --- Row 3: the selected file's own controls ------------------------------------------
          A file tab only. The four lanes already carry their controls inside their panels —
          Files its filter, Review its refresh and branch row, Terminal its restart, GitHub its
          fetch/pull/push — and lifting them into a second bar would DUPLICATE them, which is the
          opposite of what deleting the title block was for. See `13-right-panel-applied.md`.
          No previous/next arrows any more: the tabs are that, and ⌃Tab steps through them. */}
      {activeFile !== null && (
        <div className="workbench-toolbar">
          {/* Where the file lives, NOT what it is called: the tab above already states the name. A
              click shows it in the tree — the second one-click way back to the project's files. */}
          <button
            type="button"
            onClick={() => onTab({ kind: 'lane', id: 'files' })}
            className="workbench-crumb min-h-6 min-w-0 flex-1 cursor-pointer truncate rounded-md px-1.5 py-0.5 text-left text-[11px] text-faint hover:bg-hover hover:text-ink"
            title={`${activeFile} — show in the file tree`}
          >
            {fileDir(activeFile) || 'project root'}
          </button>

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
                  desc={dirtyFiles.has(activeFile) ? 'You will be asked about the unsaved changes' : undefined}
                  onClick={() => { onCloseFiles([activeFile]); close(); }}
                />
              </>
            )}
          </SeedMenu>
        </div>
      )}

      {/* --- Row 4: the content, flush ------------------------------------------------------- */}
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
