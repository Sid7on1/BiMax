import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mayRestart, NotchDeck, notchContent, notchSays, notchTask } from '../main/notch';
import type { ThreadSummary } from '../shared/threads';

/**
 * God's Land stage 1 (docs/product-reset/gods-land/03_PLAN.md): what the notch shows, when it speaks up by itself,
 * and the helper's lifecycle. The native side has its own --selftest and a click-through check run on a real screen.
 */

let clock = 1_000;
const task = (id: string, patch: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id, title: `Task ${id}`, root: '/tmp', updatedAt: clock++, status: 'idle', peers: [], origin: 'quick', ...patch,
});
const byId = (list: ThreadSummary[]) => new Map(list.map((t) => [t.id, t]));

describe('what the notch shows', () => {
  test('only ⌘2 tasks, the ones needing you first, then running, then the most recent', () => {
    const list = [
      task('old-done', { outcome: 'completed', check: 'passed' }),
      task('project', { origin: 'project', status: 'working' }),
      task('running', { status: 'working' }),
      task('asks', { status: 'needs-you' }),
      task('newest-idle'),
    ];
    const content = notchContent(list);
    expect(content.tasks.map((t) => t.id)).toEqual(['asks', 'running', 'newest-idle', 'old-done']);
    expect(content).toMatchObject({ t: 'content', active: 2, waiting: 1 });
    expect(notchContent(list, 2).tasks).toHaveLength(2);
  });

  test('each state gets its dot and the menu bar\'s own words', () => {
    expect(notchTask(task('a', { status: 'working' }))).toMatchObject({ state: 'working', detail: 'Working' });
    expect(notchTask(task('b', { status: 'needs-you' }))).toMatchObject({ state: 'waiting', detail: 'Needs your decision' });
    expect(notchTask(task('c', { outcome: 'completed', check: 'passed' }))).toMatchObject({ state: 'done', detail: 'Done · check passed' });
    // A finished task whose check failed is not "done" (F3).
    expect(notchTask(task('d', { outcome: 'completed', check: 'failed' }))).toMatchObject({ state: 'failed', detail: 'Check failed' });
    expect(notchTask(task('e', { outcome: 'failed' }))).toMatchObject({ state: 'failed' });
    expect(notchTask(task('f'))).toMatchObject({ state: 'idle', detail: '' });
    expect(notchTask(task('g', { title: 'x'.repeat(80) })).title).toHaveLength(48);
  });
});

describe('when the notch speaks up', () => {
  test('a task that starts needing you, finishes, fails, or fails its check — each once, at the moment it happens', () => {
    const before = [task('ask', { status: 'working' }), task('ok', { status: 'working' }), task('bad', { status: 'working' }), task('check', { status: 'working' })];
    const after = [
      { ...before[0], status: 'needs-you' as const },
      { ...before[1], status: 'idle' as const, outcome: 'completed' as const, check: 'passed' as const },
      { ...before[2], status: 'idle' as const, outcome: 'failed' as const },
      { ...before[3], status: 'idle' as const, outcome: 'completed' as const, check: 'failed' as const },
    ];
    expect(notchSays(byId(before), after)).toEqual([
      { t: 'say', text: 'Task ask needs you', tone: 'waiting', seconds: 6 },
      { t: 'say', text: 'Task ok is done · check passed', tone: 'done', seconds: 4 },
      { t: 'say', text: 'Task bad failed', tone: 'failed', seconds: 6 },
      { t: 'say', text: 'Task check finished, but its check failed', tone: 'failed', seconds: 6 },
    ]);
    // The same states seen again say nothing: only transitions speak.
    expect(notchSays(byId(after), after)).toEqual([]);
  });

  test('nothing for tasks seen for the first time, for projects, or for a stop that did not finish', () => {
    const fresh = [task('new', { status: 'idle', outcome: 'completed' })];
    expect(notchSays(new Map(), fresh)).toEqual([]);
    const project = task('p', { origin: 'project', status: 'working' });
    expect(notchSays(byId([project]), [{ ...project, status: 'needs-you' }])).toEqual([]);
    const stopped = task('s', { status: 'working' });
    expect(notchSays(byId([stopped]), [{ ...stopped, status: 'stopped', outcome: 'interrupted' }])).toEqual([]);
  });
});

test('a helper that keeps exiting is restarted three times in five minutes, then left off', () => {
  expect(mayRestart([], 0)).toBe(true);
  expect(mayRestart([1, 2], 10)).toBe(true);
  expect(mayRestart([1, 2, 3], 10)).toBe(false);
  expect(mayRestart([1, 2, 3], 5 * 60_000 + 10)).toBe(true);
});

class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  written: string[] = [];
  constructor() {
    super();
    this.stdin.on('data', (chunk) => this.written.push(...String(chunk).split('\n').filter(Boolean)));
  }
  kill() { this.exitCode = 0; return true; }
}

describe('the helper process', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  test('gets the content once per change, the says on transitions, and opens the task it names', async () => {
    const helpers: FakeHelper[] = [];
    const opened: string[] = [];
    const deck = new NotchDeck({ helper: '/x', onOpenTask: (id) => opened.push(id), spawnHelper: () => { const h = new FakeHelper(); helpers.push(h); return h as never; } });
    deck.start();
    const working = task('t', { status: 'working' });
    deck.update([working]);
    deck.update([working]); // unchanged: not sent again
    deck.update([{ ...working, status: 'needs-you' }]);
    await flush();
    const messages = helpers[0].written.map((line) => JSON.parse(line));
    expect(messages.map((m) => m.t)).toEqual(['content', 'content', 'say']);
    expect(messages[2]).toMatchObject({ text: 'Task t needs you', tone: 'waiting' });

    helpers[0].stdout.write('{"t":"ready","hasNotch":true}\n{"t":"open-task","id":"t"}\n{"t":"open-task"}\nnot json\n');
    await flush();
    expect(opened).toEqual(['t']);

    deck.stop();
    await flush();
    expect(helpers[0].written.map((line) => JSON.parse(line).t).pop()).toBe('quit');
    expect(deck.running()).toBe(false);
  });

  test('an exit restarts it after a second, but a stop never does', () => {
    jest.useFakeTimers();
    try {
      const helpers: FakeHelper[] = [];
      const deck = new NotchDeck({ helper: '/x', onOpenTask: () => undefined, spawnHelper: () => { const h = new FakeHelper(); helpers.push(h); return h as never; } });
      deck.start();
      helpers[0].emit('exit', 1, null);
      expect(deck.running()).toBe(false);
      jest.advanceTimersByTime(1_000);
      expect(helpers).toHaveLength(2);
      deck.stop();
      helpers[1].emit('exit', 0, null);
      jest.advanceTimersByTime(5_000);
      expect(helpers).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
