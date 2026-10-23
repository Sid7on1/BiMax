import { ThreadManager, IDLE_ENGINE_TTL_MS } from '../main/thread.manager';

/**
 * An engine costs 227 MB whether it is working or finished (measured 2026-09-19), and nothing used
 * to reclaim one: `start()` evicted an idle engine only when a NEW task hit the live limit, so
 * finished ⌘2 tasks sat on a quarter of a gigabyte each, indefinitely.
 *
 * These pin the conservative half — WHAT MUST NOT BE REAPED — because a wrong reap costs the user a
 * restart mid-thought, which is far worse than holding memory a little longer.
 */
const engineFor = () => ({ openProject: jest.fn(), sendFromRenderer: jest.fn(), dispose: jest.fn() });

function manager(): { threads: ThreadManager; engines: ReturnType<typeof engineFor>[] } {
  const engines: ReturnType<typeof engineFor>[] = [];
  const threads = new ThreadManager({
    engine: () => { const e = engineFor(); engines.push(e); return e; },
    changed: () => {}, selected: () => {}, message: () => {}, approval: () => {}, save: () => {},
  } as any);
  return { threads, engines };
}

const stale = (threads: ThreadManager, id: string): void => {
  // Reach past the clock rather than sleeping: the record's own activity stamp is the input.
  (threads as any).records.get(id).summary.updatedAt = Date.now() - IDLE_ENGINE_TTL_MS - 1;
};

test('an idle engine nobody is looking at is reclaimed once it goes stale', () => {
  const { threads } = manager();
  const id = threads.create('/tmp/project-a');
  threads.start(id);
  threads.activeId = null;
  (threads as any).records.get(id).summary.status = 'idle';

  expect(threads.reapIdleEngines()).toEqual([]);   // fresh: left alone
  stale(threads, id);
  expect(threads.reapIdleEngines()).toEqual([id]);
  expect((threads as any).records.get(id).engine).toBeUndefined();
  // And it says why, so a reclaimed thread does not read as a crash.
  expect((threads as any).records.get(id).state.engine.detail).toMatch(/free memory/i);
});

test('the thread on screen, a busy one, and one with queued work are all left alone', () => {
  for (const arrange of [
    (t: ThreadManager, id: string) => { t.activeId = id; },
    (t: ThreadManager, id: string) => { (t as any).records.get(id).summary.status = 'working'; },
    (t: ThreadManager, id: string) => { (t as any).records.get(id).inputs.push({ id: 'i', text: 'x', display: 'x', state: 'queued', at: Date.now() }); },
    (t: ThreadManager, id: string) => { (t as any).records.get(id).pending.set(1, { question: 'ok?' }); },
  ]) {
    const { threads } = manager();
    const id = threads.create('/tmp/project-b');
    threads.start(id);
    threads.activeId = null;
    (threads as any).records.get(id).summary.status = 'idle';
    stale(threads, id);
    arrange(threads, id);
    expect(threads.reapIdleEngines()).toEqual([]);
    expect((threads as any).records.get(id).engine).toBeDefined();
  }
});

test('the sweep is not armed by merely constructing a manager', () => {
  // A manager built in a test must not leave a real timer behind — that is how a jest worker ends
  // up force-killed, and it is why startIdleReaper is the app's call to make.
  const { threads } = manager();
  expect((threads as any).reapCancel).toBeUndefined();
});

test('the ⌘2 bar’s thread is protected even though it is not activeId', () => {
  // quickThreadId lives in the host, not the manager. Before onScreen existed, a bar left open on a
  // quiet thread could have its engine reclaimed under it.
  const engines: any[] = [];
  let onScreenId: string | null = null;
  const threads = new ThreadManager({
    engine: () => { const e = engineFor(); engines.push(e); return e; },
    changed: () => {}, selected: () => {}, message: () => {}, approval: () => {}, save: () => {},
    onScreen: () => [onScreenId],
  } as any);
  const id = threads.create('/tmp/project-c');
  threads.start(id);
  threads.activeId = null;
  (threads as any).records.get(id).summary.status = 'idle';
  (threads as any).records.get(id).summary.updatedAt = Date.now() - IDLE_ENGINE_TTL_MS - 1;

  onScreenId = id;
  expect(threads.reapIdleEngines()).toEqual([]);
  onScreenId = null;
  expect(threads.reapIdleEngines()).toEqual([id]);
});
