import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { engineEvents } from '../../engine/events';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const STATUS_ICON: Record<TodoItem['status'], string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
};

// The most recent todo list the agent wrote. Kept DURABLE across turns: it is the model's own task
// memory, re-injected into the system prompt every turn (see getTodoPromptBlock) so the checklist
// survives context compaction — the model must never forget its own phases mid-task. It is replaced
// only when TodoWriteTool writes a fresh list, or wiped on a hard reset (/clear).
let lastTodos: TodoItem[] = [];
// Did THIS turn touch the list? The loop's persistence auto-continue keys off this so it only fires
// when the model is actively working a checklist — a stray "thanks" after a task with open items
// must not force a continue.
let touchedThisTurn = false;

export function getActiveTodos(): TodoItem[] { return lastTodos; }
export function todosTouchedThisTurn(): boolean { return touchedThisTurn; }
/** Turn boundary: reset the per-turn touched flag but KEEP the list (it's persistent task memory). */
export function beginTodoTurn(): void { touchedThisTurn = false; }
/** Hard reset (new session / cleared history): forget the list entirely. */
export function clearActiveTodos(): void { lastTodos = []; touchedThisTurn = false; }

/**
 * Turn-end cleanup: once every item is completed the task is DONE, so retire the list — otherwise a
 * finished checklist lingers forever (re-injected into the prompt and pinned in the TUI) until the
 * next /clear. Clears the UI panel too. No-op while any item is still open (that must survive to the
 * next turn as task memory).
 */
export function retireCompletedTodos(): void {
  if (lastTodos.length > 0 && lastTodos.every(t => t.status === 'completed')) {
    lastTodos = [];
    touchedThisTurn = false;
    try { engineEvents.emit('todo_update', []); } catch { /* best-effort */ }
  }
}

export function renderTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return 'Todo list is empty.';
  const done = todos.filter(t => t.status === 'completed').length;
  const lines = todos.map(t => `${STATUS_ICON[t.status]} ${t.content}`);
  return `Tasks (${done}/${todos.length} done):\n${lines.join('\n')}`;
}

/**
 * The live task checklist formatted for injection into the system prompt EVERY turn. This is the fix
 * for "what phases are you talking about?": the list is otherwise UI-only state that the model loses
 * as soon as the creating turn is compacted out of history. Empty when there's no list at all.
 */
export function getTodoPromptBlock(): string {
  if (lastTodos.length === 0) return '';
  const done = lastTodos.filter(t => t.status === 'completed').length;
  const allDone = done === lastTodos.length;
  const lines = lastTodos.map(t => `${STATUS_ICON[t.status]} ${t.content}`);
  const header = allDone
    ? `### CURRENT TASK LIST — COMPLETE (${done}/${lastTodos.length} done)`
    : `### CURRENT TASK LIST (${done}/${lastTodos.length} done) — your checklist for the work in progress`;
  return `${header}\nThis is authoritative for what you are doing and what remains. If the user asks about progress, "the phases", "the tasks", or "the plan", answer from THIS list — never say you don't know what they mean. Keep it live with TodoWriteTool as statuses change.\n${lines.join('\n')}`;
}

export const createTodoWriteTool = (governor: IGovernor) => buildTool({
  name: 'TodoWriteTool',
  description: `Maintains a structured task checklist for the current session. Use it for any multi-step work (3+ steps) so the user can see progress at a glance.

# Instructions
- Pass the FULL list every time — this replaces the previous list, it does not append.
- Keep exactly ONE task \`in_progress\` at a time.
- Mark a task \`completed\` IMMEDIATELY after finishing it; don't batch completions.
- Statuses: \`pending\`, \`in_progress\`, \`completed\`.`,
  isDestructive: false,
  isConcurrencySafe: true,
  schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete, updated todo list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Imperative description of the task.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  execute: async (args: { todos: TodoItem[] }) => {
    const todos = (args.todos || []).filter(
      (t): t is TodoItem =>
        !!t && typeof t.content === 'string' && t.content.trim().length > 0 &&
        (t.status === 'pending' || t.status === 'in_progress' || t.status === 'completed'),
    );


    lastTodos = todos;      // durable: re-injected into the prompt every turn (task memory)
    touchedThisTurn = true; // this turn is actively working a checklist → persistence may auto-continue
    // Push to the UI: full list into app state, compact progress into the status bar.
    engineEvents.emit('todo_update', todos);
    const done = todos.filter(t => t.status === 'completed').length;
    const current = todos.find(t => t.status === 'in_progress');
    if (todos.length > 0) {
      engineEvents.emit('status', `Tasks: ${done}/${todos.length} done${current ? ` · now: ${current.content.slice(0, 50)}` : ''}`);
    }

    return renderTodoList(todos);
  },
}, governor);
