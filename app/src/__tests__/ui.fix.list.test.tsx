import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { composerOverflow, COMPOSER_MAX_HEIGHT, approvalLevel } from '../renderer/src/composer.model';
import { createHoverIntent, HOVER_CLOSE_DELAY_MS } from '../renderer/src/hover.intent';
import { AttachmentWell } from '../renderer/src/components/AttachmentWell';
import { QUICK_TOGGLES, toggleValue } from '../renderer/src/quick.settings';
import { visibleThreads, THREADS_PAGE } from '../renderer/src/threads.list.model';
import { QuickBarLesson } from '../renderer/src/components/ProjectWelcome';
import { ancestorsOf, closeTabs, cycleTab, filesToClose, neighbourAfterClose, tabLabel } from '../renderer/src/workbench.tabs';
// The workbench imports the terminal, whose stylesheet jest cannot load; the terminal is not under test here.
jest.mock('../renderer/src/components/TerminalPanel', () => ({ TerminalPanel: () => null }));
import { Inspector } from '../renderer/src/components/Inspector';
import { MATCH_COUNT_CAP, matchStatus, nearestMatch, statusText } from '../renderer/src/components/FindWidget';
import { EditorSelection, EditorState } from '@codemirror/state';
import { SearchQuery } from '@codemirror/search';
import { inspectorTabs, type WorkbenchTab } from '../renderer/src/inspector.model';
// The renderer's `window.bimax` declaration, which ProjectWelcome compiles against.
import type {} from '../renderer/src/global';
import { CONFIG_WIRE_KEYS } from '../../../src/protocol/config.wire';
import { GATE_KEYS } from '../../../src/engine/gate.flags';
import { Markdown } from '../renderer/src/markdown';

/**
 * The owner's UI fix list, 2026-09-30 (`front inspo/14-ui-fix-list-2026-09-30.md`). One block per item,
 * each written to fail against the code the owner reported.
 */

const repo = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(repo, rel), 'utf8');
const css = read('app/src/renderer/src/styles.css');

describe('item 1 — the placeholder never gets a scrollbar', () => {
  test('an empty field never scrolls, however tall its wrapped placeholder measures', () => {
    expect(composerOverflow('', 900)).toBe('hidden');
    expect(composerOverflow('', COMPOSER_MAX_HEIGHT + 1)).toBe('hidden');
  });
  test('typed text scrolls only once it is taller than the cap', () => {
    expect(composerOverflow('short', 40)).toBe('hidden');
    expect(composerOverflow('a lot', COMPOSER_MAX_HEIGHT)).toBe('hidden');
    expect(composerOverflow('a lot', COMPOSER_MAX_HEIGHT + 1)).toBe('auto');
  });
  test('the field applies the rule, refits on width changes, and the placeholder is one line', () => {
    const composer = read('app/src/renderer/src/components/Composer.tsx');
    expect(composer).toContain('ta.style.overflowY = composerOverflow(ta.value, full)');
    expect(composer).toContain('new ResizeObserver(');
    expect(css).toMatch(/\.composer-input::placeholder \{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/);
  });
});

describe('items 2, 3, 13 — floating surfaces are readable over live content', () => {
  test('the floating veil is the solid floating tint at 94%, in every theme block', () => {
    const veils = [...css.matchAll(/--float-veil: ([^;]+);/g)].map((m) => m[1]);
    // @theme, .theme-moonlight, .theme-starlight, and the Reduce Transparency override.
    expect(veils).toEqual([
      'color-mix(in srgb, var(--float-solid) 94%, transparent)',
      'color-mix(in srgb, var(--float-solid) 94%, transparent)',
      'color-mix(in srgb, var(--float-solid) 94%, transparent)',
      'var(--float-solid)',
    ]);
  });
  test('menus and dialogs take it: the liquid-glass material and the Settings shell', () => {
    expect(css).toMatch(/\.liquid-glass \{\n  position: relative;\n  isolation: isolate;\n  background: var\(--float-veil\);/);
    expect(css).toMatch(/\.settings-shell \{\n  background: var\(--float-veil\);/);
  });
});

describe('item 4 — the + that opens the attach tray closes it', () => {
  test('the tray has no Done button of its own', () => {
    const tray = renderToStaticMarkup(
      <AttachmentWell attachments={[]} dragging={false} onPick={() => undefined} onRemove={() => undefined} onClose={() => undefined} />,
    );
    expect(tray).not.toContain('Done');
    expect(tray).toContain('Choose files or drop them here');
  });
  test('the composer\'s + toggles: it closes when the tray is open and says so', () => {
    const composer = read('app/src/renderer/src/components/Composer.tsx');
    expect(composer).toContain('onClick={wellOpen ? closeWell : openWell}');
    expect(composer).toContain('aria-expanded={wellOpen}');
    expect(composer).toContain("aria-label={wellOpen ? 'Close the attach tray' : 'Attach files'}");
  });
});

describe('item 5 — Settings hover holds quick switches, not App health', () => {
  const sidebar = read('app/src/renderer/src/components/TaskSidebar.tsx');
  test('App health is gone from the sidebar', () => {
    expect(sidebar).not.toMatch(/label: 'App health'/);
    expect(sidebar).not.toContain('onOpenMachineHealth');
    expect(sidebar).not.toContain('HardDrive');
    expect(sidebar).toContain('aria-label="Quick settings"');
  });
  test('four or five switches, every one of them reaching something live', () => {
    expect(QUICK_TOGGLES.length).toBeGreaterThanOrEqual(4);
    expect(QUICK_TOGGLES.length).toBeLessThanOrEqual(5);
    // Applied by the PAGE, not the engine: each needs a reader in the renderer.
    const app = read('app/src/renderer/src/App.tsx');
    const pageApplied: Record<string, boolean> = {
      reducedMotion: app.includes('applyMotionPreference(config.reducedMotion)'),
      notificationBell: app.includes('setTurnSound(config.notificationBell === true)') && app.includes('window.bimax.beep?.()'),
    };
    for (const toggle of QUICK_TOGGLES) {
      expect([toggle.key, CONFIG_WIRE_KEYS.includes(toggle.key as never)]).toEqual([toggle.key, true]);
      const live = (GATE_KEYS as readonly string[]).includes(toggle.key) || pageApplied[toggle.key] === true;
      expect([toggle.key, live]).toEqual([toggle.key, true]);
    }
  });
  test('unset reads as off', () => {
    expect(toggleValue(null, 'selfCritic')).toBe(false);
    expect(toggleValue({}, 'selfCritic')).toBe(false);
    expect(toggleValue({ selfCritic: true }, 'selfCritic')).toBe(true);
  });
});

describe('item 6 — the Threads list shows five, and its rows are not toolbars', () => {
  const threads = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}` }));
  test('five, then "Show more" for the rest', () => {
    expect(THREADS_PAGE).toBe(5);
    const { shown, hidden } = visibleThreads(threads, null, false);
    expect(shown.map((t) => t.id)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(hidden).toBe(4);
  });
  test('the thread you are in is always visible, and the list stays five long', () => {
    const { shown, hidden } = visibleThreads(threads, 't7', false);
    expect(shown.map((t) => t.id)).toEqual(['t0', 't1', 't2', 't3', 't7']);
    expect(hidden).toBe(4);
    expect(visibleThreads(threads, 't2', false).shown.map((t) => t.id)).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });
  test('expanded, or five or fewer, shows everything', () => {
    expect(visibleThreads(threads, null, true)).toEqual({ shown: threads, hidden: 0 });
    expect(visibleThreads(threads.slice(0, 5), null, false).hidden).toBe(0);
  });
  test('a row offers Resume/Stop, Rename and Bin; the rest is behind "…"', () => {
    const list = read('app/src/renderer/src/components/ThreadsList.tsx');
    for (const visible of ['label="Resume"', 'label="Stop only this thread"', 'label="Rename"', 'label="Move to the Bin"', 'label="More actions for this thread"']) {
      expect([visible, list.includes(visible)]).toEqual([visible, true]);
    }
    // No longer a standing row of text buttons: these live only inside the "…" menu.
    expect(list).not.toContain('Priority: {');
    expect(list).not.toContain("'Link to current'");
    expect(list).toContain('<SeedMenuLabel>Priority</SeedMenuLabel>');
    expect(css).toContain('.thread-row-actions { background: var(--glass-solid);');
  });
});

describe('item 7 — the current recent is marked by glass, not a white strip', () => {
  test('no light bar down the active row, and no sheen line across it', () => {
    expect(css).toContain('.sidebar-shell .glass-row[data-active] { background: var(--glass-raise); }');
    expect(css).not.toMatch(/glass-row\[data-active\][^{]*\{[^}]*inset 2px 0 0/);
    expect(css).toMatch(/\.glass-row\[data-active='true'\] \{\n  background: var\(--glass-raise\);\n\}/);
  });
});

describe('item 12 — the permission pill states the engine\'s gates', () => {
  test('each combination of gates names one level', () => {
    expect(approvalLevel({ askBeforeEdits: true, readOnly: false, unattended: false })).toBe('ask');
    expect(approvalLevel({ askBeforeEdits: false, readOnly: false, unattended: false })).toBe('auto');
    expect(approvalLevel({ askBeforeEdits: false, readOnly: true, unattended: false })).toBe('readOnly');
    expect(approvalLevel({ askBeforeEdits: false, readOnly: false, unattended: true })).toBe('unattended');
    // Read-only wins: nothing is written, whatever else is set.
    expect(approvalLevel({ askBeforeEdits: true, readOnly: true, unattended: true })).toBe('readOnly');
    expect(approvalLevel(undefined)).toBeNull();
  });
  test('"Custom rules" unfolds its choices instead of closing and sending nothing', () => {
    const composer = read('app/src/renderer/src/components/Composer.tsx');
    expect(composer).toContain('if (!entry.autonomy) { setCustomOpen((value) => !value); return; }');
    expect(composer).toContain('const engineLevel = approvalLevel(snapshot?.approvals);');
  });
});

describe('item 13 — no decorative thinking budget', () => {
  test('the model window no longer offers it, and the wire no longer carries it', () => {
    const dialog = read('app/src/renderer/src/components/ModelDialog.tsx');
    expect(dialog).not.toContain("onApply('maxThinkingTokens'");
    expect(dialog).not.toContain('function ThinkingTokens(');
    expect(CONFIG_WIRE_KEYS).not.toContain('maxThinkingTokens' as never);
  });
});

describe('item 14 — the peek is readable over the conversation', () => {
  test('peeking, the sidebar takes the floating density', () => {
    // The rule, not its exact text: item 10 added the peek's own blur to the same rule.
    const peek = css.slice(css.indexOf('.sidebar-peek .sidebar-shell {'), css.indexOf('}', css.indexOf('.sidebar-peek .sidebar-shell {')));
    expect(peek).toContain('background: color-mix(in srgb, var(--glass-solid) 94%, transparent);');
    expect(read('app/src/renderer/src/App.tsx')).toContain('className="sidebar-peek ');
  });
});

describe('item 15 — the peek survives the trip from the toggle to the panel', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('leaving closes only after the delay', () => {
    const seen: boolean[] = [];
    const intent = createHoverIntent((open) => seen.push(open));
    intent.enter();
    intent.leave();
    jest.advanceTimersByTime(HOVER_CLOSE_DELAY_MS - 1);
    expect(seen).toEqual([true]);
    jest.advanceTimersByTime(1);
    expect(seen).toEqual([true, false]);
  });

  test('reaching the panel before the delay keeps it open', () => {
    const seen: boolean[] = [];
    const intent = createHoverIntent((open) => seen.push(open));
    intent.enter();           // the toggle
    intent.leave();           // …off the toggle, across the header
    jest.advanceTimersByTime(HOVER_CLOSE_DELAY_MS / 2);
    intent.enter();           // the panel
    jest.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 4);
    expect(seen).toEqual([true]);
  });

  test('close is immediate, and a later hover opens it again', () => {
    const seen: boolean[] = [];
    const intent = createHoverIntent((open) => seen.push(open));
    intent.enter();
    intent.close();
    intent.enter();
    expect(seen).toEqual([true, false, true]);
    intent.dispose();
  });

  test('the peek goes through the intent, and its header is not a drag region while peeking', () => {
    const app = read('app/src/renderer/src/App.tsx');
    expect(app).not.toContain('setSidebarPeek(false)');
    expect(app).toContain('onMouseLeave={() => peekIntent.leave()}');
    expect(app).toContain('onPeekLeave={() => peekIntent.leave()}');
    expect(read('app/src/renderer/src/components/TaskSidebar.tsx')).toContain("!peek && 'drag-region'");
  });
});

describe('item 18 — no card that looks like a button and goes nowhere', () => {
  test('the Environment and ML Alchemist pages list their inventories instead of dead links', () => {
    const settings = read('app/src/renderer/src/components/SettingsDialog.tsx');
    expect(settings).not.toContain('action="Open Environment"');
    expect(settings).not.toContain('action="Open Alchemist"');
    expect(settings).toContain('<CapabilityList title="Tools on this Mac"');
    expect(settings).toContain('<CapabilityList title="Backends"');
  });
  test('a card with no action does not answer the pointer', () => {
    expect(css).toContain('.settings-action-card--static, .settings-action-card--static:hover { cursor: default;');
    expect(read('app/src/renderer/src/components/SettingsDialog.tsx')).toContain('<div className="settings-action-card settings-action-card--static">');
  });
});

describe('item 20 — the welcome says what Bimax does that others do not', () => {
  test('no generic headline', () => {
    const welcome = read('app/src/renderer/src/components/ProjectWelcome.tsx');
    const heading = welcome.match(/<h1[^>]*>\s*([^<]+?)\s*<\/h1>/)?.[1];
    expect(heading).toBe('Work you can verify.');
  });
});

describe('item 21 — ⌘2 is taught by pressing it', () => {
  test('it asks for the key, then confirms once the bar has opened', () => {
    const waiting = renderToStaticMarkup(<QuickBarLesson shortcut="⌘2" initial="waiting" />);
    expect(waiting).toContain('Try it now: press ⌘2.');
    expect(waiting).toContain('Not now');
    const learned = renderToStaticMarkup(<QuickBarLesson shortcut="⌘2" initial="learned" />);
    expect(learned).toContain('That’s the ⌘2 bar.');
    expect(learned).not.toContain('Try it now');
  });
  test('main tells the window when the bar opens, and the lesson listens', () => {
    const main = read('app/src/main/index.ts');
    const show = main.slice(main.indexOf('async function showQuickBar('), main.indexOf('function bimaxModel('));
    expect(show).toContain("broadcast('threads:quick-shown');");
    expect(read('app/src/preload/index.ts')).toContain("onQuickShown: (cb: () => void) => subscribe('threads:quick-shown', cb)");
    expect(read('app/src/renderer/src/components/ProjectWelcome.tsx')).toContain('window.bimax.threads.onQuickShown?.(');
  });
});

describe('item 8 — open files are tabs, and the tree is one click away', () => {
  const FILES = ['src/api/index.ts', 'docs/README.md', 'src/web/index.ts'];

  test('a tab is its name; a folder hint appears only when two open files share a name', () => {
    expect(tabLabel(FILES, 'docs/README.md')).toEqual({ name: 'README.md', hint: '' });
    expect(tabLabel(FILES, 'src/api/index.ts')).toEqual({ name: 'index.ts', hint: 'api' });
    expect(tabLabel(FILES, 'src/web/index.ts')).toEqual({ name: 'index.ts', hint: 'web' });
    // The shortest trailing part that differs, not the whole path.
    expect(tabLabel(['a/x/y.ts', 'b/x/y.ts'], 'a/x/y.ts')).toEqual({ name: 'y.ts', hint: 'a/x' });
  });

  test('closing the tab in front lands on the one that slides under the pointer', () => {
    expect(neighbourAfterClose(FILES, 'src/api/index.ts')).toBe('docs/README.md'); // right
    expect(neighbourAfterClose(FILES, 'src/web/index.ts')).toBe('docs/README.md'); // left, at the end
    expect(neighbourAfterClose(['only.ts'], 'only.ts')).toBeNull();
  });

  test('Close Others, Close to the Right, Close All', () => {
    expect(filesToClose(FILES, 'docs/README.md', 'others')).toEqual(['src/api/index.ts', 'src/web/index.ts']);
    expect(filesToClose(FILES, 'docs/README.md', 'right')).toEqual(['src/web/index.ts']);
    expect(filesToClose(FILES, 'docs/README.md', 'all')).toEqual(FILES);
    expect(filesToClose(FILES, 'gone.ts', 'close')).toEqual([]);
  });

  test('⌃Tab wraps round, and the tree opens on the current file’s folders', () => {
    expect(cycleTab(FILES, 'src/web/index.ts', 1)).toBe('src/api/index.ts');
    expect(cycleTab(FILES, 'src/api/index.ts', -1)).toBe('src/web/index.ts');
    expect(cycleTab(FILES, null, 1)).toBe('src/api/index.ts');
    expect(ancestorsOf('src/api/index.ts')).toEqual(['src', 'src/api']);
    expect(ancestorsOf('README.md')).toEqual([]);
  });

  test('an unsaved tab is shown and asked about; Cancel, or a failed save, keeps it and everything after it', async () => {
    const run = async (answers: ('save' | 'discard' | 'cancel')[], saves = true) => {
      const log: string[] = [];
      const closed = await closeTabs(FILES, {
        isDirty: (p) => p !== 'docs/README.md',
        show: (p) => log.push(`show ${p}`),
        ask: async (p) => { log.push(`ask ${p}`); return answers.shift() ?? 'cancel'; },
        save: async (p) => { log.push(`save ${p}`); return saves; },
        close: (p) => log.push(`close ${p}`),
      });
      return { closed, log };
    };
    const saved = await run(['save', 'discard']);
    expect(saved.closed).toEqual(FILES);
    expect(saved.log).toEqual([
      'show src/api/index.ts', 'ask src/api/index.ts', 'save src/api/index.ts', 'close src/api/index.ts',
      'close docs/README.md',
      'show src/web/index.ts', 'ask src/web/index.ts', 'close src/web/index.ts',
    ]);
    expect((await run(['cancel'])).closed).toEqual([]);
    expect((await run(['save'], false)).closed).toEqual([]);
  });

  function render(active: WorkbenchTab, openFiles = FILES, dirty: string[] = []) {
    return renderToStaticMarkup(
      <Inspector
        tabs={inspectorTabs({ review: null, gitStatus: null, hasProject: true, isRepo: true })}
        active={active} onTab={() => {}} onClose={() => {}}
        review={null} gitStatus={null} checkpoints={undefined} onRefreshGit={() => {}} onCommand={() => {}}
        project="/p" onOpenFile={() => {}} lastFile={null}
        openFiles={openFiles} dirtyFiles={new Set(dirty)} onCloseFile={() => {}} onCloseFiles={() => {}} onDirty={() => {}}
        wide={false} onToggleWide={() => {}}
      />,
    );
  }

  test('with a file in front: a tab per open file, that one selected, and the tree one click away', () => {
    const html = render({ kind: 'file', path: 'docs/README.md' }, FILES, ['src/web/index.ts']);
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toMatch(/aria-selected="true"[^>]*title="docs\/README.md"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*title="Show the project’s files"/);
    expect(html).toContain('data-dirty="true"');
    // The arrows the tabs replace are gone; the folder is a way back to the tree.
    expect(html).not.toContain('Previous open file');
    expect(html).toContain('show in the file tree');
  });

  test('in the tree the tabs stay, none selected; in Terminal or Review they give the lane its height back', () => {
    const tree = render({ kind: 'lane', id: 'files' });
    expect(tree.match(/role="tab"/g)).toHaveLength(3);
    expect(tree).not.toContain('aria-selected="true"');
    expect(tree).toMatch(/aria-pressed="true"[^>]*title="Show the project’s files"/);
    expect(render({ kind: 'lane', id: 'review' })).not.toContain('role="tablist"');
    expect(render({ kind: 'lane', id: 'files' }, [])).not.toContain('role="tablist"');
  });

  test('App asks before closing, ⌘W closes the tab in front, ⌃Tab steps', () => {
    const app = read('app/src/renderer/src/App.tsx');
    expect(app).toContain("ask: (path) => window.bimax.files.confirmClose?.(path) ?? Promise.resolve('cancel' as const),");
    expect(app).toContain('onCloseFiles={(paths) => { void closeFiles(paths); }}');
    expect(app).toContain("w: 'close-tab',");
    expect(app).toContain("if (inspectorOpen && activeTab?.kind === 'file') void closeFiles([activeTab.path]);");
    expect(app).toContain("event.key === 'Tab' && tabKeys.current.cycle(event.shiftKey ? -1 : 1)");
    // The no-questions close is only for a file the editor cannot show.
    expect(app).toContain('onCloseFile={closeFile}');
    // The tree, remounted each time it comes back, opens on the file you were in.
    const files = read('app/src/renderer/src/components/FilesPanel.tsx');
    expect(files).toContain('for (const dir of ancestorsOf(activeFile)) loadDir(dir, true);');
    expect(files).toContain("row.scrollIntoView?.({ block: 'center' });");
  });
});

describe('item 9 — find and replace is Cursor’s widget', () => {
  const DOC = 'const response = await fetch(url);\nif (!response.ok) throw new Error(RESPONSE);\nreturn response;';
  const at = (from: number, to: number) => EditorState.create({ doc: DOC, selection: EditorSelection.single(from, to) });
  const first = DOC.indexOf('response');
  const second = DOC.indexOf('response', first + 1);

  test('it counts the matches and says which one you are on', () => {
    const query = new SearchQuery({ search: 'response' });
    expect(matchStatus(at(0, 0), query)).toEqual({ count: 4, current: 0, capped: false });
    expect(statusText(query, matchStatus(at(0, 0), query))).toBe('4 found');
    const onSecond = at(second, second + 'response'.length);
    expect(statusText(query, matchStatus(onSecond, query))).toBe('2 of 4');
    // The toggles change what counts: case, and whole word.
    expect(matchStatus(at(0, 0), new SearchQuery({ search: 'response', caseSensitive: true })).count).toBe(3);
    expect(matchStatus(at(0, 0), new SearchQuery({ search: 'respon', wholeWord: true })).count).toBe(0);
  });

  test('empty, invalid and missing each say so, in words', () => {
    expect(statusText(new SearchQuery({ search: '' }), { count: 0, current: 0, capped: false })).toBe('');
    const broken = new SearchQuery({ search: '(', regexp: true });
    expect(statusText(broken, matchStatus(at(0, 0), broken))).toBe('Invalid pattern');
    const none = new SearchQuery({ search: 'nowhere' });
    expect(statusText(none, matchStatus(at(0, 0), none))).toBe('No results');
  });

  test('a huge count stops at the cap instead of walking the whole file on every keystroke', () => {
    const state = EditorState.create({ doc: 'x '.repeat(MATCH_COUNT_CAP * 3) });
    const query = new SearchQuery({ search: 'x' });
    const status = matchStatus(state, query);
    expect(status).toEqual({ count: MATCH_COUNT_CAP, current: 0, capped: true });
    expect(statusText(query, status)).toBe(`${MATCH_COUNT_CAP}+ found`);
  });

  test('find-as-you-type lands on the next match from the caret, wrapping to the top', () => {
    const query = new SearchQuery({ search: 'response' });
    expect(nearestMatch(at(0, 0), query, first + 1)?.from).toBe(second);
    expect(nearestMatch(at(0, 0), query, DOC.length)?.from).toBe(first);
    expect(nearestMatch(at(0, 0), new SearchQuery({ search: 'nowhere' }), 0)).toBeNull();
  });

  test('find in selection counts only inside the range it was turned on for', () => {
    const scope = { from: 0, to: DOC.indexOf('\n') };
    const query = new SearchQuery({ search: 'response', test: (_m, _s, from, to) => from >= scope.from && to <= scope.to });
    expect(matchStatus(at(0, 0), query).count).toBe(1);
  });

  test('the editor uses it, floating over the code instead of docking across it', () => {
    const editor = read('app/src/renderer/src/components/EditorPane.tsx');
    expect(editor).toContain('findWidget(),');
    expect(editor).toMatch(/'\.cm-panels': \{\s*position: 'absolute', top: '6px', right: '14px', left: 'auto'/);
    // The stock panel's input styling must not reach the widget's fields.
    expect(editor).toContain("'.cm-panel:not(.find-widget-host) input, .cm-textfield'");
    const widget = read('app/src/renderer/src/components/FindWidget.tsx');
    expect(widget).toContain('return search({ top: true, createPanel: (view) => new FindPanel(view) });');
    expect(widget).toContain("runScopeHandlers(view, event.nativeEvent, 'search-panel')");
  });
});

describe('item 10 — the sidebar and the conversation are one window', () => {
  const block = (selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    // Declarations only: the comments inside a rule explain what it no longer does.
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '');
  };

  test('the pinned sidebar carries no blur of its own, like the canvas and the right pane; the peek keeps it', () => {
    // Measured on the installed window: the sidebar/canvas step is exactly their tints' difference, so the pinned
    // blur painted nothing — it only cost a compositor pass on a full-height layer while panes fly.
    expect(block('.sidebar-shell')).not.toContain('backdrop-filter');
    expect(block('.app-surface')).not.toContain('backdrop-filter');
    // The unprefixed property itself — `-webkit-backdrop-filter` contains the same text.
    expect(block('.sidebar-peek .sidebar-shell')).toMatch(/^\s*backdrop-filter: blur\(20px\) saturate\(1\.2\);/m);
  });

  test('the sidebar’s name is shown whole or not at all — never "Bi…"', () => {
    const sidebar = read('app/src/renderer/src/components/TaskSidebar.tsx');
    expect(sidebar).toContain('<span className="sidebar-title shrink-0 ');
    expect(sidebar).not.toMatch(/<span className="truncate[^"]*">Bimax<\/span>/);
    expect(sidebar).toContain("cn('sidebar-header flex h-11");
    expect(css).toContain('.sidebar-header { container-type: inline-size; }');
    expect(css).toContain('@container (max-width: 117px) { .sidebar-title { display: none; } }');
  });
});

/** A rule's declarations, comments stripped, for the selector exactly as written in styles.css. */
const ruleOf = (selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '');
};

describe('item 34 — every control takes clicks over at least 24×24', () => {
  // `npm run check:hit-targets` measures this by clicking in the built app; these pin the source it measured.
  test('`.hit-24` widens the clickable region to 24×24 and paints nothing', () => {
    const ring = ruleOf('.hit-24::after');
    expect(ring).toContain("content: '';");
    expect(ring).toContain('width: max(100%, 24px);');
    expect(ring).toContain('height: max(100%, 24px);');
    expect(ring).toContain('translate: -50% -50%;');
    expect(ring).not.toMatch(/background|border|box-shadow/);
    expect(ruleOf('.hit-24')).toContain('position: relative;');
  });

  test('the small glyphs wear the ring: "Thought for", a tab’s ×, find’s toggles and chevron', () => {
    expect(read('app/src/renderer/src/components/Transcript.tsx')).toContain("cn('hit-24 flex items-center gap-1 text-xs text-faint italic'");
    expect(read('app/src/renderer/src/components/Inspector.tsx')).toContain('className="workbench-tab-close hit-24"');
    const find = read('app/src/renderer/src/components/FindWidget.tsx');
    expect(find).toContain('className="find-toggle hit-24"');
    expect(find).toContain('className="find-expand hit-24"');
  });

  test('toggles 22px wide sit 2px apart, so neighbouring 24px rings meet and do not overlap', () => {
    // At 1px apart each lost the pixel its neighbour's ring covered: measured 22.5px of clickable width.
    expect(css).toMatch(/\n\.find-toggle \{ width: 22px; height: 20px;/);
    expect(ruleOf('.find-field')).toMatch(/gap: 2px;/);
  });

  test('rows stacked edge to edge, and a path that truncates, get real height instead of a ring', () => {
    expect(read('app/src/renderer/src/components/FilesPanel.tsx')).toContain("'group flex min-h-6 w-full cursor-pointer");
    expect(read('app/src/renderer/src/components/TaskSidebar.tsx')).toContain('className="glass-row flex min-h-6 w-full cursor-pointer');
    expect(read('app/src/renderer/src/components/Inspector.tsx')).toContain('className="workbench-crumb min-h-6 min-w-0 flex-1');
  });
});

describe('item 38 — text a comfortable width, numbers that hold still, the code face only for code', () => {
  test('running text in a reply stops near 70 characters; code and tables keep the whole column', () => {
    // Measured in the built app: 66 characters a line in the owner's usual layout, 119 with the right panel closed,
    // 186 on a large window. Inter averages 0.478em a character, so 30–36em is 63–75 characters.
    const rule = /\.md :is\(([^)]*)\), \.md-text \{ max-width: (\d+(?:\.\d+)?)em; \}/.exec(css);
    expect(rule).not.toBeNull();
    const [, capped, em] = rule!;
    expect(Number(em)).toBeGreaterThanOrEqual(30);
    expect(Number(em)).toBeLessThanOrEqual(36);
    expect(capped.split(',').map((s) => s.trim()).sort()).toEqual(['.md-h', 'blockquote', 'ol', 'p', 'ul']);
    // What the rule reaches in a real reply: the prose is a <p>, the snippet a <pre> the rule does not name.
    const reply = renderToStaticMarkup(<Markdown text={'A sentence of prose.\n\n```ts\nconst a = 1;\n```'} />);
    expect(reply).toMatch(/^<div class="md"><p>A sentence of prose\.<\/p>/);
    expect(reply).toContain('<pre');
  });

  test('your own message wraps at the same width', () => {
    expect(read('app/src/renderer/src/components/Transcript.tsx')).toContain('max-w-[min(78%,calc(34em+32px))]');
  });

  test('times, percentages, counts and key badges use the interface face, with digits that hold their width', () => {
    const sidebar = read('app/src/renderer/src/components/TaskSidebar.tsx');
    expect(sidebar).toContain('<span className="shrink-0 text-[10px] text-faint tabular-nums">');
    expect(sidebar).toContain('<span className="glass-key shrink-0 rounded-[5px] px-1.5 py-px text-[9.5px] leading-[15px] tracking-tight">');
    expect(read('app/src/renderer/src/components/HomeView.tsx')).toContain('<span className="shrink-0 text-[10px] text-faint tabular-nums">{relTime(task.startedAt)}</span>');
    expect(read('app/src/renderer/src/components/Composer.tsx')).toContain("cn('shrink-0 text-[10px] tabular-nums', ctxPct >= 85");
    expect(read('app/src/renderer/src/components/ProjectWelcome.tsx')).toContain('<kbd className="glass-key shrink-0 rounded-md px-2 py-1 text-[13px] text-ink">{shortcut}</kbd>');
    expect(read('app/src/renderer/src/components/MachineHealthDialog.tsx')).toContain('text-[16px] font-semibold tabular-nums');
    for (const rule of ['.evidence-count', '.status-chip']) {
      expect(ruleOf(rule)).toContain('var(--font-sans)');
      expect(ruleOf(rule)).toContain('font-variant-numeric: tabular-nums;');
    }
    // The ⌘2 bar's footer counts a turn's seconds live.
    expect(ruleOf('.quick-footer')).toContain('font-variant-numeric: tabular-nums;');
  });
});

describe('items 27, 32, 36 — the motion ladder', () => {
  // `npm run check:morph` holds every flight to the ladder in the built app; these pin the CSS side of it.
  test('the most-pressed controls ease back in 120ms, with no bounce', () => {
    expect(ruleOf('.glass-pill')).toContain('transform 120ms ease-out;');
    expect(ruleOf('.glass-row')).toContain('transform 120ms ease-out;');
    expect(ruleOf('.pressable')).toContain('transition: transform 120ms ease-out,');
    for (const rule of ['.glass-pill', '.glass-row', '.pressable']) expect(ruleOf(rule)).not.toContain('bouncy');
  });
  test('the quick-settings flyout is a popover, so it takes the snappy curve, not the bounce', () => {
    expect(ruleOf('.glass-flyout')).toContain('animation: pop-in var(--dur-snappy) var(--ease-snappy) both;');
  });
  test('under Reduce Motion a driven surface does not move; it fades in', () => {
    expect(css).toContain('.morph-surface[data-reduced] { animation: fade-in 120ms ease-out both; }');
    expect(read('app/src/renderer/src/components/ui/morph/paint.ts')).toContain("surface.toggleAttribute?.('data-reduced', frame.reduced);");
  });
});

describe('item 42 — never status by colour alone', () => {
  test('every attention dot says so in words, to a screen reader and on hover', () => {
    const inspector = read('app/src/renderer/src/components/Inspector.tsx');
    expect(inspector.match(/rounded-full bg-amber" role="img" aria-label="Needs attention" title="Needs attention"/g)).toHaveLength(2);
    const sidebar = read('app/src/renderer/src/components/TaskSidebar.tsx');
    expect(sidebar).toMatch(/role="img"\s+aria-label="needs attention"\s+title="Needs attention"/);
  });
  test('no dot that is always on and means nothing', () => {
    expect(read('app/src/renderer/src/components/SettingsDialog.tsx')).not.toContain("(entry.id === 'environment' || entry.id === 'alchemist') ? <span");
  });
});
