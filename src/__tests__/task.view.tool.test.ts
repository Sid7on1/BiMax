import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { engineEvents } from '../engine/events';
import { checkView, createTaskViewTool, readAnswer } from '../tools/implementations/task.view.tool';

/** Backlog FL8: a contact sheet, a matching table and a name editor, used by the person inside a task. */

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as any;
const tool = createTaskViewTool(governor);
let root: string;
const put = (rel: string): string => { const p = path.join(root, rel); fs.writeFileSync(p, 'x'); return p; };
const isFile = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-view-'))); process.env.BIMAX_THREAD_ROOT = root; });
afterEach(() => { delete process.env.BIMAX_THREAD_ROOT; fs.rmSync(root, { recursive: true, force: true }); });

test('a contact sheet: pictures in the folder, and what was picked comes back as paths', async () => {
  const a = put('IMG_1.JPG'); const b = put('IMG_2.heic');
  const answered: any[] = [];
  const answer = (question: string, options: string[], resolve: (a: string) => void, isAsk: boolean, multi: boolean, body: string) => {
    answered.push({ question, options, isAsk, body: JSON.parse(body) });
    resolve(JSON.stringify({ picked: [b, '/etc/passwd'] }));
  };
  engineEvents.on('veto_prompt', answer);
  try {
    const result = await tool.execute({ view: 'photos', title: 'Pick the ones for the album', files: ['IMG_1.JPG', b] }, { cwd: root });
    expect(answered[0]).toEqual({ question: 'Pick the ones for the album', options: ['Cancel'], isAsk: true, body: { bimaxView: { view: 'photos', title: 'Pick the ones for the album', files: [a, b], pick: 'some' } } });
    expect(result).toBe(`The person picked 1 of 2:\n- ${b}`);
  } finally {
    engineEvents.off('veto_prompt', answer);
  }
});

test('only real files in the task folder, pictures on a contact sheet, names without slashes', () => {
  put('a.jpg'); put('notes.txt');
  const outside = path.join(path.dirname(root), `outside-${process.pid}.jpg`);
  fs.writeFileSync(outside, 'x');
  try {
    expect(() => checkView({ view: 'photos', files: [outside] }, root, isFile)).toThrow('not a file in the task folder');
    expect(() => checkView({ view: 'photos', files: [`../${path.basename(outside)}`] }, root, isFile)).toThrow('not a file in the task folder');
  } finally { fs.rmSync(outside, { force: true }); }
  expect(() => checkView({ view: 'photos', files: ['missing.jpg'] }, root, isFile)).toThrow('not a file in the task folder');
  expect(() => checkView({ view: 'photos', files: ['notes.txt'] }, root, isFile)).toThrow('these are not: notes.txt');
  expect(() => checkView({ view: 'photos', files: [] }, root, isFile)).toThrow('Give `files`');
  expect(() => checkView({ view: 'names', items: [{ path: 'a.jpg', name: 'sub/b.jpg' }] }, root, isFile)).toThrow('is not a file name');
  expect(() => checkView({ view: 'photos', files: Array.from({ length: 201 }, () => 'a.jpg') }, root, isFile)).toThrow('At most 200');
  expect(() => checkView({ view: 'chart' }, root, isFile)).toThrow('must be "photos", "match" or "names"');
  expect(checkView({ view: 'photos', files: ['a.jpg'], pick: 'one' }, root, isFile)).toMatchObject({ pick: 'one' });
});

test('a matching table keeps only pairs in range, and the answer reads as matches', () => {
  const view = checkView({ view: 'match', title: 'Match', left: ['Bank 12.00', 'Bank 40.00'], right: ['Inv A', 'Inv B'], pairs: [{ left: 0, right: 1 }, { left: 1, right: 9 }, { left: 5, right: 0 }, { left: 1 }] }, root, isFile);
  expect(view).toMatchObject({ pairs: [{ left: 0, right: 1 }, { left: 1, right: null }] });
  expect(readAnswer(view, JSON.stringify({ pairs: [{ left: 0, right: 0 }, { left: 1, right: null }] }))).toBe('The person confirmed these matches:\n- Bank 12.00 → Inv A\n- Bank 40.00 → (no match)');
});

test('a name editor returns the settled names, keeping the proposal where an edit is unusable', () => {
  const a = put('scan1.pdf'); const b = put('scan2.pdf');
  const view = checkView({ view: 'names', items: [{ path: 'scan1.pdf', name: '2026-09-01 Cafe.pdf' }, { path: 'scan2.pdf', name: '2026-09-02 Bus.pdf' }] }, root, isFile);
  const text = readAnswer(view, JSON.stringify({ names: [{ path: a, name: 'Cafe Sept.pdf' }, { path: b, name: 'x/y.pdf' }] }));
  expect(text).toContain('- scan1.pdf → Cafe Sept.pdf');
  expect(text).toContain('- scan2.pdf → 2026-09-02 Bus.pdf');
  expect(text).toContain('OrganizePlanTool');
});

test('a cancel, or a front-end that could not show the view, never becomes a made-up choice', () => {
  const view = { view: 'photos' as const, title: 't', files: ['/r/a.jpg'], pick: 'some' as const };
  expect(readAnswer(view, 'Cancel')).toContain('without choosing');
  expect(readAnswer(view, 'Yes')).toContain('could not be shown here');
});
