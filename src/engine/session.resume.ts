import type { Message } from '../core/llm.provider';
import { ContinuationState, type Archiver } from '../context/continuation';
import { parseTodoArgs, type TodoItem } from '../tools/implementations/todo.tool';
import type { MessageEntry } from './events';
import { foldEntries } from './session';

/**
 * A saved task's state, rebuilt from its transcript when it resumes (backlog F2, first version).
 *
 * Every resume — the sidebar, the boot revival after an engine crash, a model switch that restarts the engine — goes
 * through `/resume`, which kept the newest messages live and dropped the rest. On a long task that dropped the user's
 * request, every constraint stated early, the commands already run, and the checklist: the task came back as whatever
 * its last forty messages said, while the same task running without a restart kept all of it through compaction.
 *
 * The transcript already records all of it, so nothing new is saved: the task's state is derived from the file every
 * time, and cannot disagree with it.
 * - The messages before the live window go through the same continuation state compaction uses (record 50 step 6): the
 *   user's words quoted exactly, the first one always kept; commands with the exit status the engine saw; the
 *   assistant's outcome sentences labelled as claims. The block leads the restored history, and the engine's context
 *   manager adopts it before its first compaction, exactly as it does after a model switch (step 8).
 * - The checklist is the last TodoWriteTool call that succeeded, retired when every item was complete — which is what
 *   the live list would have been.
 * The live window itself is unchanged: the same newest messages a resume always showed.
 */

/** How many messages a resume keeps live. */
export const RESUME_WINDOW = 40;

export interface ResumedTask {
  /** The history to restore: the continuation block when earlier messages were left out, then the live window. */
  messages: Message[];
  /** How many messages were left out of the live window and carried by the continuation block instead. */
  carried: number;
  /** The checklist as the task last wrote it; empty when it had none or had finished it. */
  todos: TodoItem[];
}

interface SavedToolCall { id?: string; toolName?: string; input?: string; output?: string; status?: string; parentId?: string }

export function resumeTaskState(entries: MessageEntry[], archive: Archiver, window = RESUME_WINDOW): ResumedTask {
  const folded = foldEntries(entries);
  const start = Math.max(0, folded.length - window);
  const live = folded.slice(start).map((item) => item.message);
  const todos = lastChecklist(entries);
  if (start === 0) return { messages: live, carried: 0, todos };

  const state = new ContinuationState();
  state.absorb(continuationInput(entries.slice(0, folded[start].from)), archive);
  const block = state.render(archive);
  return { messages: block ? [{ role: 'system', content: block }, ...live] : live, carried: start, todos };
}

/**
 * Saved entries as the messages the continuation state reads, each tool call paired with its result. A sub-agent's
 * calls are left out: the live state only ever sees the main loop's, and a worker's commands are its own report.
 */
function continuationInput(entries: MessageEntry[]): Message[] {
  const out: Message[] = [];
  const toolPair = (call: SavedToolCall, index: number): void => {
    const id = call.id || `saved-${index}`;
    out.push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: call.toolName ?? '', arguments: call.input ?? '' } }] } as Message);
    out.push({ role: 'tool', tool_call_id: id, content: String(call.output ?? '') } as Message);
  };
  entries.forEach((entry, index) => {
    const saved = entry as unknown as SavedToolCall & { role: string };
    if (saved.role === 'tool') { if (!saved.parentId) toolPair(saved, index); return; }
    if (entry.role !== 'user' && entry.role !== 'assistant') return;
    if (typeof entry.content === 'string' && entry.content.trim()) out.push({ role: entry.role, content: entry.content });
    (entry.toolCalls ?? []).forEach((call, n) => { if (!call.parentId) toolPair(call, index * 1000 + n); });
  });
  return out;
}

/** The last checklist a TodoWriteTool call wrote, or nothing when there was none or every item was complete. */
function lastChecklist(entries: MessageEntry[]): TodoItem[] {
  const calls: SavedToolCall[] = [];
  for (const entry of entries) {
    const saved = entry as unknown as SavedToolCall & { role: string };
    if (saved.role === 'tool') calls.push(saved);
    else calls.push(...(entry.toolCalls ?? []));
  }
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    // A sub-agent's list is its own, not the task's.
    if (call.toolName !== 'TodoWriteTool' || call.status === 'error' || call.parentId) continue;
    let args: unknown;
    try { args = JSON.parse(call.input ?? ''); } catch { continue; }
    const todos = parseTodoArgs(args);
    return todos.every((todo) => todo.status === 'completed') ? [] : todos;
  }
  return [];
}
