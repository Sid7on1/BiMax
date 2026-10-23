import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '../../lib/cn';
import { SeedMenu, SeedMenuItem } from './morph/SeedMenu';

/**
 * A toolbar that decides what to show by *measuring*, not by guessing at pixel widths.
 *
 * Prompt 2 §22 asks for explicit priority tiers — always visible, visible when space permits,
 * overflow — mirroring AppKit's `visibilityPriority` and `ToolbarOverflowMenu`, and names the thing
 * to avoid: "arbitrary pixel breakpoints that just hide things". The difference is not academic. A
 * breakpoint says *this window is 900px wide, so hide the branch chip*, which is wrong the moment
 * the project is called `x` or the branch is called `feature/really-quite-a-long-name`. Measuring
 * asks the only question that matters: does what I have actually fit?
 *
 * ## How it converges
 *
 * The row is `overflow: hidden` with non-shrinking items, so `scrollWidth > clientWidth` is a
 * truthful "this does not fit". On overflow the lowest visible tier is demoted into the overflow
 * menu, which shrinks the row, which re-triggers the observer — so it settles in at most two steps
 * for three tiers, with no width arithmetic anywhere.
 *
 * Promotion needs `SLACK` of spare room rather than merely fitting, and that hysteresis is
 * load-bearing: without it, restoring an item makes the row overflow again, which hides it, which
 * frees the room that restores it. A toolbar that flickers while a window is being dragged is worse
 * than one that keeps an item in the overflow menu 40px longer than it strictly had to.
 */

/** Mirrors `NSToolbarItem.VisibilityPriority`, at the three levels this app actually distinguishes. */
export type ToolbarPriority =
  /** Never overflows. The window-level controls a user must always be able to reach. */
  | 'always'
  /** Overflows last. Frequent, valuable, but survivable in a menu. */
  | 'high'
  /** Overflows first. */
  | 'low';

export interface ToolbarAction {
  id: string;
  /** Shown in the overflow menu, and as the button's tooltip when it is on the bar. */
  label: string;
  icon: React.ReactNode;
  priority: ToolbarPriority;
  /** Current/selected state — a toggle that is on. */
  active?: boolean;
  onSelect: () => void;
  /** Hover intent, for controls with a peek behaviour. Not offered in the overflow menu. */
  onHover?: () => void;
}

const ORDER: ToolbarPriority[] = ['always', 'high', 'low'];

/** How much spare room must exist before a demoted tier comes back. See the hysteresis note. */
const SLACK = 40;

export function Toolbar({
  actions, children, className, overflowLabel = 'More toolbar actions',
}: {
  actions: ToolbarAction[];
  /**
   * Controls that are not simple actions and therefore never overflow — a menu, a status badge.
   *
   * A menu cannot go into the overflow menu without becoming a submenu, and a submenu is a worse
   * answer than leaving one icon on the bar (Prompt 2 §39: restraint over completeness).
   */
  children?: React.ReactNode;
  className?: string;
  overflowLabel?: string;
}): React.ReactElement {
  const row = useRef<HTMLDivElement | null>(null);
  /** How deep the visible tiers go. `always` means everything else is in the overflow menu. */
  const [depth, setDepth] = useState<ToolbarPriority>('low');

  const measure = useCallback(() => {
    const element = row.current;
    if (!element) return;
    const overflowing = element.scrollWidth > element.clientWidth + 1;
    setDepth((current) => {
      const index = ORDER.indexOf(current);
      if (overflowing) return ORDER[Math.max(0, index - 1)];
      if (index < ORDER.length - 1 && element.clientWidth - element.scrollWidth > SLACK) {
        return ORDER[index + 1];
      }
      return current;
    });
  }, []);

  useEffect(() => {
    const element = row.current;
    if (!element || typeof ResizeObserver !== 'function') return;
    // The row's own box AND the window: the first catches a neighbour releasing width (the sidebar
    // collapsing), the second catches the window itself being dragged.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  /*
    Re-measure after every change to what is rendered — including our own.

    `depth` is the dependency that matters. The observer only fires when the row's *box* changes, and
    demoting a tier does not always change it: if the tier that was demoted happens to hold nothing,
    the row is exactly as wide as before, no callback comes, and the toolbar sits one step short of
    fitting forever. (Measured exactly that: a 298px title bar whose controls still overflowed, with
    the component convinced it had already dealt with it.) Re-running here turns one nudge per resize
    into a proper convergence — and it terminates on its own, because React bails out when `setDepth`
    returns the value it already had.

    `actions` covers the other case: a label that grew, or a control that appeared because a project
    was opened, changes what fits without changing any box the observer is watching.
  */
  useEffect(measure, [measure, actions, depth]);

  const visibleDepth = ORDER.indexOf(depth);
  const shown = actions.filter((action) => ORDER.indexOf(action.priority) <= visibleDepth);
  const overflowed = actions.filter((action) => ORDER.indexOf(action.priority) > visibleDepth);

  return (
    <div
      ref={row}
      /*
        Shrinkable while it still has something to give; immovable once it does not.

        The row has to be squeezable at all, or it never learns that it is short of room — flexbox
        would hand the whole deficit to the truncating labels beside it and this component would
        measure a comfortable fit forever. But shrinking is *also* how items get clipped, and flex
        distributes a deficit proportionally, so the row keeps losing its share even after there is
        nothing left to demote. That is how the overflow button itself ends up sliced down the
        middle — measured at 6px, which is enough to look broken and not enough to notice why.

        So the floor is the row's own content once everything demotable has been demoted. From that
        point the labels absorb the rest, which is the right order anyway: a truncated name still
        reads, a half-drawn control does not.
      */
      style={{ minWidth: depth === 'always' ? 'max-content' : 0 }}
      className={cn('flex min-w-0 items-center gap-1 overflow-hidden', className)}
    >
      {shown.map((action) => (
        <ToolbarButton key={action.id} action={action} />
      ))}
      {children}
      {overflowed.length > 0 && (
        <SeedMenu
          label={overflowLabel}
          // A list of commands, not a chooser — Prompt 2 §42 keeps standard behaviour for menus.
          // See `SeedMenu`'s `motion`.
          motion="standard"
          triggerClassName="no-drag shrink-0"
          trigger={() => (
            <span className="flex size-7 items-center justify-center rounded-lg text-faint hover:bg-hover hover:text-ink">
              <MoreHorizontal size={15} />
            </span>
          )}
        >
          {(close) => (
            <>
              {overflowed.map((action) => (
                <SeedMenuItem
                  key={action.id}
                  icon={action.icon}
                  selected={action.active}
                  label={action.label}
                  onClick={() => { action.onSelect(); close(); }}
                />
              ))}
            </>
          )}
        </SeedMenu>
      )}
    </div>
  );
}

function ToolbarButton({ action }: { action: ToolbarAction }): React.ReactElement {
  return (
    <button
      type="button"
      title={action.label}
      aria-label={action.label}
      aria-pressed={action.active}
      onClick={action.onSelect}
      onMouseEnter={action.onHover}
      onFocus={action.onHover}
      className={cn(
        // `shrink-0` is what makes the measurement honest: an item allowed to squash would report
        // that it fits at any width, right down to an unreadable sliver.
        'no-drag flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ember',
        action.active ? 'bg-hover text-ember' : 'text-faint hover:bg-hover hover:text-ink',
      )}
    >
      {action.icon}
    </button>
  );
}
