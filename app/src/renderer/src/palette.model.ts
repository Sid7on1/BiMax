/** Frequent outcomes, shared by mouse rows and the palette's keyboard path (UI fix list 35). */
export const PALETTE_COMMANDS = [
  { id: 'new-thread', label: 'Start a new task', group: 'Task', shortcut: '⌘N' },
  { id: 'open-project', label: 'Open another project', group: 'Project', shortcut: '⌘O' },
  { id: 'review', label: 'Review changes', group: 'Evidence' },
  { id: 'github', label: 'GitHub — fetch, pull, push', group: 'Evidence' },
  { id: 'files', label: 'Browse files', group: 'Workspace' },
  { id: 'terminal', label: 'Open terminal', group: 'Workspace', shortcut: '⌘T' },
  { id: 'map', label: 'Explore code map', group: 'Workspace' },
  { id: 'memory', label: 'Open memory', group: 'Workspace' },
  { id: 'chats', label: 'Browse all chats', group: 'Task' },
  { id: 'settings', label: 'Open settings', group: 'App', shortcut: '⌘,' },
  { id: 'toggle-sidebar', label: 'Toggle sidebar', group: 'Layout', shortcut: '⌘B' },
  { id: 'toggle-panel', label: 'Toggle right panel', group: 'Layout', shortcut: '⌘J' },
  { id: 'toggle-wide', label: 'Expand or restore right panel', group: 'Layout' },
  { id: 'focus-composer', label: 'Write to Bimax', group: 'Task' },
  { id: 'stop-task', label: 'Stop the current task', group: 'Task', requires: 'busy' },
  { id: 'models', label: 'Choose models and reasoning effort', group: 'App' },
  { id: 'app-health', label: 'Open app health', group: 'App' },
  { id: 'moonlight', label: 'Use Moonlight appearance', group: 'Appearance' },
  { id: 'starlight', label: 'Use Starlight appearance', group: 'Appearance' },
  { id: 'appearance-auto', label: 'Match system appearance', group: 'Appearance' },
  { id: 'quick-bar', label: 'Open the floating bar', group: 'Task' },
  { id: 'find-file', label: 'Find and replace in this file', group: 'Editor', requires: 'editor', shortcut: '⌘F' },
  { id: 'close-file', label: 'Close this file tab', group: 'Editor', requires: 'editor', shortcut: '⌘W' },
  { id: 'next-file', label: 'Show next file tab', group: 'Editor', requires: 'files', shortcut: '⌃Tab' },
  { id: 'previous-file', label: 'Show previous file tab', group: 'Editor', requires: 'files', shortcut: '⌃⇧Tab' },
  { id: 'refresh-git', label: 'Refresh Git status', group: 'Evidence' },
] as const;
export type PaletteCommand = typeof PALETTE_COMMANDS[number]['id'];
export type PaletteAvailability = Record<'busy' | 'editor' | 'files', boolean>;
export interface PaletteEntry { id: PaletteCommand; label: string; group: string; shortcut?: string; disabled: boolean }

export function paletteEntries(query: string, available: PaletteAvailability): PaletteEntry[] {
  const needle = query.trim().toLowerCase();
  return PALETTE_COMMANDS.filter((entry) => `${entry.label} ${entry.group}`.toLowerCase().includes(needle))
    .map((entry) => ({ ...entry, disabled: 'requires' in entry && !available[entry.requires] }));
}
/** Skip unavailable outcomes; the empty list never selects −1 or executes a hidden command. */
export function movePaletteSelection(entries: readonly PaletteEntry[], current: number, delta: 1 | -1): number {
  for (let i = current + delta; i >= 0 && i < entries.length; i += delta) if (!entries[i].disabled) return i;
  return current;
}
export function firstPaletteSelection(entries: readonly PaletteEntry[]): number {
  const first = entries.findIndex((entry) => !entry.disabled);
  return first < 0 ? 0 : first;
}
