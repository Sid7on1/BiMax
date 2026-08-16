import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../../lib/cn';
import { SeedPopover } from './MorphSurface';
import { useSeedRef } from './use-seed';

/**
 * A menu that is its own trigger, grown.
 *
 * This is the first real surface migrated to Seed Morph v2, and it is deliberately a *menu* rather
 * than something more spectacular. Prompt 2 §72 names the model selector as the flagship case, and
 * the reason it is a good flagship is that it is boring and frequent: a control the user hits dozens
 * of times a session, where any motion that draws attention to itself becomes an irritation by the
 * tenth use (§6, §105). If the morph survives being *ordinary*, it will survive anywhere.
 *
 * Compared with the anchored `../dropdown.tsx` it replaces:
 *
 *   - The panel is measured from the trigger's real rect and flies from it, rather than scaling out
 *     of a `transform-origin` corner. At a pill's scale those look similar in a still frame; the
 *     difference is that the corner trick has no idea where the trigger is, so it cannot travel, it
 *     cannot fold back into it, and it cannot be interrupted halfway.
 *   - It is portalled, so the composer strip's own clipping cannot amputate it.
 *   - The panel's corner is interpolated from the pill's, so the two read as one piece of glass.
 *
 * ## Keyboard
 *
 * Prompt 2 §33 is blunt about this: a beautiful morph is irrelevant if the keyboard path is
 * awkward. So the menu is a real menu — arrows move, Home/End jump, Enter and Space activate,
 * Escape closes and returns focus to the trigger, and the roving `tabindex` means Tab leaves the
 * menu rather than walking through it. None of that is new behaviour for the app; it is what the
 * dropdown should always have had.
 */

export interface SeedMenuProps {
  /** Renders the trigger's contents. `open` lets it show its own expanded state. */
  trigger: (open: boolean) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  label: string;
  /** Preferred menu width. The window still gets the final say. */
  width?: number;
  /**
   * Whether this menu is one of the surfaces the morph is *for*.
   *
   * Prompt 2 §42 and §44 draw a line that is easy to lose: a **chooser** — model, quality, branch,
   * task lane, appearance — has a real source→destination relationship, because the control states
   * the current value and the surface is that value at full size. A **menu of commands** does not;
   * it is a list of things you could do next, and §42 keeps standard system behaviour for those.
   * The toolbar's overflow menu is the second kind, and it is also the case where a flight is most
   * out of place: it only exists when the window is too narrow, so it fires exactly when the user
   * is short of room and looking for a control they can no longer see.
   *
   * `standard` keeps everything else — the anchoring, the fold home, the keyboard contract — and
   * only declines the journey. See `MorphSurface`'s `launch`.
   */
  motion?: 'seeded' | 'standard';
  className?: string;
  triggerClassName?: string;
}

export function SeedMenu({
  trigger, children, label, width = 268, motion = 'seeded', className, triggerClassName,
}: SeedMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const seed = useSeedRef();
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  // Move focus into the menu once it has arrived, not when it launches. Focusing an item at t=0
  // scrolls the (still tiny) panel and fires a focus ring on a control that is a few pixels wide —
  // and on the way out it would fight the trigger for focus mid-collapse.
  const onSettled = useCallback(() => {
    const first = panelRef.current?.querySelector<HTMLElement>('[data-menuitem]:not([disabled])');
    first?.focus();
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('[data-menuitem]:not([disabled])') ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);

    const focus = (next: number): void => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };

    switch (event.key) {
      case 'ArrowDown': return focus(index + 1);
      case 'ArrowUp': return focus(index - 1);
      case 'Home': return focus(0);
      case 'End': return focus(items.length - 1);
      default:
    }
  }, []);

  return (
    <>
      <button
        type="button"
        ref={seed.ref}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'cursor-pointer rounded-xl focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ember',
          triggerClassName,
        )}
      >
        {trigger(open)}
      </button>

      <SeedPopover
        open={open}
        onClose={close}
        seed={seed}
        label={label}
        width={width}
        launch={motion === 'seeded' ? 'seed' : 'inPlace'}
        // A menu is exactly as tall as its rows. See `fitHeight`.
        fitHeight
        onSettled={onSettled}
        className={className}
      >
        <div
          ref={panelRef}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          className="flex min-h-0 flex-1 flex-col gap-0.5 p-1.5"
        >
          {children(close)}
        </div>
      </SeedPopover>
    </>
  );
}

/** A row in a `SeedMenu`. Same shape as the dropdown's item, with the keyboard contract added. */
export function SeedMenuItem({
  selected, disabled, onClick, label, desc, icon, trailing,
}: {
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  desc?: string;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      data-menuitem
      disabled={disabled}
      // Roving: only the focused item is tabbable, so Tab leaves the menu instead of walking it.
      tabIndex={-1}
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px]',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ember',
        disabled && 'cursor-default opacity-45',
        selected ? 'bg-ember/15 text-ink' : 'text-dim not-disabled:hover:bg-hover not-disabled:hover:text-ink',
      )}
    >
      {icon ? <span className="mt-0.5 shrink-0 text-ember">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {desc ? <span className="block truncate text-[11px] text-faint">{desc}</span> : null}
      </span>
      {trailing ? <span className="mt-0.5 shrink-0 text-faint">{trailing}</span> : null}
    </button>
  );
}

/**
 * A row that states something rather than doing something.
 *
 * Not a disabled `SeedMenuItem`, and the difference matters. A disabled control means *you cannot do
 * this right now*, and it is drawn faint to say so — which is exactly backwards for a row whose only
 * job is to be read. The loaded-model rows are the most useful thing in the model menu; dimming them
 * to 45% makes the answer the user came for the hardest thing on screen, and in light mode it is at
 * the edge of legible (Prompt 2 §91: when realism and legibility conflict, legibility wins).
 *
 * So it is a `<div>`: full contrast, no focus, no hover, nothing that implies it can be pressed.
 */
export function SeedMenuReadout({
  label, value, icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px]">
      {icon ? <span className="mt-0.5 shrink-0 text-faint">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ink">{label}</span>
        <span className="block truncate font-mono text-[10.5px] text-dim">{value}</span>
      </span>
    </div>
  );
}

/**
 * A line of prose inside a menu — an explanation, not a control.
 *
 * The lane chip's menu opens with *why Bimax classified this task the way it did*, which is the
 * reason to open it at all. Left as a bare `<div>` at each call site it drifted: three menus, three
 * paddings, two type sizes. Here it is one thing, and it is deliberately not focusable, so the
 * keyboard walk skips straight to the rows that do something.
 */
export function SeedMenuNote({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="px-2.5 pb-1.5 text-[10.5px] leading-relaxed text-faint">{children}</div>;
}

/** A labelled group heading inside a `SeedMenu`. */
export function SeedMenuLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="px-2.5 pt-1.5 pb-1 text-[9.5px] font-semibold tracking-[0.1em] text-faint uppercase">
      {children}
    </div>
  );
}

export function SeedMenuSeparator(): React.ReactElement {
  return <div role="separator" className="mx-1.5 my-1 h-px bg-line/70" />;
}

/**
 * Keep a menu closed while its trigger is unmounting.
 *
 * Exported for callers that render a `SeedMenu` inside a list whose rows come and go: a menu whose
 * seed has been removed can still measure, but it measures nothing, and the collapse would fold into
 * the window's origin. `use-seed` already returns null in that case and the controller folds into
 * the surface's own centre instead — this hook is the earlier, cheaper fix of simply not being open.
 */
export function useCloseOnUnmount(close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => () => latest.current(), []);
}
