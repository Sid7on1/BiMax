/**
 * The quick settings behind the sidebar's Settings row (fix list item 5).
 *
 * Hovering Settings used to open a "Machine" flyout with one row in it — App health — which the owner
 * asked to be removed: nobody hovers Settings to read diagnostics. It now holds the switches people
 * open Settings FOR, one hover deep. App health itself is still in Settings → Support.
 *
 * Every entry here must reach something live, or it is the decorative switch this list was written to
 * remove. `app/src/__tests__/quick.settings.test.ts` holds each one to that: the engine must accept the
 * key, and either the engine applies it (engine/gate.flags.ts) or the page does (motion.preference.ts,
 * the turn-finished sound in App.tsx).
 */
import type { EngineConfig } from './protocol';

export interface QuickToggle {
  key: 'reducedMotion' | 'notificationBell' | 'selfCritic' | 'autoVerify' | 'gitAutoCommit';
  label: string;
  /** One line, shown as the row's tooltip. */
  hint: string;
}

export const QUICK_TOGGLES: readonly QuickToggle[] = [
  { key: 'notificationBell', label: 'Sound when a task finishes', hint: 'A system sound when a reply finishes while Bimax is in the background' },
  { key: 'selfCritic', label: 'Check work before replying', hint: 'Bimax reviews each result against your request and fixes what it finds (costs extra tokens)' },
  { key: 'autoVerify', label: 'Typecheck after edits', hint: 'After an edit to a JS or TS file, run the checker and show Bimax any error it caused' },
  { key: 'gitAutoCommit', label: 'Commit each edit', hint: 'Commit every file Bimax edits, one commit per edit, in a Git project' },
  { key: 'reducedMotion', label: 'Reduce motion', hint: 'Quiet fades instead of moving panels, throughout Bimax' },
];

/** A toggle's state as the config reports it. Unset is off — every one of these defaults to off. */
export function toggleValue(config: EngineConfig | null, key: QuickToggle['key']): boolean {
  return Boolean(config?.[key]);
}
