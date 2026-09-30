/**
 * The lifecycle half of a morph, once.
 *
 * Three surfaces in this app own their DOM differently — `MorphSurface` portals a shell with a
 * content layer sized to the destination, `MorphRegion` leaves its content in the layout and flies
 * an empty shell over it, and `ui/dialog` has to let Radix own the node so the focus trap stays
 * real. What none of them differ on is the *lifecycle*: build one controller and keep it for the
 * surface's whole life, open and close by retargeting rather than restarting, re-measure when the
 * world moves, paint every frame, and stay mounted until the collapse has actually finished.
 *
 * That was written out three times before this hook existed, which is precisely the "duplicate
 * animation systems" Prompt 1 §36 warns about — not three animation *engines* (there is one), but
 * three chances for one of them to quietly stop calling `remeasure`, or to unmount a surface that
 * is still flying, and for the difference to show up only on the surface nobody re-tested.
 *
 * The caller keeps its elements and its markup. This owns the controller.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MorphController, type MorphFrame } from './controller';
import type { DestinationKind, MorphGeometry } from './geometry';
import { armSurface, disarmSurface, paintFrame, type MorphElements } from './paint';
import { prefersReducedMotion } from '../motion';

export interface MorphDriverOptions {
  /** The caller's intent. `active` lags this on the way down, by exactly the collapse. */
  open: boolean;
  /**
   * What the surface is. A function, not a value: a `kind` change must never rebuild the
   * controller, because rebuilding it loses the spring state and strands the element it was driving
   * (measured in the Motion Lab as two frozen ghost surfaces).
   */
  kind: () => DestinationKind;
  /** Re-measure both ends. Called on open, on close, and whenever the world moves. */
  resolve: () => { seed: MorphGeometry | null; destination: MorphGeometry };
  /**
   * The nodes to paint, or null while they do not exist yet.
   *
   * Portalled children do not exist on the commit that renders the portal, so this legitimately
   * arrives late — `subscribe` publishes immediately, which is what lets a flight already in the air
   * be picked up rather than missed.
   */
  elements: MorphElements | null;
  /** Extra per-frame writes the caller owns: a region's clip, a dialog's overlay. */
  paint?: (frame: MorphFrame) => void;
  onClosed?: () => void;
  onSettled?: () => void;
  onFrame?: (frame: MorphFrame) => void;
  /**
   * An element whose *parent* is watched for size changes.
   *
   * Dragging a splitter moves everything on one side of it and fires no `resize` event at all, so a
   * surface that only listens to the window retargets on the one interaction that never happens and
   * misses the one that does.
   */
  observe?: HTMLElement | null;
}

export interface MorphDriver {
  /** True from the moment the caller opens until the collapse has finished. Drives mounting. */
  active: boolean;
  /** For callers that need to command it directly — the Motion Lab's interruption drills. */
  controller: () => MorphController | null;
}

export function useMorphDriver(options: MorphDriverOptions): MorphDriver {
  const { open, elements, observe } = options;
  const [active, setActive] = useState(open);
  const controllerRef = useRef<MorphController | null>(null);

  /*
    Every input reaches the controller through a ref.

    Callers pass inline arrows, so each of these is a new function on every render; listing them as
    effect dependencies would tear down and rebuild the controller on every unrelated keystroke in
    the app — mid-flight, losing the momentum, and leaving whatever it was driving frozen.
  */
  const latest = useRef(options);
  latest.current = options;

  useLayoutEffect(() => {
    if (open) setActive(true);
  }, [open]);

  useLayoutEffect(() => {
    const controller = new MorphController({
      kind: () => latest.current.kind(),
      resolve: () => latest.current.resolve(),
      reducedMotion: prefersReducedMotion,
      onClosed: () => {
        setActive(false);
        latest.current.onClosed?.();
      },
      onSettled: () => latest.current.onSettled?.(),
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  // Open / close. Neither restarts the flight — both retarget it, so a close arriving mid-open
  // curves back out of the growth it is already in rather than snapping to the seed and replaying.
  useLayoutEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !active) return;
    if (open) {
      controller.open();
      return;
    }
    // Closing something that never opened is a no-op inside the controller, so it would never call
    // back — and the caller would keep a surface mounted forever waiting for it.
    if (controller.state === 'closed') {
      setActive(false);
      latest.current.onClosed?.();
    } else {
      controller.close();
    }
  }, [open, active]);

  useLayoutEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !elements) return;
    armSurface(elements);
    /*
      Re-measure, because the flight may have started without these.

      A portal renders `null` on its own first commit — Radix defers to a layout effect so server
      rendering has no `document.body` to reach for — so the commit that opens a surface can be one
      where its nodes do not exist yet. The open effect above still runs (its dependencies changed),
      `resolve()` finds nothing to measure, and the destination falls back to a default: a sheet
      sized for content it never saw. Measured as a 560×624 dialog holding 197px of content.

      Retargeting rather than restarting is what makes this invisible: the springs keep the seed
      they launched from and simply curve toward the right box, which they are still nowhere near
      one frame in.
    */
    controller.remeasure();
    const unsubscribe = controller.subscribe((frame) => {
      paintFrame(elements, frame);
      latest.current.paint?.(frame);
      latest.current.onFrame?.(frame);
      // The compositor hint is a promise to keep changing; holding it on a settled surface is a
      // permanent layer nobody is going to collect.
      if (frame.state === 'open' || frame.state === 'closed') disarmSurface(elements);
    });
    return () => {
      unsubscribe();
      disarmSurface(elements);
    };
    // `elements` is an object literal at most call sites, so it is compared by the identity the
    // caller gives it — memoize it there, on the nodes it holds.
  }, [elements]);

  // Both ends of the morph move when the world does (Prompt 2 §79).
  //
  // A LAYOUT effect, so the observer exists before the first paint and its first callback lands in that same frame's
  // rendering steps. It was a passive effect, which starts after paint: a structural region that its panel group sizes
  // in a layout effect was therefore drawn once at full width before its flight could take hold of the layout —
  // measured as the conversation snapping 401px narrower for one frame and back (UI fix list item 11).
  useLayoutEffect(() => {
    if (!active) return;
    const onResize = (): void => controllerRef.current?.remeasure();
    window.addEventListener('resize', onResize);
    let observer: ResizeObserver | undefined;
    if (observe && typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(onResize);
      observer.observe(observe);
    }
    return () => {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
    };
  }, [active, observe]);

  const controller = useCallback(() => controllerRef.current, []);
  return { active, controller };
}
