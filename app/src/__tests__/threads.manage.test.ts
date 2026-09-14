import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_THREADS, ThreadManager, type SavedThread } from '../main/thread.manager';
import { ThreadStorage } from '../main/thread.storage';
import { initialEngineState } from '../renderer/src/engine.state';

/**
 * Backlog N11: threads can be renamed, searched, archived, restored and moved to the Bin, and a full list archives the
 * least recently used thread instead of refusing a new task (folder triggers start one per run). Nothing is deleted.
 */

function fixture(saved: SavedThread[] = [], withArchive = true) {
  const archived: SavedThread[] = [];
  const save = jest.fn();
  const manager = new ThreadManager({
    engine: () => ({ sendFromRenderer: jest.fn(), dispose: jest.fn(), openProject: jest.fn() }),
    selected: jest.fn(), message: jest.fn(), approval: jest.fn(), save, changed: jest.fn(),
    ...(withArchive ? { archive: (value: SavedThread) => { archived.push(value); } } : {}),
  }, saved);
  return { manager, archived, save };
}

const savedThread = (id: string, updatedAt: number, extra: Partial<SavedThread> = {}): SavedThread => ({
  summary: { id, root: `/fixture/${id}`, title: `Thread ${id}`, updatedAt, status: 'stopped', peers: [], origin: 'quick' },
  state: { ...initialEngineState, items: [] },
  ...extra,
});
const queued = (id: string) => ({ id, text: 'Then zip them', display: 'Then zip them', state: 'queued' as const, at: 1 });

test('a thread can be renamed: the name is cleaned, limited and saved, and the first message does not replace it', () => {
  const f = fixture();
  const id = f.manager.create('/fixture/Downloads');
  f.manager.rename(id, '  Invoices\n for   2026 ');
  expect(f.manager.get(id).summary.title).toBe('Invoices for 2026');
  expect(f.save).toHaveBeenLastCalledWith(expect.objectContaining({ summary: expect.objectContaining({ title: 'Invoices for 2026' }) }));
  expect(() => f.manager.rename(id, '   ')).toThrow('1–80 characters');
  expect(() => f.manager.rename(id, 'x'.repeat(81))).toThrow('1–80 characters');
  expect(() => f.manager.rename('missing', 'Name')).toThrow('Thread not found');
  f.manager.submit(id, 'Sort the PDFs');
  expect(f.manager.get(id).summary.title).toBe('Invoices for 2026');
});

test('search finds threads by name, folder or anything said in them, needing every word, ignoring case', () => {
  const said = (text: string) => ({ ...initialEngineState, items: [{ kind: 'msg', msg: { id: 'm', role: 'assistant', content: text, timestamp: '' } }] }) as any;
  const f = fixture([
    savedThread('a', 3, { state: said('Moved 4 invoices into Accounting') }),
    savedThread('b', 2, { summary: { ...savedThread('b', 2).summary, title: 'Holiday photos', root: '/Users/me/Pictures' } }),
    savedThread('c', 1),
  ]);
  expect(f.manager.search('INVOICES')).toEqual(['a']);
  expect(f.manager.search('pictures holiday')).toEqual(['b']);
  expect(f.manager.search('holiday invoices')).toEqual([]);
  expect(f.manager.search('   ')).toEqual(['a', 'b', 'c']);
});

test('a thread with an engine cannot leave the list; a stopped one leaves with its state, and its links and selection end', () => {
  const f = fixture();
  const a = f.manager.create('/fixture/a', 'Tidy');
  const b = f.manager.create('/fixture/b');
  f.manager.receive(a, { t: 'ready', protocol: 3 } as any);
  f.manager.link(a, b, true);
  f.manager.select(a);
  expect(() => f.manager.release(a)).toThrow('Stop this thread first');
  f.manager.stop(a);
  const saved = f.manager.release(a);
  expect(saved.summary).toMatchObject({ id: a, title: 'Tidy', status: 'stopped' });
  expect(saved.state.items.length).toBeGreaterThan(0);
  expect(f.manager.list().map((t) => t.id)).toEqual([b]);
  expect(f.manager.activeId).toBeNull();
  expect(f.manager.get(b).summary.peers).toEqual([]);
  expect(() => f.manager.get(a)).toThrow('Thread not found');
});

test('a restored thread comes back stopped, at the top, with the messages it still had queued', () => {
  const f = fixture([savedThread('recent', 5_000)]);
  const id = f.manager.restore(savedThread('old', 5, { inputs: [queued('q1')] }));
  expect(id).toBe('old');
  expect(f.manager.list().map((t) => t.id)).toEqual(['old', 'recent']);
  expect(f.manager.get('old').summary.status).toBe('stopped');
  expect(f.manager.get('old').inputs).toEqual([queued('q1')]);
  expect(() => f.manager.restore(savedThread('old', 5))).toThrow('already in the list');
  expect(() => f.manager.restore(savedThread('../escape', 5))).toThrow('cannot be read');
});

test(`with ${MAX_THREADS} threads, a new task archives the least recently used one that is not open or holding a message`, () => {
  const saved = Array.from({ length: MAX_THREADS }, (_, i) => savedThread(`t${i}`, 1_000 + i));
  saved[0] = savedThread('t0', 1_000, { inputs: [queued('q')] });
  const f = fixture(saved);
  f.manager.select('t1');
  const id = f.manager.create('/fixture/new', 'Sort Downloads');
  expect(f.archived.map((t) => t.summary.id)).toEqual(['t2']);
  expect(f.manager.list()).toHaveLength(MAX_THREADS);
  expect(f.manager.list().some((t) => t.id === id)).toBe(true);
});

test('with no archive, or nothing that can be put away, a full list still refuses with a reason', () => {
  const full = Array.from({ length: MAX_THREADS }, (_, i) => savedThread(`t${i}`, i));
  expect(() => fixture(full, false).manager.create('/fixture/new')).toThrow('Thread history is full');
  const holding = Array.from({ length: MAX_THREADS }, (_, i) => savedThread(`t${i}`, i, { inputs: [queued(`q${i}`)] }));
  const f = fixture(holding);
  expect(() => f.manager.create('/fixture/new')).toThrow('Thread history is full');
  expect(f.archived).toEqual([]);
  expect(f.manager.list()).toHaveLength(MAX_THREADS);
});

test('storage: an archived thread leaves the list folder with its final state; a save in flight never brings it back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-threads-archive-'));
  try {
    const storage = new ThreadStorage(dir);
    const keep = savedThread('keep', 1);
    const gone = savedThread('gone', 2);
    storage.save(keep);
    storage.save(gone);
    await storage.flush();
    expect(storage.archivedCount()).toBe(0);

    storage.save({ ...gone, summary: { ...gone.summary, title: 'Coalesced save' } });
    const inflight = storage.flush();
    await storage.archive({ ...gone, summary: { ...gone.summary, title: 'Latest name', status: 'working' } });
    await inflight;
    storage.save({ ...gone, summary: { ...gone.summary, title: 'A late save' } });
    await storage.flush();
    expect(fs.existsSync(path.join(dir, 'gone.json'))).toBe(false);
    expect(new ThreadStorage(dir).load().map((t) => t.summary.id)).toEqual(['keep']);
    expect(storage.archivedCount()).toBe(1);
    expect((await storage.archived()).map((t) => [t.id, t.title, t.status])).toEqual([['gone', 'Latest name', 'stopped']]);
    expect(storage.archivedFile('gone')).toBe(path.join(dir, 'archive', 'gone.json'));
    expect(() => storage.archivedFile('../keep')).toThrow('not found');

    const back = await storage.unarchive('gone');
    expect(back.summary.title).toBe('Latest name');
    expect(storage.archivedCount()).toBe(0);
    storage.save({ ...back, summary: { ...back.summary, title: 'Saved again' } });
    await storage.flush();
    expect(new ThreadStorage(dir).load().map((t) => t.summary.title).sort()).toEqual(['Saved again', 'Thread keep']);
    await expect(storage.unarchive('gone')).rejects.toThrow('not found');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('storage: archiving that fails keeps the thread saving in place; nothing unarchives over a thread in the list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-threads-refuse-'));
  try {
    const storage = new ThreadStorage(dir);
    const stay = savedThread('stay', 1);
    storage.save(stay);
    await storage.flush();
    await expect(storage.writeFinal(savedThread('../escape', 1))).rejects.toThrow('Thread not found');

    fs.writeFileSync(path.join(dir, 'archive'), 'a file where the archive folder should be');
    await expect(storage.archive({ ...stay, summary: { ...stay.summary, title: 'Final' } })).rejects.toThrow();
    storage.save({ ...stay, summary: { ...stay.summary, title: 'Still saving' } });
    await storage.flush();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stay.json'), 'utf8')).summary.title).toBe('Still saving');
    fs.rmSync(path.join(dir, 'archive'));

    const twin = savedThread('twin', 2);
    await storage.archive(twin);
    fs.copyFileSync(path.join(dir, 'archive', 'twin.json'), path.join(dir, 'twin.json'));
    await expect(storage.unarchive('twin')).rejects.toThrow('already in the list');
    expect(fs.existsSync(path.join(dir, 'archive', 'twin.json'))).toBe(true);

    // A file whose name does not match the thread inside it is not listed.
    fs.writeFileSync(path.join(dir, 'archive', 'renamed.json'), JSON.stringify(savedThread('someone-else', 3)));
    expect((await storage.archived()).map((t) => t.id)).toEqual(['twin']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('storage: the Bin gets a thread’s final state, and later saves of it are ignored until it is readmitted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-threads-bin-'));
  try {
    const storage = new ThreadStorage(dir);
    const thread = savedThread('bin', 1);
    storage.save(thread);
    await storage.flush();
    const file = await storage.writeFinal({ ...thread, summary: { ...thread.summary, title: 'Final' } });
    expect(file).toBe(path.join(dir, 'bin.json'));
    storage.save(thread);
    await storage.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).summary.title).toBe('Final');

    storage.readmit('bin');
    storage.save({ ...thread, summary: { ...thread.summary, title: 'Kept after all' } });
    await storage.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).summary.title).toBe('Kept after all');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
