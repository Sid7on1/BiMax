import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronRight, PenLine, PanelLeft, Search, Users, Cpu, Settings2, HardDrive, FlaskConical,
} from 'lucide-react';
import { ThreadsList } from './ThreadsList';
import { cn } from '../lib/cn';
import { UiSnapshot } from '../protocol';
import type { InspectorTabId } from '../inspector.model';

/**
 * The left panel: navigation, and only navigation.
 *
 * Two rules produced this shape.
 *
 * *Nothing here reports state.* The previous panel carried a status orb, a branch/architecture
 * string, live counts, an "active" flag and a machine-health strip — six live readings in the one
 * surface whose job is to move you somewhere. Each of those facts already has a home next to the
 * evidence it describes (`TaskHeader`, the inspector lanes, Settings), so a second copy here
 * could only ever be a copy that disagrees. The single exception is the attention marker on
 * Permissions, which is a *destination* cue — it says where to go, not what is happening.
 *
 * *Features live in named, collapsible groups.* The old panel ran out of room because every feature
 * was a top-level row, so each new one made the panel longer and the whole list harder to scan.
 * Groups fix the scaling problem: a new feature is one entry in `GROUPS` below, and it costs the
 * user nothing until they open the group it belongs to. Collapse state persists per group.
 */

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** Keyboard shortcut, rendered as an engraved keycap. */
  keys?: string;
  onSelect: () => void;
  /** Draws the attention marker — a destination worth visiting, never a live metric. */
  marked?: boolean;
}

interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 90) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Collapse state outlives the session: a group the user closed stays closed on the next launch. */
function useCollapsed(id: string, initial: boolean): [boolean, () => void] {
  const key = `bimax:sidebar:${id}`;
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem(key);
    return saved === null ? initial : saved === 'open';
  });
  // The write happens here rather than inside the state updater: an updater must be pure, and
  // React re-invokes it (twice, under StrictMode) whenever it likes.
  const toggle = useCallback(() => {
    const next = !open;
    localStorage.setItem(key, next ? 'open' : 'closed');
    setOpen(next);
  }, [key, open]);
  return [open, toggle];
}

export function TaskSidebar({
  snapshot,
  onNewTask,
  onOpenPalette,
  onResume,
  onOpenInspector,
  onOpenSettings,
  onOpenMachineHealth,
  sidebarOpen = true,
  onToggleSidebar,
}: {
  snapshot: UiSnapshot | null;
  onNewTask: () => void;
  onOpenPalette: () => void;
  onResume: (id: string) => void;
  onOpenInspector: (tab: InspectorTabId) => void;
  onOpenSettings: () => void;
  onOpenMachineHealth: () => void;
  /** Whether the panel is pinned. Drives only the toggle's own label and pressed state. */
  sidebarOpen?: boolean;
  /** Omitted where the panel is not dismissible (the design preview), which hides the toggle. */
  onToggleSidebar?: () => void;
}): React.ReactElement {
  const sessions = snapshot?.sessions ?? [];
  // The running task first, then history — one list, because "which task am I in" is a property of
  // the row (it is the selected one), not a reason for a second heading.
  const ordered = [...sessions.filter((s) => s.current), ...sessions.filter((s) => !s.current)];
  // Recents shows 8 by default. "Show more" reveals the rest rather than growing the panel
  // unbounded; it collapses back so the list can never become the whole sidebar.
  const RECENTS_PAGE = 8;
  const [recentsExpanded, setRecentsExpanded] = useState(false);
  const visibleRecents = recentsExpanded ? ordered : ordered.slice(0, RECENTS_PAGE);
  const hiddenRecents = Math.max(0, ordered.length - RECENTS_PAGE);

  const groups: NavGroup[] = [
  ];

  /**
   * Machine lives behind Settings rather than in the list. Computer, Runtime and Permissions are
   * things you configure once and then forget, so they are the wrong shape for a standing row — but
   * they are also the things you need immediately when something is wrong, which is the wrong shape
   * for burying them in a dialog. A flyout off the last row is both: out of the way, one hover deep.
   */
  const machine: NavItem[] = [
    { id: 'health', label: 'App health', icon: <HardDrive size={15} />, onSelect: onOpenMachineHealth },
  ];

  return (
    <nav
      className="sidebar-shell glass-lens flex h-full min-h-0 flex-col select-none text-[13px] text-dim"
      aria-label="Navigation"
    >
      {/* --- Identity, and the gutter the traffic lights sit in ------------------------------
          There is no title bar above this any more (see TitleBar.tsx). The glass therefore starts
          at y=0 and the window's own traffic lights sit ON it, which is where macOS 26/27 put them
          for an edge-to-edge sidebar. `pl-[76px]` is their room: 12pt lights on a 23pt pitch from
          x=16 run through x≈62pt. `drag-region` because no bar spans the top to drag by now. */}
      <div className="drag-region flex h-11 shrink-0 items-center gap-1 pr-2 pl-[76px]">
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            title={sidebarOpen ? 'Unpin tasks (⌘B)' : 'Pin tasks open (⌘B)'}
            aria-label={sidebarOpen ? 'Unpin tasks' : 'Pin tasks open'}
            aria-pressed={sidebarOpen}
            className="no-drag flex size-7 cursor-pointer items-center justify-center rounded-md text-faint hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ember"
          >
            <PanelLeft size={15} />
          </button>
        )}
        <span className="truncate px-1 text-[13.5px] font-semibold tracking-[-0.01em] text-ink">Bimax</span>
        <span className="flex-1" />
        <button
          onClick={onOpenPalette}
          title="Search everything (⌘K)"
          aria-label="Search everything"
          className="no-drag glass-row flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-ember"
        >
          <Search size={15} />
        </button>
      </div>

      {/* --- The one thing you do most ------------------------------------------------------ */}
      <div className="px-3 pb-1">
        <button
          onClick={onNewTask}
          className="glass-pill flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-semibold text-ink focus-visible:outline-2 focus-visible:outline-ember"
        >
          <PenLine size={15} />
          <span className="flex-1 text-left">New thread</span>
          <Keycap>⌘N</Keycap>
        </button>
      </div>

      {/* --- Everything else, grouped ------------------------------------------------------- */}
      <div className="quiet-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
        {/* Collapsible like Recents; the open/closed choice is remembered (useCollapsed). */}
        <Section id="threads" label="Threads" defaultOpen>
          <ThreadsList />
        </Section>
        <Section id="recents" label="Recents" defaultOpen>
          {ordered.length === 0 ? (
            <p className="px-2.5 py-1.5 text-[12px] text-faint">Nothing yet</p>
          ) : (
            <>
              {visibleRecents.map((session) => (
                <button
                  key={session.id}
                  onClick={() => onResume(session.id)}
                  data-active={session.current || undefined}
                  className="glass-row group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-ember data-[active]:font-medium data-[active]:text-ink"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {session.title === '(no messages yet)' ? 'Untitled' : session.title}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-faint tabular-nums">
                    {relTime(session.startedAt)}
                  </span>
                </button>
              ))}
              {hiddenRecents > 0 && (
                <button
                  onClick={() => setRecentsExpanded((v) => !v)}
                  className="w-full cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-faint hover:bg-hover hover:text-dim focus-visible:outline-2 focus-visible:outline-ember"
                >
                  {recentsExpanded ? 'Show less' : `Show more (${hiddenRecents})`}
                </button>
              )}
            </>
          )}
        </Section>

        {groups.map((group) => (
          <section key={group.id} className="pt-1.5">
            <p className="px-2.5 py-1 text-[10.5px] font-semibold tracking-[0.09em] text-faint uppercase">
              {group.label}
            </p>
            <div className="mt-0.5 space-y-px">
              {group.items.map((item) => <NavRow key={item.id} item={item} />)}
            </div>
          </section>
        ))}
      </div>

      {/* --- Settings, and Machine behind it ------------------------------------------------- */}
      <MachineFooter items={machine} onOpenSettings={onOpenSettings} />
    </nav>
  );
}

/**
 * The last row, plus the Machine flyout it reveals on hover.
 *
 * Two things make the hover survivable. The flyout sits flush against the footer and extends its own
 * hit area *down* across the visual gap (`.glass-flyout::after`), so the pointer never crosses dead
 * space on its way up — that gap is what made the panel vanish the moment you reached for it. And
 * closing is deferred a beat, so a diagonal path that clips a corner does not dismiss it either.
 *
 * Hover alone would strand keyboard users, so the panel also opens on focus inside the footer and
 * closes on Escape or when focus leaves.
 */
function MachineFooter({
  items, onOpenSettings,
}: {
  items: NavItem[];
  onOpenSettings: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const closing = useRef<number | undefined>(undefined);

  const show = useCallback(() => {
    window.clearTimeout(closing.current);
    setOpen(true);
  }, []);
  const hide = useCallback((delay = 140) => {
    window.clearTimeout(closing.current);
    closing.current = window.setTimeout(() => setOpen(false), delay);
  }, []);

  useEffect(() => () => window.clearTimeout(closing.current), []);

  return (
    <div
      className="relative border-t border-[var(--glass-edge)] px-3 py-2"
      onMouseEnter={show}
      onMouseLeave={() => hide()}
      onFocus={show}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hide(0);
      }}
      onKeyDown={(event) => { if (event.key === 'Escape') hide(0); }}
    >
      {open && (
        <div
          className="glass-flyout absolute right-3 bottom-full left-3 space-y-px rounded-xl p-1.5"
          role="group"
          aria-label="Machine"
        >
          <p className="px-2 pt-0.5 pb-1 text-[10px] font-semibold tracking-[0.09em] text-faint uppercase">
            Machine
          </p>
          {items.map((item) => <NavRow key={item.id} item={item} />)}
        </div>
      )}

      <button
        onClick={onOpenSettings}
        aria-expanded={open}
        className="glass-row flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-ember"
      >
        <Settings2 size={15} className="shrink-0 text-dim" />
        <span className="flex-1">Settings</span>
        <Keycap>⌘,</Keycap>
      </button>
    </div>
  );
}

/** One navigation row. Shared by the groups and the Machine flyout so they cannot drift apart. */
function NavRow({ item }: { item: NavItem }): React.ReactElement {
  return (
    <button
      onClick={item.onSelect}
      className="glass-row flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-ember"
    >
      {/* `dim`, not `faint`. Icons are NON-TEXT, so the floor they answer to is 3:1 (WCAG 1.4.11),
          not 4.5:1 — and `faint` only just clears it: measured 4.54:1 in moonlight but 3.12:1 in
          starlight against the solid surface, and the glass-contrast checker puts this same band at
          ~2.1:1 in starlight over windowed glass. So in the light theme these icons were under the
          floor whenever the sidebar was actually translucent.
          This is also as far as "macOS 27 restores colour to sidebar icons" can sensibly be taken
          here: the palette is achromatic on purpose — `--color-ember` and `--color-amber` are greys
          — and the sidebar has no destination taxonomy for a hue to encode. Inventing per-item
          colours would be decoration carrying no information. Undraining them is the real intent. */}
      <span className="shrink-0 text-dim">{item.icon}</span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.marked && (
        <span
          aria-label="needs attention"
          className="size-1.5 shrink-0 rounded-full bg-ember shadow-[0_0_6px_var(--color-ember)]"
        />
      )}
      {item.keys && <Keycap>{item.keys}</Keycap>}
    </button>
  );
}

/**
 * A collapsible group. The heading is the control — a separate chevron button would give the same
 * action two hit targets in a panel whose whole point is that rows are unambiguous.
 */
function Section({
  id, label, defaultOpen, children,
}: {
  id: string;
  label: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, toggle] = useCollapsed(id, defaultOpen);
  const bodyId = `sidebar-section-${id}`;
  return (
    <section className="pt-1.5 first:pt-0">
      <button
        onClick={toggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="glass-row flex w-full cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-left text-[10.5px] font-semibold tracking-[0.09em] text-faint uppercase hover:text-dim focus-visible:outline-2 focus-visible:outline-ember"
      >
        <ChevronRight
          size={11}
          className={cn('shrink-0 transition-transform duration-200', open ? 'rotate-90' : 'rotate-0')}
        />
        {label}
      </button>
      {open && (
        <div id={bodyId} className="mt-0.5 space-y-px">
          {children}
        </div>
      )}
    </section>
  );
}

function Keycap({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="glass-key shrink-0 rounded-[5px] px-1.5 py-px font-mono text-[9.5px] leading-[15px] tracking-tight">
      {children}
    </span>
  );
}
