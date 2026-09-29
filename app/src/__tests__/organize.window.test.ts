import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The Organize preview's window and channels (FL2), moved out of main/index.ts into organize.window.ts (flaw list
 * C13). Until the move this ran only inside the app; here it runs against real files and a stand-in window.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-organize-window-')));
jest.mock('electron', () => ({ app: { getPath: () => require('path').join(tmp, 'userData') } }));

import { organizeWebContentsId, receiveOrganizePlan, registerOrganizeIpc, setOrganizeHost } from '../main/organize.window';
import type { IpcGate } from '../main/ipc.gate';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const gate: IpcGate = { handle: (channel, _fallback, fn) => { handlers.set(channel, fn as Handler); }, on: () => undefined };
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

const notes: Array<[string, string]> = [];
const window = { shown: 0, hidden: 0, sent: [] as unknown[] };
const fakeWindow = {
  isDestroyed: () => false, setResizable: () => undefined, show: () => { window.shown++; }, focus: () => undefined,
  hide: () => { window.hidden++; }, webContents: { id: 42, send: (_c: string, view: unknown) => { window.sent.push(view); } },
};
let protectedPaths: string[] = [];
const root = path.join(tmp, 'Downloads');

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'userData'), { recursive: true });
  setOrganizeHost({
    createWindow: () => fakeWindow as never,
    summary: () => ({ root, origin: 'quick' }),
    addNote: (id, text) => { notes.push([id, text]); },
    protectedIn: () => protectedPaths,
  });
  registerOrganizeIpc(gate);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const f of ['inv-a.pdf', 'inv-b.pdf', 'IMG_1.jpg']) fs.writeFileSync(path.join(root, f), f);
  notes.length = 0; protectedPaths = [];
});

const propose = () => receiveOrganizePlan('t1', { id: 'p1', title: 'Sort Downloads', moves: [
  { from: `${root}/inv-a.pdf`, to: `${root}/Invoices/inv-a.pdf`, group: 'Invoices' },
  { from: `${root}/inv-b.pdf`, to: `${root}/Invoices/inv-b.pdf`, group: 'Invoices' },
  { from: `${root}/IMG_1.jpg`, to: `${root}/Photos/IMG_1.jpg`, group: 'Photos' },
] });

test('the channels it registers, all through the gate', () => {
  expect([...handlers.keys()].sort()).toEqual(['organize:apply', 'organize:cancel', 'organize:current', 'organize:include', 'organize:keep', 'organize:move', 'organize:move-group']);
});

test('a proposed plan opens the preview and moves nothing until it is applied', async () => {
  propose();
  expect(organizeWebContentsId()).toBe(42);
  expect(window.shown).toBeGreaterThan(0);
  expect(call('organize:current')).toEqual(expect.objectContaining({ title: 'Sort Downloads', total: 3 }));
  expect(fs.existsSync(path.join(root, 'inv-a.pdf'))).toBe(true);
  expect(notes.at(-1)).toEqual(['t1', 'A plan to move 3 files is waiting in the Organize preview. Nothing moves until you apply it.']);

  await expect(call('organize:apply')).resolves.toEqual({ ok: true });
  expect(fs.existsSync(path.join(root, 'Invoices', 'inv-a.pdf'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'inv-a.pdf'))).toBe(false);
  expect(notes.at(-1)![1]).toMatch(/^Applied “Sort Downloads”: moved 3 files/);
  expect(call('organize:current')).toBeNull();
});

test('a plan that would move something the folder\'s rules protect is refused, and nothing moves', async () => {
  protectedPaths = [path.join(root, 'IMG_1.jpg')];
  propose();
  await expect(call('organize:apply')).resolves.toEqual({ ok: false, error: 'IMG_1.jpg is protected by this folder\'s rules.' });
  expect(fs.existsSync(path.join(root, 'inv-a.pdf'))).toBe(true);
});

test('keeping every file dismisses the plan; cancel says nothing moved', () => {
  propose();
  for (const f of ['inv-a.pdf', 'inv-b.pdf', 'IMG_1.jpg']) call('organize:keep', f);
  expect(notes.at(-1)).toEqual(['t1', 'Every file was left where it is; nothing moved.']);
  expect(call('organize:current')).toBeNull();
  propose();
  expect(call('organize:cancel')).toBe(true);
  expect(notes.at(-1)).toEqual(['t1', 'The organize plan was dismissed; nothing moved.']);
});
