import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as path from 'path';

/**
 * God's Land stage 8 (docs/product-reset/gods-land/03_PLAN.md): find by vague memory, and predictive cards.
 *
 * People forget a file's name but remember its CONTEXT — when, which app they were in, which task it came from
 * (Stuff I've Seen, SIGIR 2003; research 02 §3). So the notch keeps a small log of what the person did with files
 * THROUGH BIMAX — dropped on the shelf, used from it, handed to a ⌘2 task, made by a task — with the app that was in
 * front at the time. Nothing else is watched: no Spotlight, no file system scan, no contents. The log stays on this Mac.
 *
 * Two things are built from it:
 * - **Recall**: the files grouped by the cues people remember ("Yesterday afternoon, in Figma", "From “Add tests”").
 *   The notch takes no input (owner decision 3), so this is browsing, not a search box.
 * - **Probably next**: a recency/frequency time series with context (Quick Access, KDD 2017) — but only once it has
 *   beaten plain "most recent first" on this person's own log (the plan's exit rule). Until then the row is "Recent".
 */

export type ActivityKind = 'drop' | 'use' | 'edit' | 'made' | 'task-out';
export interface Activity {
  at: number;
  kind: ActivityKind;
  path: string;
  /** The app in front when it happened (the notch never activates, so this is the person's app). */
  app?: string;
  /** The ⌘2 task a file came out of. */
  task?: string;
}

const KINDS = new Set<ActivityKind>(['drop', 'use', 'edit', 'made', 'task-out']);
/** Kinds that are the person's own choice of file: only these are predicted in a replay. */
const CHOSEN = new Set<ActivityKind>(['drop', 'use', 'edit']);
/** The log keeps this many events (~100 bytes each); older ones are dropped when it is rewritten. */
export const MAX_EVENTS = 20_000;

function validEvent(e: unknown): e is Activity {
  const a = e as Activity;
  return !!a && typeof a.at === 'number' && Number.isFinite(a.at) && KINDS.has(a.kind) && typeof a.path === 'string' && path.isAbsolute(a.path);
}

/** The log: one JSON line per event, appended; rewritten (atomically) only when it grows past half again its cap. */
export class ActivityLog {
  private events: Activity[] = [];

  constructor(private readonly file: string, private readonly now: () => number = Date.now, private readonly cap = MAX_EVENTS) {
    try {
      this.events = readFileSync(file, 'utf8').split('\n').flatMap((line) => {
        if (!line.trim()) return [];
        try { const e: unknown = JSON.parse(line); return validEvent(e) ? [e] : []; } catch { return []; }
      });
    } catch { this.events = []; }
    this.events.sort((a, b) => a.at - b.at);
  }

  record(input: { kind: ActivityKind; path: string; app?: string; task?: string }): Activity | null {
    const event: Activity = {
      at: this.now(), kind: input.kind, path: input.path,
      ...(input.app ? { app: input.app.slice(0, 60) } : {}), ...(input.task ? { task: input.task.slice(0, 80) } : {}),
    };
    if (!validEvent(event)) return null;
    this.events.push(event);
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (this.events.length > this.cap * 1.5) {
      this.events = this.events.slice(-this.cap);
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, this.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      renameSync(temp, this.file);
    } else {
      appendFileSync(this.file, JSON.stringify(event) + '\n');
    }
    return event;
  }

  all(): readonly Activity[] {
    return this.events;
  }
}

// ── Probably next ───────────────────────────────────────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEIGHT: Record<ActivityKind, number> = { drop: 1, use: 1.2, edit: 1.5, made: 1, 'task-out': 1 };

export interface PredictContext {
  now: number;
  /** The app in front now. */
  app?: string;
  /** The file used last: never suggested (it is already at hand), and the source of "what usually comes after". */
  last?: string;
  /** Files already in view (the shelf's front cards): not suggested again. */
  exclude?: ReadonlySet<string>;
}
export type Ranker = (events: readonly Activity[], context: PredictContext, k: number) => string[];

/** The baseline the plan names: most recently used first. */
export const mostRecent: Ranker = (events, context, k) => {
  const out: string[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < k; i--) {
    const p = events[i]!.path;
    if (events[i]!.at > context.now || p === context.last || context.exclude?.has(p) || out.includes(p)) continue;
    out.push(p);
  }
  return out;
};

const hourOf = (at: number): number => new Date(at).getHours();
const hourDistance = (a: number, b: number): number => Math.min(Math.abs(a - b), 24 - Math.abs(a - b));

/**
 * Recency and frequency at three time scales (hours, a day, a week), then three context multipliers: how often the
 * file was used in the app in front now, at this time of day, and right after the file used last.
 */
export const predict: Ranker = (events, context, k) => {
  const stats = new Map<string, { score: number; total: number; app: number; hour: number }>();
  const nowHour = hourOf(context.now);
  const after = new Map<string, number>();
  let afterTotal = 0;
  let previous: string | undefined;
  for (const e of events) {
    if (e.at > context.now) break;
    if (context.last && previous === context.last && e.path !== context.last) {
      after.set(e.path, (after.get(e.path) ?? 0) + 1);
      afterTotal++;
    }
    if (e.path !== previous) previous = e.path;
    const age = context.now - e.at;
    const s = stats.get(e.path) ?? { score: 0, total: 0, app: 0, hour: 0 };
    s.score += WEIGHT[e.kind] * (Math.exp(-age / (2 * HOUR)) + 0.5 * Math.exp(-age / DAY) + 0.25 * Math.exp(-age / (7 * DAY)));
    s.total++;
    if (context.app && e.app === context.app) s.app++;
    if (hourDistance(hourOf(e.at), nowHour) <= 1) s.hour++;
    stats.set(e.path, s);
  }
  const scored: Array<[string, number]> = [];
  for (const [file, s] of stats) {
    if (file === context.last || context.exclude?.has(file)) continue;
    const inApp = context.app ? 1 + 1.5 * (s.app / s.total) : 1;
    const atHour = 1 + 0.5 * (s.hour / s.total);
    const next = afterTotal ? 1 + 2 * ((after.get(file) ?? 0) / afterTotal) : 1;
    scored.push([file, s.score * inApp * atHour * next]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, k).map(([file]) => file);
};

/** How much of the past a prediction looks at: at the week-long scale, older use adds under 2% (e^-30/7). */
export const HISTORY = 2_000;

export interface Replay { trials: number; hits: number }

/**
 * Replays the log: at each moment the person chose a file they had used before (and not the one they had just
 * used), would `rank` have had it in its top k, knowing only what came before? The last `window` events are scored.
 */
export function replay(events: readonly Activity[], rank: Ranker, k = 3, window = 600): Replay {
  const start = Math.max(1, events.length - window);
  const seen = new Set(events.slice(0, start).map((e) => e.path));
  let trials = 0;
  let hits = 0;
  for (let i = start; i < events.length; i++) {
    const e = events[i]!;
    const previous = events[i - 1]!;
    if (CHOSEN.has(e.kind) && seen.has(e.path) && e.path !== previous.path) {
      trials++;
      const history = events.slice(Math.max(0, i - HISTORY), i);
      if (rank(history, { now: e.at, app: e.app, last: previous.path }, k).includes(e.path)) hits++;
    }
    seen.add(e.path);
  }
  return { trials, hits };
}

/** Fewer re-finds than this and the log says nothing either way. */
export const MIN_TRIALS = 30;

export interface Verdict { use: 'predict' | 'recent'; trials: number; predictHits: number; recentHits: number }

/** The plan's exit rule, applied to this person's own log: the ranker is used only when it has beaten the baseline. */
export function verdict(events: readonly Activity[], k = 3): Verdict {
  const p = replay(events, predict, k);
  const r = replay(events, mostRecent, k);
  return { use: p.trials >= MIN_TRIALS && p.hits > r.hits ? 'predict' : 'recent', trials: p.trials, predictHits: p.hits, recentHits: r.hits };
}

// ── Recall: files by the cues people remember ───────────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function partOfDay(hour: number): 'morning' | 'afternoon' | 'evening' | 'night' {
  return hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 17 ? 'afternoon' : hour >= 17 && hour < 22 ? 'evening' : 'night';
}

const startOfDay = (at: number): number => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** When something happened, the way a person remembers it: "This morning", "Yesterday evening", "Tuesday", "12 Sep". */
export function whenWords(at: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  const date = new Date(at);
  const part = partOfDay(date.getHours());
  if (days <= 0) return part === 'night' ? 'Earlier tonight' : `This ${part}`;
  if (days === 1) return part === 'night' ? 'Last night' : `Yesterday ${part}`;
  if (days < 7) return `${WEEKDAYS[date.getDay()]} ${part}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

export interface MemoryGroup { cue: string; paths: string[] }
export const MAX_GROUPS = 5;
export const MAX_PER_GROUP = 6;

/**
 * The log as groups a person would recognise: each ⌘2 task's files ("From “Add tests”"), and each stretch of time
 * with the app mostly in front then ("Yesterday afternoon, in Figma"). Newest first; a group that only repeats one
 * already shown is left out.
 */
export function memoryGroups(events: readonly Activity[], now: number, exists: (file: string) => boolean = () => true): MemoryGroup[] {
  const groups = new Map<string, { cue: string; paths: string[]; newest: number }>();
  const add = (key: string, cue: string, e: Activity): void => {
    const g = groups.get(key) ?? { cue, paths: [], newest: e.at };
    if (!g.paths.includes(e.path) && g.paths.length < MAX_PER_GROUP && exists(e.path)) g.paths.push(e.path);
    groups.set(key, g);
  };
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.at > now) continue;
    if (e.task) add(`task:${e.task}`, `From “${e.task}”`, e);
    const when = whenWords(e.at, now);
    add(`when:${when}|${e.app ?? ''}`, e.app ? `${when}, in ${e.app}` : when, e);
  }
  const chosen: MemoryGroup[] = [];
  for (const g of [...groups.values()].sort((a, b) => b.newest - a.newest)) {
    if (!g.paths.length) continue;
    if (chosen.some((c) => g.paths.every((p) => c.paths.includes(p)))) continue;
    chosen.push({ cue: g.cue, paths: g.paths });
    if (chosen.length === MAX_GROUPS) break;
  }
  return chosen;
}
