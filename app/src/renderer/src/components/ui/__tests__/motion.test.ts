import { describe, expect, test } from '@jest/globals';
import {
  SPRINGS, easingFunction, resolveSpring, simulateSpring, sizeFactor, springFor,
  springFromCharacter, type SpringPreset,
} from '../motion';

/**
 * The springs.
 *
 * Motion is the one part of a UI where "it looked fine" is not evidence: an over-damped config and
 * a springy one both produce a smooth animation, and the difference between them is a claim about
 * physics that nobody can read off a screen recording. So the physics is asserted directly.
 *
 * The specific thing these guard is the mistake that was in this file first: grading springs by
 * SIZE through raw damping. Raising mass while holding `c` lowers ζ, so a config meant to make big
 * surfaces calmer made them bounce roughly three times as hard as the button that opened them —
 * smoothly, plausibly, and completely backwards.
 */

const PRESETS: SpringPreset[] = ['snappy', 'bouncy', 'glass', 'calm'];

/** The peak of a preset at a given surface size, as a percentage over target. */
function overshootPercent(preset: SpringPreset, diagonal: number): number {
  return (springFor(preset, diagonal).peak - 1) * 100;
}

describe('spring solver', () => {
  test('every preset reaches its target and stops there', () => {
    for (const preset of PRESETS) {
      const sim = simulateSpring(springFromCharacter(SPRINGS[preset]));
      expect(sim.values[0]).toBe(0);
      expect(sim.values[sim.values.length - 1]).toBe(1);
      // A curve that has not settled inside a second is a misconfiguration, not a slow animation.
      expect(sim.duration).toBeLessThan(1);
      expect(sim.duration).toBeGreaterThan(0.1);
    }
  });

  test('ζ below 1 overshoots and ζ at 1 does not', () => {
    expect(simulateSpring(springFromCharacter({ stiffness: 380, ratio: 0.55 })).peak).toBeGreaterThan(1.05);
    // Critically damped: the definition is that it reaches the target without crossing it.
    expect(simulateSpring(springFromCharacter({ stiffness: 380, ratio: 1 })).peak).toBeCloseTo(1, 3);
  });

  test('the presets are ordered by bounce, and `calm` has none', () => {
    const control = 40;
    expect(overshootPercent('bouncy', control)).toBeGreaterThan(overshootPercent('glass', control));
    expect(overshootPercent('glass', control)).toBeGreaterThan(overshootPercent('snappy', control));
    expect(overshootPercent('calm', control)).toBeCloseTo(0, 1);
  });

  // This test used to demand MORE than 8% — it pinned the 12.6% the owner's UI fix list (item 16)
  // asked to cut. The contract is now the list's: a visible rebound, within ≤8% and ~200–240ms,
  // because everything `bouncy` runs on is clicked a hundred times a day.
  test('`bouncy` rebounds visibly on a control, and no more than a frequent control can bear', () => {
    expect(overshootPercent('bouncy', 40)).toBeGreaterThan(overshootPercent('glass', 40));
    expect(overshootPercent('bouncy', 40)).toBeLessThanOrEqual(8);
    expect(springFor('bouncy', 40).duration).toBeLessThanOrEqual(240);
  });
});

describe('size grading', () => {
  /** A round button, a dialog, and a full-window bar. */
  const CONTROL = 40;
  const DIALOG = 900;
  const WINDOW = 1600;

  test('bigger surfaces bounce LESS, not more', () => {
    // The regression. Under the first (mass-based) model this assertion failed in both directions:
    // the window overshot ~29% against the control's ~9%.
    for (const preset of ['bouncy', 'glass', 'snappy'] as SpringPreset[]) {
      expect(overshootPercent(preset, DIALOG)).toBeLessThan(overshootPercent(preset, CONTROL));
      expect(overshootPercent(preset, WINDOW)).toBeLessThan(overshootPercent(preset, DIALOG));
    }
  });

  test('bigger surfaces are slower, because weightless is the other failure', () => {
    expect(springFor('glass', WINDOW).duration).toBeGreaterThan(springFor('glass', CONTROL).duration);
  });

  test('a full window still bounces — damped is not the same as dead', () => {
    // If the grading were free to run to critical, "same material at every size" would be a lie:
    // the sidebar would arrive on a curve the dropdown never uses.
    expect(overshootPercent('bouncy', WINDOW)).toBeGreaterThan(2);
  });

  test('no surface takes long enough to feel like waiting', () => {
    for (const preset of PRESETS) {
      for (const diagonal of [CONTROL, 300, DIALOG, WINDOW, 4000]) {
        expect(springFor(preset, diagonal).duration).toBeLessThanOrEqual(750);
      }
    }
  });

  test('the grading is clamped at both ends', () => {
    // Below a control, nothing special happens — a 12px badge is not its own case…
    expect(sizeFactor(10)).toBe(0);
    expect(sizeFactor(120)).toBe(0);
    // …and above a window it stops, so a 5K display does not get a two-second flight.
    expect(sizeFactor(1000)).toBe(1);
    expect(sizeFactor(6000)).toBe(1);
    expect(springFor('glass', 1000).duration).toBe(springFor('glass', 6000).duration);
  });

  test('a degenerate measurement cannot produce a degenerate spring', () => {
    // A panel measured before layout reports 0; a broken one can report a negative or a NaN-adjacent
    // value. None of those may become a duration the wall-clock guards then have to absorb.
    for (const diagonal of [0, -50, 0.001]) {
      const spring = springFor('glass', diagonal);
      expect(spring.duration).toBeGreaterThan(0);
      expect(spring.duration).toBeLessThanOrEqual(750);
    }
  });
});

describe('compiled easings', () => {
  test('a spring compiles to a CSS timing function that starts at 0 and ends at 1', () => {
    const { easing } = resolveSpring(springFromCharacter(SPRINGS.bouncy));
    const at = easingFunction(easing);
    expect(at(0)).toBeCloseTo(0, 4);
    expect(at(1)).toBeCloseTo(1, 4);
  });

  /** The densest useful sweep of a timing function. See the note about vertices below. */
  function sweep(spec: string): number {
    const at = easingFunction(spec);
    let max = 0;
    for (let i = 0; i <= 10_000; i++) max = Math.max(max, at(i / 10_000));
    return max;
  }

  test('the compiled linear() reproduces the overshoot the solver reported', () => {
    // Built here rather than taken from `resolveSpring`, which is environment-dependent: there is no
    // `CSS.supports` under the node test runner, so it emits the bezier FALLBACK and this would
    // quietly be measuring the approximation instead of the curve Chromium plays.
    const sim = simulateSpring(springFromCharacter(SPRINGS.bouncy));
    // Densely, on purpose. `linear()` is a polyline of ~57 stops whose peak is a single vertex; a
    // coarse sweep steps over that vertex and reads the chord, understating the bounce by about a
    // sixth — which is indistinguishable from a real amplitude bug.
    expect(sweep(`linear(${sim.values.join(', ')})`)).toBeCloseTo(sim.peak, 3);
  });

  test('a sample lands ON the peak, so the polyline does not cut the corner off it', () => {
    // Without the snap in simulateSpring, `bouncy` integrated to 11.8% and emitted 11.0%.
    const sim = simulateSpring(springFromCharacter(SPRINGS.bouncy));
    expect(Math.max(...sim.values)).toBeCloseTo(sim.peak, 6);
  });

  test('the fallback bezier keeps the one distinction that matters: does it bounce', () => {
    // Where `linear()` is unsupported the curve can only be approximate — but a springy config must
    // not silently flatten into the non-springy fallback, because that is a change of character
    // rather than of fidelity.
    const springy = resolveSpring(springFromCharacter(SPRINGS.bouncy));
    const flat = resolveSpring(springFromCharacter(SPRINGS.calm));
    if (springy.easing.startsWith('cubic-bezier')) {
      expect(sweep(springy.easing)).toBeGreaterThan(1);
      expect(sweep(flat.easing)).toBeCloseTo(1, 3);
    }
  });

  test('easings are monotonic in time even when the value is not', () => {
    const at = easingFunction(resolveSpring(springFromCharacter(SPRINGS.bouncy)).easing);
    // Sampling past the ends must clamp rather than extrapolate — a WAAPI `fill: both` holds there.
    expect(at(-1)).toBeCloseTo(at(0), 6);
    expect(at(2)).toBeCloseTo(at(1), 6);
  });

  test('cubic-bezier and the keyword curves are understood too', () => {
    // The fallback path, used where `linear()` is unsupported. If this silently returned identity,
    // every counter-scale computed against a fallback easing would be subtly wrong.
    const ease = easingFunction('cubic-bezier(0.34, 1.56, 0.64, 1)');
    expect(ease(0)).toBeCloseTo(0, 4);
    expect(ease(1)).toBeCloseTo(1, 4);
    let peak = 0;
    for (let i = 0; i <= 100; i++) peak = Math.max(peak, ease(i / 100));
    expect(peak).toBeGreaterThan(1);

    const out = easingFunction('ease-out');
    expect(out(0.5)).toBeGreaterThan(0.5);
  });

  test('an unrecognised easing degrades to linear rather than to zero', () => {
    const at = easingFunction('steps(4, end)');
    expect(at(0)).toBe(0);
    expect(at(0.5)).toBeCloseTo(0.5, 6);
    expect(at(1)).toBe(1);
  });
});
