import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadManager, RESUME_CHOICES, type SavedThread } from '../main/thread.manager';
import { ThreadStorage } from '../main/thread.storage';

/**
 * Backlog F9–F12 (record 46, T02–T05): a resume that fails says so and asks, a failed engine can be resumed, a stopped
 * task keeps its folder until its process is gone, and one failed write does not stop later saves.
 */

function fixture(saved: SavedThread[] = [], options: { drainable?: boolean } = {}) {
  const engines = new Map<string, any>();
  const created: string[] = [];
  const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
  const approvals: any[] = [];
  const manager = new ThreadManager({
    engine: (id) => {
      let exited!: () => void;
      const done = new Promise<void>((resolve) => { exited = resolve; });
      const e = { sendFromRenderer: jest.fn(), openProject: jest.fn(), dispose: jest.fn(() => (options.drainable ? done : undefined)), exited };
      engines.set(id, e);
      created.push(id);
      return e;
    },
    save: jest.fn(), selected: jest.fn(), message: jest.fn(), changed: jest.fn(),
    approval: (value) => approvals.push(value),
    timer: (fn) => { const t = { fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
  }, saved);
  const ready = (id: string) => manager.receive(id, { t: 'ready', protocol: 3 } as any);
  const idle = (id: string) => manager.receive(id, { t: 'event', name: 'spinner_state', args: ['idle', ''] } as any);
  const notes = (id: string) => manager.get(id).state.items
    .filter((item: any) => item.kind === 'msg' && item.msg.role === 'system').map((item: any) => String(item.msg.content)).join('\n');
  const fireTimers = () => { for (const t of timers.splice(0)) if (!t.cancelled) t.fn(); };
  return { manager, engines, created, approvals, ready, idle, notes, fireTimers };
}

/** A thread saved with a session to resume. */
function savedWithSession(sessionId: string): SavedThread {
  const first = fixture();
  const id = first.manager.create('/fixture/resume', 'Write a report');
  first.ready(id);
  first.manager.receive(id, { t: 'event', name: 'ui_snapshot', args: [{ sessions: [{ id: sessionId, current: true }] }] } as any);
  first.idle(id);
  return JSON.parse(JSON.stringify(first.manager.get(id)));
}

describe('F9: a resume that cannot happen says so, keeps the message, and asks what to do', () => {
  test('a refused resume offers start fresh, saved conversations, or keep; an idle engine does not clear the choice', () => {
    const saved = savedWithSession('session-gone');
    const f = fixture([saved]);
    const id = saved.summary.id;
    f.manager.submit(id, 'Continue');
    f.ready(id);
    expect(f.engines.get(id).sendFromRenderer.mock.calls).toEqual([[{ t: 'resume', id: 'session-gone' }]]);

    f.manager.receive(id, { t: 'event', name: 'session_restore_failed', args: [{ id: 'session-gone', reason: 'no saved conversation has that id' }] } as any);
    expect(f.notes(id)).toContain("Couldn't pick up the saved conversation (session-gone): no saved conversation has that id. Your message is kept and has not been sent.");
    const choice = f.approvals.at(-1);
    expect(choice.request.options).toEqual([RESUME_CHOICES.fresh, RESUME_CHOICES.sessions, RESUME_CHOICES.keep]);
    expect(f.manager.get(id).summary.status).toBe('needs-you');
    f.idle(id);
    expect(f.manager.approvals()).toHaveLength(1);
    expect(f.engines.get(id).sendFromRenderer).toHaveBeenCalledTimes(1);

    f.manager.send(id, { t: 'reply', id: choice.request.id, value: RESUME_CHOICES.fresh, approvalToken: choice.token });
    expect(f.engines.get(id).sendFromRenderer.mock.calls.slice(1)).toEqual([[{ t: 'input', text: 'Continue' }]]);
    expect(f.manager.approvals()).toHaveLength(0);
  });

  test('an engine that never answers the resume fails it after the deadline, with the same choice', () => {
    const saved = savedWithSession('session-silent');
    const f = fixture([saved]);
    const id = saved.summary.id;
    f.manager.submit(id, 'Continue');
    f.ready(id);
    f.fireTimers();
    expect(f.notes(id)).toContain('the engine did not confirm it within 20 seconds');
    expect(f.approvals.at(-1).request.options).toContain(RESUME_CHOICES.sessions);
    // Control: a resume the engine confirms arms no failure.
    const g = fixture([savedWithSession('session-ok')]);
    const other = g.manager.list()[0].id;
    g.manager.submit(other, 'Continue');
    g.ready(other);
    g.manager.receive(other, { t: 'event', name: 'session_restore', args: [{ id: 'session-ok', entries: [] }] } as any);
    g.fireTimers();
    expect(g.notes(other)).not.toContain("Couldn't pick up");
    expect(g.engines.get(other).sendFromRenderer).toHaveBeenLastCalledWith({ t: 'input', text: 'Continue' });
  });

  test('Show saved conversations asks the engine for its list, and the conversation picked there gets the message', () => {
    const saved = savedWithSession('session-gone');
    const f = fixture([saved]);
    const id = saved.summary.id;
    f.manager.submit(id, 'Continue');
    f.ready(id);
    f.manager.receive(id, { t: 'event', name: 'session_restore_failed', args: [{ id: 'session-gone', reason: 'gone' }] } as any);
    const choice = f.approvals.at(-1);
    f.manager.send(id, { t: 'reply', id: choice.request.id, value: RESUME_CHOICES.sessions, approvalToken: choice.token });
    expect(f.engines.get(id).sendFromRenderer).toHaveBeenLastCalledWith({ t: 'input', text: '/sessions' });
    f.manager.receive(id, { t: 'event', name: 'session_restore', args: [{ id: 'session-picked', entries: [] }] } as any);
    expect(f.engines.get(id).sendFromRenderer).toHaveBeenLastCalledWith({ t: 'input', text: 'Continue' });
    expect(f.manager.get(id).summary.sessionId).toBe('session-picked');
  });
});

test('F10: after an engine fails for good, Resume starts a new engine instead of doing nothing', () => {
  const f = fixture();
  const id = f.manager.create('/fixture/failing', 'work');
  f.ready(id);
  const dead = f.engines.get(id);
  f.manager.lifecycle(id, 'failed', 'restart budget exhausted');
  expect(dead.dispose).toHaveBeenCalled();
  f.manager.start(id);
  expect(f.created).toEqual([id, id]);
  expect(f.engines.get(id)).not.toBe(dead);
  // Control: a restarting engine is the same engine coming back, not a dead one.
  const g = fixture();
  const other = g.manager.create('/fixture/restarting', 'work');
  g.ready(other);
  g.manager.lifecycle(other, 'restarting', 'backing off');
  g.manager.start(other);
  expect(g.created).toEqual([other]);
});

test('F11: a stopped task keeps its folder until its engine has exited', async () => {
  const f = fixture([], { drainable: true });
  const a = f.manager.create('/fixture/shared', 'writer A');
  const b = f.manager.create('/fixture/shared', 'writer B');
  f.ready(a);
  f.ready(b);
  expect(f.engines.get(b).sendFromRenderer).not.toHaveBeenCalled();
  const first = f.engines.get(a);
  f.manager.stop(a);
  await Promise.resolve();
  expect(f.engines.get(b).sendFromRenderer).not.toHaveBeenCalled();
  first.exited();
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.engines.get(b).sendFromRenderer).toHaveBeenCalledWith({ t: 'input', text: 'writer B' });
});

test('F12: one failed write neither blocks later saves nor loses the thread, and is reported until it is saved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-thread-storage-'));
  try {
    const dir = path.join(root, 'threads');
    const reports: Array<string | null> = [];
    const retries: Array<() => void> = [];
    const storage = new ThreadStorage(dir, { onFailure: (message) => reports.push(message), setTimeout: (fn) => retries.push(fn) });
    const thread = (id: string): SavedThread => ({ summary: { id, title: id, root: '/fixture/x', updatedAt: 1, status: 'idle', peers: [] } as any, state: { items: [] } as any });

    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(dir, 'something in the way');
    storage.save(thread('first'));
    await expect(storage.flush()).resolves.toBeUndefined();
    expect(storage.unsaved()).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual(expect.any(String));
    expect(retries).toHaveLength(1);

    fs.rmSync(dir);
    storage.save(thread('second'));
    retries.shift()!();
    await storage.flush();
    expect(storage.load().map((t) => t.summary.id).sort()).toEqual(['first', 'second']);
    expect(storage.unsaved()).toBe(0);
    expect(reports.at(-1)).toBeNull();
    expect(storage.lastError()).toBeNull();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
