import { ThreadManager, type SavedThread } from '../main/thread.manager';

/**
 * Backlog F7: steering a running task, and its priority. Words sent while a task works go to the running turn; a
 * task's priority decides which waiting task starts first and which idle engine is stopped last to make room.
 */

function fixture(saved: SavedThread[] = [], memory?: () => { freeBytes: number }) {
  const engines = new Map<string, { sendFromRenderer: jest.Mock; dispose: jest.Mock; openProject: jest.Mock }>();
  const manager = new ThreadManager({
    engine: (id) => { const e = { sendFromRenderer: jest.fn(), dispose: jest.fn(), openProject: jest.fn() }; engines.set(id, e); return e; },
    selected: jest.fn(), message: jest.fn(), approval: jest.fn(), save: jest.fn(), saveNow: jest.fn(), changed: jest.fn(),
    ...(memory ? { memory } : {}),
  }, saved);
  const ready = (id: string) => manager.receive(id, { t: 'ready', protocol: 3 } as any);
  const idle = (id: string) => manager.receive(id, { t: 'event', name: 'spinner_state', args: ['idle', ''] } as any);
  const sent = (id: string) => engines.get(id)!.sendFromRenderer.mock.calls.map(([msg]) => msg);
  return { manager, engines, ready, idle, sent };
}

describe('steering', () => {
  test('words for a working task go to the running turn now, recorded as being worked on', () => {
    const f = fixture();
    const id = f.manager.create('/fixture/parser', 'Refactor the parser');
    f.ready(id);
    expect(f.manager.summary(id).status).toBe('working');
    f.manager.send(id, { t: 'steer', text: 'Keep the old name exported.' });
    expect(f.sent(id)).toEqual([{ t: 'input', text: 'Refactor the parser' }, { t: 'steer', text: 'Keep the old name exported.' }]);
    expect(f.manager.get(id).inputs?.map((i) => [i.display, i.state])).toEqual([['Refactor the parser', 'sent'], ['Keep the old name exported.', 'sent']]);
    expect(f.manager.summary(id).queued).toBeUndefined();
    // The turn ends: both are settled, nothing is sent again.
    f.idle(id);
    expect(f.manager.get(id).inputs ?? []).toEqual([]);
    expect(f.sent(id)).toHaveLength(2);
  });

  test('words for a task that is not working are an ordinary message', () => {
    const f = fixture();
    const id = f.manager.create('/fixture/parser', 'Refactor the parser');
    f.ready(id);
    f.idle(id);
    f.manager.send(id, { t: 'steer', text: 'Now add tests.' });
    expect(f.sent(id)[1]).toEqual({ t: 'input', text: 'Now add tests.' });
    expect(f.manager.summary(id).status).toBe('working');
  });

  test('a slash command is never steering', () => {
    const f = fixture();
    const id = f.manager.create('/fixture/parser', 'Refactor the parser');
    f.ready(id);
    f.manager.send(id, { t: 'steer', text: '/cost' });
    expect(f.sent(id)[1]).toEqual({ t: 'input', text: '/cost' });
  });

  test('steering the turn never took is sent next, once, when the turn ends', () => {
    const f = fixture();
    const id = f.manager.create('/fixture/parser', 'Refactor the parser');
    f.ready(id);
    f.manager.send(id, { t: 'steer', text: 'Also rename the module.' });
    f.manager.receive(id, { t: 'event', name: 'steer_unused', args: [{ texts: ['Also rename the module.'] }] } as any);
    f.idle(id);
    expect(f.sent(id)).toEqual([
      { t: 'input', text: 'Refactor the parser' },
      { t: 'steer', text: 'Also rename the module.' },
      { t: 'input', text: 'Also rename the module.' },
    ]);
  });
});

describe('priority', () => {
  test('when a folder frees, the high-priority task waiting for it starts first', () => {
    const f = fixture();
    const running = f.manager.create('/fixture/Downloads', 'Sort the downloads');
    f.ready(running);
    const normal = f.manager.create('/fixture/Downloads', 'Rename the photos');
    f.ready(normal);
    const urgent = f.manager.create('/fixture/Downloads', 'Find the tax form');
    f.ready(urgent);
    expect(f.manager.summary(normal).waiting).toBe('folder');
    f.manager.setPriority(urgent, 'high');
    f.idle(running);
    expect(f.manager.summary(urgent).status).toBe('working');
    expect(f.manager.summary(normal).status).toBe('idle');
    expect(f.manager.summary(normal).waiting).toBe('folder');
  });

  test('at the engine limit, an idle low-priority task is stopped before an older normal one', () => {
    const f = fixture([], () => ({ freeBytes: 64 * 1024 ** 3 }));
    const ids = ['/a', '/b', '/c', '/d'].map((root, i) => {
      const id = f.manager.create(`/fixture${root}`, `task ${i}`);
      f.ready(id);
      f.idle(id);
      return id;
    });
    f.manager.setPriority(ids[3], 'low');
    f.manager.create('/fixture/e', 'task 4');
    expect(f.manager.summary(ids[3]).status).toBe('stopped');
    expect(f.manager.summary(ids[0]).status).toBe('idle');
  });

  test('a high-priority task is stopped last; normal is the default and is not saved', () => {
    const f = fixture([], () => ({ freeBytes: 64 * 1024 ** 3 }));
    const ids = ['/a', '/b', '/c', '/d'].map((root, i) => {
      const id = f.manager.create(`/fixture${root}`, `task ${i}`);
      f.ready(id);
      f.idle(id);
      return id;
    });
    f.manager.setPriority(ids[0], 'high');
    f.manager.create('/fixture/e', 'task 4');
    expect(f.manager.summary(ids[0]).status).toBe('idle');
    expect(f.manager.summary(ids[1]).status).toBe('stopped');
    f.manager.setPriority(ids[0], 'normal');
    expect(f.manager.summary(ids[0]).priority).toBeUndefined();
  });
});
