// Conformance for the menu/keyboard action surface (P7).
//
// Every expectation is pinned to a value MEASURED on this machine on 2026-08-18 against a real
// running app, not to what the AX headers imply. These encodings are the whole point of the module:
// each is a landmine that a plausible implementation gets backwards while still looking right.
//
//   * WhatsApp's menu titles arrive as U+200E + "Chats"; `menu item "Chats"` fails with -1728.
//   * The modifier mask's bit 3 is INVERTED: set means Command is absent, so mods=0 is Cmd.
//   * Finder's Enclosing Folder reports Up as cmdChar U+F700, NOT as a glyph — no glyph attribute
//     was set on a single item across five apps.
//   * AppleScript's `as text` turns `missing value` into the literal string "missing value".
//   * `name of every menu item` DROPS separators while `enabled of every menu item` keeps them, so
//     the plural-attribute read that looks like the obvious optimisation silently misaligns.
//
// A test that would pass against a naive implementation pins nothing, so the shortcut cases use
// bindings whose real value is independently known (Cmd-W is Close, Cmd-Shift-N is New Window).

import {
  MenuSurface,
  MenuSurfaceError,
  buildActivateScript,
  buildItemReference,
  buildWalkScript,
  classifyMenuFailure,
  describeShortcut,
  isDestructiveCommand,
  isMenuSeparator,
  normalizeMenuName,
  parseWalk,
  quoteAppleScript,
} from '../computer/menu.surface';

const FS = String.fromCharCode(31);
const RS = String.fromCharCode(30);
/** U+200E LEFT-TO-RIGHT MARK — the exact prefix measured on every WhatsApp menu title. */
const LRM = String.fromCharCode(0x200e);
/** U+F700 NSUpArrowFunctionKey — how Finder reports Cmd-Up on "Enclosing Folder". */
const UP_ARROW = String.fromCharCode(0xf700);
/** U+F703 — how Spotify reports Cmd-Right on "Next". */
const RIGHT_ARROW = String.fromCharCode(0xf703);

/** One row of the walk output: depth, dotted index path, name, enabled, submenu count. */
const row = (depth: number, path: string, name: string, enabled = 'true', sub = '0') =>
  [String(depth), path, name, enabled, sub].join(FS) + RS;

describe('menu name normalization', () => {
  it('strips the invisible bidi mark WhatsApp prefixes to every title', () => {
    // Measured bytes: e2808e 4368617473 — U+200E followed by "Chats".
    expect(normalizeMenuName(`${LRM}Chats`)).toBe('Chats');
    expect(`${LRM}Chats`).not.toBe('Chats');
  });

  it('treats a title that is only direction marks as nameless', () => {
    expect(isMenuSeparator(`${LRM}   `)).toBe(true);
    expect(isMenuSeparator('missing value')).toBe(true);
    expect(isMenuSeparator('Play')).toBe(false);
  });
});

describe('key equivalent decoding', () => {
  it('reads mods=0 as Command alone, because bit 3 means Command is ABSENT', () => {
    // Notion File > Close Tab, measured char=W mods=0; Cmd-W is independently known to be Close.
    const shortcut = describeShortcut('W', 0);
    expect(shortcut!.display).toBe('⌘W');
    expect(shortcut!.modifiers).toEqual(['command']);
  });

  it('reads mods=1 as Command-Shift', () => {
    // Notion File > New Window, measured char=N mods=1. Known binding: Cmd-Shift-N.
    expect(describeShortcut('N', 1)!.display).toBe('⇧⌘N');
  });

  it('drops Command when bit 3 is set', () => {
    // Finder Go > Library, measured mods=10 (8 + 2) — Option alone, no Command.
    const shortcut = describeShortcut('x', 10);
    expect(shortcut!.modifiers).toEqual(['option']);
    expect(shortcut!.display).not.toContain('⌘');
  });

  it('reports no shortcut when modifiers are present but no character is', () => {
    // Notion File > "Print…" measured mods=0 with cmdChar missing.
    expect(describeShortcut('', 0)).toBeNull();
    expect(describeShortcut('missing value', 0)).toBeNull();
    expect(describeShortcut(undefined, 4)).toBeNull();
  });

  it('maps arrow keys from the private-use block to named keys, never to typed text', () => {
    // Finder's Enclosing Folder is U+F700; Spotify's Next is U+F703. Typing these inserts garbage.
    expect(describeShortcut(UP_ARROW, 0)).toMatchObject({ key: 'up', named: true, display: '⌘↑' });
    expect(describeShortcut(RIGHT_ARROW, 0)).toMatchObject({ key: 'right', named: true, display: '⌘→' });
  });

  it('refuses to name a private-use key it does not recognise', () => {
    expect(describeShortcut(String.fromCharCode(0xf7a0), 0)).toBeNull();
  });
});

describe('index-path addressing', () => {
  it('nests the AX reference innermost-first', () => {
    expect(buildItemReference([3])).toBe('menu bar item 3 of menu bar 1');
    expect(buildItemReference([3, 7])).toBe('menu item 7 of menu 1 of menu bar item 3 of menu bar 1');
    expect(buildItemReference([3, 7, 2]))
      .toBe('menu item 2 of menu 1 of menu item 7 of menu 1 of menu bar item 3 of menu bar 1');
  });

  it('rejects a malformed path rather than generating nonsense AppleScript', () => {
    expect(() => buildItemReference([])).toThrow(MenuSurfaceError);
    expect(() => buildItemReference([0])).toThrow(/invalid index path/);
    expect(() => buildItemReference([1, -2])).toThrow(/invalid index path/);
  });

  it('activates by index, never by name — names are ambiguous and invisibly marked', () => {
    // Finder's Go menu has THREE items titled "Enclosing Folder"; a name lookup takes the wrong one.
    const script = buildActivateScript('Finder', [6, 4]);
    expect(script).toContain('menu item 4 of menu 1 of menu bar item 6');
    expect(script).not.toContain('Enclosing Folder');
  });

  it('re-reads enabled inside the activation script, not from the snapshot', () => {
    // Enabled state is app state: a command enumerated seconds ago can be dead now, and pressing a
    // disabled item is a silent no-op that AppleScript reports as success.
    const script = buildActivateScript('Finder', [5, 19]);
    expect(script).toMatch(/if not \(enabled of mi\) then return "DISABLED"/);
  });
});

describe('walk parsing', () => {
  // Shape measured live: a top-level row at depth 0, its items at depth 1, submenu items at depth 2.
  const walk =
    row(0, '1', 'Apple') +
    row(1, '1.3', 'Shut Down…') +
    row(0, '5', 'View') +
    row(1, '5.1', 'as Icons') +
    row(1, '5.2', 'missing value') +
    row(1, '5.11', 'Clean Up By', 'true', '1') +
    row(2, '5.11.1', 'Name') +
    row(2, '5.11.2', 'Kind', 'false') +
    row(0, '6', 'Go') +
    row(1, '6.3', 'Enclosing Folder', 'false') +
    row(1, '6.4', 'Enclosing Folder', 'false');

  it('drops the Apple menu, which is the system\'s and holds Shut Down', () => {
    // Measured: including it put "Shut Down" one fuzzy match away from any "close"/"quit" intent.
    const commands = parseWalk(walk);
    expect(commands.some(c => c.menu === 'Apple')).toBe(false);
    expect(commands.some(c => c.title === 'Shut Down…')).toBe(false);
  });

  it('drops separators, which activate nothing', () => {
    expect(parseWalk(walk).some(c => c.title === 'missing value')).toBe(false);
  });

  it('builds a readable name path alongside the index path', () => {
    const kind = parseWalk(walk).find(c => c.indexPath.join('.') === '5.11.2')!;
    expect(kind.path).toEqual(['View', 'Clean Up By', 'Kind']);
    expect(kind.menu).toBe('View');
    expect(kind.enabled).toBe(false);
  });

  it('keeps duplicate titles distinguishable by index path', () => {
    const dupes = parseWalk(walk).filter(c => c.title === 'Enclosing Folder');
    expect(dupes).toHaveLength(2);
    expect(dupes.map(c => c.indexPath.join('.'))).toEqual(['6.3', '6.4']);
  });

  it('marks submenu parents, which open a menu rather than performing a command', () => {
    expect(parseWalk(walk).find(c => c.title === 'Clean Up By')!.hasSubmenu).toBe(true);
  });

  it('flags destructive commands', () => {
    expect(isDestructiveCommand('Quit Finder')).toBe(true);
    expect(isDestructiveCommand('Move to Trash')).toBe(true);
    expect(isDestructiveCommand('Shut Down…')).toBe(true);
    expect(isDestructiveCommand('New Finder Window')).toBe(false);
    // MEASURED on Spotify: these were OFFERED to the model. Neither matches an anchored pattern,
    // and the first destroys local app state.
    expect(isDestructiveCommand('Reset App Data and Restart')).toBe(true);
    expect(isDestructiveCommand('Disable Hardware Acceleration and Restart')).toBe(true);
  });
});

describe('script construction', () => {
  it('escapes quotes so an app name cannot break out of the literal', () => {
    expect(quoteAppleScript('a"b')).toBe('"a\\"b"');
    expect(quoteAppleScript('a\\b')).toBe('"a\\\\b"');
  });

  it('emits no raw control character into the generated script', () => {
    // Delimiters are built inside AppleScript with `character id`, so the script text stays
    // printable and survives any transport that strips control bytes.
    const script = buildWalkScript('Spotify');
    expect(script).toContain('character id 31');
    expect(script).not.toContain(FS);
    expect(script).not.toContain(RS);
  });

  it('reads properties in bulk rather than attributes per item', () => {
    // The per-item shape measured 11,981ms on Finder against 365ms for this one; the plural
    // ATTRIBUTE shape was faster still and silently misaligned, so it is not used at all.
    const script = buildWalkScript('Finder');
    expect(script).toContain('properties of every menu item');
    expect(script).not.toContain('name of every menu item');
    expect(script).not.toContain('value of attribute "AXMenuItemCmdChar" of every menu item');
  });

  it('honours the depth limit', () => {
    expect(buildWalkScript('Finder', 1)).not.toContain('props2');
    expect(buildWalkScript('Finder', 2)).toContain('props2');
  });
});

describe('failure taxonomy', () => {
  it('separates causes that need different responses', () => {
    expect(classifyMenuFailure('System Events got an error: Can’t get process "X". (-1728)')).toBe('app_not_running');
    expect(classifyMenuFailure('osascript is not allowed assistive access. (-25211)')).toBe('permission_denied');
    expect(classifyMenuFailure('AppleEvent timed out. (-1712)')).toBe('timeout');
    expect(classifyMenuFailure('something else entirely')).toBe('unknown');
  });
});

describe('MenuSurface', () => {
  const walk =
    row(0, '2', 'File') +
    row(1, '2.1', 'New Finder Window') +
    row(1, '2.9', 'Move to Trash') +
    row(0, '5', 'View') +
    row(1, '5.19', 'Show Path Bar') +
    row(1, '5.20', 'Hide Sidebar', 'false');

  /** A fake osascript runner that answers by script shape and records what it was asked. */
  const runner = (opts: { walk?: string; activate?: string; title?: string; frontmost?: string } = {}) => {
    const scripts: string[] = [];
    const osa = jest.fn(async (script: string) => {
      scripts.push(script);
      if (script.includes('frontmost of process')) return opts.frontmost ?? 'false';
      if (script.includes('properties of every menu item')) return opts.walk ?? walk;
      if (script.includes('click mi')) return opts.activate ?? `OK${FS}Show Path Bar`;
      if (script.includes('set nm to name of')) return opts.title ?? 'Show Path Bar';
      return '';
    });
    return { osa, scripts };
  };

  it('walks the whole tree in ONE script rather than one per menu', async () => {
    // Parallelising per menu was measured SLOWER (Finder 529ms vs 237ms): System Events serialises
    // AX access, so extra processes only add spawn cost.
    const { osa } = runner();
    const surface = new MenuSurface(osa);
    await surface.snapshot('Finder');
    expect(osa).toHaveBeenCalledTimes(1);
  });

  it('caches a snapshot, and drops it after an activation changes app state', async () => {
    let clock = 1_000;
    const { osa } = runner();
    const surface = new MenuSurface(osa, () => clock);
    await surface.snapshot('Finder');
    await surface.snapshot('Finder');
    expect(osa.mock.calls.filter(c => String(c[0]).includes('properties of every')).length).toBe(1);

    await surface.activate('Finder', [5, 19]);
    await surface.snapshot('Finder');
    // Enabled flags are app state, so a snapshot taken before the click cannot be reused after it.
    expect(osa.mock.calls.filter(c => String(c[0]).includes('properties of every')).length).toBe(2);
  });

  it('never offers a destructive command to a fuzzy match', async () => {
    const { osa } = runner();
    const surface = new MenuSurface(osa);
    expect(await surface.find('Finder', 'trash')).toEqual([]);
    await expect(surface.activateBest('Finder', 'move to trash')).rejects.toThrow(/no menu command matching/);
  });

  it('ranks a disabled command last instead of hiding it', async () => {
    const { osa } = runner();
    const surface = new MenuSurface(osa);
    const hits = await surface.find('Finder', 'Hide Sidebar');
    expect(hits.map(h => h.title)).toContain('Hide Sidebar');
    expect(hits[hits.length - 1].enabled).toBe(false);
  });

  it('refuses a disabled command and says whether activation state explains it', async () => {
    // MEASURED: Finder backgrounded has 47/156 commands enabled, frontmost 75/155. So "disabled"
    // alone is not the whole answer, and the caller decides whether to front the app — this module
    // never does it silently, which was tried twice on this codebase and was wrong both times.
    const { osa } = runner({ activate: `DISABLED${FS}Hide Sidebar`, frontmost: 'false' });
    const surface = new MenuSurface(osa);
    await expect(surface.activate('Finder', [5, 20])).rejects.toThrow(/in the background/);
  });

  it('does not claim an activation state it failed to read', async () => {
    const osa = jest.fn(async (script: string) => {
      if (script.includes('frontmost of process')) throw new Error('boom');
      if (script.includes('click mi')) return `DISABLED${FS}Hide Sidebar`;
      return walk;
    });
    const surface = new MenuSurface(osa);
    // Unknown must not be reported as "in the background" — that asserts a state never measured.
    await expect(surface.activate('Finder', [5, 20])).rejects.toThrow(/disabled right now/);
    await expect(surface.activate('Finder', [5, 20])).rejects.not.toThrow(/in the background/);
  });

  it('confirms a toggle by its own renamed title', async () => {
    // "Show Path Bar" -> "Hide Path Bar" makes the item its own postcondition.
    let title = 'Show Path Bar';
    const osa = jest.fn(async (script: string) => {
      if (script.includes('properties of every menu item')) return walk;
      if (script.includes('click mi')) { title = 'Hide Path Bar'; return `OK${FS}Hide Path Bar`; }
      if (script.includes('set nm to name of')) return title;
      return '';
    });
    const surface = new MenuSurface(osa);
    const result = await surface.activateAndConfirm('Finder', [5, 19]);
    expect(result.confirmed).toBe(true);
    expect(result.title).toBe('Hide Path Bar');
  });

  it('reports an unchanged title as UNCONFIRMED, never as a failure', async () => {
    // Measured: "New Finder Window" runs fine and its title never changes. Reporting that as false
    // would turn every non-toggle command into a spurious failure.
    let clock = 0;
    const { osa } = runner({ title: 'New Finder Window', activate: `OK${FS}New Finder Window` });
    const surface = new MenuSurface(osa, () => (clock += 400));
    const result = await surface.activateAndConfirm('Finder', [2, 1]);
    expect(result.confirmed).toBeNull();
  });

  it('surfaces an unreadable menu bar as a typed failure', async () => {
    const osa = jest.fn(async () => { throw new Error('Can’t get process "Ghost". (-1728)'); });
    const surface = new MenuSurface(osa);
    await expect(surface.snapshot('Ghost')).rejects.toMatchObject({ kind: 'app_not_running' });
  });

  it('treats an empty menu bar as a reportable state, not a silent empty list', async () => {
    const osa = jest.fn(async () => '');
    const surface = new MenuSurface(osa);
    await expect(surface.snapshot('Headless')).rejects.toMatchObject({ kind: 'no_menu_bar' });
  });
});
