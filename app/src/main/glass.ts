import { isQuickThread, type ThreadSummary } from '../shared/threads';

/**
 * God's Land stage 4 (docs/product-reset/gods-land/03_PLAN.md): the notch's glass says how the ⌘2 tasks are doing,
 * as a material — the owner's shades (00 §"The Palette of Glass States", 01 §1) — with a label and a symbol so it
 * never depends on colour alone.
 *
 * One state for the notch, the most urgent first. Every state is read from something the app really knows:
 * - ink       a task is waiting for the person (status needs-you);
 * - fissure   a result the person has not looked at yet failed (the turn failed, ran out of time, or its check failed);
 * - frost     a task is working but its record has not changed for STALL_MS — the summary only changes on real
 *             progress (thread.manager.ts persist() ignores idle heartbeats), so this is "stuck", not "busy";
 * - night     a Night Shift task is working (FL5);
 * - molten    tasks are working;
 * - bubbles   messages are queued and nothing is working yet;
 * - prism     a result the person has not looked at yet passed (or finished with no check);
 * - water     all quiet.
 * Mercury (live streaming) is in the design but not here: the app has no streaming signal per task yet, and a state
 * that guesses is worse than none.
 */

export type GlassState = 'ink' | 'fissure' | 'frost' | 'night' | 'molten' | 'bubbles' | 'prism' | 'water';
export interface Glass { state: GlassState; label: string }

/** How long a working task may go without any change before its glass frosts. */
export const STALL_MS = 30_000;
/** How long an unseen result keeps its colour when the person never opens the notch. */
export const UNSEEN_MS = 15 * 60_000;

export type Outcome = 'passed' | 'failed';
export interface Unseen { outcome: Outcome; title: string; at: number }

const TITLE = 40;
const short = (title: string): string => (title.length > TITLE ? `${title.slice(0, TITLE - 1)}…` : title);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** How a finished task's result reads: a failed turn, a timeout or a failed check is a failure. */
export function outcomeOf(t: ThreadSummary): Outcome {
  return t.outcome === 'failed' || t.outcome === 'time-limit' || t.check === 'failed' ? 'failed' : 'passed';
}

/** Stall time in words, in steps coarse enough that the label does not change every second. */
export function stalledFor(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 30_000) * 30} s`;
  if (ms < 60 * 60_000) return plural(Math.floor(ms / 60_000), 'min', 'min');
  return plural(Math.floor(ms / 3_600_000), 'hour', 'hours');
}

export function notchGlass(input: {
  threads: readonly ThreadSummary[];
  now: number;
  /** Thread ids with a Night Shift running. */
  night?: ReadonlySet<string>;
  /** Results the person has not looked at, by thread id. */
  unseen?: ReadonlyMap<string, Unseen>;
}): Glass {
  const { now } = input;
  const quick = input.threads.filter(isQuickThread);
  const working = quick.filter((t) => t.status === 'working' || t.status === 'starting');
  const unseen = [...(input.unseen ?? new Map()).values()].filter((u) => now - u.at < UNSEEN_MS).sort((a, b) => b.at - a.at);

  const asking = quick.filter((t) => t.status === 'needs-you');
  if (asking.length) return { state: 'ink', label: asking.length === 1 ? `${short(asking[0]!.title)} needs you` : `${asking.length} tasks need you` };

  const failed = unseen.find((u) => u.outcome === 'failed');
  if (failed) return { state: 'fissure', label: `${short(failed.title)} failed` };

  const stalled = working.filter((t) => now - t.updatedAt >= STALL_MS).sort((a, b) => a.updatedAt - b.updatedAt);
  if (stalled.length) return { state: 'frost', label: `${short(stalled[0]!.title)} · no progress for ${stalledFor(now - stalled[0]!.updatedAt)}` };

  if (working.some((t) => input.night?.has(t.id))) return { state: 'night', label: 'Night Shift is working' };

  if (working.length) return { state: 'molten', label: working.length === 1 ? `${short(working[0]!.title)} · working` : `${working.length} tasks working` };

  const queued = quick.reduce((sum, t) => sum + (t.queued ?? 0), 0);
  if (queued) return { state: 'bubbles', label: `${plural(queued, 'message', 'messages')} waiting to start` };

  const passed = unseen.find((u) => u.outcome === 'passed');
  if (passed) return { state: 'prism', label: `${short(passed.title)} is done` };

  return { state: 'water', label: 'All quiet' };
}

/**
 * When the glass will next change with nothing else happening: the moment the oldest working task crosses STALL_MS,
 * the next coarse step of an existing stall, or an unseen result expiring. Null when nothing is waiting on time.
 */
export function nextGlassChange(input: { threads: readonly ThreadSummary[]; now: number; unseen?: ReadonlyMap<string, Unseen> }): number | null {
  const times: number[] = [];
  for (const t of input.threads.filter(isQuickThread)) {
    if (t.status !== 'working' && t.status !== 'starting') continue;
    const age = input.now - t.updatedAt;
    times.push(age < STALL_MS ? t.updatedAt + STALL_MS : input.now + (age < 60_000 ? 30_000 : 60_000));
  }
  for (const u of input.unseen?.values() ?? []) if (input.now - u.at < UNSEEN_MS) times.push(u.at + UNSEEN_MS);
  return times.length ? Math.min(...times) : null;
}
