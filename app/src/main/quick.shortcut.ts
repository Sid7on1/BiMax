/**
 * The global shortcut that opens the ⌘2 bar (backlog N14). ⌘2 stays the default, but a global ⌘2 takes the key from
 * every app (a browser's second tab, Finder's list view), and another app may hold it first. So a short list of
 * alternatives is offered from the menu bar. Pure, so switching can be tested without Electron.
 */
export const DEFAULT_SHORTCUT = 'CommandOrControl+2';

export const SHORTCUT_CHOICES: ReadonlyArray<{ accelerator: string; label: string }> = [
  { accelerator: 'CommandOrControl+2', label: '⌘2' },
  { accelerator: 'CommandOrControl+Shift+2', label: '⇧⌘2' },
  { accelerator: 'Control+Alt+Space', label: '⌃⌥Space' },
  { accelerator: 'Alt+Space', label: '⌥Space' },
];

/** The saved choice when it is one of the offered shortcuts; anything else (a hand-edited setting) is the default. */
export function chosenShortcut(saved: unknown): string {
  return SHORTCUT_CHOICES.some((choice) => choice.accelerator === saved) ? (saved as string) : DEFAULT_SHORTCUT;
}

export function shortcutLabel(accelerator: string): string {
  return SHORTCUT_CHOICES.find((choice) => choice.accelerator === accelerator)?.label ?? accelerator;
}

export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/**
 * Move the bar's shortcut from `from` (null: none is registered) to `to`. When `to` cannot be registered, `from` is
 * registered again, so a refused choice never takes away the shortcut the bar had.
 */
export function switchShortcut(registry: ShortcutRegistry, from: string | null, to: string, open: () => void): { ok: boolean; active: string | null } {
  if (from === to) return { ok: true, active: to };
  if (from) registry.unregister(from);
  if (registry.register(to, open)) return { ok: true, active: to };
  if (from && registry.register(from, open)) return { ok: false, active: from };
  return { ok: false, active: null };
}
