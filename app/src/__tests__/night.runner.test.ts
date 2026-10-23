import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Night shift's runner (FL5), moved out of main/index.ts into night.runner.ts (flaw list C13). Until the move it could
 * only run inside the app; here it runs against a real git repository with a stand-in for the Bimax Threads.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-night-runner-')));
const awake = { started: 0, stopped: 0 };
jest.mock('electron', () => ({
  app: { getPath: () => require('path').join(tmp, 'userData') },
  Notification: { isSupported: () => false },
  powerSaveBlocker: { start: () => { awake.started++; return 7; }, stop: () => { awake.stopped++; } },
}));

import { afterNightTurn, isNightShift, nightShiftBudget, setNightRunnerHost, startNightShift } from '../main/night.runner';

const repo = path.join(tmp, 'repo');
const created: string[] = [];
const notes: Array<[string, string]> = [];
const submitted: Array<[string, string]> = [];
let answer = '';

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'userData', 'night'), { recursive: true });
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '.'); git('commit', '-qm', 'first');
  setNightRunnerHost({
    threads: () => ({
      create: (root: string) => { created.push(root); return `night-${created.length}`; },
      rename: () => undefined,
      get: () => ({ summary: { status: 'idle' }, state: { items: [{ kind: 'msg', msg: { role: 'assistant', content: answer } }] } }),
      send: () => undefined,
      submit: (id: string, words: string) => { submitted.push([id, words]); },
      addNote: (id: string, text: string) => { notes.push([id, text]); },
    }) as never,
    quickModel: () => undefined,
    showQuickThread: () => undefined,
    openThread: () => undefined,
  });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const inTwoHours = (): string => {
  const when = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
};

test('bad input is refused before anything is made', async () => {
  await expect(startNightShift(repo, 'tidy', 0, inTwoHours())).resolves.toEqual({ ok: false, error: 'Give a budget between $1 and $100.' });
  await expect(startNightShift(repo, 'tidy', 3, 'soon')).resolves.toEqual({ ok: false, error: 'Give the morning time as HH:MM, within 16 hours.' });
  await expect(startNightShift(repo, '  ', 3, inTwoHours())).resolves.toEqual({ ok: false, error: 'Say what the shift should work on.' });
  const plain = path.join(tmp, 'not-a-repo');
  fs.mkdirSync(plain);
  await expect(startNightShift(plain, 'tidy', 3, inTwoHours())).resolves.toEqual(expect.objectContaining({ ok: false }));
  expect(created).toEqual([]);
});

test('a shift works in its own checkout on its own branch, keeps the Mac awake, and writes a briefing when done', async () => {
  const result = await startNightShift(repo, 'Tidy the README', 3, inTwoHours());
  expect(result.ok).toBe(true);
  const id = `night-${created.length}`;
  const worktree = created.at(-1)!;
  expect(path.dirname(worktree)).toBe(path.join(tmp, 'userData', 'night'));
  expect(execFileSync('git', ['-C', worktree, 'branch', '--show-current']).toString().trim()).toMatch(/^bimax\/night-/);
  expect(isNightShift(id)).toBe(true);
  expect(nightShiftBudget(id)).toBe(3);
  expect(awake.started).toBe(1);
  expect(submitted.at(-1)![0]).toBe(id);

  answer = 'Tidied it.\nNIGHT SHIFT DONE';
  afterNightTurn(id);
  await new Promise((resolve) => setTimeout(resolve, 300)); // the briefing reads git and writes a file
  expect(isNightShift(id)).toBe(false);
  expect(awake.stopped).toBe(1);
  const briefings = fs.readdirSync(path.join(tmp, 'userData', 'night')).filter((f) => f.endsWith('-briefing.md'));
  expect(briefings).toHaveLength(1);
  expect(notes.at(-1)![0]).toBe(id);
  expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n'); // the working copy was never touched
});
