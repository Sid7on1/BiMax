/**
 * Menu surface — the macOS menu bar as a first-class observation and action surface.
 *
 * WHY THIS EXISTS. AX window trees are incomplete, and the gap is not evenly distributed: measured
 * on this machine 2026-08-18, Spotify's window publishes 1 element and 0 actionable controls, while
 * Spotify's menu bar publishes 101 items, 75 of them named and 45 carrying a keyboard equivalent.
 * Every command a pixel-guessing run was reaching for — Play, Next, Previous, Shuffle, Volume Up —
 * is a named, AX-addressable menu item. This surface is cheap, exact and verifiable exactly where
 * the window tree is blind.
 *
 * The window element list deliberately does NOT carry this. `desktop.runtime.ts` filters menu-role
 * nodes that are not laid out, because an app's whole menu bar is ~380 nodes against a window's ~28
 * rows and surfacing it inline would bury the window's real controls. That filter is correct and is
 * left alone; this module is the separate surface.
 *
 * ── HOW IT READS THE TREE, AND WHY THAT SHAPE ────────────────────────────────────────────────────
 *
 * MEASURED 2026-08-18. Three access patterns were benchmarked against real apps:
 *
 *   per-item attribute reads     Finder 11,981ms / Safari 17,279ms   correct
 *   bulk PLURAL attribute reads  Finder    627ms                     *** SILENTLY WRONG ***
 *   `properties of every ...`    Finder    365ms / Safari    438ms   correct   <-- what we use
 *
 * The middle row is the trap. `name of every menu item` DROPS nameless separators while
 * `enabled of every menu item` keeps them, so the two lists have different lengths (Finder's Apple
 * menu: names=15, enabled=21) and index `i` refers to a DIFFERENT item in each. A reader built on
 * them mis-assigns enabled state and shortcuts to the wrong commands while looking perfectly
 * healthy, and `value of attribute ... of every menu item` is worse still — it returns only the
 * items that HAVE the attribute (Apple menu: 5 of 21), and throws outright on some menus.
 *
 * `properties of every menu item` returns one record per item, aligned, in a single round trip:
 * 176 records for Finder's 176 real entries. That is the only bulk read this module trusts.
 * Submenu presence comes from `menus of every menu item`, which is aligned the same way.
 *
 * Parallelising across menus was also measured and is SLOWER (Finder 529ms vs 237ms): System Events
 * serialises AX access, so extra processes only add spawn cost.
 *
 * KEY EQUIVALENTS ARE NOT IN `properties` and are therefore LAZY — one targeted read (~170ms) for
 * the command actually being used, rather than ~4.7s to decorate a whole app's menus with shortcuts
 * that will never be pressed.
 *
 * ── ADDRESSING ───────────────────────────────────────────────────────────────────────────────────
 *
 * Every activation addresses items by INDEX PATH, never by name. Measured reasons, each fatal alone:
 *   * Invisible bidi marks. WhatsApp's titles are U+200E + name; `menu item "Chats"` fails -1728.
 *   * Duplicate names. Finder's Go menu has THREE items called "Enclosing Folder" (plain, Option and
 *     Control variants); a name lookup silently takes the first, which is usually the wrong one.
 *   * Names contain commas. Safari's History menu lists "Monday, August 17, 2026", so no output
 *     format may be comma-delimited and no name may be assumed atomic.
 *   * Localisation. An index is the same in every language.
 *
 * ── KEY EQUIVALENT ENCODINGS (all measured) ──────────────────────────────────────────────────────
 *
 *   * The modifier mask's bit 3 is INVERTED: set means Command is ABSENT, so mods=0 is Command.
 *     Verified against known bindings (Notion New Window char=N mods=1 -> Cmd-Shift-N).
 *   * Modifiers alone never imply a shortcut. Notion's "Print..." is mods=0 with no character.
 *   * Arrow and function keys arrive as PRIVATE-USE CHARACTERS, not glyphs: Finder's Enclosing
 *     Folder is U+F700, Spotify's Next is U+F703. No glyph attribute was set on a single item across
 *     five apps, so a Carbon glyph table would be dead code. Typing U+F700 inserts garbage; these
 *     must be pressed as named keys.
 *   * AppleScript's `as text` turns `missing value` into the literal string "missing value". This
 *     shipped past 24 green unit tests and was caught only by a live run, where it made every
 *     separator survive as a command named "missing value" and gave every item a shortcut.
 *
 * A command whose key equivalent cannot be named is reported with `shortcut: null` rather than a
 * guess: a shortcut we cannot press must not be advertised as one we can.
 */

/** Unicode direction-control marks apps prepend to menu titles. Invisible, and fatal to name matching. */
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;

/** macOS reports a menu item's key equivalent in the U+F700 private-use block for non-typing keys.
 * These are the AppKit `NS*FunctionKey` constants. Anything outside this map is deliberately unnamed. */
const FUNCTION_KEYS = new Map<number, string>([
  [0xf700, 'up'], [0xf701, 'down'], [0xf702, 'left'], [0xf703, 'right'],
  [0xf727, 'insert'], [0xf728, 'forward_delete'], [0xf729, 'home'], [0xf72b, 'end'],
  [0xf72c, 'page_up'], [0xf72d, 'page_down'], [0xf746, 'help'],
]);

/** Control characters that are legitimate key equivalents but must be pressed, not typed. */
const CONTROL_KEYS = new Map<number, string>([
  [0x08, 'delete'], [0x09, 'tab'], [0x0a, 'return'], [0x0d, 'return'],
  [0x1b, 'escape'], [0x20, 'space'], [0x7f, 'delete'],
]);

/** How a key equivalent is rendered for the model, and how it is pressed. */
export interface MenuShortcut {
  /** Human-readable form, e.g. `⌘⇧N` or `⌘↑`. */
  readonly display: string;
  /** The key to press: a single literal character, or a named key such as `up`/`return`. */
  readonly key: string;
  /** Modifier names, in the canonical order macOS renders them. */
  readonly modifiers: readonly string[];
  /** True when `key` is a named key rather than a character to type. */
  readonly named: boolean;
}

/** One node of an app's menu tree. */
export interface MenuCommand {
  /** Normalized, display- and match-safe title. */
  readonly title: string;
  /** Exact AX title, kept for diagnostics. NOT used for addressing — see the header. */
  readonly rawTitle: string;
  /** Normalized titles from the top-level menu down to this item. */
  readonly path: readonly string[];
  /** 1-based AX indices along the same route. This is what activation uses. */
  readonly indexPath: readonly number[];
  /** Normalized title of the top-level menu holding it. */
  readonly menu: string;
  /** A disabled command is present but refuses activation; it must not be offered as ready. */
  readonly enabled: boolean;
  /** True when the item opens a submenu rather than performing a command. */
  readonly hasSubmenu: boolean;
  /** True for commands that end a session or destroy data. Never auto-selected; see DESTRUCTIVE. */
  readonly destructive: boolean;
}

/**
 * Commands a ranked free-text match must never pick on its own.
 *
 * The menu bar puts "Quit", "Move to Trash" and — through the Apple menu — "Shut Down" one fuzzy
 * string match away from any intent containing "close" or "quit". Ranking alone is not a safe
 * gate for those, so they are flagged here and excluded from `find`/`activateBest` unless the
 * caller opts in explicitly with an exact index path.
 */
const DESTRUCTIVE_TITLE = /^(quit|shut ?down|restart|log ?out|sleep|move to (the )?(bin|trash)|delete|erase|empty (the )?(bin|trash)|remove|eject|close window|close all|sign out)\b/i;

/**
 * The same hazard, but not at the start of the title.
 *
 * MEASURED on Spotify 2026-08-18: the offered command list included "Reset App Data and Restart"
 * and "Disable Hardware Acceleration and Restart". Neither matches an anchored pattern, and the
 * first one destroys the user's local app state. Anchoring alone is not enough — the dangerous verb
 * can sit anywhere in a menu title.
 */
const DESTRUCTIVE_ANYWHERE = /\b(reset .*(data|settings)|and restart|erase|uninstall|deauthori[sz]e|revoke|clear .*(history|data|cache))\b/i;

/**
 * Commands every macOS app carries that are almost never the user's intent.
 *
 * These are not dangerous, they are NOISE. Measured on Spotify, the offered list led with
 * "About Spotify", "Hide Spotify", "Hide Others", "Edit > Cut/Copy/Paste", "Window > Spotify" and
 * five Help entries, while the six commands that actually drive the app (Playback > Previous, Seek,
 * Volume; View > Zoom) sat below them. A model reading top-down sees the boilerplate first.
 *
 * They are RANKED DOWN, never removed: "Paste" is boilerplate until the task is pasting.
 */
const BOILERPLATE_TITLE =
  /^(about |hide |show all$|bring all to front|minimi[sz]e|zoom$|arrange in front|enter full screen|exit full screen|.* help$|.* community$|check for updates|what.s new|acknowledgements|privacy policy|terms|report (an )?issue|send feedback|learn more)/i;

/** Menus whose entire contents are system boilerplate rather than the app's own verbs. */
const BOILERPLATE_MENU = /^(help|window)$/i;

export function isBoilerplateCommand(command: { title: string; menu: string }): boolean {
  return BOILERPLATE_MENU.test(command.menu) || BOILERPLATE_TITLE.test(command.title);
}

/**
 * Find the app's OWN search entry point from its menu bar.
 *
 * This is what makes type-to-search universal without a per-app key table: measured 2026-08-19,
 * Spotify publishes `Edit > Search` bound to Cmd-L, and Finder and TextEdit both publish `Find`.
 * The app tells us how to reach its own search box, so nothing is hardcoded and nothing is guessed.
 * An app with no such command (measured: Notion) simply has no entry point, which is a reportable
 * fact rather than a reason to start pressing keys hopefully.
 */
export function findSearchCommand(commands: readonly MenuCommand[]): MenuCommand | null {
  const ranked = commands
    .filter(c => c.enabled && !c.hasSubmenu && !c.destructive)
    .map(c => {
      const title = c.title.toLowerCase().replace(/[.…]+$/, '');
      if (title === 'search') return { c, score: 100 };
      if (title === 'find') return { c, score: 90 };
      if (/^search /.test(title)) return { c, score: 80 };
      if (/^find$|^find /.test(title)) return { c, score: 70 };
      if (/^(go to|jump to|quick open|open quickly)/.test(title)) return { c, score: 60 };
      return { c, score: 0 };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.c ?? null;
}

export function isDestructiveCommand(title: string): boolean {
  const name = normalizeMenuName(title);
  return DESTRUCTIVE_TITLE.test(name) || DESTRUCTIVE_ANYWHERE.test(name);
}

/** Why a menu read could not be answered. Each maps to a different caller response. */
export type MenuFailureKind =
  | 'app_not_running'
  | 'no_menu_bar'
  | 'permission_denied'
  | 'timeout'
  | 'not_found'
  | 'disabled'
  | 'unknown';

export class MenuSurfaceError extends Error {
  constructor(readonly kind: MenuFailureKind, message: string) {
    super(message);
    this.name = 'MenuSurfaceError';
  }
}

/** Strip invisible direction marks and surrounding whitespace. */
export function normalizeMenuName(raw: string | null | undefined): string {
  return String(raw ?? '').replace(BIDI_MARKS, '').trim();
}

/**
 * AppleScript's `as text` coercion turns `missing value` into the literal string "missing value",
 * so an unset attribute arrives looking like real content. MEASURED 2026-08-18: this made every
 * separator survive as a command named "missing value" and gave every item a shortcut, rendering
 * Notion's Print... as the nonsense "Cmd-MISSING VALUE". The generated scripts no longer coerce, so
 * this is defence in depth — kept because 24 green unit tests did not catch the first occurrence.
 */
export function absentAttribute(value: string | null | undefined): boolean {
  const trimmed = String(value ?? '').trim();
  return trimmed.length === 0 || trimmed === 'missing value';
}

/** A separator has no name of any kind once the invisible characters are gone. */
export function isMenuSeparator(raw: string | null | undefined): boolean {
  if (absentAttribute(raw)) return true;
  return normalizeMenuName(raw).length === 0;
}

const MODIFIER_ORDER: ReadonlyArray<{ bit: number; name: string; symbol: string }> = [
  { bit: 4, name: 'control', symbol: '⌃' },
  { bit: 2, name: 'option', symbol: '⌥' },
  { bit: 1, name: 'shift', symbol: '⇧' },
];

const NAMED_KEY_SYMBOLS: Record<string, string> = {
  up: '↑', down: '↓', left: '←', right: '→',
  return: '↩', tab: '⇥', space: 'Space', escape: 'Esc',
  delete: '⌫', forward_delete: '⌦',
  home: '↖', end: '↘', page_up: '⇞', page_down: '⇟',
  help: 'Help', insert: 'Insert',
};

/** Describe a key equivalent from the AX attributes. Null when absent or unnameable. */
export function describeShortcut(
  cmdChar: string | null | undefined,
  modifiers: number | null | undefined,
): MenuShortcut | null {
  const raw = String(cmdChar ?? '');
  if (absentAttribute(raw)) return null;

  const code = raw.codePointAt(0) ?? 0;
  let key: string;
  let named: boolean;
  if (FUNCTION_KEYS.has(code)) {
    key = FUNCTION_KEYS.get(code)!;
    named = true;
  } else if (CONTROL_KEYS.has(code)) {
    key = CONTROL_KEYS.get(code)!;
    named = true;
  } else if (code >= 0xf700 && code <= 0xf8ff) {
    // Private-use block, but not a key we can name. Do not claim it.
    return null;
  } else {
    key = raw;
    named = false;
  }

  const mask = Number(modifiers ?? 0);
  const mods: string[] = [];
  let display = '';
  for (const { bit, name, symbol } of MODIFIER_ORDER) {
    if ((mask & bit) !== 0) { mods.push(name); display += symbol; }
  }
  // Bit 3 set means Command is NOT part of the equivalent.
  if ((mask & 8) === 0) { mods.push('command'); display += '⌘'; }

  const shown = named ? (NAMED_KEY_SYMBOLS[key] ?? key.toUpperCase()) : key.toUpperCase();
  return { display: `${display}${shown}`, key, modifiers: mods, named };
}

/** Escape a string for embedding in an AppleScript double-quoted literal. */
export function quoteAppleScript(value: string): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** ASCII US/RS. They cannot occur in a menu title, and are built inside AppleScript by code point so
 * no control character ever appears in this source or in a generated script string. */
const FIELD = String.fromCharCode(31);
const RECORD = String.fromCharCode(30);

/**
 * Build the AX reference for an item at an index path, innermost first.
 *
 * `[3]`      -> menu bar item 3 (a top-level menu)
 * `[3,7]`    -> menu item 7 of menu 1 of menu bar item 3
 * `[3,7,2]`  -> menu item 2 of menu 1 of menu item 7 of menu 1 of menu bar item 3
 */
export function buildItemReference(indexPath: readonly number[]): string {
  if (indexPath.length === 0) throw new MenuSurfaceError('not_found', 'empty index path');
  if (indexPath.some(index => !Number.isInteger(index) || index < 1)) {
    throw new MenuSurfaceError('not_found', `invalid index path: ${indexPath.join('.')}`);
  }
  let reference = `menu bar item ${indexPath[0]} of menu bar 1`;
  for (let depth = 1; depth < indexPath.length; depth += 1) {
    reference = `menu item ${indexPath[depth]} of menu 1 of ${reference}`;
  }
  return reference;
}

/**
 * One script that walks the whole menu bar to `maxDepth`, using only aligned bulk reads.
 *
 * The loop counters are numeric and every title is coerced with `as text` at the point of use:
 * `repeat with t in someList` binds a REFERENCE that AppleScript re-evaluates lazily, which
 * silently produced zero rows in an earlier draft of this walk.
 */
export function buildWalkScript(app: string, maxDepth = 2): string {
  // The deeper block is OMITTED rather than guarded by a false condition, so a depth-1 walk sends
  // no dead AppleScript and the generated script says exactly what it will do.
  const deeper = maxDepth >= 2 ? `
        if (sub > 0) then
          try
            set props2 to properties of every menu item of menu 1 of menu item b of menu 1 of menu bar item a of menu bar 1
            repeat with c from 1 to (count of props2)
              set pr2 to item c of props2
              set nm2 to name of pr2
              if nm2 is missing value then set nm2 to ""
              set en2 to enabled of pr2
              if en2 is missing value then set en2 to false
              set out to out & "2" & fs & (a as text) & "." & (b as text) & "." & (c as text) & fs & (nm2 as text) & fs & (en2 as text) & fs & "0" & rs
            end repeat
          end try
        end if` : '';

  return `tell application "System Events" to tell process ${quoteAppleScript(app)}
  set fs to character id 31
  set rs to character id 30
  set out to ""
  set topCount to count of menu bar items of menu bar 1
  repeat with a from 1 to topCount
    try
      set topName to name of menu bar item a of menu bar 1
      if topName is missing value then set topName to ""
      set out to out & "0" & fs & (a as text) & fs & (topName as text) & fs & "true" & fs & "1" & rs
      set props to properties of every menu item of menu 1 of menu bar item a of menu bar 1
      set subs to menus of every menu item of menu 1 of menu bar item a of menu bar 1
      repeat with b from 1 to (count of props)
        set pr to item b of props
        set nm to name of pr
        if nm is missing value then set nm to ""
        set en to enabled of pr
        if en is missing value then set en to false
        set sub to 0
        try
          set sub to count of (item b of subs)
        end try
        set out to out & "1" & fs & (a as text) & "." & (b as text) & fs & (nm as text) & fs & (en as text) & fs & (sub as text) & rs${deeper}
      end repeat
    end try
  end repeat
  return out
end tell`;
}

/** Script reading one item's key equivalent. Addressed by index path, so it is bidi- and
 * duplicate-proof. */
export function buildShortcutScript(app: string, indexPath: readonly number[]): string {
  return `tell application "System Events" to tell process ${quoteAppleScript(app)}
  set mi to ${buildItemReference(indexPath)}
  set cc to ""
  try
    set v to value of attribute "AXMenuItemCmdChar" of mi
    if v is not missing value then set cc to v as text
  end try
  set md to "0"
  try
    set v to value of attribute "AXMenuItemCmdModifiers" of mi
    if v is not missing value then set md to v as text
  end try
  return cc & (character id 31) & md
end tell`;
}

/**
 * Script that activates one item by index path, re-reading `enabled` immediately before the click.
 *
 * The freshness matters: enabled state is a function of app state, not of the menu, so a command
 * enumerated seconds ago can be dead by the time it is pressed — and pressing a disabled item is a
 * SILENT no-op that AppleScript reports as success.
 */
export function buildActivateScript(app: string, indexPath: readonly number[]): string {
  return `tell application "System Events" to tell process ${quoteAppleScript(app)}
  set mi to ${buildItemReference(indexPath)}
  set nm to name of mi
  if nm is missing value then set nm to ""
  if not (enabled of mi) then return "DISABLED" & (character id 31) & (nm as text)
  click mi
  return "OK" & (character id 31) & (nm as text)
end tell`;
}

/** Parse the delimited walk output into a flat command list. Separators are dropped. */
export function parseWalk(stdout: string): MenuCommand[] {
  const commands: MenuCommand[] = [];
  /** Normalized title for each index path, so a child can rebuild its own name path. */
  const titleByPath = new Map<string, string>();

  for (const record of String(stdout ?? '').split(RECORD)) {
    if (!record.includes(FIELD)) continue;
    const [depthRaw = '', pathRaw = '', nameRaw = '', enabledRaw = '', subRaw = '0'] = record.split(FIELD);
    const depth = Number(depthRaw);
    if (!Number.isFinite(depth)) continue;
    const indexPath = pathRaw.trim().split('.').map(Number);
    if (indexPath.length === 0 || indexPath.some(n => !Number.isInteger(n) || n < 1)) continue;

    const rawTitle = absentAttribute(nameRaw) ? '' : nameRaw;
    const title = normalizeMenuName(rawTitle);
    titleByPath.set(indexPath.join('.'), title);
    // Depth 0 is the top-level menu itself: it names the branch but is not a command.
    if (depth === 0) continue;
    // The Apple menu belongs to the SYSTEM, not to the app being driven, and it is where Shut Down,
    // Restart and Log Out live — one fuzzy match away from any intent mentioning "close" or "quit".
    // It is dropped whole rather than filtered per item, because nothing an app task needs is in it.
    if (titleByPath.get(String(indexPath[0])) === 'Apple') continue;
    // A nameless item is a separator and activates nothing.
    if (title.length === 0) continue;

    const path: string[] = [];
    for (let i = 1; i <= indexPath.length; i += 1) {
      const at = titleByPath.get(indexPath.slice(0, i).join('.'));
      if (at) path.push(at);
    }
    commands.push({
      title,
      rawTitle,
      path,
      indexPath,
      menu: titleByPath.get(String(indexPath[0])) ?? '',
      enabled: String(enabledRaw).trim() === 'true',
      hasSubmenu: Number(subRaw) > 0,
      destructive: isDestructiveCommand(title),
    });
  }
  return commands;
}

/** Classify a raw osascript failure so callers can respond differently to each cause. */
export function classifyMenuFailure(message: string): MenuFailureKind {
  const text = String(message ?? '');
  if (/-1728|Can.t get process|is not running|isn.t running/i.test(text)) return 'app_not_running';
  if (/-25211|-1743|assistive|not authori[sz]ed|not allowed/i.test(text)) return 'permission_denied';
  if (/timed out|ETIMEDOUT|-1712/i.test(text)) return 'timeout';
  if (/menu bar|-25202|-25212/i.test(text)) return 'no_menu_bar';
  return 'unknown';
}

/** Script asking whether this process currently owns the menu bar. */
export function buildFrontmostScript(app: string): string {
  return `tell application "System Events" to return (frontmost of process ${quoteAppleScript(app)}) as text`;
}

/**
 * Render commands for the model: grouped by menu, app verbs before boilerplate.
 *
 * A flat list of 60 dotted paths is technically complete and practically unreadable. Grouping by
 * menu mirrors how the app itself is organised, so "what can I do to playback" is answerable by
 * reading one line instead of scanning sixty.
 */
export function describeMenuForModel(
  commands: readonly MenuCommand[],
  shortcuts: ReadonlyMap<string, MenuShortcut> = new Map(),
  limitPerMenu = 12,
): string {
  const byMenu = new Map<string, MenuCommand[]>();
  for (const command of commands) {
    const list = byMenu.get(command.menu) ?? [];
    list.push(command);
    byMenu.set(command.menu, list);
  }
  // Order menus by how much of each is the app's OWN verbs. Ranking only Help/Window down was not
  // enough: measured on Spotify the application menu led with About/Hide/Hide Others while Playback
  // — the six commands that actually drive the app — sat fourth.
  const usefulness = (menu: string) => {
    const entries = byMenu.get(menu) ?? [];
    if (BOILERPLATE_MENU.test(menu)) return -1;
    const real = entries.filter(c => !isBoilerplateCommand(c)).length;
    return entries.length === 0 ? 0 : real / entries.length;
  };
  const menus = [...byMenu.keys()].sort((a, b) => usefulness(b) - usefulness(a));
  const lines: string[] = [];
  for (const menu of menus) {
    const entries = byMenu.get(menu)!
      .slice()
      .sort((a, b) => Number(isBoilerplateCommand(a)) - Number(isBoilerplateCommand(b)));
    const rendered = entries.slice(0, limitPerMenu).map(command => {
      const key = shortcuts.get(command.indexPath.join('.'));
      const deeper = command.indexPath.length > 2 ? command.path.slice(1, -1).join(' > ') + ' > ' : '';
      return `${deeper}${command.title}${key ? ` ${key.display}` : ''} [${command.indexPath.join('.')}]`;
    });
    const more = entries.length > limitPerMenu ? ` (+${entries.length - limitPerMenu} more)` : '';
    lines.push(`${menu}: ${rendered.join(', ')}${more}`);
  }
  return lines.join('\n');
}

/** Runs an AppleScript and returns stdout. Injected so the surface is testable without a Mac. */
export type OsaRunner = (script: string, signal?: AbortSignal) => Promise<string>;

export interface MenuSnapshot {
  readonly app: string;
  readonly commands: readonly MenuCommand[];
  /** Top-level menu titles, in menu-bar order. */
  readonly menus: readonly string[];
  /** Milliseconds the walk cost, so a caller can see how cheap this surface is. */
  readonly elapsedMs: number;
}

/**
 * How long to wait for an app to reflect a menu command before calling the result unconfirmed.
 *
 * MEASURED 2026-08-18 by toggling Finder's path bar three times and polling the item's own title:
 * it settled after 748ms, 1157ms and 1134ms. A caller that re-reads immediately sees the OLD title
 * and concludes the click missed — which is exactly what happened on the first live run here. The
 * budget is deliberately above the slowest observation, and polling stops as soon as it changes.
 */
export const MENU_SETTLE_BUDGET_MS = 2_000;
const MENU_SETTLE_POLL_MS = 50;

/** How long a cached snapshot stays usable. Menu STRUCTURE is near-static; `enabled` is not, which
 * is why activation always re-reads it rather than trusting the cache. */
export const SNAPSHOT_TTL_MS = 15_000;

/**
 * The menu bar of one running process.
 *
 * The whole tree costs one script (~270-450ms measured), so a snapshot is taken whole and cached
 * briefly rather than drip-fed per menu. Key equivalents stay lazy because they are the only part
 * that cannot be read in bulk.
 */
export class MenuSurface {
  private readonly cache = new Map<string, { at: number; snapshot: MenuSnapshot }>();

  constructor(private readonly osa: OsaRunner, private readonly now: () => number = Date.now) {}

  /** Walk the app's whole menu bar. Cached for a few seconds; `force` bypasses the cache. */
  async snapshot(
    app: string,
    opts: { maxDepth?: number; force?: boolean; signal?: AbortSignal } = {},
  ): Promise<MenuSnapshot> {
    const maxDepth = opts.maxDepth ?? 2;
    const key = `${app}:${maxDepth}`;
    const hit = this.cache.get(key);
    if (!opts.force && hit && this.now() - hit.at < SNAPSHOT_TTL_MS) return hit.snapshot;

    const started = this.now();
    let stdout: string;
    try {
      stdout = await this.osa(buildWalkScript(app, maxDepth), opts.signal);
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      throw new MenuSurfaceError(classifyMenuFailure(message), `menu bar unreadable for ${app}: ${message}`);
    }
    const commands = parseWalk(stdout);
    if (commands.length === 0) {
      // An app with a genuinely empty menu bar is a real, reportable state — not an error to hide.
      throw new MenuSurfaceError('no_menu_bar', `${app} published no menu commands`);
    }
    const menus: string[] = [];
    for (const command of commands) {
      if (command.menu && !menus.includes(command.menu)) menus.push(command.menu);
    }
    const snapshot: MenuSnapshot = { app, commands, menus, elapsedMs: this.now() - started };
    this.cache.set(key, { at: this.now(), snapshot });
    return snapshot;
  }

  /** Top-level menu titles. */
  async titles(app: string, signal?: AbortSignal): Promise<string[]> {
    return [...(await this.snapshot(app, { signal })).menus];
  }

  /** Commands directly inside one named top-level menu. */
  async commands(app: string, menu: string, signal?: AbortSignal): Promise<MenuCommand[]> {
    const wanted = normalizeMenuName(menu).toLowerCase();
    const snapshot = await this.snapshot(app, { signal });
    const found = snapshot.commands.filter(c => c.menu.toLowerCase() === wanted && c.indexPath.length === 2);
    if (found.length === 0) {
      throw new MenuSurfaceError(
        'not_found',
        `no menu "${normalizeMenuName(menu)}" in ${app} — available: ${snapshot.menus.join(', ')}`,
      );
    }
    return found;
  }

  /**
   * Rank candidate commands for a free-text intent, best first.
   *
   * Ranked rather than filtered, so the caller can see why a target was chosen. Disabled commands
   * rank last instead of vanishing: "the command exists but is not available right now" is a useful
   * answer, and dropping them makes an app look like it has no such command at all.
   */
  async find(app: string, query: string, signal?: AbortSignal): Promise<MenuCommand[]> {
    const wanted = normalizeMenuName(query).toLowerCase();
    if (!wanted) return [];
    const snapshot = await this.snapshot(app, { signal });
    const words = wanted.split(/\s+/).filter(Boolean);
    const scored: Array<{ command: MenuCommand; score: number }> = [];
    for (const command of snapshot.commands) {
      // A submenu parent opens a menu, it does not perform a command.
      if (command.hasSubmenu) continue;
      // Never let a fuzzy match reach Quit / Move to Trash / Shut Down.
      if (command.destructive) continue;
      const title = command.title.toLowerCase();
      const trimmed = title.replace(/[.…\s]+$/, '');
      let score = 0;
      if (title === wanted || trimmed === wanted) score = 100;
      else if (trimmed.startsWith(wanted)) score = 80;
      else if (title.includes(wanted)) score = 60;
      else if (words.length > 1 && words.every(word => title.includes(word))) score = 40;
      if (score === 0) continue;
      if (!command.enabled) score -= 50;
      scored.push({ command, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.command.title.length - b.command.title.length)
      .map(entry => entry.command);
  }

  /**
   * Is the app currently frontmost?
   *
   * MEASURED 2026-08-18, and it changes what the menu bar will accept: with Finder in the
   * background 47 of 156 commands are enabled, and with it frontmost 75 of 155 are. TextEdit barely
   * moves (33 -> 36). So activation state gates a large, app-specific slice of the menu, and a
   * "disabled" answer is only the whole truth once you know which state produced it.
   */
  async isFrontmost(app: string, signal?: AbortSignal): Promise<boolean | null> {
    try {
      const stdout = await this.osa(buildFrontmostScript(app), signal);
      const answer = String(stdout).trim();
      if (answer === 'true') return true;
      if (answer === 'false') return false;
      return null;
    } catch {
      // Unknown, NOT backgrounded. Returning false here would assert an activation state we never
      // measured — and a malformed script in this very method once made that assertion silently.
      return null;
    }
  }

  /**
   * Resolve key equivalents for many commands in ONE script.
   *
   * MEASURED 2026-08-19: reading them one call at a time cost 3,971ms for 25 commands (~159ms each,
   * dominated by process spawn), while a single script covering every item in the app took 1,576ms.
   * Shortcuts are the whole point of the keyboard path, so they must not cost four seconds.
   */
  async shortcutsFor(
    app: string,
    indexPaths: ReadonlyArray<readonly number[]>,
    signal?: AbortSignal,
  ): Promise<Map<string, MenuShortcut>> {
    const found = new Map<string, MenuShortcut>();
    if (indexPaths.length === 0) return found;
    const blocks = indexPaths.map(path => `  set k to ${quoteAppleScript(path.join('.'))}
  set cc to ""
  set md to "0"
  try
    set mi to ${buildItemReference(path)}
    set v to value of attribute "AXMenuItemCmdChar" of mi
    if v is not missing value then set cc to v as text
    set v2 to value of attribute "AXMenuItemCmdModifiers" of mi
    if v2 is not missing value then set md to v2 as text
  end try
  set out to out & k & fs & cc & fs & md & rs`).join('\n');
    const script = `tell application "System Events" to tell process ${quoteAppleScript(app)}
  set fs to character id 31
  set rs to character id 30
  set out to ""
${blocks}
  return out
end tell`;
    const stdout = await this.osa(script, signal).catch(() => '');
    for (const record of String(stdout).split(RECORD)) {
      if (!record.includes(FIELD)) continue;
      const [key = '', cmdChar = '', modifiers = '0'] = record.split(FIELD);
      const shortcut = describeShortcut(cmdChar, absentAttribute(modifiers) ? 0 : Number(modifiers) || 0);
      if (shortcut) found.set(key.trim(), shortcut);
    }
    return found;
  }

  /** Resolve one command's key equivalent. Lazy: this is the only read that is not bulk. */
  async shortcutFor(
    app: string,
    indexPath: readonly number[],
    signal?: AbortSignal,
  ): Promise<MenuShortcut | null> {
    const stdout = await this.osa(buildShortcutScript(app, indexPath), signal);
    const [cmdChar = '', modifiers = '0'] = String(stdout).replace(/\n$/, '').split(FIELD);
    return describeShortcut(cmdChar, absentAttribute(modifiers) ? 0 : Number(modifiers) || 0);
  }

  /**
   * Activate a command by index path.
   *
   * `enabled` is re-read inside the same script immediately before the click, because a command
   * enumerated seconds ago can be dead by now and pressing a disabled item is a silent no-op that
   * AppleScript reports as success.
   */
  async activate(
    app: string,
    indexPath: readonly number[],
    signal?: AbortSignal,
  ): Promise<{ title: string }> {
    return this.activateInternal(app, indexPath, signal);
  }

  /**
   * Activate, then wait for the app to actually reflect it.
   *
   * A toggle renames its own menu item ("Show Path Bar" -> "Hide Path Bar"), which makes the item
   * its own postcondition — end state, not a receipt. `confirmed: null` means the command ran and
   * the title simply is not a toggle, which is NOT the same as a failure and must not be reported
   * as one.
   */
  async activateAndConfirm(
    app: string,
    indexPath: readonly number[],
    signal?: AbortSignal,
  ): Promise<{ title: string; confirmed: boolean | null; elapsedMs: number }> {
    const before = await this.titleAt(app, indexPath, signal).catch(() => null);
    const started = this.now();
    const result = await this.activateInternal(app, indexPath, signal);
    if (before === null) return { ...result, confirmed: null, elapsedMs: this.now() - started };

    while (this.now() - started < MENU_SETTLE_BUDGET_MS) {
      const seen = await this.titleAt(app, indexPath, signal).catch(() => null);
      if (seen !== null && seen !== before) {
        return { title: seen, confirmed: true, elapsedMs: this.now() - started };
      }
      await new Promise(resolve => setTimeout(resolve, MENU_SETTLE_POLL_MS));
    }
    return { ...result, confirmed: null, elapsedMs: this.now() - started };
  }

  /** Current title of one item, used as its own postcondition. */
  private async titleAt(app: string, indexPath: readonly number[], signal?: AbortSignal): Promise<string> {
    const script = `tell application "System Events" to tell process ${quoteAppleScript(app)}
  set nm to name of ${buildItemReference(indexPath)}
  if nm is missing value then return ""
  return nm as text
end tell`;
    return normalizeMenuName(await this.osa(script, signal));
  }

  private async activateInternal(
    app: string,
    indexPath: readonly number[],
    signal?: AbortSignal,
  ): Promise<{ title: string }> {
    let stdout: string;
    try {
      stdout = await this.osa(buildActivateScript(app, indexPath), signal);
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      throw new MenuSurfaceError(
        classifyMenuFailure(message),
        `could not activate ${indexPath.join('.')} in ${app}: ${message}`,
      );
    }
    const [status = '', title = ''] = String(stdout).replace(/\n$/, '').split(FIELD);
    if (status.trim() === 'DISABLED') {
      // Report the activation state rather than silently fixing it. Auto-switching to the
      // foreground was tried twice on this codebase and was wrong both times: it steals the user's
      // screen to satisfy a guess. Naming the condition lets the caller decide.
      const frontmost = await this.isFrontmost(app, signal);
      const hint = frontmost === true
        ? ' and the app is already frontmost, so this is app state, not activation state'
        : frontmost === false
          ? `; ${app} is in the background, where a large app-specific slice of the menu is disabled — activating it may enable this command`
          : '';
      throw new MenuSurfaceError(
        'disabled',
        `menu command "${normalizeMenuName(title)}" is disabled right now and would do nothing${hint}`,
      );
    }
    // The app's state has just changed under us, so every cached enabled flag is now suspect.
    this.cache.clear();
    return { title: normalizeMenuName(title) };
  }

  /** Resolve a free-text intent and activate the best ENABLED match. */
  async activateBest(
    app: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<{ title: string; path: readonly string[] }> {
    const candidates = await this.find(app, query, signal);
    const target = candidates.find(c => c.enabled);
    if (!target) {
      const closest = candidates[0];
      if (closest) {
        throw new MenuSurfaceError(
          'disabled',
          `"${closest.title}" exists in ${closest.path.join(' > ')} but is disabled right now`,
        );
      }
      throw new MenuSurfaceError('not_found', `no menu command matching "${query}" in ${app}`);
    }
    const done = await this.activate(app, target.indexPath, signal);
    return { title: done.title || target.title, path: target.path };
  }
}
