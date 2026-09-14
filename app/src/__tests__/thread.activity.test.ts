import { ThreadManager, type SavedThread } from '../main/thread.manager';
import { trayEntries } from '../main/thread.tray';
import { threadActivity, threadNotice, type ThreadSummary } from '../shared/threads';
import { initialEngineState } from '../renderer/src/engine.state';

/**
 * Backlog N12: a task with queued work used to show "idle". Each thread now says what it waits for (its folder, its
 * engine, a resume), how many messages are queued, and how its last turn ended; queued messages can be cancelled.
 */

function fixture(saved: SavedThread[] = []) {
  const engines = new Map<string, any>();
  const save = jest.fn();
  const saveNow = jest.fn();
  const manager = new ThreadManager({
    engine: (id) => { const e = { sendFromRenderer: jest.fn(), dispose: jest.fn(), openProject: jest.fn() }; engines.set(id, e); return e; },
    selected: jest.fn(), message: jest.fn(), approval: jest.fn(), save, saveNow, changed: jest.fn(),
  }, saved);
  const ready = (id: string) => manager.receive(id, { t: 'ready', protocol: 3 } as any);
  const idle = (id: string) => manager.receive(id, { t: 'event', name: 'spinner_state', args: ['idle', ''] } as any);
  return { manager, engines, save, saveNow, ready, idle, summary: (id: string) => manager.summary(id) };
}

test('the words for a thread’s state say what it waits for and how its last turn ended', () => {
  const at = (fields: Partial<ThreadSummary>) => threadActivity({ status: 'idle', ...fields });
  expect(at({ status: 'working', queued: 2 })).toEqual({ label: 'Working · 2 messages queued', short: 'working' });
  expect(at({ status: 'needs-you' })).toEqual({ label: 'Needs your decision', short: 'needs you' });
  expect(at({ status: 'starting', queued: 1 }).label).toBe('Starting · 1 message queued');
  expect(at({ queued: 1, waiting: 'folder' })).toEqual({ label: 'Waiting for another task in this folder · 1 message queued', short: 'waiting for its folder' });
  expect(at({ status: 'stopped', queued: 3, waiting: 'resume' })).toEqual({ label: 'Stopped · 3 messages queued, sent when it resumes', short: 'messages kept' });
  expect(at({ queued: 1, waiting: 'engine' })).toEqual({ label: 'Waiting to start · 1 message queued', short: 'waiting' });
  expect(at({ outcome: 'completed' })).toEqual({ label: 'Done', short: '' });
  expect(at({ status: 'stopped', outcome: 'failed' })).toEqual({ label: 'Failed', short: 'failed' });
  expect(at({ outcome: 'interrupted' })).toEqual({ label: 'Interrupted', short: 'interrupted' });
  expect(at({ status: 'stopped', outcome: 'completed' })).toEqual({ label: 'Stopped', short: '' });
  expect(at({})).toEqual({ label: 'Idle', short: '' });

  expect(threadNotice({ status: 'working', queued: 2 })).toBeNull();
  expect(threadNotice({ status: 'needs-you', queued: 1 })).toBeNull();
  expect(threadNotice({ status: 'idle', outcome: 'completed' })).toBeNull();
  expect(threadNotice({ status: 'idle', queued: 1, waiting: 'folder' })).toBe('Waiting for another task in this folder · 1 message queued');
  expect(threadNotice({ status: 'stopped', outcome: 'failed' })).toBe('Failed');
  expect(threadNotice({ status: 'idle', outcome: 'interrupted' })).toBe('Interrupted');
});

test('a message queued behind another task in the same folder says so, and runs when that task is done', () => {
  const f = fixture();
  const a = f.manager.create('/fixture/Downloads', 'Sort the PDFs');
  f.ready(a);
  const b = f.manager.create('/fixture/Downloads/Invoices', 'Rename the invoices');
  expect(f.summary(b)).toMatchObject({ status: 'starting', queued: 1, waiting: 'engine' });
  f.ready(b);
  expect(f.summary(b)).toMatchObject({ status: 'idle', queued: 1, waiting: 'folder' });
  expect(f.summary(a).status).toBe('working');
  expect(f.summary(a).queued).toBeUndefined();
  expect(trayEntries(f.manager.list()).find((entry) => entry.id === b)?.label).toBe('○ Rename the invoices — waiting for its folder');

  f.idle(a);
  expect(f.summary(a).outcome).toBe('completed');
  expect(f.summary(b).status).toBe('working');
  expect(f.summary(b).queued).toBeUndefined();
  expect(f.summary(b).waiting).toBeUndefined();
});

test('messages behind a running turn are counted; a stopped task keeps them, and the counts are never saved', () => {
  const f = fixture();
  const id = f.manager.create('/fixture/Desktop', 'Tidy the Desktop');
  f.ready(id);
  f.manager.submit(id, 'Then empty the screenshots folder');
  expect(f.summary(id)).toMatchObject({ status: 'working', queued: 1 });
  expect(f.summary(id).waiting).toBeUndefined();

  f.manager.stop(id, { keepInputs: true });
  expect(f.summary(id)).toMatchObject({ status: 'stopped', queued: 1, waiting: 'resume', outcome: 'interrupted' });
  const saved = [...f.save.mock.calls, ...f.saveNow.mock.calls].map((call) => call[0].summary);
  expect(saved.length).toBeGreaterThan(0);
  for (const summary of saved) {
    expect(summary).not.toHaveProperty('queued');
    expect(summary).not.toHaveProperty('waiting');
  }
});

test('a turn ends done, failed or interrupted, and the next turn clears how the last one ended', () => {
  const f = fixture();
  const id = f.manager.create('/fixture/a', 'First');
  f.ready(id);
  f.manager.receive(id, { t: 'event', name: 'message', args: [{ id: 'e', role: 'system', level: 'error', content: 'Agent error: the model refused', timestamp: '' }] } as any);
  f.idle(id);
  expect(f.summary(id).outcome).toBe('failed');

  f.manager.submit(id, 'Second');
  expect(f.summary(id).outcome).toBeUndefined();
  f.manager.send(id, { t: 'interrupt' });
  f.idle(id);
  expect(f.summary(id).outcome).toBe('interrupted');

  f.manager.submit(id, 'Third');
  f.manager.receive(id, { t: 'event', name: 'message', args: [{ id: 'w', role: 'system', level: 'warning', content: 'Slow provider', timestamp: '' }] } as any);
  f.idle(id);
  expect(f.summary(id).outcome).toBe('completed');

  f.manager.submit(id, 'Fourth');
  f.manager.lifecycle(id, 'failed', 'The engine crashed');
  expect(f.summary(id)).toMatchObject({ status: 'stopped', outcome: 'failed' });

  // An engine that exits, or a Stop, between turns cuts nothing off: the last turn stays done.
  const quiet = f.manager.create('/fixture/quiet', 'Short job');
  f.ready(quiet);
  f.idle(quiet);
  f.manager.lifecycle(quiet, 'exited', 'The engine closed while idle');
  expect(f.summary(quiet)).toMatchObject({ status: 'stopped', outcome: 'completed' });
  const calm = f.manager.create('/fixture/calm', 'Another short job');
  f.ready(calm);
  f.idle(calm);
  f.manager.stop(calm);
  expect(f.summary(calm)).toMatchObject({ status: 'stopped', outcome: 'completed' });
});

test('a task that was mid-turn when Bimax closed reopens as interrupted', () => {
  const sent = { id: 's', text: 'Zip it', display: 'Zip it', state: 'sent' as const, at: 1 };
  const saved: SavedThread = {
    summary: { id: 'z', root: '/fixture/z', title: 'Zip', updatedAt: 1, status: 'working', peers: [], outcome: 'completed' },
    state: { ...initialEngineState, items: [] }, inputs: [sent],
  };
  expect(fixture([saved]).summary('z')).toMatchObject({ status: 'stopped', outcome: 'interrupted' });
  expect(fixture([{ ...saved, inputs: [] }]).summary('z')).toMatchObject({ status: 'stopped', outcome: 'completed' });
});

test('Cancel queued drops only the waiting messages, says which, and saves at once', () => {
  const f = fixture();
  const id = f.manager.create('/fixture/b', 'Working on this');
  f.ready(id);
  f.manager.submit(id, 'Then this');
  f.manager.submit(id, 'And this');
  expect(f.manager.cancelQueued(id)).toBe(2);
  expect(f.summary(id).status).toBe('working');
  expect(f.summary(id).queued).toBeUndefined();
  expect(f.manager.get(id).inputs).toEqual([expect.objectContaining({ display: 'Working on this', state: 'sent' })]);
  expect(f.saveNow).toHaveBeenLastCalledWith(expect.objectContaining({ inputs: [expect.objectContaining({ state: 'sent' })] }));
  const note = f.manager.get(id).state.items.at(-1);
  expect(note?.kind === 'msg' ? note.msg.content : null).toBe('Cancelled 2 queued messages: “Then this”, “And this”.');
  expect(f.manager.cancelQueued(id)).toBe(0);
  expect(() => f.manager.cancelQueued('missing')).toThrow('Thread not found');
  f.idle(id);
  expect(f.engines.get(id).sendFromRenderer).toHaveBeenCalledTimes(1);
});
