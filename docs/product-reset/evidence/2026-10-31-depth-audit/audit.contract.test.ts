/** Audit-only desired contracts. Red tests intentionally preserve current defects, outside CI roots. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ThreadStorage } from '../../../../app/src/main/thread.storage';
import { ThreadManager, type SavedThread } from '../../../../app/src/main/thread.manager';
import { engineReducer, initialEngineState } from '../../../../app/src/renderer/src/engine.state';
import { RealEngineAdapter } from '../../../../app/src/main/responder/adapter';
import { VectorStore } from '../../../../src/memory/vector.store';
import { recallForTurn, answeringExcerpt } from '../../../../src/memory/recall';
import type { EmbeddingBackend } from '../../../../src/memory/embeddings';

const event = (name: string, ...args: unknown[]) => ({ t: 'event', name, args } as any);
const saved = (content = '', inputs: any[] = []): SavedThread => ({
  summary: { id: 'audit-thread', title: 'Synthetic audit', root: '/fixture', updatedAt: 1, status: 'idle', peers: [] } as any,
  state: { ...initialEngineState, items: content ? [{ kind: 'msg', msg: { id: 'm', role: 'assistant', content, timestamp: '2026-10-31T00:00:00Z' } }] : [] }, inputs,
});
const input = { id: 'accepted', text: 'append exactly once', display: 'append exactly once', state: 'queued', at: 1 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function manager(storage?: ThreadStorage, initial: SavedThread[] = []) {
  const engines: any[] = [];
  const value = new ThreadManager({
    engine: () => { const e = { openProject: jest.fn(), sendFromRenderer: jest.fn(), dispose: jest.fn() }; engines.push(e); return e; },
    save: v => storage?.save(v), saveNow: v => storage?.saveNow(v),
    changed: jest.fn(), selected: jest.fn(), message: jest.fn(), approval: jest.fn(),
  }, initial);
  return { value, engines };
}

test('CONTROL: a newer ordinary save reloads exact bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-audit-control-'));
  try {
    const storage = new ThreadStorage(dir);
    storage.saveNow(saved('first'));
    storage.save(saved('second'));
    await storage.flush();
    expect((storage.load()[0].state.items[0] as any).msg.content).toBe('second');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('A01: an old async rename already in flight must not replace a newer acknowledged input', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-audit-rename-'));
  const entered = deferred(), release = deferred();
  const actualRename = fsp.rename.bind(fsp);
  const spy = jest.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
    entered.resolve();
    await release.promise;
    return actualRename(from, to);
  });
  const storage = new ThreadStorage(dir);
  try {
    storage.save(saved('old'));
    const writing = storage.flush();
    await entered.promise;
    storage.saveNow(saved('new', [input]));
    expect(storage.load()[0].inputs).toEqual([input]); // acknowledged before old rename completes
    release.resolve();
    await writing;
    expect(storage.load()[0].inputs).toEqual([input]);
  } finally { release.resolve(); spy.mockRestore(); await storage.flush(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('A02: a failed sent-state save must not leave an executed request eligible for automatic replay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-audit-admission-'));
  const storage = new ThreadStorage(dir);
  const first = manager(storage);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  let spy: jest.SpyInstance | undefined;
  try {
    const id = first.value.create('/fixture');
    first.value.start(id);
    first.value.receive(id, { t: 'ready', protocol: 3 } as any);
    const actualWrite = fs.writeFileSync.bind(fs);
    spy = jest.spyOn(fs, 'writeFileSync').mockImplementation((...args: any[]) => {
      if (typeof args[1] === 'string' && args[1].includes('"state":"sent"'))
        throw Object.assign(new Error('synthetic ENOSPC at sent-state publication'), { code: 'ENOSPC' });
      return (actualWrite as any)(...args);
    });
    // Refusing dispatch when durable admission fails is an acceptable repair.
    let refused = false;
    try { first.value.submit(id, input.text); } catch { refused = true; }
    if (refused) {
      expect(first.engines[0].sendFromRenderer).not.toHaveBeenCalledWith({ t: 'input', text: input.text });
      return;
    }
    expect(first.engines[0].sendFromRenderer).toHaveBeenCalledWith({ t: 'input', text: input.text });
    const diskAtCrash = storage.load(); // crash before 500ms coalesced retry
    spy.mockRestore(); spy = undefined;
    const restarted = manager(undefined, diskAtCrash);
    restarted.value.start(id);
    restarted.value.receive(id, { t: 'ready', protocol: 3 } as any);
    const replays = restarted.engines[0].sendFromRenderer.mock.calls.filter(([m]: any[]) => m.t === 'input' && m.text === input.text);
    expect(replays).toHaveLength(0);
  } finally { spy?.mockRestore(); warn.mockRestore(); await storage.flush(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('A03: an oversized snapshot is either explicitly refused or successfully reloadable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-audit-history-'));
  try {
    const storage = new ThreadStorage(dir);
    try { storage.saveNow(saved('x'.repeat(32 * 1024 * 1024))); }
    catch (error) { expect(String(error)).toMatch(/size|large|limit|history|budget/i); return; }
    expect(fs.statSync(path.join(dir, 'audit-thread.json')).size).toBeGreaterThan(32 * 1024 * 1024);
    expect(storage.load()).toHaveLength(1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('A04: user echoes must adopt the matching earlier queued bubble, preserving order without duplicates', () => {
  let state = engineReducer(initialEngineState, { type: 'localUser', text: 'first' });
  state = engineReducer(state, { type: 'localUser', text: 'second' });
  state = engineReducer(state, { type: 'outbound', msg: event('message', { id: 'engine-first', role: 'user', content: 'first', timestamp: '2026-10-31T00:00:00Z' }) });
  const words = state.items.filter(x => x.kind === 'msg').map((x: any) => x.msg.content);
  expect(words).toEqual(['first', 'second']);
});

test('A05: engine failure settles an app-owned approval promise as refused', async () => {
  const { value } = manager();
  const id = value.create('/fixture'); value.start(id);
  value.receive(id, { t: 'ready', protocol: 3 } as any);
  let result: string | undefined;
  void value.askOnBehalf(id, 'Allow synthetic read?', ['Allow', 'Not now']).then(r => { result = r; });
  value.lifecycle(id, 'failed', 'synthetic worker failure');
  await Promise.resolve(); await Promise.resolve();
  expect(result).toBe('');
});

test('CONTROL: explicit Stop settles the same app-owned approval as refused', async () => {
  const { value } = manager();
  const id = value.create('/fixture'); value.start(id);
  value.receive(id, { t: 'ready', protocol: 3 } as any);
  const answer = value.askOnBehalf(id, 'Allow synthetic read?', ['Allow', 'Not now']);
  value.stop(id);
  await expect(answer).resolves.toBe('');
});

test('A06: first remote instruction with a default workspace enqueues exactly one user request', async () => {
  const { value } = manager();
  const adapter = new RealEngineAdapter(value, undefined, '/fixture');
  await adapter.sendInstruction({ idempotencyKey: 'synthetic-once', instruction: 'do this once' });
  const id = value.list()[0].id;
  expect(value.get(id).inputs!.map(x => x.text)).toEqual(['do this once']);
});

test('CONTROL: successful sent-state persistence prevents automatic replay on restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-audit-admission-control-'));
  const storage = new ThreadStorage(dir);
  try {
    const first = manager(storage);
    const id = first.value.create('/fixture'); first.value.start(id);
    first.value.receive(id, { t: 'ready', protocol: 3 } as any);
    first.value.submit(id, input.text);
    const restarted = manager(undefined, storage.load());
    restarted.value.start(id); restarted.value.receive(id, { t: 'ready', protocol: 3 } as any);
    expect(restarted.engines[0].sendFromRenderer.mock.calls.filter(([m]: any[]) => m.t === 'input')).toHaveLength(0);
  } finally { await storage.flush(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CONTROL: a single optimistic user bubble adopts the engine echo', () => {
  let state = engineReducer(initialEngineState, { type: 'localUser', text: 'first' });
  state = engineReducer(state, { type: 'outbound', msg: event('message', { id: 'engine-first', role: 'user', content: 'first', timestamp: '2026-10-31T00:00:00Z' }) });
  expect(state.items).toHaveLength(1);
  expect((state.items[0] as any).msg.id).toBe('engine-first');
});

test('A07: zero-similarity memory with no lexical overlap must not be injected as relevant evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-audit-recall-'));
  try {
    const backend: EmbeddingBackend = { id: 'audit-orthogonal@2', dimensions: 2,
      embed: async (texts, role) => texts.map(() => role === 'query' ? [0, 1] : [1, 0]) };
    const store = new VectorStore(backend, null, { storePath: path.join(dir, 'memory.json'), dedup: false });
    await store.storeDocument('irrelevant', 'Apricot orchards require seasonal pruning.', ['note']);
    const query = 'Explain quantum neutrino oscillation parameters';
    expect(await store.semanticSearch(query, 3, 0, { mode: 'lexical' })).toHaveLength(0);
    expect(await recallForTurn(store, query)).toBeNull();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('A08: a bounded excerpt must preserve the answering clause on a long matching line', () => {
  const line = 'Background context '.repeat(40) + 'Orion launch authorization code is VIOLET-73';
  const excerpt = answeringExcerpt(line, 'Orion launch authorization code', 120);
  expect(excerpt.length).toBeLessThanOrEqual(120);
  expect(excerpt).toContain('VIOLET-73');
});

test('CONTROL: a short answering line preserves the exact fact', () => {
  expect(answeringExcerpt('Orion code is VIOLET-73', 'Orion code', 120)).toBe('Orion code is VIOLET-73');
});
