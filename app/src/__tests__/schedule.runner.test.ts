import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Repeating ⌘2 tasks' runner, moved out of main/index.ts into schedule.runner.ts (flaw list C13). Until the move it
 * could only run inside the app; here the settings file and the Bimax Threads are stand-ins.
 */

jest.mock('electron', () => ({ dialog: { showMessageBox: jest.fn() }, Notification: { isSupported: () => false } }));
const settings: { schedules?: unknown[] } = {};
jest.mock('../main/settings', () => ({
  loadSettings: () => settings,
  saveSettings: (patch: Record<string, unknown>) => Object.assign(settings, patch),
}));

import { runSchedules, setScheduleRunnerHost, loadSchedules } from '../main/schedule.runner';
import { newSchedule, type Schedule } from '../main/schedules';

const DAY = 24 * 60 * 60 * 1000;
const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-schedules-')));
afterAll(() => fs.rmSync(folder, { recursive: true, force: true }));

let running = 0;
const created: string[] = [];
const submitted: string[] = [];
let trayUpdates = 0;
setScheduleRunnerHost({
  threads: () => ({
    list: () => Array.from({ length: running }, (_, i) => ({ id: `r${i}`, status: 'working' })),
    create: (root: string) => { created.push(root); return `t${created.length}`; },
    addNote: () => undefined,
    submit: (_id: string, words: string) => { submitted.push(words); },
  }) as never,
  quickModel: () => undefined,
  openThread: () => undefined,
  updateTray: () => { trayUpdates++; },
});

const due = (root = folder): Schedule => newSchedule({ id: `s-${root.length}`, title: 'Morning report', root, prompt: 'Summarise yesterday', cadence: 'daily', now: new Date(Date.now() - DAY - 60_000) });
beforeEach(() => { settings.schedules = []; running = 0; created.length = 0; submitted.length = 0; trayUpdates = 0; });

test('a due schedule starts a new task in its folder and is marked as run', async () => {
  settings.schedules = [due()];
  await runSchedules();
  expect(created).toEqual([folder]);
  expect(submitted).toEqual(['Summarise yesterday']);
  expect(loadSchedules()[0]!.lastRunAt).toBeGreaterThan(Date.now() - 5_000);
  expect(trayUpdates).toBe(1);
});

test('with four tasks already running nothing is started, and the run is tried again later', async () => {
  settings.schedules = [due()];
  running = 4;
  await runSchedules();
  expect(created).toEqual([]);
  expect(loadSchedules()[0]!.lastRunAt).toBeUndefined();
});

test('a folder that is gone fails that run without starting a task, and it is not retried every minute', async () => {
  settings.schedules = [due(path.join(folder, 'gone'))];
  await runSchedules();
  expect(created).toEqual([]);
  expect(loadSchedules()[0]!.lastRunAt).toBeGreaterThan(Date.now() - 5_000);
});
