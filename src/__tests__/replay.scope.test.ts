import { inReplayScope, isReplayActive } from '../core/replay.scope';
import { engineEvents } from '../engine/events';
import { reportCapability, capabilitySnapshot, resetCapabilityStatus } from '../core/capability.status';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('overlapping replays stay isolated while foreground events continue throughout', async () => {
  const a = latch(), b = latch(), observed: string[] = [];
  const listener = (message: { content: string }) => observed.push(message.content);
  const emit = (content: string) => engineEvents.emit('message', { id: content, role: 'assistant', content, timestamp: new Date() });
  engineEvents.on('message', listener);
  try {
    const first = inReplayScope(async () => { expect(isReplayActive()).toBe(true); emit('old A'); await a.promise; emit('old A ended'); });
    const second = inReplayScope(async () => { emit('old B'); await b.promise; expect(isReplayActive()).toBe(true); emit('old B ended'); });
    expect(isReplayActive()).toBe(false); emit('live while both replay');
    a.release(); await first;
    expect(isReplayActive()).toBe(false); emit('live while B replays');
    b.release(); await second; emit('live after replay');
    expect(observed).toEqual(['live while both replay', 'live while B replays', 'live after replay']);
  } finally { a.release(); b.release(); engineEvents.off('message', listener); }
});

test('failed and nested evaluations restore context without hiding later live events', async () => {
  await expect(inReplayScope(async () => {
    await inReplayScope(async () => { await Promise.resolve(); expect(isReplayActive()).toBe(true); });
    expect(isReplayActive()).toBe(true);
    throw new Error('fixture replay failed');
  })).rejects.toThrow('fixture replay failed');
  expect(isReplayActive()).toBe(false);
  const observed = jest.fn(); engineEvents.on('stream_token', observed);
  try { engineEvents.emit('stream_token', 'real answer'); expect(observed).toHaveBeenCalledWith('real answer'); }
  finally { engineEvents.off('stream_token', observed); }
});

test('replay capability failures never replace live capability state', async () => {
  resetCapabilityStatus();
  const status = { id: 'fixture', label: 'Fixture', state: 'degraded' as const, reason: 'real failure', impact: '', action: '' };
  reportCapability(status); const before = capabilitySnapshot();
  await inReplayScope(async () => { reportCapability({ ...status, reason: 'recorded failure' }); });
  expect(capabilitySnapshot()).toEqual(before);
  resetCapabilityStatus();
});
