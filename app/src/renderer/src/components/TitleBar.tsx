import React from 'react';
import {
  PanelLeft, PanelRight, FolderOpen, GitBranch, Palette, Sun, Moon, Monitor, Globe,
} from 'lucide-react';
import { cn } from '../lib/cn';
import type { GitStatusResult } from '../global';
import { BrandMark } from './BrandMark';
import { SeedMenu, SeedMenuItem, SeedMenuLabel } from './ui/morph/SeedMenu';
import { Toolbar } from './ui/toolbar';
import { APPEARANCES, Appearance } from '../appearance';

/**
 * Standard hidden-inset title bar: project identity, repository state, and the two pane toggles.
 *
 * The task's own state moved to `TaskHeader` — `examples/CURRENT_BIMAX_UI.md` recorded the defect
 * of a verification badge living up here, far from the evidence it referred to. What remains is
 * window-level: which project, which branch, and which panes are showing.
 */
export function TitleBar({
  project, protocolMismatch, gitStatus, sidebarOpen, inspectorOpen,
  onToggleSidebar, onPeekSidebar, onToggleInspector, onOpenChanges, browserOpen, onToggleBrowser, appearance, onAppearance,
}: {
  project: string;
  protocolMismatch: number | null;
  gitStatus: GitStatusResult | null;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  onToggleSidebar: () => void;
  /** Hover intent: reveal the panel transiently, without pinning it. */
  onPeekSidebar?: () => void;
  onToggleInspector: () => void;
  onOpenChanges: () => void;
  /** Whether the embedded research browser lane is the one on screen. */
  browserOpen?: boolean;
  /** Toggle the browser lane. Omitted in surfaces that do not host it (the design preview). */
  onToggleBrowser?: () => void;
  appearance: Appearance;
  onAppearance: (appearance: Appearance) => void;
}): React.ReactElement {
  const projectName = project ? project.split('/').filter(Boolean).pop() : '';
  const insertions = gitStatus?.files.reduce((total, file) => total + file.insertions, 0) ?? 0;
  const deletions = gitStatus?.files.reduce((total, file) => total + file.deletions, 0) ?? 0;

  return (
    <header className="titlebar-shell drag-region flex h-11 shrink-0 items-center gap-2 border-b border-line/80 pr-3 pl-[80px] select-none">
      {project && (
        <IconBtn
          title={sidebarOpen ? 'Unpin tasks (⌘B)' : 'Pin tasks open (⌘B)'}
          active={sidebarOpen}
          /*
            Hover and click are DIFFERENT actions, and conflating them was the bug: `onHover` used
            to call this same toggle, so pointing at the button latched the panel open with no way
            back — "it comes but it never goes".
              hover → peek   (transient; ends when the pointer leaves the panel)
              click → pin    (sticky; only another click releases it)
          */
          onClick={onToggleSidebar}
          onHover={onPeekSidebar}
        >
          <PanelLeft size={16} />
        </IconBtn>
      )}
      <BrandMark className="mr-1 text-[12px]" />
      {/*
        Identity yields before the controls do.

        Both compete for the same row, and flexbox would otherwise shrink them in proportion to
        their size — so a long project path would squeeze the toolbar into its overflow menu while
        the path itself stayed almost intact. The shrink factors say which of them is *supposed* to
        give: a truncated project name is still an answer to "where am I?" (Prompt 2 §19), whereas a
        control pushed into a menu costs a click every time it is used.

        The floors are the last thing to give and they are deliberately low: below them the toolbar
        starts clipping its own overflow button, and a control sliced in half is worse than a
        project name shown as three letters and an ellipsis — the name has a tooltip, the sliced
        button has nothing.
      */}
      <button
        title={project || 'Open a project'}
        onClick={() => void window.bimax.pickFolder()}
        style={{ flexShrink: 6, minWidth: '3.25rem' }}
        className="no-drag flex max-w-[320px] cursor-pointer items-center gap-1.5 truncate rounded-lg px-2 py-1 text-dim hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ember"
      >
        <FolderOpen size={13} />
        <span className="truncate">{projectName || 'Open Project…'}</span>
      </button>
      {onToggleBrowser && (
        <button
          title={browserOpen ? 'Back to chat' : 'Open the research browser'}
          aria-pressed={browserOpen}
          onClick={onToggleBrowser}
          className={`no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 focus-visible:outline-2 focus-visible:outline-ember ${
            browserOpen ? 'bg-hover text-ink' : 'text-dim hover:bg-hover hover:text-ink'
          }`}
        >
          <Globe size={13} />
          <span>Browser</span>
        </button>
      )}
      {gitStatus && (
        <button
          title={gitStatus.files.length
            ? `${gitStatus.files.length} changed file${gitStatus.files.length === 1 ? '' : 's'} — open Changes`
            : `On ${gitStatus.branch} — nothing changed`}
          onClick={onOpenChanges}
          style={{ flexShrink: 8, minWidth: '2.5rem' }}
          className="no-drag flex max-w-[220px] cursor-pointer items-center gap-1.5 truncate rounded-lg px-2 py-1 text-xs text-dim hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ember"
        >
          <GitBranch size={12} className="shrink-0 text-ember/80" />
          <span className="truncate">{gitStatus.branch || '(detached)'}</span>
          {gitStatus.files.length > 0 && (
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
              <span className="text-moss">+{insertions}</span> <span className="text-rust">−{deletions}</span>
            </span>
          )}
        </button>
      )}
      <span className="flex-1" />
      {/*
        The trailing cluster, tiered rather than crammed (Prompt 2 §22).

        Which of these survives a narrow window is a statement about what the app is for. The
        evidence toggle is how you see what the agent just did, and it never overflows. The Trust
        Center answers a question you ask once a session — why can it not drive my Mac? — so it is
        the one that moves into a menu, and it keeps its keyboard shortcut when it does.

        Appearance is pinned here rather than tiered only because it is a menu, and a menu inside an
        overflow menu is a submenu; that is a worse answer than one more icon (§39).
      */}
      <Toolbar
        actions={project ? [
          {
            id: 'inspector',
            label: 'Show or hide evidence (⌘J)',
            icon: <PanelRight size={16} />,
            priority: 'always',
            active: inspectorOpen,
            onSelect: onToggleInspector,
          },
        ] : []}
      >
        {protocolMismatch !== null && (
          <span className="shrink-0 rounded-lg border border-rust/25 bg-rust/8 px-2 py-1 text-xs text-rust">
            Bimax needs an update
          </span>
        )}
        {/* The one morph in the title bar. Its seed is a 28px square rather than a pill, which is
            the case that shows whether the corner really interpolates: it starts at 8px, not
            round. Pinned rather than tiered — see `Toolbar`'s note on menus in overflow menus. */}
        <SeedMenu
          label="Change appearance"
          // `shrink-0` for the same reason the toolbar buttons have it: an item that squashes
          // reports that it fits at any width, which makes the overflow measurement a lie.
          triggerClassName="no-drag shrink-0"
          trigger={(open) => (
            <span
              title="Change appearance"
              className={cn(
                'flex size-7 items-center justify-center rounded-lg transition-colors',
                open ? 'bg-hover text-ember' : 'text-faint hover:bg-hover hover:text-ink',
              )}
            >
              <Palette size={15} />
            </span>
          )}
        >
          {(close) => (
            <>
              <SeedMenuLabel>Appearance</SeedMenuLabel>
              {APPEARANCES.map((item) => (
                <SeedMenuItem
                  key={item.id}
                  selected={appearance === item.id}
                  icon={item.id === 'starlight' ? <Sun size={13} /> : item.id === 'moonlight' ? <Moon size={13} /> : <Monitor size={13} />}
                  label={item.label}
                  desc={item.description}
                  onClick={() => { onAppearance(item.id); close(); }}
                />
              ))}
            </>
          )}
        </SeedMenu>
      </Toolbar>
    </header>
  );
}

function IconBtn({
  title, active, onClick, onHover, children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  onHover?: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={onHover}
      className={cn(
        'no-drag flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-hover focus-visible:outline-2 focus-visible:outline-ember',
        active ? 'text-ink' : 'text-faint',
      )}
    >
      {children}
    </button>
  );
}
