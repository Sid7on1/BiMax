import {
  NativePerceptionLatency,
  NativePerceptionReadiness,
  nativeSnapshotAuthority,
} from '../native.perception';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: 'snapshot-1', pid: 42, windowId: 7, windowGeneration: 3,
    eventRevision: 11, eventTracking: true,
    truncated: false, partial: false, changedDuringCapture: false,
    nodes: [],
    ...overrides,
  };
}

describe('native perception authority', () => {
  test('never promotes diff, filtered, truncated, partial, or mid-capture observations', () => {
    expect(nativeSnapshotAuthority(snapshot()).usable).toBe(true);
    for (const mutant of [
      { baseSnapshotId: 'old', diff: { operations: [] } },
      { query: 'Continue' },
      { truncated: true },
      { partial: true },
      { changedDuringCapture: true },
      { eventTracking: false },
      { eventRevision: undefined },
    ]) {
      expect(nativeSnapshotAuthority(snapshot(mutant))).toMatchObject({
        usable: false,
        cache: 'disabled_pending_mutation_proof',
      });
    }
  });

  test('classifies each exact window observation instead of latching an app identity', () => {
    const readiness = new NativePerceptionReadiness();
    expect(readiness.observe(snapshot()).state).toBe('warming');
    expect(readiness.observe(snapshot({
      snapshotId: 'snapshot-2', eventRevision: 12,
      nodes: [{ role: 'AXTextField', label: 'Message', enabled: true }],
    })).state).toBe('ready');

    // A replaced window gets its own readiness history even though the pid is unchanged.
    expect(readiness.observe(snapshot({
      snapshotId: 'snapshot-3', windowGeneration: 4, eventRevision: 13,
    }))).toMatchObject({ state: 'warming', attempt: 0 });
  });

  test('keeps observe/capture/verification timing in separate evidence buckets', async () => {
    const latency = new NativePerceptionLatency();
    await latency.measure('observe', async () => 'observed');
    await latency.measure('capture', async () => 'captured');
    await latency.measure('verification', async () => 'verified');
    expect(latency.summary()).toMatchObject({
      workspace: { count: 0 },
      observe: { count: 1 },
      capture: { count: 1 },
      verification: { count: 1 },
    });
  });
});
