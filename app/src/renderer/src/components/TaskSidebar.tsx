import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight, PenLine, PanelLeft, Palette, Sun, Moon, Monitor, Search, Settings2,
} from 'lucide-react';
import { ThreadsList } from './ThreadsList';
import { cn } from '../lib/cn';
import { UiSnapshot } from '../protocol';
import type { InspectorTabId } from '../inspector.model';
import { SeedMenu, SeedMenuItem, SeedMenuLabel } from './ui/morph/SeedMenu';
import { SETTINGS_BUTTON_ID } from './SettingsDialog';
import { APPEARANCES, Appearance } from '../appearance';
import { createHoverIntent } from '../hover.intent';
import { QUICK_TOGGLES, toggleValue, type QuickToggle } from '../quick.settings';
import { applyMotionPreference } from '../motion.preference';
import type { EngineConfig } from '../protocol';

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
  quickSettings,
  sidebarOpen = true,
  onToggleSidebar,
  peek = false,
  appearance,
  onAppearance,
}: {
  snapshot: UiSnapshot | null;
  onNewTask: () => void;
  onOpenPalette: () => void;
  onResume: (id: string) => void;
  onOpenInspector: (tab: InspectorTabId) => void;
  onOpenSettings: () => void;
  /**
   * Read and write the engine's config for the quick switches behind Settings. Omitted where there is
   * no engine (the design preview): the switches are then shown, disabled.
   */
  quickSettings?: { get: () => Promise<EngineConfig>; set: (patch: EngineConfig) => Promise<EngineConfig> };
  /** Whether the panel is pinned. Drives only the toggle's own label and pressed state. */
  sidebarOpen?: boolean;
  /** Omitted where the panel is not dismissible (the design preview), which hides the toggle. */
  onToggleSidebar?: () => void;
  /**
   * Shown as a peek over the conversation rather than pinned in the layout. The header then stops
   * being a window drag region: Chromium delivers no pointer events over one, so the pointer crossing
   * it on the way from the toggle to the rows looked like it had LEFT the panel (fix list item 15).
   */
  peek?: boolean;
  /* Evidence and appearance live down in the footer now, not in a bar across the top: the top of
     the window is the one place the shell deliberately keeps empty. See TitleBar.tsx. */
  appearance?: Appearance;
  onAppearance?: (appearance: Appearance) => void;
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


  return (
    <nav
      /* No `glass-lens`. That pseudo-element paints an 8px ring of
         `backdrop-filter: brightness(1.12)` around the surface — a lens rim, which is right for a
         floating rounded panel and wrong for a flush, full-height, square-edged one: it renders as a
         bright frame down the join. This panel is edge-to-edge now, so it takes the material without
         the ring. */
      className="sidebar-shell flex h-full min-h-0 flex-col select-none text-[13px] text-dim"
      aria-label="Navigation"
    >
      {/* --- Identity, and the gutter the traffic lights sit in ------------------------------
          There is no title bar above this any more (see TitleBar.tsx). The glass therefore starts
          at y=0 and the window's own traffic lights sit ON it, which is where macOS 26/27 put them
          for an edge-to-edge sidebar. `pl-[76px]` is their room: 12pt lights on a 23pt pitch from
          x=16 run through x≈62pt. `drag-region` because no bar spans the top to drag by now. */}
      <div className={cn('sidebar-header flex h-11 shrink-0 items-center gap-1 pr-2 pl-[76px]', !peek && 'drag-region')}>
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
        <span className="sidebar-title shrink-0 px-1 text-[13.5px] font-semibold tracking-[-0.01em] text-ink">Bimax</span>
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
                  <span className="shrink-0 text-[10px] text-faint tabular-nums">
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

      {/* --- Settings, and its quick switches behind it ----------------------------------------- */}
      <SettingsFooter
        quickSettings={quickSettings}
        onOpenSettings={onOpenSettings}
        appearance={appearance}
        onAppearance={onAppearance}
      />
    </nav>
  );
}

/**
 * The last row, plus the quick switches it reveals on hover (fix list item 5).
 *
 * It used to reveal a "Machine" flyout whose one row was App health, which the owner asked to be
 * removed — nobody hovers Settings to read diagnostics (App health is still in Settings → Support).
 * What people DO open Settings for is a handful of switches, so those are here, one hover deep, and
 * "All settings" is the row below them.
 *
 * Two things make the hover survivable. The flyout sits flush against the footer and extends its own
 * hit area down across the visual gap (`.glass-flyout::after`), so the pointer never crosses dead
 * space on its way up; and closing is a decision taken a beat later (hover.intent.ts, the same one the
 * sidebar peek uses), so a diagonal path that clips a corner does not dismiss it either.
 *
 * Hover alone would strand keyboard users, so the panel also opens on focus inside the footer and
 * closes on Escape or when focus leaves.
 */
function SettingsFooter({
  quickSettings, onOpenSettings, appearance, onAppearance,
}: {
  quickSettings?: { get: () => Promise<EngineConfig>; set: (patch: EngineConfig) => Promise<EngineConfig> };
  onOpenSettings: () => void;
  appearance?: Appearance;
  onAppearance?: (appearance: Appearance) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const intent = useMemo(() => createHoverIntent(setOpen), []);
  useEffect(() => () => intent.dispose(), [intent]);
  // Read fresh on every open: the same switches are in the Settings window, and a stale copy here
  // would show one state beside a window showing the other.
  const [config, setConfig] = useState<EngineConfig | null>(null);
  useEffect(() => {
    if (!open || !quickSettings) return undefined;
    let live = true;
    void quickSettings.get().then((value) => { if (live) setConfig(value); }).catch(() => undefined);
    return () => { live = false; };
  }, [open, quickSettings]);

  const flip = (toggle: QuickToggle): void => {
    if (!quickSettings) return;
    const next = !toggleValue(config, toggle.key);
    setConfig((current) => ({ ...(current ?? {}), [toggle.key]: next }));
    // Reduce motion is the one switch the page itself acts on; it takes effect before the save lands.
    if (toggle.key === 'reducedMotion') applyMotionPreference(next);
    void quickSettings.set({ [toggle.key]: next } as EngineConfig)
      .then((canonical) => { if (Object.keys(canonical).length > 0) setConfig(canonical); })
      .catch(() => undefined);
  };

  return (
    <div
      className="relative px-3 py-2"
      onMouseEnter={intent.enter}
      onMouseLeave={() => intent.leave()}
      onFocus={intent.enter}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) intent.close();
      }}
      onKeyDown={(event) => { if (event.key === 'Escape') intent.close(); }}
    >
      {open && (
        <div
          className="glass-flyout absolute right-3 bottom-full left-3 space-y-px rounded-xl p-1.5"
          role="group"
          aria-label="Quick settings"
        >
          <p className="px-2 pt-0.5 pb-1 text-[10px] font-semibold tracking-[0.09em] text-faint uppercase">
            Quick settings
          </p>
          {QUICK_TOGGLES.map((toggle) => {
            const on = toggleValue(config, toggle.key);
            return (
              <button
                key={toggle.key}
                type="button"
                role="switch"
                aria-checked={on}
                disabled={!quickSettings || config === null}
                title={toggle.hint}
                onClick={() => flip(toggle)}
                className="glass-row flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-ember disabled:cursor-default disabled:opacity-60"
              >
                <span className="min-w-0 flex-1 truncate">{toggle.label}</span>
                <QuickSwitch on={on} />
              </button>
            );
          })}
        </div>
      )}

      {/* Settings and appearance. The right panel's toggle used to sit here too, which put "show
          the panel on the RIGHT" in the bottom-LEFT corner — and hid it entirely whenever the
          sidebar was away. It is at the top right of the canvas now (`CanvasChrome`). */}
      <div className="flex items-center gap-1">
        <button
          id={SETTINGS_BUTTON_ID}
          onClick={() => { intent.close(); onOpenSettings(); }}
          aria-expanded={open}
          className="glass-row flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-ember"
        >
          <Settings2 size={15} className="shrink-0 text-dim" />
          {/* No keycap. The row now shares its width with the evidence and appearance controls, and
              at the sidebar's 190px minimum the keycap was what pushed "Settings" into "Setti…".
              A truncated label costs more than a shortcut hint that ⌘, already teaches. */}
          <span className="flex-1 truncate">Settings</span>
        </button>

        {appearance && onAppearance && (
          <SeedMenu
            label="Change appearance"
            triggerClassName="shrink-0"
            trigger={(menuOpen) => (
              <span
                title="Change appearance"
                className={cn(
                  'flex size-7 items-center justify-center rounded-lg transition-colors',
                  menuOpen ? 'text-ember' : 'text-faint hover:text-ink',
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
        )}
      </div>
    </div>
  );
}

/** A small on/off pill for a quick-settings row. The row is the control; this only shows its state. */
function QuickSwitch({ on }: { on: boolean }): React.ReactElement {
  return (
    <span
      aria-hidden
      className={cn('relative h-4 w-7 shrink-0 rounded-full transition-colors duration-150', on ? 'bg-ember' : 'bg-line')}
    >
      <span className={cn('absolute top-0.5 left-0.5 size-3 rounded-full bg-ink shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-transform duration-150', on && 'translate-x-3 bg-bg')} />
    </span>
  );
}

/** One navigation row, as the groups draw it. */
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
          role="img"
          aria-label="needs attention"
          title="Needs attention"
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
        className="glass-row flex min-h-6 w-full cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-left text-[10.5px] font-semibold tracking-[0.09em] text-faint uppercase hover:text-dim focus-visible:outline-2 focus-visible:outline-ember"
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
    <span className="glass-key shrink-0 rounded-[5px] px-1.5 py-px text-[9.5px] leading-[15px] tracking-tight">
      {children}
    </span>
  );
}
