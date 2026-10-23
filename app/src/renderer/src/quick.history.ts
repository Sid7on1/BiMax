/**
 * Prompt history for the ⌘2 bar: ↑ recalls earlier prompts, ↓ walks back to what was being typed. Kept per machine
 * in localStorage — a convenience, not data — newest last, at most 50, without repeats.
 */
const KEY = 'bimax:quick-history';
const LIMIT = 50;

export function loadHistory(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(-LIMIT) : [];
  } catch {
    return [];
  }
}

export function remember(history: readonly string[], prompt: string): string[] {
  const text = prompt.trim();
  if (!text) return [...history];
  const next = [...history.filter((entry) => entry !== text), text].slice(-LIMIT);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private window or no storage */ }
  return next;
}

/**
 * One step through the history. `cursor` is null while typing fresh text, otherwise an index into `history`.
 * Returns the new cursor and the text to show — the saved draft once stepping past the newest entry.
 */
export function stepHistory(
  history: readonly string[],
  cursor: number | null,
  direction: 'back' | 'forward',
  draft: string,
): { cursor: number | null; text: string } {
  if (!history.length) return { cursor: null, text: draft };
  if (direction === 'back') {
    const next = cursor === null ? history.length - 1 : Math.max(0, cursor - 1);
    return { cursor: next, text: history[next] };
  }
  if (cursor === null) return { cursor: null, text: draft };
  const next = cursor + 1;
  return next >= history.length ? { cursor: null, text: draft } : { cursor: next, text: history[next] };
}
