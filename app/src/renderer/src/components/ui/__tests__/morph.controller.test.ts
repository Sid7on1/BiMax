import { MorphController, liveMorphCount, type MorphFrame } from '../morph/controller';
import type { MorphGeometry } from '../morph/geometry';

/**
 * The interruption matrix, run as arithmetic.
 *
 * Prompt 2 §112 asks for open→close at 10/30/70%, close→reopen, A→B, and resize mid-flight to be
 * automated "where possible". They are entirely possible: the driver has no timeline, so a test can
 * step it frame by frame and interrupt on any frame it likes. What the Motion Lab adds on top is
 * whether the result *looks* right; what this file settles is whether the geometry is continuous,
 * which is not something the eye can certify at 60fps.
 *
 * `advance()` is stepped by hand throughout — there is no rAF in the node lane, so the shared clock
 * never starts and every flight here is deterministic.
 */

const SEED: MorphGeometry = { x: 40, y: 700, width: 44, height: 28, radius: 14 };
const VIEWPORT = { width: 1440, height: 900 };

function makeController(overrides: {
  seed?: MorphGeometry | null;
  kind?: 'popover' | 'inspector' | 'palette';
  reduced?: boolean;
  onClosed?: () => void;
  onSettled?: () => void;
} = {}): { controller: MorphController; frames: MorphFrame[]; setSeed: (s: MorphGeometry | null) => void; setViewport: (v: { width: number; height: number }) => void } {
  let seed = overrides.seed === undefined ? SEED : overrides.seed;
  let viewport = { ...VIEWPORT };
  const frames: MorphFrame[] = [];

  const controller = new MorphController({
    kind: () => overrides.kind ?? 'popover',
    reducedMotion: () => overrides.reduced ?? false,
    onClosed: overrides.onClosed,
    onSettled: overrides.onSettled,
    resolve: () => ({
      seed,
      destination: {
        x: viewport.width / 2 - 130,
        y: viewport.height / 2 - 150,
        width: 260,
        height: 300,
        radius: 14,
      },
    }),
  });
  controller.subscribe((frame) => frames.push({ ...frame, geometry: { ...frame.geometry } }));

  return {
    controller,
    frames,
    setSeed: (s) => { seed = s; },
    setViewport: (v) => { viewport = v; },
  };
}

/** Step a controller n frames at 60Hz. */
function run(controller: MorphController, n: number): void {
  for (let i = 0; i < n; i++) controller.advance(1 / 60);
}

/** Step until settled, with a bound so a stuck controller fails as a timeout rather than a hang. */
function runToRest(controller: MorphController, max = 400): number {
  let i = 0;
  while (i < max && (controller.state === 'opening' || controller.state === 'closing')) {
    controller.advance(1 / 60);
    i += 1;
  }
  return i;
}

afterEach(() => {
  // Prompt 1 §33: "ensure no ghost morph surfaces remain". A controller left in the shared clock
  // is exactly that — it keeps stepping and keeps writing to a detached element.
  expect(liveMorphCount()).toBe(0);
});

describe('opening', () => {
  test('the first frame is the seed, exactly', () => {
    // The whole system's claim in one assertion. If this is off by even a couple of pixels the
    // surface visibly "jumps" out of the control on frame one, which reads as a different object.
    const { controller, frames } = makeController();
    controller.open();
    expect(frames[0].geometry).toEqual(SEED);
    controller.dispose();
  });

  test('position and size change together, not in sequence', () => {
    // Prompt 1 §4: move-then-resize looks mechanical. Both must be in motion on the same frames.
    const { controller, frames } = makeController();
    controller.open();
    run(controller, 5);
    const mid = frames[frames.length - 1];
    expect(mid.geometry.x).not.toBeCloseTo(SEED.x, 1);
    expect(mid.geometry.width).not.toBeCloseTo(SEED.width, 1);
    expect(mid.geometry.y).not.toBeCloseTo(SEED.y, 1);
    controller.dispose();
  });

  test('the corner interpolates the whole way, never popping', () => {
    // Prompt 1 §7. v1 hard-coded 999px -> 22px on a scaled box; here the radius is a real number in
    // px and must move monotonically from the seed's to the destination's with no step.
    const { controller, frames } = makeController();
    controller.open();
    runToRest(controller);
    const radii = frames.map((f) => f.geometry.radius);
    expect(radii[0]).toBe(SEED.radius);
    expect(radii[radii.length - 1]).toBeCloseTo(14, 1);
    for (let i = 1; i < radii.length; i++) {
      expect(Math.abs(radii[i] - radii[i - 1])).toBeLessThan(2);
    }
    controller.dispose();
  });

  test('content stays hidden while the box is at its most distorted', () => {
    // Prompt 1 §12: 0-30% is shell only. Text revealed while the container is a sliver is the
    // single most common way this effect looks cheap.
    const { controller, frames } = makeController();
    controller.open();
    runToRest(controller);
    for (const frame of frames) {
      if (frame.progress < 0.4) expect(frame.reveal).toBe(0);
    }
    expect(frames[frames.length - 1].reveal).toBeCloseTo(1, 2);
    controller.dispose();
  });

  test('settles open and leaves the clock', () => {
    const onSettled = jest.fn();
    const { controller } = makeController({ onSettled });
    controller.open();
    const frames = runToRest(controller);
    expect(controller.state).toBe('open');
    expect(onSettled).toHaveBeenCalledTimes(1);
    // Prompt 2 §8/§118: a frequent interaction must not feel like something to wait for.
    expect(frames).toBeLessThan(45);
    controller.dispose();
  });

  test('deformation is felt, not seen', () => {
    // Prompt 2 §51. The reference implementation this comes from caps at 18%; anything close to
    // that on a Mac control is the "jelly" the brief rules out twice.
    const { controller, frames } = makeController();
    controller.open();
    runToRest(controller);
    const peak = Math.max(...frames.map((f) => Math.max(Math.abs(f.deform.x - 1), Math.abs(f.deform.y - 1))));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(0.045);
    controller.dispose();
  });
});

describe('interruption', () => {
  for (const at of [0.1, 0.3, 0.7]) {
    test(`close at ${Math.round(at * 100)}% keeps travelling before it turns round`, () => {
      const { controller, frames } = makeController();
      controller.open();
      // Advance to roughly the requested progress.
      while (frames[frames.length - 1].progress < at) controller.advance(1 / 60);
      const atInterrupt = frames[frames.length - 1].geometry;

      controller.close();
      controller.advance(1 / 60);
      const next = frames[frames.length - 1].geometry;

      // Momentum survives: the surface is still growing on the frame after the user asked for it to
      // close. This is the difference between "it continued from its current state" and "it stopped
      // dead and reversed", which is what a cancel-and-restart animation does.
      expect(next.width).toBeGreaterThan(atInterrupt.width);

      runToRest(controller);
      expect(controller.state).toBe('closed');
      // …and it lands on the seed, not somewhere near it.
      const last = frames[frames.length - 1].geometry;
      expect(last.x).toBeCloseTo(SEED.x, 0);
      expect(last.y).toBeCloseTo(SEED.y, 0);
      expect(last.width).toBeCloseTo(SEED.width, 0);
      controller.dispose();
    });
  }

  test('reopening mid-close curves back out without restarting', () => {
    const { controller, frames } = makeController();
    controller.open();
    runToRest(controller);
    controller.close();
    run(controller, 6);
    const shrinking = frames[frames.length - 1].geometry;
    expect(shrinking.width).toBeLessThan(260);

    controller.open();
    controller.advance(1 / 60);
    const resumed = frames[frames.length - 1].geometry;
    // Continuous: the reopen picks up from where the collapse had reached, not from the seed.
    expect(Math.abs(resumed.width - shrinking.width)).toBeLessThan(30);
    expect(resumed.width).not.toBeCloseTo(SEED.width, 0);

    runToRest(controller);
    expect(controller.state).toBe('open');
    controller.dispose();
  });

  test('never emits a discontinuous frame, however it is interrupted', () => {
    // The invariant behind every case above, asserted directly: no frame may teleport. A jump is
    // exactly what a cancel-and-restart produces and exactly what the eye reads as "two different
    // things", so it is worth pinning independently of any particular interruption.
    const { controller, frames } = makeController();
    controller.open();
    run(controller, 4);
    controller.close();
    run(controller, 3);
    controller.open();
    run(controller, 2);
    controller.close();
    runToRest(controller);

    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1].geometry;
      const b = frames[i].geometry;
      // One frame at 60Hz over a 900px window: nothing physical moves more than this.
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(120);
      expect(Math.abs(b.width - a.width)).toBeLessThan(120);
      expect(Math.abs(b.height - a.height)).toBeLessThan(120);
    }
    controller.dispose();
  });
});

describe('the world moving underneath', () => {
  test('a resize mid-flight retargets instead of jumping', () => {
    // Prompt 2 §79. The failure this rules out is the surface finishing at the old size and then
    // snapping to the new one on the frame after it settles.
    const { controller, frames, setViewport } = makeController();
    controller.open();
    run(controller, 5);
    const before = frames[frames.length - 1].geometry;

    setViewport({ width: 900, height: 600 });
    controller.remeasure();
    controller.advance(1 / 60);
    const after = frames[frames.length - 1].geometry;
    expect(Math.abs(after.x - before.x)).toBeLessThan(60);

    runToRest(controller);
    // Destination is derived from the NEW viewport: centred in 900x600.
    expect(frames[frames.length - 1].geometry.x).toBeCloseTo(320, 0);
    controller.dispose();
  });

  test('closing uses where the control is now, not where it was', () => {
    // Prompt 1 §22 / Prompt 2 §25: the sidebar got wider while the panel was open. A morph that
    // folds into a remembered rect flies, very smoothly, to a place the button is not.
    const { controller, frames, setSeed } = makeController();
    controller.open();
    runToRest(controller);

    const moved: MorphGeometry = { x: 300, y: 120, width: 44, height: 28, radius: 14 };
    setSeed(moved);
    controller.close();
    runToRest(controller);

    const landed = frames[frames.length - 1].geometry;
    expect(landed.x).toBeCloseTo(moved.x, 0);
    expect(landed.y).toBeCloseTo(moved.y, 0);
    controller.dispose();
  });

  test('a control that vanished leaves the surface in place, not flying anywhere', () => {
    // Its pane was collapsed while the panel was open. Two wrong answers here: folding to (0,0)
    // flings the surface into the corner of the window, and folding into a small box at its own
    // centre — which this used to do — reads as the window swallowing it. With no origin there is
    // no honest destination for the collapse, so it leaves from where it is and fades, which is
    // what `seeded: false` tells the painter to do.
    const { controller, frames, setSeed } = makeController();
    controller.open();
    runToRest(controller);
    const open = frames[frames.length - 1].geometry;

    setSeed(null);
    controller.close();
    runToRest(controller);

    const landed = frames[frames.length - 1].geometry;
    // Barely moved and barely shrank: this is a fade, not a journey.
    expect(Math.hypot(landed.x - open.x, landed.y - open.y)).toBeLessThan(20);
    expect(landed.width).toBeGreaterThan(open.width * 0.85);
    expect(frames[frames.length - 1].seeded).toBe(false);
    controller.dispose();
  });

  test('an unseeded flight is reported as unseeded, so the painter can fade it out', () => {
    // The distinction is not derivable from the geometry — a seeded collapse ends sitting exactly
    // on its trigger, at that control's size, and unmounting there is invisible; an unseeded one
    // ends over empty background. Only the driver knows which happened.
    const seeded = makeController();
    seeded.controller.open();
    runToRest(seeded.controller);
    seeded.controller.close();
    runToRest(seeded.controller);
    expect(seeded.frames[seeded.frames.length - 1].seeded).toBe(true);
    seeded.controller.dispose();

    const bare = makeController({ seed: null, kind: 'palette' });
    bare.controller.open();
    expect(bare.frames[0].seeded).toBe(false);
    bare.controller.dispose();
  });

  test('Reduce Motion does not fly home either', () => {
    // Prompt 2 §32 asks for the travel to be removed, and it used to be removed in one direction
    // only: the launch box was pinned near the destination while `close()` targeted the seed
    // outright, so a panel that appeared in place then crossed the whole window on the way out.
    const { controller, frames } = makeController({ reduced: true });
    controller.open();
    runToRest(controller);
    const open = frames[frames.length - 1].geometry;

    controller.close();
    runToRest(controller);
    const landed = frames[frames.length - 1].geometry;

    // SEED sits at (40, 700); the destination is centred. Anything that travelled home would be
    // hundreds of pixels away from where it was sitting.
    expect(Math.hypot(landed.x - open.x, landed.y - open.y)).toBeLessThan(20);
    controller.dispose();
  });
});

describe('honesty about origins', () => {
  test('with no seed the surface materialises in place', () => {
    // Prompt 2 §45: a palette opened from the keyboard has no spatial origin, and inventing one
    // would be a false claim about causality. It may grow slightly; it may not fly.
    const { controller, frames } = makeController({ seed: null, kind: 'palette' });
    controller.open();
    const first = frames[0].geometry;
    runToRest(controller);
    const settled = frames[frames.length - 1].geometry;
    expect(Math.hypot(first.x - settled.x, first.y - settled.y)).toBeLessThan(30);
    expect(first.width).toBeGreaterThan(settled.width * 0.8);
    controller.dispose();
  });
});

describe('reduced motion', () => {
  test('keeps the shape change and drops the journey', () => {
    // Prompt 1 §27 / Prompt 2 §32: NOT "turn the animation off". The surface must still be visibly
    // one object changing shape, and must still lean in from the seed's direction — it just must
    // not cross the window to do it.
    const { controller, frames } = makeController({ reduced: true });
    controller.open();
    const first = frames[0].geometry;
    runToRest(controller);
    const settled = frames[frames.length - 1].geometry;

    // No travel across the window…
    expect(Math.hypot(first.x - settled.x, first.y - settled.y)).toBeLessThan(40);
    // …but a real geometry transition, not an appear.
    expect(first.width).toBeLessThan(settled.width);
    expect(first.width).toBeGreaterThan(settled.width * 0.85);
    controller.dispose();
  });

  test('never overshoots and never deforms', () => {
    const { controller, frames } = makeController({ reduced: true });
    controller.open();
    runToRest(controller);
    const widest = Math.max(...frames.map((f) => f.geometry.width));
    expect(widest).toBeLessThanOrEqual(260.001);
    for (const frame of frames) {
      expect(frame.deform).toEqual({ x: 1, y: 1 });
    }
    controller.dispose();
  });

  test('is quick', () => {
    const { controller } = makeController({ reduced: true });
    controller.open();
    expect(runToRest(controller)).toBeLessThan(20);
    controller.dispose();
  });
});

describe('lifecycle', () => {
  test('closing reports back exactly once', () => {
    const onClosed = jest.fn();
    const { controller } = makeController({ onClosed });
    controller.open();
    runToRest(controller);
    controller.close();
    runToRest(controller);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(controller.state).toBe('closed');
    controller.dispose();
  });

  test('closing a controller that never opened is a no-op', () => {
    const onClosed = jest.fn();
    const { controller } = makeController({ onClosed });
    controller.close();
    expect(onClosed).not.toHaveBeenCalled();
    expect(controller.state).toBe('closed');
    controller.dispose();
  });

  test('dispose removes it from the shared clock even mid-flight', () => {
    const { controller } = makeController();
    controller.open();
    run(controller, 3);
    expect(liveMorphCount()).toBe(1);
    controller.dispose();
    expect(liveMorphCount()).toBe(0);
  });

  test('two morphs can fly at once without touching each other', () => {
    // Prompt 1 §33, "multiple seeds": open one panel and immediately activate another.
    const a = makeController();
    const b = makeController({ seed: { x: 1200, y: 60, width: 44, height: 28, radius: 14 } });
    a.controller.open();
    b.controller.open();
    run(a.controller, 4);
    run(b.controller, 4);
    expect(a.frames[a.frames.length - 1].geometry.x)
      .not.toBeCloseTo(b.frames[b.frames.length - 1].geometry.x, 0);
    a.controller.dispose();
    b.controller.dispose();
  });
});
