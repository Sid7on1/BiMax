import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadManager, type SavedThread } from '../main/thread.manager';
import { ThreadStorage } from '../main/thread.storage';

/**
 * Backlog F1 (record 46, T01): a message the user sent is saved before it is accepted, survives a crash, an engine
 * restart, a model switch and a reload, and is dropped only by the user's Stop or interrupt. A message that was being
 * worked on when the engine went away may have partly run, so it is reported and never sent again on its own.
 */

function fixture(saved: SavedThread[] = []) {
  const engines = new Map<string, { sendFromRenderer: jest.Mock; dispose: jest.Mock; openProject: jest.Mock }>();
  /** What is on disk: the last snapshot written, deep-copied as storage would. */
  const disk = new Map<string, SavedThread>();
  let urgentWrites = 0;
  const manager = new ThreadManager({
    engine: (id) => { const e = { sendFromRenderer: jest.fn(), dispose: jest.fn(), openProject: jest.fn() }; engines.set(id, e); return e; },
    save: (value) => { disk.set(value.summary.id, JSON.parse(JSON.stringify(value))); },
    saveNow: (value) => { urgentWrites++; disk.set(value.summary.id, JSON.parse(JSON.stringify(value))); },
    selected: jest.fn(), message: jest.fn(), approval: jest.fn(), changed: jest.fn(),
  }, saved);
  const ready = (id: string) => manager.receive(id, { t: 'ready', protocol: 3 } as any);
  const idle = (id: string) => manager.receive(id, { t: 'event', name: 'spinner_state', args: ['idle', ''] } as any);
  const notes = (id: string) => manager.get(id).state.items
    .filter((item: any) => item.kind === 'msg' && item.msg.role === 'system').map((item: any) => String(item.msg.content)).join('\n');
  return { manager, engines, disk, ready, idle, notes, urgent: () => urgentWrites };
}

const inputs = (thread: SavedThread) => (thread.inputs ?? []).map((input) => [input.display, input.state]);

test('a queued message is on disk before submit returns, and a reload sends it when the task resumes', () => {
  const first = fixture();
  const id = first.manager.create('/fixture/a', 'first job');
  first.ready(id);
  const before = first.urgent();
  first.manager.submit(id, 'UNIQUE PENDING MESSAGE');
  expect(first.urgent()).toBeGreaterThan(before);
  expect(inputs(first.disk.get(id)!)).toEqual([['first job', 'sent'], ['UNIQUE PENDING MESSAGE', 'queued']]);

  // Bimax closes without warning: a new manager starts from what was on disk.
  const reloaded = fixture([first.disk.get(id)!]);
  expect(reloaded.notes(id)).toContain('when Bimax closed, so it may have partly run. It was not sent again: “first job”');
  expect(reloaded.notes(id)).toContain('Kept 1 message that had not been sent when Bimax closed');
  reloaded.manager.start(id);
  reloaded.ready(id);
  expect(reloaded.engines.get(id)!.sendFromRenderer.mock.calls).toEqual([[{ t: 'input', text: 'UNIQUE PENDING MESSAGE' }]]);
});

test('an engine restart keeps the queue and sends it when the engine is back; the interrupted message is not repeated', () => {
  const f = fixture();
  const id = f.manager.create('/fixture/b', 'long job');
  f.ready(id);
  f.manager.submit(id, 'next one');
  f.manager.lifecycle(id, 'restarting', 'Engine restarting');
  expect(inputs(f.manager.get(id))).toEqual([['next one', 'queued']]);
  expect(f.notes(id)).toContain('when the engine restarted, so it may have partly run. It was not sent again: “long job”');
  f.ready(id);
  expect(f.engines.get(id)!.sendFromRenderer.mock.calls).toEqual([[{ t: 'input', text: 'long job' }], [{ t: 'input', text: 'next one' }]]);
});

test('a model switch and quitting keep the queue; only the user’s Stop or interrupt drops it', () => {
  const f = fixture();
  const id = f.manager.create('/fixture/c', 'job');
  f.ready(id);
  f.idle(id);
  f.manager.submit(id, 'still wanted');
  f.manager.submit(id, 'also wanted');
  f.manager.setModel(id, 'fixture/other-model');
  expect(inputs(f.manager.get(id)).map(([display]) => display)).toEqual(['also wanted']);
  expect(f.notes(id)).toContain('“still wanted”'); // it had been sent, so the restart reports it instead of repeating it
  f.manager.dispose();
  expect(inputs(f.disk.get(id)!)).toEqual([['also wanted', 'queued']]);

  const g = fixture();
  const stopped = g.manager.create('/fixture/d', 'job');
  g.ready(stopped);
  g.manager.submit(stopped, 'dropped by Stop');
  g.manager.stop(stopped);
  expect(g.manager.get(stopped).inputs).toEqual([]);
  expect(g.notes(stopped)).not.toContain('may have partly run');

  const h = fixture();
  const interrupted = h.manager.create('/fixture/e', 'job');
  h.ready(interrupted);
  h.manager.submit(interrupted, 'dropped by interrupt');
  h.manager.send(interrupted, { t: 'interrupt' });
  expect(h.manager.get(interrupted).inputs).toEqual([]);
});

test('a finished turn leaves nothing open in the saved record', () => {
  const f = fixture();
  const id = f.manager.create('/fixture/f', 'job');
  f.ready(id);
  expect(inputs(f.disk.get(id)!)).toEqual([['job', 'sent']]);
  f.idle(id);
  expect(f.disk.get(id)!.inputs).toEqual([]);
  // Control: an idle heartbeat with no turn running settles nothing that is still queued.
  f.manager.submit(id, 'queued behind nothing');
  f.idle(id);
  expect(f.engines.get(id)!.sendFromRenderer).toHaveBeenLastCalledWith({ t: 'input', text: 'queued behind nothing' });
});

test('storage writes a queued message at once, reloads it, and an older save in flight never overwrites it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-thread-queue-'));
  try {
    const storage = new ThreadStorage(dir);
    const summary = { id: 'queue-thread', title: 't', root: '/fixture/g', updatedAt: 1, status: 'idle', peers: [] } as any;
    const state = { items: [] } as any;
    const message = { id: 'input-1', text: 'hello', display: 'hello', state: 'queued' as const, at: 2 };

    storage.save({ summary, state, inputs: [] });
    const inFlight = storage.flush();
    storage.saveNow({ summary, state, inputs: [message] });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'queue-thread.json'), 'utf8')).inputs).toEqual([message]);
    await inFlight;
    expect(storage.load()[0].inputs).toEqual([message]);

    // A coalesced save already writing when saveNow lands must not rename its older file over the newer one.
    const newer = { ...message, id: 'input-2', text: 'newer', display: 'newer' };
    const promises = require('node:fs/promises');
    const realWrite = promises.writeFile;
    const spy = jest.spyOn(promises, 'writeFile').mockImplementation(async (...args: any[]) => {
      spy.mockRestore();
      await realWrite(...args);
      storage.saveNow({ summary, state, inputs: [newer] });
    });
    storage.save({ summary, state, inputs: [] });
    await storage.flush();
    expect(storage.load()[0].inputs).toEqual([newer]);

    // Control: a newer ordinary save still replaces it.
    storage.save({ summary, state, inputs: [] });
    await storage.flush();
    expect(storage.load()[0].inputs).toEqual([]);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
