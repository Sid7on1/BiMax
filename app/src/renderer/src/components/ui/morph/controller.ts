/**
 * The morph driver: five springs, one clock, one element.
 *
 * This is the piece that makes a Seed Morph a *physical* object rather than a scheduled animation.
 * It holds `(value, velocity)` for x, y, width, height and radius, and every frame it steps them
 * toward whatever the current target is. Nothing here has a timeline, an elapsed time or a
 * duration — which is precisely why every interruption in the brief (close mid-open, reopen
 * mid-close, resize mid-flight, switch to another seed) is handled by *changing a target*, with no
 * cancel, no restart and no special case.
 *
 * ## One clock for everything
 *
 * All live morphs step from a single rAF. Two reasons, and the second is the important one:
 *
 *   1. One callback instead of N.
 *   2. **The clock that writes the geometry is the same clock everything else is waiting on.** If a
 *      surface's box were driven from JS while its contents rode a compositor transition, a
 *      main-thread stall would freeze the box and let the contents keep sailing — they visibly come
 *      apart. This app stalls the main thread routinely, because it renders streaming markdown. One
 *      shared clock makes the tear impossible: a stall holds *everything* still, and the analytic
 *      spring then resumes through the correct point rather than from a stale one.
 *
 * ## Read, then write
 *
 * Prompt 1 §26. The tick performs no layout reads at all: geometry is state, so a frame is pure
 * arithmetic followed by a batch of style writes. Measurement happens only at the edges — when a
 * morph opens, closes, or is told the window changed — and each of those is a single read pass
 * before any write. There is no point in the frame where a read follows a write.
 */

import {
  centreOf,
  progressOf,
  sameGeometry,
  travelBetween,
  type DestinationKind,
  type MorphGeometry,
} from './geometry';
import { isAtRest, settle, step, type SpringState } from './spring-value';
import {
  MATERIAL,
  MOTION,
  deformationFor,
  gradeSpring,
  mixMaterial,
  tokenForKind,
  type MaterialState,
  type MotionToken,
} from './tokens';

export type MorphState = 'closed' | 'opening' | 'open' | 'closing';

/** What the driver publishes each frame. Read-only; the driver owns the storage. */
export interface MorphFrame {
  state: MorphState;
  /**
   * Whether this flight has an honest origin to travel to and from.
   *
   * False for ⌘K, for a menu launched in place, and under Reduce Motion. Published rather than
   * inferred because the *painter* needs it and cannot work it out: a seeded surface ends its
   * collapse sitting exactly on top of its own trigger, at its size and its corner, so unmounting
   * it there is invisible — while an unseeded one ends over empty background and has to fade
   * instead. Reading "did it have a seed?" off the geometry is guesswork; the driver knows.
   */
  seeded: boolean;
  geometry: MorphGeometry;
  /** 0..1, derived from geometry so it survives retargeting. */
  progress: number;
  /** Content visibility, 0..1, ramped inside the token's reveal window. */
  reveal: number;
  /** Axis stretch factors, ~1.00–1.03. */
  deform: { x: number; y: number };
  material: MaterialState;
  velocity: { x: number; y: number; width: number; height: number };
}

export interface MorphOptions {
  /**
   * What the surface is, read at use time rather than captured.
   *
   * A function, not a value, so that a caller changing `kind` does not force the controller to be
   * rebuilt. Rebuilding it throws away the spring state — and worse, `dispose()` on a controller
   * that is still mounted leaves the surface in the DOM with nothing driving it: a ghost, frozen at
   * whatever fraction of the flight it had reached. (Measured in the Motion Lab: two of them, with
   * every seed reporting `aria-expanded="false"`.) Prompt 1 §33 names this exact failure.
   */
  kind: () => DestinationKind;
  /**
   * Re-measure the world. Called on open, on close, and whenever the window changes.
   *
   * A function rather than two rects because both ends move: the destination depends on the current
   * viewport, and the seed depends on where its control has drifted to since the surface opened
   * (Prompt 1 §22, Prompt 2 §25 — the sidebar got wider, the toolbar reflowed). A morph that closes
   * to the rect it was opened from flies smoothly to a place the button no longer is.
   *
   * Returning a null seed is legitimate and means "no honest origin" (Prompt 2 §45): the surface
   * materialises in place instead of inventing a journey.
   */
  resolve: () => { seed: MorphGeometry | null; destination: MorphGeometry };
  /** Fired once the collapse has finished, so the caller can unmount. */
  onClosed?: () => void;
  /** Fired once the expansion has settled, so a structural region can leave the overlay layer. */
  onSettled?: () => void;
  /** Honour `prefers-reduced-motion`. Injected so the tests can exercise both paths. */
  reducedMotion?: () => boolean;
}

/* ------------------------------------------------------------ shared clock */

const live = new Set<MorphController>();
let frameHandle = 0;
let lastFrameTime = 0;
let timeScale = 1;

/**
 * Slow the whole motion system down (Prompt 2 §116–§117).
 *
 * The quality bar the brief sets is a 0.25× one: at full speed a good morph and a cheap fade are
 * genuinely hard to tell apart, and every defect it lists — radius pop, opacity flash, content
 * teleporting, the shadow jumping — is only visible slowed down. Scaling `dt` rather than the spring
 * constants is what makes this an honest slow motion: the physics is untouched, so what you watch at
 * 0.25× is the same trajectory that ships, not a differently-tuned one.
 *
 * Driven from the Motion Lab. Left in production code deliberately — it is four lines, it defaults
 * to 1, and a debug facility that only exists in the harness is one that cannot be used to diagnose
 * the thing the user is actually looking at.
 */
export function setTimeScale(scale: number): void {
  timeScale = Math.min(1, Math.max(0.05, scale));
}

export function getTimeScale(): number {
  return timeScale;
}

function tick(now: number): void {
  frameHandle = 0;
  const dt = (lastFrameTime ? (now - lastFrameTime) / 1000 : 1 / 60) * timeScale;
  lastFrameTime = now;

  // Snapshot: a controller settling inside its own step may call back into React (onClosed), which
  // can dispose another controller. Iterating the live set directly while that happens is how a
  // morph ends up half-stepped.
  for (const controller of [...live]) controller.advance(dt);

  if (live.size) schedule();
  else lastFrameTime = 0;
}

function schedule(): void {
  if (frameHandle || typeof requestAnimationFrame !== 'function') return;
  frameHandle = requestAnimationFrame(tick);
}

/* --------------------------------------------------------------- controller */

/**
 * How long a flight may remain unfinished before it is forced to its target.
 *
 * rAF does not fire while the window is occluded or the renderer has stopped painting, so a morph
 * interrupted by either would sit frozen at whatever fraction it had reached — and for a modal
 * surface that means the user is left under a half-drawn panel with no way back. (Seed Morph v1 hit
 * exactly this and shipped a wall-clock guard for it; the lesson carries forward.) The spring itself
 * needs no such guard — its analytic step lands settled after a long gap — so this only exists for
 * the case where the gap never ends.
 */
const WATCHDOG_MS = 1400;

export class MorphController {
  state: MorphState = 'closed';

  private readonly options: MorphOptions;
  private x: SpringState = { value: 0, velocity: 0 };
  private y: SpringState = { value: 0, velocity: 0 };
  private w: SpringState = { value: 0, velocity: 0 };
  private h: SpringState = { value: 0, velocity: 0 };
  private r: SpringState = { value: 0, velocity: 0 };

  /** Where this flight began. Kept so `progressOf` has a baseline that survives retargeting. */
  private origin: MorphGeometry | null = null;
  /** Whether the current flight has an honest origin. Published on every frame — see `MorphFrame`. */
  private seeded = false;
  private target: MorphGeometry | null = null;
  private token: MotionToken = MOTION.seedPanel;
  // Unqualified `setTimeout`, not `window.setTimeout`: the physics and the state machine are graded
  // in the node test lane, where there is no `window`, and a driver that cannot be stepped without a
  // DOM is a driver whose interruption behaviour is only ever checked by hand.
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(frame: MorphFrame) => void>();

  constructor(options: MorphOptions) {
    this.options = options;
  }

  /* ------------------------------------------------------------- commands */

  /** Grow out of the seed. Safe to call while closing — the springs keep their momentum. */
  open(): void {
    const { seed, destination } = this.options.resolve();

    // Already there, and nothing has moved. Restarting would re-enter `opening`, settle again on
    // the next tick, and announce a *second* handoff for a flight that finished — which is not a
    // harmless no-op: `onSettled` is what moves focus into a menu and what tells a structural
    // region to leave the overlay. Firing it again yanks focus back to the first row under the
    // user's hands, and remounts an overlay so it can immediately unmount.
    if (this.state === 'open' && this.target && sameGeometry(this.target, destination)) return;

    if (this.state === 'closed') {
      // A fresh flight starts *at* the seed, exactly — this is the claim the whole system makes, and
      // it is the one place it could be quietly broken by starting a pixel or two off.
      const from = this.launchGeometry(seed, destination);
      this.origin = from;
      this.x = settle(from.x);
      this.y = settle(from.y);
      this.w = settle(from.width);
      this.h = settle(from.height);
      this.r = settle(from.radius);
    } else {
      // Already in flight (or open). Keep every spring's current value AND velocity; only the
      // target changes. Reversing a close mid-collapse therefore curves back out of the fold
      // instead of restarting from the button.
      this.origin = this.origin ?? this.currentGeometry();
    }

    // A surface with no honest seed does not get a flight token. `tokenForKind` describes a journey
    // — its reveal window holds the content back until the box is most of the way there, which is
    // right for something arriving from a control and wrong for something arriving in place, where
    // the delay reads as the surface being slow rather than as it travelling. Prompt 2 §45 asks for
    // *soft materialisation* in that case, and `MOTION.materialize` is it. This is also what makes
    // ⌘K and a click on the palette's toolbar button look identical, which is the point of §45: the
    // motion may not claim a cause the interaction did not have.
    this.seeded = seed !== null && !this.reduced();
    this.token = this.reduced()
      ? MOTION.reducedMotion
      : seed ? tokenForKind(this.options.kind()) : MOTION.materialize;
    this.target = destination;
    this.state = 'opening';
    this.start();
  }

  /** Fold back into the seed, re-measured now rather than remembered from the open. */
  close(): void {
    if (this.state === 'closed') return;
    const { seed, destination } = this.options.resolve();
    // The trip home is the launch, run backwards — the *same* function, so the two can never
    // disagree. That matters in three cases that used to be handled separately or not at all:
    // the seed as it is NOW (it may have moved since the open); a control that has gone away
    // entirely, where the surface leaves from where it is rather than shrinking into a dot at its
    // own centre; and Reduce Motion, which used to open in place and then fly the whole way back
    // across the window on close — the exact travel Prompt 2 §32 asks to remove.
    this.origin = this.currentGeometry();
    this.seeded = seed !== null && !this.reduced();
    this.target = this.launchGeometry(seed, destination);
    this.token = this.reduced() ? MOTION.reducedMotion : MOTION.dismiss;
    this.state = 'closing';
    this.start();
  }

  /**
   * The window changed. Recompute both ends and keep flying (Prompt 2 §79).
   *
   * Called from a resize observer. When open, this is a spring retarget: the surface curves to the
   * new size carrying its velocity, rather than finishing at the old target and jumping — which is
   * the failure Prompt 2 §78 names outright.
   */
  remeasure(): void {
    if (this.state === 'closed') return;
    const { seed, destination } = this.options.resolve();
    this.target = this.state === 'closing'
      ? this.launchGeometry(seed, destination)
      : destination;
    this.start();
  }

  /** Drop to the target immediately, no motion. Used by the watchdog and on dispose. */
  finish(): void {
    if (!this.target) return;
    this.x = settle(this.target.x);
    this.y = settle(this.target.y);
    this.w = settle(this.target.width);
    this.h = settle(this.target.height);
    this.r = settle(this.target.radius);
    this.settleNow();
  }

  dispose(): void {
    live.delete(this);
    this.clearWatchdog();
    this.listeners.clear();
    this.state = 'closed';
  }

  subscribe(listener: (frame: MorphFrame) => void): () => void {
    this.listeners.add(listener);
    // Publish immediately so a subscriber that mounts mid-flight paints the current frame rather
    // than the element's un-driven default — which for a fixed-position surface is the top-left
    // corner of the window, for exactly one frame, and is very visible.
    if (this.target) listener(this.frame());
    return () => this.listeners.delete(listener);
  }

  /* ---------------------------------------------------------------- clock */

  /** One step. Public because the shared clock calls it; not part of the component API. */
  advance(dt: number): void {
    const target = this.target;
    if (!target) return;

    const spring = this.gradedSpring(target);
    this.x = step(this.x, target.x, spring, dt);
    this.y = step(this.y, target.y, spring, dt);
    this.w = step(this.w, target.width, spring, dt);
    this.h = step(this.h, target.height, spring, dt);
    this.r = step(this.r, target.radius, spring, dt);

    const rested = isAtRest(this.x, target.x)
      && isAtRest(this.y, target.y)
      && isAtRest(this.w, target.width)
      && isAtRest(this.h, target.height)
      && isAtRest(this.r, target.radius);

    if (rested) {
      this.finish();
      return;
    }

    this.publish();
  }

  /* -------------------------------------------------------------- private */

  private start(): void {
    live.add(this);
    schedule();
    this.clearWatchdog();
    // Divided by the time scale, or slow motion would trip its own safety net: a 400ms flight
    // watched at 0.25x takes 1.6s of wall clock and would be force-settled halfway through, which
    // looks exactly like the bug the lab exists to find.
    this.watchdog = setTimeout(() => this.finish(), WATCHDOG_MS / timeScale);
    // Node keeps the process alive for a pending timer; a watchdog is not a reason to hold a test
    // runner open, and in the renderer `unref` is simply absent.
    (this.watchdog as { unref?: () => void }).unref?.();
    this.publish();
  }

  private settleNow(): void {
    live.delete(this);
    this.clearWatchdog();
    const wasClosing = this.state === 'closing';
    this.state = wasClosing ? 'closed' : 'open';
    this.publish();
    if (wasClosing) this.options.onClosed?.();
    else this.options.onSettled?.();
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private reduced(): boolean {
    return this.options.reducedMotion?.() ?? false;
  }

  /**
   * Where the flight starts.
   *
   * Normally: the seed, exactly.
   *
   * Under Reduce Motion, the brief (Prompt 1 §27, Prompt 2 §32) asks for something more careful than
   * "turn it off" — keep the source identification and the geometry transition, remove the journey.
   * So the launch box is the destination itself, shrunk slightly and nudged a few pixels toward
   * wherever the seed is, wearing the seed's corner. The surface still visibly changes shape and
   * still leans in from the right direction; it just does not cross the window to do it.
   *
   * With no seed at all (Prompt 2 §45 — ⌘K has no spatial origin, and inventing one would be a false
   * claim about causality) the same shrink is applied with no lean.
   */
  private launchGeometry(seed: MorphGeometry | null, destination: MorphGeometry): MorphGeometry {
    if (seed && !this.reduced()) return seed;

    const inset = Math.min(destination.width, destination.height) * 0.04;
    let leanX = 0;
    let leanY = 0;
    if (seed) {
      const from = centreOf(seed);
      const to = centreOf(destination);
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      const length = Math.hypot(dx, dy) || 1;
      const LEAN = 14;
      leanX = (dx / length) * LEAN;
      leanY = (dy / length) * LEAN;
    }

    return {
      x: destination.x + inset + leanX,
      y: destination.y + inset + leanY,
      width: Math.max(1, destination.width - inset * 2),
      height: Math.max(1, destination.height - inset * 2),
      radius: seed ? seed.radius : destination.radius,
    };
  }

  private currentGeometry(): MorphGeometry {
    return {
      x: this.x.value,
      y: this.y.value,
      width: this.w.value,
      height: this.h.value,
      radius: this.r.value,
    };
  }

  /**
   * The spring, graded against *this* flight's size and distance.
   *
   * Recomputed per frame rather than cached at launch, and that is not waste: when the target moves
   * mid-flight — window resized, inspector width dragged — the grading has to move with it, or a
   * surface retargeted from a popover-sized box to a window-sized one keeps a popover's snap and
   * arrives weightless.
   */
  private gradedSpring(target: MorphGeometry): { stiffness: number; ratio: number } {
    const diagonal = Math.hypot(target.width, target.height);
    const distance = this.origin ? travelBetween(this.origin, target).distance : 0;
    return gradeSpring(this.token.spring, diagonal, distance);
  }

  private frame(): MorphFrame {
    const geometry = this.currentGeometry();
    const target = this.target ?? geometry;
    const origin = this.origin ?? geometry;
    const progress = progressOf(origin, geometry, target);

    const { start, end } = this.token.reveal;
    const reveal = this.state === 'closing'
      // Leaving early, so what flies home is an empty shell rather than shrinking text. The ramp is
      // read against *remaining* progress on the way out, which is why closing uses `1 - progress`.
      ? clamp01(1 - (progress - start) / Math.max(1e-3, end - start))
      : clamp01((progress - start) / Math.max(1e-3, end - start));

    const material = mixMaterial(
      MATERIAL.seed,
      MATERIAL[this.options.kind()],
      // Material leads the geometry a little: by the time the box has finished growing, the glass
      // it is made of should already be the destination's glass, not still catching up.
      Math.min(1, progress * 1.25),
    );

    return {
      state: this.state,
      seeded: this.seeded,
      geometry,
      progress,
      reveal,
      deform: this.reduced()
        ? { x: 1, y: 1 }
        : deformationFor(this.x.velocity, this.y.velocity),
      material,
      velocity: {
        x: this.x.velocity,
        y: this.y.velocity,
        width: this.w.velocity,
        height: this.h.velocity,
      },
    };
  }

  private publish(): void {
    if (!this.listeners.size) return;
    const frame = this.frame();
    for (const listener of this.listeners) listener(frame);
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Live morph count. Exists so the test lane can assert nothing is left running. */
export function liveMorphCount(): number {
  return live.size;
}
