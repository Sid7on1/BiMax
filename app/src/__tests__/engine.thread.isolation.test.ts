/// <reference path="../renderer/src/global.d.ts" />
import { contextBridge, ipcRenderer } from 'electron';
import { useEffect, useState } from 'react';
import '../preload/index';
import { useEngine } from '../renderer/src/useEngine';
import { engineReducer, initialEngineState, type EngineUiState } from '../renderer/src/engine.state';
import type { Outbound } from '../renderer/src/protocol';
import { Composer } from '../renderer/src/components/Composer';

jest.mock('electron', () => {
  const { EventEmitter } = require('node:events');
  return {
    contextBridge: { exposeInMainWorld: jest.fn() },
    ipcRenderer: Object.assign(new EventEmitter(), { send: jest.fn(), invoke: jest.fn() }),
    webUtils: {},
  };
});

// Run the hook's actual subscriptions without a DOM. No render happens after selecting a Thread:
// this deliberately tests IPC arriving before React's next render, rather than a refreshed closure.
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: jest.fn((init: unknown) => [typeof init === 'function' ? init() : init, jest.fn()]),
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (fn: unknown) => fn,
  useEffect: jest.fn(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
jest.mock('../renderer/src/useDictation', () => ({ useDictation: () => ({ state: 'idle', available: false }) }));
jest.mock('../renderer/src/useTalk', () => ({ useTalk: () => ({ active: false }) }));

const api = (contextBridge.exposeInMainWorld as jest.Mock).mock.calls[0][1];
const emit = (channel: string, ...args: unknown[]) => (ipcRenderer as any).emit(channel, {}, ...args);
const event = (name: string, ...args: unknown[]): Outbound => ({ t: 'event', name, args } as Outbound);
const restored = event('session_restore', { id: 'engine-session-not-thread-id', entries: [
  { id: 'saved-user', role: 'user', content: 'old request' },
  { id: 'saved-tool', role: 'tool', toolName: 'ReadFileTool', output: 'report', status: 'success' },
  { id: 'saved-answer', role: 'assistant', content: 'saved answer' },
] });
const selected = (id: string, state: Partial<EngineUiState> = {}) =>
  emit('threads:selected', { id, state: { ...initialEngineState, ...state, threadId: id } });

let owner: ReturnType<typeof useEngine>;
let cleanups: Array<() => void>;
beforeEach(() => {
  jest.useFakeTimers();
  (useEffect as jest.Mock).mockClear();
  (globalThis as any).window = { bimax: api };
  owner = useEngine();
  cleanups = (useEffect as jest.Mock).mock.calls.map(([effect]) => effect()).filter(Boolean);
});
afterEach(() => {
  cleanups.forEach(cleanup => cleanup());
  jest.clearAllTimers();
  jest.useRealTimers();
  delete (globalThis as any).window;
  delete (globalThis as any).localStorage;
});

test('the real preload forwards ownership and removes its listeners on unsubscribe', () => {
  const message = jest.fn(); const lifecycle = jest.fn();
  const offMsg = api.onMessage(message); const offState = api.onEngineState(lifecycle);
  emit('engine:msg', restored, 'A');
  emit('engine:state', 'exited', 'crashed', 'A');
  expect(message).toHaveBeenCalledWith(restored, 'A');
  expect(lifecycle).toHaveBeenCalledWith('exited', 'crashed', 'A');
  offMsg(); offState();
  emit('engine:msg', restored, 'B');
  emit('engine:state', 'ready', '', 'B');
  expect(message).toHaveBeenCalledTimes(1);
  expect(lifecycle).toHaveBeenCalledTimes(1);
});

test('late restore, tools, text, approvals and lifecycle from A leave selected B exactly intact', () => {
  selected('A');
  emit('engine:msg', event('stream_token', 'buffered A'), 'A');
  selected('B');
  owner.submit('where is the report man');
  const before = owner.store.getState();
  const stale: Outbound[] = [
    restored, event('stream_token', 'late A'), event('thinking', 'old thinking'),
    event('tool_call_result', { id: 'old-tool', toolName: 'BashTool', output: 'old output' }),
    { t: 'request', id: 1, kind: 'approve', title: 'Old approval' } as unknown as Outbound,
    { t: 'ready', protocol: 999 } as Outbound,
    event('clear'), event('review_update', { files: [], status: 'pending' }),
  ];
  for (const msg of stale) emit('engine:msg', msg, 'A');
  emit('engine:msg', restored); // Unscoped output cannot impersonate a selected Thread either.
  emit('engine:state', 'exited', 'A crashed', 'A');
  emit('engine:state', 'exited', 'missing owner');
  jest.advanceTimersByTime(100);
  expect(owner.store.getState()).toBe(before);
  expect(before.items).toHaveLength(1);
  expect(before.items[0]).toMatchObject({ kind: 'msg', msg: { content: 'where is the report man' } });
  emit('engine:msg', event('stream_token', 'B reply'), 'B');
  jest.advanceTimersByTime(100);
  expect(owner.store.getState().streaming).toBe('B reply');
});

test('same-Thread restore still hydrates messages and tools exactly once, even after a switch back', () => {
  selected('A'); selected('B'); selected('A');
  emit('engine:msg', restored, 'A');
  emit('engine:msg', restored, 'A');
  expect(owner.store.getState().items).toHaveLength(3);
  expect(owner.store.getState().items[1]).toMatchObject({ kind: 'tool', call: { id: 'saved-tool', output: 'report' } });
  emit('engine:state', 'ready', '', 'A');
  expect(owner.store.getState().engine.state).toBe('ready');
});

test('a new Thread starts streaming before the old frame fires without merging old text', () => {
  selected('A');
  emit('engine:msg', event('stream_token', 'buffered A'), 'A');
  selected('B');
  emit('engine:msg', event('stream_token', 'fresh B'), 'B');
  jest.advanceTimersByTime(100);
  expect(owner.store.getState().streaming).toBe('fresh B');
});

test('unscoped legacy events work only before a Thread is adopted', () => {
  emit('engine:msg', restored);
  expect(owner.store.getState().items).toHaveLength(3);
  selected('B');
  const before = owner.store.getState();
  emit('engine:msg', restored);
  expect(owner.store.getState()).toBe(before);
});

test('config and catalogue replies with colliding request ids cannot resolve B from A', async () => {
  selected('B');
  const config = owner.configGet(); const catalogue = owner.catalogGet();
  const configDone = jest.fn(); const catalogueDone = jest.fn();
  void config.then(configDone); void catalogue.then(catalogueDone);
  emit('engine:msg', { t: 'configResult', id: 1, config: { wrong: 'A' } }, 'A');
  emit('engine:msg', { t: 'catalogResult', id: 1, providers: [], models: [], error: 'A' }, 'A');
  await Promise.resolve();
  expect(configDone).not.toHaveBeenCalled(); expect(catalogueDone).not.toHaveBeenCalled();
  emit('engine:msg', { t: 'configResult', id: 1, config: { right: 'B' } }, 'B');
  emit('engine:msg', { t: 'catalogResult', id: 1, providers: [], models: [], error: 'B' }, 'B');
  expect(await config).toEqual({ right: 'B' });
  expect((await catalogue).error).toBe('B');
});

test('completion and attachment replies are also scoped before consumption', async () => {
  selected('B');
  owner.query('report');
  emit('engine:msg', { t: 'queryResult', id: 1, items: [{ label: 'wrong', value: 'A' }] }, 'A');
  expect(owner.store.getState().completions.items).toEqual([]);
  emit('engine:msg', { t: 'queryResult', id: 1, items: [{ label: 'right', value: 'B' }] }, 'B');
  expect(owner.store.getState().completions.items[0].label).toBe('right');
  const attachment = owner.ingestAttachment('/fixture/report.txt'); const done = jest.fn();
  void attachment.then(done);
  emit('engine:msg', { t: 'queryResult', id: 2, items: [{ label: 'read', value: '9' }] }, 'A');
  await Promise.resolve(); expect(done).not.toHaveBeenCalled();
  emit('engine:msg', { t: 'queryResult', id: 2, items: [{ label: 'read', value: '2' }] }, 'B');
  expect(await attachment).toEqual({ ok: true, chunks: 2, reason: '' });
});

test('the reducer independently rejects a stale restore and lifecycle envelope', () => {
  const state = { ...initialEngineState, threadId: 'B' };
  expect(engineReducer(state, { type: 'outbound', msg: restored, threadId: 'A' })).toBe(state);
  expect(engineReducer(state, { type: 'outbound', msg: restored, threadId: undefined })).toBe(state);
  expect(engineReducer(state, { type: 'engineState', state: 'exited', detail: 'A', threadId: 'A' })).toBe(state);
  expect(engineReducer(state, { type: 'outbound', msg: restored, threadId: 'B' }).items).toHaveLength(3);
  // Manager-side folding already selects the owning record; the session id is deliberately different.
  expect(engineReducer(state, { type: 'outbound', msg: restored }).items).toHaveLength(3);
});

test('a foreign restore or clear cannot clear the selected composer draft', () => {
  const clear = jest.fn();
  (globalThis as any).localStorage = { getItem: () => JSON.stringify({ at: Date.now(), draft: { text: 'B unsent report request', output: 'Auto' } }) };
  const draftIndex = (useState as jest.Mock).mock.results.length;
  Composer({ threadId: 'B', project: '/fixture', busy: false, mode: '', tier: '', snapshot: null,
    streamedChars: 0, completions: [], branch: null, runtime: { phase: 'ready' } as any,
    onSubmit: jest.fn(), onInterrupt: jest.fn(), onControls: jest.fn(), onCommand: jest.fn(),
    onQuery: jest.fn(), onIngest: jest.fn(), onClearCompletions: clear, onOpenModels: jest.fn() });
  const [draft, setDraft] = (useState as jest.Mock).mock.results[draftIndex].value;
  expect(draft.text).toBe('B unsent report request');
  // Exercise the component's real engine subscription; unrelated DOM/voice effects need no host.
  const [effect] = (useEffect as jest.Mock).mock.calls.find(([, deps]) => deps?.includes(clear))!;
  cleanups.push(effect());
  emit('engine:msg', restored, 'A');
  emit('engine:msg', event('clear'), 'A');
  emit('engine:msg', restored);
  expect(clear).not.toHaveBeenCalled();
  expect(setDraft).not.toHaveBeenCalled();
  emit('engine:msg', restored, 'B');
  expect(clear).toHaveBeenCalledTimes(1);
  expect(setDraft).toHaveBeenCalledWith({ text: '', output: 'Auto' });
});
