import type { TranscriptItem } from './engine.state';
import type { ReviewSnapshot, ToolCallEntry } from './protocol';
import { runSummary } from './run.summary.model';

export interface TaskProgressInput {
  items: TranscriptItem[]; review: ReviewSnapshot | null; busy: boolean; streaming: boolean;
  pendingInput: boolean; stopRequested: boolean; awaitingReply: boolean; engineState: string;
  status: string; todos: { content?: string; status?: string }[];
}
export interface TaskProgressView {
  goal: string; step: string; files: string[]; next: string;
  state: 'ready' | 'pending' | 'working' | 'checking' | 'needs-you' | 'stopping' | 'failed' | 'done';
}

function subject(call: ToolCallEntry): string {
  try {
    const args = JSON.parse(call.input);
    for (const key of ['command', 'cmd', 'file_path', 'path', 'file', 'query', 'pattern']) {
      if (typeof args?.[key] === 'string') return args[key].replace(/\s+/g, ' ').trim();
    }
  } catch { /* tool rows also accept a plain command/path */ }
  return call.input.replace(/\s+/g, ' ').trim();
}
// Describe a check only while that exact command is actually running. This is activity, never a
// verification verdict: the engine's scoped evidence decides the ending through runSummary.
const CHECK_COMMAND = /^(?:npm|pnpm|yarn|bun)\s+(?:(?:run\s+)?(?:test(?::[\w-]+)?|build|check(?::[\w-]+)?)\b)|^(?:npx\s+(?:jest|vitest|tsc)\b|(?:pytest|cargo\s+(?:test|check)|go\s+test)\b)/;
function activity(call: ToolCallEntry, changed: boolean): { text: string; checking: boolean } {
  const target = subject(call);
  const shell = /bash|shell|terminal|command/i.test(call.toolName);
  const checking = changed && shell && CHECK_COMMAND.test(target);
  const verb = checking ? 'Checking changes' : shell ? 'Running' : /edit|patch/i.test(call.toolName) ? 'Editing'
    : /write/i.test(call.toolName) ? 'Writing' : /read/i.test(call.toolName) ? 'Reading'
    : /search|grep|glob|find/i.test(call.toolName) ? 'Searching' : 'Working';
  return { text: target ? `${verb} · ${target}` : verb, checking };
}

/** Four current chunks; session history can never stand in for the latest run's evidence. */
export function taskProgress(input: TaskProgressInput): TaskProgressView {
  let start = -1;
  for (let i = input.items.length - 1; i >= 0; i--) {
    if (input.items[i].kind === 'msg' && (input.items[i] as Extract<TranscriptItem, { kind: 'msg' }>).msg.role === 'user') { start = i; break; }
  }
  const user = start < 0 ? null : (input.items[start] as Extract<TranscriptItem, { kind: 'msg' }>).msg;
  const at = user ? Date.parse(user.timestamp) : NaN;
  const files = Number.isFinite(at) ? input.review?.changes.filter(change => change.lastAt >= at).map(change => change.file) ?? [] : [];
  const base = { goal: user?.content.trim() || 'Start a task', files };
  const view = (state: TaskProgressView['state'], step: string, next: string): TaskProgressView => ({ ...base, state, step, next });
  if (input.engineState === 'exited' || input.engineState === 'failed') return view('failed', 'Bimax unavailable', 'Open support');
  if (input.awaitingReply || (input.review?.state === 'awaiting_approval' && input.review.updatedAt >= at)) return view('needs-you', 'Needs you', 'Answer the open question');
  if (input.stopRequested) return view('stopping', 'Stopping', 'Waiting for Bimax to stop');
  if (input.pendingInput) return view('pending', 'Sent · waiting for Bimax', 'Bimax will start when ready');
  if (input.busy || input.streaming) {
    const running = input.items.slice(start + 1).filter((item): item is Extract<TranscriptItem, { kind: 'tool' }> => item.kind === 'tool' && item.call.status === 'running').at(-1);
    if (running) {
      const active = activity(running.call, files.length > 0);
      return view(active.checking ? 'checking' : 'working', active.text, 'Waiting for the result');
    }
    const todo = input.todos.find(todo => todo.status === 'in_progress');
    return view('working', input.status || todo?.content || 'Working', 'Waiting for Bimax’s result');
  }
  const ending = runSummary(input.items, input.review, false);
  if (ending) {
    if (ending.verdict === 'failed') return view('failed', 'Check failed', 'Review the failed check');
    if (ending.verdict === 'unchecked') return view('done', 'Finished · not checked', 'Review and check the changes');
    if (ending.verdict === 'stopped') return view('done', 'Stopped', 'Review what changed');
    return view('done', ending.verdict === 'verified' ? 'Checks passed' : 'Finished', 'Review changes');
  }
  return view('ready', 'Ready', user ? 'Write the next instruction' : 'Write an instruction');
}
