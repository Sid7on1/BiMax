import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { composerOverflow, COMPOSER_MAX_HEIGHT, approvalLevel } from '../renderer/src/composer.model';
import { createHoverIntent, HOVER_CLOSE_DELAY_MS } from '../renderer/src/hover.intent';
import { AttachmentWell } from '../renderer/src/components/AttachmentWell';
import { QUICK_TOGGLES, toggleValue } from '../renderer/src/quick.settings';
import { visibleThreads, THREADS_PAGE } from '../renderer/src/threads.list.model';
import { CONFIG_WIRE_KEYS } from '../../../src/protocol/config.wire';
import { GATE_KEYS } from '../../../src/engine/gate.flags';

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
    expect(css).toContain('.sidebar-peek .sidebar-shell {\n  background: color-mix(in srgb, var(--glass-solid) 94%, transparent);\n}');
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
