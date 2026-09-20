import type { RenderingDecision } from '../../phase9/adaptive.policy';
import type { AdaptiveRuntimeSnapshot } from './global';

/**
 * WP-2 (docs/product-reset/57): the rendering half of the adaptive policy, finally applied.
 *
 * Until now `renderingPolicy` was called with its canary hardcoded off, so `mode`, `preferredFps`
 * and `nonessentialAnimation` were computed every 30 s, sent over IPC, typed in global.d.ts — and
 * read by nothing. This module is the consumer.
 *
 * It sets ONE attribute, `data-render-mode`, on the document element, and styles.css does the rest.
 * That keeps the decision in the policy and the treatment in the stylesheet, which is also why the
 * quick bar and the approval popup get it for free: all three surfaces share this entry.
 *
 * What quiet stops is decorative only — the infinite loops that cost a compositor pass per frame
 * and say nothing (blink, shimmer, orbit, the talk orb's idle pulse). A turn's elapsed seconds and
 * a notice's expiry keep ticking: a person on battery still needs to see what the agent is doing.
 */

export type RenderMode = RenderingDecision['mode'];

/**
 * The mode to apply, given what main decided. Pure, so the shadow-mode rule can be graded without a
 * DOM or an IPC bridge.
 *
 * A decision that is not `automatic` is shadow mode — main computed it but has not been told to act
 * on it — and must change nothing on screen. Reduce Motion is the exception by construction:
 * `renderingPolicy` returns it with `automatic: true` because it is an accessibility constraint, not
 * a canary. Anything unreadable falls back to `full`, because failing towards MORE motion is the
 * safe direction: a missed optimisation is invisible, a UI that silently stops animating looks broken.
 */
export function renderModeFor(rendering: RenderingDecision | null | undefined): RenderMode {
  if (!rendering || !rendering.automatic) return 'full';
  return rendering.mode === 'quiet' || rendering.mode === 'reduced-motion' ? rendering.mode : 'full';
}

/**
 * The bit of an element this module touches. Structural rather than `HTMLElement` so the rules above
 * can be graded without a DOM — app/src/__tests__ are pure-logic suites and this repo does not ship
 * jsdom. `document.documentElement` satisfies it as-is.
 */
export interface RenderModeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Stamp the mode where CSS can see it. `full` clears the attribute rather than writing a default. */
export function applyRenderMode(root: RenderModeTarget, mode: RenderMode): void {
  if (mode === 'full') root.removeAttribute('data-render-mode');
  else root.setAttribute('data-render-mode', mode);
}

interface RenderModeBridge {
  adaptiveState(): Promise<AdaptiveRuntimeSnapshot | null>;
  onAdaptiveChanged(handler: (snapshot: AdaptiveRuntimeSnapshot) => void): () => void;
}

/**
 * Subscribe for the life of the window. Returns a stop function; the app never calls it, but a test
 * must be able to.
 *
 * Main broadcasts `adaptive:changed` on every thermal transition, so there is no poll here — the
 * initial read is the only request this makes.
 */
export function startRenderMode(bridge: RenderModeBridge, root: RenderModeTarget): () => void {
  let live = true;
  const set = (snapshot: AdaptiveRuntimeSnapshot | null): void => {
    if (live) applyRenderMode(root, renderModeFor(snapshot?.rendering));
  };
  // A bridge that throws or resolves null leaves the document at `full`, which is the safe direction.
  void bridge.adaptiveState().then(set).catch(() => { /* stay at full */ });
  const off = bridge.onAdaptiveChanged(set);
  return () => { live = false; off(); };
}
