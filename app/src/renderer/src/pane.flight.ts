/**
 * Keep the task column moving WITH a closing side pane, instead of after it.
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
 * frame. Opening is untouched.
 */
export type Pane = 'sidebar' | 'inspector';

const OTHER: Record<Pane, Pane> = { sidebar: 'inspector', inspector: 'sidebar' };
const PANEL_IDS: Record<Pane, string[]> = { sidebar: ['sidebar'], inspector: ['inspector', 'editor'] };

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
