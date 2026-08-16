/**
 * What did the user just press?
 *
 * A seeded expansion needs the rect of the control that opened the surface. Passing that down by
 * hand works, and `useSeedRef()` exists for callers who can — every menu uses it, because a menu
 * *is* its own trigger. What is left is the surfaces that cannot: the model picker is opened from
 * the composer, from the toolbar and from the command palette, and threading a rect through three
 * unrelated components means the fourth caller silently loses the animation.
 *
 * So the trigger is observed instead. One capture-phase listener records the rect of the last
 * control the user activated; any surface opening shortly afterwards can claim it.
 *
 * ## This is a fallback, not a policy
 *
 * It used to feed every dialog and both structural bars, which made "whatever the user last pressed"
 * the origin of most of the app's motion — a signature applied by default rather than chosen
 * (Prompt 2 §42). It now has two consumers: the model picker, which genuinely comes out of a control
 * that states the current model, and the palette, which asks for the *placement* and refuses the
 * origin. Everything else either holds its own seed or does not morph at all.
 *
 * ## Why not `document.activeElement`
 *
 * It is the obvious answer and it is wrong twice over. Radix moves focus INTO the dialog on mount,
 * so by the time a content component can read it the trigger is already gone — and a control
 * activated by mouse may never have taken focus at all. Recording the intent as it happens is the
 * only reading that survives both.
 *
 * ## Why freshness matters
 *
 * Not every surface is opened by a press. The engine raises approval prompts on its own schedule,
 * and a permission modal that appeared while the user was reading should NOT fly out of whatever
 * button they happened to touch a minute ago — that is a false claim about causality, and it looks
 * like one. Past the freshness window there is no seed and the surface plainly fades in, which is
 * the honest animation for "this arrived by itself".
 */

/** How recently a press must have happened to be plausibly the cause of a surface opening. */
export const INTENT_FRESHNESS_MS = 1200;

/** The things a seed can come from. Anything else is a click on scenery. */
const ACTIVATABLE = 'button, a[href], summary, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [data-seed]';

interface Intent {
  /**
   * The control itself, weakly.
   *
   * A rect is where the button *was*; between opening a surface and closing it the window may have
   * been resized, the sidebar dragged wider, the toolbar reflowed into its overflow menu — so a
   * surface that folds back into a remembered rectangle flies, very smoothly, to a place its button
   * is no longer at (Prompt 1 §22, Prompt 2 §25). Keeping the element means the seed can be
   * re-measured at the moment it is needed instead.
   *
   * Weak because this is module-level state that outlives the press: a strong reference would pin a
   * detached DOM subtree — the whole dialog that has just unmounted, in the common case — until the
   * user happens to click something else.
   */
  element: WeakRef<HTMLElement>;
  /** The rect as it was at the press. The fallback for a control that has since gone away. */
  rect: DOMRect;
  at: number;
}

let last: Intent | null = null;

/**
 * The control an event actually refers to.
 *
 * Events arrive on whatever was under the cursor — a label, an icon, a span of text inside the
 * button. Seeding from that inner node produces a flight that starts from a 14px icon rather than
 * from the control the user perceives themselves as having pressed. `closest()` walks back up to
 * the thing that is arguably the button.
 *
 * `[data-seed]` is the manual override for controls that are none of the above (a styled div with a
 * click handler), and it is checked by the same selector rather than by a separate branch so an
 * opted-in element behaves identically to a real button.
 */
export function activatedElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const found = target.closest(ACTIVATABLE);
  return found instanceof HTMLElement ? found : null;
}

/** Whether an intent recorded at `at` can still explain something opening at `now`. */
export function isFresh(at: number, now: number, window = INTENT_FRESHNESS_MS): boolean {
  return now - at >= 0 && now - at <= window;
}

function record(event: Event): void {
  const element = activatedElement(event.target);
  if (!element) return;
  const rect = element.getBoundingClientRect();
  // A control with no box (display:none, or detached between the press and this handler) would
  // seed a zero-size flight from the top-left corner of the screen. No rect is better than that.
  if (!rect.width && !rect.height) return;
  last = { element: new WeakRef(element), rect, at: Date.now() };
}

function recordKey(event: KeyboardEvent): void {
  // Enter and Space are what activate a button from the keyboard. Tabbing to it is not a press, and
  // seeding from a control the user merely passed through would be a flight from the wrong place.
  if (event.key !== 'Enter' && event.key !== ' ') return;
  record(event);
}

/**
 * The rect of the last activated control, if it is recent enough to be the cause.
 *
 * Returns null rather than a stale rect — callers treat null as "no seed, fade instead".
 */
export function recentIntentRect(window = INTENT_FRESHNESS_MS): DOMRect | null {
  return recentIntent(window)?.rect ?? null;
}

/**
 * The last activated control itself, plus when it was pressed — for callers that will need to
 * measure it again later.
 *
 * `at` is part of the result rather than hidden inside the freshness test because a seed handle has
 * two different questions to answer with it. *Opening* asks "is this press recent enough to explain
 * a surface appearing?", which is what the window is for. *Closing* asks "which control did this
 * surface come from?", where recency is irrelevant and the honest answer is the one that was
 * latched at open — so the caller compares timestamps rather than re-testing freshness.
 */
export function recentIntent(window = INTENT_FRESHNESS_MS): { element: HTMLElement | null; rect: DOMRect; at: number } | null {
  if (!last || !isFresh(last.at, Date.now(), window)) return null;
  return { element: last.element.deref() ?? null, rect: last.rect, at: last.at };
}

/** Drop the recorded intent. Used after a surface consumes it, so a second one cannot reuse it. */
export function clearIntent(): void {
  last = null;
}

/**
 * Start observing. Capture phase, so a handler that calls `stopPropagation()` — the command palette
 * and the dropdown menus both do — cannot hide the press from us.
 *
 * Three events, not one, because each covers activations the others do not see:
 *
 *   - `pointerdown` is the mouse and touch path, and the earliest signal available.
 *   - `keydown` is the keyboard path; a pointer event never fires for Enter on a focused button.
 *   - `click` catches activations that produce no pointer event at all — assistive technology
 *     commonly dispatches a bare `click`, as does any code calling `element.click()`. Without it a
 *     screen-reader user gets the plain fade while everyone else gets the expansion, which is a
 *     worse outcome for exactly the people least served by a silent state change.
 *
 * Recording the same press two or three times is harmless: each write stores the same rect, and the
 * freshness window is what decides whether it counts, not how many events produced it.
 */
export function installIntentTracking(target: Document): () => void {
  target.addEventListener('pointerdown', record, true);
  target.addEventListener('click', record, true);
  target.addEventListener('keydown', recordKey, true);
  return () => {
    target.removeEventListener('pointerdown', record, true);
    target.removeEventListener('click', record, true);
    target.removeEventListener('keydown', recordKey, true);
  };
}

// Installed on import rather than from a setup function on purpose: the alternative fails silently
// and late (every seeded surface degrades to a fade, with nothing in the console), and there is
// exactly one renderer document. Guarded so the module stays importable from the node test lane.
if (typeof document !== 'undefined') installIntentTracking(document);
