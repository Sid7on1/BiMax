/**
 * A structural region that grows out of its own edge — and then stops being an animation.
 *
 * This is the second destination class in the system, and it is not a bigger popover. Prompt 2 §46
 * and §47 draw the distinction precisely: *during* the transition a sidebar or inspector is a
 * growing structural region, and *after* it settles it is part of the window's layout and leaves the
 * overlay layer. A surface that keeps living on the overlay is a floating card that happens to be
 * docked — it cannot be resized by the splitter, it does not reflow its neighbours, and it sits
 * above the title bar.
 *
 * ## Why the edge, and not the control that was pressed
 *
 * The first version of this seeded both bars from the intent tracker, so the inspector grew out of
 * whichever control had opened it — the lane chip, the composer, the dock, ⌘J. That is a faithful
 * reading of Prompt 1 §17 (*a sidebar should not simply slide in from off-screen if a visible
 * control triggered it*) and it is the wrong one, for a reason §75 states directly: **hiding and
 * unhiding a persistent sidebar is a structural width transition**, and only *a small button
 * creating a contextual region* is a Seed Morph. These two bars are persistent. They have splitters,
 * they have remembered widths, they are in the layout group, and the user opens and closes them
 * dozens of times a session. A 700px diagonal flight across the workspace every time is the
 * "animation spectacle" §8 rules out, and it also makes the same panel arrive from a different
 * direction depending on which of five controls the user happened to use.
 *
 * So the origin is the region's own outer edge (`edgeOf`), and what the user sees is the window's
 * layout edge sweeping across — with the content already laid out behind it, uncovered rather than
 * flown in. §17 is still honoured in the part that matters: this is emphatically not a finished
 * panel sliding in from off-screen, because nothing translates. The panel is where it will be for
 * the whole flight; only its near edge moves.
 *
 * `seed` remains on the props for a genuinely contextual region — §75's small button creating one —
 * and no caller in the app passes it today.
 *
 * So the region is in the layout from the first frame, at its real width, and what flies is a piece
 * of glass with nothing in it:
 *
 *   - **The shell** — portalled, `position: fixed`, driven by the same `MorphController` as every
 *     other morph — travels from the seed to the region's measured box.
 *   - **The region itself** is clipped to the shell's live geometry and faded in behind it, so the
 *     content is revealed *by* the growing container rather than fading in independently
 *     (Prompt 1 §12, §13).
 *   - At rest the shell unmounts and the clip is dropped. The layout owns the region; nothing is
 *     left driving anything.
 *
 * ## Why the content is not rendered inside the shell
 *
 * `MorphSurface` lays its children out at the destination's size inside the flying element, which is
 * the right answer for a menu and the wrong one here. The inspector holds live sessions, an xterm,
 * a diff view; mounting a second copy of that tree for the duration of a flight would double every
 * effect it runs, and handing over at the end would remount them again. The region has to *be* the
 * destination, mounted once — which means the flight has to happen around it.
 *
 * ## Why the destination is measured, not computed
 *
 * `destinationFor('inspector', …)` returns the box a *floating* inspector would want. The real one
 * is wherever the resizable panel group put it, which depends on a width the user dragged and may
 * have persisted. Measuring the element means the shell lands exactly where the content already is —
 * including its real corner radius, so nothing pops at the handoff — and it costs one
 * `getBoundingClientRect` at the two edges of the flight instead of a duplicated layout model that
 * would drift out of agreement with CSS the first time either changed.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../../lib/cn';
import type { MorphFrame } from './controller';
import { edgeOf, type DestinationKind, type MorphGeometry } from './geometry';
import { paintRegionClip, releaseRegion } from './paint';
import { useMorphDriver } from './use-morph';
import { measureElement, type SeedHandle } from './use-seed';

export interface MorphRegionProps {
  open: boolean;
  /**
   * Where the region grows from. Omit — which every caller in the app now does — and it grows from
   * its own window edge. See the header.
   */
  seed?: SeedHandle;
  /** `sidebar` or `inspector`. Decides the spring and the glass, not the placement. */
  kind: Extract<DestinationKind, 'sidebar' | 'inspector'>;
  /** Fired when the collapse has finished, so the parent can drop the region from the layout. */
  onCollapsed?: () => void;
  /** Fired when the region has taken ownership of its own geometry. */
  onSettled?: () => void;
  onFrame?: (frame: MorphFrame) => void;
  className?: string;
  children: React.ReactNode;
}

export function MorphRegion({
  open, seed, kind, onCollapsed, onSettled, onFrame, className, children,
}: MorphRegionProps): React.ReactElement {
  const [region, setRegion] = useState<HTMLDivElement | null>(null);
  /*
    The same node as a ref, because `resolve()` runs inside the layout effect that starts the
    flight — before React has re-rendered with the state above. (The state exists so the paint
    effect can *depend* on the node arriving; the ref is how the driver reads it during a commit.)
  */
  const regionNode = useRef<HTMLDivElement | null>(null);
  const setRegionNode = useCallback((node: HTMLDivElement | null) => {
    regionNode.current = node;
    setRegion(node);
  }, []);

  const [shell, setShell] = useState<HTMLDivElement | null>(null);
  /**
   * The destination as last measured.
   *
   * Held here so the per-frame write can position the clip in the region's own coordinates without
   * asking the layout engine anything. Prompt 1 §26: measurement happens at the edges of a flight,
   * never inside one.
   */
  const destination = useRef<MorphGeometry | null>(null);

  const resolve = useCallback(() => {
    // The region's real box, with the real corner it is painted with — see the file header.
    const measured = measureElement(regionNode.current);
    // A region with no box yet (the panel mounted this very commit and the group has not sized it)
    // would otherwise become a destination of 0×0 at the window origin, and the shell would fly
    // there. Keeping the previous destination is right in both directions: on open the resize
    // observer retargets as soon as the group lays out, and on close the last known box is exactly
    // the one the user is looking at.
    if (measured) destination.current = measured;
    const current = destination.current ?? { x: 0, y: 0, width: 0, height: 0, radius: 0 };
    // No seed given: the region's own outer edge is the origin. Derived from the destination that
    // was just measured, not from the window, so a sidebar that is second in its panel group — or
    // one the user has dragged narrower — still starts from the edge it actually has.
    const origin = seed
      ? seed.measure()
      : edgeOf(current, kind === 'sidebar' ? 'left' : 'right');
    return { seed: origin, destination: current };
  }, [seed, kind]);

  // Memoized on the nodes, not rebuilt per render: the driver re-subscribes whenever this identity
  // changes, and re-subscribing mid-flight would re-arm the shell every frame.
  const elements = useMemo(() => (shell ? { surface: shell, content: null } : null), [shell]);

  const paint = useCallback((frame: MorphFrame) => {
    // The shell is the container while the region is still arriving, and the region *is* the
    // container once it has. Crossfading the two across the same clip is what keeps that a change
    // of material rather than a swap of elements: their geometry is identical every frame, so the
    // only thing that varies is which of them is drawing it.
    if (shell) shell.style.opacity = (1 - frame.reveal).toFixed(3);
    if (region) paintRegionClip(region, frame, destination.current);
  }, [shell, region]);

  /** The handoff, and its mirror on the way out. Both drop the clip in the same commit. */
  const release = useCallback(() => {
    if (regionNode.current) releaseRegion(regionNode.current);
  }, []);

  /*
    A region's overlay dies at *settle*; a popover's dies at close.

    That is the one place this component cannot take the driver's own lifetime. `active` means "keep
    the element mounted", which for `MorphSurface` is right — the surface it mounts *is* the
    destination, so it lives until the collapse finishes. Here the shell is scaffolding: the moment
    the geometry arrives, the layout owns the column and the overlay has to go, or the inspector is
    a floating card wearing a docked shape and its splitter does nothing (Prompt 2 §47).
  */
  const [handedOff, setHandedOff] = useState(false);
  React.useLayoutEffect(() => { setHandedOff(false); }, [open]);

  const { active } = useMorphDriver({
    open,
    kind: () => kind,
    resolve,
    elements,
    paint,
    observe: region,
    onSettled: () => { release(); setHandedOff(true); onSettled?.(); },
    onClosed: () => { release(); onCollapsed?.(); },
    onFrame,
  });

  const flying = active && !handedOff;

  return (
    <>
      <div ref={setRegionNode} className={cn('morph-region h-full', className)}>
        {children}
      </div>
      {flying && typeof document !== 'undefined' && createPortal(
        <div
          ref={setShell}
          aria-hidden
          // Decorative for its whole life: the region underneath owns every interaction, and a
          // shell that ate clicks would produce dead presses along the edge of an opening panel.
          className="morph-surface liquid-glass pointer-events-none z-50"
        />,
        document.body,
      )}
    </>
  );
}
