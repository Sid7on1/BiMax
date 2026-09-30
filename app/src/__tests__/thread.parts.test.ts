import { ThreadManager } from '../main/thread.manager';
import { reclaimableEngines, type EngineHolder } from '../main/thread.budget';

/**
 * The parts thread.manager.ts was split into (flaw list C16): the reclaim rule now in thread.budget.ts, and the
 * approval-reply check `send()` hands to `takeReply`. Until this file nothing tested that a reply with the wrong token
 * or an offered-nowhere choice is refused.
 */

const TTL = 1_000;
const NOW = 100_000;

function holder(id: string, over: Partial<Omit<EngineHolder, 'summary'>> & { summary?: Partial<EngineHolder['summary']> } = {}): EngineHolder {
  const { summary, ...rest } = over;
  return {
    engine: {}, inputs: [], pending: new Map(),
    ...rest,
    summary: { id, status: 'idle', updatedAt: NOW - TTL, ...summary },
  };
}

const ids = (list: EngineHolder[]) => list.map((h) => h.summary.id);

describe('reclaimableEngines: only an engine that costs the user nothing to stop', () => {
  test('each guard keeps its thread; a thread past the age limit, idle and unseen, is taken', () => {
    const threads = [
      holder('ok'),
      holder('no-engine', { engine: undefined }),
      holder('on-screen'),
      holder('working', { summary: { status: 'working' } }),
      holder('starting', { summary: { status: 'starting' } }),
      holder('queued', { inputs: [{}] }),
      holder('asking', { pending: new Map([[1, {}]]) }),
      holder('draining', { draining: Promise.resolve() }),
      holder('fresh', { summary: { updatedAt: NOW - TTL + 1 } }),
    ];
    expect(ids(reclaimableEngines(threads, { now: NOW, ttlMs: TTL, onScreen: [null, 'on-screen'] }))).toEqual(['ok']);
  });

  test('low priority goes first and high last; least recently used first within a priority', () => {
    const threads = [
      holder('high-old', { summary: { priority: 'high', updatedAt: 1 } }),
      holder('normal-new', { summary: { updatedAt: 30 } }),
      holder('low-new', { summary: { priority: 'low', updatedAt: 50 } }),
      holder('normal-old', { summary: { updatedAt: 10 } }),
      holder('low-old', { summary: { priority: 'low', updatedAt: 20 } }),
    ];
    expect(ids(reclaimableEngines(threads, { now: NOW, ttlMs: 0, onScreen: [] })))
      .toEqual(['low-old', 'low-new', 'normal-old', 'normal-new', 'high-old']);
  });
});

describe('ThreadManager: the main window selection is never reclaimed', () => {
  test('the idle sweep passes over the selected thread even when it is the oldest idle one', () => {
    const threads = new ThreadManager({
      engine: () => ({ openProject: jest.fn(), sendFromRenderer: jest.fn(), dispose: jest.fn() }),
      changed: jest.fn(), selected: jest.fn(), message: jest.fn(), approval: jest.fn(), save: jest.fn(),
    });
    const a = threads.create('/fixture/a');
    threads.start(a);
    threads.receive(a, { t: 'ready', protocol: 3 } as any);
    threads.activeId = a;
    const b = threads.create('/fixture/b');
    threads.start(b);
    threads.receive(b, { t: 'ready', protocol: 3 } as any);
    expect(threads.reapIdleEngines(Number.MAX_SAFE_INTEGER)).toEqual([b]);
  });
});

describe('approval replies: the token and the choice are checked before anything reaches the engine', () => {
  function held(request: Record<string, unknown>) {
    const approvals: any[] = [];
    const message = jest.fn();
    const engine = { openProject: jest.fn(), sendFromRenderer: jest.fn(), dispose: jest.fn() };
    const threads = new ThreadManager({
      engine: () => engine, changed: jest.fn(), selected: jest.fn(), message, save: jest.fn(),
      approval: (value) => approvals.push(value),
    });
    const id = threads.create('/fixture/approvals');
    threads.start(id);
    threads.receive(id, { t: 'ready', protocol: 3 } as any);
    threads.receive(id, { t: 'request', id: 7, kind: 'prompt', question: 'Go?', options: ['Yes', 'No', 'Maybe'], ...request } as any);
    return { threads, id, engine, message, approval: approvals[0] };
  }
  const reply = (token: string, value: string) => ({ t: 'reply', id: 7, value, approvalToken: token });

  test('the request reaches the window carrying the token its reply must quote, and the thread waits on the user', () => {
    const { threads, id, message, approval } = held({});
    expect(message).toHaveBeenLastCalledWith(id, expect.objectContaining({ t: 'request', id: 7, approvalToken: approval.token }));
    expect(threads.summary(id).status).toBe('needs-you');
  });

  test('a wrong token is refused and the approval stays open', () => {
    const { threads, id, engine, approval } = held({});
    expect(() => threads.send(id, reply('forged', 'Yes'))).toThrow('That approval has expired');
    expect(() => threads.send(id, { t: 'reply', id: 7, value: 'Yes' })).toThrow('That approval has expired');
    expect(engine.sendFromRenderer).not.toHaveBeenCalledWith(expect.objectContaining({ t: 'reply' }));
    expect(threads.approvals()).toEqual([approval]);
  });

  test('a choice the request did not offer is refused', () => {
    const { threads, id, engine, approval } = held({});
    expect(() => threads.send(id, reply(approval.token, 'Delete everything'))).toThrow('Invalid approval choice');
    expect(engine.sendFromRenderer).not.toHaveBeenCalledWith(expect.objectContaining({ t: 'reply' }));
  });

  test('an offered choice goes to the engine and the thread is working again', () => {
    const { threads, id, engine, approval } = held({});
    threads.send(id, reply(approval.token, 'Maybe'));
    expect(engine.sendFromRenderer).toHaveBeenLastCalledWith(reply(approval.token, 'Maybe'));
    expect(threads.summary(id).status).toBe('working');
    expect(threads.approvals()).toEqual([]);
    expect(() => threads.send(id, reply(approval.token, 'Maybe'))).toThrow('That approval has expired');
  });

  test('a multi-choice reply must hold only offered choices', () => {
    const { threads, id, approval } = held({ isMulti: true });
    expect(() => threads.send(id, reply(approval.token, 'Yes, Never'))).toThrow('Invalid approval choice');
    threads.send(id, reply(approval.token, 'Yes, Maybe'));
    expect(threads.approvals()).toEqual([]);
  });

  test('an ask and an input request take free text', () => {
    for (const request of [{ isAsk: true }, { kind: 'input' }]) {
      const { threads, id, approval } = held(request);
      threads.send(id, reply(approval.token, 'my own words'));
      expect(threads.approvals()).toEqual([]);
    }
  });

  test('an interrupt drops the open approval and the queue, and still reaches the engine', () => {
    const { threads, id, engine } = held({});
    threads.submit(id, 'and then this');
    threads.send(id, { t: 'interrupt' });
    expect(threads.approvals()).toEqual([]);
    expect(threads.summary(id).queued).toBeUndefined();
    expect(engine.sendFromRenderer).toHaveBeenLastCalledWith({ t: 'interrupt' });
  });
});
