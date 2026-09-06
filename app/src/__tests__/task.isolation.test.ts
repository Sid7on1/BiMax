/**
 * Task isolation: nothing from a finished task may appear in the next one.
 *
 * Reported from a live session — a brand-new task rendered the PREVIOUS task's `find` and `Deleted`
 * tool lines and its half-written assistant sentence. Two independent causes, both in the `clear`
 * path of the engine reducer:
 *
 *   1. `/clear force` empties the transcript instantly, but the engine turn that was already
 *      running does not stop. Its remaining `stream_token` / `thinking` / `tool_call` /
 *      `tool_call_result` events keep arriving, and every one of those reducer cases appends
 *      unconditionally — straight into the fresh transcript. `upsertTool` compounded it: a result
 *      whose originating call had just been wiped matches nothing, so it appends as a NEW item,
 *      which is why completed tool lines from the old task showed up in the new one.
 *
 *   2. `clear` reset only `items`/`streaming`/`thinking`/`streamedChars`. Every other per-task
 *      field survived: the todo list, sub-agent claims, the review lane, a stale spinner and status,
 *      and `request` — a pending APPROVAL MODAL belonging to the discarded turn, left on screen.
 *
 * Each test ends with the mutation it exists to catch, per `08_ACCEPTANCE_GATES.md`.
 */
import { engineReducer, initialEngineState, type EngineUiState } from '../renderer/src/engine.state';

/** Feed one engine event through the reducer the way the IPC bridge does. */
const event = (state: EngineUiState, name: string, ...args: unknown[]): EngineUiState =>
  engineReducer(state, { type: 'outbound', msg: { t: 'event', name, args } as never });

const toolCall = (id: string, toolName: string, output: string) => ({
  id, toolName, input: '{}', output, status: 'success', startTime: '2026-09-04T00:00:00Z',
});

/** A task mid-flight: a user turn, a completed tool call, an open stream, todos and a live request. */
function busyTask(): EngineUiState {
  let s = engineReducer(initialEngineState, { type: 'localUser', text: 'delete the pptx files' });
  s = event(s, 'tool_call', toolCall('t1', 'BashTool', 'find /Users/x -name "*.pptx"'));
  s = event(s, 'stream_token', 'The governor blocked the deletion of that file. Let me ');
  s = event(s, 'todo_update', [{ content: 'find every pptx', status: 'in_progress' }]);
  return s;
}

describe('a cleared task leaves nothing behind', () => {
  it('drops in-flight events from the discarded turn instead of appending them to the new task', () => {
    let s = busyTask();
    s = event(s, 'clear');
    expect(s.items).toHaveLength(0);

    // Everything below was already on the wire when the clear landed.
    s = event(s, 'stream_token', 'check what is in the .breakglass directory');
    s = event(s, 'thinking', 'the user asked me to keep looking');
    s = event(s, 'tool_call_result', toolCall('t1', 'BashTool', 'Deleted snakes_presentation.pptx'));
    s = event(s, 'tool_call', toolCall('t2', 'BashTool', 'ls -la .breakglass/backups/'));
    s = event(s, 'message', { id: 'm9', role: 'assistant', content: 'Let me check the backups.', timestamp: '' });

    expect(s.items).toEqual([]);
    expect(s.streaming).toBe('');
    expect(s.thinking).toBe('');
    // Mutant: dropping the `awaitingNewTurn` guard at the top of onEvent re-appends all five.
  });

  it('resets every per-task field, not just the transcript', () => {
    let s = busyTask();
    s = event(s, 'subagent_update', [{ id: 'a1', label: 'scout' }]);
    s = event(s, 'spinner_state', 'working', 'deleting files');
    s = event(s, 'status', 'running BashTool');
    s = engineReducer(s, { type: 'outbound', msg: { t: 'request', id: 7, kind: 'approval', text: 'delete file?' } as never });
    expect(s.request).not.toBeNull();

    s = event(s, 'clear');

    expect(s.todos).toEqual([]);
    expect(s.subagents).toEqual([]);
    expect(s.review).toBeNull();
    expect(s.spinner).toEqual({ state: 'idle', message: '' });
    expect(s.status).toBe('');
    // The safety one: an approval modal for a discarded turn must never survive into the new task.
    expect(s.request).toBeNull();
    // Mutant: restoring the old one-line `clear` case leaves all six populated.
  });

  it('keeps session-level state across a clear — the workspace did not change', () => {
    let s = engineReducer(initialEngineState, { type: 'project', dir: '/Users/x/proj' });
    s = engineReducer(s, { type: 'engineState', state: 'ready', detail: '' });
    s = event(s, 'mode_change', 'plan');
    s = event(s, 'log', { text: 'engine started', level: 'info' });

    s = event(s, 'clear');

    expect(s.project).toBe('/Users/x/proj');
    expect(s.engine.state).toBe('ready');
    expect(s.mode).toBe('plan');
    expect(s.diagnostics).toHaveLength(1);
    // Mutant: clearing to `initialEngineState` wholesale blanks the workspace identity too.
  });

  it('lets the NEXT real turn through — the fence is not a permanent mute', () => {
    let s = event(busyTask(), 'clear');
    s = engineReducer(s, { type: 'localUser', text: 'now summarise the repo' });

    s = event(s, 'stream_token', 'Reading the repository');
    s = event(s, 'tool_call', toolCall('t9', 'ReadFileTool', 'package.json'));

    expect(s.streaming).toBe('Reading the repository');
    expect(s.items.filter((i) => i.kind === 'tool')).toHaveLength(1);
    // Mutant: never lifting `awaitingNewTurn` silently blanks every task after the first clear.
  });

  it('lets a palette command through after a clear', () => {
    // `/mode plan` issued straight after a new task is a real interaction; its output must render.
    let s = event(busyTask(), 'clear');
    s = engineReducer(s, { type: 'turnStarted' });
    s = event(s, 'message', { id: 'm1', role: 'assistant', content: 'Mode set to plan.', timestamp: '' });
    expect(s.items).toHaveLength(1);
    // Mutant: omitting the dispatch in sendCommand swallows every chrome-command reply after a clear.
  });

  it('a restored session is a current transcript, not a fenced one', () => {
    let s = event(busyTask(), 'clear');
    s = event(s, 'session_restore', {
      id: 'sess-1',
      entries: [{ role: 'user', id: 'u1', content: 'earlier question', timestamp: '' }],
    });
    expect(s.items).toHaveLength(1);

    s = event(s, 'stream_token', 'continuing the restored thread');
    expect(s.streaming).toBe('continuing the restored thread');
    // Mutant: leaving the fence armed through session_restore makes every resumed session mute.
  });
});
