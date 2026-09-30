import { ThreadManager } from '../main/thread.manager';
import { popupDecisions } from '../main/approval.notification';
import { engineReducer, initialEngineState, type EngineUiState } from '../renderer/src/engine.state';

/**
 * A question was asked twice and one copy stuck (owner report, 2026-09-30): a project's approval showed as the main
 * window's card AND in the approval popup. Answering in the popup closed the popup, but the main window's card kept its
 * own copy of the thread's state and was never told; its Allow and Deny were then refused as expired, so it stayed.
 */

type View = { state: EngineUiState };

function fixture() {
  const approvals: any[] = [];
  const views = new Map<string, View>();
  const engine = { openProject: jest.fn(), sendFromRenderer: jest.fn(), dispose: jest.fn() };
  const threads = new ThreadManager({
    engine: () => engine, changed: jest.fn(), selected: jest.fn(), save: jest.fn(),
    approval: (value) => approvals.push(value),
    timer: () => () => {},
    // A window showing the thread: it folds every message it is sent into its own state, as useEngine does.
    message: (id, msg) => {
      const view = views.get(id) ?? { state: { ...initialEngineState, threadId: id } };
      view.state = engineReducer(view.state, { type: 'outbound', msg });
      views.set(id, view);
    },
  });
  const id = threads.create('/fixture/one-card');
  threads.start(id);
  threads.receive(id, { t: 'ready', protocol: 3 } as any);
  const ask = (requestId = 7) =>
    threads.receive(id, { t: 'request', id: requestId, kind: 'prompt', question: 'Run `mkdir data`?', options: ['Allow', 'Deny'] } as any);
  const card = () => views.get(id)?.state.request ?? null;
  return { threads, id, engine, approvals, ask, card };
}

test('answering in the popup closes the card the main window shows', () => {
  const f = fixture();
  f.ask();
  expect(f.card()?.id).toBe(7);
  // The popup answers with the token it was handed, exactly as ThreadApprovals does over threads:reply.
  f.threads.send(f.id, { t: 'reply', id: 7, value: 'Allow', approvalToken: f.approvals[0].token });
  expect(f.card()).toBeNull();
  expect(f.engine.sendFromRenderer).toHaveBeenLastCalledWith(expect.objectContaining({ t: 'reply', id: 7, value: 'Allow' }));
});

test('an interrupt, the turn ending, and a stop each close the card too', () => {
  const interrupted = fixture();
  interrupted.ask();
  interrupted.threads.send(interrupted.id, { t: 'interrupt' });
  expect(interrupted.card()).toBeNull();

  const ended = fixture();
  ended.ask();
  ended.threads.receive(ended.id, { t: 'event', name: 'spinner_state', args: ['idle', ''] } as any);
  expect(ended.card()).toBeNull();

  const stopped = fixture();
  stopped.ask();
  stopped.threads.stop(stopped.id);
  expect(stopped.card()).toBeNull();
});

test('an engine restarting mid-question closes the card', () => {
  const f = fixture();
  f.ask();
  f.threads.lifecycle(f.id, 'restarting', 'The engine is restarting');
  expect(f.card()).toBeNull();
});

test('a new message closes the "what should happen to your message?" card of a failed resume', () => {
  const f = fixture();
  f.threads.receive(f.id, { t: 'event', name: 'ui_snapshot', args: [{ sessions: [{ id: 'gone', current: true }] }] } as any);
  f.threads.stop(f.id);
  f.threads.submit(f.id, 'Continue');
  f.threads.receive(f.id, { t: 'ready', protocol: 3 } as any);
  f.threads.receive(f.id, { t: 'event', name: 'session_restore_failed', args: [{ id: 'gone', reason: 'it was deleted' }] } as any);
  expect(f.card()?.id).toBe(-1);
  f.threads.submit(f.id, 'Start over');
  expect(f.card()).toBeNull();
});

test('closing an answered question leaves a newer one open', () => {
  const asked = { ...initialEngineState, request: { t: 'request', id: 8, kind: 'prompt', question: 'Next?', options: ['Allow', 'Deny'] } } as EngineUiState;
  const after = engineReducer(asked, { type: 'outbound', msg: { t: 'event', name: 'request_closed', args: [{ id: 7 }] } as any });
  expect(after.request?.id).toBe(8);
  expect(engineReducer(asked, { type: 'outbound', msg: { t: 'event', name: 'request_closed', args: [{ id: 8 }] } as any }).request).toBeNull();
});

test('the popup does not repeat a question the main window or the ⌘2 bar is already asking', () => {
  const decision = (threadId: string) => ({ threadId, title: threadId, root: `/fixture/${threadId}`, token: 't', request: { id: 1 } }) as any;
  const all = [decision('project'), decision('bar'), decision('elsewhere')];
  expect(popupDecisions(all, ['project', 'bar']).map((a) => a.threadId)).toEqual(['elsewhere']);
  // Neither window on screen: the popup carries every question, so none is stranded.
  expect(popupDecisions(all, [null, null]).map((a) => a.threadId)).toEqual(['project', 'bar', 'elsewhere']);
});
