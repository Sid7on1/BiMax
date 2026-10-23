import type {} from '../renderer/src/global';
import { EventEmitter } from 'node:events';
import { subscribeQuickBootstrap } from '../renderer/src/quick.bootstrap';
import { initialEngineState } from '../renderer/src/engine.state';
import type { QuickContext, QuickThread } from '../shared/threads';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture() {
  const events = new EventEmitter();
  const context = deferred<QuickContext>(); const thread = deferred<QuickThread | null>();
  const handlers = { context: jest.fn(), thread: jest.fn(), error: jest.fn() };
  const subscribe = (channel: string, listener: (...args: any[]) => void) => {
    events.on(channel, listener); return () => { events.off(channel, listener); };
  };
  const api = { context: () => context.promise, quickCurrent: () => thread.promise,
    onContext: (cb: (value: QuickContext) => void) => subscribe('context', cb),
    onQuickThread: (cb: (value: QuickThread | null) => void) => subscribe('thread', cb) };
  const stop = subscribeQuickBootstrap(api, handlers);
  return { events, context, thread, handlers, stop };
}
const chat = (id: string): QuickThread => ({ id, title: id, root: `/fixture/${id}`, state: { ...initialEngineState, threadId: id } });

test('the initial snapshot remains usable when no newer selection arrived', async () => {
  const f = fixture(); f.thread.resolve(chat('A')); f.context.resolve({ root: '/fixture/A', source: 'initial' });
  await Promise.resolve();
  expect(f.handlers.thread).toHaveBeenCalledWith(chat('A'));
  expect(f.handlers.context).toHaveBeenCalledWith({ root: '/fixture/A', source: 'initial' }, true);
  f.stop(); expect(f.events.eventNames()).toEqual([]);
});

test.each([chat('B'), null])('a late startup snapshot cannot undo a live selection or New', async selected => {
  const f = fixture(); f.events.emit('thread', selected); f.thread.resolve(chat('A')); await Promise.resolve();
  expect(f.handlers.thread.mock.calls).toEqual([[selected]]);
  f.context.resolve({ root: null, source: 'fixture' }); f.stop();
});

test('a late Finder/context read cannot overwrite a newer folder, prompt or attachments', async () => {
  const f = fixture(); const newer = { root: '/fixture/B', source: 'Selected folder', prompt: 'new words', attachments: [] };
  f.events.emit('context', newer); f.context.resolve({ root: '/fixture/A', source: 'old Finder' }); await Promise.resolve();
  expect(f.handlers.context.mock.calls).toEqual([[newer, false]]);
  f.thread.resolve(null); f.stop();
});

test('closing the surface retires both pending startup reads and unsubscribes', async () => {
  const f = fixture(); f.stop(); f.stop();
  f.context.resolve({ root: '/fixture/A', source: 'old' }); f.thread.resolve(chat('A')); await Promise.resolve();
  expect(f.handlers.context).not.toHaveBeenCalled(); expect(f.handlers.thread).not.toHaveBeenCalled();
  expect(f.events.eventNames()).toEqual([]);
});

test('startup bridge failures name the failed read without leaving an unhandled rejection', async () => {
  const f = fixture(); f.context.reject(new Error('Finder unavailable')); f.thread.reject(new Error('chat read denied'));
  await Promise.resolve(); await Promise.resolve();
  expect(f.handlers.error.mock.calls).toEqual([
    ['Could not read folder context: Finder unavailable'], ['Could not read the current chat: chat read denied'],
  ]);
  f.stop();
});

test('retired startup failures cannot replace a new selection with an unrelated error', async () => {
  const f = fixture(); f.events.emit('context', { root: '/fixture/B', source: 'new' }); f.events.emit('thread', chat('B'));
  f.context.reject(new Error('old')); f.thread.reject(new Error('old'));
  await Promise.resolve(); await Promise.resolve();
  expect(f.handlers.error).not.toHaveBeenCalled(); f.stop();
});
