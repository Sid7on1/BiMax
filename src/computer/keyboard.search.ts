/**
 * Type-to-search — reaching CONTENT in an app whose accessibility tree publishes none.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT "FOCUS NAVIGATION" ────────────────────────────────────────
 *
 * The menu bar solved COMMANDS on blind apps: measured 2026-08-18, Spotify publishes 0 targetable
 * elements and 75 named menu commands, so play/pause/skip/volume are all exact and verifiable. It
 * did nothing for CONTENT — a menu cannot click one song, or one conversation.
 *
 * The obvious next idea is to walk focus with the keyboard and read back `AXFocusedUIElement`,
 * sampling the tree one node at a time instead of enumerating it. That was MEASURED on 2026-08-19
 * and it does not work where it is needed:
 *
 *   Finder    6 window elements   focus = AXList "icon view"     <- healthy anyway
 *   TextEdit  1 window element    focus = AXOutline "list view"  <- healthy anyway
 *   Spotify   4 window elements   focus = MISSING
 *   Notion    4 window elements   focus = MISSING
 *   ChatGPT   0 window elements   focus = MISSING
 *   Claude    0 window elements   focus = MISSING
 *
 * Focus is readable exactly where the tree is already usable and missing on every app where we need
 * it — it is the same accessibility subsystem, so it fails in the same place. Spotify published no
 * focused element before Tab, after Tab, or after Cmd-K. Focus navigation is therefore NOT a rung
 * for blind apps, and this module does not pretend otherwise.
 *
 * What DOES survive is the other half of how keyboard-only Mac users work: they do not hunt for a
 * row, they open the app's search box, type a name, and let THE APP do the addressing. That needs
 * no accessibility tree at all, so a blind app cannot block it.
 *
 * ── THE ENTRY POINT IS DISCOVERED, NEVER HARDCODED ───────────────────────────────────────────────
 *
 * A per-app key table (Cmd-K here, Cmd-F there, Cmd-L elsewhere) would be exactly the per-app
 * special-casing this codebase refuses. It is unnecessary: the app publishes its own search command
 * in the menu bar we already walk. Measured 2026-08-19 — Spotify `Edit > Search` (Cmd-L), Finder
 * `Find`, TextEdit `Find`. Notion publishes none, and that is reported as "no entry point" rather
 * than answered by pressing keys hopefully.
 *
 * ── THE HONEST LIMIT: WE CAN ACT, BUT WE OFTEN CANNOT SEE ────────────────────────────────────────
 *
 * Firing a search is universal. CONFIRMING what it selected is not: on a blind app there is no
 * focused element and no tree to read back. This module therefore reports what verification is
 * actually available and never invents a confirmation — see `SearchOutcome.verifiable`.
 */

import { MenuSurface, MenuCommand, MenuSurfaceError, findSearchCommand, quoteAppleScript } from './menu.surface';

/** How the effect of a search could be checked afterwards, if at all. */
export type VerificationSource =
  /** The app publishes a focused element we can read back. */
  | 'ax_focus'
  /** The app publishes a usable window tree. */
  | 'ax_tree'
  /** The app has a scripting dictionary exposing live state (Spotify: current track, player state). */
  | 'scripting_dictionary'
  /** Nothing structured is available; only pixels can say what happened. */
  | 'vision_only';

export interface SearchOutcome {
  /** The menu command used to open the search box. */
  readonly via: string;
  /** The index path activated, for the receipt. */
  readonly indexPath: readonly number[];
  readonly text: string;
  /** True when a Return was sent to commit the selection. */
  readonly submitted: boolean;
  /** What could actually confirm this — never a claim that it WAS confirmed. */
  readonly verifiable: VerificationSource;
  /** Present only when `verifiable` produced a real reading. */
  readonly observed?: string;
}

/** Runs an AppleScript and returns stdout. Injected so this is testable without a Mac. */
export type OsaRunner = (script: string, signal?: AbortSignal) => Promise<string>;

/** Time for a search panel to appear and take keystrokes. Measured against Spotify's Cmd-L panel. */
export const SEARCH_PANEL_SETTLE_MS = 600;

/**
 * Script that types literal text into whatever now has keyboard focus.
 *
 * `keystroke` sends real characters, so unicode and spaces survive. It is deliberately separate
 * from the menu activation: the panel must exist before anything is typed, and lumping both into
 * one script would type into the old surface when the panel is slow.
 */
export function buildTypeScript(text: string): string {
  return `tell application "System Events" to keystroke ${quoteAppleScript(text)}`;
}

/** Script that presses Return to commit whatever the search box has selected. */
export function buildSubmitScript(): string {
  return 'tell application "System Events" to key code 36';
}

/** Script that reads the app's focused element, used only to report what we could verify. */
export function buildFocusProbeScript(app: string): string {
  return `tell application "System Events" to tell process ${quoteAppleScript(app)}
  try
    set f to value of attribute "AXFocusedUIElement"
    if f is missing value then return ""
    set out to (role of f) as text
    try
      set v to value of f
      if v is not missing value then set out to out & " value=" & (v as text)
    end try
    return out
  on error
    return ""
  end try
end tell`;
}

/**
 * Reaching content by asking the app to find it.
 *
 * The flow is: activate the app's own search command through the menu surface (exact, refusable,
 * and verifiable that the command ran), then type, then optionally commit. Every step that CAN be
 * checked is checked; nothing that cannot be checked is claimed.
 */
export class KeyboardSearch {
  constructor(
    private readonly menus: MenuSurface,
    private readonly osa: OsaRunner,
    private readonly settleMs: number = SEARCH_PANEL_SETTLE_MS,
    /** Reads a bundle's scripting dictionary. Injected so this stays testable without a Mac. */
    private readonly runSdef?: (bundlePath: string) => Promise<string>,
  ) {}

  /**
   * The app's own search command, or null when it publishes none.
   *
   * `force` re-walks rather than trusting the cache, because a search command's enabled state
   * depends on the app being frontmost and a snapshot taken while it was in the background reports
   * the command as dead.
   */
  async entryPoint(app: string, signal?: AbortSignal, force = false): Promise<MenuCommand | null> {
    const snapshot = await this.menus.snapshot(app, { signal, force });
    return findSearchCommand(snapshot.commands);
  }

  /**
   * Open the app's search, type `text`, and optionally commit it.
   *
   * Throws a typed `MenuSurfaceError` when the app publishes no search command — that is a real,
   * reportable state ("this app cannot be searched from the keyboard"), not something to paper over
   * by guessing a shortcut.
   */
  async search(
    app: string,
    text: string,
    opts: { submit?: boolean; signal?: AbortSignal } = {},
  ): Promise<SearchOutcome> {
    // Front FIRST, then look: the command we need may not exist until the app is active.
    await this.osa(`tell application ${quoteAppleScript(app)} to activate`, opts.signal);
    await new Promise(resolve => setTimeout(resolve, this.settleMs));
    const entry = await this.entryPoint(app, opts.signal, true);
    if (!entry) {
      throw new MenuSurfaceError(
        'not_found',
        `${app} publishes no search command in its menu bar, so its content cannot be reached by typing`,
      );
    }
    // Searching is inherently a FOREGROUND operation and this is not a silent focus steal:
    // keystrokes go to whatever app is frontmost, so typing into a background app is not a thing
    // that can work. It is also required for the command to exist at all — MEASURED 2026-08-19,
    // Spotify's `Edit > Search` reports enabled=false while backgrounded and enabled=true while
    // frontmost, which is the same activation gate that gives Finder 47/156 commands in the
    // background against 75/155 in front.
    // Activation goes through the menu surface, so a disabled search command is refused before any
    // keystroke is sent rather than typed into whatever happened to be focused.
    await this.menus.activate(app, entry.indexPath, opts.signal);
    await new Promise(resolve => setTimeout(resolve, this.settleMs));

    await this.osa(buildTypeScript(text), opts.signal);
    if (opts.submit) {
      await this.osa(buildSubmitScript(), opts.signal);
    }

    // Verification is TIERED and reported, never assumed. Focus first because it is the most
    // specific; the app's own dictionary second because it is live and exact where it exists
    // (measured: Spotify answers `player state` and `current track` while publishing no focused
    // element at all); vision last, and only named as the remaining option — this module does not
    // run it.
    const focused = (await this.osa(buildFocusProbeScript(app), opts.signal).catch(() => '')).trim();
    if (focused) {
      return { via: entry.path.join(' > '), indexPath: entry.indexPath, text, submitted: !!opts.submit,
        verifiable: 'ax_focus', observed: focused };
    }
    const scriptable = this.runSdef
      ? await scriptableCommandCount(app, this.osa, this.runSdef, opts.signal)
      : 0;
    if (scriptable > 0) {
      return { via: entry.path.join(' > '), indexPath: entry.indexPath, text, submitted: !!opts.submit,
        verifiable: 'scripting_dictionary',
        observed: `${app} declares ${scriptable} scriptable commands; its own vocabulary can confirm this` };
    }
    return { via: entry.path.join(' > '), indexPath: entry.indexPath, text, submitted: !!opts.submit,
      verifiable: 'vision_only' };
  }
}

/**
 * Does this app publish its OWN scripting vocabulary?
 *
 * MEASURED 2026-08-19, and this is the second version — the first was wrong in a way worth
 * recording. `properties of application X` looked like a generic way to read live state and
 * returned EMPTY for every app tested, including Spotify, which certainly has a dictionary. Shipped,
 * it would have reported `vision_only` everywhere while looking like a working probe.
 *
 * What does work generically is the bundle's own `sdef`: Spotify declares 6 commands, Finder 25,
 * Notion 0. That is a real, app-agnostic capability signal.
 *
 * What does NOT work generically is READING meaning out of it. Spotify exposes `current track` and
 * `player state`; another app exposes something else entirely. Knowing which property means "what
 * is playing" is per-app knowledge, and a table of those would be exactly the special-casing this
 * codebase refuses. So this reports the CAPABILITY and its size, and leaves interpretation to the
 * caller that actually has an intent.
 */
export function buildScriptabilityScript(app: string): string {
  return `tell application "System Events" to return POSIX path of (file of process ${quoteAppleScript(app)})`;
}

/** Number of commands the app's scripting dictionary declares; 0 when it has none. */
export async function scriptableCommandCount(
  app: string,
  osa: OsaRunner,
  runSdef: (bundlePath: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<number> {
  const bundle = (await osa(buildScriptabilityScript(app), signal).catch(() => '')).trim();
  if (!bundle) return 0;
  const dictionary = await runSdef(bundle).catch(() => '');
  return (String(dictionary).match(/<command name=/g) ?? []).length;
}
