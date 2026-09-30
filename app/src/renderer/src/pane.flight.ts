/**
 * Keep the task column moving WITH a side pane — closing, and since 2026-09-30 opening too.
 *
 * Opening used to be "untouched", and measured in the built renderer it was the jitter the owner reported (UI fix list
 * item 11, "when the right panel opens"): the panel took its full width in ONE frame — the conversation went from 967px
 * to 566px and rewrapped all at once — and only then did the glass sweep in over it for ~600ms. Opening now runs the
 * same override as closing, from the other end: the pane's basis starts at the shell's width at the edge and grows
 * with it, the conversation gives way on the same frame, and the layout is handed back when the flight is at rest.
 *
 * What follows is the closing half's original account; every word of it holds for the opening.
 *
 * A bar's collapse is flown by `MorphRegion`, but its Panel used to keep its full width until the flight
 * had finished and only then leave the layout — so the pane visibly contracted first and the conversation
 * jumped across afterwards. react-resizable-panels cannot express the widths in between: its layout
 * validation clamps any size under `minSize` (or snaps a collapsible panel shut at the halfway point),
 * and changing `minSize` re-registers the panel.
 *
 * So for the length of a collapse the layout is overridden in CSS (see `[data-flight-…]` in styles.css):
 * the closing pane's flex basis follows the shell's live width every frame, the other side pane is held
 * at the pixel width it had when the collapse began, and the task column — the only panel left flexible
 * — takes up exactly what is freed, on the same frame. The pane's content is held at its starting width
 * and clipped by the shrinking pane, so it is uncovered by the moving edge rather than reflowed on every
 * frame.
 */
export type Pane = 'sidebar' | 'inspector';

const OTHER: Record<Pane, Pane> = { sidebar: 'inspector', inspector: 'sidebar' };
/* `inspector` alone since 2026-09-19. The right side used to mount as `editor` OR `inspector`
   depending on a mode flag, so every lookup here — and every `[data-flight-…]` rule in styles.css —
   had to name both. One tabbed workbench, one panel, one id. */
const PANEL_IDS: Record<Pane, string[]> = { sidebar: ['sidebar'], inspector: ['inspector'] };

interface LayoutHandle {
  getLayout(): Record<string, number>;
  setLayout(layout: Record<string, number>): unknown;
}

function panelOf(group: HTMLElement, pane: Pane): HTMLElement | null {
  for (const id of PANEL_IDS[pane]) {
    const found = group.querySelector<HTMLElement>(`[data-panel][id="${id}"], [data-panel="${id}"], [data-panel-id="${id}"]`);
    if (found) return found;
  }
  return null;
}

/** One frame of a collapse: the closing pane follows the shell. */
export function followCollapse(group: HTMLElement | null, pane: Pane, width: number, reducedMotion = false): void {
  if (!group) return;
  const flag = `data-flight-${pane}`;
  if (!group.hasAttribute(flag)) {
    const own = panelOf(group, pane);
    const other = panelOf(group, OTHER[pane]);
    if (own) group.style.setProperty(`--flight-start-${pane}`, `${own.getBoundingClientRect().width}px`);
    if (other) group.style.setProperty(`--hold-${OTHER[pane]}`, `${other.getBoundingClientRect().width}px`);
    group.setAttribute(flag, '');
  }
  // Reduce Motion collapses without travel — the shell fades in place — so the layout does not travel
  // either: the pane leaves on the first frame. Following a shell that barely shrinks instead left the
  // pane ~230px wide at unmount, and the task column reflowed by all of it in one step.
  group.style.setProperty(`--flight-${pane}`, `${reducedMotion ? 0 : Math.max(0, width)}px`);
}

/** Drop the override. Used directly when a collapse is reversed into an opening. */
export function releaseCollapse(group: HTMLElement | null, pane: Pane): void {
  if (!group) return;
  group.removeAttribute(`data-flight-${pane}`);
  for (const name of [`--flight-${pane}`, `--flight-start-${pane}`, `--hold-${OTHER[pane]}`]) group.style.removeProperty(name);
}

/**
 * The collapsed pane has left the layout. Before the override is dropped, the layout the user is already
 * looking at is written back into the panel group — the held pane at its held pixel width, the task column
 * the rest — or the group renormalises the remaining percentages and the other pane jumps wider.
 */
export function settleCollapse(group: HTMLElement | null, handle: LayoutHandle | null, pane: Pane): void {
  if (!group || !group.hasAttribute(`data-flight-${pane}`)) return;
  const held = parseFloat(group.style.getPropertyValue(`--hold-${OTHER[pane]}`));
  const total = group.getBoundingClientRect().width;
  if (handle && Number.isFinite(held) && total > 0) {
    const layout = handle.getLayout();
    const otherId = Object.keys(layout).find((id) => PANEL_IDS[OTHER[pane]].includes(id));
    if (otherId && 'task' in layout) {
      const share = Math.min(99, Math.max(1, (held / total) * 100));
      const rest = Object.entries(layout).filter(([id]) => id !== otherId && id !== 'task').reduce((sum, [, size]) => sum + size, 0);
      handle.setLayout({ ...layout, [otherId]: share, task: Math.max(1, 100 - share - rest) });
    }
  }
  releaseCollapse(group, pane);
}

/** The frame of a bar's flight, as much of it as the layout needs. */
interface FlightFrame {
  state: 'opening' | 'open' | 'closing' | 'closed';
  geometry: { width: number };
}

/**
 * The width the panel group has decided a pane gets, from its own layout — or null before it has registered the pane.
 *
 * Not the pane's box: a pane that has just mounted is drawn with the library's placeholder `flex: 1 1 0px` until the
 * group applies its layout, which measured 11.7px out of 1178 — and holding the region at THAT width flew the shell to
 * 11.6px and snapped the pane to 400px at the handoff. The layout is the number the pane is about to have.
 * Each size is a flex-grow over the space the separators leave, so it is read as a share of their sum.
 */
export function layoutWidth(group: HTMLElement, handle: LayoutHandle | null, pane: Pane): number | null {
  let layout: Record<string, number> | undefined;
  // The handle throws until the group has registered itself ("Could not find Group"), which is exactly the moment a
  // pane that mounts with the window is first asked about — measured as a render crash when this was not guarded.
  try { layout = handle?.getLayout(); } catch { return null; }
  const id = layout ? Object.keys(layout).find((key) => PANEL_IDS[pane].includes(key)) : undefined;
  if (!layout || id === undefined) return null;
  const total = Object.values(layout).reduce((sum, size) => sum + size, 0);
  if (!(total > 0)) return null;
  const separators = [...group.children]
    .filter((child) => child.hasAttribute('data-separator'))
    .reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
  return (layout[id] / total) * (group.getBoundingClientRect().width - separators);
}

/**
 * A bar's `onFrame`: its layout follows its shell in BOTH directions.
 *
 * - Closing: the pane shrinks with the shell (`followCollapse`), and `settleCollapse` hands the layout back after the
 *   pane has left it — not on the `closed` frame, which comes before the unmount.
 * - Opening: the same override, from the edge. The flight's first frames are published inside layout effects, before
 *   the first paint, so the full-width pane is never drawn. The region is held at the width the panel group is giving
 *   the pane (`layoutWidth`), re-read every frame because the group may still be settling it. Under Reduce Motion there
 *   is no travel, so there is nothing to follow: the pane is simply there.
 * - At rest open, the override is dropped. The shell is on its destination by then, so the pane's own width from the
 *   panel group is the width it already had.
 */
export function followFlight(
  group: HTMLElement | null, handle: LayoutHandle | null, pane: Pane, frame: FlightFrame, reducedMotion: boolean,
): void {
  if (frame.state === 'closing') followCollapse(group, pane, frame.geometry.width, reducedMotion);
  else if (frame.state === 'opening') {
    if (!group) return;
    if (reducedMotion) { releaseCollapse(group, pane); return; }
    // Take the layout on the FIRST frame, at zero width. The group has not laid the pane out yet (its layout effect
    // runs after this one), and waiting for it meant the first painted frame was the full-width pane — measured as the
    // conversation snapping 401px narrower for one frame and back. The width the pane is heading for is filled in as
    // soon as the group knows it; until then the pane, and so the region's measured box, is zero wide at the edge.
    if (!group.hasAttribute(`data-flight-${pane}`)) {
      const other = panelOf(group, OTHER[pane]);
      if (other) group.style.setProperty(`--hold-${OTHER[pane]}`, `${other.getBoundingClientRect().width}px`);
      group.setAttribute(`data-flight-${pane}`, '');
    }
    const target = layoutWidth(group, handle, pane);
    const held = layoutWidth(group, handle, OTHER[pane]);
    if (held !== null) group.style.setProperty(`--hold-${OTHER[pane]}`, `${held}px`);
    if (target !== null) group.style.setProperty(`--flight-start-${pane}`, `${target}px`);
    group.style.setProperty(`--flight-${pane}`, `${target === null ? 0 : Math.max(0, Math.min(target, frame.geometry.width))}px`);
  } else if (frame.state === 'open') releaseCollapse(group, pane);
}
