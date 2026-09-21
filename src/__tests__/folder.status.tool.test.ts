import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { engineEvents } from '../engine/events';
import { ToolRegistry } from '../tools/tool.registry';
import { checkStatusItems, createFolderStatusTool } from '../tools/implementations/folder.status.tool';

/** Backlog FL1 part 2: a task in a folder with an outcome reports each file as ready or needing the person. */

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as any;
const tool = createFolderStatusTool(governor);
let reports: any[];
let root: string;
const onReport = (r: any) => reports.push(r);
beforeEach(() => {
  reports = [];
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-outcome-')));
  engineEvents.on('folder_status', onReport);
  process.env.BIMAX_FOLDER_OUTCOME = 'Every receipt is a PDF named by date, in its month folder.';
  process.env.BIMAX_THREAD_ROOT = root;
});
afterEach(() => {
  engineEvents.off('folder_status', onReport);
  delete process.env.BIMAX_FOLDER_OUTCOME;
  delete process.env.BIMAX_THREAD_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

test('files are reported with absolute paths inside the folder, and a reason for each that needs the person', async () => {
  const result = await tool.execute({ items: [
    { path: '2026-09/2026-09-03 Cafe 4.50.pdf', state: 'ready' },
    { path: `${root}/scan 12.jpg`, state: 'needs-you', reason: '  no date on the receipt —\n which month? ' },
  ] }, { cwd: root });
  expect(reports).toEqual([{ items: [
    { path: `${root}/2026-09/2026-09-03 Cafe 4.50.pdf`, state: 'ready' },
    { path: `${root}/scan 12.jpg`, state: 'needs-you', reason: 'no date on the receipt — which month?' },
  ] }]);
  expect(String(result)).toContain('2 files: 1 ready, 1 needing the person');
});

test('nothing is recorded without an outcome, outside the folder, or without a reason', async () => {
  const bad = async (items: unknown): Promise<string> => { try { await tool.execute({ items }, { cwd: root }); return 'ran'; } catch (e) { return (e as Error).message; } };
  expect(await bad([{ path: '../elsewhere/a.pdf', state: 'ready' }])).toMatch(/not inside this task's folder/);
  expect(await bad([{ path: root, state: 'ready' }])).toMatch(/not inside/);
  expect(await bad([{ path: 'a.pdf', state: 'done' }])).toMatch(/"ready" or "needs-you"/);
  expect(await bad([{ path: 'a.pdf', state: 'needs-you' }])).toMatch(/give a `reason`/);
  expect(await bad([{ state: 'ready' }])).toMatch(/needs a `path`/);
  expect(await bad([])).toMatch(/Give `items`/);
  expect(await bad(Array.from({ length: 201 }, (_, i) => ({ path: `f${i}`, state: 'ready' })))).toMatch(/at most 200/);
  delete process.env.BIMAX_FOLDER_OUTCOME;
  expect(await bad([{ path: 'a.pdf', state: 'ready' }])).toMatch(/no outcome set/);
  expect(reports).toEqual([]);
});

test('reasons are one line and capped', () => {
  const [item] = checkStatusItems([{ path: 'a.pdf', state: 'needs-you', reason: 'x'.repeat(400) }], '/r');
  expect(item!.reason).toHaveLength(300);
  expect(checkStatusItems([{ path: 'a.pdf', state: 'ready', reason: 'fine' }], '/r')).toEqual([{ path: '/r/a.pdf', state: 'ready', reason: 'fine' }]);
});

test('it is always shown to the model when it is registered, and absent otherwise', () => {
  const registry = new ToolRegistry();
  const names = (): string[] => registry.getSchemas({ mode: 'smart' }).map((t: any) => t.name ?? t.function?.name);
  expect(names()).not.toContain('FolderStatusTool');
  registry.register(tool);
  expect(names()).toContain('FolderStatusTool');
});
