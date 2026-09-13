import { EngineStore } from '../renderer/src/engine.store';
import { engineReducer, initialEngineState } from '../renderer/src/engine.state';
import { Outbound } from '../renderer/src/protocol';

const event = (name: string, ...args: unknown[]): Parameters<typeof engineReducer>[1] => ({
  type: 'outbound', msg: { t: 'event', name, args } as Outbound,
});

describe('engine domain subscriptions', () => {
  test('1,000 text batches update the live tail without repeatedly notifying the workspace', () => {
    const store = new EngineStore();
    const calls = Object.fromEntries(Object.entries(store.domains).map(([name, domain]) => {
      const listener = jest.fn();
      domain.subscribe(listener);
      return [name, listener];
    }));
    const original = store.domains.transcript.getSnapshot();
    for (let i = 0; i < 1000; i++) store.dispatch(event('stream_token', '界🙂'));
    expect(store.getState().streaming).toBe('界🙂'.repeat(1000));
    expect(calls.stream).toHaveBeenCalledTimes(1000);
    expect(calls.workspace).toHaveBeenCalledTimes(1); // empty → live only
    for (const name of ['transcript', 'task', 'review', 'settings']) expect(calls[name]).not.toHaveBeenCalled();
    expect(store.domains.transcript.getSnapshot()).toBe(original);
    const workspace = store.domains.workspace.getSnapshot();
    expect(workspace).not.toHaveProperty('streaming');
    expect(workspace).not.toHaveProperty('thinking');
    expect(workspace.hasActiveStream).toBe(true);
  });

  test('snapshots are cached, frozen and old snapshots retain their values', () => {
    const store = new EngineStore();
    const before = store.domains.stream.getSnapshot();
    expect(store.domains.stream.getSnapshot()).toBe(before);
    expect(Object.isFrozen(before)).toBe(true);
    store.dispatch(event('stream_token', 'new'));
    expect(before.streaming).toBe('');
    expect(store.domains.stream.getSnapshot().streaming).toBe('new');
    const current = store.domains.stream.getSnapshot();
    store.dispatch(event('stream_token', ''));
    expect(store.domains.stream.getSnapshot()).toBe(current);
  });

  test('every domain is current before the first notification on assistant finalization', () => {
    const store = new EngineStore();
    store.dispatch(event('stream_token', 'answer'));
    store.dispatch(event('thinking', 'reasoning'));
    let observations = 0;
    store.domains.transcript.subscribe(() => {
      observations++;
      expect(store.domains.stream.getSnapshot()).toMatchObject({ streaming: '', thinking: '' });
      expect(store.domains.workspace.getSnapshot().hasActiveStream).toBe(false);
      expect(store.domains.transcript.getSnapshot().items).toEqual([
        { kind: 'msg', msg: { id: 'final', role: 'assistant', content: 'answer' }, thought: 'reasoning' },
      ]);
    });
    store.dispatch(event('message', { id: 'final', role: 'assistant', content: 'answer' }));
    expect(observations).toBe(1);
  });

  test('requests, reviews and settings are delivered without waiting for text', () => {
    const store = new EngineStore();
    const task = jest.fn(); const review = jest.fn(); const settings = jest.fn();
    store.domains.task.subscribe(task);
    store.domains.review.subscribe(review);
    store.domains.settings.subscribe(settings);
    const request = { t: 'request', id: 7, kind: 'approve', title: 'Change file?' } as unknown as Outbound;
    store.dispatch({ type: 'outbound', msg: request });
    expect(store.domains.task.getSnapshot().request).toEqual(request);
    expect(task).toHaveBeenCalledTimes(1);
    store.dispatch(event('mode_change', 'code'));
    expect(store.domains.settings.getSnapshot().mode).toBe('code');
    expect(settings).toHaveBeenCalledTimes(1);
    store.dispatch(event('review_update', { files: [], status: 'pending' }));
    expect(review).toHaveBeenCalledTimes(1);
    store.dispatch({ type: 'engineState', state: 'exited', detail: 'stopped' });
    expect(store.domains.task.getSnapshot().request).toBeNull();
  });

  test('clear removes task data and late output cannot leak into the next task', () => {
    const store = new EngineStore();
    store.dispatch(event('stream_token', 'old'));
    store.dispatch(event('thinking', 'old thought'));
    store.dispatch(event('clear'));
    store.dispatch(event('stream_token', 'late'));
    store.dispatch(event('message', { id: 'old', role: 'assistant', content: 'late' }));
    expect(store.domains.stream.getSnapshot()).toEqual({ streaming: '', thinking: '', busy: false });
    expect(store.domains.transcript.getSnapshot().items).toEqual([]);
    expect(store.domains.workspace.getSnapshot().hasActiveStream).toBe(false);
    store.dispatch({ type: 'turnStarted' });
    store.dispatch(event('stream_token', 'fresh'));
    expect(store.domains.stream.getSnapshot().streaming).toBe('fresh');
  });

  test('project reset updates every projection and separate engine owners stay isolated', () => {
    const store = new EngineStore(); const other = new EngineStore();
    store.dispatch(event('stream_token', 'old'));
    store.dispatch({ type: 'project', dir: '/new' });
    expect(store.domains.workspace.getSnapshot().project).toBe('/new');
    expect(store.domains.stream.getSnapshot().streaming).toBe('');
    expect(other.getState()).toBe(initialEngineState);
  });

  test('unsubscribe is idempotent and a newly mounted subscriber sees the latest state', () => {
    const store = new EngineStore(); const listener = jest.fn();
    const off = store.domains.stream.subscribe(listener);
    off(); off();
    store.dispatch(event('stream_token', 'one'));
    expect(listener).not.toHaveBeenCalled();
    store.domains.stream.subscribe(listener);
    expect(store.domains.stream.getSnapshot().streaming).toBe('one');
    store.dispatch(event('stream_token', 'two'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.domains.stream.getSnapshot().streaming).toBe('onetwo');
  });

  test('mixed protocol stream retains the exact reducer end state at every boundary', () => {
    const store = new EngineStore();
    let expected = initialEngineState;
    const actions = [
      event('spinner_state', 'working', 'Reading'), event('thinking', 'because'),
      event('stream_token', '\ud83d'), event('stream_token', '\ude42界'),
      event('tool_call', { id: 'read', toolName: 'read', status: 'running' }),
      event('tool_call_result', { id: 'read', toolName: 'read', status: 'success', output: 'ok' }),
      event('message', { id: 'answer', role: 'assistant', content: '🙂界' }),
      event('spinner_state', 'idle'), event('session_restore', { entries: [
        { id: 'restored', role: 'assistant', content: 'saved' },
      ] }), event('clear'), event('stream_token', 'retired'),
    ];
    for (const action of actions) {
      expected = engineReducer(expected, action);
      store.dispatch(action);
      expect(store.getState()).toEqual(expected);
      expect(store.domains.transcript.getSnapshot().items).toEqual(expected.items);
      expect(store.domains.stream.getSnapshot().streaming).toBe(expected.streaming);
    }
  });
});
