/**
 * The geometry a Seed Morph is made of.
 *
 * Everything here is pure and window-coordinate based. That is deliberate: the morph's whole claim
 * is "this control became that surface", and a claim about two rectangles is only checkable if the
 * rectangles are values rather than side effects of a layout pass. The driver (./controller) does
 * the measuring and the writing; this file does the arithmetic, and the tests grade it directly.
 *
 * ## Why (x, y, width, height) and not (centre, scale)
 *
 * The obvious encoding of a shared-element transition is FLIP: lay the destination out at its final
 * size, invert it onto the seed with a transform, play to identity. It composites beautifully and it
 * is what Seed Morph v1 did. It has two defects that cannot be patched:
 *
 *   1. **The corner is a lie.** `border-radius` is resolved before the transform, so a 22px radius
 *      on a box scaled by (0.07, 0.4) paints as a 1.5×9px ellipse. The radius cannot be interpolated
 *      honestly under a scale, which is why v1 hard-coded `999px → 22px` and let it distort.
 *   2. **Content has to be counter-scaled** to survive, and a counter-scale is a resample: glyphs
 *      get re-rendered at a non-integer scale for the whole flight.
 *
 * Animating the box's real geometry fixes both — the radius is just another number in px, and the
 * content inside is never transformed at all. It also buys the anchoring the brief asks for (§6) for
 * free: with `x` and `width` as independent springs, a seed to the LEFT of its destination has a
 * left edge that travels 200px while its right edge travels 660px. The near edge stays visually
 * hooked to the source without anyone writing a rule that says so. Under centre+scale both edges
 * move symmetrically and the effect has to be faked with `transform-origin`.
 *
 * The cost is layout per frame on the morphing element. It is bounded: the surface is
 * `position: fixed` with `contain: layout paint`, so it has no in-flow siblings to reflow and its
 * own subtree is laid out at the destination's size once and then merely clipped.
 */

/** A rectangle in window coordinates, plus the corner it is drawn with. */
export interface MorphGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Uniform corner radius in px. `radiusOf` resolves `50%`-style seeds into a real number. */
  radius: number;
}

/** Anything rect-shaped — `DOMRect`, or a literal in a test. */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The window we are morphing inside. Never assumed; always passed in. */
export interface Viewport {
  width: number;
  height: number;
}

/**
 * What a surface *is*, which decides where it lands and how it is dressed.
 *
 * Prompt 2 §43: the morph system has to understand destination semantics, because a model picker
 * hugging its button and an inspector owning the window's right edge are not the same interaction
 * wearing different sizes.
 */
export type DestinationKind =
  /** Small, transient, hugs its seed. Model selector, branch chooser, quick tools. */
  | 'popover'
  /** Command palette / global search. Keyboard-first, so often *seedless* — see `hasHonestSeed`. */
  | 'palette'
  /** A control expanding in place along the toolbar it lives in. */
  | 'toolbarExpansion'
  /** The left structural region. Owns its edge and the full height. */
  | 'sidebar'
  /** The right contextual region. Owns its edge and the full height. */
  | 'inspector'
  /** A transient utility window floating over the workspace. */
  | 'floatingPanel'
  /** A large contextual surface that takes most of the window. */
  | 'workspaceSurface';

/* ------------------------------------------------------------------ radius */

/**
 * The window's own corner radius, in px.
 *
 * macOS 26 draws a window corner around this size at 1x. It is a constant here rather than a
 * measurement because Chromium cannot see the native frame's corner — and it is named rather than
 * inlined so that when the shell's corner changes, the surfaces that are supposed to nest inside it
 * change with it. That relationship is the entire point of the concentric rule.
 */
export const WINDOW_RADIUS = 12;

/** A standard control (button, field, row). */
export const CONTROL_RADIUS = 10;

/** A popover or dropdown. */
export const POPOVER_RADIUS = 14;

/** A floating sheet. Bigger surface, bigger corner — the curvature has more edge to relax into. */
export const PANEL_RADIUS = 22;

/**
 * The corner an inset surface should draw so it looks concentric with its container.
 *
 * Two rounded rectangles look nested when their corner arcs share a centre, which means the inner
 * radius is the outer radius minus the gap between them. Get this wrong in either direction and the
 * eye reads it immediately: an inner radius that is too large bulges away from the corner, one too
 * small leaves a wedge of container visible inside the curve.
 *
 * This is the arithmetic behind AppKit's `NSViewCornerRadius.containerConcentric`, reimplemented
 * because that API does not exist in the SDK installed here (26.5) and, being AppKit, would not be
 * reachable from a Chromium renderer if it did. See docs/motion/AUDIT.md §B.
 *
 * Floored at `min` rather than at 0: a surface inset far enough to compute a negative radius is not
 * asking for a sharp corner, it is simply deep inside its container, and a hairline round reads as
 * intentional where a hard 90° corner reads as a bug.
 */
export function concentricRadius(outerRadius: number, inset: number, min = 4): number {
  return Math.max(min, outerRadius - Math.max(0, inset));
}

/** The corner a surface of this kind wants, given where it sits relative to the window edge. */
export function radiusFor(kind: DestinationKind, inset: number): number {
  switch (kind) {
    case 'popover':
      return POPOVER_RADIUS;
    case 'palette':
    case 'floatingPanel':
      return PANEL_RADIUS;
    case 'toolbarExpansion':
      return CONTROL_RADIUS;
    // The bars and full-window surfaces are flush with the shell, so their corners are the window's
    // own corner brought inward by however far they sit from it. A sidebar hard against the left
    // edge inherits the window's 12px; the same sidebar with an 8px gutter draws 4px.
    case 'sidebar':
    case 'inspector':
    case 'workspaceSurface':
      return concentricRadius(WINDOW_RADIUS, inset);
  }
}

/**
 * Resolve an element's painted corner to a single number.
 *
 * A round button is `border-radius: 50%`, and 50% of nothing is nothing — the percentage has to be
 * resolved against the element's own box before it can be interpolated toward a destination's px
 * value. Percentages resolve per-axis (50% of width horizontally, 50% of height vertically), and the
 * morph carries one uniform radius, so the smaller half-extent is used: that is the value at which a
 * pill is fully round, and using the larger would clip.
 */
export function radiusOf(spec: string, box: { width: number; height: number }): number {
  const trimmed = spec.trim();
  const percent = /^([\d.]+)%$/.exec(trimmed);
  if (percent) {
    return (Number(percent[1]) / 100) * Math.min(box.width, box.height);
  }
  const px = parseFloat(trimmed);
  if (!Number.isFinite(px)) return 0;
  // A pill declares a radius far larger than its box (`999px`); it paints as half the short side.
  return Math.min(px, Math.min(box.width, box.height) / 2);
}

/* ---------------------------------------------------------------- geometry */

export function fromRect(rect: RectLike, radius: number): MorphGeometry {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, radius };
}

/**
 * Whether two boxes are the same box, to within a pixel.
 *
 * Not `===` on the fields: both ends of a morph are measured with `getBoundingClientRect`, which
 * returns sub-pixel values that differ in the last decimal between two reads of a layout that never
 * changed. A tolerance is what makes "did anything actually move?" answerable, and half a pixel is
 * below what any of this can paint.
 */
export function sameGeometry(a: MorphGeometry, b: MorphGeometry, tolerance = 0.5): boolean {
  return Math.abs(a.x - b.x) <= tolerance
    && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance
    && Math.abs(a.height - b.height) <= tolerance
    && Math.abs(a.radius - b.radius) <= tolerance;
}

/** Centre point. Used for travel distance and for the deformation axis. */
export function centreOf(g: MorphGeometry): { x: number; y: number } {
  return { x: g.x + g.width / 2, y: g.y + g.height / 2 };
}

/**
 * How big a change this morph is, on the three axes the brief says should influence the physics.
 *
 * Prompt 1 §29: a seed travelling 20px and one travelling 700px should not read as the same timing
 * curve. Prompt 2 §8 immediately constrains that — brief and precise, never "wait for the
 * animation" — so this is reported as normalized 0..1 factors and the spring grading decides how
 * little to do with them, rather than being handed a duration multiplier.
 */
export interface Travel {
  /** Centre-to-centre px. */
  distance: number;
  /** Diagonal growth ratio, ≥1 for a growing surface. */
  sizeDelta: number;
  /** How much the shape has to change proportion, 0 = same aspect ratio. */
  aspectDelta: number;
}

export function travelBetween(from: MorphGeometry, to: MorphGeometry): Travel {
  const a = centreOf(from);
  const b = centreOf(to);
  const fromDiagonal = Math.hypot(from.width, from.height) || 1;
  const toDiagonal = Math.hypot(to.width, to.height) || 1;
  const fromAspect = from.width / Math.max(1, from.height);
  const toAspect = to.width / Math.max(1, to.height);
  return {
    distance: Math.hypot(b.x - a.x, b.y - a.y),
    sizeDelta: toDiagonal / fromDiagonal,
    // Ratio of ratios, folded so 2:1 and 1:2 are the same amount of reshaping.
    aspectDelta: Math.abs(Math.log(Math.max(toAspect, 1e-3) / Math.max(fromAspect, 1e-3))),
  };
}

/* ------------------------------------------------------------ destinations */

/** What a caller asks for. The window gets the final say. */
export interface DestinationRequest {
  kind: DestinationKind;
  /** Preferred width in px. Ignored by the bars, which negotiate width only. */
  width?: number;
  /** Preferred height in px. Omit to let the kind decide. */
  height?: number;
  /** Gap from the seed (popovers) or the window edge (everything else). */
  gap?: number;
}

/** Breathing room between a floating surface and the window edge, when the window can afford it. */
const EDGE_MARGIN = 20;

/** Gap between a popover and the control it came from. Close enough to read as attached. */
const SEED_GAP = 8;

const DEFAULTS: Record<DestinationKind, { width: number; height?: number }> = {
  popover: { width: 260 },
  palette: { width: 640, height: 420 },
  toolbarExpansion: { width: 320 },
  sidebar: { width: 260 },
  inspector: { width: 340 },
  floatingPanel: { width: 560 },
  workspaceSurface: { width: 960 },
};

/**
 * Where a surface of this kind lands, in this window, seeded from here.
 *
 * The whole responsive story (Prompt 1 §21, §23; Prompt 2 §23, §25) lives in this one pure
 * function, and it is a function rather than a pile of CSS clamps because the flight needs exactly
 * the numbers the layout gets. A surface that CSS sizes one way while the driver assumes another
 * flies smoothly to the wrong place — the worst kind of bug, because it looks deliberate.
 *
 * `seed` may be null: a palette opened from ⌘K has no spatial origin, and Prompt 2 §45 is explicit
 * that one must not be invented. Placement still has to work.
 */
export function destinationFor(
  request: DestinationRequest,
  viewport: Viewport,
  seed: MorphGeometry | null,
): MorphGeometry {
  const kind = request.kind;
  const defaults = DEFAULTS[kind];
  const vw = Math.max(1, viewport.width);
  const vh = Math.max(1, viewport.height);

  if (kind === 'sidebar' || kind === 'inspector') {
    // A bar is a region of the window, not a sheet over it: it owns its edge and the full height,
    // and only its width negotiates. Its corner is therefore the window's, brought in by 0.
    const width = Math.min(request.width ?? defaults.width, vw);
    return {
      x: kind === 'sidebar' ? 0 : vw - width,
      y: 0,
      width,
      height: vh,
      radius: radiusFor(kind, 0),
    };
  }

  if (kind === 'popover' || kind === 'toolbarExpansion') {
    return anchoredBox(request, viewport, seed, defaults);
  }

  // Centred surfaces: palette, floatingPanel, workspaceSurface.
  const margin = request.gap ?? EDGE_MARGIN;
  // The margin yields before the surface does. On a 320px window a fixed 20px gutter each side
  // leaves 280px for a 560px panel, so the gutter collapses toward zero rather than the panel going
  // negative — and the surface stays usable at sizes the design was never drawn at.
  const gutterX = Math.min(margin, vw * 0.2);
  const gutterY = Math.min(margin, vh * 0.2);
  const width = Math.min(request.width ?? defaults.width, vw - gutterX * 2);
  const height = Math.min(
    request.height ?? defaults.height ?? vh * 0.78,
    vh - gutterY * 2,
  );

  // A palette sits high, the way every Mac command palette does — the user's eye is already at the
  // top of the window and the results list wants room to grow downward.
  const top = kind === 'palette'
    ? Math.min(Math.round(vh * 0.14), Math.max(gutterY, vh - height - gutterY))
    : Math.round((vh - height) / 2);

  return {
    x: clamp(Math.round((vw - width) / 2), 0, Math.max(0, vw - width)),
    y: clamp(top, 0, Math.max(0, vh - height)),
    width,
    height,
    radius: radiusFor(kind, Math.min(gutterX, gutterY)),
  };
}

/**
 * A surface that hangs off its seed, flipped away from whichever edge it would have hit.
 *
 * Prompt 1 §5 and §23: the origin's position is part of the interaction's meaning, and a seed in a
 * corner must not produce a surface that clips. So the box is placed below the seed by default,
 * flipped above when there is more room there, and then slid along the cross axis to stay inside —
 * *aligned* to the seed's near edge rather than centred on it, so the surface visibly belongs to the
 * control rather than merely appearing near it.
 */
function anchoredBox(
  request: DestinationRequest,
  viewport: Viewport,
  seed: MorphGeometry | null,
  defaults: { width: number; height?: number },
): MorphGeometry {
  const vw = viewport.width;
  const vh = viewport.height;
  const gap = request.gap ?? SEED_GAP;
  const width = Math.min(request.width ?? defaults.width, vw - EDGE_MARGIN * 2);
  const wanted = request.height ?? defaults.height ?? 280;

  // No seed: behave like a small centred sheet rather than guessing a corner to hug.
  if (!seed) {
    const height = Math.min(wanted, vh - EDGE_MARGIN * 2);
    return {
      x: Math.round((vw - width) / 2),
      y: Math.round((vh - height) / 2),
      width,
      height,
      radius: radiusFor(request.kind, EDGE_MARGIN),
    };
  }

  const below = vh - (seed.y + seed.height) - gap - EDGE_MARGIN;
  const above = seed.y - gap - EDGE_MARGIN;
  // Prefer below (the direction a Mac menu opens), but flip when below genuinely cannot hold the
  // surface and above can hold more of it. Comparing *available space* rather than testing "does it
  // fit" keeps the choice stable while the window is being dragged smaller: the surface flips once,
  // at the crossover, instead of oscillating around a fit threshold.
  const flip = below < wanted && above > below;
  const height = Math.min(wanted, Math.max(64, flip ? above : below));

  const y = flip
    ? seed.y - gap - height
    : seed.y + seed.height + gap;

  // Align to whichever of the seed's edges is further from the window edge, so the surface opens
  // *away* from the boundary — a seed on the right opens leftward, which is what §5 describes.
  const seedCentre = seed.x + seed.width / 2;
  const x = seedCentre > vw / 2
    ? seed.x + seed.width - width
    : seed.x;

  return {
    x: clamp(Math.round(x), EDGE_MARGIN, Math.max(EDGE_MARGIN, vw - width - EDGE_MARGIN)),
    y: clamp(Math.round(y), EDGE_MARGIN, Math.max(EDGE_MARGIN, vh - height - EDGE_MARGIN)),
    width,
    height: Math.round(height),
    radius: radiusFor(request.kind, EDGE_MARGIN),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * The vertical edge of a box, as a zero-width origin.
 *
 * This is what a structural region grows out of: the sidebar's left edge, the inspector's right one.
 * It is a *seed* like any other — the five springs do not know the difference — but because only `x`
 * and `width` differ from the destination, the flight is a pure width transition. The far edge sits
 * still and the near one sweeps across, which is Prompt 2 §76's "edge movement, not object scaling"
 * expressed as geometry rather than as a special case in the driver.
 *
 * Zero width, not one pixel: a 1px sliver of glass at the window edge is visible for the first few
 * frames and reads as a hairline artefact. Nothing downstream divides by it — `travelBetween` floors
 * both the diagonal and the aspect, and the reveal is normalized against the *largest* span, which
 * here is the width.
 */
export function edgeOf(box: MorphGeometry, side: 'left' | 'right'): MorphGeometry {
  return {
    x: side === 'left' ? box.x : box.x + box.width,
    y: box.y,
    width: 0,
    height: box.height,
    // The corner belongs to the panel, not to the edge. A zero-width box with a 12px radius paints
    // nothing at all, and interpolating up from 0 means the corner arrives with the width.
    radius: 0,
  };
}

/**
 * Move a seed inside a container without resizing it.
 *
 * Carried over from v1, where it earned its place: a bar seeded from a toggle in the title bar would
 * otherwise spend the first half of its flight outside its own clipping column — invisible — and
 * then appear from the clipped edge. What the user reads is not "the button unfolded", it is
 * "something slid in from the top", which is the animation this system exists to replace.
 *
 * A seed larger than the container is shrunk first: otherwise no position satisfies "inside", and
 * clamping alone would silently leave it hanging out of one edge.
 */
export function projectInto(seed: MorphGeometry, container: MorphGeometry): MorphGeometry {
  const width = Math.min(seed.width, container.width);
  const height = Math.min(seed.height, container.height);
  return {
    width,
    height,
    x: clamp(seed.x, container.x, container.x + container.width - width),
    y: clamp(seed.y, container.y, container.y + container.height - height),
    radius: seed.radius,
  };
}

/**
 * How far along the flight is, from the geometry alone.
 *
 * Deliberately derived rather than tracked: a morph that is retargeted mid-flight (the window
 * resized, the inspector's width changed) has no meaningful "elapsed / total", but it always has a
 * current box, a start and a destination. Measuring progress geometrically means the content reveal
 * survives every interruption the brief demands without a single special case.
 *
 * Normalized against the largest of the four spans so that a morph which mostly grows and barely
 * moves is not reported as instantly complete because its centre arrived first.
 */
export function progressOf(from: MorphGeometry, current: MorphGeometry, to: MorphGeometry): number {
  const spans = [
    Math.abs(to.x - from.x),
    Math.abs(to.y - from.y),
    Math.abs(to.width - from.width),
    Math.abs(to.height - from.height),
  ];
  const total = Math.max(...spans);
  // Start and destination coincide (a re-open of an already-open surface): nothing to travel, so
  // the flight is over by definition. Reporting 0 here would hide the content indefinitely.
  if (total < 0.5) return 1;

  const remaining = Math.max(
    Math.abs(to.x - current.x),
    Math.abs(to.y - current.y),
    Math.abs(to.width - current.width),
    Math.abs(to.height - current.height),
  );
  return clamp(1 - remaining / total, 0, 1);
}
