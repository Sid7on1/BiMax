import type { ToolCallEntry } from './events';

// A small global ring buffer of recently-completed tool calls (with their FULL output). The
// transcript truncates long tool output (and lives in Ink's write-once <Static>, so it can't be
// expanded in place), which leaves users with "truncation regret". This buffer captures the
// untruncated output as each tool finishes so the /output viewer can show any recent call in full,
// without re-rendering committed history. Bounded so a long session can't grow it without limit.

const MAX = 50;
const buffer: ToolCallEntry[] = [];

/** Record a finished tool call (update in place if the same id was already captured). */
export function recordToolCall(entry: ToolCallEntry): void {
  if (!entry || !entry.id) return;
  const idx = buffer.findIndex(e => e.id === entry.id);
  if (idx !== -1) buffer[idx] = entry;
  else {
    buffer.push(entry);
    if (buffer.length > MAX) buffer.shift();
  }
}

/** Recent tool calls, most-recent first. */
export function getRecentToolCalls(): ToolCallEntry[] {
  return [...buffer].reverse();
}

/** Test/`/clear` hook. */
export function clearToolHistory(): void {
  buffer.length = 0;
}
