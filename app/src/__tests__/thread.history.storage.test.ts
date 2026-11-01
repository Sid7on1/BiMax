import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ThreadStorage } from '../main/thread.storage';
import { initialEngineState } from '../renderer/src/engine.state';
import type { SavedThread } from '../main/thread.manager';

const LIMIT = 32 * 1024 * 1024;
const saved = (content = 'kept', id = 'history'): SavedThread => ({
  summary: { id, root: '/fixture', title: 'Retained conversation', updatedAt: 1, status: 'stopped', peers: [] },
  state: { ...initialEngineState, items: [{ kind: 'msg', msg: { id: 'answer', role: 'assistant', content, timestamp: '2026-10-31T00:00:00Z' } }] }, inputs: [],
});
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-history-storage-')); });
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

test.each(['immediate', 'coalesced', 'final'])('%s publication refuses oversized bytes without replacing a reloadable snapshot', async kind => {
  const notices: unknown[] = [];
  const store = new ThreadStorage(dir, { onFailure: m => notices.push(m), setTimeout: () => undefined });
  store.saveNow(saved());
  const original = fs.readFileSync(path.join(dir, 'history.json'));
  const large = saved('x'.repeat(LIMIT));
  if (kind === 'immediate') expect(() => store.saveNow(large)).toThrow(/history.*limit|history.*large/i);
  else if (kind === 'final') await expect(store.writeFinal(large)).rejects.toThrow(/history.*limit|history.*large/i);
  else {
    store.save(large); await store.flush();
    expect(notices.at(-1)).toMatch(/history.*limit|history.*large/i);
    expect(store.unsaved()).toBe(1);
  }
  expect(fs.readFileSync(path.join(dir, 'history.json'))).toEqual(original);
  expect(store.load()[0].state.items).toEqual(saved().state.items);
  expect(fs.readdirSync(dir).filter(n => n.endsWith('.tmp'))).toEqual([]);
  // An oversized final attempt must not tombstone later valid writes.
  store.save(saved('later valid update'));
  await store.flush();
  expect(store.load()[0].state.items).toEqual(saved('later valid update').state.items);
});

test('the boundary is encoded bytes: exact-limit Unicode round-trips; one byte over refuses', () => {
  const store = new ThreadStorage(dir);
  const base = Buffer.byteLength(JSON.stringify(saved('')));
  const room = LIMIT - base;
  const content = '界'.repeat(Math.floor(room / 3)) + 'x'.repeat(room % 3);
  expect(Buffer.byteLength(JSON.stringify(saved(content)))).toBe(LIMIT);
  store.saveNow(saved(content));
  expect((store.load()[0].state.items[0] as any).msg.content).toBe(content);
  expect(() => store.saveNow(saved(content + 'x'))).toThrow(/history.*limit|history.*large/i);
  expect(fs.statSync(path.join(dir, 'history.json')).size).toBe(LIMIT);
});

test('existing oversized main and archived files remain discoverable without reading their bodies', async () => {
  const file = path.join(dir, 'large.json'), archived = path.join(dir, 'archive');
  fs.mkdirSync(archived);
  // Sparse files need no enormous JS allocation and must never be parsed on startup.
  for (const name of [file, path.join(archived, 'large.json')]) {
    fs.writeFileSync(name, 'retained original bytes'); fs.truncateSync(name, LIMIT + 1);
  }
  const read = jest.spyOn(fs, 'readFileSync');
  const asyncRead = jest.spyOn(fsp, 'readFile');
  const store = new ThreadStorage(dir);
  expect(store.load()).toEqual([]);
  await expect(store.archived()).resolves.toEqual([]);
  expect(store.recoverable()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'large', archived: false, reason: 'oversized', bytes: LIMIT + 1 }),
    expect.objectContaining({ id: 'large', archived: true, reason: 'oversized', bytes: LIMIT + 1 }),
  ]));
  expect(read.mock.calls.some(([name]) => String(name) === file)).toBe(false);
  expect(asyncRead.mock.calls.some(([name]) => String(name).endsWith('/large.json'))).toBe(false);
  await expect(store.unarchive('large')).rejects.toThrow(/history.*limit|history.*large/i);
  expect(fs.statSync(path.join(archived, 'large.json')).size).toBe(LIMIT + 1);
});

test('unreadable snapshots are reported and cannot be silently overwritten by a small placeholder', () => {
  const file = path.join(dir, 'history.json'); fs.writeFileSync(file, '{broken original');
  const store = new ThreadStorage(dir); expect(store.load()).toEqual([]);
  expect(store.recoverable()).toEqual([expect.objectContaining({ id: 'history', reason: 'unreadable' })]);
  expect(() => store.saveNow(saved())).toThrow(/recover|recovery/i);
  expect(fs.readFileSync(file, 'utf8')).toBe('{broken original');
});

test('invalid UTF-8 is retained for recovery rather than silently replacing damaged content', () => {
  const text = JSON.stringify(saved('original'));
  const offset = text.indexOf('original');
  const bytes = Buffer.concat([Buffer.from(text.slice(0, offset)), Buffer.from([0xff]), Buffer.from(text.slice(offset + 8))]);
  const file = path.join(dir, 'history.json'); fs.writeFileSync(file, bytes);
  const store = new ThreadStorage(dir);
  expect(store.load()).toEqual([]);
  expect(store.recoverable()).toEqual([expect.objectContaining({ id: 'history', reason: 'unreadable' })]);
  expect(fs.readFileSync(file)).toEqual(bytes);
});

test('short filesystem reads preserve exact text; growth during reading is retained as unavailable', () => {
  const store = new ThreadStorage(dir); store.saveNow(saved('complete Unicode 界'));
  const actualRead = fs.readSync.bind(fs);
  const read = jest.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
    actualRead(fd, buffer, offset, Math.min(length, 7), position)) as any);
  expect(store.load()[0].state.items).toEqual(saved('complete Unicode 界').state.items);
  read.mockRestore();
  let changed = false;
  jest.spyOn(fs, 'readSync').mockImplementation(((...args: any[]) => {
    const n = (actualRead as any)(...args);
    if (!changed) { changed = true; fs.appendFileSync(path.join(dir, 'history.json'), ' '); }
    return n;
  }) as any);
  expect(store.load()).toEqual([]);
  expect(store.recoverable()[0].reason).toBe('unreadable');
  expect(fs.existsSync(path.join(dir, 'history.json'))).toBe(true);
});
