import { ThreadManager } from '../main/thread.manager';

/** Talk mode in a project (the main window): spoken style and the talk model while talking, then back, never saved. */
function fixture() {
  const engines: Array<{ sendFromRenderer: jest.Mock; dispose: jest.Mock; openProject: jest.Mock }> = [];
  const save = jest.fn(), restarted = jest.fn(), message = jest.fn();
  const manager = new ThreadManager({
    engine: () => { const e = { sendFromRenderer: jest.fn(), dispose: jest.fn(), openProject: jest.fn() }; engines.push(e); return e; },
    selected: jest.fn(), message, approval: jest.fn(), save, changed: jest.fn(), restarted,
  });
  const ready = (id: string) => manager.receive(id, { t: 'ready', protocol: 3 } as any);
  const idle = (id: string) => manager.receive(id, { t: 'event', name: 'spinner_state', args: ['idle', ''] } as any);
  return { manager, engines, save, restarted, message, ready, idle, last: () => engines[engines.length - 1] };
}
const TALK = 'openai/gpt-oss-20b';

test('talking in a project gives its engine spoken style and the talk model, restarting only between turns', () => {
  const f = fixture();
  const id = f.manager.create('/fixture/CN Lab', '', 'project');
  f.manager.start(id); f.ready(id);
  expect(f.manager.talkState(id)).toEqual({ voice: false });
  f.manager.submit(id, 'explain the lab sheet');
  const working = f.last();
  f.manager.setTalk(id, true, TALK);
  expect(f.manager.talkState(id)).toEqual({ voice: true, model: TALK });
  expect(working.dispose).not.toHaveBeenCalled();
  f.idle(id);
  expect(working.dispose).toHaveBeenCalled();
  expect(f.engines).toHaveLength(2);
  expect(f.restarted).toHaveBeenCalledWith(id);
  expect(f.last().openProject).toHaveBeenCalledWith('/fixture/CN Lab');
});

test('what the user just said is never dropped by the restart back, and nothing about talking is saved', () => {
  const f = fixture();
  const id = f.manager.create('/fixture/CN Lab', '', 'project');
  f.manager.start(id); f.ready(id);
  f.manager.setTalk(id, true, TALK);
  expect(f.engines).toHaveLength(2);
  f.ready(id);
  f.manager.submit(id, 'what is subnetting');
  f.manager.submit(id, 'and a /26?');
  f.manager.setTalk(id, false);
  const talking = f.last();
  f.idle(id);
  expect(talking.sendFromRenderer).toHaveBeenLastCalledWith({ t: 'input', text: 'and a /26?' });
  expect(talking.dispose).not.toHaveBeenCalled();
  f.idle(id);
  expect(talking.dispose).toHaveBeenCalled();
  expect(f.engines).toHaveLength(3);
  expect(f.manager.talkState(id)).toEqual({ voice: false });
  expect(f.save.mock.calls.every(([saved]) => saved.summary.voice === undefined && saved.summary.model === undefined)).toBe(true);
});

test('a thread with no engine running just starts with the talk settings; a talk task keeps its own', () => {
  const f = fixture();
  const id = f.manager.create('/fixture/CN Lab', '', 'project');
  f.manager.setTalk(id, true, TALK);
  expect(f.engines).toHaveLength(0);
  expect(f.manager.talkState(id)).toEqual({ voice: true, model: TALK });
  const task = f.manager.create('/fixture/Downloads', '', 'quick', TALK, true);
  expect(f.manager.talkState(task)).toEqual({ voice: true, model: TALK });
});

test('a restart for talking resumes the conversation without adding a "Resumed" notice every time', () => {
  const f = fixture();
  const id = f.manager.create('/fixture/CN Lab', '', 'project');
  f.manager.start(id); f.ready(id);
  const resumed = { t: 'event', name: 'message', args: [{ id: 'n1', role: 'system', level: 'success', content: 'Resumed "2026-09-14 02:59:09" · 2 turn(s) restored — continuing this thread.', timestamp: 't' }] } as any;
  f.manager.setTalk(id, true, TALK);
  f.ready(id);
  f.manager.receive(id, resumed);
  expect(f.manager.get(id).state.items).toHaveLength(0);
  expect(f.message).not.toHaveBeenCalledWith(id, resumed);
  // A resume that is not the manager's own restart still says so.
  f.manager.receive(id, resumed);
  expect(f.manager.get(id).state.items).toHaveLength(1);
});
