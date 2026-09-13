/**
 * The motion system: springs, compiled to CSS `linear()`.
 *
 * ## Why springs and not more cubic-beziers
 *
 * A cubic-bezier is a shape. A spring is a *physical claim* — this surface has mass, it is being
 * pulled to a target, and it settles. The difference is only visible in one place, but it is the
 * place that matters here: the moment of arrival. An ease-out decelerates asymptotically into its
 * target and stops dead; a spring arrives with a little momentum left and settles it out. That
 * settle is the entire perceptual difference between "a box resized" and "a thing moved".
 *
 * Everything is compiled ahead of time into a CSS `linear()` easing, so the browser composites the
 * whole flight on the GPU — no per-frame JS, no jank when the engine is busy streaming tokens into
 * the transcript. The spring is a *design-time* solver, not a runtime one.
 *
 * ## Why the presets are graded by size
 *
 * A round button and a full window cannot bounce the same amount. Overshoot is perceived relative
 * to the surface: 5% on a 40px pill is 2px and reads as a crisp snap, while 5% on a 900px window is
 * 45px of visible rubber and reads as a toy. So `springFor()` takes the surface's diagonal and
 * grades the spring against it — one bounce character, progressively damped and slowed as the
 * surface grows, so a dropdown, the sidebar and a full sheet feel like the same material at
 * different sizes.
 *
 * ## Why presets are stiffness + damping RATIO, not stiffness + damping
 *
 * Raw damping is not a portable description of bounce: what a spring actually does is set by the
 * dimensionless ratio ζ = c / (2·√(k·m)), so the same `damping: 22` is springy under one stiffness
 * and dead under another. Grading by size through raw damping is worse than useless — raising mass
 * while holding `c` LOWERS ζ, which is how a "heavier, calmer window" config ends up bouncing
 * roughly three times as hard as the button that opened it. Presets therefore name ζ directly
 * (0.55 = visibly springy, 1.0 = no overshoot at all) and the solver derives `c` from it.
 */

export interface SpringConfig {
  /** Pull toward the target. Higher = faster, tighter. */
  stiffness: number;
  /** Resistance. Below the critical value (2·√(stiffness·mass)) the spring overshoots. */
  damping: number;
  mass: number;
}

/** A preset's shape: how hard it pulls, and how much it rings. */
export interface SpringCharacter {
  stiffness: number;
  /** ζ. <1 overshoots, 1 is critically damped, >1 crawls in. */
  ratio: number;
}

export type SpringPreset =
  /** Controls: press, toggle, row selection. Fast, barely overshoots. */
  | 'snappy'
  /** The house bounce: menus, pills, seeded panels. Visibly springy. */
  | 'bouncy'
  /** Large surfaces settling. A soft rebound that reads as weight rather than as bounce. */
  | 'glass'
  /** No overshoot at all — for anything that must not draw attention (peeks, hovers). */
  | 'calm';

export const SPRINGS: Record<SpringPreset, SpringCharacter> = {
  // Calibrated against the reference bounce (k 320 / c 17, i.e. ζ≈0.47) rather than copied: that
  // config peaks near 26%, which is right for a 32px droplet flying out of a plus-menu and far too
  // much for a window. `bouncy` keeps the character at ~12% on a control, and the size grading
  // below takes it to ~5% on a full window.
  //
  // 2026-09-12: every stiffness DOUBLED. Settling time goes as 1/√k while overshoot depends only on
  // ζ, so this is a uniform ~30% cut in duration that leaves the physics — the peak of each preset,
  // and the ladder between them — exactly where it was. It is the only knob that shortens motion
  // without changing its character; tightening the settle band (the previous pass) had already
  // plateaued, because what remained was real movement rather than an invisible tail.
  //
  //   snappy 283→209ms   bouncy 467→338ms   glass 379→271ms   calm 417→278ms
  //
  // (Measured with the corrected DT above. Overshoot is now invariant under stiffness — 1.94% at
  // k=1240 and 1.88% at k=4960 — which is what makes this knob safe to reach for at all; under the
  // old step the same sweep bled a third of the bounce away.)
  //
  // The target is the platform's, not ours: light interactions are conventionally ≤200ms, and the
  // two reference apps we measured animate at 0ms and 367ms respectively. `snappy` carries by far
  // the most events, so it is the one that had to clear 200.
  snappy: { stiffness: 1240, ratio: 0.78 },
  bouncy: { stiffness: 760, ratio: 0.55 },
  glass: { stiffness: 680, ratio: 0.70 },
  calm: { stiffness: 760, ratio: 1.0 },
};

/** Turn a character into an integrable spring. ζ = c / (2·√(k·m)) — this is that, solved for c. */
export function springFromCharacter(character: SpringCharacter, mass = 1): SpringConfig {
  return {
    stiffness: character.stiffness,
    damping: 2 * character.ratio * Math.sqrt(character.stiffness * mass),
    mass,
  };
}

export interface ResolvedSpring {
  /** ms, from launch to settled — the point past which nothing perceptible is still moving. */
  duration: number;
  /** A CSS timing function, ready for `transition-timing-function` or WAAPI's `easing`. */
  easing: string;
  /**
   * Peak displacement. >1 means it overshot; exactly 1 means it never did.
   *
   * This is the SPRING's peak — the physics — and the compiled `linear()` carries it exactly (a
   * sample is placed on it). Where `linear()` is unsupported and a bezier stands in, the emitted
   * curve only approximates this; the fallback preserves whether it bounces, not by how much.
   */
  peak: number;
}

/**
 * The integration step, 4800Hz.
 *
 * It was 1/240 ("fine enough that a stiff spring's first quarter-cycle is not aliased into a
 * corner"), and that was measurably wrong — not in the sampling, which a later fix already
 * addressed by putting a stop on the peak, but one level below it in the INTEGRATION. Semi-implicit
 * Euler is only first-order accurate, and its error shows up as numerical damping: energy the
 * scheme quietly removes from the spring. Measured against the closed form
 * `Mp = exp(-πζ/√(1-ζ²))`, which depends on ζ alone:
 *
 *              analytic   at 1/240   at 1/4800
 *   snappy       1.99%      1.22%       1.94%
 *   bouncy      12.63%     11.79%      12.57%
 *   glass        4.60%      3.85%       4.55%
 *
 * So 39% of `snappy`'s overshoot was being eaten by the integrator before any of it reached CSS.
 * Worse, the error scales with stiffness — at k=1240 it took 53% — which silently punishes exactly
 * the knob you reach for to make a preset faster, and made "raising stiffness preserves character"
 * true only by accident.
 *
 * 1/4800 puts every preset within 3% of the closed form. It costs iterations and nothing else: the
 * emitted `linear()` is resampled to `stops` (24-120) regardless of DT, so the stylesheet does not
 * grow, and every result here is cached.
 */
const DT = 1 / 4800;
/**
 * Settled = close to target, and slow. Held for 64ms to reject a fly-through.
 *
 * These are the FLOOR, used when the caller cannot say how big the surface is. They are a
 * displacement of 0.1% and a velocity of 0.02/s, which on a full window is about a pixel and a
 * third of a pixel per frame — right for a window, and far below perception on a control. A 120pt
 * control settling to 0.1% is settling to a *ninth* of a pixel, and every frame spent getting there
 * is composited for nobody: measured, the appearance menu was still drawing 180ms after the last
 * perceptible movement. `settleFor()` scales the pair by surface size so a small surface stops when
 * it has stopped moving *visibly*, and clamps to these floors so nothing is ever LESS precise than
 * it is today.
 */
const SETTLE_EPSILON = 0.001;
const SETTLE_VELOCITY = 0.02;
const SETTLE_HOLD = 0.064;
/** The threshold everything here is derived from: half a device-independent pixel. */
const HALF_PIXEL = 0.5;
/** …and half a pixel per frame at 60fps, expressed as normalised units per second. */
const HALF_PIXEL_PER_FRAME = HALF_PIXEL * 60;

/**
 * Settle thresholds for a surface of this diagonal, in normalised units.
 *
 * Never tighter than the floors above, so this can only remove invisible frames, never add them.
 */
export function settleFor(diagonal?: number): { epsilon: number; velocity: number } {
  if (!diagonal || !Number.isFinite(diagonal) || diagonal <= 0) {
    return { epsilon: SETTLE_EPSILON, velocity: SETTLE_VELOCITY };
  }
  // Clamped exactly like `sizeFactor`, and for two reasons that both bite.
  //
  // Above a window there is nothing more to gain, and letting the threshold keep shrinking makes
  // two surfaces that are graded identically settle at different times — the scale-invariance the
  // grading exists to provide.
  //
  // Below a control it is worse than useless: half a pixel of a 40pt button is 1.25% of its travel,
  // which is WIDER than snappy's 1.2% overshoot, so the settle band swallows the bounce and the
  // emitted curve loses the character this whole module exists to preserve.
  const size = Math.min(WINDOW_DIAGONAL, Math.max(CONTROL_DIAGONAL, diagonal));
  return {
    epsilon: Math.max(SETTLE_EPSILON, HALF_PIXEL / size),
    velocity: Math.max(SETTLE_VELOCITY, HALF_PIXEL_PER_FRAME / size),
  };
}

/**
 * Integrate the spring and return its normalized displacement curve.
 *
 * Exported because this is the half that can be quietly wrong: an over-damped config still produces
 * a perfectly smooth animation, so "did this actually overshoot?" is not answerable by looking at
 * it. The tests assert the physics directly.
 */
export function simulateSpring(
  config: SpringConfig,
  diagonal?: number,
): { duration: number; values: number[]; peak: number } {
  const { epsilon, velocity } = settleFor(diagonal);
  let x = 0;
  let v = 0;
  let t = 0;
  let settledAt = -1;
  let peak = 0;
  let peakIndex = 0;
  const xs: number[] = [0];

  // 10s is a backstop, not an expectation. A config that has not settled by then is a
  // misconfiguration, and the curve gets truncated rather than running forever.
  while (t < 10) {
    const a = (-config.stiffness * (x - 1) - config.damping * v) / config.mass;
    v += a * DT;
    x += v * DT;
    t += DT;
    xs.push(x);
    if (x > peak) { peak = x; peakIndex = xs.length - 1; }
    if (Math.abs(x - 1) < epsilon && Math.abs(v) < velocity) {
      if (settledAt < 0) settledAt = t;
      if (t - settledAt >= SETTLE_HOLD) break;
    } else {
      settledAt = -1;
    }
  }

  const duration = settledAt > 0 ? settledAt : t;
  // ~90 stops per second of animation, clamped. Below ~24 the linear() polyline visibly facets on a
  // long travel; above ~120 the stylesheet grows for a curve nobody can distinguish.
  const stops = Math.round(Math.min(120, Math.max(24, duration * 90)));
  const lastIndex = Math.min(xs.length - 1, Math.round(duration / DT));
  const values: number[] = [];
  for (let i = 0; i <= stops; i++) {
    const index = Math.min(xs.length - 1, Math.round((i / stops) * lastIndex));
    values.push(Math.round(xs[index] * 1e4) / 1e4);
  }

  // Put a sample ON the peak.
  //
  // `linear()` is a polyline, and a polyline sampled at fixed intervals cuts the corner off any
  // extremum that falls between two stops. Measured: `bouncy` peaks at 11.8% in the integration and
  // the emitted curve peaked at 11.0% — a sixth of the bounce lost, silently, to sampling. Moving
  // the nearest stop onto the true peak costs nothing (no extra stops) and shifts that stop's
  // timing by at most half an interval, ~5ms, against an amplitude error that is visible.
  if (lastIndex > 0 && peakIndex > 0) {
    const nearest = Math.round((peakIndex / lastIndex) * stops);
    if (nearest > 0 && nearest < stops) values[nearest] = Math.round(peak * 1e4) / 1e4;
  }

  // The sampled tail may sit a hair off target; CSS must land exactly on 1 or the panel finishes
  // fractionally scaled and text renders off the pixel grid.
  values[values.length - 1] = 1;

  // Reported from the EMITTED curve, not from the integration. The curve is what the compositor
  // plays and what `easingFunction()` re-reads for the counter-scale, so it is the only peak any
  // caller can act on; reporting the integration's would be describing an animation nobody sees.
  return { duration, values, peak: Math.max(...values, 1) };
}

let linearSupport: boolean | null = null;
function supportsLinearEasing(): boolean {
  if (linearSupport === null) {
    linearSupport = typeof CSS !== 'undefined'
      && typeof CSS.supports === 'function'
      && CSS.supports('transition-timing-function', 'linear(0, 1)');
  }
  return linearSupport;
}

const springCache = new Map<string, ResolvedSpring>();

/** Compile a spring to a CSS easing. Cached — the solver is cheap but not free, and this is hot. */
export function resolveSpring(config: SpringConfig, diagonal?: number): ResolvedSpring {
  const key = `${config.stiffness}/${config.damping}/${config.mass}/${diagonal ?? 0}/${supportsLinearEasing()}`;
  const hit = springCache.get(key);
  if (hit) return hit;

  const sim = simulateSpring(config, diagonal);
  const resolved: ResolvedSpring = {
    duration: Math.round(sim.duration * 1000),
    easing: supportsLinearEasing()
      ? `linear(${sim.values.join(', ')})`
      // No `linear()` (Electron is new enough, but the design harness and jsdom may not be): fall
      // back to a bezier that at least keeps the overshoot/no-overshoot distinction.
      : sim.peak > 1.001
        ? 'cubic-bezier(0.34, 1.56, 0.64, 1)'
        : 'cubic-bezier(0.22, 1, 0.36, 1)',
    peak: sim.peak,
  };
  springCache.set(key, resolved);
  return resolved;
}

/** A control-sized surface (a toolbar button). At or below this, presets are used unmodified. */
const CONTROL_DIAGONAL = 120;
/** A full-window surface. At or above this, the grading is at its strongest. */
const WINDOW_DIAGONAL = 1000;
/** How far toward critical damping a full-window surface is pushed. */
const SIZE_DAMPING = 0.30;
/** How much a full-window surface is softened. 0.45 = its stiffness is 55% of a control's. */
const SIZE_SOFTENING = 0.45;

/**
 * How large a surface is, on the 0..1 scale the grading runs on.
 *
 * Exported so the grading can be asserted at its endpoints without reading them out of a spring.
 */
export function sizeFactor(diagonal: number): number {
  const t = (diagonal - CONTROL_DIAGONAL) / (WINDOW_DIAGONAL - CONTROL_DIAGONAL);
  return Math.min(1, Math.max(0, t));
}

/**
 * The spring for a surface of a given size.
 *
 * `diagonal` is the final surface's diagonal in px. Two things move with it, and they are separate
 * knobs because they answer different complaints:
 *
 *   - **ζ rises toward critical**, which takes the bounce out. This is the perceptual correction:
 *     a fixed percentage of overshoot is a fixed number of PIXELS only for a fixed-size surface.
 *   - **stiffness falls**, which makes it slower. This is the weight: a big surface that snaps as
 *     fast as a button reads as weightless, however little it bounces.
 *
 * Both are clamped at a window's size, so a 4K display does not get a spring that takes 2s to
 * settle, and both are flat below a control's size, so a 12px badge is not treated as a special case.
 */
export function springFor(preset: SpringPreset, diagonal: number): ResolvedSpring {
  const base = SPRINGS[preset];
  const t = sizeFactor(diagonal);
  return resolveSpring(springFromCharacter({
    stiffness: base.stiffness * (1 - SIZE_SOFTENING * t),
    ratio: base.ratio + (1 - base.ratio) * (t * SIZE_DAMPING),
  }), diagonal);
}

/**
 * Evaluate a CSS timing function in JS.
 *
 * Needed because the seeded expansion's content layer must counter-scale by the EXACT inverse of
 * the panel at every instant, and CSS cannot express "1/x of that other animation". Sampling the
 * same easing here and emitting explicit keyframes is what makes the glyphs hold at 1:1 through a
 * flight that scales the box by 15x — see `inverseScaleKeyframes`.
 */
const easingCache = new Map<string, (t: number) => number>();
export function easingFunction(spec: string): (t: number) => number {
  const cached = easingCache.get(spec);
  if (cached) return cached;

  let fn: (t: number) => number;
  const linear = /^linear\(([^)]+)\)$/.exec(spec.trim());
  const bezier = /^cubic-bezier\(([^)]+)\)$/.exec(spec.trim());

  if (linear) {
    // Our compiled lists carry no percentage stops, so they are evenly spaced by construction.
    const values = linear[1].split(',').map(Number);
    fn = (t) => {
      if (t <= 0) return values[0];
      if (t >= 1) return values[values.length - 1];
      const f = t * (values.length - 1);
      const i = Math.floor(f);
      return values[i] + (values[i + 1] - values[i]) * (f - i);
    };
  } else if (bezier) {
    const [x1, y1, x2, y2] = bezier[1].split(',').map(Number);
    fn = (t) => {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      // Bisect for the parameter u where the curve's x equals t. 24 halvings is ~6e-8 — far below
      // a pixel on any surface this drives.
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        const xm = 3 * mid * (1 - mid) ** 2 * x1 + 3 * mid ** 2 * (1 - mid) * x2 + mid ** 3;
        if (xm < t) lo = mid; else hi = mid;
      }
      const u = (lo + hi) / 2;
      return 3 * u * (1 - u) ** 2 * y1 + 3 * u ** 2 * (1 - u) * y2 + u ** 3;
    };
  } else if (spec === 'ease') {
    fn = easingFunction('cubic-bezier(0.25, 0.1, 0.25, 1)');
  } else if (spec === 'ease-in') {
    fn = easingFunction('cubic-bezier(0.42, 0, 1, 1)');
  } else if (spec === 'ease-out') {
    fn = easingFunction('cubic-bezier(0, 0, 0.58, 1)');
  } else if (spec === 'ease-in-out') {
    fn = easingFunction('cubic-bezier(0.42, 0, 0.58, 1)');
  } else {
    fn = (t) => Math.min(1, Math.max(0, t));
  }

  easingCache.set(spec, fn);
  return fn;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
