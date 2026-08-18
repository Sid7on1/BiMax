/**
 * Perception ladder — which surface should answer this observation.
 *
 * The order is AX window tree, then the menu bar, then vision, and the reasoning is not a
 * preference but a measurement:
 *
 *   AX WINDOW TREE is the most specific. It names the actual content — this row, this message,
 *     this field — and it is what a task usually needs to touch. When it is healthy nothing else
 *     is worth paying for.
 *   MENU BAR is exact but coarse. It covers COMMANDS (play, save, find, new) and not content, and
 *     it is nearly universal on macOS: measured 2026-08-18, Spotify's window publishes 1 element
 *     and 0 actionable controls while its menu bar publishes 101 items, 75 named. A full menu walk
 *     costs ~700ms-3s against ~1s for an observe, and every hit is an exact command name with a
 *     verifiable press — no coordinates, no OCR error, no model inference.
 *   VISION is universal and fuzzy. It is the only surface that survives a canvas, a game or a
 *     remote desktop, and it is also the slowest and the least certain. It is a floor, not a
 *     default.
 *
 * The ladder exists because the previous behaviour skipped the middle rung entirely: an AX-opaque
 * window went straight from "no elements" to vision, and vision then produced no targets at all
 * (`foveated:{triggered:false, ocrTextRegions:0}`), so the model was told the window was unusable
 * while every command it wanted sat named and addressable one AX query away.
 *
 * IMPORTANT: menus do not REPLACE the tree, they cover a different half of the problem. A request
 * to click a specific conversation row is not servable by a menu, and a request to start playback
 * usually is. So the decision is per-observation and is reported, never silently assumed.
 */

/**
 * What the AX window tree produced for this observation.
 *
 * TARGETABLE, not "actionable". These are two different sets and conflating them broke the ladder
 * once already: `ACTIONABLE_AX_ROLES` is buttons and fields, but a Finder window's content is
 * `AXRow`/`AXCell`, which appear in NEITHER the actionable nor the structural role set. Measured
 * 2026-08-18, a normal Finder window reports 4 actionable controls (all unlabeled) beside 28 named
 * rows — judged on "actionable" it looked blind and was routed to the menu bar, when in fact every
 * file in it was individually addressable by name.
 *
 * The rule that matches how handles are actually resolved: an element is targetable when it is NOT
 * structural. A lone AXWindow is structural, so a window publishing only chrome scores zero — which
 * is the Spotify case the ladder exists for.
 */
export interface AxTreeSignals {
  /** Non-structural elements: things a click can actually be aimed at. */
  readonly targetableCount: number;
  /** Of those, how many carry a real name rather than a positional placeholder. */
  readonly namedTargetableCount: number;
  /** The window published no elements at all. */
  readonly emptyTree: boolean;
  /** A query was supplied and the tree did not contain it. */
  readonly queryMissing: boolean;
}

/** What the menu bar produced, when it was consulted. */
export interface MenuSignals {
  /** Commands that are present AND enabled right now. */
  readonly enabledCommandCount: number;
  /** Commands matching the caller's query, if one was given. */
  readonly queryMatchCount: number;
}

export type PerceptionTier = 'ax_tree' | 'menu_bar' | 'vision';

export interface LadderDecision {
  readonly tier: PerceptionTier;
  /** Why this rung, in one line the model can read. */
  readonly reason: string;
  /** Should the menu bar be walked at all? False whenever the tree already answered. */
  readonly consultMenus: boolean;
  /** Should the vision floor run? */
  readonly consultVision: boolean;
}

/**
 * Is the AX tree good enough on its own?
 *
 * "Good enough" is deliberately about NAMED TARGETABLE elements, not element count: a lone AXWindow
 * is an entry that names nothing and can be clicked nowhere, and counting entries is exactly how a
 * window with 1 element and 0 usable controls scored healthy.
 */
export function axTreeIsSufficient(signals: AxTreeSignals): boolean {
  if (signals.emptyTree) return false;
  if (signals.targetableCount === 0) return false;
  if (signals.namedTargetableCount === 0) return false;
  // A query that the tree cannot satisfy is a miss even when the tree is otherwise rich.
  if (signals.queryMissing) return false;
  return true;
}

/** Why the AX tree could not answer, in the model's own terms. */
function cause(ax: AxTreeSignals): string {
  if (ax.emptyTree) return 'the window published no accessibility elements';
  if (ax.targetableCount === 0) return 'the window published no targetable elements';
  if (ax.namedTargetableCount === 0) return 'no targetable element carries a name';
  return `the requested target is not in the window tree (${ax.namedTargetableCount} named of ${ax.targetableCount} targetable)`;
}

/**
 * Decide the rung BEFORE the menu bar has been read.
 *
 * Returns `consultMenus` so the caller knows whether to pay the walk at all — a healthy tree must
 * not cost an extra ~700ms-3s of AppleScript on every observation.
 */
export function chooseTier(ax: AxTreeSignals): LadderDecision {
  if (axTreeIsSufficient(ax)) {
    return {
      tier: 'ax_tree',
      reason: `AX tree is usable (${ax.namedTargetableCount} named of ${ax.targetableCount} targetable)`,
      consultMenus: false,
      consultVision: false,
    };
  }
  return {
    tier: 'menu_bar',
    reason: `${cause(ax)} — trying the menu bar before vision`,
    consultMenus: true,
    consultVision: false,
  };
}

/**
 * Decide the rung AFTER the menu bar has been read.
 *
 * A menu answer only counts when something is actually actionable: a menu bar full of disabled
 * commands is not a usable surface, and a query with no matching command is a miss even when the
 * menu bar is rich. Both of those fall through to vision rather than reporting a false success.
 */
export function refineTierWithMenus(
  ax: AxTreeSignals,
  menus: MenuSignals | null,
  opts: { hasQuery: boolean } = { hasQuery: false },
): LadderDecision {
  const before = chooseTier(ax);
  if (!before.consultMenus) return before;

  if (!menus || menus.enabledCommandCount === 0) {
    return {
      tier: 'vision',
      reason: `${before.reason}; the menu bar offered no enabled command either — falling through to vision`,
      consultMenus: false,
      consultVision: true,
    };
  }
  if (opts.hasQuery && menus.queryMatchCount === 0) {
    return {
      tier: 'vision',
      reason: `${before.reason}; the menu bar has ${menus.enabledCommandCount} enabled commands but none match the request — falling through to vision`,
      consultMenus: false,
      consultVision: true,
    };
  }
  // Carry the ORIGINAL cause forward. An earlier draft replaced it with a generic "the window tree
  // is unusable", which told the model a rung had been chosen but not what was wrong with the tree —
  // and that is precisely the fact needed to decide whether a coarse command surface can serve the
  // intent at all.
  return {
    tier: 'menu_bar',
    reason: opts.hasQuery
      ? `${cause(ax)}, but ${menus.queryMatchCount} menu command(s) match the request`
      : `${cause(ax)}; the menu bar offers ${menus.enabledCommandCount} enabled commands`,
    consultMenus: false,
    consultVision: false,
  };
}

/** One line describing the ladder outcome for the observation summary the model reads. */
export function describeLadder(decision: LadderDecision, menus: MenuSignals | null): string {
  if (decision.tier === 'ax_tree') return '';
  if (decision.tier === 'menu_bar' && menus) {
    return `MENU BAR is the usable surface here (${menus.enabledCommandCount} enabled commands): ${decision.reason}. `
      + 'Target a command by its menu path — these are exact names, not guesses.';
  }
  return `NO precise surface: ${decision.reason}.`;
}
