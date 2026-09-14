import { DEFAULT_SHORTCUT, SHORTCUT_CHOICES, chosenShortcut, shortcutLabel, switchShortcut } from '../main/quick.shortcut';
import { trayTooltip } from '../main/thread.tray';

/**
 * Backlog N14: the ⌘2 bar's shortcut can be changed from the menu bar. A shortcut another app holds is refused, and the
 * bar keeps the one it had.
 */

function registry(takenElsewhere: string[] = []) {
  const held = new Set<string>();
  const calls: string[] = [];
  return {
    held,
    calls,
    register: (accelerator: string) => {
      calls.push(`register ${accelerator}`);
      if (takenElsewhere.includes(accelerator) || held.has(accelerator)) return false;
      held.add(accelerator);
      return true;
    },
    unregister: (accelerator: string) => {
      calls.push(`unregister ${accelerator}`);
      held.delete(accelerator);
    },
  };
}
const open = (): void => {};

test('a saved shortcut is used only when it is one of the offered choices, and every choice has a label', () => {
  expect(DEFAULT_SHORTCUT).toBe('CommandOrControl+2');
  expect(chosenShortcut('Alt+Space')).toBe('Alt+Space');
  expect(chosenShortcut('Command+Q')).toBe(DEFAULT_SHORTCUT);
  expect(chosenShortcut(undefined)).toBe(DEFAULT_SHORTCUT);
  expect(SHORTCUT_CHOICES.map((choice) => shortcutLabel(choice.accelerator))).toEqual(['⌘2', '⇧⌘2', '⌃⌥Space', '⌥Space']);
  expect(shortcutLabel('F13')).toBe('F13');
  expect(trayTooltip([], '⌥Space')).toBe('Bimax — no tasks running. Press ⌥Space anywhere to start one.');
  expect(trayTooltip([])).toBe('Bimax — no tasks running. Press ⌘2 anywhere to start one.');
});

test('switching releases the old shortcut and holds the new one; choosing the same one changes nothing', () => {
  const r = registry();
  expect(switchShortcut(r, null, DEFAULT_SHORTCUT, open)).toEqual({ ok: true, active: DEFAULT_SHORTCUT });
  expect(switchShortcut(r, DEFAULT_SHORTCUT, 'Alt+Space', open)).toEqual({ ok: true, active: 'Alt+Space' });
  expect([...r.held]).toEqual(['Alt+Space']);
  r.calls.length = 0;
  expect(switchShortcut(r, 'Alt+Space', 'Alt+Space', open)).toEqual({ ok: true, active: 'Alt+Space' });
  expect(r.calls).toEqual([]);
});

test('a shortcut another app holds is refused, and the bar keeps the one it had', () => {
  const r = registry(['Control+Alt+Space']);
  switchShortcut(r, null, DEFAULT_SHORTCUT, open);
  expect(switchShortcut(r, DEFAULT_SHORTCUT, 'Control+Alt+Space', open)).toEqual({ ok: false, active: DEFAULT_SHORTCUT });
  expect([...r.held]).toEqual([DEFAULT_SHORTCUT]);

  const taken = registry([DEFAULT_SHORTCUT]);
  expect(switchShortcut(taken, null, DEFAULT_SHORTCUT, open)).toEqual({ ok: false, active: null });
  expect(switchShortcut(taken, null, 'Alt+Space', open)).toEqual({ ok: true, active: 'Alt+Space' });
});
