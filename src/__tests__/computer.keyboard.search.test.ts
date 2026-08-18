// Conformance for type-to-search — reaching CONTENT in an app with no accessibility tree.
//
// The measurements this pins, all taken 2026-08-19 against live apps:
//
//   * Focus readback is NOT a rung for blind apps. Finder and TextEdit answer AXFocusedUIElement;
//     Spotify, Notion, ChatGPT and Claude all return MISSING — before Tab, after Tab, and after
//     Cmd-K. Focus works where the tree already works and fails where it is needed.
//   * The search entry point is DISCOVERED from the menu bar, never hardcoded: Spotify publishes
//     `Edit > Search` (Cmd-L), Finder and TextEdit publish `Find`, Notion publishes none.
//   * Search is inherently FOREGROUND. Spotify's `Edit > Search` reports enabled=false while
//     backgrounded and enabled=true while frontmost, and keystrokes go to the frontmost app anyway.
//   * `properties of application X` returned EMPTY for every app including Spotify, so the first
//     scriptability probe silently reported "no live state" everywhere. The bundle's `sdef` is the
//     signal that actually works: Spotify 6 commands, Finder 25, Notion 0.

import {
  KeyboardSearch,
  buildFocusProbeScript,
  buildSubmitScript,
  buildTypeScript,
  scriptableCommandCount,
} from '../computer/keyboard.search';
import { MenuSurface } from '../computer/menu.surface';

const FS = String.fromCharCode(31);
const RS = String.fromCharCode(30);
const row = (depth: number, path: string, name: string, enabled = 'true', sub = '0') =>
  [String(depth), path, name, enabled, sub].join(FS) + RS;

/** Spotify's menu bar as measured: a Search command inside Edit, plus playback commands. */
const spotifyWalk =
  row(0, '4', 'Edit') +
  row(1, '4.4', 'Cut') +
  row(1, '4.10', 'Search') +
  row(0, '6', 'Playback') +
  row(1, '6.1', 'Play');

/** Notion's: no search command anywhere. */
const notionWalk =
  row(0, '3', 'File') +
  row(1, '3.1', 'New Tab') +
  row(0, '5', 'View') +
  row(1, '5.1', 'Reload');

const harness = (walk: string, opts: { focus?: string; bundle?: string; sdef?: string } = {}) => {
  const scripts: string[] = [];
  const osa = jest.fn(async (script: string) => {
    scripts.push(script);
    if (script.includes('properties of every menu item')) return walk;
    if (script.includes('POSIX path of (file of process')) return opts.bundle ?? '';
    if (script.includes('AXFocusedUIElement')) return opts.focus ?? '';
    if (script.includes('click mi')) return `OK${FS}Search`;
    if (script.includes('set nm to name of')) return 'Search';
    return '';
  });
  const menus = new MenuSurface(osa);
  const sdef = async () => opts.sdef ?? '';
  // settleMs 0 keeps the suite fast; the real value is measured against a live search panel.
  return { osa, scripts, search: new KeyboardSearch(menus, osa, 0, sdef) };
};

describe('search entry point discovery', () => {
  it("uses the app's own Search command rather than a hardcoded key", async () => {
    // A per-app key table (Cmd-K here, Cmd-F there) is the special-casing this codebase refuses,
    // and it is unnecessary — the app publishes its own entry point.
    const { search } = harness(spotifyWalk);
    const entry = await search.entryPoint('Spotify');
    expect(entry!.title).toBe('Search');
    expect(entry!.indexPath).toEqual([4, 10]);
  });

  it('reports an app with no search command instead of pressing keys hopefully', async () => {
    const { search } = harness(notionWalk);
    expect(await search.entryPoint('Notion')).toBeNull();
    await expect(search.search('Notion', 'anything')).rejects.toThrow(/publishes no search command/);
  });

  it('sends no keystrokes when there is no entry point', async () => {
    const { search, scripts } = harness(notionWalk);
    await search.search('Notion', 'secret text').catch(() => undefined);
    // Typing into "whatever happened to be focused" is how an agent types a search query into a
    // document. If there is no search box, nothing may be typed at all.
    expect(scripts.some(s => s.includes('keystroke'))).toBe(false);
  });
});

describe('the search flow', () => {
  it('fronts the app before looking for the command', async () => {
    // MEASURED: Spotify's Search is enabled=false backgrounded and enabled=true frontmost, and
    // keystrokes go to the frontmost app regardless. Searching cannot be a background operation.
    const { search, scripts } = harness(spotifyWalk);
    await search.search('Spotify', 'a song');
    const activateAt = scripts.findIndex(s => s.includes('to activate'));
    const walkAt = scripts.findIndex(s => s.includes('properties of every menu item'));
    expect(activateAt).toBeGreaterThanOrEqual(0);
    expect(activateAt).toBeLessThan(walkAt);
  });

  it('opens the search box before typing, never the other way round', async () => {
    const { search, scripts } = harness(spotifyWalk);
    await search.search('Spotify', 'a song');
    const clickAt = scripts.findIndex(s => s.includes('click mi'));
    const typeAt = scripts.findIndex(s => s.includes('keystroke'));
    expect(clickAt).toBeGreaterThanOrEqual(0);
    expect(clickAt).toBeLessThan(typeAt);
  });

  it('only sends Return when asked to commit', async () => {
    const plain = harness(spotifyWalk);
    await plain.search.search('Spotify', 'a song');
    expect(plain.scripts.some(s => s === buildSubmitScript())).toBe(false);

    const committed = harness(spotifyWalk);
    await committed.search.search('Spotify', 'a song', { submit: true });
    expect(committed.scripts.some(s => s === buildSubmitScript())).toBe(true);
  });

  it('types the literal text, so spaces and unicode survive', () => {
    expect(buildTypeScript('Bohemian Rhapsody')).toContain('"Bohemian Rhapsody"');
    expect(buildTypeScript('a "quoted" b')).toContain('\\"quoted\\"');
  });
});

describe('what could verify the result', () => {
  it('prefers a readable focused element when the app publishes one', async () => {
    const { search } = harness(spotifyWalk, { focus: 'AXTextField value=Bohemian' });
    const outcome = await search.search('Spotify', 'Bohemian');
    expect(outcome.verifiable).toBe('ax_focus');
    expect(outcome.observed).toMatch(/AXTextField/);
  });

  it("falls back to the app's own scripting vocabulary when focus is missing", async () => {
    // Spotify publishes no focused element but declares 6 scriptable commands, and its own
    // dictionary reported `player state` and `current track` correctly during the live run.
    const { search } = harness(spotifyWalk, {
      focus: '', bundle: '/Applications/Spotify.app', sdef: '<command name="play"/><command name="pause"/>',
    });
    const outcome = await search.search('Spotify', 'Bohemian');
    expect(outcome.verifiable).toBe('scripting_dictionary');
    expect(outcome.observed).toMatch(/2 scriptable commands/);
  });

  it('admits vision is the only option when nothing structured answers', async () => {
    // Notion: no focused element, and zero scriptable commands.
    const { search } = harness(spotifyWalk, { focus: '', bundle: '/Applications/X.app', sdef: '' });
    const outcome = await search.search('Spotify', 'Bohemian');
    expect(outcome.verifiable).toBe('vision_only');
    // Never invent a reading it did not take.
    expect(outcome.observed).toBeUndefined();
  });

  it('probes focus on the target process, not the frontmost one', () => {
    expect(buildFocusProbeScript('Spotify')).toContain('process "Spotify"');
  });
});

describe('scriptability detection', () => {
  it('counts the commands a bundle declares', async () => {
    const osa = jest.fn(async () => '/Applications/Spotify.app');
    const sdef = async () => '<command name="play"/><command name="pause"/><command name="next track"/>';
    expect(await scriptableCommandCount('Spotify', osa, sdef)).toBe(3);
  });

  it('reports zero when the app has no dictionary', async () => {
    const osa = jest.fn(async () => '/Applications/Notion.app');
    expect(await scriptableCommandCount('Notion', osa, async () => '')).toBe(0);
  });

  it('reports zero rather than throwing when the bundle path is unknown', async () => {
    const osa = jest.fn(async () => { throw new Error('no such process'); });
    expect(await scriptableCommandCount('Ghost', osa, async () => '<command name="x"/>')).toBe(0);
  });
});
