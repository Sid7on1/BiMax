const mockPlan = { automatic: true, reason: '', sessionId: 'old-session', agents: [{ id: 'a1' }] };
jest.mock('../core/agent.checkpoint', () => ({
  crashedAgents: () => [{ id: 'a1' }],
  planAutomaticRecovery: () => mockPlan,
}));

import { engineEvents } from '../engine/events';
import { startHeartbeat } from '../protocol/headless.heartbeat';
import { startAssignmentRecovery } from '../protocol/headless.recovery';
import { startOutcomeContinuation } from '../protocol/headless.continuation';
import { startIndexOnboarding } from '../protocol/headless.onboarding';

/**
 * The parts of the engine's session that were split out of the 750-line startHeadless (flaw list C19). verify-engine
 * boots the real bundle through all of them; these pin what each promises on its own, and that each one stops.
 */

const statuses = () => {
  const seen: string[] = [];
  const on = (text: string) => seen.push(text);
  engineEvents.on('status', on);
  return { seen, stop: () => engineEvents.off('status', on) };
};

test('the heartbeat beats at once (the hang watchdog arms on the first), reports a busy turn, and stops', () => {
  jest.useFakeTimers();
  try {
    const sent: any[] = [];
    let busy = true;
    const stop = startHeartbeat((m) => sent.push(m), () => busy, { BIMAX_HEARTBEAT_MS: '1000' } as any);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(expect.objectContaining({ t: 'health', activeTurn: true, phase: 'ready' }));
    busy = false;
    jest.advanceTimersByTime(1000);
    expect(sent[1]).toEqual(expect.objectContaining({ activeTurn: false }));
    stop();
    jest.advanceTimersByTime(5000);
    expect(sent).toHaveLength(2);
    expect(startHeartbeat((m) => sent.push(m), () => false, { BIMAX_HEARTBEAT_MS: '0' } as any)).toBeInstanceOf(Function);
    expect(sent).toHaveLength(2);
  } finally {
    jest.useRealTimers();
  }
});

test('recovery never moves a fresh session onto an old crashed one; it says how to recover instead', async () => {
  const dispatched: string[] = [];
  const session = { isBusy: false, dispatch: async (t: string) => { dispatched.push(t); } } as any;
  const outcomeManager = { activeSessionId: () => '' } as any;
  const log = statuses();
  const stop = startAssignmentRecovery({ session, outcomeManager, config: {} });
  engineEvents.emit('agent_recovery_available');
  await new Promise((r) => setImmediate(r));
  expect(dispatched).toEqual([]);
  expect(log.seen.join('\n')).toMatch(/run \/resume old-session then \/subagents resume/);
  stop();
  engineEvents.emit('agent_recovery_available');
  await new Promise((r) => setImmediate(r));
  expect(log.seen.filter((s) => s.includes('old-session'))).toHaveLength(1); // stopped: no second answer
  log.stop();
});

test('recovery in the crashed session itself resumes it, then its assignments', async () => {
  const dispatched: string[] = [];
  const session = { isBusy: false, dispatch: async (t: string) => { dispatched.push(t); } } as any;
  const stop = startAssignmentRecovery({ session, outcomeManager: { activeSessionId: () => 'old-session' } as any, config: {} });
  engineEvents.emit('agent_recovery_available');
  await new Promise((r) => setTimeout(r, 10));
  expect(dispatched).toEqual(['/resume old-session', '/subagents resume']);
  stop();
});

test('a halted outcome loop is reported once per revision, and a stopped loop listens to nothing', async () => {
  const messages: any[] = [];
  const onMessage = (m: any) => messages.push(m);
  engineEvents.on('message', onMessage);
  let revision = 1;
  const outcomeManager = {
    continuation: () => ({ state: 'halted', revision, lastError: 'three wakes made no progress' }),
    activeSessionId: () => 's1',
  } as any;
  const stop = startOutcomeContinuation({ session: { isBusy: false } as any, outcomeManager, config: {} });
  engineEvents.emit('outcome_continuation_requested', { sessionId: 's1' });
  await new Promise((r) => setTimeout(r, 300));
  engineEvents.emit('outcome_continuation_requested', { sessionId: 's1' });
  await new Promise((r) => setTimeout(r, 300));
  const halts = () => messages.filter((m) => String(m.content).includes('Outcome auto-continuation paused'));
  expect(halts()).toHaveLength(1);
  stop();
  revision = 2;
  engineEvents.emit('outcome_continuation_requested', { sessionId: 's1' });
  await new Promise((r) => setTimeout(r, 300));
  expect(halts()).toHaveLength(1);
  engineEvents.off('message', onMessage);
});

test('index onboarding stops listening for a finished map when the session ends (the listener used to outlive it)', () => {
  const before = engineEvents.listenerCount('graph_changed');
  const stop = startIndexOnboarding({ graphStore: null, codebaseIndexer: { autoIndex: async () => undefined } });
  expect(engineEvents.listenerCount('graph_changed')).toBe(before + 1);
  stop();
  expect(engineEvents.listenerCount('graph_changed')).toBe(before);
});
