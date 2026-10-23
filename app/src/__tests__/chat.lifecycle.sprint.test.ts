import type {} from '../renderer/src/global';
import { contextBridge, ipcRenderer } from 'electron';
import { useEffect } from 'react';
import '../preload/index';
import { useEngine } from '../renderer/src/useEngine';
import { initialEngineState } from '../renderer/src/engine.state';

jest.mock('electron', () => {
  const { EventEmitter } = require('node:events');
  return { contextBridge: { exposeInMainWorld: jest.fn() },
    ipcRenderer: Object.assign(new EventEmitter(), { send: jest.fn(), invoke: jest.fn() }), webUtils: {} };
});

// Keep hook cells across renders while exercising the actual preload subscriptions and reducer.
let mockCells: unknown[] = [];
let mockCursor = 0;
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: (init: unknown) => {
    const i = mockCursor++;
    if (!(i in mockCells)) mockCells[i] = typeof init === 'function' ? init() : init;
    return [mockCells[i], jest.fn()];
  },
  useRef: (value: unknown) => {
    const i = mockCursor++;
    if (!(i in mockCells)) mockCells[i] = { current: value };
    return mockCells[i];
  },
  useCallback: (fn: unknown) => fn,
  useEffect: jest.fn(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

const api = (contextBridge.exposeInMainWorld as jest.Mock).mock.calls[0][1];
const emit = (channel: string, ...args: unknown[]) => (ipcRenderer as any).emit(channel, {}, ...args);
const select = (id: string) => emit('threads:selected', { id, state: { ...initialEngineState, threadId: id } });
const message = (msg: unknown, id = 'A') => emit('engine:msg', msg, id);
let owner: ReturnType<typeof useEngine>;
let cleanup: () => void;
function render() { mockCursor = 0; owner = useEngine(); return owner; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.useFakeTimers(); mockCells = []; mockCursor = 0;
  (useEffect as jest.Mock).mockClear();
  (ipcRenderer.send as jest.Mock).mockReset();
  (ipcRenderer.invoke as jest.Mock).mockReset();
  (globalThis as any).window = { bimax: api };
  render();
  cleanup = (useEffect as jest.Mock).mock.calls[0][0]();
  select('A');
});
afterEach(() => {
  cleanup(); jest.clearAllTimers(); jest.useRealTimers();
  delete (globalThis as any).window;
});

test('answered config and catalogue requests release their timers immediately', async () => {
  const config = owner.configGet(); const catalog = owner.catalogGet();
  message({ t: 'configResult', id: 1, config: { mode: 'code' } });
  message({ t: 'catalogResult', id: 1, providers: [], models: [], error: 'fixture' });
  expect(await config).toEqual({ mode: 'code' });
  expect((await catalog).error).toBe('fixture');
  expect(jest.getTimerCount()).toBe(0);
});

test('an immediate bridge reply cannot leave a newly armed timeout behind', async () => {
  (ipcRenderer.send as jest.Mock).mockImplementation((channel, msg) => {
    if (channel === 'engine:send' && msg.t === 'configGet') message({ t: 'configResult', id: msg.id, config: { mode: 'code' } });
  });
  expect(await owner.configGet()).toEqual({ mode: 'code' });
  expect(jest.getTimerCount()).toBe(0);
});

test('attachment requests share one owner subscription, and settle without retaining timers', async () => {
  const before = (ipcRenderer as any).listenerCount('engine:msg');
  const a = owner.ingestAttachment('/fixture/a.txt'); const b = owner.ingestAttachment('/fixture/b.txt');
  const done = jest.fn(); void a.then(done);
  expect((ipcRenderer as any).listenerCount('engine:msg')).toBe(before);
  message({ t: 'queryResult', id: 1, items: [{ label: 'read', value: '2' }] });
  message({ t: 'queryResult', id: 2, items: [{ label: 'read', value: '3' }] });
  await Promise.resolve(); expect(done).toHaveBeenCalled();
  expect(await a).toEqual({ ok: true, chunks: 2, reason: '' });
  expect((await b).chunks).toBe(3);
  expect(jest.getTimerCount()).toBe(0);
  expect(owner.store.getState().completions.items).toEqual([]);
});

test.each(['Thread changed', 'Project changed', 'Engine exited', 'Engine failed', 'Engine restarting', 'Engine stopping', 'Renderer closed'])(
  '%s settles every pending request and removes all request timers/listeners', async reason => {
    const config = owner.configGet(); const catalog = owner.catalogGet(); const attachment = owner.ingestAttachment('/fixture/report.txt');
    const done = jest.fn(); const configDone = jest.fn(); const catalogDone = jest.fn();
    void attachment.then(done); void config.then(configDone); void catalog.then(catalogDone);
    if (reason === 'Thread changed') select('B');
    if (reason === 'Project changed') emit('app:project', '/fixture/B', 2);
    if (reason.startsWith('Engine ')) emit('engine:state', reason.slice(7), 'fixture lifecycle', 'A');
    if (reason === 'Renderer closed') cleanup();
    await Promise.resolve();
    expect(done).toHaveBeenCalled();
    expect(configDone).toHaveBeenCalled(); expect(catalogDone).toHaveBeenCalled();
    expect(await config).toEqual({});
    expect((await catalog).error).toContain(reason);
    expect(await attachment).toEqual({ ok: false, chunks: 0, reason });
    expect(jest.getTimerCount()).toBe(0);
    expect((ipcRenderer as any).listenerCount('engine:msg')).toBe(reason === 'Renderer closed' ? 0 : 1);
  },
);

test('a synchronous bridge failure settles as a visible failure and releases the timer', async () => {
  (ipcRenderer.send as jest.Mock).mockImplementation(() => { throw new Error('bridge closed'); });
  expect((await owner.catalogGet()).error).toContain('bridge closed');
  expect(jest.getTimerCount()).toBe(0);
});

test('a deadline resolves once and removes the pending request before a late answer', async () => {
  const result = owner.catalogGet(); const done = jest.fn(); void result.then(done);
  jest.advanceTimersByTime(30_000);
  await Promise.resolve(); expect(done).toHaveBeenCalledTimes(1);
  expect((await result).error).toContain('did not answer');
  message({ t: 'catalogResult', id: 1, providers: [], models: [], error: 'late' });
  await Promise.resolve();
  expect(done).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test.each(['same chat', 'different chat'])('a late approval acknowledgement preserves a newer card in %s', async variant => {
  const answer = deferred<boolean>();
  (ipcRenderer.invoke as jest.Mock).mockReturnValue(answer.promise);
  const card = (id: number, token: string) => ({ t: 'request', id, kind: 'prompt', question: 'Change?', options: ['Yes'], approvalToken: token });
  message(card(1, 'old'));
  render(); owner.reply(1, 'Yes');
  if (variant === 'different chat') select('B');
  message(card(2, 'new'), variant === 'different chat' ? 'B' : 'A');
  answer.resolve(true); await Promise.resolve(); await Promise.resolve();
  expect(owner.store.getState().request).toMatchObject({ id: 2, approvalToken: 'new' });
});

test('a refused old approval lookup cannot dismiss the current card after a switch', async () => {
  const answer = deferred<boolean>(); const approvals = deferred<unknown[]>();
  (ipcRenderer.invoke as jest.Mock).mockImplementation(channel => channel === 'threads:reply' ? answer.promise : approvals.promise);
  message({ t: 'request', id: 1, kind: 'prompt', approvalToken: 'old' });
  render(); owner.reply(1, 'Yes');
  answer.resolve(false); await Promise.resolve();
  select('B'); message({ t: 'request', id: 2, kind: 'prompt', approvalToken: 'new' }, 'B');
  approvals.resolve([]); await Promise.resolve(); await Promise.resolve();
  expect(owner.store.getState().request).toMatchObject({ id: 2, approvalToken: 'new' });
});

test('successful approval acknowledgement closes exactly its own current card', async () => {
  (ipcRenderer.invoke as jest.Mock).mockResolvedValue(true);
  message({ t: 'request', id: 1, kind: 'prompt', approvalToken: 'current' });
  render(); owner.reply(1, 'Yes'); await Promise.resolve();
  expect(owner.store.getState().request).toBeNull();
});

test('an approval id reused with a new token cannot be dismissed by the old acknowledgement', async () => {
  const answer = deferred<boolean>();
  (ipcRenderer.invoke as jest.Mock).mockReturnValue(answer.promise);
  message({ t: 'request', id: 1, kind: 'prompt', approvalToken: 'old' });
  render(); owner.reply(1, 'Yes');
  message({ t: 'request', id: 1, kind: 'prompt', approvalToken: 'new' });
  answer.resolve(true); await Promise.resolve();
  expect(owner.store.getState().request).toMatchObject({ id: 1, approvalToken: 'new' });
});

test('a Thread boundary remains required even when a fixture reuses the card id and token', async () => {
  const answer = deferred<boolean>();
  (ipcRenderer.invoke as jest.Mock).mockReturnValue(answer.promise);
  const card = { t: 'request', id: 1, kind: 'prompt', approvalToken: 'fixture-token' };
  message(card); render(); owner.reply(1, 'Yes');
  select('B'); message(card, 'B');
  answer.resolve(true); await Promise.resolve();
  expect(owner.store.getState().request).toEqual(card);
});

test('a new card id remains required even when a fixture reuses its token', async () => {
  const answer = deferred<boolean>();
  (ipcRenderer.invoke as jest.Mock).mockReturnValue(answer.promise);
  message({ t: 'request', id: 1, kind: 'prompt', approvalToken: 'fixture-token' });
  render(); owner.reply(1, 'Yes');
  message({ t: 'request', id: 2, kind: 'prompt', approvalToken: 'fixture-token' });
  answer.resolve(true); await Promise.resolve();
  expect(owner.store.getState().request).toMatchObject({ id: 2 });
});

test('a failed approval inventory read preserves the current card for retry', async () => {
  (ipcRenderer.invoke as jest.Mock).mockImplementation(channel => channel === 'threads:reply'
    ? Promise.resolve(false) : Promise.reject(new Error('inventory offline')));
  message({ t: 'request', id: 1, kind: 'prompt', approvalToken: 'current' });
  render(); owner.reply(1, 'Yes');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(owner.store.getState().request).toMatchObject({ id: 1, approvalToken: 'current' });
});

test('old Thread replies cannot settle requests made after switching', async () => {
  select('B'); const attachment = owner.ingestAttachment('/fixture/b.txt'); const done = jest.fn(); void attachment.then(done);
  message({ t: 'queryResult', id: 1, items: [{ label: 'read', value: '99' }] }, 'A');
  await Promise.resolve(); expect(done).not.toHaveBeenCalled();
  message({ t: 'queryResult', id: 1, items: [{ label: 'read', value: '2' }] }, 'B');
  expect((await attachment).chunks).toBe(2);
});
