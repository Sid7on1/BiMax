/**
 * Bimax's own "Reduce motion" setting, applied to the page.
 *
 * The setting is `reducedMotion` in the engine config (Settings → General), and for its whole life it
 * was written and never read (fix list item 17). It now stamps `data-reduce-motion` on <html>, which
 * styles.css answers with the same quieting the macOS setting gets, and `prefersReducedMotion()` in
 * motion.ts reads for the morphs.
 *
 * The config is the source of truth; this page keeps a copy in localStorage only so a window that has
 * just opened — before any engine has answered — does not animate once and then stop. Every window
 * this renderer mounts (the main window, the ⌘2 bar, the approval popup) reads that copy at boot.
 */
const KEY = 'bimax:reduce-motion';

export function applyMotionPreference(reduce: boolean, root: HTMLElement = document.documentElement): void {
  try { localStorage.setItem(KEY, reduce ? '1' : '0'); } catch { /* storage refused: the attribute still applies */ }
  root.toggleAttribute('data-reduce-motion', reduce);
}

/** The copy saved by the last `applyMotionPreference`, false when there is none or storage is refused. */
export function savedMotionPreference(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
