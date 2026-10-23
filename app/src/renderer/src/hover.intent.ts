/**
 * Hover intent: a surface opened by pointing stays open while the pointer is on its way to it.
 *
 * The sidebar peek closed on the first `mouseleave`, and the path from the toggle to the panel's rows
 * crosses the panel's own header — a window drag region, where Chromium delivers no pointer events at
 * all — so the panel vanished the moment the pointer left the icon (owner, fix list item 15). Closing
 * is therefore a DECISION taken a beat later, cancelled by any `enter` in between: the icon, the panel
 * and the gap between them behave as one hover region. Opening stays immediate — a delay there reads
 * as lag, and only closing can be taken back.
 *
 * Pure timer logic, no React, so the contract is testable with fake timers. The Settings flyout in
 * the sidebar footer uses the same one, so the two hover surfaces cannot drift apart.
 */
export const HOVER_CLOSE_DELAY_MS = 250;

export interface HoverIntent {
  /** The pointer is on the trigger or the surface. Opens now, and cancels a pending close. */
  enter(): void;
  /** The pointer left. Closes after the delay unless something enters first. */
  leave(delayMs?: number): void;
  /** Close now — a click that pins, Escape, focus leaving. */
  close(): void;
  /** Stop any pending timer (unmount). */
  dispose(): void;
}

export function createHoverIntent(onChange: (open: boolean) => void, closeDelayMs = HOVER_CLOSE_DELAY_MS): HoverIntent {
  let open = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const set = (next: boolean): void => {
    if (open === next) return;
    open = next;
    onChange(next);
  };
  return {
    enter() { cancel(); set(true); },
    leave(delayMs = closeDelayMs) {
      cancel();
      timer = setTimeout(() => { timer = undefined; set(false); }, delayMs);
    },
    close() { cancel(); set(false); },
    dispose: cancel,
  };
}
