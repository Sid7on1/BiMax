import React from 'react';
import type { JsonValue } from '../renderer/src/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { taskProgress, type TaskProgressInput } from '../renderer/src/task.progress.model';
import { TaskProgress } from '../renderer/src/components/TaskProgress';
const at = Date.parse('2026-10-01T10:00:00Z');
const user = { kind: 'msg', msg: { id: 'u', role: 'user', content: 'Fix the fetch client', timestamp: new Date(at).toISOString() } } as const;
const review = { sessionId: 's', state: 'unverified', nextAction: '', approvals: [], changes: [{ file: 'src/retry.ts', lastAt: at + 1000, edits: 1, tools: ['Edit'] }], verifications: [], checkpoints: [], lastCheckpoint: null, todos: [], interrupted: false, updatedAt: at + 1000 } as const;
const base = { items: [user], review, busy: false, streaming: false, pendingInput: false, stopRequested: false, awaitingReply: false, engineState: 'ready', status: '', todos: [] } as unknown as TaskProgressInput;
const tool = (command: string, status = 'running') => ({ kind: 'tool', call: { id: 't', toolName: 'Bash', input: command, output: '', status, startTime: new Date(at + 2000).toISOString() } });

test('all four chunks survive an empty task and remain outside scrollback', () => {
  const value = taskProgress({ ...base, items: [], review: null });
  expect(value).toEqual({ state: 'ready', goal: 'Start a task', step: 'Ready', files: [], next: 'Write an instruction' });
  const html = renderToStaticMarkup(<TaskProgress value={value} onReview={() => {}} />);
  for (const label of ['Goal', 'Step', 'Files', 'Next']) expect(html).toContain(`>${label}</dt>`);
  expect(html).toContain('shrink-0');
});
test('pending acknowledgement, question and Stop outrank stale work', () => {
  expect(taskProgress({ ...base, pendingInput: true }).state).toBe('pending');
  expect(taskProgress({ ...base, busy: true, awaitingReply: true, stopRequested: true }).state).toBe('needs-you');
  expect(taskProgress({ ...base, busy: true, stopRequested: true }).step).toBe('Stopping');
  expect(taskProgress({ ...base, pendingInput: true, engineState: 'exited' }).step).toBe('Bimax unavailable');
});
test('a new goal excludes the previous run’s files and running tools', () => {
  const newer = { ...user, msg: { ...user.msg, id: 'u2', content: 'Explain the change', timestamp: new Date(at + 9000).toISOString() } };
  const value = taskProgress({ ...base, items: [user, tool('npm test'), newer] as never, busy: true, todos: [] });
  expect(value.goal).toBe('Explain the change');
  expect(value.files).toEqual([]);
  expect(value.step).toBe('Working');
});
test('checking is a live command after actual changes, never a decorative delay or a proof claim', () => {
  const input = { ...base, busy: true, items: [user, tool('{"command":"npm test"}')] as never };
  expect(taskProgress(input)).toMatchObject({ state: 'checking', step: 'Checking changes · npm test' });
  expect(taskProgress({ ...input, review: null }).state).toBe('working');
  expect(taskProgress({ ...input, items: [user, tool('echo npm test')] as never }).state).toBe('working');
  expect(taskProgress({ ...input, items: [user, tool('npm test', 'success')] as never }).state).toBe('working');
  expect(taskProgress({ ...input, busy: false }).step).toBe('Finished · not checked');
});
test('the ending uses scoped verification; a completed answer never invents passed checks', () => {
  expect(taskProgress(base).step).toBe('Finished · not checked');
  const verified = { ...base, review: { ...base.review!, verifications: [{ command: 'npm test', ok: true, at: at + 2000, coveredFiles: [], repoWide: true, settled: 1 }] } };
  expect(taskProgress(verified).step).toBe('Checks passed');
  expect(taskProgress({ ...verified, review: { ...verified.review, changes: [{ ...verified.review.changes[0], lastAt: at + 3000 }] } }).step).toBe('Finished · not checked');
});

import { engineReducer, initialEngineState } from '../renderer/src/engine.state';
const event = (name: string, ...args: JsonValue[]) => ({ type: 'outbound', msg: { t: 'event', name, args } } as const);
test('sending acknowledges locally without claiming the engine is running, and drops the old plan/status', () => {
  const sent = engineReducer({ ...initialEngineState, todos: [{ content: 'Old plan', status: 'in_progress' }], status: 'Old retry' }, { type: 'localUser', text: 'New goal' });
  expect(sent.pendingInput).toBe(true);
  expect(sent.spinner.state).toBe('idle');
  expect(sent.todos).toEqual([]);
  expect(sent.status).toBe('');
  expect(engineReducer(sent, event('stream_token', 'hello')).pendingInput).toBe(false);
});
test('Stop acknowledges locally but only an actual idle or failed engine ends it', () => {
  const working = engineReducer(initialEngineState, event('spinner_state', 'working'));
  const stopping = engineReducer(working, { type: 'interruptRequested' });
  expect(stopping.stopRequested).toBe(true);
  expect(stopping.spinner.state).toBe('working');
  expect(engineReducer(stopping, event('spinner_state', 'working')).stopRequested).toBe(true);
  expect(engineReducer(stopping, event('spinner_state', 'idle')).stopRequested).toBe(false);
  expect(engineReducer(stopping, { type: 'engineState', state: 'exited', detail: 'crash' }).stopRequested).toBe(false);
});
test('clear, restored history and a different project never inherit a pending acknowledgement', () => {
  const pending = { ...initialEngineState, pendingInput: true, stopRequested: true };
  for (const action of [event('clear'), event('session_restore', { entries: [] }), { type: 'project', dir: '/new' } as const]) {
    expect(engineReducer(pending, action)).toMatchObject({ pendingInput: false, stopRequested: false });
  }
});
