import { GenerationFence, SingleFlightRefresh, ProjectStamp } from '../renderer/src/refresh.controller';

type Reply = { branch: string } & Partial<ProjectStamp>;

/** A fetch you can hold open, so "while a read is in flight" is exact instead of timing-dependent. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let every already-resolved microtask settle. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const stampOf = (value: Reply): ProjectStamp | null =>
  typeof value.project === 'string' && typeof value.generation === 'number'
    ? { project: value.project, generation: value.generation }
    : null;

describe('GenerationFence', () => {
  it('only ever raises its floor', () => {
    const fence = new GenerationFence();
    expect(fence.generation).toBe(-1);
    expect(fence.raiseTo(3)).toBe(true);
    expect(fence.raiseTo(2)).toBe(false); // a late, lower generation cannot rewind the fence
    expect(fence.raiseTo(3)).toBe(false);
    expect(fence.generation).toBe(3);
  });

  it('ignores a generation that is not a finite number', () => {
    const fence = new GenerationFence();
    for (const bad of [undefined, null, 'seven', NaN, Infinity]) expect(fence.raiseTo(bad)).toBe(false);
    expect(fence.generation).toBe(-1);
  });

  it('drops a reply that names another project', () => {
    const fence = new GenerationFence();
    fence.raiseTo(2);
    expect(fence.deliverable({ project: '/b', generation: 2 }, '/a', 2))
      .toEqual({ ok: false, reason: 'different-project' });
  });

  it('drops a reply from a retired generation and keeps the current one', () => {
    const fence = new GenerationFence();
    fence.raiseTo(5);
    expect(fence.deliverable({ project: '/a', generation: 4 }, '/a', 4))
      .toEqual({ ok: false, reason: 'retired-generation' });
    expect(fence.deliverable({ project: '/a', generation: 5 }, '/a', 5)).toEqual({ ok: true });
  });

  it('adopts a generation newer than it knew about', () => {
    const fence = new GenerationFence();
    expect(fence.deliverable({ project: '/a', generation: 9 }, '/a', -1)).toEqual({ ok: true });
    expect(fence.generation).toBe(9);
  });

  it('falls back to the issue-time generation when a reply carries no stamp', () => {
    const fence = new GenerationFence();
    fence.raiseTo(4);
    expect(fence.deliverable(null, '/a', 4)).toEqual({ ok: true });
    // The same unstamped reply, issued before the switch, is not deliverable after it.
    expect(fence.deliverable(null, '/a', 3))
      .toEqual({ ok: false, reason: 'issued-before-current-generation' });
  });
});

describe('SingleFlightRefresh — bursts coalesce', () => {
  it('runs one fetch at a time and exactly one follow-up however large the burst', async () => {
    const gate = deferred<Reply | null>();
    let calls = 0;
    const results: (Reply | null)[] = [];
    const refresher = new SingleFlightRefresh<Reply>({
      expectedProject: '/a',
      fetch: () => { calls++; return calls === 1 ? gate.promise : Promise.resolve({ branch: 'main', project: '/a', generation: 1 }); },
      stampOf,
      onResult: v => results.push(v),
    });
    refresher.setGeneration(1);

    expect(refresher.request()).toBe(true); // this one issues
    for (let i = 0; i < 100; i++) expect(refresher.request()).toBe(false); // these fold into it
    expect(calls).toBe(1);
    expect(refresher.snapshot()).toMatchObject({ requested: 101, issued: 1, coalesced: 100, inFlight: true, dirty: true });

    gate.resolve({ branch: 'main', project: '/a', generation: 1 });
    await settle();

    // A hundred events during one slow read produce ONE more read, not a hundred.
    expect(calls).toBe(2);
    expect(refresher.snapshot()).toMatchObject({ requested: 101, issued: 2, coalesced: 100, inFlight: false, dirty: false });
    expect(results.length).toBe(2);
  });

  it('does not schedule a follow-up when nothing arrived during the fetch', async () => {
    let calls = 0;
    const refresher = new SingleFlightRefresh<Reply>({
      expectedProject: '/a',
      fetch: () => { calls++; return Promise.resolve({ branch: 'main', project: '/a', generation: 1 }); },
      stampOf,
      onResult: () => { /* ignored */ },
    });
    refresher.request();
    await settle();
    expect(calls).toBe(1);
    expect(refresher.snapshot()).toMatchObject({ issued: 1, coalesced: 0, dirty: false });
  });
});

describe('SingleFlightRefresh — a slow old-project reply cannot overwrite new state', () => {
  it('drops a reply stamped with the project the user has left', async () => {
    const slow = deferred<Reply | null>();
    const delivered: (Reply | null)[] = [];
    // This controller belongs to project /b; the in-flight read was started for /a.
    const refresher = new SingleFlightRefresh<Reply>({
      expectedProject: '/b',
      fetch: () => slow.promise,
      stampOf,
      onResult: v => delivered.push(v),
    });
    refresher.setGeneration(2);
    refresher.request();

    slow.resolve({ branch: 'old-branch', project: '/a', generation: 1 });
    await settle();

    expect(delivered).toEqual([]);
    expect(refresher.snapshot()).toMatchObject({ droppedStale: 1, drops: ['different-project'] });
  });

  it('drops a reply for the same project from a retired generation', async () => {
    const slow = deferred<Reply | null>();
    const delivered: (Reply | null)[] = [];
    const refresher = new SingleFlightRefresh<Reply>({
      expectedProject: '/a',
      fetch: () => slow.promise,
      stampOf,
      onResult: v => delivered.push(v),
    });
    refresher.setGeneration(1);
    refresher.request();
    // The project is closed and reopened while the read is in flight.
    refresher.setGeneration(2);
    slow.resolve({ branch: 'stale', project: '/a', generation: 1 });
    await settle();

    expect(delivered).toEqual([]);
    expect(refresher.snapshot()).toMatchObject({ droppedStale: 1, drops: ['retired-generation'] });
  });

  it('delivers a reply from the current generation', async () => {
    const delivered: (Reply | null)[] = [];
    const refresher = new SingleFlightRefresh<Reply>({
      expectedProject: '/a',
      fetch: () => Promise.resolve({ branch: 'main', project: '/a', generation: 7 }),
      stampOf,
      onResult: v => delivered.push(v),
    });
    refresher.setGeneration(7);
    refresher.request();
    await settle();
    expect(delivered).toEqual([{ branch: 'main', project: '/a', generation: 7 }]);
    expect(refresher.snapshot().droppedStale).toBe(0);
  });

  it('drops an unstamped null that was issued before the project changed', async () => {
    const slow = deferred<Reply | null>();
    const delivered: (Reply | null)[] = [];
    const refresher = new SingleFlightRefresh<Reply>({
      expectedProject: '/a',
      fetch: () => slow.promise,
      stampOf,
      onResult: v => delivered.push(v),
    });
    refresher.setGeneration(1);
    refresher.request();
    refresher.setGeneration(2); // project switched mid-read
    slow.resolve(null);         // "not a git repository" — carries no stamp to check
    await settle();

    // Without this fence, a null from the OLD project blanks the NEW project's status pill.
    expect(delivered).toEqual([]);
    expect(refresher.snapshot()).toMatchObject({ drops: ['issued-before-current-generation'] });
  });

  it('delivers an unstamped null when nothing changed', async () => {
    const delivered: (Reply | null)[] = [];
    const refresher = new SingleFlightRefresh<Reply>({
      expectedProject: '/a',
      fetch: () => Promise.resolve(null),
      stampOf,
      onResult: v => delivered.push(v),
    });
    refresher.setGeneration(3);
    refresher.request();
    await settle();
    expect(delivered).toEqual([null]);
  });
});

describe('SingleFlightRefresh — failures and disposal', () => {
  it('counts a failed fetch, reports null, and keeps accepting requests', async () => {
    let calls = 0;
    const delivered: (Reply | null)[] = [];
    const errors: unknown[] = [];
    const refresher = new SingleFlightRefresh<Reply>({
      expectedProject: '/a',
      fetch: () => { calls++; return calls === 1 ? Promise.reject(new Error('git missing')) : Promise.resolve({ branch: 'main', project: '/a', generation: 1 }); },
      stampOf,
      onResult: v => delivered.push(v),
      onError: e => errors.push(e),
    });
    refresher.setGeneration(1);
    refresher.request();
    await settle();
    expect(delivered).toEqual([null]);
    expect(errors.length).toBe(1);
    expect(refresher.snapshot().failed).toBe(1);

    refresher.request();
    await settle();
    expect(delivered[1]).toMatchObject({ branch: 'main' });
  });

  it('does not blank the new project when a read of the old one fails', async () => {
    const slow = deferred<Reply | null>();
    const delivered: (Reply | null)[] = [];
    const refresher = new SingleFlightRefresh<Reply>({
      expectedProject: '/a',
      fetch: () => slow.promise,
      stampOf,
      onResult: v => delivered.push(v),
    });
    refresher.setGeneration(1);
    refresher.request();
    refresher.setGeneration(2);
    slow.reject(new Error('project deleted'));
    await settle();
    expect(delivered).toEqual([]);
    expect(refresher.snapshot().failed).toBe(1);
  });

  it('stops delivering and stops following up once disposed', async () => {
    const gate = deferred<Reply | null>();
    let calls = 0;
    const delivered: (Reply | null)[] = [];
    const refresher = new SingleFlightRefresh<Reply>({
      expectedProject: '/a',
      fetch: () => { calls++; return calls === 1 ? gate.promise : Promise.resolve({ branch: 'x', project: '/a', generation: 1 }); },
      stampOf,
      onResult: v => delivered.push(v),
    });
    refresher.setGeneration(1);
    refresher.request();
    refresher.request();               // dirty, so a follow-up would normally run
    refresher.dispose();
    gate.resolve({ branch: 'main', project: '/a', generation: 1 });
    await settle();

    expect(delivered).toEqual([]);     // the in-flight reply is dropped
    expect(calls).toBe(1);             // and the follow-up never runs
    expect(refresher.request()).toBe(false);
    expect(refresher.snapshot().drops).toEqual(['disposed']);
  });
});

// --- main-side halves of the same fence -----------------------------------------------------------

import * as os from 'os';
import * as pathMod from 'path';
import { promises as fsp } from 'fs';
import { stampedGitStatus, GitStatusResult } from '../main/git';
import { watchProject } from '../main/files';

describe('stampedGitStatus — the stamp describes what was read, not what is open now', () => {
  const status = (branch: string): GitStatusResult => ({ branch, ahead: 0, behind: 0, files: [] });

  it('stamps the project and generation captured before the read began', async () => {
    const reply = await stampedGitStatus('/a', 3, async () => status('main'));
    expect(reply).toEqual({ branch: 'main', ahead: 0, behind: 0, files: [], project: '/a', generation: 3 });
  });

  it('keeps the pre-read stamp even when the project changes mid-read', async () => {
    let liveProject = '/a';
    let liveGeneration = 4;
    const reply = await stampedGitStatus(liveProject, liveGeneration, async (cwd) => {
      // The user switches projects while git is still running.
      liveProject = '/b';
      liveGeneration = 5;
      expect(cwd).toBe('/a'); // the read itself must run against the captured project
      return status('old-branch');
    });
    // The reply is honest about which session it describes, so the renderer can drop it.
    expect(reply).toMatchObject({ project: '/a', generation: 4 });
    expect(reply).not.toMatchObject({ project: liveProject, generation: liveGeneration });
  });

  it('returns null without a stamp when no project is open, and never reads', async () => {
    let read = 0;
    expect(await stampedGitStatus('', 2, async () => { read++; return status('main'); })).toBeNull();
    expect(read).toBe(0);
  });

  it('returns null when the directory is not a repository', async () => {
    expect(await stampedGitStatus('/a', 1, async () => null)).toBeNull();
  });
});

describe('watchProject — a closed watcher is silent', () => {
  let dir: string;
  beforeEach(async () => { dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'bimax-watch-')); });
  afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); });

  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  it('fires for a project change while open', async () => {
    let fired = 0;
    const watch = watchProject(dir, () => { fired++; });
    if (!watch) return; // recursive watch unavailable on this platform
    await fsp.writeFile(pathMod.join(dir, 'a.txt'), 'x');
    await wait(700);
    expect(fired).toBeGreaterThan(0);
    watch.close();
  });

  it('does not fire after close, even for a change already inside the debounce window', async () => {
    let fired = 0;
    const watch = watchProject(dir, () => { fired++; });
    if (!watch) return;
    await fsp.writeFile(pathMod.join(dir, 'b.txt'), 'x');
    await wait(50);          // inside the 400 ms debounce: the timer is scheduled but has not run
    watch.close();           // switching project here used to leave that timer armed
    await wait(700);
    expect(fired).toBe(0);
    expect(watch.closed).toBe(true);
  });

  it('cancels a pending debounce timer on close, rather than only silencing it', async () => {
    const watch = watchProject(dir, () => { /* ignored */ });
    if (!watch) return;
    await fsp.writeFile(pathMod.join(dir, 'c.txt'), 'x');
    await wait(50);
    if (!watch.pendingChange) { watch.close(); return; } // no event on this platform; nothing to assert
    // A silenced-but-armed timer still holds the event loop open for its whole window after the
    // project is gone. Closing must actually clear it.
    watch.close();
    expect(watch.pendingChange).toBe(false);
  });

  it('close() is idempotent', () => {
    const watch = watchProject(dir, () => { /* ignored */ });
    if (!watch) return;
    watch.close();
    expect(() => watch.close()).not.toThrow();
    expect(watch.closed).toBe(true);
  });
});
