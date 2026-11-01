import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ThreadStorage } from '../main/thread.storage';
import { ThreadManager, type SavedThread } from '../main/thread.manager';
import { initialEngineState } from '../renderer/src/engine.state';
import { threadActivity } from '../shared/threads';
import { RealEngineAdapter } from '../main/responder/adapter';

const saved = (title = 'old'): SavedThread => ({
  summary: { id: 'publication', title, root: '/fixture', updatedAt: 1, status: 'idle', peers: [] },
  state: { ...initialEngineState }, inputs: [],
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function world(dir: string) {
  const storage = new ThreadStorage(dir, { setTimeout: () => undefined });
  const send = jest.fn();
  const manager = new ThreadManager({
    engine: () => ({ openProject() {}, sendFromRenderer: send, dispose() {} }),
    save: v => storage.save(v), saveNow: v => storage.saveNow(v),
    selected() {}, changed() {}, approval() {}, message() {},
  });
  const id = manager.create('/fixture'); manager.start(id);
  manager.receive(id, { t: 'ready', protocol: 3 } as any);
  storage.saveNow(manager.get(id));
  const idle = () => manager.receive(id, { t: 'event', name: 'spinner_state', args: ['idle', ''] });
  return { storage, manager, send, id, idle };
}
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-persistence-regression-')); });
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

test('an old asynchronous publication cannot replace a newer acknowledged snapshot', async () => {
  const storage = new ThreadStorage(dir);
  const entered = deferred(), release = deferred();
  const actualRename = fsp.rename.bind(fsp);
  const rename = jest.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
    entered.resolve(); await release.promise; return actualRename(from, to);
  });
  let writing: Promise<void> = Promise.resolve();
  try {
    storage.save(saved()); writing = storage.flush();
    // Old implementation reaches a suspended async commit. A fixed indivisible commit completes.
    await Promise.race([entered.promise, writing]);
    const newer = { ...saved('new'), inputs: [{ id: 'accepted', text: 'once', display: 'once', state: 'queued' as const, at: 1 }] };
    storage.saveNow(newer);
    expect(storage.load()[0]).toMatchObject(newer);
    release.resolve(); await writing;
    expect(storage.load()[0]).toMatchObject(newer);
  } finally { release.resolve(); await writing; rename.mockRestore(); await storage.flush(); }
});

test.each(['queued', 'sent'])('%s-state write failure dispatches nothing, retains the input and permits an explicit retry', async stage => {
  const w = world(dir);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const actualWrite = fs.writeFileSync.bind(fs);
  const fault = jest.spyOn(fs, 'writeFileSync').mockImplementation((...args: any[]) => {
    if (typeof args[1] === 'string' && args[1].includes(`"state":"${stage}"`)) throw new Error(`ENOSPC at ${stage}`);
    return (actualWrite as any)(...args);
  });
  try {
    expect(() => w.manager.submit(w.id, 'keep this request')).not.toThrow();
    expect(w.send).not.toHaveBeenCalled();
    expect(w.manager.get(w.id).inputs).toEqual([expect.objectContaining({ text: 'keep this request', state: 'queued' })]);
    expect(w.manager.summary(w.id).waiting).toBe('storage');
    expect(threadActivity(w.manager.summary(w.id)).label).toMatch(/saving|save/i);
    expect(JSON.stringify(w.manager.get(w.id).state.items)).toContain('has not been sent');
    w.idle(); w.idle();
    expect(w.send).not.toHaveBeenCalled();
    fault.mockRestore();
    // A background save may recover, but only an explicit user interaction retries execution.
    await w.storage.flush(); w.idle(); expect(w.send).not.toHaveBeenCalled();
    w.manager.submit(w.id, 'next request');
    expect(w.send.mock.calls).toEqual([[{ t: 'input', text: 'keep this request' }]]);
    w.idle(); expect(w.send.mock.calls).toEqual([[{ t: 'input', text: 'keep this request' }], [{ t: 'input', text: 'next request' }]]);
    w.idle(); w.idle(); expect(w.send).toHaveBeenCalledTimes(2);
  } finally { fault.mockRestore(); await w.storage.flush(); }
});

test('a failed steering save cannot send unrecorded steering or forget the running request', async () => {
  const w = world(dir);
  w.manager.submit(w.id, 'running request');
  const actualWrite = fs.writeFileSync.bind(fs);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const fault = jest.spyOn(fs, 'writeFileSync').mockImplementation((...args: any[]) => {
    if (typeof args[1] === 'string' && args[1].includes('"display":"follow-up","state":"sent"')) throw new Error('ENOSPC at steering');
    return (actualWrite as any)(...args);
  });
  try {
    w.manager.steer(w.id, 'follow-up');
    expect(w.send.mock.calls).toEqual([[{ t: 'input', text: 'running request' }]]);
    expect(w.manager.get(w.id).inputs!.map(i => [i.text, i.state])).toEqual([['running request', 'sent'], ['follow-up', 'queued']]);
    w.idle(); expect(w.send).toHaveBeenCalledTimes(1);
    fault.mockRestore();
    w.manager.submit(w.id, 'retry after storage repair');
    expect(w.send).toHaveBeenLastCalledWith({ t: 'input', text: 'follow-up' });
  } finally { fault.mockRestore(); await w.storage.flush(); }
});

test('an actual process exit after a failed sent-state write cannot duplicate a disk side effect on restart', () => {
  const fixture = path.join(__dirname, 'fixtures/thread.persistence.worker.cjs');
  const run = (mode: string) => execFileSync(process.execPath, ['--import', 'tsx', fixture, dir, mode], { timeout: 15_000, stdio: 'pipe' });
  run('fail');
  const effects = path.join(dir, 'effects.log');
  expect(fs.existsSync(effects) ? fs.readFileSync(effects, 'utf8') : '').toBe('');
  run('resume');
  expect(fs.readFileSync(effects, 'utf8')).toBe('effect\n');
  run('resume');
  expect(fs.readFileSync(effects, 'utf8')).toBe('effect\n');
});

test('one remote instruction creates one queued input and one dispatch through the real manager', async () => {
  const sends: unknown[] = [];
  const manager = new ThreadManager({
    engine: () => ({ openProject() {}, dispose() {}, sendFromRenderer: msg => sends.push(msg) }),
    save() {}, saveNow() {}, selected() {}, changed() {}, approval() {}, message() {},
  });
  const adapter = new RealEngineAdapter(manager, undefined, '/fixture');
  await adapter.sendInstruction({ idempotencyKey: 'one-instruction', instruction: 'do this once' });
  const id = manager.list()[0].id;
  expect(manager.get(id).inputs!.map(i => i.text)).toEqual(['do this once']);
  manager.receive(id, { t: 'ready', protocol: 3 } as any);
  manager.receive(id, { t: 'event', name: 'spinner_state', args: ['idle', ''] });
  expect(sends).toEqual([{ t: 'input', text: 'do this once' }]);
});
