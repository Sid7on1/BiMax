import { nextGlassChange, notchGlass, outcomeOf, STALL_MS, stalledFor, UNSEEN_MS, type Unseen } from '../main/glass';
import type { ThreadSummary } from '../shared/threads';

/**
 * God's Land stage 4: one glass state for the notch, most urgent first, each read from something the app knows.
 * Table-driven, as the plan's exit evidence asks: each situation gives exactly one state.
 */

const NOW = 10_000_000;
const task = (id: string, patch: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id, title: `Task ${id}`, root: '/w', updatedAt: NOW - 1_000, status: 'idle', peers: [], origin: 'quick', ...patch,
});
const unseen = (entries: Array<[string, Unseen]>) => new Map(entries);

test.each([
  ['nothing at all', [], undefined, undefined, 'water', 'All quiet'],
  ['a task working', [task('a', { status: 'working' })], undefined, undefined, 'molten', 'Task a · working'],
  ['two working', [task('a', { status: 'working' }), task('b', { status: 'starting' })], undefined, undefined, 'molten', '2 tasks working'],
  ['working, stuck for 45 s', [task('a', { status: 'working', updatedAt: NOW - 45_000 })], undefined, undefined, 'frost', 'Task a · no progress for 30 s'],
  ['stuck for 3 minutes', [task('a', { status: 'working', updatedAt: NOW - 185_000 })], undefined, undefined, 'frost', 'Task a · no progress for 3 min'],
  ['a night shift working', [task('n', { status: 'working' })], new Set(['n']), undefined, 'night', 'Night Shift is working'],
  ['messages queued, nothing working', [task('q', { queued: 2 })], undefined, undefined, 'bubbles', '2 messages waiting to start'],
  ['an unseen pass', [task('p')], undefined, unseen([['p', { outcome: 'passed', title: 'Tidy Downloads', at: NOW - 1_000 }]]), 'prism', 'Tidy Downloads is done'],
  ['an unseen failure', [task('f')], undefined, unseen([['f', { outcome: 'failed', title: 'Build', at: NOW - 1_000 }]]), 'fissure', 'Build failed'],
  ['an old unseen result is forgotten', [task('p')], undefined, unseen([['p', { outcome: 'passed', title: 'Old', at: NOW - UNSEEN_MS }]]), 'water', 'All quiet'],
  ['a task needs you', [task('i', { status: 'needs-you' })], undefined, undefined, 'ink', 'Task i needs you'],
  ['two need you', [task('i', { status: 'needs-you' }), task('j', { status: 'needs-you' })], undefined, undefined, 'ink', '2 tasks need you'],
  ['a project needing you is not the notch\'s', [task('p', { status: 'needs-you', origin: 'project' })], undefined, undefined, 'water', 'All quiet'],
])('%s → %s', (_name, threads, night, seen, state, label) => {
  expect(notchGlass({ threads: threads as ThreadSummary[], now: NOW, night: night as Set<string> | undefined, unseen: seen as Map<string, Unseen> | undefined }))
    .toEqual({ state, label });
});

test('the most urgent wins: needs-you over a failure over stuck over night over working over queued over a pass', () => {
  const all = [
    task('i', { status: 'needs-you' }),
    task('s', { status: 'working', updatedAt: NOW - STALL_MS }),
    task('n', { status: 'working' }),
    task('q', { queued: 1 }),
  ];
  const results = unseen([['f', { outcome: 'failed', title: 'F', at: NOW }], ['p', { outcome: 'passed', title: 'P', at: NOW }]]);
  const night = new Set(['n']);
  const order: string[] = [];
  let threads = all;
  let seen = results;
  for (let i = 0; i < 8; i++) {
    const glass = notchGlass({ threads, now: NOW, night, unseen: seen });
    order.push(glass.state);
    if (glass.state === 'ink') threads = threads.filter((t) => t.id !== 'i');
    else if (glass.state === 'fissure') seen = unseen([...seen].filter(([id]) => id !== 'f'));
    else if (glass.state === 'frost') threads = threads.filter((t) => t.id !== 's');
    else if (glass.state === 'night') night.clear();
    else if (glass.state === 'molten') threads = threads.filter((t) => t.id !== 'n');
    else if (glass.state === 'bubbles') threads = threads.filter((t) => t.id !== 'q');
    else if (glass.state === 'prism') seen = unseen([]);
    else break;
  }
  expect(order).toEqual(['ink', 'fissure', 'frost', 'night', 'molten', 'bubbles', 'prism', 'water']);
});

test('a result is a failure when the turn failed, ran out of time, or its check failed', () => {
  expect(outcomeOf(task('a', { outcome: 'completed', check: 'passed' }))).toBe('passed');
  expect(outcomeOf(task('a', { outcome: 'completed' }))).toBe('passed');
  expect(outcomeOf(task('a', { outcome: 'completed', check: 'failed' }))).toBe('failed');
  expect(outcomeOf(task('a', { outcome: 'failed' }))).toBe('failed');
  expect(outcomeOf(task('a', { outcome: 'time-limit' }))).toBe('failed');
});

test('the glass knows when it will change on its own, so it frosts on time without polling', () => {
  const fresh = task('a', { status: 'working', updatedAt: NOW - 5_000 });
  expect(nextGlassChange({ threads: [fresh], now: NOW })).toBe(fresh.updatedAt + STALL_MS);
  expect(nextGlassChange({ threads: [task('b', { status: 'working', updatedAt: NOW - 40_000 })], now: NOW })).toBe(NOW + 30_000);
  expect(nextGlassChange({ threads: [task('c', { status: 'working', updatedAt: NOW - 300_000 })], now: NOW })).toBe(NOW + 60_000);
  expect(nextGlassChange({ threads: [], now: NOW, unseen: unseen([['p', { outcome: 'passed', title: 'P', at: NOW - 1_000 }]]) })).toBe(NOW - 1_000 + UNSEEN_MS);
  expect(nextGlassChange({ threads: [task('idle')], now: NOW })).toBeNull();
  expect(stalledFor(59_000)).toBe('30 s');
  expect(stalledFor(2 * 3_600_000)).toBe('2 hours');
});
