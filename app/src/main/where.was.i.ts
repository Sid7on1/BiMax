import type { TranscriptItem } from '../renderer/src/engine.state';

/**
 * "Where was I?" (backlog FL7). The person leaves themselves a bookmark on a task — a line in their own words — and
 * when they come back to it, Bimax says what happened since: the changes the task made, what it said, the files
 * that arrived in its folder, and what is still open on its checklist. First version: an explicit bookmark, never
 * inferred.
 */

export interface Bookmark { note: string; at: number }
export interface WhereWasI { note: string; at: number; since: string[]; open: string[] }

/** A bookmark as saved: one line in the person's words, capped. */
export function cleanBookmark(raw: unknown, now: number): Bookmark | null {
  const note = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return note ? { note, at: now } : null;
}

/** The checklist items the task has not finished: from its last successful TodoWriteTool call. */
export function openTodos(items: readonly TranscriptItem[]): string[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind !== 'tool' || item.call.toolName !== 'TodoWriteTool' || item.call.status !== 'success' || item.call.parentId) continue;
    try {
      const todos = (JSON.parse(String(item.call.input)) as { todos?: Array<{ content?: unknown; status?: unknown }> }).todos ?? [];
      return todos.filter((t) => t.status !== 'completed' && typeof t.content === 'string').map((t) => String(t.content)).slice(0, 10);
    } catch {
      return [];
    }
  }
  return [];
}

/** What happened since the bookmark, in plain lines, and what is still open. */
export function whereWasI(input: {
  bookmark: Bookmark;
  items: readonly TranscriptItem[];
  changes: ReadonlyArray<{ title: string; at: number }>;
  arrivals: readonly string[];
}): WhereWasI {
  const { bookmark } = input;
  const since: string[] = [];
  const changes = input.changes.filter((c) => c.at > bookmark.at);
  if (changes.length) since.push(`${changes.length} change${changes.length === 1 ? '' : 's'}: ${changes.slice(-3).map((c) => c.title).join('; ')}${changes.length > 3 ? '…' : ''}`);
  const said = input.items.filter((item) => item.kind === 'msg' && item.msg.role === 'assistant' && (Date.parse(String(item.msg.timestamp)) || 0) > bookmark.at);
  if (said.length) {
    const last = said[said.length - 1]!;
    const text = last.kind === 'msg' ? last.msg.content.replace(/\s+/g, ' ').trim() : '';
    since.push(`${said.length} answer${said.length === 1 ? '' : 's'}; the last: “${text.length > 160 ? `${text.slice(0, 159)}…` : text}”`);
  }
  if (input.arrivals.length) since.push(`${input.arrivals.length} new file${input.arrivals.length === 1 ? '' : 's'} in the folder: ${input.arrivals.slice(0, 5).join(', ')}${input.arrivals.length > 5 ? '…' : ''}`);
  return { note: bookmark.note, at: bookmark.at, since, open: openTodos(input.items) };
}

/** Files directly in the folder that appeared after the bookmark (by creation time), newest first, at most 20. */
export function arrivalsSince(entries: ReadonlyArray<{ name: string; born: number; isFile: boolean }>, at: number): string[] {
  return entries.filter((e) => e.isFile && e.born > at && !e.name.startsWith('.')).sort((a, b) => b.born - a.born).slice(0, 20).map((e) => e.name);
}
