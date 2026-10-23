import {
  WINDOW_RADIUS,
  concentricRadius,
  destinationFor,
  edgeOf,
  fromRect,
  progressOf,
  projectInto,
  radiusOf,
  travelBetween,
  type MorphGeometry,
} from '../morph/geometry';

/**
 * Geometry is where a morph goes wrong *smoothly*.
 *
 * A destination clamped a few pixels off, a seed whose corner was resolved as zero, a popover that
 * hangs off the bottom of a short window — none of these look like bugs. They look like a slightly
 * odd animation, which is why they survive review and why the numbers are pinned here instead.
 */

const seed = (x: number, y: number, w = 40, h = 40): MorphGeometry =>
  ({ x, y, width: w, height: h, radius: Math.min(w, h) / 2 });

describe('radius', () => {
  test('a percentage resolves against the box, not to zero', () => {
    // The round-button case. `border-radius: 50%` is the single most common seed in the app, and
    // reading it as a bare number gives 0 — a flight that starts from a square.
    expect(radiusOf('50%', { width: 40, height: 40 })).toBe(20);
    expect(radiusOf('50%', { width: 120, height: 40 })).toBe(20);
  });

  test('a pill radius paints as half its short side', () => {
    // `999px` on a 40px-tall control is not a 999px corner; the browser clamps it. Interpolating
    // from the declared value would launch the morph from a corner ~25x larger than the one on
    // screen, and the first frames would look like the box inflating.
    expect(radiusOf('999px', { width: 200, height: 40 })).toBe(20);
    expect(radiusOf('8px', { width: 200, height: 40 })).toBe(8);
  });

  test('junk resolves to a square corner rather than NaN', () => {
    // A NaN radius poisons the spring for the whole flight and every frame after it.
    expect(radiusOf('', { width: 40, height: 40 })).toBe(0);
    expect(radiusOf('inherit', { width: 40, height: 40 })).toBe(0);
  });

  test('concentric corners share a centre with their container', () => {
    expect(concentricRadius(WINDOW_RADIUS, 0)).toBe(WINDOW_RADIUS);
    expect(concentricRadius(20, 8)).toBe(12);
    // Inset past the container's own radius: floored to a hairline, never squared off. A hard 90°
    // corner deep inside a rounded window reads as a rendering bug; 4px reads as intentional.
    expect(concentricRadius(12, 40)).toBe(4);
  });
});

describe('destinations', () => {
  const viewport = { width: 1440, height: 900 };

  test('a bar owns its edge and the full height', () => {
    const left = destinationFor({ kind: 'sidebar', width: 260 }, viewport, seed(20, 40));
    expect(left).toMatchObject({ x: 0, y: 0, width: 260, height: 900 });

    const right = destinationFor({ kind: 'inspector', width: 340 }, viewport, seed(1400, 40));
    expect(right).toMatchObject({ x: 1100, y: 0, width: 340, height: 900 });
  });

  test('a popover opens away from the window edge it is near', () => {
    // Prompt 1 §5: the origin's position is part of the interaction's meaning. A seed on the right
    // must not produce a surface that runs off the right edge and gets clamped back — it should
    // open leftward, aligned to the seed's trailing edge.
    const onRight = destinationFor({ kind: 'popover', width: 260 }, viewport, seed(1340, 60));
    expect(onRight.x + onRight.width).toBeCloseTo(1380, 0);

    const onLeft = destinationFor({ kind: 'popover', width: 260 }, viewport, seed(24, 60));
    expect(onLeft.x).toBe(24);
  });

  test('a popover near the bottom flips above its seed', () => {
    const low = destinationFor({ kind: 'popover', width: 260, height: 300 }, viewport, seed(600, 840));
    expect(low.y + low.height).toBeLessThanOrEqual(840);
  });

  test('a popover with room below opens downward', () => {
    const high = destinationFor({ kind: 'popover', width: 260, height: 300 }, viewport, seed(600, 60));
    expect(high.y).toBeGreaterThanOrEqual(100);
  });

  test('nothing escapes a tiny window', () => {
    // Prompt 1 §21: never assume 1440x900. At 320x480 every default is larger than the window, so
    // the clamps are doing all the work and a sign error here puts the surface off screen.
    const tiny = { width: 320, height: 480 };
    for (const kind of ['popover', 'palette', 'floatingPanel', 'workspaceSurface'] as const) {
      const box = destinationFor({ kind }, tiny, seed(300, 460));
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(tiny.width + 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(tiny.height + 0.5);
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    }
  });

  test('a seedless surface still places itself', () => {
    // ⌘K has no spatial origin and Prompt 2 §45 forbids inventing one. Placement must not depend on
    // having a seed to hang off.
    const palette = destinationFor({ kind: 'palette' }, viewport, null);
    expect(palette.width).toBeGreaterThan(0);
    expect(palette.x).toBeGreaterThan(0);
    // Palettes sit high, the way every Mac palette does.
    expect(palette.y).toBeLessThan(viewport.height / 3);
  });

  test('a bar hard against the window edge inherits the window corner', () => {
    const bar = destinationFor({ kind: 'sidebar' }, viewport, null);
    expect(bar.radius).toBe(WINDOW_RADIUS);
  });

  test('every window in the test matrix produces a surface that fits', () => {
    const sizes = [
      [720, 500], [800, 600], [1024, 640], [1024, 768], [1280, 720], [1280, 800],
      [1440, 900], [1512, 982], [1728, 1117], [1920, 1080], [2560, 1440],
      // The shapes that actually break things: a dragged-flat window and a dragged-thin one.
      [1440, 320], [380, 900],
    ];
    const seeds = [seed(8, 8), seed(600, 8), seed(1200, 8), seed(8, 400), seed(1200, 800)];

    for (const [width, height] of sizes) {
      for (const origin of seeds) {
        if (origin.x > width || origin.y > height) continue;
        for (const kind of ['popover', 'palette', 'floatingPanel', 'inspector', 'sidebar'] as const) {
          const box = destinationFor({ kind }, { width, height }, origin);
          expect(box.x).toBeGreaterThanOrEqual(-0.5);
          expect(box.y).toBeGreaterThanOrEqual(-0.5);
          expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
          expect(box.y + box.height).toBeLessThanOrEqual(height + 0.5);
        }
      }
    }
  });
});

describe('projection', () => {
  test('a seed outside its column is pulled to the nearest inside point', () => {
    const column: MorphGeometry = { x: 0, y: 0, width: 260, height: 900, radius: 12 };
    const inside = projectInto(seed(600, 40), column);
    expect(inside.x).toBe(220);
    expect(inside.y).toBe(40);
    expect(inside.width).toBe(40);
  });

  test('a seed larger than its column is shrunk before it is moved', () => {
    const column: MorphGeometry = { x: 0, y: 0, width: 100, height: 100, radius: 12 };
    const inside = projectInto(seed(500, 500, 400, 400), column);
    // Otherwise no position satisfies "inside" and clamping alone leaves it hanging out of an edge.
    expect(inside.width).toBe(100);
    expect(inside.x).toBe(0);
  });
});

describe('progress', () => {
  const from = seed(100, 100);
  const to: MorphGeometry = { x: 400, y: 300, width: 500, height: 400, radius: 14 };

  test('runs 0 to 1 across the flight', () => {
    expect(progressOf(from, from, to)).toBe(0);
    expect(progressOf(from, to, to)).toBe(1);
  });

  test('is normalized against the largest span, not the first to arrive', () => {
    // A morph that mostly grows and barely moves must not report itself complete because its
    // centre got there first — that is how content appears while the box is still a sliver.
    const centreArrived = { ...from, x: to.x, y: to.y };
    expect(progressOf(from, centreArrived, to)).toBeLessThan(0.5);
  });

  test('a re-open of an already-open surface is complete, not stuck at zero', () => {
    // Same start and destination: there is nothing to travel. Reporting 0 would hide the content
    // for as long as the surface stayed open.
    expect(progressOf(to, to, to)).toBe(1);
  });
});

describe('travel', () => {
  test('reports distance, growth and reshaping separately', () => {
    const t = travelBetween(seed(0, 0), { x: 300, y: 400, width: 40, height: 40, radius: 8 });
    expect(t.distance).toBeCloseTo(500, 0);
    expect(t.sizeDelta).toBeCloseTo(1, 3);
    expect(t.aspectDelta).toBeCloseTo(0, 3);
  });

  test('a square becoming a wide sheet reports reshaping', () => {
    const t = travelBetween(seed(0, 0), { x: 0, y: 0, width: 600, height: 200, radius: 8 });
    expect(t.aspectDelta).toBeGreaterThan(1);
    expect(t.sizeDelta).toBeGreaterThan(10);
  });
});

describe('edges', () => {
  const bar: MorphGeometry = { x: 1100, y: 0, width: 340, height: 900, radius: 0 };

  test('the right edge is a zero-width strip at the box’s far side', () => {
    expect(edgeOf(bar, 'right')).toEqual({ x: 1440, y: 0, width: 0, height: 900, radius: 0 });
  });

  test('the left edge is its mirror', () => {
    expect(edgeOf(bar, 'left')).toEqual({ x: 1100, y: 0, width: 0, height: 900, radius: 0 });
  });

  test('an edge shares three of the destination’s four spans, so only the width can travel', () => {
    // The property the structural transition rests on, stated where it is decided rather than left
    // to be inferred from a flight: y and height are the destination's already, and x differs only
    // by the width. Nothing about this can produce a diagonal.
    for (const side of ['left', 'right'] as const) {
      const edge = edgeOf(bar, side);
      expect(edge.y).toBe(bar.y);
      expect(edge.height).toBe(bar.height);
      expect(Math.abs(edge.x - bar.x)).toBe(side === 'left' ? 0 : bar.width);
    }
  });

  test('travel from an edge is reported as growth, not as distance across the window', () => {
    // `gradeSpring` reads both. A bar whose origin claimed a 700px journey would be graded as a
    // long flight and slowed for it — 12% more time to do something that never leaves the column.
    const t = travelBetween(edgeOf(bar, 'right'), bar);
    expect(t.distance).toBeCloseTo(bar.width / 2, 0);
    expect(t.sizeDelta).toBeGreaterThan(1);
  });
});

describe('fromRect', () => {
  test('carries a DOMRect straight through', () => {
    expect(fromRect({ left: 10, top: 20, width: 30, height: 40 }, 6))
      .toEqual({ x: 10, y: 20, width: 30, height: 40, radius: 6 });
  });
});
