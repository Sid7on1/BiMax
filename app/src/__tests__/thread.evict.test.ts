import { ThreadManager, MAX_LIVE_ENGINES } from '../main/thread.manager';

/**
 * Making room for a new Bimax Thread when the machine is already at its live-engine cap.
 *
 * This is the hot path: once four Threads hold an engine, EVERY ⌘2 start runs it. It had drifted
 * badly from its sibling `reapIdleEngines`, which is careful about the same decision:
 *
 *   • it picked with `.find()` — the first record in Map INSERTION order, i.e. the oldest-CREATED
 *     Thread, not the least recently used. Alternating between two Threads evicted the one just
 *     used and kept the one abandoned an hour ago, so every switch cost a restart. `ensureRoom()`
 *     had already been doing this correctly, so the two policies simply disagreed;
 *   • it called `stop(id)` with no options, and `stop` does `r.inputs = []` unless `keepInputs` is
 *     set — silently destroying every queued message on the victim;
 *   • it checked only `status === 'idle'`, so an on-screen Thread or one holding a pending
 *     approval was fair game.
 *
 * These pin the behaviour, never the cap.
 */

const engineFor = () => ({ openProject: jest.fn(), sendFromRenderer: jest.fn(), dispose: jest.fn() });

function manager(onScreen: () => Array<string | null> = () => []) {
  const threads = new ThreadManager({
    engine: () => engineFor(),
    changed: () => {}, selected: () => {}, message: () => {}, approval: () => {}, save: () => {},
    onScreen,
  } as any);
  return threads;
}

/** Fill every live-engine slot with an idle Thread, oldest use first. Returns the ids in that order. */
function fillToCap(threads: ThreadManager): string[] {
  const ids: string[] = [];
  for (let i = 0; i < MAX_LIVE_ENGINES; i++) {
    const id = threads.create(`/tmp/evict-${i}`);
    threads.start(id);
    const r = (threads as any).records.get(id);
    r.summary.status = 'idle';
    // Created first == used longest ago, for now. Individual tests rewrite this.
    r.summary.updatedAt = 1_000 + i;
    ids.push(id);
  }
  threads.activeId = null;
  return ids;
}

const live = (threads: ThreadManager, id: string): boolean => !!(threads as any).records.get(id).engine;

test('evicts the LEAST RECENTLY USED Thread, not the oldest-created one', () => {
  const threads = manager();
  const [first, , , last] = fillToCap(threads);
  // The user has just been working in the oldest-created Thread, and abandoned the newest.
  (threads as any).records.get(first).summary.updatedAt = Date.now();
  (threads as any).records.get(last).summary.updatedAt = 1;

  const fresh = threads.create('/tmp/evict-new');
  threads.start(fresh);

  expect(live(threads, first)).toBe(true);   // just used — kept
  expect(live(threads, last)).toBe(false);   // abandoned — reclaimed
});

test('keeps the queued messages of the Thread it evicts', () => {
  const threads = manager();
  const ids = fillToCap(threads);
  const victim = ids[0]; // least recently used by construction
  // A Thread can be `idle` and still hold queued work — a turn has settled but the pump has not
  // dispatched the next message yet. That window is where the messages were being destroyed.
  const queued = { id: 'i1', text: 'finish the migration', display: 'finish the migration', state: 'queued', at: Date.now() };
  (threads as any).records.get(victim).inputs.push(queued);

  const fresh = threads.create('/tmp/evict-new');
  threads.start(fresh);

  // Holding queued work now disqualifies it outright, so a different Thread is reclaimed...
  expect(live(threads, victim)).toBe(true);
  expect((threads as any).records.get(victim).inputs).toHaveLength(1);
  expect(ids.some((id) => !live(threads, id))).toBe(true);
});

test('never evicts a Thread the user can see', () => {
  const ids: string[] = [];
  const threads = manager(() => [ids[0]]); // the ⌘2 bar is showing the least recently used one
  ids.push(...fillToCap(threads));

  const fresh = threads.create('/tmp/evict-new');
  threads.start(fresh);

  expect(live(threads, ids[0])).toBe(true);
});

test('says why it stopped, so a reclaimed Thread does not read as a crash', () => {
  const threads = manager();
  const ids = fillToCap(threads);
  threads.start(threads.create('/tmp/evict-new'));
  const stopped = ids.find((id) => !live(threads, id))!;
  expect((threads as any).records.get(stopped).state.engine.detail).toMatch(/make room/i);
});

test('refuses rather than evicting a Thread that is working', () => {
  const threads = manager();
  for (const id of fillToCap(threads)) (threads as any).records.get(id).summary.status = 'working';
  const fresh = threads.create('/tmp/evict-new');
  // Better an honest refusal than silently killing a turn in flight.
  expect(() => threads.start(fresh)).toThrow(/stop a task|memory for right now/i);
});
