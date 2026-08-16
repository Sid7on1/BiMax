/**
 * The React binding: one surface, driven by one controller, rendered on the overlay layer.
 *
 * This component owns three things and deliberately not a fourth:
 *
 *   1. **Lifetime.** `open` is the caller's intent; the surface stays mounted past `open === false`
 *      for exactly as long as the collapse takes, so it can fold home instead of vanishing.
 *   2. **The overlay layer** (Prompt 1 §24). Rendered through a portal to `document.body`, because
 *      the morph has to be able to cross any ancestor with `overflow: hidden`, any transform-created
 *      stacking context, and the panel columns' own clipping — all of which exist in this app's
 *      layout and any of which would silently amputate a flight.
 *   3. **Re-measurement.** A resize observer on the window and on the seed's own offset parent, so a
 *      window drag or a sidebar resize retargets the live spring instead of stranding it.
 *
 * What it does *not* own is focus semantics. A popover, a modal sheet and a structural region want
 * three different answers about focus traps, and baking one in would either over-trap the popovers
 * or under-trap the modals. `SeedPopover` (below) adds the popover answer; a modal composes this
 * with Radix's Dialog, which is already load-bearing elsewhere in the app.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../../lib/cn';
import { MorphController, type MorphFrame, type MorphState } from './controller';
import { destinationFor, type DestinationKind, type MorphGeometry, type Viewport } from './geometry';
import { armSurface, disarmSurface, paintFrame } from './paint';
import { prefersReducedMotion } from '../motion';
import type { SeedHandle } from './use-seed';

export interface MorphSurfaceProps {
  open: boolean;
  /** Where the surface came from. */
  seed: SeedHandle;
  kind: DestinationKind;
  /** Preferred size. The window still gets the final say — see `destinationFor`. */
  width?: number;
  height?: number;
  /**
   * Size the destination to what the content actually needs.
   *
   * Menus want this and designed surfaces do not. A menu with four rows in a box sized for eight is
   * a box with dead space in it, and the dead space is *worse* here than in an ordinary popover:
   * the morph's whole claim is that the destination is the shape this control becomes, so a
   * surface that arrives visibly larger than its contents reads as the animation having overshot
   * rather than as a menu that happens to be roomy.
   *
   * A palette or a floating panel is the opposite case — its size is a design decision, and
   * shrink-wrapping it to whatever happens to be in it would make the same surface a different size
   * every time it opened.
   */
  fitHeight?: boolean;
  /**
   * Whether the surface *flies* from its seed or merely appears at the place the seed puts it.
   *
   * These are two different claims and only one of them is a Seed Morph. Prompt 2 §42 keeps standard
   * system behaviour for menus, alerts, permissions and sheets — a Mac menu appears anchored to its
   * control, it does not travel out of it — while §44 wants the flight for the choosers where the
   * source→destination relationship is the point (model, branch, quick tools).
   *
   * `inPlace` keeps the seed for *placement* and withholds it from the *launch*: the surface still
   * hugs the right corner of the right control and still folds back toward it, but it starts from a
   * box at its own destination, which the controller then plays on `MOTION.materialize`. One prop,
   * no second code path, and the anchoring logic in `destinationFor` cannot drift between them.
   */
  launch?: 'seed' | 'inPlace';
  /**
   * The box the surface is placed inside. Defaults to the window.
   *
   * Exists so the Motion Lab can put a real morph inside a 320×480 frame and watch it negotiate,
   * without needing to actually resize the application window to test it.
   */
  bounds?: () => Viewport & { originX: number; originY: number };
  /** Fired when the collapse has finished and the surface may be dropped. */
  onClosed?: () => void;
  /** Fired when the expansion settles — a structural region uses this to leave the overlay. */
  onSettled?: () => void;
  /** Published every frame. The debug overlay is the only consumer in production code paths. */
  onFrame?: (frame: MorphFrame) => void;
  className?: string;
  contentClassName?: string;
  /** Passed straight through; the surface is a plain div otherwise. */
  role?: string;
  'aria-label'?: string;
  'aria-modal'?: boolean;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export function MorphSurface({
  open, seed, kind, width, height, fitHeight, launch = 'seed', bounds, onClosed, onSettled, onFrame,
  className, contentClassName, children, style, ...aria
}: MorphSurfaceProps): React.ReactElement | null {
  const [mounted, setMounted] = useState(open);
  /*
    State rather than refs for the two driven nodes.

    A portal's children do not exist on the commit that renders the portal — and a layout effect
    reading `ref.current` at that point sees null, then never retries, because its dependencies have
    not changed by the time the node actually arrives. The flight simply never starts. (Measured
    exactly this in Seed Morph v1, through Radix's Portal, which defers its mount for SSR.) A
    callback ref writing to state makes "the node exists" a dependency an effect can wait on.
  */
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  /*
    The same node, as a plain ref.

    `resolve()` has to be able to measure the content *during* the layout effect that opens the
    morph — before React has re-rendered with the state above. The ref callback runs in the commit
    phase, so the node is already there; the state exists only so the paint effect can depend on it.
  */
  const contentNode = useRef<HTMLDivElement | null>(null);
  const setContentNode = useCallback((node: HTMLDivElement | null) => {
    contentNode.current = node;
    setContent(node);
  }, []);
  const controllerRef = useRef<MorphController | null>(null);
  /** The destination's size, so the content layer can be laid out once instead of every frame. */
  const [destination, setDestination] = useState<MorphGeometry | null>(null);

  // The latest callbacks, read at fire time. These must NOT be effect dependencies: callers pass
  // inline arrows, so they are new functions on every render, and depending on them would tear down
  // and rebuild the controller — losing the spring state — on every unrelated keystroke in the app.
  const callbacks = useRef({ onClosed, onSettled, onFrame });
  callbacks.current = { onClosed, onSettled, onFrame };

  const resolve = useCallback(() => {
    const box = bounds?.() ?? { width: window.innerWidth, height: window.innerHeight, originX: 0, originY: 0 };
    const rawSeed = seed.measure();
    const viewport: Viewport = { width: box.width, height: box.height };

    // Placement is computed in the container's own space, then translated into window space. The
    // seed arrives in window space (that is what `getBoundingClientRect` returns), so it is brought
    // *into* container space for the placement decision and the result is pushed back out. Keeping
    // the two conversions adjacent is what stops a coordinate-space bug from being spread across
    // three files (Prompt 2 §63).
    const localSeed = rawSeed && {
      ...rawSeed,
      x: rawSeed.x - box.originX,
      y: rawSeed.y - box.originY,
    };
    let local = destinationFor({ kind, width, height }, viewport, localSeed);

    if (fitHeight && height === undefined && contentNode.current) {
      // Two passes, one layout read. The first pass settles the WIDTH — which does not depend on
      // height — so the content can be laid out at its real width before it is measured; measuring
      // at the wrong width gives the wrong number of wrapped lines and therefore the wrong height.
      contentNode.current.style.width = `${Math.round(local.width)}px`;
      const natural = contentNode.current.scrollHeight;
      if (natural > 0) local = destinationFor({ kind, width, height: natural }, viewport, localSeed);
    }

    return {
      // Withheld from the launch, never from the placement — see `launch`. A null seed is exactly
      // how the controller is already told "there is no honest origin" (Prompt 2 §45), so this
      // needs no new concept: it reuses the one the palette taught the system.
      seed: launch === 'inPlace' ? null : rawSeed,
      destination: { ...local, x: local.x + box.originX, y: local.y + box.originY },
    };
  }, [seed, kind, width, height, fitHeight, launch, bounds]);

  // Keep `resolve` and `kind` reachable from the controller without making either a dependency of
  // it. The controller must outlive every prop change: it *is* the animation's state, and rebuilding
  // it mid-flight both loses the momentum and — because `dispose()` cannot unmount its own surface —
  // strands the element in the DOM with nothing driving it.
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  const kindRef = useRef(kind);
  kindRef.current = kind;

  useLayoutEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  // One controller for the surface's whole life. Empty deps, deliberately: every input it needs
  // reaches it through a ref, so no prop change can ever cost it its spring state.
  useEffect(() => {
    const controller = new MorphController({
      kind: () => kindRef.current,
      resolve: () => resolveRef.current(),
      reducedMotion: prefersReducedMotion,
      onClosed: () => {
        setMounted(false);
        callbacks.current.onClosed?.();
      },
      onSettled: () => callbacks.current.onSettled?.(),
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  // Paint. Subscribed separately from the controller's own life so the driven nodes can arrive late
  // (portal) without missing the flight already in progress — `subscribe` publishes immediately.
  useLayoutEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !surface) return;
    const elements = { surface, content };
    armSurface(elements);
    const unsubscribe = controller.subscribe((frame) => {
      paintFrame(elements, frame);
      callbacks.current.onFrame?.(frame);
      if (frame.state === 'open' || frame.state === 'closed') disarmSurface(elements);
    });
    return () => {
      unsubscribe();
      disarmSurface(elements);
    };
  }, [surface, content]);

  // Open / close. The controller does not restart on either — it retargets, so a close arriving
  // mid-open curves back out of the flight it is already in.
  useLayoutEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !mounted) return;
    if (open) {
      setDestination(resolveRef.current().destination);
      controller.open();
      return;
    }
    // Closing a controller that never opened is a no-op, so it would never report back — and the
    // surface would stay mounted forever with nothing driving it. Drop it here instead of waiting
    // for a callback that is not coming.
    if (controller.state === 'closed') setMounted(false);
    else controller.close();
  }, [open, mounted]);

  // The window changed shape, so both ends of the morph did (Prompt 2 §79). Retarget rather than
  // recompute-and-jump: the surface curves to its new geometry carrying the velocity it had.
  useEffect(() => {
    if (!mounted) return;
    const onResize = (): void => {
      const controller = controllerRef.current;
      if (!controller) return;
      setDestination(resolveRef.current().destination);
      controller.remeasure();
    };
    window.addEventListener('resize', onResize);
    // Layout can also move under a surface without the window changing at all — dragging the
    // sidebar splitter is the case that matters here, and it fires no resize event. Watching the
    // seed's own element covers it, which is why the seed is a handle rather than a rect.
    const seedElement = seed.current();
    let observer: ResizeObserver | undefined;
    if (seedElement && typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(onResize);
      if (seedElement.parentElement) observer.observe(seedElement.parentElement);
    }
    return () => {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
    };
  }, [mounted, seed]);

  if (!mounted || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={setSurface}
      {...aria}
      className={cn(
        // z-index above the app, below nothing. The surface is the overlay layer.
        'morph-surface z-50 overflow-hidden',
        'liquid-glass focus:outline-none',
        className,
      )}
      style={style}
    >
      {/*
        Laid out ONCE at the destination's size and then clipped by the shell as it grows. This is
        what Prompt 1 §12/§13 describe literally — content revealed by the expanding container,
        never scaled, never re-flowed per frame — and it is why v2 needs no counter-scale: the text
        is rendered at its final size from the first frame, most of it simply outside the shell.
      */}
      <div
        ref={setContentNode}
        className={cn('absolute top-0 left-0 flex flex-col', contentClassName)}
        style={{
          width: destination ? `${Math.round(destination.width)}px` : '100%',
          // `auto` when the destination is sized FROM this element, or the two would define each
          // other. Otherwise pinned to the destination, so the shell can grow past a content layer
          // that was laid out once and never reflows.
          height: fitHeight ? 'auto' : destination ? `${Math.round(destination.height)}px` : '100%',
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ popover */

/**
 * A popover with the Mac answers to focus and dismissal.
 *
 * No focus trap: a popover is not modal, and trapping focus in one is the behaviour that makes web
 * apps feel unlike Mac apps. What it does provide is what a Mac popover actually does — Escape
 * closes it, a press outside closes it, focus returns to the control that opened it, and the
 * trigger's `aria-expanded` stays honest.
 */
export function SeedPopover({
  open, onClose, seed, children, label, ...rest
}: Omit<MorphSurfaceProps, 'role' | 'children' | 'kind'> & {
  kind?: DestinationKind;
  onClose: () => void;
  label: string;
  children: React.ReactNode;
}): React.ReactElement | null {
  const [surfaceEl, setSurfaceEl] = useState<HTMLElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (open) restoreTo.current = seed.current() ?? (document.activeElement as HTMLElement | null);
  }, [open, seed]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
      // Restore focus explicitly. The surface is portalled to `body`, so the browser's own focus
      // recovery would drop the user at the top of the document rather than back on the control.
      restoreTo.current?.focus?.();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (surfaceEl?.contains(target)) return;
      // A press on the trigger itself is the trigger's business — it will toggle us closed on its
      // own, and closing here as well would toggle twice and reopen.
      if (seed.current()?.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, onClose, seed, surfaceEl]);

  return (
    <MorphSurface
      {...rest}
      kind={rest.kind ?? 'popover'}
      open={open}
      seed={seed}
      role="dialog"
      aria-label={label}
      className={cn('liquid-glass-pop', rest.className)}
    >
      <div ref={setSurfaceEl} className="flex min-h-0 flex-1 flex-col">{children}</div>
    </MorphSurface>
  );
}

export type { MorphFrame, MorphState };
