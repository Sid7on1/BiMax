import { buildRows } from '../renderer/src/components/Transcript';
import { EngineStore } from '../renderer/src/engine.store';
import { Outbound } from '../renderer/src/protocol';

/**
 * Opening any folder printed "Code index: degraded. Indexing 1 changed or new files. Search results are
 * incomplete…" at the top of the chat, and it never went away. The engine reports the index degraded
 * while it syncs and recovered when it finishes — both in the same millisecond on a small folder (measured
 * live) — but the transcript kept the warning and dropped the recovery as chatter. Capability notices
 * belong to the banner, which clears them on recovery.
 */

const notice = (id: string, state: 'degraded' | 'ready', level: 'warn' | 'success', reason: string) => ({
  t: 'event', name: 'message', args: [{
    id, role: 'system', level, timestamp: '2026-09-29T01:41:53.800Z',
    content: `Code index: ${state === 'ready' ? 'recovered' : state}. ${reason}`,
    payload: { capabilityStatus: {
      id: 'code-index:/tmp/proj', label: 'Code index', state, reason,
      impact: state === 'ready' ? 'Index coverage is current.' : 'Search results are incomplete; absence from results does not prove absence from the project.',
      action: state === 'ready' ? '' : 'Use file search for exact tokens. Further searches retry indexing.',
      observedAt: '2026-09-29T01:41:53.800Z',
    } },
  }],
}) as unknown as Outbound;

function storeAfter(...events: Outbound[]): EngineStore {
  const store = new EngineStore();
  for (const msg of events) store.dispatch({ type: 'outbound', msg });
  return store;
}

test('a capability that degrades and recovers leaves nothing in the chat or the banner', () => {
  const store = storeAfter(
    notice('capability-1', 'degraded', 'warn', 'Indexing 1 changed or new files.'),
    notice('capability-2', 'ready', 'success', 'Index synchronization completed.'),
  );
  expect(buildRows(store.domains.transcript.getSnapshot().items)).toEqual([]);
  expect(store.domains.workspace.getSnapshot().capabilities).toEqual({});
});

test('a capability still degraded is shown by the banner, not written into the chat', () => {
  const store = storeAfter(notice('capability-1', 'degraded', 'warn', 'Indexing 1 changed or new files.'));
  expect(buildRows(store.domains.transcript.getSnapshot().items)).toEqual([]);
  expect(Object.keys(store.domains.workspace.getSnapshot().capabilities)).toEqual(['code-index:/tmp/proj']);
});

test('an ordinary warning still reaches the chat', () => {
  const store = storeAfter({
    t: 'event', name: 'message',
    args: [{ id: 'w1', role: 'system', level: 'warn', content: 'Provider rejected the API key.', timestamp: '2026-09-29T01:41:53.800Z' }],
  } as unknown as Outbound);
  const rows = buildRows(store.domains.transcript.getSnapshot().items);
  expect(rows.map((r) => r.key)).toEqual(['w1']);
});
