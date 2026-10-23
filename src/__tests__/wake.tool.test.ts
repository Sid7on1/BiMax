import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { engineEvents } from '../engine/events';
import { ToolRegistry } from '../tools/tool.registry';
import { __setWakeProbe, createWakeTool, parseWakeTime } from '../tools/implementations/wake.tool';

/** Backlog F4: a task asks to be resumed by an event; the engine registers it and the app delivers it. */

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as any;
const tool = createWakeTool(governor);
let dir: string;
let requests: any[];
let cancels: any[];
const onRequest = (w: any) => requests.push(w);
const onCancel = (c: any) => cancels.push(c);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-wake-'));
  process.env.BIMAX_WAKES = '1';
  requests = []; cancels = [];
  engineEvents.on('wake_request', onRequest);
  engineEvents.on('wake_cancel', onCancel);
  __setWakeProbe({ head: async () => 'a'.repeat(40), ghReady: async () => null });
});
afterEach(() => {
  engineEvents.off('wake_request', onRequest);
  engineEvents.off('wake_cancel', onCancel);
  delete process.env.BIMAX_WAKES;
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (args: object) => tool.execute(args, { cwd: dir });

test('without the app there is nobody to deliver a wake, so the tool refuses rather than promise one', async () => {
  delete process.env.BIMAX_WAKES;
  await expect(call({ action: 'at', minutes: 5, reason: 'rerun the tests' })).rejects.toThrow(/not running in it, so nothing would wake the task/);
  expect(requests).toEqual([]);
});

test('a time wake: minutes from now, bounded to seven days, and it tells the user', async () => {
  const told = jest.fn();
  engineEvents.on('message', told);
  const before = Date.now();
  try { await expect(call({ action: 'at', minutes: 30, reason: 'check the deploy' })).resolves.toMatch(/^Registered wake \w+: at .*End your turn now/); }
  finally { engineEvents.off('message', told); }
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ kind: 'at', reason: 'check the deploy' });
  expect(requests[0].at).toBeGreaterThanOrEqual(before + 30 * 60_000);
  expect(requests[0].at).toBeLessThan(before + 31 * 60_000);
  expect(told).toHaveBeenCalledWith(expect.objectContaining({ role: 'system', content: expect.stringContaining('to: check the deploy') }));
  await expect(call({ action: 'at', minutes: 8 * 24 * 60, reason: 'x' })).rejects.toThrow(/at most 7 days ahead/);
  await expect(call({ action: 'at', time: '2020-01-01T00:00:00Z', reason: 'x' })).rejects.toThrow(/already passed/);
  await expect(call({ action: 'at', time: 'soon', reason: 'x' })).rejects.toThrow(/Give a time/);
});

test('"HH:MM" is the next one: later today, or tomorrow once it has passed', () => {
  const morning = new Date(2026, 8, 21, 9, 0, 0).getTime();
  expect(new Date(parseWakeTime('14:30', morning)!).toString()).toBe(new Date(2026, 8, 21, 14, 30, 0).toString());
  expect(new Date(parseWakeTime('08:15', morning)!).toString()).toBe(new Date(2026, 8, 22, 8, 15, 0).toString());
  expect(parseWakeTime('25:00', morning)).toBeNull();
});

test('a folder wake needs a real folder, and defaults to the task folder and any file', async () => {
  await expect(call({ action: 'folder', path: 'missing', reason: 'file the invoice' })).rejects.toThrow(/is not a folder/);
  await call({ action: 'folder', reason: 'file the invoice' });
  expect(requests[0]).toMatchObject({ kind: 'folder', path: dir, match: 'any' });
  fs.mkdirSync(path.join(dir, 'inbox'));
  await call({ action: 'folder', path: 'inbox', match: 'pdf', reason: 'file the invoice' });
  expect(requests[1]).toMatchObject({ path: path.join(dir, 'inbox'), match: 'pdf' });
});

test('a CI wake records the commit, and says why when it cannot be kept', async () => {
  await call({ action: 'ci', reason: 'fix whatever fails' });
  expect(requests[0]).toMatchObject({ kind: 'ci', sha: 'a'.repeat(40), path: dir });
  __setWakeProbe({ head: async () => null, ghReady: async () => null });
  await expect(call({ action: 'ci', reason: 'x' })).rejects.toThrow(/not a git repository with a commit/);
  __setWakeProbe({ head: async () => 'b'.repeat(40), ghReady: async () => 'the GitHub CLI (gh) is not signed in — run `gh auth login`' });
  await expect(call({ action: 'ci', reason: 'x' })).rejects.toThrow(/CI results come from GitHub, and the GitHub CLI \(gh\) is not signed in/);
  expect(requests).toHaveLength(1);
});

test('an answer wake needs the question; every wake needs a reason; cancel goes to the app', async () => {
  await expect(call({ action: 'answer', reason: 'continue' })).rejects.toThrow(/Give the question/);
  await expect(call({ action: 'at', minutes: 5 })).rejects.toThrow(/Give a reason/);
  await call({ action: 'answer', question: 'Which of the two logos?', reason: 'use the one chosen' });
  expect(requests[0]).toMatchObject({ kind: 'answer', question: 'Which of the two logos?' });
  await call({ action: 'cancel', id: 'all' });
  expect(cancels).toEqual([{ id: 'all' }]);
});

test('the model can always see WakeTool', () => {
  const registry = new ToolRegistry();
  registry.register(tool);
  expect(registry.isSent('WakeTool', 'smart')).toBe(true);
});
