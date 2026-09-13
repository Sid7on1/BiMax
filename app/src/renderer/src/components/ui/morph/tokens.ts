/**
 * Motion tokens, v2 — named by what they are for, not by how long they take.
 *
 * Prompt 1 §41 and Prompt 2 §95 both ask for the same thing and for the same reason: a duration
 * scattered across forty components is forty independent decisions that drift apart, and nobody can
 * answer "is this app's motion consistent?" by reading them. A token names an *interaction*, so the
 * question becomes "should a popover and an inspector feel the same?" — which is answerable.
 *
 * ## Why these springs are stiffer and better damped than v1's
 *
 * v1's morph used `glass` (k 340, ζ 0.70), which overshoots about 12% on a control-sized surface.
 * That is a good number for a design demo and the wrong one for BiMAX. Prompt 2 §6 is the
 * governing constraint: this is a pointer-driven Mac app, not a touch UI, and these controls get
 * clicked hundreds of times in a working session. Apple's guidance is that indirect input should
 * get the more subdued response — an overshoot you notice on the first click is one you resent by
 * the hundredth.
 *
 * So every morph token sits at ζ ≥ 0.82: present as a settle, absent as a bounce. The springiness
 * the brief asks for is still there, in the sense that matters — the surface arrives with momentum
 * and resolves it, rather than decelerating asymptotically and stopping dead. It just resolves it
 * in about two pixels.
 *
 * The values are a starting point tuned against the physics, not received wisdom; the Motion Lab
 * exists to move them (Prompt 1 §41: *do not blindly use arbitrary numbers*).
 */

import type { SpringSpec } from './spring-value';
import type { DestinationKind } from './geometry';

export interface MotionToken {
  spring: SpringSpec;
  /** Where in the flight content starts and finishes appearing, as geometric progress 0..1. */
  reveal: { start: number; end: number };
}

/**
 * The one place a spring is chosen.
 *
 * `dismiss` is not the inverse of an opening token, and that asymmetry is deliberate: the user has
 * already decided, so the flight home is an acknowledgement rather than a presentation. It is
 * critically damped (nothing may grow again after a dismissal — an overshoot on close means the
 * panel briefly gets *bigger* after the user asked for it to go away) and stiffer, so it clears the
 * screen faster than it filled it.
 */
export const MOTION = {
  /** Press and release on a control. Barely visible, purely confirmatory. */
  microFeedback: { spring: { stiffness: 900, ratio: 0.9 }, reveal: { start: 0, end: 1 } },
  /** A selection indicator moving between rows. */
  selectionMove: { spring: { stiffness: 620, ratio: 0.85 }, reveal: { start: 0, end: 1 } },

  /** Model picker, branch chooser, quick tools. The most frequent morph, so the briefest. */
  seedPopover: { spring: { stiffness: 520, ratio: 0.82 }, reveal: { start: 0.42, end: 0.80 } },
  /** A sheet or floating panel. */
  seedPanel: { spring: { stiffness: 420, ratio: 0.84 }, reveal: { start: 0.45, end: 0.85 } },
  /**
   * The sidebar and the inspector. Pane resize and collapse.
   *
   * No overshoot at all, and that is not the usual "large surface, so damp it" grading — it is a
   * different claim about what is moving. A popover is an object that arrives; a bar is the window's
   * own layout edge changing where it is. An edge that springs past its resting place and comes back
   * looks broken rather than alive, because the content on both sides of it visibly reflows twice
   * (Prompt 2 §76, §77).
   *
   * The reveal is early for the same reason. A surface that flies across the window should hold its
   * content back until it is nearly there, or the text appears to travel; a bar's content is being
   * *uncovered* by an edge moving off it, so it should be there to be uncovered.
   */
  structuralPane: { spring: { stiffness: 400, ratio: 1.0 }, reveal: { start: 0, end: 0.5 } },

  /** A surface with no honest seed (⌘K). It does not fly; it arrives. */
  materialize: { spring: { stiffness: 460, ratio: 0.95 }, reveal: { start: 0.25, end: 0.65 } },
  /** Every close. */
  dismiss: { spring: { stiffness: 700, ratio: 1.0 }, reveal: { start: 0, end: 0.30 } },

  /**
   * Reduce Motion. Not "no motion" — Prompt 2 §32 asks for the continuity to survive.
   *
   * The spring is critically damped and stiff, so the geometry still transitions (the surface is
   * still visibly the same object changing shape) but arrives in ~120ms with no overshoot. What the
   * driver additionally removes is *travel*: the flight starts from a seed collapsed onto the
   * destination's own centre, so there is a shape change without a journey across the window.
   */
  reducedMotion: { spring: { stiffness: 1100, ratio: 1.0 }, reveal: { start: 0.1, end: 0.4 } },
} satisfies Record<string, MotionToken>;

export type MotionTokenName = keyof typeof MOTION;

/** Which token a destination kind opens with. */
export function tokenForKind(kind: DestinationKind): MotionToken {
  switch (kind) {
    case 'popover':
    case 'toolbarExpansion':
      return MOTION.seedPopover;
    // Both bars grow from their own window edge rather than from whatever control asked for them —
    // see `MorphRegion`. So there is no journey to grade, and the token that describes a layout
    // edge moving is the right one for every case they have.
    case 'sidebar':
    case 'inspector':
      return MOTION.structuralPane;
    case 'palette':
    case 'floatingPanel':
    case 'workspaceSurface':
      return MOTION.seedPanel;
  }
}

/* ------------------------------------------------------------ size grading */

/** At or below this diagonal, a surface is control-sized and the token is used unmodified. */
const CONTROL_DIAGONAL = 120;
/** At or above this, the grading is at full strength. */
const WINDOW_DIAGONAL = 1100;
/** Longest travel that still counts as "across the window" for grading purposes. */
const LONG_TRAVEL = 900;

/** How much slower a full-window surface is than a control. 0.30 = 70% of the stiffness. */
const SIZE_SOFTENING = 0.30;
/** How much further toward critical damping a full-window surface is pushed. */
const SIZE_DAMPING = 0.5;
/** How much slower the longest travel is. Small on purpose — see below. */
const DISTANCE_SOFTENING = 0.12;

/** Where a value sits on 0..1 between two bounds. */
export function factor(value: number, low: number, high: number): number {
  return Math.min(1, Math.max(0, (value - low) / (high - low)));
}

/**
 * The spring for a surface of a given size, travelling a given distance.
 *
 * Two corrections, for two different complaints:
 *
 *   - **Size.** Overshoot is perceived as a fraction of the surface. 3% of a 40px pill is one pixel
 *     and reads as a crisp snap; 3% of a 900px window is 27px of visible rubber and reads as a toy.
 *     So ζ climbs toward critical as the surface grows. Stiffness falls at the same time, because a
 *     large surface that arrives as fast as a button reads as weightless however little it bounces.
 *   - **Distance.** Prompt 1 §29: 20px and 700px should not use an identical curve. But Prompt 2 §8
 *     immediately fences this in — *optimise for perceived immediacy, never animation spectacle* —
 *     so the distance term is small by design. A long flight gets 12% more time, which is enough to
 *     read as a longer journey and not enough to make the user wait for it. Scaling duration with
 *     distance the way a physical simulation would is exactly how a 700px morph becomes a 900ms one.
 *
 * Both terms are clamped, so a 5K display does not produce a spring that takes two seconds, and both
 * are flat below control size, so a 12px badge is not a special case.
 */
export function gradeSpring(spec: SpringSpec, diagonal: number, distance = 0): SpringSpec {
  const size = factor(diagonal, CONTROL_DIAGONAL, WINDOW_DIAGONAL);
  const travel = factor(distance, 0, LONG_TRAVEL);
  return {
    stiffness: spec.stiffness * (1 - SIZE_SOFTENING * size) * (1 - DISTANCE_SOFTENING * travel),
    // Toward 1, never past it: an over-damped morph crawls into place, which reads as lag.
    ratio: Math.min(1, spec.ratio + (1 - spec.ratio) * size * SIZE_DAMPING),
    mass: spec.mass,
  };
}

/* --------------------------------------------------------------- material */

/**
 * How the glass itself changes across the flight (Prompt 1 §11).
 *
 * A morph that merely resizes a box with fixed glass is the tell that it is a resized box: the
 * material of a small, thick, strongly-curved control genuinely does not look like the material of
 * a large flat sheet, and holding it constant is what makes an expansion read as a zoom.
 *
 * These are the two ends; the driver interpolates between them on geometric progress and writes
 * them as custom properties the CSS reads. `thickness` is the lens band's width — the same dial
 * `--glass-thickness` already drives — and `elevation` scales the drop shadow, so a surface that
 * starts flush with the toolbar ends up genuinely floating above the workspace.
 */
export interface MaterialState {
  /** Lens band width in px. A pill is thick glass at its scale; a sheet is thinner in proportion. */
  thickness: number;
  /** Drop-shadow strength, 0..1. */
  elevation: number;
  /** Specular highlight strength, 0..1. Concentrated on a control, diffuse on a panel. */
  sheen: number;
}

export const MATERIAL: Record<'seed' | DestinationKind, MaterialState> = {
  // The control the morph launches from: compact, high apparent thickness, tight specular.
  seed: { thickness: 5, elevation: 0.15, sheen: 1 },

  popover: { thickness: 7, elevation: 0.7, sheen: 0.7 },
  palette: { thickness: 12, elevation: 1, sheen: 0.55 },
  toolbarExpansion: { thickness: 6, elevation: 0.4, sheen: 0.8 },
  // The bars are flush with the window, not floating over it — a drop shadow there reads as a
  // second window edge, which is why `elevation` is 0 rather than merely small.
  sidebar: { thickness: 8, elevation: 0, sheen: 0.5 },
  inspector: { thickness: 8, elevation: 0, sheen: 0.5 },
  floatingPanel: { thickness: 14, elevation: 1, sheen: 0.5 },
  workspaceSurface: { thickness: 14, elevation: 0.9, sheen: 0.45 },
};

export function mixMaterial(from: MaterialState, to: MaterialState, t: number): MaterialState {
  const k = Math.min(1, Math.max(0, t));
  return {
    thickness: from.thickness + (to.thickness - from.thickness) * k,
    elevation: from.elevation + (to.elevation - from.elevation) * k,
    sheen: from.sheen + (to.sheen - from.sheen) * k,
  };
}

/* ------------------------------------------------------------ deformation */

/**
 * Velocity-derived stretch (Prompt 1 §31/§32, Prompt 2 §51).
 *
 * The reference implementation this technique comes from caps at 18%, which is right for a gooey
 * droplet and grotesque on a Mac control. The governing line is Prompt 2 §51: *velocity perceived,
 * not deformation observed* — the user should feel momentum without ever being able to say the
 * button stretched. 3% is at the edge of that: measurable in a screenshot, invisible in use.
 *
 * `k` converts px/s into stretch. At 1200 px/s — a fast flight across a large window — this reaches
 * the cap; at the speeds a small popover moves it contributes well under one percent, which is the
 * correct amount for a surface that has barely travelled.
 */
export const DEFORM_MAX = 0.03;
const DEFORM_K = 1 / 40000;

/**
 * Axis-aligned stretch factors for a given centre velocity, in px/s.
 *
 * Axis-aligned, not rotated to the travel vector, for a reason worth stating: a rotated scale
 * matrix would rotate the surface's corners with it, and a rounded rectangle whose corners are a
 * fraction of a degree off square is visibly wrong in a way a 3% stretch is not. Diagonal travel
 * therefore stretches both axes, which is the same shape a rotated stretch would produce anyway at
 * amplitudes this small.
 */
export function deformationFor(vx: number, vy: number): { x: number; y: number } {
  const sx = Math.min(DEFORM_MAX, Math.abs(vx) * DEFORM_K);
  const sy = Math.min(DEFORM_MAX, Math.abs(vy) * DEFORM_K);
  return {
    // Stretch along travel, squash across it — the volume-preserving read that makes it look like
    // material under acceleration rather than a box being scaled.
    x: 1 + sx - sy * 0.5,
    y: 1 + sy - sx * 0.5,
  };
}
