/**
 * The seed side: a control that can be measured *now*.
 *
 * v1 captured the trigger's rect at click time and kept it. That is correct for opening and wrong
 * for closing, which is a distinction the brief makes twice (Prompt 1 §22, Prompt 2 §25): between
 * the two events the window may have been resized, the sidebar dragged wider, the toolbar reflowed
 * into its overflow menu. A surface that folds back into a remembered rectangle flies, very
 * smoothly, to a place its button is no longer at.
 *
 * So a seed is a *handle*, not a value. The morph asks it where the control is at the moment it
 * needs to know.
 *
 * `../intent.ts` remains the fallback for surfaces that cannot hold a ref to their trigger — the
 * engine-raised approval prompts, and anything opened from a menu that has already unmounted. That
 * path deliberately returns null when no press was recent enough to explain the surface appearing,
 * because a modal that flies out of a button nobody touched is a false claim about causality.
 */

import { useCallback, useMemo, useRef } from 'react';
import { fromRect, radiusOf, type MorphGeometry } from './geometry';
import { recentIntent } from '../intent';

export interface SeedHandle {
  /** Attach to the trigger. */
  ref: (element: HTMLElement | null) => void;
  /** The control's geometry right now, or null if it is gone or unrendered. */
  measure: () => MorphGeometry | null;
  current: () => HTMLElement | null;
}

/** Measure any element as a morph origin, resolving its painted corner to a number. */
export function measureElement(element: HTMLElement | null): MorphGeometry | null {
  if (!element || !element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  // A control with no box — `display: none`, or collapsed into an overflow menu while the surface it
  // opened is still up. Folding into a zero-size rect at the origin of the window is worse than
  // having no seed at all, so the caller is told there isn't one.
  if (rect.width < 1 || rect.height < 1) return null;
  const style = getComputedStyle(element);
  return fromRect(rect, radiusOf(style.borderTopLeftRadius, rect));
}

export function useSeedRef(): SeedHandle {
  const element = useRef<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLElement | null) => { element.current = node; }, []);
  const measure = useCallback(() => measureElement(element.current), []);
  const current = useCallback(() => element.current, []);
  return { ref, measure, current };
}

/**
 * A seed handle backed by the last control the user actually pressed.
 *
 * For surfaces that have no way to hold a ref to their trigger — the engine-raised approval prompts,
 * the dialogs opened from a menu that has already unmounted, and the structural regions whose
 * triggers live in a different component tree entirely.
 *
 * ## It latches, and that is the whole design
 *
 * A press explains a surface *opening* only if it was recent (`INTENT_FRESHNESS_MS`), because a
 * modal that flies out of a button nobody touched is a false claim about causality. But a surface
 * that has been open for a minute still has to fold back into the control it came from, and by then
 * no press is recent. Re-reading the tracker at close time therefore gives null, and the panel
 * collapses into its own centre instead of going home.
 *
 * So the first fresh intent is *latched* — the element, not its rect — and re-measured on every
 * subsequent call. A newer press replaces the latch, which is what makes reopening the same surface
 * from a different control fly from the right place. This is Prompt 1 §15's `MorphOrigin` with the
 * rect left out: the rect is derived when it is wanted, never stored, so the trip home lands on the
 * control as it is now rather than as it was.
 *
 * A press *inside the surface itself* never replaces the latch. The model window's Done button is the
 * freshest press when the window closes, and latching it folded the window into its own footer — the
 * owner saw it "close on the Done button, the wrong place" (2026-10-01). `surface` names the element
 * whose own controls are not origins.
 */
export function intentSeed(surface: () => Element | null = () => null): SeedHandle {
  let latched: HTMLElement | null = null;
  let latchedAt = 0;
  let latchedRect: DOMRect | null = null;
  let home: HTMLElement | null = null;

  return {
    ref: () => {},
    current: () => (latched?.isConnected ? latched : null),
    measure: () => {
      const intent = recentIntent();
      // Anything fresher than what we hold is the cause of whatever is happening now — unless it was
      // pressed inside the surface, which cannot have come out of its own button.
      const own = intent?.element ? surface()?.contains(intent.element) === true : false;
      if (intent && intent.at > latchedAt && !own) {
        latched = intent.element;
        latchedAt = intent.at;
        latchedRect = intent.rect;
        // Read now, while the pressed row is still in its menu: by the time this surface closes, the menu is gone.
        home = homeOf(intent.element);
      }

      const live = measureElement(latched);
      if (live) return live;
      // A row of a menu that has closed: its menu's button is where the surface came from. Folding into the row's old
      // rect instead left a glass box hanging in empty space and then vanishing — the model window, opened from the
      // Model menu's "Change model…", did exactly that (owner, 2026-10-01: "flickers when closing and has not actual
      // closing seed").
      const back = measureElement(home);
      if (back) return back;
      // The control has gone (its pane collapsed, its menu closed) — fall back to where it was.
      // The corner cannot be read off an element that is no longer there, and a pill is the safe
      // assumption: every control in this app that opens a surface is a pill or a rounded rect, and
      // starting slightly too round reads as a control while starting too square reads as a box.
      return latchedRect
        ? fromRect(latchedRect, Math.min(latchedRect.width, latchedRect.height) / 2)
        : null;
    },
  };
}

/** The button of the `SeedMenu` an element sits in (its panel names it in `data-seed-trigger`), or null. */
export function homeOf(element: Element | null): HTMLElement | null {
  const id = element?.closest('[data-seed-trigger]')?.getAttribute('data-seed-trigger');
  return id ? document.getElementById(id) : null;
}

/**
 * `intentSeed` as a hook, with the identity a component needs.
 *
 * The handle carries the latch, so building a new one on every render would throw the origin away
 * on every unrelated keystroke in the app — and `MorphSurface` takes the handle as an effect
 * dependency, so it would also re-run the resize wiring each time.
 */
export function useIntentSeed(surface?: () => Element | null): SeedHandle {
  // Through a ref, so the handle (and its latch) keeps one identity while the caller's arrow changes every render.
  const latest = useRef(surface);
  latest.current = surface;
  return useMemo(() => intentSeed(() => latest.current?.() ?? null), []);
}
