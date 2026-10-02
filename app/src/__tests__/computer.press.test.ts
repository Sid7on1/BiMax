import { INPUT_TOOLS, LOOK_TOOLS, PICK_ROLES, USE_TOOLS, TYPE_ROLES, isNeverUsed, useManifest } from '../main/computer/look.manifest';
import {
  createLookService, KEEP_GOING_EVERY, MAX_SCROLL_PAGES, MAX_TYPE_CHARS, PRESS_FRESH_MS,
  type LookDriver, type LookElement, type PressOutcome, type PressTarget, type RunningApp, type TypeOutcome,
} from '../main/computer/look.service';
import { windowElements } from '../main/computer/look.driver';
import { buildEngineChildEnv } from '../main/coding.runtime.paths';
import { identifyProcess, type ProcessIdentity } from '../main/computer/look.identity';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Record 65 stage 6 (§6h) — using other apps: press any named control and type into a box, in any app the person lets
 * the task use, with the app's card before anything that commits. Each failure mode stage 3 named keeps its test (wrong
 * target, no-op, stale frame, duplicate effect, approval skipped, takeover, wrong build), and each new rule has one: the
 * use grant, ordinary steps without a card, commit words, dialogs, unreadable names, the press after typing, typing
 * read back, overwrite, line breaks, password fields, the keep-going card, never-used apps.
 */

const FIXTURE: RunningApp = { name: 'BimaxCuFixture', bundleId: 'ai.bimax.cu.fixture', pid: 21 };
const NOTES: RunningApp = { name: 'Notes', bundleId: 'com.apple.Notes', pid: 22 };
const VAULT: RunningApp = { name: '1Password 7', bundleId: 'com.agilebits.onepassword7', pid: 23 };
const BANK: RunningApp = { name: 'Chase Bank', bundleId: 'com.chase.mobile', pid: 24 };
const WINDOW = 1228;
const BEFORE = '- [62] AXWindow "Bimax-Cu Fixture"\n  - [63] AXButton "Fixture Button"\n  - [90] AXStaticText = "presses=0 events=0 last=none"';
const AFTER = '- [62] AXWindow "Bimax-Cu Fixture"\n  - [63] AXButton "Fixture Button"\n  - [90] AXStaticText = "presses=1 events=1 last=button"';
const ELEMENTS: LookElement[] = [
  { role: 'AXButton', label: 'Fixture Button', pressable: true },
  { role: 'AXCheckBox', label: 'Fixture Checkbox', pressable: true },
  { role: 'AXTextField', label: 'Compose message', pressable: false, editable: true, value: '', at: '219,371' },
  { role: 'AXTextField', label: 'Search', pressable: false, editable: true, value: '', at: '219,300' },
  { role: 'AXSecureTextField', label: 'Password', pressable: false },
  { role: 'AXButton', label: 'Send', pressable: true },
  { role: 'AXButton', label: 'Delete Everything', pressable: true },
  { role: 'AXRow', label: 'Mom', pressable: true },
  { role: 'AXButton', label: 'OK', pressable: true },
  { role: 'AXButton', label: 'OK', pressable: true },
  { role: 'AXStaticText', label: 'presses=0', pressable: false },
  { role: 'AXPopUpButton', label: 'First', pressable: false, pickable: true, value: 'First', at: '582,332' },
  { role: 'AXPopUpButton', label: 'Delete…', pressable: false, pickable: true, value: 'Nothing', at: '582,400' },
  // A search box whose name does not say so (measured: Music's reads "Apple Music"); the driver marks it from its Search child.
  { role: 'AXTextField', label: 'Apple Music', pressable: false, editable: true, value: '', at: '600,40', searchBox: true },
];
const ALLOW_USE = 'Allow using BimaxCuFixture';

interface Opts {
  look?: boolean; use?: boolean; answers?: string[]; elements?: LookElement[];
  outcome?: PressOutcome | (() => PressOutcome);
  typed?: TypeOutcome | ((text: string) => TypeOutcome);
  confirmed?: PressOutcome;
  picked?: TypeOutcome | ((option: string) => TypeOutcome);
  scrolled?: PressOutcome;
  /** What the driver reports in front, call by call (the last repeats). */
  fronts?: Array<string | null>;
  identify?: (pid: number) => Promise<ProcessIdentity | null>;
}

function setup(opts: Opts = {}) {
  let look = opts.look ?? true;
  let useOn = opts.use ?? true;
  let clock = 1_000_000;
  const answers = [...(opts.answers ?? [ALLOW_USE])];
  const asked: Array<{ question: string; options: string[]; body: string }> = [];
  const presses: Array<{ threadId: string; app: string; target: PressTarget; front?: boolean }> = [];
  const frontTypings: Array<{ app: string; target: PressTarget; text: string }> = [];
  const frontReturns: Array<{ app: string; target: PressTarget }> = [];
  const fronts = [...(opts.fronts ?? ['Muse'])];
  const typings: Array<{ app: string; target: PressTarget; text: string }> = [];
  const confirms: Array<{ app: string; target: PressTarget & { at?: string } }> = [];
  const picks: Array<{ app: string; target: PressTarget; option: string }> = [];
  const scrolls: Array<{ app: string; target: PressTarget; direction: string; pages: number }> = [];
  const audit: any[] = [];
  let beforeDriver: (() => void) | null = null;
  let duringAsk: (() => void) | null = null;
  let elements = opts.elements ?? ELEMENTS;
  const driver: LookDriver = {
    runningApps: async () => [FIXTURE, NOTES, VAULT, BANK],
    look: async (_t, app) => ({ title: app === FIXTURE ? 'Bimax-Cu Fixture' : 'Groceries', markdown: BEFORE, windowId: WINDOW, elements }),
    press: async (threadId, app, target, front) => {
      presses.push({ threadId, app: app.bundleId, target, ...(front ? { front } : {}) });
      const o = opts.outcome ?? { kind: 'pressed', title: 'Bimax-Cu Fixture', before: BEFORE, after: AFTER, elements };
      return typeof o === 'function' ? o() : o;
    },
    type: async (_threadId, app, target, text) => {
      typings.push({ app: app.bundleId, target, text });
      const o = opts.typed ?? ((t: string) => ({
        kind: 'typed', title: 'Bimax-Cu Fixture', before: BEFORE, after: AFTER, value: t,
        elements: elements.map((e) => (e.role === target.role && e.label === target.label ? { ...e, label: t || e.label, value: t } : e)),
      }) as TypeOutcome);
      return typeof o === 'function' ? o(text) : o;
    },
    typeFront: async (_threadId, app, target, text) => {
      frontTypings.push({ app: app.bundleId, target, text });
      return { kind: 'typed', title: 'Bimax-Cu Fixture', before: BEFORE, after: AFTER, value: text, elements: elements.map((e) => (e.role === target.role && e.label === target.label ? { ...e, label: text || e.label, value: text } : e)) };
    },
    returnFront: async (_threadId, app, target) => {
      frontReturns.push({ app: app.bundleId, target });
      return { kind: 'pressed', title: 'Bimax-Cu Fixture', before: AFTER, after: `${AFTER}\n  - [91] AXStaticText = "results: 3"`, elements };
    },
    frontApp: async () => (fronts.length > 1 ? fronts.shift()! : fronts[0] ?? null),
    confirm: async (_threadId, app, target) => {
      confirms.push({ app: app.bundleId, target });
      return opts.confirmed ?? { kind: 'pressed', title: 'Bimax-Cu Fixture', before: AFTER, after: `${AFTER}\n  - [91] AXStaticText = "results: 3"`, elements };
    },
    pick: async (_threadId, app, target, option) => {
      picks.push({ app: app.bundleId, target, option });
      const o = opts.picked ?? ((opt: string) => ({ kind: 'typed', title: 'x', before: BEFORE, after: `${BEFORE}\n  - [92] AXStaticText = "chosen ${opt}"`, value: opt, elements }) as TypeOutcome);
      return typeof o === 'function' ? o(option) : o;
    },
    scroll: async (_threadId, app, target, direction, pages) => {
      scrolls.push({ app: app.bundleId, target, direction, pages });
      return opts.scrolled ?? { kind: 'pressed', title: 'x', before: BEFORE, after: `${BEFORE}\n  - [93] AXButton "Row 13"`, elements };
    },
    end: async () => {},
  };
  const service = createLookService({
    enabled: () => look,
    useEnabled: () => look && useOn,
    now: () => clock,
    ...(opts.identify ? { identify: opts.identify } : {}),
    driver: async () => { const hook = beforeDriver; beforeDriver = null; hook?.(); return driver; },
    ask: async (_t, question, options, body) => {
      asked.push({ question, options, body });
      const hook = duringAsk; duringAsk = null; hook?.();
      return answers.shift() ?? '';
    },
    audit: (entry) => audit.push(entry),
  });
  let id = 0;
  const call = (capability: 'look' | 'press' | 'type' | 'scroll', op: string, args: Record<string, unknown>, callId = ++id) =>
    service.handle('t1', { t: 'host_call', id: callId, capability, op, args } as any);
  const lookAt = (app = 'BimaxCuFixture') => call('look', 'look', { app });
  const press = (control = 'Fixture Button', extra: Record<string, unknown> = {}) => call('press', 'press', { app: 'BimaxCuFixture', control, ...extra });
  const type = (text: string, extra: Record<string, unknown> = { field: 'Compose message' }) => call('type', 'type', { app: 'BimaxCuFixture', text, ...extra });
  const scroll = (control = 'Mom', extra: Record<string, unknown> = { direction: 'down' }) => call('scroll', 'scroll', { app: 'BimaxCuFixture', control, ...extra });
  const pick = (control: string, option: string) => call('press', 'press', { app: 'BimaxCuFixture', control, option });
  return {
    service, call, lookAt, press, type, scroll, pick, asked, presses, typings, confirms, picks, scrolls, frontTypings, frontReturns, audit,
    tick: (ms: number) => { clock += ms; },
    lookOff: () => { look = false; }, useOff: () => { useOn = false; }, useBackOn: () => { useOn = true; },
    setElements: (next: LookElement[]) => { elements = next; },
    answer: (...more: string[]) => { answers.push(...more); },
    beforeDriver: (hook: () => void) => { beforeDriver = hook; },
    duringAsk: (hook: () => void) => { duringAsk = hook; },
    counts: () => service.counts('t1'),
    pressCards: () => asked.filter((a) => a.question.startsWith('Press “')),
  };
}

const text = (result: any) => String(result.value?.text ?? '');

describe('the use grant: once per app per task, on the app’s own card', () => {
  it('with using on, the first look asks to use the app — use, only look, or not now', async () => {
    const s = setup();
    expect((await s.lookAt()).ok).toBe(true);
    expect(s.asked[0].question).toBe('Let this task use BimaxCuFixture?');
    expect(s.asked[0].options).toEqual([ALLOW_USE, 'Only look', 'Not now']);
    expect(s.asked[0].body).toContain('Before anything is sent, posted, bought, deleted or confirmed it stops and asks you');
  });

  it('“Only look”: a press is refused without asking again, and nothing is pressed', async () => {
    const s = setup({ answers: ['Only look'] });
    expect((await s.lookAt()).ok).toBe(true);
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.asked).toHaveLength(1);
    expect(s.presses).toEqual([]);
  });

  it('allowed to look while using was off: the first press asks to use it', async () => {
    const s = setup({ use: false, answers: ['Allow looking at BimaxCuFixture', ALLOW_USE] });
    await s.lookAt();
    s.useBackOn();
    expect((await s.press()).ok).toBe(true);
    expect(s.asked[1]).toMatchObject({ question: 'Let this task use BimaxCuFixture?', options: [ALLOW_USE, 'Not now'] });
    expect(s.presses).toHaveLength(1);
  });

  it('…and “Not now” there refuses this and every later step without asking again', async () => {
    const s = setup({ use: false, answers: ['Allow looking at BimaxCuFixture', 'Not now'] });
    await s.lookAt();
    s.useBackOn();
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'denied' } });
    await s.lookAt();
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.asked).toHaveLength(2);
    expect(s.presses).toEqual([]);
  });

  it.each([['a password manager', '1Password 7'], ['a bank', 'Chase Bank']])('%s is never looked at or used, and never asked about', async (_name, app) => {
    const s = setup();
    expect(await s.lookAt(app)).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(await s.call('press', 'press', { app, control: 'Fixture Button' })).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(await s.call('type', 'type', { app, text: 'x' })).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.asked).toEqual([]);
    expect(s.presses).toEqual([]);
    expect(s.typings).toEqual([]);
    const listed = text(await s.call('look', 'list_apps', {}));
    expect(listed).toContain('Notes');
    expect(listed).not.toContain(app);
  });

  it('never-used names cover password managers, wallets, banks and settings — and not ordinary apps', () => {
    for (const name of ['1Password 7', 'Bitwarden', 'MetaMask', 'Ledger Live', 'Chase Bank', 'PayPal', 'Wise', 'System Settings', 'com.apple.Passwords']) expect(isNeverUsed(name)).toBe(true);
    for (const name of ['WhatsApp', 'Music', 'Notes', 'Spotify', 'Safari', 'Otherwise', 'BimaxCuFixture']) expect(isNeverUsed(name)).toBe(false);
  });
});

describe('ordinary steps run without a card', () => {
  it('an ordinary press: no card after the grant, pressed once, what changed, and the re-read is bound for the next step', async () => {
    const s = setup();
    await s.lookAt();
    const result = await s.press('Fixture Button', { role: 'AXButton' });
    expect(result.ok).toBe(true);
    expect(s.asked).toHaveLength(1); // the grant only
    expect(s.presses).toEqual([{ threadId: 't1', app: 'ai.bimax.cu.fixture', target: { windowId: WINDOW, role: 'AXButton', label: 'Fixture Button' } }]);
    expect(text(result)).toContain('Pressed “Fixture Button” in BimaxCuFixture');
    expect(text(result)).toContain('- AXStaticText = "presses=0 events=0 last=none"');
    expect(text(result)).toContain('+ AXStaticText = "presses=1 events=1 last=button"');
    expect(text(result)).toContain('without looking again');
    expect(s.counts()).toMatchObject({ looks: 1, asked: 1, presses: 1, inputCalls: 1 });
    const receipt = s.audit[1].receipt;
    expect(receipt).toMatchObject({ action: 'press', role: 'AXButton', windowId: WINDOW, asked: null, outcome: 'pressed' });
    expect(JSON.stringify(s.audit[1])).not.toContain('Fixture Button');
  });

  it('steps chain on each step’s own re-read: no look between them', async () => {
    const s = setup();
    await s.lookAt();
    expect((await s.press('Mom')).ok).toBe(true);
    expect((await s.press('Fixture Checkbox')).ok).toBe(true);
    expect(s.presses).toHaveLength(2);
    expect(s.counts()).toMatchObject({ looks: 1 });
  });

  it('a step whose re-read came back without controls needs a new look', async () => {
    const s = setup({ outcome: { kind: 'pressed', title: 'x', before: BEFORE, after: AFTER } });
    await s.lookAt();
    expect((await s.press()).ok).toBe(true);
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(s.presses).toHaveLength(1);
  });

  it('a read cut short says so (measured: on a busy Mac the driver ran out of time after the menu bar)', async () => {
    const s = setup();
    const look = s.service; void look;
    const partial = createLookService({
      enabled: () => true, useEnabled: () => true, ask: async () => ALLOW_USE,
      driver: async () => ({ runningApps: async () => [FIXTURE], look: async () => ({ title: 'x', markdown: BEFORE, windowId: 1, elements: ELEMENTS, partial: true }), end: async () => {} }),
    });
    const result = await partial.handle('t1', { t: 'host_call', id: 1, capability: 'look', op: 'look', args: { app: 'BimaxCuFixture' } } as any);
    expect(text(result)).toContain('Only part of the window could be read in time');
    expect(text(await s.lookAt())).not.toContain('Only part');
  });

  it('any app the person allowed, not only Bimax’s test apps', async () => {
    const s = setup({ answers: ['Allow using Notes'] });
    await s.lookAt('Notes');
    expect((await s.call('press', 'press', { app: 'Notes', control: 'Mom' })).ok).toBe(true);
    expect(s.presses[0].app).toBe('com.apple.Notes');
  });
});

describe('a step that commits stops on the app’s card first', () => {
  it.each([
    ['sends', 'Send'],
    ['deletes', 'Delete Everything'],
    ['confirms', 'Confirm'],
    ['buys', 'Buy now'],
    ['sends, in French', 'Envoyer'],
  ])('a control that %s: “%s”', async (_what, label) => {
    const els: LookElement[] = [...ELEMENTS.filter((e) => e.label !== label), { role: 'AXButton', label, pressable: true }];
    const s = setup({ elements: els, answers: [ALLOW_USE, `Press “${label}”`] });
    await s.lookAt();
    expect((await s.press(label)).ok).toBe(true);
    expect(s.pressCards()).toHaveLength(1);
    expect(s.pressCards()[0]).toMatchObject({ question: `Press “${label}” in BimaxCuFixture?`, options: [`Press “${label}”`, 'Don’t press'] });
    expect(s.pressCards()[0].body).toContain('can send, buy, delete or confirm something');
    expect(s.presses).toHaveLength(1);
    expect(s.audit[1].receipt.asked).toBe('word');
  });

  it('“Don’t press” presses nothing, and a closed card is no', async () => {
    for (const no of ['Don’t press', '']) {
      const s = setup({ answers: [ALLOW_USE, no] });
      await s.lookAt();
      expect(await s.press('Send')).toMatchObject({ ok: false, value: { code: 'denied' } });
      expect(s.presses).toEqual([]);
    }
  });

  it('every commit asks — an earlier yes covers nothing later', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Press “Send”', 'Don’t press'] });
    await s.lookAt();
    expect((await s.press('Send')).ok).toBe(true);
    expect(await s.press('Send')).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.pressCards()).toHaveLength(2);
    expect(s.presses).toHaveLength(1);
  });

  it('any control inside a sheet or dialog, whatever its name', async () => {
    const els: LookElement[] = [{ role: 'AXButton', label: 'Fixture Button', pressable: true, inDialog: true }];
    const s = setup({ elements: els, answers: [ALLOW_USE, 'Don’t press'] });
    await s.lookAt();
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.pressCards()[0].body).toContain('answers a question the app asked');
  });

  it('a name with no letters Bimax can read', async () => {
    const els: LookElement[] = [{ role: 'AXButton', label: '➤', pressable: true }];
    const s = setup({ elements: els, answers: [ALLOW_USE, 'Don’t press'] });
    await s.lookAt();
    expect(await s.press('➤')).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.pressCards()[0].body).toContain('cannot tell from the name');
  });

  it('the first press after typing into a box that is not a search box — the card shows the text as the box reads, and what was opened', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Press “Fixture Button”'] });
    await s.lookAt();
    expect((await s.press('Mom')).ok).toBe(true); // ordinary: opens the chat
    expect((await s.type('running late')).ok).toBe(true); // ordinary: typing sends nothing
    expect(s.pressCards()).toHaveLength(0);
    expect((await s.press('Fixture Button')).ok).toBe(true);
    const card = s.pressCards()[0];
    expect(card.body).toContain('Bimax typed text in this app, and this press may send it');
    expect(card.body).toContain('Window: “Bimax-Cu Fixture”');
    expect(card.body).toContain('Bimax last opened here: “Mom”');
    expect(card.body).toContain('as the box reads now: “running late”');
    // The person saw the text and let it go: the next ordinary press runs without a card.
    expect((await s.press('Fixture Checkbox')).ok).toBe(true);
    expect(s.pressCards()).toHaveLength(1);
  });

  it('typing into a search box is not followed by a card', async () => {
    const s = setup();
    await s.lookAt();
    expect((await s.type('mom', { field: 'Search' })).ok).toBe(true);
    expect((await s.press('Mom')).ok).toBe(true);
    expect(s.pressCards()).toHaveLength(0);
  });
});

describe('typing', () => {
  it('sets one box’s text, reads it back exactly, and says nothing was sent', async () => {
    const s = setup();
    await s.lookAt();
    const result = await s.type('running late', { field: 'Compose message', role: 'AXTextField' });
    expect(result.ok).toBe(true);
    expect(s.typings).toEqual([{ app: 'ai.bimax.cu.fixture', target: { windowId: WINDOW, role: 'AXTextField', label: 'Compose message' }, text: 'running late' }]);
    expect(text(result)).toContain('The box now reads exactly: “running late”');
    expect(text(result)).toContain('Nothing was sent');
    expect(s.counts()).toMatchObject({ typings: 1, inputCalls: 1, asked: 1 });
    const receipt = s.audit[1].receipt;
    expect(receipt).toMatchObject({ action: 'type', asked: null, outcome: 'typed', textLength: 12 });
    expect(JSON.stringify(s.audit[1])).not.toContain('running late');
  });

  it('the box may be left out when the window has exactly one; with two it must be named', async () => {
    const one = setup({ elements: ELEMENTS.filter((e) => e.label !== 'Search' && e.label !== 'Apple Music') });
    await one.lookAt();
    expect((await one.type('hi', {})).ok).toBe(true);
    const two = setup();
    await two.lookAt();
    expect(await two.type('hi', {})).toMatchObject({ ok: false, value: { code: 'ambiguous' } });
    expect((await two.type('hi', {})).error).toBeDefined();
    expect(two.typings).toEqual([]);
  });

  it.each([
    ['a line break', 'hi\nthere'],
    ['a carriage return', 'hi\rthere'],
    ['a Unicode line separator', `hi${String.fromCharCode(0x2028)}there`],
    ['too much text', 'x'.repeat(MAX_TYPE_CHARS + 1)],
  ])('refuses %s before anything is asked or typed', async (_name, value) => {
    const s = setup();
    await s.lookAt();
    expect(await s.type(value)).toMatchObject({ ok: false, value: { code: 'invalid_args' } });
    expect(s.typings).toEqual([]);
    expect(s.asked).toHaveLength(1);
  });

  it('never a password field, and never a control that is not a text box', async () => {
    const s = setup();
    await s.lookAt();
    expect(await s.type('hunter2', { field: 'Password' })).toMatchObject({ ok: false, value: { code: 'denied' } });
    await s.lookAt();
    expect(await s.type('x', { field: 'Fixture Button' })).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(s.typings).toEqual([]);
  });

  it('a text box is typed into, not pressed', async () => {
    const s = setup();
    await s.lookAt();
    const result = await s.press('Compose message');
    expect(result).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(result.error).toContain('TypeInAppTool');
  });

  it('text the person put in the box: asked before it is replaced', async () => {
    const els = ELEMENTS.map((e) => (e.label === 'Compose message' ? { ...e, label: 'my own draft', value: 'my own draft' } : e));
    const no = setup({ elements: els, answers: [ALLOW_USE, 'Don’t type'] });
    await no.lookAt();
    expect(await no.type('hi', { field: 'my own draft' })).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(no.asked[1].question).toBe('Replace the text in “my own draft” in BimaxCuFixture?');
    expect(no.asked[1].body).toContain('“my own draft”');
    expect(no.typings).toEqual([]);
    const yes = setup({ elements: els, answers: [ALLOW_USE, 'Replace it'] });
    await yes.lookAt();
    expect((await yes.type('hi', { field: 'my own draft' })).ok).toBe(true);
    expect(yes.audit[1].receipt.asked).toBe('overwrite');
  });

  it('text in a search box is a query: replacing it never asks (measured: Music’s box holds “Apple Music”)', async () => {
    const els = ELEMENTS.map((e) => (e.label === 'Apple Music' ? { ...e, value: 'Apple Music' } : e));
    const s = setup({ elements: els });
    await s.lookAt();
    expect((await s.type('blinding lights', { field: 'Apple Music' })).ok).toBe(true);
    expect(s.asked).toHaveLength(1);
  });

  it('typing again over Bimax’s own text does not ask', async () => {
    const s = setup();
    await s.lookAt();
    expect((await s.type('first')).ok).toBe(true);
    expect((await s.type('second', { field: 'first' })).ok).toBe(true);
    expect(s.asked).toHaveLength(1);
    expect(s.typings).toHaveLength(2);
  });

  it('text that did not land is a failure — and the next press still asks', async () => {
    const s = setup({
      typed: { kind: 'typed', title: 'x', before: BEFORE, after: BEFORE, value: '', elements: ELEMENTS },
      answers: [ALLOW_USE, 'Don’t press'],
    });
    await s.lookAt();
    const result = await s.type('running late');
    expect(result).toMatchObject({ ok: false, value: { code: 'no_effect' } });
    expect(result.error).toContain('did not land');
    expect(s.counts()).toMatchObject({ typings: 0, inputCalls: 1 });
    expect(s.audit[1].receipt.outcome).toBe('no_effect');
    expect(await s.press('Fixture Button')).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.pressCards()).toHaveLength(1);
  });

  it('a box that reads something else, a box not found again, an unknown outcome: never “typed”, never retried', async () => {
    for (const [typed, code] of [
      [{ kind: 'typed', title: 'x', before: BEFORE, after: AFTER, value: 'running lat', elements: ELEMENTS }, 'uncertain'],
      [{ kind: 'typed', title: 'x', before: BEFORE, after: AFTER, value: null, elements: ELEMENTS }, 'uncertain'],
      [{ kind: 'uncertain', detail: 'timed out' }, 'uncertain'],
    ] as Array<[TypeOutcome, string]>) {
      const s = setup({ typed });
      await s.lookAt();
      expect(await s.type('running late')).toMatchObject({ ok: false, value: { code } });
      expect(s.typings).toHaveLength(1);
      expect(s.counts()).toMatchObject({ typings: 0, inputCalls: 1 });
    }
  });
});

describe('Return in a box', () => {
  it('in a search box it just runs: typed, read back, then Return — no card', async () => {
    const s = setup();
    await s.lookAt();
    const result = await s.type('blinding lights', { field: 'Apple Music', submit: true });
    expect(result.ok).toBe(true);
    expect(s.asked).toHaveLength(1);
    expect(s.confirms).toEqual([{ app: 'ai.bimax.cu.fixture', target: { windowId: WINDOW, role: 'AXTextField', label: 'blinding lights', at: '600,40' } }]);
    expect(text(result)).toContain('Then pressed Return in it');
    expect(text(result)).toContain('+ AXStaticText = "results: 3"');
    expect(s.audit[1].receipt).toMatchObject({ action: 'type', submitted: true, asked: null });
    // A search sends nothing, so the next ordinary press runs without a card.
    expect((await s.press('Mom')).ok).toBe(true);
    expect(s.pressCards()).toHaveLength(0);
  });

  it('in any other box it asks first, showing the text as the box reads it; “Don’t press Return” sends nothing', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Don’t press Return'] });
    await s.lookAt();
    expect((await s.press('Mom')).ok).toBe(true);
    const result = await s.type('running late', { field: 'Compose message', submit: true });
    expect(result).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(result.error).toContain('Nothing was sent');
    expect(s.asked[1].question).toBe('Press Return in “Compose message” in BimaxCuFixture?');
    expect(s.asked[1].options).toEqual(['Press Return', 'Don’t press Return']);
    expect(s.asked[1].body).toContain('may send what is in it');
    expect(s.asked[1].body).toContain('The box reads now: “running late”');
    expect(s.asked[1].body).toContain('Bimax last opened here: “Mom”');
    expect(s.confirms).toEqual([]);
    expect(s.typings).toHaveLength(1);
  });

  it('allowed: Return is pressed once, and the text it sent no longer makes the next press ask', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Press Return'] });
    await s.lookAt();
    expect((await s.type('running late', { field: 'Compose message', submit: true })).ok).toBe(true);
    expect(s.confirms).toHaveLength(1);
    expect(s.audit[1].receipt).toMatchObject({ asked: 'submit', submitted: true });
    expect((await s.press('Mom')).ok).toBe(true);
    expect(s.pressCards()).toHaveLength(0);
  });

  it('text that did not land is never followed by Return', async () => {
    const s = setup({ typed: { kind: 'typed', title: 'x', before: BEFORE, after: BEFORE, value: '', elements: ELEMENTS } });
    await s.lookAt();
    expect(await s.type('blinding lights', { field: 'Apple Music', submit: true })).toMatchObject({ ok: false, value: { code: 'no_effect' } });
    expect(s.confirms).toEqual([]);
  });

  it('Return that changed nothing is not a success, and is never pressed again', async () => {
    const s = setup({ confirmed: { kind: 'pressed', title: 'x', before: AFTER, after: AFTER, elements: ELEMENTS } });
    await s.lookAt();
    const result = await s.type('blinding lights', { field: 'Apple Music', submit: true });
    expect(result).toMatchObject({ ok: false, value: { code: 'no_effect' } });
    expect(result.error).toContain('Look again before doing anything else');
    expect(s.confirms).toHaveLength(1);
  });
});

describe('picking an item from a pop-up', () => {
  it('an ordinary item: chosen without opening the menu, read back, no card', async () => {
    const s = setup();
    await s.lookAt();
    const result = await s.pick('First', 'Second');
    expect(result.ok).toBe(true);
    expect(s.picks).toEqual([{ app: 'ai.bimax.cu.fixture', target: { windowId: WINDOW, role: 'AXPopUpButton', label: 'First' }, option: 'Second' }]);
    expect(text(result)).toContain('Chose “Second” in “First”');
    expect(s.asked).toHaveLength(1);
    expect(s.presses).toEqual([]);
    expect(s.counts()).toMatchObject({ picks: 1, inputCalls: 1 });
    expect(s.audit[1].receipt).toMatchObject({ action: 'pick', asked: null, outcome: 'pressed' });
    expect(JSON.stringify(s.audit[1])).not.toContain('Second');
  });

  it('an item that commits asks first; “Don’t choose” chooses nothing', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Don’t choose'] });
    await s.lookAt();
    expect(await s.pick('First', 'Delete All')).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.asked[1]).toMatchObject({ question: 'Choose “Delete All” in “First” in BimaxCuFixture?', options: ['Choose “Delete All”', 'Don’t choose'] });
    expect(s.picks).toEqual([]);
  });

  it('a pop-up whose own name commits asks for any item', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Choose “Everything”'] });
    await s.lookAt();
    expect((await s.pick('Delete…', 'Everything')).ok).toBe(true);
    expect(s.asked[1].question).toBe('Choose “Everything” in “Delete…” in BimaxCuFixture?');
    expect(s.asked[1].body).toContain('“Delete…” can send, buy, delete or confirm');
  });

  it('a pop-up inside a sheet or dialog asks for any item', async () => {
    const els: LookElement[] = [{ role: 'AXPopUpButton', label: 'Format', pressable: false, pickable: true, value: 'PNG', inDialog: true, at: '1,1' }];
    const s = setup({ elements: els, answers: [ALLOW_USE, 'Don’t choose'] });
    await s.lookAt();
    expect(await s.pick('Format', 'JPEG')).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.asked[1].body).toContain('answers a question the app asked');
    expect(s.picks).toEqual([]);
  });

  it('only a pop-up is picked from, and a pop-up is never pressed without an item', async () => {
    const s = setup();
    await s.lookAt();
    expect(await s.pick('Fixture Button', 'Second')).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    await s.lookAt();
    const pressed = await s.press('First');
    expect(pressed).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(pressed.error).toContain('give the item to choose as "option"');
    expect(s.picks).toEqual([]);
    expect(s.presses).toEqual([]);
  });

  it('an item that did not stick, or another item, is never “chosen”', async () => {
    for (const [picked, code] of [
      [{ kind: 'typed', title: 'x', before: BEFORE, after: BEFORE, value: 'First', elements: ELEMENTS }, 'no_effect'],
      [{ kind: 'typed', title: 'x', before: BEFORE, after: AFTER, value: 'Third', elements: ELEMENTS }, 'uncertain'],
      [{ kind: 'not_typed', reason: 'refused', detail: 'no item' }, 'not_found'],
    ] as Array<[TypeOutcome, string]>) {
      const s = setup({ picked });
      await s.lookAt();
      expect(await s.pick('First', 'Second')).toMatchObject({ ok: false, value: { code } });
      expect(s.counts()?.picks).toBe(0);
    }
  });

  it('the item is matched without case or invisible marks, as the driver matches it', async () => {
    const s = setup({ picked: { kind: 'typed', title: 'x', before: BEFORE, after: AFTER, value: `${String.fromCharCode(0x200e)}second`, elements: ELEMENTS } });
    await s.lookAt();
    expect((await s.pick('First', 'Second')).ok).toBe(true);
  });
});

describe('scrolling', () => {
  it('scrolls at one named control, with no card, and says what came into view', async () => {
    const s = setup();
    await s.lookAt();
    const result = await s.scroll('Mom', { direction: 'down', pages: 2 });
    expect(result.ok).toBe(true);
    expect(s.scrolls).toEqual([{ app: 'ai.bimax.cu.fixture', target: { windowId: WINDOW, role: 'AXRow', label: 'Mom' }, direction: 'down', pages: 2 }]);
    expect(text(result)).toContain('+ AXButton "Row 13"');
    expect(text(result)).toContain('without looking again');
    expect(s.asked).toHaveLength(1);
    expect(s.counts()).toMatchObject({ scrolls: 1, inputCalls: 1 });
    expect(s.audit[1].receipt).toMatchObject({ action: 'scroll', asked: null, outcome: 'pressed' });
  });

  it('nothing moved is said plainly — the end of the list — and is not counted as a scroll', async () => {
    const s = setup({ scrolled: { kind: 'pressed', title: 'x', before: BEFORE, after: BEFORE, elements: ELEMENTS } });
    await s.lookAt();
    const result = await s.scroll();
    expect(result).toMatchObject({ ok: false, value: { code: 'no_effect' } });
    expect(result.error).toContain('nothing moved');
    expect(s.counts()?.scrolls).toBe(0);
  });

  it.each([
    ['no direction', { }],
    ['a direction that is not one of the four', { direction: 'sideways' }],
    ['too far', { direction: 'down', pages: MAX_SCROLL_PAGES + 1 }],
    ['zero pages', { direction: 'down', pages: 0 }],
  ])('refuses %s before anything is sent', async (_name, extra) => {
    const s = setup();
    await s.lookAt();
    expect(await s.scroll('Mom', extra as Record<string, unknown>)).toMatchObject({ ok: false, value: { code: 'invalid_args' } });
    expect(s.scrolls).toEqual([]);
  });

  it('a place that is not there once is refused', async () => {
    const s = setup();
    await s.lookAt();
    expect(await s.scroll('Nowhere')).toMatchObject({ ok: false, value: { code: 'not_found' } });
    await s.lookAt();
    expect(await s.scroll('OK')).toMatchObject({ ok: false, value: { code: 'ambiguous' } });
    expect(s.scrolls).toEqual([]);
  });

  it('scrolls count toward “Keep going?” like any unasked step', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Stop here'] });
    await s.lookAt();
    for (let i = 0; i < KEEP_GOING_EVERY; i++) expect((await s.scroll()).ok).toBe(true);
    expect(await s.scroll()).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.asked[1].body).toContain('Next: scroll down at “Mom”');
  });
});

describe('bringing the app forward for one step (ability 4) — asked every time, and the person’s app put back', () => {
  it('an ordinary press in front: its own card names the app, the step and the app put back; the result says it came back', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Bring BimaxCuFixture forward once'], fronts: ['Muse', 'Muse'] });
    await s.lookAt();
    const result = await s.press('Mom', { front: true });
    expect(result.ok).toBe(true);
    expect(s.asked[1].question).toBe('Bring BimaxCuFixture forward for a moment?');
    expect(s.asked[1].options).toEqual(['Bring BimaxCuFixture forward once', 'Not now']);
    expect(s.asked[1].body).toContain('press “Mom”');
    expect(s.asked[1].body).toContain('puts Muse back');
    expect(s.asked[1].body).toContain('Please don\'t type until it has');
    expect(s.presses).toEqual([{ threadId: 't1', app: 'ai.bimax.cu.fixture', target: { windowId: WINDOW, role: 'AXRow', label: 'Mom' }, front: true }]);
    expect(text(result)).toContain('put Muse back in front');
    expect(s.audit[1].receipt.front).toEqual({ asked: true, before: 'Muse', after: 'Muse', restored: true });
  });

  it('“Not now” brings nothing forward and presses nothing', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Not now'] });
    await s.lookAt();
    expect(await s.press('Mom', { front: true })).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.presses).toEqual([]);
  });

  it('every time — an earlier yes covers nothing later', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Bring BimaxCuFixture forward once', 'Not now'] });
    await s.lookAt();
    expect((await s.press('Mom', { front: true })).ok).toBe(true);
    expect(await s.press('Mom', { front: true })).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.asked.filter((a) => a.question.startsWith('Bring'))).toHaveLength(2);
    expect(s.presses).toHaveLength(1);
  });

  it('a step that commits asks once: its own card says the app comes forward', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Press “Send”'] });
    await s.lookAt();
    expect((await s.press('Send', { front: true })).ok).toBe(true);
    expect(s.asked).toHaveLength(2);
    expect(s.asked[1].question).toBe('Press “Send” in BimaxCuFixture?');
    expect(s.asked[1].body).toContain('brings BimaxCuFixture to the front for about 3 seconds, then puts Muse back');
    expect(s.presses[0].front).toBe(true);
  });

  it('when the person’s app does not come back, it is said — Bimax moves nothing to fix it', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Bring BimaxCuFixture forward once'], fronts: ['Muse', 'BimaxCuFixture'] });
    await s.lookAt();
    const result = await s.press('Mom', { front: true });
    expect(text(result)).toContain('Muse did not come back to the front: BimaxCuFixture is in front now');
    expect(s.audit[1].receipt.front).toMatchObject({ restored: false });
  });

  it('typing in front: the front typing path, then Return as a keystroke in a search box — one card', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Bring BimaxCuFixture forward once'] });
    await s.lookAt();
    const result = await s.type('blinding lights', { field: 'Apple Music', submit: true, front: true });
    expect(result.ok).toBe(true);
    expect(s.typings).toEqual([]);
    expect(s.frontTypings).toHaveLength(1);
    expect(s.frontReturns).toHaveLength(1);
    expect(s.confirms).toEqual([]);
    expect(s.asked.filter((a) => a.question.startsWith('Bring'))).toHaveLength(1);
    expect(s.asked[1].body).toContain('type into “Apple Music”');
  });

  it('Return in front in a message box: the Return card also says the app comes forward', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Bring BimaxCuFixture forward once', 'Press Return'] });
    await s.lookAt();
    expect((await s.type('running late', { field: 'Compose message', submit: true, front: true })).ok).toBe(true);
    expect(s.asked[2].question).toBe('Press Return in “Compose message” in BimaxCuFixture?');
    expect(s.asked[2].body).toContain('brings BimaxCuFixture to the front for about 3 seconds');
    expect(s.frontReturns).toHaveLength(1);
  });

  it('scrolling and choosing from a pop-up never bring an app forward', async () => {
    const s = setup();
    await s.lookAt();
    expect(await s.scroll('Mom', { direction: 'down', front: true })).toMatchObject({ ok: false, value: { code: 'invalid_args' } });
    expect(await s.call('press', 'press', { app: 'BimaxCuFixture', control: 'First', option: 'Second', front: true })).toMatchObject({ ok: false, value: { code: 'invalid_args' } });
  });

  it('a press from behind that changed nothing says the person can let Bimax bring the app forward', async () => {
    const s = setup({ outcome: { kind: 'pressed', title: 'x', before: BEFORE, after: BEFORE, elements: ELEMENTS } });
    await s.lookAt();
    expect((await s.press()).error).toContain('"front": true');
  });
});

describe('a long run of unasked steps stops for a word from the person', () => {
  it(`after ${KEEP_GOING_EVERY} steps the next one asks “Keep going?”; “Stop here” stops it`, async () => {
    const s = setup({ answers: [ALLOW_USE, 'Stop here'] });
    await s.lookAt();
    for (let i = 0; i < KEEP_GOING_EVERY; i++) expect((await s.press('Fixture Checkbox')).ok).toBe(true);
    expect(s.asked).toHaveLength(1);
    const result = await s.press('Fixture Checkbox');
    expect(result).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.asked[1]).toMatchObject({ question: 'Keep going in BimaxCuFixture?', options: ['Keep going', 'Stop here'] });
    expect(s.presses).toHaveLength(KEEP_GOING_EVERY);
  });

  it('“Keep going” carries on, and the count starts again', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Keep going'] });
    await s.lookAt();
    for (let i = 0; i < KEEP_GOING_EVERY + 1; i++) expect((await s.press('Fixture Checkbox')).ok).toBe(true);
    for (let i = 0; i < KEEP_GOING_EVERY - 1; i++) expect((await s.press('Fixture Checkbox')).ok).toBe(true);
    expect(s.asked).toHaveLength(2);
  });
});

describe('missing names: recover from observed controls without guessing a target', () => {
  it('the invented song name suggests the real pressable row, despite a wrong role; only copying it presses', async () => {
    const els: LookElement[] = [
      { role: 'AXTextField', label: 'Espresso Sabrina Carpenter', editable: true, pressable: false },
      { role: 'AXButton', label: 'Play', pressable: true },
      { role: 'AXMenuButton', label: 'Espresso, Another Artist', pressable: true },
      { role: 'AXMenuButton', label: 'Espresso, Sabrina Carpenter', pressable: true },
    ];
    const s = setup({ elements: els });
    await s.lookAt();
    const missing = await s.press('espresso – sabrina carpenter', { role: 'AXCell' });
    expect(missing).toMatchObject({ ok: false, value: { code: 'not_found' } });
    expect(missing.error).toContain('AXMenuButton: "Espresso, Sabrina Carpenter"');
    expect(missing.error!.indexOf('"Espresso, Sabrina Carpenter"')).toBeLessThan(missing.error!.indexOf('"Espresso, Another Artist"'));
    expect(missing.error).not.toContain('AXTextField:');
    expect(s.presses).toEqual([]);
    expect(s.asked).toHaveLength(1);
    expect(s.counts()?.inputCalls).toBe(0);
    expect(JSON.stringify(s.audit)).not.toContain('Espresso');
    expect((await s.press('Espresso, Sabrina Carpenter', { role: 'AXMenuButton' })).ok).toBe(true);
    expect(s.presses).toHaveLength(1);
    expect(s.presses[0].target.label).toBe('Espresso, Sabrina Carpenter');
  });

  it('the right name with the wrong role returns its real role, without pressing', async () => {
    const s = setup(); await s.lookAt();
    const result = await s.press('Fixture Button', { role: 'AXCell' });
    expect(result).toMatchObject({ ok: false, value: { code: 'not_found' } });
    expect(result.error).toContain('AXButton: "Fixture Button"');
    expect(s.presses).toEqual([]);
  });

  it('typing and choosing suggest only boxes and pop-ups respectively, never password labels or values', async () => {
    const s = setup({ elements: [...ELEMENTS,
      { role: 'AXSecureTextField', label: 'Secret password label', value: 'secret value', editable: true, pressable: true },
    ] });
    await s.lookAt();
    const typed = await s.type('hi', { field: 'missing box' });
    expect(typed.error).toContain('AXTextField: "Compose message"');
    expect(typed.error).not.toContain('AXButton:');
    const picked = await s.pick('missing popup', 'Second');
    expect(picked.error).toContain('AXPopUpButton: "First"');
    expect(picked.error).not.toContain('AXTextField:');
    const scrolled = await s.scroll('missing row');
    for (const r of [typed, picked, scrolled]) {
      expect(r).toMatchObject({ ok: false, value: { code: 'not_found' } });
      expect(r.error).not.toContain('Secret password label');
      expect(r.error).not.toContain('secret value');
    }
    expect(s.typings).toEqual([]); expect(s.picks).toEqual([]); expect(s.scrolls).toEqual([]);
  });

  it('suggestions are bounded, unique, copyable for long names, and preserve quoted screen text', async () => {
    const long = 'Result "quoted" '.repeat(50);
    const els: LookElement[] = [
      { role: 'AXButton', label: long, pressable: true },
      { role: 'AXButton', label: long, pressable: true },
      ...Array.from({ length: 10 }, (_, i) => ({ role: 'AXButton', label: `Result ${i}`, pressable: true })),
    ];
    const s = setup({ elements: els }); await s.lookAt();
    const result = await s.press('Result quoted absent');
    const hints = result.error!.split('\n').filter((l) => l.startsWith('AXButton:'));
    expect(hints).toHaveLength(5);
    expect(new Set(hints).size).toBe(5);
    const prefix = JSON.parse(hints[0].slice('AXButton: '.length).replace(' (name prefix)', ''));
    expect(prefix).toBe(long.slice(0, 300));
    expect(result.error!.length).toBeLessThan(2500);
    expect(s.presses).toEqual([]);
    // Shared full names remain ambiguous even when a suggested prefix was copied.
    expect(await s.press(prefix)).toMatchObject({ ok: false, value: { code: 'ambiguous' } });
    expect(s.presses).toEqual([]);
  });

  it('a hint never renews freshness or bypasses a commit card', async () => {
    const s = setup({ answers: [ALLOW_USE, 'Don’t press'] }); await s.lookAt();
    const missing = await s.press('sendd');
    expect(missing.error).toContain('AXButton: "Send"');
    expect(await s.press('Send')).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.pressCards()).toHaveLength(1); expect(s.presses).toEqual([]);
    await s.lookAt(); s.tick(PRESS_FRESH_MS + 1);
    const stale = await s.press('sendd');
    expect(stale).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(stale.error).not.toContain('Closest real names');
  });

  it('a window with no eligible control asks for a new look and makes no action', async () => {
    const s = setup({ elements: [{ role: 'AXStaticText', label: 'No results yet', pressable: false }] });
    await s.lookAt(); const result = await s.press('Missing song');
    expect(result.error).toContain('No named controls for this action were in that read');
    expect(s.presses).toEqual([]);
  });
});

describe('wrong target: refused, nothing done', () => {
  it.each([
    ['a control the look did not show', 'Save', {}, 'not_found'],
    ['the right name with the wrong role', 'Fixture Button', { role: 'AXCheckBox' }, 'not_found'],
    ['a name two controls share', 'OK', {}, 'ambiguous'],
    ['a control with no press of its own', 'presses=0', {}, 'not_permitted'],
  ])('%s', async (_name, control, extra, code) => {
    const s = setup();
    await s.lookAt();
    const result = await s.press(control as string, extra as Record<string, unknown>);
    expect(result).toMatchObject({ ok: false, value: { code } });
    expect(result.error).toContain('Nothing was pressed');
    expect(s.presses).toEqual([]);
    expect(s.asked).toHaveLength(1);
  });

  it('the window changed between the read and the press: the driver finds it no longer exactly once', async () => {
    const s = setup({ outcome: { kind: 'not_pressed', reason: 'changed' } });
    await s.lookAt();
    const result = await s.press();
    expect(result).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(result.error).toContain('Nothing was pressed');
    expect(s.counts()).toMatchObject({ presses: 0, inputCalls: 0 });
  });

  it('a name that differs only in its spaces is the same control (a model sent a no-break space); a different name is not', async () => {
    const s = setup();
    await s.lookAt();
    expect((await s.press(`Fixture${String.fromCharCode(0xa0)}Button`)).ok).toBe(true);
    expect(s.presses[0].target.label).toBe('Fixture Button');
    expect(await s.press('Fixture Buttons')).toMatchObject({ ok: false, value: { code: 'not_found' } });
    expect(s.presses).toHaveLength(1);
  });
});

describe('long names (measured: a WhatsApp community row runs past 200 characters with its last message)', () => {
  const long = `Club community, 2 unread messages from General, ${'a very long preview of the last message '.repeat(6)}`;
  const twin = `${long.slice(0, 150)} but a different ending`;
  it('a long name is found whole, or by its first 120 characters or more — and only if one control starts that way', async () => {
    const els: LookElement[] = [{ role: 'AXButton', label: long, pressable: true }, { role: 'AXButton', label: twin, pressable: true }];
    const s = setup({ elements: els });
    await s.lookAt();
    expect((await s.press(long)).ok).toBe(true);
    expect(s.presses[0].target.label).toBe(long);
    expect((await s.press(long.slice(0, 160))).ok).toBe(true);
    expect(s.presses[1].target.label).toBe(long);
    expect(await s.press(long.slice(0, 140))).toMatchObject({ ok: false, value: { code: 'ambiguous' } });
    await s.lookAt();
    expect(await s.press(long.slice(0, 60))).toMatchObject({ ok: false, value: { code: 'not_found' } });
    expect(s.presses).toHaveLength(2);
  });

  it('a refusal quotes a long name only in part', async () => {
    const s = setup();
    await s.lookAt();
    const result = await s.press(long);
    expect(result).toMatchObject({ ok: false, value: { code: 'not_found' } });
    expect(result.error!.split('\n')[0].length).toBeLessThan(260);
    expect(result.error).not.toContain(long);
  });
});

describe('no-op: the driver said ok and nothing changed', () => {
  it('is reported as a failure, never as a success', async () => {
    const s = setup({ outcome: { kind: 'pressed', title: 'Bimax-Cu Fixture', before: BEFORE, after: BEFORE, elements: ELEMENTS } });
    await s.lookAt();
    const result = await s.press();
    expect(result).toMatchObject({ ok: false, value: { code: 'no_effect' } });
    expect(result.error).toContain('nothing in the window changed');
    expect(s.audit[1].receipt.outcome).toBe('no_effect');
  });
});

describe('stale frame: every step is bound to a fresh read', () => {
  it('no look, no step', async () => {
    const s = setup();
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(await s.type('x')).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(s.asked).toEqual([]);
  });

  it('a read older than the limit is refused', async () => {
    const s = setup();
    await s.lookAt();
    s.tick(PRESS_FRESH_MS + 1);
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(s.presses).toEqual([]);
  });

  it('an unknown outcome is never retried, and the next step needs a new look', async () => {
    const s = setup({ outcome: { kind: 'uncertain', detail: 'timed out' } });
    await s.lookAt();
    const result = await s.press();
    expect(result).toMatchObject({ ok: false, value: { code: 'uncertain' } });
    expect(result.error).toContain('do not press it again');
    expect(s.counts()).toMatchObject({ presses: 0, inputCalls: 1 });
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(s.presses).toHaveLength(1);
  });
});

describe('duplicate effect', () => {
  it('the same request reaching the app twice is carried out once', async () => {
    const s = setup();
    await s.lookAt();
    await s.call('press', 'press', { app: 'BimaxCuFixture', control: 'Fixture Button' }, 77);
    await s.lookAt();
    expect(await s.call('press', 'press', { app: 'BimaxCuFixture', control: 'Fixture Button' }, 77)).toMatchObject({ ok: false, value: { code: 'invalid_args' } });
    expect(await s.call('type', 'type', { app: 'BimaxCuFixture', field: 'Compose message', text: 'x' }, 77)).toMatchObject({ ok: false, value: { code: 'invalid_args' } });
    expect(s.presses).toHaveLength(1);
    expect(s.typings).toEqual([]);
  });
});

describe('switched off: nothing is asked, pressed or typed, though looking still works', () => {
  it('using off', async () => {
    const s = setup({ use: false, answers: ['Allow looking at BimaxCuFixture'] });
    expect((await s.lookAt()).ok).toBe(true);
    const result = await s.press();
    expect(result).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(result.error).toContain('Using other apps is turned off');
    expect(await s.type('x')).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(s.asked).toHaveLength(1);
    expect(s.presses).toEqual([]);
    expect(s.typings).toEqual([]);
  });
});

describe('takeover: a Stop or a switch turned off cancels a step that was allowed but not sent', () => {
  const sendCard = () => setup({ answers: [ALLOW_USE, 'Press “Send”'] });
  it('using switched off while the card waits', async () => {
    const s = sendCard();
    await s.lookAt();
    s.duringAsk(() => s.useOff());
    const result = await s.press('Send');
    expect(result).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(result.error).toContain('cancelled');
    expect(s.presses).toEqual([]);
  });

  it('the Thread stopped while the card waits', async () => {
    const s = sendCard();
    await s.lookAt();
    s.duringAsk(() => { void s.service.end('t1'); });
    expect(await s.press('Send')).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(s.presses).toEqual([]);
  });

  it('stopped after the yes, before the driver is reached', async () => {
    const s = sendCard();
    await s.lookAt();
    s.duringAsk(() => s.beforeDriver(() => { void s.service.end('t1'); }));
    expect(await s.press('Send')).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(s.presses).toEqual([]);
  });

  it('looking switched off while the card waits cancels it too', async () => {
    const s = sendCard();
    await s.lookAt();
    s.duringAsk(() => s.lookOff());
    expect(await s.press('Send')).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(s.presses).toEqual([]);
  });

  it('a Stop ends the grant: after it, the app asks again', async () => {
    const s = setup({ answers: [ALLOW_USE, ALLOW_USE] });
    await s.lookAt();
    await s.service.end('t1');
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'stale' } });
    await s.lookAt();
    expect(s.asked.filter((a) => a.question === 'Let this task use BimaxCuFixture?')).toHaveLength(2);
  });
});

describe('the driver: one use session per app, with click and set_value alone', () => {
  it('USE_TOOLS is exactly click, set_value, scroll — and type_text and press_key for a step in front; never a password field', () => {
    expect([...USE_TOOLS]).toEqual(['click', 'set_value', 'scroll', 'type_text', 'press_key']);
    expect([...PICK_ROLES]).toEqual(['AXPopUpButton']);
    expect([...TYPE_ROLES].sort()).toEqual(['AXComboBox', 'AXSearchField', 'AXTextArea', 'AXTextField']);
    expect(TYPE_ROLES.has('AXSecureTextField')).toBe(false);
  });

  it('a use manifest allows the look tools and USE_TOOLS, and denies every other input tool by name', () => {
    const manifest = useManifest('net.whatsapp.WhatsApp');
    expect(manifest).toContain(`  tools: [${[...LOOK_TOOLS, ...USE_TOOLS].join(', ')}]`);
    const deny = manifest.split('deny:\n')[1];
    for (const tool of INPUT_TOOLS.filter((t) => !(USE_TOOLS as readonly string[]).includes(t))) expect(deny).toContain(tool);
    expect(deny).not.toMatch(/\bclick\b|\bset_value\b|(?<!_)\bscroll\b|\btype_text\b|\bpress_key\b/);
    for (const tool of ['hotkey', 'drag', 'bring_to_front', 'launch_app', 'clipboard_write', 'double_click', 'move_cursor']) expect(deny).toContain(tool);
    expect(() => useManifest('ai.bimax.app')).toThrow('not an app a task may use');
    expect(() => useManifest('com.apple.systempreferences')).toThrow('not an app a task may use');
  });

  it('only named controls inside the window count — never the menu bar; any real press is pressable except menus and boxes', () => {
    const els = windowElements([
      { element_index: 0, role: 'AXMenuBar' },
      { element_index: 1, parent_index: 0, role: 'AXMenuBarItem', label: 'Apple', actions: ['AXPress'] },
      { element_index: 2, parent_index: 1, role: 'AXButton', label: 'Log Out', actions: ['AXPress'] },
      { element_index: 62, role: 'AXWindow', label: 'Bimax-Cu Fixture' },
      { element_index: 63, parent_index: 62, role: 'AXButton', label: 'Fixture Button', value: 'a private preview', actions: ['AXPress'], enabled: true, element_token: 's1:63' },
      { element_index: 64, parent_index: 62, role: 'AXButton', label: 'Disabled', actions: ['AXPress'], enabled: false, element_token: 's1:64' },
      { element_index: 65, parent_index: 62, role: 'AXTextField', label: 'alpha', value: 'alpha', actions: ['AXConfirm'], frame: { x: 219.4, y: 371, w: 300, h: 26 }, element_token: 's1:65' },
      { element_index: 66, parent_index: 62, role: 'AXRow', label: 'Mom', actions: ['AXPress'], element_token: 's1:66' },
      { element_index: 67, parent_index: 62, role: 'AXPopUpButton', label: 'First', actions: ['AXShowMenu', 'AXPress'], element_token: 's1:67' },
      { element_index: 68, parent_index: 62, role: 'AXSecureTextField', label: 'Password', element_token: 's1:68' },
      { element_index: 69, parent_index: 62, role: 'AXSheet', label: 'Delete?' },
      { element_index: 71, parent_index: 62, role: 'AXTextField', label: 'Apple Music', value: 'Apple Music', frame: { x: 600, y: 40, w: 200, h: 22 }, element_token: 's1:71' },
      { element_index: 72, parent_index: 71, role: 'AXButton', label: 'Search', actions: ['AXPress'], element_token: 's1:72' },
      { element_index: 70, parent_index: 69, role: 'AXButton', label: 'Cancel', actions: ['AXPress'], element_token: 's1:70' },
      { element_index: 80, parent_index: 62, role: 'AXButton', actions: ['AXPress'], element_token: 's1:80' },
    ]);
    expect(els.map((e) => [e.role, e.label, e.pressable, e.editable === true, e.inDialog === true])).toEqual([
      ['AXButton', 'Fixture Button', true, false, false],
      ['AXButton', 'Disabled', false, false, false],
      ['AXTextField', 'alpha', false, true, false],
      ['AXRow', 'Mom', true, false, false],
      ['AXPopUpButton', 'First', false, false, false],
      ['AXSecureTextField', 'Password', false, false, false],
      ['AXSheet', 'Delete?', false, false, false],
      ['AXTextField', 'Apple Music', false, true, false],
      ['AXButton', 'Search', true, false, false],
      ['AXButton', 'Cancel', true, false, true],
    ]);
    // A pop-up is picked, with its chosen item as value; a box with a child named Search is a search box.
    expect(els.find((e) => e.label === 'First')).toMatchObject({ pickable: true });
    expect(els.find((e) => e.label === 'Apple Music')).toMatchObject({ searchBox: true });
    expect(els.find((e) => e.label === 'alpha')?.searchBox).toBeUndefined();
    // A button's value is never kept (measured: a chat row's value is its last message).
    expect(els.find((e) => e.label === 'Fixture Button')?.value).toBeUndefined();
    expect(els.find((e) => e.label === 'alpha')).toMatchObject({ value: 'alpha', at: '219,371' });
    expect(els.find((e) => e.label === 'Password')?.value).toBeUndefined();
  });
});

describe('admission into the engine environment', () => {
  const base = { path: '/usr/bin', projectDir: '/tmp/p' };
  const env = (parentEnv: Record<string, string>, extraEnv: Record<string, string>) => buildEngineChildEnv({ ...base, parentEnv, extraEnv });
  it('only the app’s own decision turns using on, never an inherited value, and never without looking', () => {
    expect(env({ BIMAX_COMPUTER_USE: '1', BIMAX_COMPUTER_LOOK: '1' }, {}).BIMAX_COMPUTER_USE).toBeUndefined();
    expect(env({}, { BIMAX_COMPUTER_USE: '1' }).BIMAX_COMPUTER_USE).toBeUndefined();
    expect(env({}, { BIMAX_COMPUTER_USE: '1', BIMAX_COMPUTER_LOOK: '1' }).BIMAX_COMPUTER_USE).toBe('1');
    expect(env({}, { BIMAX_COMPUTER_USE: 'yes', BIMAX_COMPUTER_LOOK: '1' }).BIMAX_COMPUTER_USE).toBeUndefined();
  });

  it('the retired stage 3 variable never reaches an engine, from anywhere', () => {
    expect(env({ BIMAX_COMPUTER_PRESS: '1', BIMAX_COMPUTER_LOOK: '1' }, { BIMAX_COMPUTER_PRESS: '1', BIMAX_COMPUTER_LOOK: '1' }).BIMAX_COMPUTER_PRESS).toBeUndefined();
  });
});

describe('stage 5: which build is running', () => {
  const BUILD_A: ProcessIdentity = { path: '/run/build/BimaxTodo.app/Contents/MacOS/BimaxTodo', sha256: 'a'.repeat(64) };
  const BUILD_B: ProcessIdentity = { path: BUILD_A.path, sha256: 'b'.repeat(64) };

  it('identifies a real process by its executable and that file’s SHA-256', async () => {
    const me = await identifyProcess(process.pid);
    expect(me?.path).toBe(process.execPath);
    expect(me?.sha256).toBe(createHash('sha256').update(readFileSync(process.execPath)).digest('hex'));
    expect(await identifyProcess(-1)).toBeNull();
    expect(await identifyProcess(999_999_999)).toBeNull();
  });

  it('a look names the running build', async () => {
    const s = setup({ identify: async () => BUILD_A });
    expect(text(await s.lookAt())).toContain(`Running build: ${BUILD_A.path} (process 21, executable SHA-256 ${BUILD_A.sha256})`);
  });

  it('a press is bound to the build the read saw, and its receipt names that build', async () => {
    const s = setup({ identify: async () => BUILD_A });
    await s.lookAt();
    const result = await s.press();
    expect(result.ok).toBe(true);
    expect(text(result)).toContain(`the running build with executable SHA-256 ${BUILD_A.sha256}, process 21`);
    expect(s.audit[1].receipt).toMatchObject({ exeSha256: BUILD_A.sha256, pid: 21, outcome: 'pressed' });
  });

  it('wrong build: rebuilt or relaunched after the read — nothing is pressed or typed', async () => {
    let current = BUILD_A;
    const s = setup({ identify: async () => current, answers: [ALLOW_USE, 'Press “Send”'] });
    await s.lookAt();
    s.duringAsk(() => { current = BUILD_B; }); // rebuilt while the card was up
    const result = await s.press('Send');
    expect(result).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(result.error).toContain('rebuilt or relaunched');
    expect(s.presses).toEqual([]);
    await s.lookAt();
    current = BUILD_A;
    expect(await s.type('x')).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(s.typings).toEqual([]);
  });

  it('the app gone since the read — nothing is pressed', async () => {
    let current: ProcessIdentity | null = BUILD_A;
    const s = setup({ identify: async () => current });
    await s.lookAt();
    current = null;
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(s.presses).toEqual([]);
  });
});
