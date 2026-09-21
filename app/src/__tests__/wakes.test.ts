import { CI_POLL_MS, CI_TIMEOUT_MS, FOLDER_SETTLE_MS, MAX_WAKES_PER_HOUR, Wakes, type CiState } from '../main/wakes';
import { ThreadManager, MAX_THREAD_WAKES, threadWakeFrom } from '../main/thread.manager';
import { threadActivity, type ThreadWake } from '../shared/threads';

/** Backlog F4: the app keeps a task's wakes and resumes the task when the event happens. */

/** A clock and timers the test moves by hand. */
function fakeTime(start = Date.UTC(2026, 8, 21, 9, 0)) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    timer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return () => { timers.delete(id); }; },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function fixture(ci: CiState[] = []) {
  const time = fakeTime();
  const fired: Array<{ threadId: string; wake: ThreadWake; text: string }> = [];
  const watchers = new Map<string, (file: string) => void>();
  const closed: string[] = [];
  const wakes = new Wakes({
    now: time.now, timer: time.timer,
    watch: (root, changed) => { watchers.set(root, changed); return () => { closed.push(root); watchers.delete(root); }; },
    ci: async () => ci.shift() ?? { state: 'waiting' },
    fire: (threadId, wake, text) => fired.push({ threadId, wake, text }),
  });
  return { time, fired, watchers, closed, wakes };
}

const wake = (fields: Partial<ThreadWake> & Pick<ThreadWake, 'kind'>): ThreadWake =>
  ({ id: fields.id ?? `w-${Math.random().toString(36).slice(2, 7)}`, reason: 'carry on', createdAt: Date.UTC(2026, 8, 21, 9, 0), ...fields });

test('a time wake fires at its time, once, saying what the task said it would do', async () => {
  const f = fixture();
  f.wakes.sync([{ threadId: 't1', wakes: [wake({ id: 'w1', kind: 'at', at: f.time.now() + 30 * 60_000, reason: 'check the deploy' })] }]);
  await f.time.advance(29 * 60_000);
  expect(f.fired).toEqual([]);
  await f.time.advance(60_000);
  expect(f.fired).toHaveLength(1);
  expect(f.fired[0].text).toMatch(/^\[Wake\] It is .*, the time this task asked to be woken\. When you registered this wake you said you would: "check the deploy"\./);
  await f.time.advance(24 * 60 * 60_000);
  expect(f.fired).toHaveLength(1);
  expect(f.wakes.size()).toBe(0);
});

test('a time wake set before the app quit and now overdue fires as soon as it is armed', async () => {
  const f = fixture();
  f.wakes.sync([{ threadId: 't1', wakes: [wake({ kind: 'at', at: f.time.now() - 60_000 })] }]);
  await f.time.advance(0);
  expect(f.fired).toHaveLength(1);
});

test('a folder wake waits for a burst of changes to settle, and ignores bookkeeping and other kinds of file', async () => {
  const f = fixture();
  f.wakes.sync([{ threadId: 't1', wakes: [wake({ kind: 'folder', path: '/Users/me/Downloads', match: 'pdf', reason: 'file the invoices' })] }]);
  const changed = f.watchers.get('/Users/me/Downloads')!;
  changed('.git/index'); changed('node_modules/x/a.pdf'); changed('photo.jpg'); changed('invoice.pdf.crdownload');
  await f.time.advance(FOLDER_SETTLE_MS * 3);
  expect(f.fired).toEqual([]);
  changed('invoice-3.pdf');
  await f.time.advance(FOLDER_SETTLE_MS / 2);
  changed('invoice-4.pdf');
  await f.time.advance(FOLDER_SETTLE_MS / 2);
  expect(f.fired).toEqual([]);
  await f.time.advance(FOLDER_SETTLE_MS);
  expect(f.fired).toHaveLength(1);
  expect(f.fired[0].text).toContain('Files changed in /Users/me/Downloads: invoice-3.pdf, invoice-4.pdf');
  expect(f.closed).toEqual(['/Users/me/Downloads']);
});

test('a CI wake polls until every run for the commit has finished, and reports what failed', async () => {
  const f = fixture([
    { state: 'waiting' },
    { state: 'waiting' },
    { state: 'done', runs: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/9' }] },
  ]);
  f.wakes.sync([{ threadId: 't1', wakes: [wake({ kind: 'ci', path: '/repo', sha: 'abcdef1234567890abcdef1234567890abcdef12', reason: 'fix what fails' })] }]);
  await f.time.advance(0);
  await f.time.advance(CI_POLL_MS);
  expect(f.fired).toEqual([]);
  await f.time.advance(CI_POLL_MS);
  expect(f.fired).toHaveLength(1);
  expect(f.fired[0].text).toContain('CI finished for commit abcdef1: 1 of 2 failed — build: success; test: failure (https://github.com/o/r/actions/runs/9)');
});

test('a CI wait that never gets a result ends after its limit and says why', async () => {
  const f = fixture(Array.from({ length: 1000 }, () => ({ state: 'error', message: 'HTTP 401: Bad credentials' } as CiState)));
  f.wakes.sync([{ threadId: 't1', wakes: [wake({ kind: 'ci', path: '/repo', sha: 'abcdef1234567890abcdef1234567890abcdef12' })] }]);
  await f.time.advance(CI_TIMEOUT_MS - CI_POLL_MS);
  expect(f.fired).toEqual([]);
  await f.time.advance(2 * CI_POLL_MS);
  expect(f.fired).toHaveLength(1);
  expect(f.fired[0].text).toContain('No CI result for commit abcdef1 after 6 hours — the last check said: HTTP 401: Bad credentials');
});

test(`a thread is woken at most ${MAX_WAKES_PER_HOUR} times an hour; the next wake waits for the hour`, async () => {
  const f = fixture();
  const due = f.time.now() + 1000;
  f.wakes.sync([{ threadId: 't1', wakes: Array.from({ length: MAX_WAKES_PER_HOUR + 1 }, (_, i) => wake({ id: `w${i}`, kind: 'at', at: due })) }]);
  await f.time.advance(1000);
  expect(f.fired).toHaveLength(MAX_WAKES_PER_HOUR);
  await f.time.advance(30 * 60_000);
  expect(f.fired).toHaveLength(MAX_WAKES_PER_HOUR);
  await f.time.advance(31 * 60_000);
  expect(f.fired).toHaveLength(MAX_WAKES_PER_HOUR + 1);
});

test('a cancelled wake is disarmed and its watch closed; an answer wake is never fired by the app', async () => {
  const f = fixture();
  const folder = wake({ id: 'f', kind: 'folder', path: '/Users/me/Inbox' });
  const later = wake({ id: 't', kind: 'at', at: f.time.now() + 60_000 });
  f.wakes.sync([{ threadId: 't1', wakes: [folder, later, wake({ id: 'a', kind: 'answer', question: 'Which logo?' })] }]);
  f.wakes.sync([{ threadId: 't1', wakes: [wake({ id: 'a', kind: 'answer', question: 'Which logo?' })] }]);
  expect(f.closed).toEqual(['/Users/me/Inbox']);
  await f.time.advance(7 * 24 * 60 * 60_000);
  expect(f.fired).toEqual([]);
});

describe('the thread manager keeps the wakes', () => {
  function manager() {
    const saved: any[] = [];
    const wakesChanged = jest.fn();
    const m = new ThreadManager({
      engine: () => ({ sendFromRenderer: jest.fn(), dispose: jest.fn(), openProject: jest.fn() } as any),
      selected: jest.fn(), message: jest.fn(), approval: jest.fn(), save: (v: any) => saved.push(v), saveNow: jest.fn(), changed: jest.fn(), wakesChanged,
    }, []);
    const id = m.create('/fixture/repo', 'Ship the fix');
    m.receive(id, { t: 'ready', protocol: 3 } as any);
    m.receive(id, { t: 'event', name: 'spinner_state', args: ['idle', ''] } as any);
    const request = (w: object) => m.receive(id, { t: 'event', name: 'wake_request', args: [w] } as any);
    return { m, id, request, wakesChanged };
  }

  test('a request is stored with the thread and shown; a duplicate or a sixth is not stored', () => {
    const { m, id, request, wakesChanged } = manager();
    request({ id: 'ci1', kind: 'ci', reason: 'fix what fails', createdAt: 1, path: '/fixture/repo', sha: 'a'.repeat(40) });
    request({ id: 'ci1', kind: 'ci', reason: 'fix what fails', createdAt: 1, path: '/fixture/repo', sha: 'a'.repeat(40) });
    expect(m.summary(id).wakes).toHaveLength(1);
    expect(wakesChanged).toHaveBeenCalledTimes(1);
    expect(threadActivity(m.summary(id)).label).toBe('Waiting for CI');
    for (let i = 0; i < MAX_THREAD_WAKES; i++) request({ id: `t${i}`, kind: 'at', at: Date.now() + (i + 1) * 60_000, reason: 'r', createdAt: 1 });
    expect(m.summary(id).wakes).toHaveLength(MAX_THREAD_WAKES);
    expect(m.wakeEntries()).toEqual([{ threadId: id, wakes: m.summary(id).wakes }]);
  });

  test('a malformed request is ignored', () => {
    expect(threadWakeFrom({ id: 'x', kind: 'at', reason: 'r' })).toBeNull();
    expect(threadWakeFrom({ id: 'x', kind: 'ci', reason: 'r', path: '/r' })).toBeNull();
    expect(threadWakeFrom({ id: 'x', kind: 'teleport', reason: 'r' })).toBeNull();
  });

  test('cancel drops one or all; waking up drops the wake and sends the task the message', () => {
    const { m, id, request } = manager();
    request({ id: 'a', kind: 'at', at: Date.now() + 60_000, reason: 'r', createdAt: 1 });
    request({ id: 'b', kind: 'at', at: Date.now() + 120_000, reason: 'r', createdAt: 1 });
    m.receive(id, { t: 'event', name: 'wake_cancel', args: [{ id: 'a' }] } as any);
    expect(m.summary(id).wakes?.map((w) => w.id)).toEqual(['b']);
    expect(m.wakeUp(id, 'b', '[Wake] It is time.', '[Wake] It is time.')).toBe(true);
    expect(m.summary(id).wakes).toBeUndefined();
    expect(m.summary(id).status).toBe('working');
    expect(m.wakeUp(id, 'b', 'again', 'again')).toBe(false);
    request({ id: 'c', kind: 'at', at: Date.now() + 60_000, reason: 'r', createdAt: 1 });
    m.receive(id, { t: 'event', name: 'wake_cancel', args: [{ id: 'all' }] } as any);
    expect(m.summary(id).wakes).toBeUndefined();
  });

  test("the user's own message answers an answer wake; a wake's message does not", () => {
    const { m, id, request } = manager();
    request({ id: 'q', kind: 'answer', question: 'Which logo?', reason: 'use it', createdAt: 1 });
    request({ id: 't', kind: 'at', at: Date.now() + 60_000, reason: 'r', createdAt: 1 });
    expect(threadActivity(m.summary(id)).label).toMatch(/^Waiting · wakes at /);
    m.submit(id, '[Wake] It is time.');
    expect(m.summary(id).wakes?.map((w) => w.id)).toEqual(['q', 't']);
    m.submit(id, 'The blue one.');
    expect(m.summary(id).wakes?.map((w) => w.id)).toEqual(['t']);
  });
});
