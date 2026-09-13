/**
 * Geometry of the ⌘2 bar — pure, so it can be graded without Electron.
 *
 * The bar behaves like Spotlight: a single pill that opens a quarter of the way down the screen, and
 * grows downward into a conversation as a task produces output. Unlike Spotlight it can be dragged, and it
 * reopens where it was left.
 */
export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }

export const QUICK_BAR = {
  width: 680,
  /** The pill alone: one row of input. */
  collapsedHeight: 64,
  /** The tallest the bar may grow, as a share of its screen's work area. */
  maxHeightShare: 0.72,
  /** Where a bar with no remembered position opens, as a share of the work area's height. */
  topShare: 0.24,
} as const;

function fits(point: Point, area: Rect): boolean {
  return point.x >= area.x
    && point.y >= area.y
    && point.x + QUICK_BAR.width <= area.x + area.width
    && point.y + QUICK_BAR.collapsedHeight <= area.y + area.height;
}

/**
 * Where the bar opens: where the user last left it when that spot is still fully on a screen (a display
 * may have been unplugged since), otherwise centred on the screen under the cursor, Spotlight's position.
 */
export function quickBarOrigin(saved: Point | undefined | null, workAreas: Rect[], cursorArea: Rect): Point {
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && workAreas.some((area) => fits(saved, area))) {
    return { x: Math.round(saved.x), y: Math.round(saved.y) };
  }
  return {
    x: Math.round(cursorArea.x + (cursorArea.width - QUICK_BAR.width) / 2),
    y: Math.round(cursorArea.y + cursorArea.height * QUICK_BAR.topShare),
  };
}

/**
 * The bar's bounds for a requested content height.
 *
 * It grows downward from its anchor — the spot the user placed it — and never past the bottom of its
 * screen: when there is not enough room below, it moves up instead, and it is capped at `maxHeightShare`
 * of the work area (the conversation scrolls inside it beyond that). Computed from the anchor rather than
 * from the current bounds, so a bar that moved up to fit a long answer returns to its spot when it shrinks.
 */
export function quickBarBounds(anchor: Point, requestedHeight: number, area: Rect): Rect {
  const maxHeight = Math.max(QUICK_BAR.collapsedHeight, Math.floor(area.height * QUICK_BAR.maxHeightShare));
  const wanted = Number.isFinite(requestedHeight) ? Math.ceil(requestedHeight) : QUICK_BAR.collapsedHeight;
  const height = Math.min(Math.max(QUICK_BAR.collapsedHeight, wanted), maxHeight);
  const bottom = area.y + area.height;
  const y = anchor.y + height > bottom ? Math.max(area.y, bottom - height) : anchor.y;
  const x = Math.min(Math.max(anchor.x, area.x), area.x + area.width - QUICK_BAR.width);
  return { x, y, width: QUICK_BAR.width, height };
}
