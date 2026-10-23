import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ActivityLog, MIN_TRIALS, memoryGroups, mostRecent, predict, replay, verdict, whenWords, type Activity } from '../main/recall';

/** God's Land stage 8: the activity log, the gated "Probably next" ranker, and recall by the cues people remember. */

const at = (day: number, hour: number, minute = 0): number => new Date(2026, 8, day, hour, minute).getTime();
const ev = (time: number, file: string, extra: Partial<Activity> = {}): Activity => ({ at: time, kind: 'use', path: `/w/${file}`, ...extra });

/** A small deterministic generator (high bits of an LCG), so the simulated person is the same every run. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 8) / 0x1000000; };
}

/**
 * A simulated person with habits: three apps, each with its own few files used unevenly, switching app every few
 * minutes. Used to test the gate's machinery — it is not evidence that the ranker helps a real person.
 */
function habitual(count: number, seed = 7): Activity[] {
  const next = random(seed);
  const apps: Record<string, string[]> = { Figma: ['hero.png', 'logo.svg', 'brand.pdf', 'grid.png'], Xcode: ['App.swift', 'Model.swift', 'Info.plist', 'Tests.swift'], Mail: ['invoice.pdf', 'contract.pdf', 'notes.md', 'q3.csv'] };
  const names = Object.keys(apps);
  const out: Activity[] = [];
  let app = names[0]!;
  let time = at(1, 9);
  for (let i = 0; i < count; i++) {
    if (next() < 0.2) app = names[Math.floor(next() * names.length)]!;
    const files = apps[app]!;
    const r = next();
    const file = files[r < 0.5 ? 0 : r < 0.75 ? 1 : r < 0.9 ? 2 : 3]!;
    time += Math.floor(next() * 40 * 60_000) + 60_000;
    out.push(ev(time, file, { app }));
  }
  return out;
}

describe('probably next', () => {
  test('the baseline is most recent first, never the file just used, never one already in view', () => {
    const events = [ev(at(1, 9), 'a'), ev(at(1, 10), 'b'), ev(at(1, 11), 'c'), ev(at(1, 12), 'd')];
    expect(mostRecent(events, { now: at(1, 13), last: '/w/d' }, 3)).toEqual(['/w/c', '/w/b', '/w/a']);
    expect(mostRecent(events, { now: at(1, 13), last: '/w/d', exclude: new Set(['/w/c']) }, 3)).toEqual(['/w/b', '/w/a']);
  });

  test('the app in front brings its own files forward over a more recent one from another app', () => {
    const events = [ev(at(1, 9), 'hero.png', { app: 'Figma' }), ev(at(1, 9, 30), 'hero.png', { app: 'Figma' }), ev(at(1, 12), 'report.pdf', { app: 'Mail' })];
    expect(predict(events, { now: at(1, 12, 30), app: 'Mail' }, 1)).toEqual(['/w/report.pdf']);
    expect(predict(events, { now: at(1, 12, 30), app: 'Figma' }, 1)).toEqual(['/w/hero.png']);
  });

  test('what usually comes after the file just used is suggested first; that file itself never is', () => {
    const events = [
      ev(at(1, 9), 'spec.md'), ev(at(1, 9, 5), 'mock.png'),
      ev(at(2, 9), 'spec.md'), ev(at(2, 9, 5), 'mock.png'),
      ev(at(3, 8), 'other.txt'), ev(at(3, 9), 'spec.md'),
    ];
    const next = predict(events, { now: at(3, 9, 1), last: '/w/spec.md' }, 2);
    expect(next[0]).toBe('/w/mock.png');
    expect(next).not.toContain('/w/spec.md');
    expect(predict(events, { now: at(3, 9, 1), last: '/w/spec.md', exclude: new Set(['/w/mock.png']) }, 3)).toEqual(['/w/other.txt']);
  });

  test('the replay knows only the past: a ranker that returns the newest event scores nothing', () => {
    const events = habitual(200);
    const r = replay(events, (history) => [history[history.length - 1]!.path], 3);
    expect(r.trials).toBeGreaterThan(50);
    expect(r.hits).toBe(0);
  });

  test('only re-finds count: first uses, repeats of the file just used and task outputs are not trials', () => {
    const events = [ev(at(1, 9), 'a'), ev(at(1, 10), 'a'), ev(at(1, 11), 'b'), ev(at(1, 12), 'b', { kind: 'task-out' }), ev(at(1, 13), 'a')];
    expect(replay(events, mostRecent, 3).trials).toBe(1);
  });

  test('on a person with habits the ranker beats most-recent-first, and the verdict switches to it', () => {
    const events = habitual(400);
    const v = verdict(events);
    expect(v.trials).toBeGreaterThanOrEqual(MIN_TRIALS);
    expect(v.predictHits).toBeGreaterThan(v.recentHits);
    expect(v.use).toBe('predict');
  });

  test('a tie is not a win, and too few re-finds decide nothing', () => {
    // Three files in a fixed cycle: both rankers always have the next one in their top 3.
    const cycle = Array.from({ length: 120 }, (_, i) => ev(at(1, 0) + i * 60_000, ['a', 'b', 'c'][i % 3]!));
    const tie = verdict(cycle);
    expect(tie.predictHits).toBe(tie.recentHits);
    expect(tie.use).toBe('recent');
    // A short log on which the ranker is already ahead: still too few re-finds to decide.
    const short = Array.from({ length: 60 }, (_, n) => habitual(n + 5)).find((log) => {
      const p = replay(log, predict, 3);
      return p.trials < MIN_TRIALS && p.hits > replay(log, mostRecent, 3).hits;
    });
    expect(short).toBeDefined();
    expect(verdict(short!).use).toBe('recent');
  });
});

describe('recall by vague memory', () => {
  const now = at(25, 15);

  test('when, as a person says it', () => {
    expect(whenWords(at(25, 9), now)).toBe('This morning');
    expect(whenWords(at(25, 1), now)).toBe('Earlier tonight');
    expect(whenWords(at(24, 14), now)).toBe('Yesterday afternoon');
    expect(whenWords(at(24, 23), now)).toBe('Last night');
    expect(whenWords(at(22, 19), now)).toBe('Tuesday evening');
    expect(whenWords(at(12, 10), now)).toBe('12 Sep');
  });

  test('files grouped by task and by time with the app in front, newest first, missing files left out', () => {
    const events = [
      ev(at(24, 14), 'hero.png', { app: 'Figma', kind: 'drop' }),
      ev(at(24, 14, 20), 'logo.svg', { app: 'Figma' }),
      ev(at(24, 15), 'gone.png', { app: 'Figma' }),
      ev(at(25, 9), 'parser.test.ts', { kind: 'task-out', task: 'Add tests' }),
      ev(at(25, 10), 'invoice.pdf', { app: 'Mail' }),
    ];
    const groups = memoryGroups(events, now, (file) => !file.endsWith('gone.png'));
    expect(groups).toEqual([
      { cue: 'This morning, in Mail', paths: ['/w/invoice.pdf'] },
      { cue: 'From “Add tests”', paths: ['/w/parser.test.ts'] },
      { cue: 'Yesterday afternoon, in Figma', paths: ['/w/logo.svg', '/w/hero.png'] },
    ]);
  });

  test('a group that only repeats one already shown is left out, and the count is capped', () => {
    const events = [ev(at(25, 9), 'a.ts', { kind: 'task-out', task: 'Fix' }), ev(at(25, 9, 1), 'b.ts', { kind: 'task-out', task: 'Fix' })];
    // "This morning" holds exactly the task's files: one group (the more specific cue), not two.
    expect(memoryGroups(events, now).map((g) => g.cue)).toEqual(['From “Fix”']);
    const many = Array.from({ length: 12 }, (_, i) => ev(at(10 + i, 10), `f${i}.md`));
    expect(memoryGroups(many, now)).toHaveLength(5);
  });
});

describe('the activity log', () => {
  test('kept across restarts, absolute paths only, app and task names cut to size', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'recall-')), 'activity.jsonl');
    let clock = at(1, 9);
    const log = new ActivityLog(file, () => clock);
    expect(log.record({ kind: 'drop', path: '/w/a.png', app: 'x'.repeat(200) })).not.toBeNull();
    expect(log.record({ kind: 'use', path: 'relative.png' })).toBeNull();
    clock += 1_000;
    log.record({ kind: 'task-out', path: '/w/b.ts', task: 'Add tests' });
    const again = new ActivityLog(file);
    expect(again.all().map((e) => [e.kind, e.path, e.app?.length, e.task])).toEqual([['drop', '/w/a.png', 60, undefined], ['task-out', '/w/b.ts', undefined, 'Add tests']]);
  });

  test('a damaged line is skipped, not fatal; past its cap the oldest events go', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'recall-')), 'activity.jsonl');
    writeFileSync(file, `${JSON.stringify({ at: 1, kind: 'use', path: '/w/a' })}\n{broken\n${JSON.stringify({ at: 2, kind: 'nonsense', path: '/w/b' })}\n`);
    let clock = 10;
    const log = new ActivityLog(file, () => clock++, 4);
    expect(log.all()).toHaveLength(1);
    for (const name of ['b', 'c', 'd', 'e', 'f', 'g']) log.record({ kind: 'use', path: `/w/${name}` });
    expect(log.all().map((e) => e.path)).toEqual(['/w/d', '/w/e', '/w/f', '/w/g']);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(4);
  });
});
