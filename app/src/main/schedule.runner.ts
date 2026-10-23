import { dialog, Notification } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ThreadManager } from './thread.manager';
import { loadSettings, saveSettings } from './settings';
import { describeSchedule, dueSchedules, type Schedule } from './schedules';

/**
 * Repeating ⌘2 tasks (schedules.ts decides what is due): storing them, starting a run, and the menu bar's "Scheduled
 * tasks". Moved out of main/index.ts (flaw list C13).
 */
export interface ScheduleRunnerHost {
  threads(): Pick<ThreadManager, 'list' | 'create' | 'addNote' | 'submit'>;
  quickModel(): string | undefined;
  openThread(id: string): void;
  updateTray(): void;
}

let host: ScheduleRunnerHost | null = null;
/** Until this is set (the threads exist), runSchedules does nothing. */
export function setScheduleRunnerHost(next: ScheduleRunnerHost): void { host = next; }

export const loadSchedules = (): Schedule[] => loadSettings().schedules ?? [];
export function saveSchedules(list: Schedule[]): void { saveSettings({ schedules: list }); host?.updateTray(); }
export const removeSchedule = (id: string): void => saveSchedules(loadSchedules().filter((s) => s.id !== id));
/** Resuming counts from now, so a paused schedule never starts a run it missed while paused. */
const setScheduleEnabled = (id: string, enabled: boolean): void =>
  saveSchedules(loadSchedules().map((s) => (s.id === id ? { ...s, enabled, ...(enabled ? { lastRunAt: Date.now() } : {}) } : s)));
/**
 * One run of a repeating task: a new ⌘2 task in its folder, which asks before changing anything like every task.
 * 'busy' (four tasks already running) creates nothing, so the run is tried again a minute later.
 */
async function startScheduled(schedule: Schedule): Promise<'started' | 'busy' | 'failed'> {
  if (host!.threads().list().filter((t) => ['working', 'starting', 'needs-you'].includes(t.status)).length >= 4) return 'busy';
  try {
    const root = await fsp.realpath(schedule.root);
    if (!(await fsp.stat(root)).isDirectory()) throw new Error(`${path.basename(schedule.root)} is not a folder`);
    const id = host!.threads().create(root, '', 'quick', schedule.model || host!.quickModel());
    host!.threads().addNote(id, `${describeSchedule(schedule)} · scheduled task`);
    host!.threads().submit(id, schedule.prompt, schedule.prompt, true);
    if (Notification.isSupported()) {
      const note = new Notification({ title: `Scheduled: ${schedule.title}`, subtitle: `Started in ${path.basename(root)}`, body: 'It will ask before it changes anything.' });
      note.on('click', () => host!.openThread(id));
      note.show();
    }
    return 'started';
  } catch (error) {
    if (Notification.isSupported()) new Notification({ title: `Couldn’t start “${schedule.title}”`, body: (error as Error).message }).show();
    return 'failed';
  }
}
let schedulesRunning = false;
export async function runSchedules(): Promise<void> {
  if (schedulesRunning || !host) return;
  schedulesRunning = true;
  try {
    const now = Date.now();
    const { due, skipped } = dueSchedules(loadSchedules(), now);
    const done = new Set(skipped.map((s) => s.id));
    for (const schedule of due) if ((await startScheduled(schedule)) !== 'busy') done.add(schedule.id);
    if (done.size) saveSchedules(loadSchedules().map((s) => (done.has(s.id) ? { ...s, lastRunAt: now } : s)));
  } finally {
    schedulesRunning = false;
  }
}
async function runScheduleNow(id: string): Promise<void> {
  const schedule = loadSchedules().find((s) => s.id === id);
  if (schedule && (await startScheduled(schedule)) === 'busy') {
    void dialog.showMessageBox({ type: 'info', message: 'Four tasks are already running.', detail: 'Stop one, or let one finish, then run it again.' });
  }
}
/** The menu bar's "Scheduled tasks": each repeating task with Run now, Pause/Resume and Stop repeating. */
export function scheduleMenu(): Electron.MenuItemConstructorOptions[] {
  const list = loadSchedules();
  if (!list.length) return [];
  return [
    { label: 'Scheduled tasks', submenu: list.map((s): Electron.MenuItemConstructorOptions => ({
      label: `${s.enabled ? '' : 'Paused · '}${s.title.slice(0, 48)} — ${describeSchedule(s)}`,
      submenu: [
        { label: `In ${path.basename(s.root)}`, enabled: false },
        { label: 'Run now', click: () => void runScheduleNow(s.id) },
        { label: s.enabled ? 'Pause' : 'Resume', click: () => setScheduleEnabled(s.id, !s.enabled) },
        { type: 'separator' },
        { label: 'Stop repeating', click: () => removeSchedule(s.id) },
      ],
    })) },
    { type: 'separator' },
  ];
}
