import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { DROPLET_TIMEOUT_MS, justFinished, mayRestart, NotchDeck, notchContent, notchSays, notchTask, recallView, VERDICT_EVERY } from '../main/notch';
import type { Activity } from '../main/recall';
import type { ThreadSummary } from '../shared/threads';

/**
 * God's Land stage 1 (docs/product-reset/gods-land/03_PLAN.md): what the notch shows, when it speaks up by itself,
 * and the helper's lifecycle. The native side has its own --selftest and a click-through check run on a real screen.
 */

let clock = 1_000;
const task = (id: string, patch: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id, title: `Task ${id}`, root: '/tmp', updatedAt: clock++, status: 'idle', peers: [], origin: 'quick', ...patch,
});
const byId = (list: ThreadSummary[]) => new Map(list.map((t) => [t.id, t]));

describe('what the notch shows', () => {
  test('only ⌘2 tasks, the ones needing you first, then running, then the most recent', () => {
    const list = [
      task('old-done', { outcome: 'completed', check: 'passed' }),
      task('project', { origin: 'project', status: 'working' }),
      task('running', { status: 'working' }),
      task('asks', { status: 'needs-you' }),
      task('newest-idle'),
    ];
    const content = notchContent(list);
    expect(content.tasks.map((t) => t.id)).toEqual(['asks', 'running', 'newest-idle', 'old-done']);
    expect(content).toMatchObject({ t: 'content', active: 2, waiting: 1 });
    expect(notchContent(list, 2).tasks).toHaveLength(2);
  });

  test('each state gets its dot and the menu bar\'s own words', () => {
    expect(notchTask(task('a', { status: 'working' }))).toMatchObject({ state: 'working', detail: 'Working' });
    expect(notchTask(task('b', { status: 'needs-you' }))).toMatchObject({ state: 'waiting', detail: 'Needs your decision' });
    expect(notchTask(task('c', { outcome: 'completed', check: 'passed' }))).toMatchObject({ state: 'done', detail: 'Done · check passed' });
    // A finished task whose check failed is not "done" (F3).
    expect(notchTask(task('d', { outcome: 'completed', check: 'failed' }))).toMatchObject({ state: 'failed', detail: 'Check failed' });
    expect(notchTask(task('e', { outcome: 'failed' }))).toMatchObject({ state: 'failed' });
    expect(notchTask(task('f'))).toMatchObject({ state: 'idle', detail: '' });
    expect(notchTask(task('g', { title: 'x'.repeat(80) })).title).toHaveLength(48);
  });
});

describe('when the notch speaks up', () => {
  test('a task that starts needing you, finishes, fails, or fails its check — each once, at the moment it happens', () => {
    const before = [task('ask', { status: 'working' }), task('ok', { status: 'working' }), task('bad', { status: 'working' }), task('check', { status: 'working' })];
    const after = [
      { ...before[0], status: 'needs-you' as const },
      { ...before[1], status: 'idle' as const, outcome: 'completed' as const, check: 'passed' as const },
      { ...before[2], status: 'idle' as const, outcome: 'failed' as const },
      { ...before[3], status: 'idle' as const, outcome: 'completed' as const, check: 'failed' as const },
    ];
    expect(notchSays(byId(before), after)).toEqual([
      { t: 'say', text: 'Task ask needs you', tone: 'waiting', seconds: 6 },
      { t: 'say', text: 'Task ok is done · check passed', tone: 'done', seconds: 4 },
      { t: 'say', text: 'Task bad failed', tone: 'failed', seconds: 6 },
      { t: 'say', text: 'Task check finished, but its check failed', tone: 'failed', seconds: 6 },
    ]);
    // The same states seen again say nothing: only transitions speak.
    expect(notchSays(byId(after), after)).toEqual([]);
  });

  test('nothing for tasks seen for the first time, for projects, or for a stop that did not finish', () => {
    const fresh = [task('new', { status: 'idle', outcome: 'completed' })];
    expect(notchSays(new Map(), fresh)).toEqual([]);
    const project = task('p', { origin: 'project', status: 'working' });
    expect(notchSays(byId([project]), [{ ...project, status: 'needs-you' }])).toEqual([]);
    const stopped = task('s', { status: 'working' });
    expect(notchSays(byId([stopped]), [{ ...stopped, status: 'stopped', outcome: 'interrupted' }])).toEqual([]);
  });
});

test('a helper that keeps exiting is restarted three times in five minutes, then left off', () => {
  expect(mayRestart([], 0)).toBe(true);
  expect(mayRestart([1, 2], 10)).toBe(true);
  expect(mayRestart([1, 2, 3], 10)).toBe(false);
  expect(mayRestart([1, 2, 3], 5 * 60_000 + 10)).toBe(true);
});

class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  written: string[] = [];
  constructor() {
    super();
    this.stdin.on('data', (chunk) => this.written.push(...String(chunk).split('\n').filter(Boolean)));
  }
  kill() { this.exitCode = 0; return true; }
}

describe('the helper process', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  test('gets the content once per change, the says on transitions, and opens the task it names', async () => {
    const helpers: FakeHelper[] = [];
    const opened: string[] = [];
    const deck = new NotchDeck({ helper: '/x', onOpenTask: (id) => opened.push(id), spawnHelper: () => { const h = new FakeHelper(); helpers.push(h); return h as never; } });
    deck.start();
    const working = task('t', { status: 'working' });
    deck.update([working]);
    deck.update([working]); // unchanged: not sent again
    deck.update([{ ...working, status: 'needs-you' }]);
    await flush();
    const messages = helpers[0].written.map((line) => JSON.parse(line));
    expect(messages.map((m) => m.t)).toEqual(['content', 'content', 'say']);
    expect(messages[2]).toMatchObject({ text: 'Task t needs you', tone: 'waiting' });

    helpers[0].stdout.write('{"t":"ready","hasNotch":true}\n{"t":"open-task","id":"t"}\n{"t":"open-task"}\nnot json\n');
    await flush();
    expect(opened).toEqual(['t']);

    deck.stop();
    await flush();
    expect(helpers[0].written.map((line) => JSON.parse(line).t).pop()).toBe('quit');
    expect(deck.running()).toBe(false);
  });

  test('an exit restarts it after a second, but a stop never does', () => {
    jest.useFakeTimers();
    try {
      const helpers: FakeHelper[] = [];
      const deck = new NotchDeck({ helper: '/x', onOpenTask: () => undefined, spawnHelper: () => { const h = new FakeHelper(); helpers.push(h); return h as never; } });
      deck.start();
      helpers[0].emit('exit', 1, null);
      expect(deck.running()).toBe(false);
      jest.advanceTimersByTime(1_000);
      expect(helpers).toHaveLength(2);
      deck.stop();
      helpers[1].emit('exit', 0, null);
      jest.advanceTimersByTime(5_000);
      expect(helpers).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the shelf through the helper (stage 2)', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function setup() {
    const calls: string[] = [];
    let items: Array<{ id: string; title: string }> = [];
    const shelf = {
      add: (inputs: readonly { kind: string; path?: string; url?: string; text?: string }[]) => {
        calls.push(`add ${JSON.stringify(inputs)}`);
        items = [...inputs.map((input, i) => ({ id: `n${items.length + i}`, title: input.path ?? input.url ?? input.text ?? '' })), ...items];
        return items.map((i) => i.id);
      },
      touch: (id: string) => { calls.push(`touch ${id}`); return true; },
      archive: (target: { ids?: readonly string[]; amber?: boolean }) => { calls.push(`archive ${JSON.stringify(target)}`); return 1; },
      restore: (id: string) => { calls.push(`restore ${id}`); return id === 'known'; },
      view: () => ({ t: 'shelf' as const, items: items.map((i) => ({ ...i, kind: 'file' as const, missing: false, amber: false })), archived: [] }),
    };
    const helpers: FakeHelper[] = [];
    const deck = new NotchDeck({ helper: '/x', onOpenTask: () => undefined, shelf, spawnHelper: () => { const h = new FakeHelper(); helpers.push(h); return h as never; } });
    deck.start();
    const say = async (line: string) => { helpers[0].stdout.write(`${line}\n`); await flush(); };
    const sent = () => helpers[0].written.map((l) => JSON.parse(l)).filter((m) => m.t === 'shelf');
    return { calls, say, sent };
  }

  test('ready sends the shelf; a drop is kept and the new shelf sent back; an unchanged shelf is not resent', async () => {
    const { calls, say, sent } = setup();
    await say('{"t":"ready","hasNotch":true}');
    expect(sent()).toHaveLength(1);
    await say('{"t":"shelf-add","items":[{"kind":"file","path":"/Users/me/a.pdf","extra":1},{"kind":"evil","path":"/x"},{"kind":"url","url":"https://bimax.app"},null,7]}');
    expect(calls).toEqual(['add [{"kind":"file","path":"/Users/me/a.pdf"},{"kind":"url","url":"https://bimax.app"}]']);
    expect(sent()).toHaveLength(2);
    expect(sent()[1].items.map((i: { title: string }) => i.title)).toEqual(['/Users/me/a.pdf', 'https://bimax.app']);
    await say('{"t":"hover","open":true}');
    expect(sent()).toHaveLength(2);
  });

  test('touch, archive (by id or all amber) and restore reach the store; malformed ones do not', async () => {
    const { calls, say } = setup();
    await say('{"t":"shelf-touch","id":"a"}');
    await say('{"t":"shelf-touch","id":5}');
    await say('{"t":"shelf-archive","ids":["a",3,"b"]}');
    await say('{"t":"shelf-archive","amber":true}');
    await say('{"t":"shelf-restore","id":"known"}');
    await say('{"t":"shelf-restore"}');
    expect(calls).toEqual(['touch a', 'archive {"ids":["a","b"],"amber":false}', 'archive {"amber":true}', 'restore known']);
  });
});

describe('stage 3: edit, the Droplet and the Hatchback', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  test('a task that just finished is reported once — completed, failed or out of time; not a stop, not a question', () => {
    const busy = ['done', 'fail', 'limit', 'stop', 'ask'].map((id) => task(id, { status: 'working' }));
    const after = [
      { ...busy[0], status: 'idle' as const, outcome: 'completed' as const, check: 'failed' as const },
      { ...busy[1], status: 'idle' as const, outcome: 'failed' as const },
      { ...busy[2], status: 'idle' as const, outcome: 'time-limit' as const },
      { ...busy[3], status: 'stopped' as const, outcome: 'interrupted' as const },
      { ...busy[4], status: 'needs-you' as const },
    ];
    expect(justFinished(byId(busy), after).map((t) => t.id)).toEqual(['done', 'fail', 'limit']);
    expect(justFinished(byId(after), after)).toEqual([]);
  });

  test('edit hands only files to the app; the Droplet resolves when it lands, or times out so the bar still opens', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const helpers: FakeHelper[] = [];
      const edits: string[][] = [];
      const deck = new NotchDeck({ helper: '/x', onOpenTask: () => undefined, onEdit: (p) => edits.push(p), spawnHelper: () => { const h = new FakeHelper(); helpers.push(h); return h as never; } });
      expect(await deck.playDroplet({ x: 0, y: 0, width: 1, height: 1 })).toBe('no-helper');
      deck.start();
      helpers[0].stdout.write('{"t":"edit","items":[{"kind":"file","path":"/Users/me/a.md"},{"kind":"url","url":"https://x.y"},{"kind":"file","path":"relative"}]}\n{"t":"edit","items":[{"kind":"text","text":"hi"}]}\n');
      await flush();
      expect(edits).toEqual([['/Users/me/a.md']]);

      const landed = deck.playDroplet({ x: 395, y: 229, width: 680, height: 64 }, '/Users/me/a.md');
      await flush();
      expect(JSON.parse(helpers[0].written.at(-1)!)).toEqual({ t: 'droplet', to: { x: 395, y: 229, width: 680, height: 64 }, icon: '/Users/me/a.md' });
      helpers[0].stdout.write('{"t":"droplet-landed"}\n');
      await flush();
      expect(await landed).toBe('landed');

      const late = deck.playDroplet({ x: 0, y: 0, width: 1, height: 1 });
      jest.advanceTimersByTime(DROPLET_TIMEOUT_MS);
      expect(await late).toBe('timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  test('the Hatchback docks a task\'s files with the task and its check', () => {
    const added: unknown[] = [];
    const shelf = { add: (i: readonly unknown[]) => { added.push(...i); return []; }, touch: () => true, archive: () => 0, restore: () => true, view: () => ({ t: 'shelf' as const, items: [], archived: [] }) };
    const deck = new NotchDeck({ helper: '/x', onOpenTask: () => undefined, shelf, spawnHelper: () => new FakeHelper() as never });
    deck.dock(['/w/contract.md'], { task: 'Make it formal', check: 'passed' });
    deck.dock([], { task: 'nothing' });
    expect(added).toEqual([{ kind: 'file', path: '/w/contract.md', from: { task: 'Make it formal', check: 'passed' } }]);
  });
});

describe('stage 4: the glass through the deck', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  test('a finished task stays unseen — prism or fissure — until the notch is opened', async () => {
    const helpers: FakeHelper[] = [];
    const deck = new NotchDeck({ helper: '/x', onOpenTask: () => undefined, now: () => 5_000_000, spawnHelper: () => { const h = new FakeHelper(); helpers.push(h); return h as never; } });
    deck.start();
    const working = task('t', { status: 'working', title: 'Tidy', updatedAt: 5_000_000 });
    deck.update([working]);
    deck.update([{ ...working, status: 'idle', outcome: 'completed', check: 'failed' }]);
    await flush();
    const glasses = () => helpers[0].written.map((l) => JSON.parse(l)).filter((m) => m.t === 'content').map((m) => m.glass.state);
    expect(glasses()).toEqual(['molten', 'fissure']);
    helpers[0].stdout.write('{"t":"hover","open":true}\n');
    await flush();
    expect(glasses()).toEqual(['molten', 'fissure', 'water']);
    deck.stop();
  });

  test('a working task frosts on time, without anything else happening', () => {
    jest.useFakeTimers();
    try {
      let now = 1_000_000;
      const helpers: FakeHelper[] = [];
      const deck = new NotchDeck({ helper: '/x', onOpenTask: () => undefined, now: () => now, spawnHelper: () => { const h = new FakeHelper(); helpers.push(h); return h as never; } });
      deck.start();
      deck.update([task('t', { status: 'working', title: 'Build', updatedAt: now })]);
      const states: string[] = [];
      helpers[0].stdin.on('data', (chunk) => { for (const line of String(chunk).split('\n').filter(Boolean)) { const m = JSON.parse(line); if (m.t === 'content') states.push(m.glass.state); } });
      now += 30_100;
      jest.advanceTimersByTime(30_100);
      expect(states).toContain('frost');
      deck.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('night comes from the app\'s Night Shift list', async () => {
    const helpers: FakeHelper[] = [];
    const deck = new NotchDeck({ helper: '/x', onOpenTask: () => undefined, nightIds: () => new Set(['n']), spawnHelper: () => { const h = new FakeHelper(); helpers.push(h); return h as never; } });
    deck.start();
    deck.update([task('n', { status: 'working', updatedAt: Date.now() })]);
    await flush();
    expect(JSON.parse(helpers[0].written[0]!).glass).toEqual({ state: 'night', label: 'Night Shift is working' });
    deck.stop();
  });
});

describe('stage 5: the clipboard through the deck', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function setup(startEnabled: boolean) {
    let enabled = startEnabled;
    const kept: string[] = [];
    const calls: string[] = [];
    const clipboard = {
      enabled: () => enabled,
      setEnabled: (on: boolean) => { enabled = on; calls.push(`enabled ${on}`); },
      add: (text: string, source?: string) => { kept.push(`${text}${source ? ` @${source}` : ''}`); return true; },
      pin: (id: string, pinned: boolean) => { calls.push(`pin ${id} ${pinned}`); return true; },
      remove: (id: string) => { calls.push(`remove ${id}`); return true; },
      view: (on: boolean) => ({ t: 'clips' as const, enabled: on, items: kept.map((text, i) => ({ id: `c${i}`, kind: 'text' as const, preview: text, text, actions: [], pinned: false })) }),
    };
    const helpers: FakeHelper[] = [];
    const deck = new NotchDeck({ helper: '/x', onOpenTask: () => undefined, clipboard, spawnHelper: () => { const h = new FakeHelper(); helpers.push(h); return h as never; } });
    deck.start();
    const say = async (line: string) => { helpers[0].stdout.write(`${line}\n`); await flush(); };
    const sent = () => helpers[0].written.map((l) => JSON.parse(l));
    return { kept, calls, say, sent };
  }

  test('with history off a copy is NOT kept, whatever the helper sends; turning it on tells the helper to watch', async () => {
    const { kept, calls, say, sent } = setup(false);
    await say('{"t":"ready"}');
    expect(sent().find((m) => m.t === 'clip-config')).toEqual({ t: 'clip-config', enabled: false });
    await say('{"t":"clip","text":"private note"}');
    expect(kept).toEqual([]);
    await say('{"t":"clip-enable"}');
    expect(calls).toEqual(['enabled true']);
    expect(sent().filter((m) => m.t === 'clip-config').pop()).toEqual({ t: 'clip-config', enabled: true });
    await say('{"t":"clip","text":"#3b82f6","source":"Figma"}');
    expect(kept).toEqual(['#3b82f6 @Figma']);
    expect(sent().filter((m) => m.t === 'clips').pop().items.map((i: { text: string }) => i.text)).toEqual(['#3b82f6 @Figma']);
  });

  test('pin, remove and turning it off reach the store; malformed ones do not', async () => {
    const { calls, say } = setup(true);
    await say('{"t":"clip-pin","id":"c0","pinned":true}');
    await say('{"t":"clip-pin","id":3}');
    await say('{"t":"clip-remove","id":"c0"}');
    await say('{"t":"clip","text":42}');
    await say('{"t":"clip-disable"}');
    expect(calls).toEqual(['pin c0 true', 'remove c0', 'enabled false']);
  });
});

describe('stage 6: secrets through the deck', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const VALUE = 'sk_live_51H8xQ2rTvKp9WmZa3BnYc7D';

  test('the helper gets the list masked; a value only when it asks for that one; unknown ids are missing', async () => {
    let scans = 0;
    let now = 1_000_000;
    const helpers: FakeHelper[] = [];
    const deck = new NotchDeck({
      helper: '/x', onOpenTask: () => undefined, now: () => now,
      secrets: { scan: () => { scans++; return [{ id: 's1', label: 'Stripe key', key: 'STRIPE_KEY', masked: 'sk_live_••••Yc7D', where: 'shop/.env.local', value: VALUE }]; } },
      clipboard: { enabled: () => true, setEnabled: () => undefined, add: () => true, pin: () => true, remove: () => true, view: (on: boolean) => ({ t: 'clips' as const, enabled: on, items: [] }), reveal: (id: string) => (id === 'clip-secret' ? 'ghp_sealed' : null) },
      spawnHelper: () => { const h = new FakeHelper(); helpers.push(h); return h as never; },
    });
    deck.start();
    const say = async (line: string) => { helpers[0].stdout.write(`${line}\n`); await flush(); };
    const sent = () => helpers[0].written.map((l) => JSON.parse(l));

    await say('{"t":"ready"}');
    expect(sent().find((m) => m.t === 'secrets')).toEqual({ t: 'secrets', items: [{ id: 's1', label: 'Stripe key', key: 'STRIPE_KEY', masked: 'sk_live_••••Yc7D', where: 'shop/.env.local' }] });
    expect(helpers[0].written.join('\n')).not.toContain(VALUE);

    await say('{"t":"secret-value","id":"s1","purpose":"reveal"}');
    await say('{"t":"secret-value","id":"clip-secret","purpose":"copy"}');
    await say('{"t":"secret-value","id":"nope"}');
    expect(sent().filter((m) => m.t === 'secret')).toEqual([
      { t: 'secret', id: 's1', purpose: 'reveal', value: VALUE },
      { t: 'secret', id: 'clip-secret', purpose: 'copy', value: 'ghp_sealed' },
      { t: 'secret', id: 'nope', purpose: 'reveal', missing: true },
    ]);

    // Opening the notch rescans, but not more than once every 30 s.
    await say('{"t":"hover","open":true}');
    expect(scans).toBe(1);
    now += 30_001;
    await say('{"t":"hover","open":true}');
    expect(scans).toBe(2);
    deck.stop();
  });
});

describe('stage 7: one-tap conversions through the deck', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const cards = [
    { id: 'img', kind: 'file' as const, title: 'hero.png', path: '/Users/me/hero.png', missing: false, amber: false },
    { id: 'code', kind: 'file' as const, title: 'parser.ts', path: '/w/parser.ts', missing: false, amber: false },
    { id: 'env', kind: 'file' as const, title: '.env.local', path: '/w/.env.local', missing: false, amber: false },
    { id: 'gone', kind: 'file' as const, title: 'x.png', path: '/w/x.png', missing: true, amber: false },
  ];

  function setup() {
    const docked: unknown[] = [];
    const edits: Array<[string[], string | undefined]> = [];
    const uses: string[] = [];
    const shelf = { add: (i: readonly unknown[]) => { docked.push(...i); return []; }, touch: () => true, archive: () => 0, restore: () => true, view: () => ({ t: 'shelf' as const, items: cards, archived: [] }) };
    const transmute = {
      counts: () => ({ 'image:ocr': 3 }), record: (file: string, id: string) => uses.push(`${file}:${id}`), madeDir: '/made',
      envExample: (source: string, out: string) => `${out}`,
    };
    const helpers: FakeHelper[] = [];
    const deck = new NotchDeck({ helper: '/x', onOpenTask: () => undefined, shelf, transmute, onEdit: (p, prompt) => edits.push([p, prompt]), spawnHelper: () => { const h = new FakeHelper(); helpers.push(h); return h as never; } });
    deck.start();
    const say = async (line: string) => { helpers[0].stdout.write(`${line}\n`); await flush(); };
    const sent = () => helpers[0].written.map((l) => JSON.parse(l));
    return { docked, edits, uses, say, sent };
  }

  test('cards carry their actions, the learned one first; a missing file has none', async () => {
    const { say, sent } = setup();
    await say('{"t":"ready"}');
    const items = sent().find((m) => m.t === 'shelf').items;
    expect(items[0].actions[0].id).toBe('ocr');
    expect(items[1].actions[0].id).toBe('task:tests');
    expect(items[3].actions).toBeUndefined();
  });

  test('a local action goes to the helper with an output inside madeDir; a task opens ⌘2 with the request; bad ones do nothing', async () => {
    const { edits, uses, say, sent } = setup();
    await say('{"t":"transmute","id":"img","action":"compress"}');
    expect(sent().find((m) => m.t === 'transmute-run')).toEqual({ t: 'transmute-run', id: 'img', action: 'compress', source: '/Users/me/hero.png', out: '/made/hero.jpg', label: 'Compress' });
    await say('{"t":"transmute","id":"code","action":"task:tests"}');
    expect(edits).toEqual([[['/w/parser.ts'], expect.stringContaining('unit tests')]]);
    await say('{"t":"transmute","id":"img","action":"pdf-page1"}');
    await say('{"t":"transmute","id":"gone","action":"compress"}');
    await say('{"t":"transmute","id":"nope","action":"compress"}');
    expect(uses).toEqual(['/Users/me/hero.png:compress', '/w/parser.ts:task:tests']);
  });

  test('.env.example is made in the app, named visibly; a helper result is kept only inside madeDir', async () => {
    const { docked, say } = setup();
    await say('{"t":"transmute","id":"env","action":"env-example"}');
    expect(docked).toEqual([expect.objectContaining({ kind: 'file', path: '/made/env.local.example' })]);
    await say('{"t":"made","source":"/Users/me/hero.png","path":"/made/hero.jpg","note":"Compressed −68%"}');
    await say('{"t":"made","path":"/Users/me/Documents/evil.jpg","note":"x"}');
    await say('{"t":"made","path":"/made/../etc/x","note":"x"}');
    await say('{"t":"made","copied":true,"note":"Copied text"}');
    expect(docked).toEqual([
      expect.objectContaining({ path: '/made/env.local.example' }),
      { kind: 'file', path: '/made/hero.jpg', from: { task: 'Compressed −68%' } },
    ]);
  });
});

describe('stage 8: recall through the deck', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const shelfCards = [{ id: 'c1', kind: 'file' as const, title: 'on-shelf.png', path: '/w/on-shelf.png', missing: false, amber: false }];

  function setup(options: { enabled?: boolean; events?: Activity[] } = {}) {
    let enabled = options.enabled ?? true;
    const events: Activity[] = [...(options.events ?? [])];
    const verdicts: unknown[] = [];
    const added: unknown[] = [];
    const recall = {
      enabled: () => enabled,
      record: (input: { kind: Activity['kind']; path: string; app?: string; task?: string }) => { events.push({ at: 5_000, ...input }); return null; },
      all: () => events,
      onVerdict: (v: unknown) => verdicts.push(v),
    };
    const shelf = { add: (i: readonly unknown[]) => { added.push(...i); return []; }, touch: () => true, archive: () => 0, restore: () => true, view: () => ({ t: 'shelf' as const, items: shelfCards, archived: [] }) };
    const transmute = { counts: () => ({}), record: () => undefined, madeDir: '/made', envExample: () => null };
    const helpers: FakeHelper[] = [];
    const deck = new NotchDeck({
      helper: '/x', onOpenTask: () => undefined, shelf, transmute, recall, onEdit: () => undefined, now: () => 10_000,
      exists: (file) => !file.includes('gone'), spawnHelper: () => { const h = new FakeHelper(); helpers.push(h); return h as never; },
    });
    deck.start();
    const say = async (line: string) => { helpers[0].stdout.write(`${line}\n`); await flush(); };
    const views = () => helpers[0].written.map((l) => JSON.parse(l)).filter((m) => m.t === 'recall');
    return { deck, events, verdicts, added, say, views, setEnabled: (on: boolean) => { enabled = on; } };
  }

  test('what is done with files is recorded with the app in front — drops, uses, edits, task results — and a one-tap result carries no task name', async () => {
    const { deck, events, say } = setup();
    await say('{"t":"ready","app":"Finder"}');
    await say('{"t":"shelf-add","items":[{"kind":"file","path":"/w/a.pdf"},{"kind":"url","url":"https://bimax.app"}]}');
    await say('{"t":"front","app":"Figma"}');
    await say('{"t":"shelf-touch","id":"c1"}');
    await say('{"t":"edit","items":[{"kind":"file","path":"/w/b.ts"}]}');
    await say('{"t":"transmute","id":"c1","action":"compress"}');
    deck.dock(['/w/out.ts'], { task: 'Add tests', check: 'passed' });
    await say('{"t":"made","path":"/made/on-shelf.jpg","note":"Compressed −40%"}');
    expect(events.map((e) => [e.kind, e.path, e.app, e.task])).toEqual([
      ['drop', '/w/a.pdf', 'Finder', undefined],
      ['use', '/w/on-shelf.png', 'Figma', undefined],
      ['edit', '/w/b.ts', 'Figma', undefined],
      ['use', '/w/on-shelf.png', 'Figma', undefined],
      ['task-out', '/w/out.ts', 'Figma', 'Add tests'],
      ['made', '/made/on-shelf.jpg', 'Figma', undefined],
    ]);
  });

  test('with recall off nothing is recorded and the notch is told it is off', async () => {
    const { events, say, views } = setup({ enabled: false });
    await say('{"t":"ready","app":"Finder"}');
    await say('{"t":"shelf-add","items":[{"kind":"file","path":"/w/a.pdf"}]}');
    await say('{"t":"edit","items":[{"kind":"file","path":"/w/b.ts"}]}');
    expect(events).toEqual([]);
    expect(views()[0]).toEqual({ t: 'recall', enabled: false, next: { label: 'Recent', items: [] }, groups: [] });
  });

  test('the view leaves out the shelf\'s own cards and missing files; a recall card is kept only if the notch was showing it', async () => {
    const events: Activity[] = [
      { at: 1_000, kind: 'use', path: '/w/old.md' }, { at: 2_000, kind: 'use', path: '/w/gone.md' },
      { at: 3_000, kind: 'use', path: '/w/on-shelf.png' }, { at: 4_000, kind: 'use', path: '/w/last.md' },
    ];
    const { added, say, views } = setup({ events });
    await say('{"t":"ready"}');
    expect(views()[0].next).toEqual({ label: 'Recent', items: [expect.objectContaining({ id: 'recall:/w/old.md', path: '/w/old.md', title: 'old.md' })] });
    await say('{"t":"recall-keep","path":"/w/old.md"}');
    await say('{"t":"recall-keep","path":"/etc/passwd"}');
    expect(added).toEqual([{ kind: 'file', path: '/w/old.md' }]);
  });

  test('a recall card used counts only if it was shown; the replay is worked out again every few events', async () => {
    const { events, verdicts, say } = setup({ events: [{ at: 1_000, kind: 'use', path: '/w/old.md' }, { at: 2_000, kind: 'use', path: '/w/last.md' }] });
    await say('{"t":"ready"}');
    expect(verdicts).toHaveLength(1);
    await say('{"t":"shelf-touch","id":"recall:/w/old.md"}');
    await say('{"t":"shelf-touch","id":"recall:/etc/hosts"}');
    expect(events.slice(2).map((e) => e.path)).toEqual(['/w/old.md']);
    for (let i = 0; i < VERDICT_EVERY; i++) await say('{"t":"edit","items":[{"kind":"file","path":"/w/b.ts"}]}');
    await say('{"t":"hover","open":true}');
    expect(verdicts).toHaveLength(2);
  });

  test('"Probably next" appears only when the replay chose the ranker', () => {
    const events: Activity[] = [{ at: 1, kind: 'use', path: '/w/a' }, { at: 2, kind: 'use', path: '/w/b' }];
    const base = { enabled: true, now: 10, inView: [], exists: () => true };
    expect(recallView(events, { ...base, use: 'recent' }).next.label).toBe('Recent');
    expect(recallView(events, { ...base, use: 'predict' }).next).toEqual({ label: 'Probably next', items: [expect.objectContaining({ path: '/w/a' })] });
  });
});
