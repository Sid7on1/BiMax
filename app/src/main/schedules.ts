/**
 * Scheduled ⌘2 tasks: "every Friday at 17:00, move Downloads older than 30 days to the Bin". Pure, so the timing can
 * be tested without clocks or Electron. Times are local wall-clock times, so a schedule keeps its hour across
 * daylight-saving changes.
 *
 * A run that was missed while the Mac slept or Bimax was closed still happens once if it is less than a day late;
 * anything older is skipped rather than replayed, so opening the lid never starts a pile of stale tasks.
 */
export type Cadence = 'daily' | 'weekdays' | 'weekly';

export interface Schedule {
  id: string;
  /** The task's title, for menus and notifications. */
  title: string;
  root: string;
  prompt: string;
  model?: string;
  cadence: Cadence;
  /** 0 = Sunday … 6 = Saturday; used by weekly schedules. */
  weekday: number;
  hour: number;
  minute: number;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
}

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** The first scheduled time strictly after `after`, in local time. */
export function nextRun(schedule: Pick<Schedule, 'cadence' | 'weekday' | 'hour' | 'minute'>, after: number): number {
  const start = new Date(after);
  for (let offset = 0; offset < 9; offset++) {
    const candidate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, schedule.hour, schedule.minute, 0, 0);
    if (candidate.getTime() <= after) continue;
    const day = candidate.getDay();
    if (schedule.cadence === 'daily'
      || (schedule.cadence === 'weekdays' && day >= 1 && day <= 5)
      || (schedule.cadence === 'weekly' && day === schedule.weekday)) return candidate.getTime();
  }
  return after + 7 * DAY;
}

/** Which schedules run now, and which missed their time by a day or more (skipped, not run late). */
export function dueSchedules(list: readonly Schedule[], now: number): { due: Schedule[]; skipped: Schedule[] } {
  const due: Schedule[] = [];
  const skipped: Schedule[] = [];
  for (const schedule of list) {
    if (!schedule.enabled) continue;
    let latest = nextRun(schedule, schedule.lastRunAt ?? schedule.createdAt);
    if (latest > now) continue;
    for (let i = 0; i < 400; i++) {
      const following = nextRun(schedule, latest);
      if (following > now) break;
      latest = following;
    }
    (now - latest < DAY ? due : skipped).push(schedule);
  }
  return { due, skipped };
}

export function describeSchedule(schedule: Pick<Schedule, 'cadence' | 'weekday' | 'hour' | 'minute'>): string {
  const at = `${pad(schedule.hour)}:${pad(schedule.minute)}`;
  if (schedule.cadence === 'daily') return `Every day at ${at}`;
  if (schedule.cadence === 'weekdays') return `Every weekday at ${at}`;
  return `Every ${WEEKDAYS[schedule.weekday] ?? 'week'} at ${at}`;
}

/** A schedule that repeats a task from now on, at the current time (and weekday, for weekly). */
export function newSchedule(input: { id: string; title: string; root: string; prompt: string; model?: string; cadence: Cadence; now: Date }): Schedule {
  return {
    id: input.id, title: input.title, root: input.root, prompt: input.prompt, ...(input.model ? { model: input.model } : {}),
    cadence: input.cadence, weekday: input.now.getDay(), hour: input.now.getHours(), minute: input.now.getMinutes(),
    enabled: true, createdAt: input.now.getTime(),
  };
}
