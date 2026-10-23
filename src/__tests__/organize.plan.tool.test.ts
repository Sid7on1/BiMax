import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { engineEvents } from '../engine/events';
import { checkPlan, createOrganizePlanTool, defaultGroup } from '../tools/implementations/organize.plan.tool';

/** Backlog FL2: a task proposes how to organize files; the app shows it as a preview the person rearranges. */

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as any;
const tool = createOrganizePlanTool(governor);
let root: string;
let plans: any[];
const onPlan = (p: any) => plans.push(p);
const file = (rel: string): string => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); return p; };
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-plan-')));
  plans = [];
  engineEvents.on('organize_plan', onPlan);
  process.env.BIMAX_THREAD_ROOT = root;
});
afterEach(() => {
  engineEvents.off('organize_plan', onPlan);
  delete process.env.BIMAX_THREAD_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

test('a plan reaches the app with absolute paths and a group for every move, and nothing moves', async () => {
  const a = file('inv-a.pdf');
  const b = file('IMG_1.jpg');
  fs.mkdirSync(path.join(root, 'Photos'));
  const result = await tool.execute({ title: 'Sort Downloads', moves: [
    { from: 'inv-a.pdf', to: 'Invoices/2026/', group: 'Invoices' },
    { from: b, to: 'Photos' },
  ] }, { cwd: root });
  expect(plans).toHaveLength(1);
  expect(plans[0]).toMatchObject({ title: 'Sort Downloads', root, moves: [
    { from: a, to: path.join(root, 'Invoices/2026/inv-a.pdf'), group: 'Invoices' },
    { from: b, to: path.join(root, 'Photos/IMG_1.jpg'), group: 'JPG files' },
  ] });
  expect(String(result)).toContain('2 moves in 2 groups');
  expect(fs.existsSync(a)).toBe(true);
});

test('every problem is named together, and nothing is sent', async () => {
  file('a.pdf'); file('b.pdf'); file('keep/c.pdf');
  const run = async (moves: unknown): Promise<string> => { try { await tool.execute({ moves }, { cwd: root }); return 'ran'; } catch (e) { return (e as Error).message; } };
  const message = await run([
    { from: 'a.pdf', to: '../outside/a.pdf' },
    { from: 'missing.pdf', to: 'x/' },
    { from: 'b.pdf', to: 'keep/c.pdf' },
    { from: 'b.pdf', to: 'y/b.pdf' },
    { to: 'z' },
  ]);
  expect(message).toContain('a.pdf → ../outside/a.pdf leaves the task folder');
  expect(message).toContain('missing.pdf is not a file here');
  expect(message).toContain('keep/c.pdf already exists');
  expect(message).toContain('b.pdf is moved twice');
  expect(message).toContain('every move needs `from` and `to`');
  expect(await run([{ from: 'a.pdf', to: 'Z/a.pdf' }, { from: 'b.pdf', to: 'z/A.PDF' }])).toContain('two files would become');
  expect(await run([{ from: 'a.pdf', to: 'a.pdf' }])).toContain('Nothing in the plan changes');
  expect(await run([])).toContain('Give `moves`');
  delete process.env.BIMAX_THREAD_ROOT;
  expect(await run([{ from: 'a.pdf', to: 'x/' }])).toContain('not running in it');
  expect(plans).toEqual([]);
});

test('a file may move onto a place another file is leaving', () => {
  const exists = (f: string) => (['/r/a.txt', '/r/b.txt'].includes(f) ? 'file' as const : null);
  expect(checkPlan([{ from: 'a.txt', to: 'old/a.txt' }, { from: 'b.txt', to: 'a.txt' }], '/r', exists)).toHaveLength(2);
});

test('an unlabelled move is grouped by its kind of file', () => {
  expect(defaultGroup('/r/x.pdf')).toBe('PDF files');
  expect(defaultGroup('/r/README')).toBe('Other files');
});
