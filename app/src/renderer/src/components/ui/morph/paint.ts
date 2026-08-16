/**
 * The write half of a frame: turn a `MorphFrame` into element styles.
 *
 * Split out from the driver so the physics can be graded without a DOM, and so there is exactly one
 * place that knows which CSS property carries which part of the geometry. That mapping is fussier
 * than it looks and getting it wrong produces animations that are smooth and wrong:
 *
 *   - Position rides the **`translate` property**, not `transform: translate()`. The individual
 *     transform properties (`translate`, `rotate`, `scale`) compose with each other, so the
 *     deformation can own `scale` without either of them having to know the other exists. Packing
 *     both into `transform` means every writer has to reconstruct the whole matrix, and whoever
 *     writes last silently wins.
 *   - Size rides real `width`/`height`, which is the entire point of v2 (see ./geometry). The
 *     surface is `position: fixed` and `contain: layout paint`, so this lays out the surface and
 *     nothing else — no ancestor reflow, and its own subtree is fixed-size and merely clipped.
 *   - The corner rides real `border-radius` in px, so it interpolates honestly instead of being an
 *     ellipse smeared by a scale.
 */

import type { MorphFrame } from './controller';

/** The two elements a morph drives. `content` is optional — a bare shell is legitimate. */
export interface MorphElements {
  surface: HTMLElement;
  content: HTMLElement | null;
}

/** How far the content lifts into place as it is revealed. Small: this is a fade, not an entrance. */
const REVEAL_LIFT = 6;
/** Peak blur on arriving content. Kept low — blur is the most expensive thing on this path. */
const REVEAL_BLUR = 2.5;

/**
 * Apply one frame.
 *
 * Every write here is unconditional and idempotent. No reads, no `getComputedStyle`, no
 * `getBoundingClientRect` — this function is the "write" half of the read/write split Prompt 1 §26
 * asks for, and it stays that way only if nothing in it ever asks the layout engine a question.
 */
export function paintFrame(elements: MorphElements, frame: MorphFrame): void {
  const { surface, content } = elements;
  const g = frame.geometry;

  surface.style.translate = `${round(g.x)}px ${round(g.y)}px`;
  surface.style.width = `${round(g.width)}px`;
  surface.style.height = `${round(g.height)}px`;
  surface.style.borderRadius = `${round(Math.max(0, g.radius))}px`;
  surface.style.scale = `${frame.deform.x.toFixed(4)} ${frame.deform.y.toFixed(4)}`;
  // A seeded collapse needs no fade: it ends with the shell sitting exactly on its own trigger, at
  // that control's size and corner, so the unmount is invisible. An unseeded one ends over empty
  // background — a menu that appeared in place, ⌘K, anything under Reduce Motion — and would pop
  // out of existence at whatever size it had reached. `dismiss`'s reveal ramp is reused rather than
  // adding a second curve: the content is already fading on it, so the glass leaves with its
  // contents instead of outliving them by a hundred milliseconds.
  surface.style.opacity = !frame.seeded && frame.state === 'closing' ? frame.reveal.toFixed(3) : '';

  // Material (Prompt 1 §11). `--glass-thickness` is the existing lens-band dial, so the morphing
  // surface uses the same knob the static glass classes already use rather than a parallel one.
  //
  // Quantized, unlike the geometry above, because these three feed a *box-shadow stack and two
  // backdrop-filtered pseudo-elements* — the most expensive things on this path by a wide margin.
  // Geometry has to be sub-pixel or the surface judders; the material does not, and stepping it
  // means the shadow recomputes about fifteen times across a flight instead of sixty. Nothing is
  // visible at these step sizes: 0.5px of lens band and 4% of shadow alpha are both below the
  // threshold where a still frame differs.
  surface.style.setProperty('--glass-thickness', `${quantize(frame.material.thickness, 0.5)}px`);
  surface.style.setProperty('--morph-elevation', `${quantize(frame.material.elevation, 0.04)}`);
  surface.style.setProperty('--morph-sheen', `${quantize(frame.material.sheen, 0.05)}`);

  if (!content) return;

  const reveal = frame.reveal;
  content.style.opacity = reveal.toFixed(3);
  // Counter the deformation exactly, so the 3% stretch lives on the glass and never on the text
  // inside it. Cheap — two numbers — and it is the difference between "the material has momentum"
  // and "the labels wobble".
  content.style.scale = `${(1 / frame.deform.x).toFixed(4)} ${(1 / frame.deform.y).toFixed(4)}`;
  content.style.translate = `0px ${round((1 - reveal) * REVEAL_LIFT)}px`;
  // `none` rather than `blur(0px)`: a zero-radius filter still allocates a filter pass, and at rest
  // that is a permanent cost on a surface that is no longer animating.
  content.style.filter = reveal > 0.995 ? 'none' : `blur(${((1 - reveal) * REVEAL_BLUR).toFixed(2)}px)`;
  // Content that has not arrived must not be clickable. Without this, a panel at 20% reveal already
  // has live buttons under an almost-invisible layer, which is how a "dead click" turns out to be a
  // click on something the user could not see.
  content.style.pointerEvents = reveal > 0.6 ? '' : 'none';
}

/* ------------------------------------------------------------------ region */

/**
 * Reveal an in-layout region through the flight's own geometry.
 *
 * The counterpart to `paintFrame` for a structural region (see ../morph/MorphRegion): the region is
 * already where it is going to be, at its real size, so nothing about it is animated except *how
 * much of it exists yet*. Clipping it to the shell's live box means the content is uncovered by the
 * growing container — Prompt 1 §12 — rather than fading in on its own schedule beside it.
 *
 * `clip-path` rather than `overflow: hidden` on a wrapper, for two reasons that both matter here:
 * it is a paint-time property, so a region containing a terminal and a diff view is not re-laid-out
 * sixty times; and it takes a `round` radius, so the reveal's corner is the same corner the shell is
 * drawing, at the same value, on the same frame.
 *
 * `destination` is passed in rather than measured. This function is on the write half of the frame
 * and must never ask the layout engine a question.
 */
export function paintRegionClip(
  region: HTMLElement,
  frame: MorphFrame,
  destination: { x: number; y: number; width: number; height: number } | null,
): void {
  if (!destination) return;
  const g = frame.geometry;
  // The shell's box in the region's own coordinates, as insets from each edge. Clamped at zero: an
  // overshoot puts the shell a pixel or two outside the region, and a negative inset would grow the
  // clip past the element's box — where there is nothing to show anyway.
  const top = Math.max(0, g.y - destination.y);
  const left = Math.max(0, g.x - destination.x);
  const right = Math.max(0, (destination.x + destination.width) - (g.x + g.width));
  const bottom = Math.max(0, (destination.y + destination.height) - (g.y + g.height));

  region.style.clipPath =
    `inset(${round(top)}px ${round(right)}px ${round(bottom)}px ${round(left)}px round ${round(Math.max(0, g.radius))}px)`;
  region.style.opacity = frame.reveal.toFixed(3);
  // Same rule as a surface's content: a region at 20% reveal has live controls under something the
  // user cannot see yet, and a click that lands on one of them is indistinguishable from a bug.
  region.style.pointerEvents = frame.reveal > 0.6 ? '' : 'none';
  region.style.willChange = 'clip-path, opacity';
}

/**
 * Hand the region back to the layout.
 *
 * Every property `paintRegionClip` writes is cleared, not set to a resting value — a region left at
 * `opacity: 1` and `clip-path: inset(0…)` is still a composited layer with a clip, permanently, for
 * a flight that finished. It also still has a stacking context, which is the kind of leftover that
 * turns into a z-index bug in a panel someone adds six months later.
 */
export function releaseRegion(region: HTMLElement): void {
  region.style.clipPath = '';
  region.style.opacity = '';
  region.style.pointerEvents = '';
  region.style.willChange = '';
}

/**
 * Prepare an element to be driven, and hint the compositor.
 *
 * `will-change` is set for the flight and cleared at rest deliberately: it promotes the surface to
 * its own layer, which is what keeps a 60fps flight cheap, and holding it forever on a settled panel
 * is a permanent memory cost for a promise nobody is going to collect.
 */
export function armSurface(elements: MorphElements): void {
  const { surface, content } = elements;
  surface.style.position = 'fixed';
  surface.style.left = '0';
  surface.style.top = '0';
  surface.style.willChange = 'translate, width, height';
  surface.style.contain = 'layout paint';
  if (content) content.style.willChange = 'opacity, translate, filter';
}

export function disarmSurface(elements: MorphElements): void {
  const { surface, content } = elements;
  surface.style.willChange = '';
  surface.style.scale = '';
  surface.style.opacity = '';
  if (content) {
    content.style.willChange = '';
    content.style.filter = '';
    content.style.scale = '';
    content.style.translate = '';
    content.style.pointerEvents = '';
  }
}

/** Sub-pixel, but not absurdly so. Two decimals is below a device pixel at 3x and keeps writes short. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Snap to a step, so repeated frames write an identical string and the style system no-ops. */
function quantize(value: number, step: number): number {
  return Math.round(value / step) * step;
}
