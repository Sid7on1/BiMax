import { INPUT_TOOLS, LOOK_TOOLS, PRESS_APPS, PRESS_ROLES, PRESS_TOOLS, pressManifest } from '../main/computer/look.manifest';
import { createLookService, PRESS_FRESH_MS, type LookDriver, type LookElement, type PressOutcome, type PressTarget, type RunningApp } from '../main/computer/look.service';
import { windowElements } from '../main/computer/look.driver';
import { buildEngineChildEnv } from '../main/coding.runtime.paths';
import { identifyProcess, type ProcessIdentity } from '../main/computer/look.identity';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Record 65 stage 3 — one press at a time, in the test app only. Each failure mode the plan names has its own test, and
 * each must leave the driver's press untouched (no input) unless the press is genuinely allowed: wrong target, no-op,
 * stale frame, duplicate effect, approval skipped — plus a Stop (takeover) between the person's Allow and the click.
 */

const FIXTURE: RunningApp = { name: 'BimaxCuFixture', bundleId: 'ai.bimax.cu.fixture', pid: 21 };
const NOTES: RunningApp = { name: 'Notes', bundleId: 'com.apple.Notes', pid: 22 };
const WINDOW = 1228;
const BEFORE = '- [62] AXWindow "Bimax-Cu Fixture"\n  - [63] AXButton "Fixture Button"\n  - [90] AXStaticText = "presses=0 events=0 last=none"';
const AFTER = '- [62] AXWindow "Bimax-Cu Fixture"\n  - [63] AXButton "Fixture Button"\n  - [90] AXStaticText = "presses=1 events=1 last=button"';
const ELEMENTS: LookElement[] = [
  { role: 'AXButton', label: 'Fixture Button', pressable: true },
  { role: 'AXCheckBox', label: 'Fixture Checkbox', pressable: true },
  { role: 'AXTextField', label: 'alpha beta gamma', pressable: false },
  { role: 'AXButton', label: 'OK', pressable: true },
  { role: 'AXButton', label: 'OK', pressable: true },
];

function setup(opts: { look?: boolean; press?: boolean; answers?: string[]; outcome?: PressOutcome | (() => PressOutcome); elements?: LookElement[]; identify?: (pid: number) => Promise<ProcessIdentity | null> } = {}) {
  let look = opts.look ?? true;
  let pressOn = opts.press ?? true;
  let clock = 1_000_000;
  const answers = [...(opts.answers ?? ['Allow looking at BimaxCuFixture', 'Press “Fixture Button”'])];
  const asked: Array<{ question: string; options: string[] }> = [];
  const presses: Array<{ threadId: string; app: string; target: PressTarget }> = [];
  const audit: any[] = [];
  let beforeDriver: (() => void) | null = null;
  let duringAsk: (() => void) | null = null;
  const driver: LookDriver = {
    runningApps: async () => [FIXTURE, NOTES],
    look: async (_t, app) => ({ title: app === FIXTURE ? 'Bimax-Cu Fixture' : 'Groceries', markdown: BEFORE, windowId: WINDOW, elements: opts.elements ?? ELEMENTS }),
    press: async (threadId, app, target) => {
      presses.push({ threadId, app: app.bundleId, target });
      const o = opts.outcome ?? { kind: 'pressed', title: 'Bimax-Cu Fixture', before: BEFORE, after: AFTER };
      return typeof o === 'function' ? o() : o;
    },
    end: async () => {},
  };
  const service = createLookService({
    enabled: () => look,
    pressEnabled: () => look && pressOn,
    now: () => clock,
    ...(opts.identify ? { identify: opts.identify } : {}),
    driver: async () => { const hook = beforeDriver; beforeDriver = null; hook?.(); return driver; },
    ask: async (_t, question, options) => {
      asked.push({ question, options });
      const hook = duringAsk; duringAsk = null; hook?.();
      return answers.shift() ?? '';
    },
    audit: (entry) => audit.push(entry),
  });
  let id = 0;
  const call = (capability: 'look' | 'press', op: string, args: Record<string, unknown>, callId = ++id) =>
    service.handle('t1', { t: 'host_call', id: callId, capability, op, args } as any);
  const lookAt = (app = 'BimaxCuFixture') => call('look', 'look', { app });
  const press = (control = 'Fixture Button', extra: Record<string, unknown> = {}) => call('press', 'press', { app: 'BimaxCuFixture', control, ...extra });
  return {
    service, call, lookAt, press, asked, presses, audit,
    tick: (ms: number) => { clock += ms; },
    lookOff: () => { look = false; }, pressOff: () => { pressOn = false; },
    beforeDriver: (hook: () => void) => { beforeDriver = hook; },
    duringAsk: (hook: () => void) => { duringAsk = hook; },
    counts: () => service.counts('t1'),
  };
}

describe('a press that is allowed', () => {
  it('asks on the app’s own card, presses the one control once, and reports what changed', async () => {
    const s = setup();
    expect((await s.lookAt()).ok).toBe(true);
    const result = await s.press('Fixture Button', { role: 'AXButton' });
    expect(s.asked[1]).toEqual({ question: 'Press “Fixture Button” in BimaxCuFixture?', options: ['Press “Fixture Button”', 'Don’t press'] });
    expect(s.presses).toEqual([{ threadId: 't1', app: 'ai.bimax.cu.fixture', target: { windowId: WINDOW, role: 'AXButton', label: 'Fixture Button' } }]);
    expect(result.ok).toBe(true);
    const text = String((result.value as any).text);
    expect(text).toContain('Pressed “Fixture Button” in BimaxCuFixture');
    expect(text).toContain('- AXStaticText = "presses=0 events=0 last=none"');
    expect(text).toContain('+ AXStaticText = "presses=1 events=1 last=button"');
    expect(s.counts()).toMatchObject({ looks: 1, asked: 2, presses: 1, inputCalls: 1 });
    // The audit keeps a content-free receipt: the name only as a hash.
    const receipt = s.audit[1].receipt;
    expect(receipt).toMatchObject({ role: 'AXButton', windowId: WINDOW, outcome: 'pressed' });
    expect(JSON.stringify(s.audit[1])).not.toContain('Fixture Button');
  });
});

describe('wrong target: refused, nothing pressed', () => {
  it.each([
    ['a control the look did not show', 'Save', {}, 'not_found'],
    ['the right name with the wrong role', 'Fixture Button', { role: 'AXCheckBox' }, 'not_found'],
    ['a name two controls share', 'OK', {}, 'ambiguous'],
    ['a control that is not a button, checkbox or radio button', 'alpha beta gamma', {}, 'not_permitted'],
  ])('%s', async (_name, control, extra, code) => {
    const s = setup();
    await s.lookAt();
    const result = await s.press(control as string, extra as Record<string, unknown>);
    expect(result).toMatchObject({ ok: false, value: { code } });
    expect(result.error).toContain('Nothing was pressed');
    expect(s.presses).toEqual([]);
    expect(s.asked).toHaveLength(1); // the look's card only: no press card for a refused target
  });

  it('an app other than the test app, even one the task may look at — though the person would allow it', async () => {
    const s = setup({ answers: ['Allow looking at Notes', 'Press “Fixture Button”'] });
    await s.lookAt('Notes');
    const result = await s.call('press', 'press', { app: 'Notes', control: 'Fixture Button' });
    expect(result).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(s.presses).toEqual([]);
  });

  it('the window changed between the look and the press: the driver finds it no longer exactly once', async () => {
    const s = setup({ outcome: { kind: 'not_pressed', reason: 'changed' } });
    await s.lookAt();
    const result = await s.press();
    expect(result).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(result.error).toContain('Nothing was pressed');
    expect(s.counts()).toMatchObject({ presses: 0, inputCalls: 0 });
  });
});

describe('names', () => {
  it('a name that differs only in its spaces is the same control (a model sent a no-break space)', async () => {
    const s = setup();
    await s.lookAt();
    expect((await s.press('Fixture\u00a0Button')).ok).toBe(true);
    expect(s.presses[0].target.label).toBe('Fixture Button');
  });

  it('but a different name is not', async () => {
    const s = setup();
    await s.lookAt();
    expect(await s.press('Fixture Buttons')).toMatchObject({ ok: false, value: { code: 'not_found' } });
    expect(s.presses).toEqual([]);
  });
});

describe('no-op: the driver said ok and nothing changed', () => {
  it('is reported as a failure, never as a success', async () => {
    const s = setup({ outcome: { kind: 'pressed', title: 'Bimax-Cu Fixture', before: BEFORE, after: BEFORE } });
    await s.lookAt();
    const result = await s.press();
    expect(result).toMatchObject({ ok: false, value: { code: 'no_effect' } });
    expect(result.error).toContain('nothing in the window changed');
    expect(s.audit[1].receipt.outcome).toBe('no_effect');
  });
});

describe('stale frame: a press is bound to a fresh look', () => {
  it('no look, no press', async () => {
    const s = setup();
    const result = await s.press();
    expect(result).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(s.asked).toEqual([]);
  });

  it('a look older than the limit is refused', async () => {
    const s = setup();
    await s.lookAt();
    s.tick(PRESS_FRESH_MS + 1);
    const result = await s.press();
    expect(result).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(s.presses).toEqual([]);
  });

  it('one look allows one press: the second needs a new look', async () => {
    const s = setup({ answers: ['Allow looking at BimaxCuFixture', 'Press “Fixture Button”', 'Press “Fixture Button”'] });
    await s.lookAt();
    expect((await s.press()).ok).toBe(true);
    const again = await s.press();
    expect(again).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(s.presses).toHaveLength(1);
    await s.lookAt();
    expect((await s.press()).ok).toBe(true);
    expect(s.presses).toHaveLength(2);
  });
});

describe('duplicate effect', () => {
  it('the same request reaching the app twice is carried out once', async () => {
    const s = setup({ answers: ['Allow looking at BimaxCuFixture', 'Press “Fixture Button”', 'Press “Fixture Button”'] });
    await s.lookAt();
    await s.call('press', 'press', { app: 'BimaxCuFixture', control: 'Fixture Button' }, 77);
    await s.lookAt();
    const replay = await s.call('press', 'press', { app: 'BimaxCuFixture', control: 'Fixture Button' }, 77);
    expect(replay).toMatchObject({ ok: false, value: { code: 'invalid_args' } });
    expect(s.presses).toHaveLength(1);
  });

  it('an unknown outcome is never retried, and the next press needs a new look', async () => {
    const s = setup({ outcome: { kind: 'uncertain', detail: 'timed out' } });
    await s.lookAt();
    const result = await s.press();
    expect(result).toMatchObject({ ok: false, value: { code: 'uncertain' } });
    expect(result.error).toContain('do not press it again');
    expect(s.presses).toHaveLength(1);
    expect(s.counts()).toMatchObject({ presses: 0, inputCalls: 1 });
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(s.presses).toHaveLength(1);
  });
});

describe('approval skipped: no press without the person’s answer on the app’s card', () => {
  it('“Don’t press” presses nothing', async () => {
    const s = setup({ answers: ['Allow looking at BimaxCuFixture', 'Don’t press'] });
    await s.lookAt();
    const result = await s.press();
    expect(result).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.presses).toEqual([]);
  });

  it('a card closed without an answer presses nothing', async () => {
    const s = setup({ answers: ['Allow looking at BimaxCuFixture', ''] });
    await s.lookAt();
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.presses).toEqual([]);
  });

  it('every press asks — an earlier Allow covers nothing later', async () => {
    const s = setup({ answers: ['Allow looking at BimaxCuFixture', 'Press “Fixture Button”', 'Don’t press'] });
    await s.lookAt();
    await s.press();
    await s.lookAt();
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.asked.filter((a) => a.question.startsWith('Press'))).toHaveLength(2);
    expect(s.presses).toHaveLength(1);
  });

  it('with pressing switched off nothing is asked or pressed, though looking still works', async () => {
    const s = setup({ press: false });
    expect((await s.lookAt()).ok).toBe(true);
    const result = await s.press();
    expect(result).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(result.error).toContain('Pressing in other apps is turned off');
    expect(s.asked).toHaveLength(1);
    expect(s.presses).toEqual([]);
  });
});

describe('takeover: a Stop or a switch turned off cancels a press that was allowed but not sent', () => {
  it('pressing switched off while the card waits', async () => {
    const s = setup();
    await s.lookAt();
    s.duringAsk(() => s.pressOff());
    const result = await s.press();
    expect(result).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(result.error).toContain('cancelled');
    expect(s.presses).toEqual([]);
  });

  it('the Thread stopped while the card waits', async () => {
    const s = setup();
    await s.lookAt();
    s.duringAsk(() => { void s.service.end('t1'); });
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(s.presses).toEqual([]);
  });

  it('stopped after the Allow, before the driver is reached', async () => {
    const s = setup();
    await s.lookAt();
    // Armed while the card is up, so it fires on the driver request that follows the Allow (not the app lookup before).
    s.duringAsk(() => s.beforeDriver(() => { void s.service.end('t1'); }));
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(s.presses).toEqual([]);
  });

  it('looking switched off while the card waits cancels it too', async () => {
    const s = setup();
    await s.lookAt();
    s.duringAsk(() => s.lookOff());
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(s.presses).toEqual([]);
  });
});

describe('the driver may press in the test app only, with click alone', () => {
  it('PRESS_APPS is exactly Bimax’s two test apps; roles are plain controls', () => {
    expect([...PRESS_APPS]).toEqual(['ai.bimax.cu.fixture', 'ai.bimax.cu.x01-todo']);
    expect([...PRESS_ROLES].sort()).toEqual(['AXButton', 'AXCheckBox', 'AXRadioButton']);
    expect([...PRESS_TOOLS]).toEqual(['click']);
  });

  it('a press manifest allows the look tools and click, and denies every other input tool by name', () => {
    const text = pressManifest('ai.bimax.cu.fixture');
    expect(text).toContain(`  tools: [${[...LOOK_TOOLS, 'click'].join(', ')}]`);
    const deny = text.split('deny:\n')[1];
    for (const tool of INPUT_TOOLS.filter((t) => t !== 'click')) expect(deny).toContain(tool);
    expect(deny).not.toMatch(/\bclick\b/);
    expect(() => pressManifest('com.apple.Notes')).toThrow('not an app a task may press in');
  });

  it('only named controls inside the window count — never the menu bar — and only real presses are pressable', () => {
    const els = windowElements([
      { element_index: 0, role: 'AXMenuBar' },
      { element_index: 1, parent_index: 0, role: 'AXMenuBarItem', label: 'Apple', actions: ['AXPress'] },
      { element_index: 2, parent_index: 1, role: 'AXButton', label: 'Log Out', actions: ['AXPress'] },
      { element_index: 62, role: 'AXWindow', label: 'Bimax-Cu Fixture' },
      { element_index: 63, parent_index: 62, role: 'AXButton', label: 'Fixture Button', actions: ['AXPress'], enabled: true, element_token: 's1:63' },
      { element_index: 64, parent_index: 62, role: 'AXButton', label: 'Disabled', actions: ['AXPress'], enabled: false, element_token: 's1:64' },
      { element_index: 65, parent_index: 62, role: 'AXTextField', label: 'alpha', actions: ['AXConfirm'], element_token: 's1:65' },
      { element_index: 80, parent_index: 62, role: 'AXButton', actions: ['AXPress'], element_token: 's1:80' },
    ]);
    expect(els.map((e) => [e.role, e.label, e.pressable])).toEqual([
      ['AXButton', 'Fixture Button', true],
      ['AXButton', 'Disabled', false],
      ['AXTextField', 'alpha', false],
    ]);
  });
});

describe('admission into the engine environment', () => {
  const base = { path: '/usr/bin', projectDir: '/tmp/p' };
  it('only the app’s own decision turns pressing on, never an inherited value, and never without looking', () => {
    const env = (parentEnv: Record<string, string>, extraEnv: Record<string, string>) => buildEngineChildEnv({ ...base, parentEnv, extraEnv }).BIMAX_COMPUTER_PRESS;
    expect(env({ BIMAX_COMPUTER_PRESS: '1', BIMAX_COMPUTER_LOOK: '1' }, {})).toBeUndefined();
    expect(env({}, { BIMAX_COMPUTER_PRESS: '1' })).toBeUndefined();
    expect(env({}, { BIMAX_COMPUTER_PRESS: '1', BIMAX_COMPUTER_LOOK: '1' })).toBe('1');
    expect(env({}, { BIMAX_COMPUTER_PRESS: 'yes', BIMAX_COMPUTER_LOOK: '1' })).toBeUndefined();
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
    const result = await s.lookAt();
    expect(String((result.value as any).text)).toContain(`Running build: ${BUILD_A.path} (process 21, executable SHA-256 ${BUILD_A.sha256})`);
  });

  it('a press is bound to the build the look saw, and its receipt names that build', async () => {
    const s = setup({ identify: async () => BUILD_A });
    await s.lookAt();
    const result = await s.press();
    expect(result.ok).toBe(true);
    expect(String((result.value as any).text)).toContain(`the running build with executable SHA-256 ${BUILD_A.sha256}, process 21`);
    expect(s.audit[1].receipt).toMatchObject({ exeSha256: BUILD_A.sha256, pid: 21, outcome: 'pressed' });
  });

  it('wrong build: rebuilt or relaunched after the look — nothing is pressed', async () => {
    let current = BUILD_A;
    const s = setup({ identify: async () => current });
    await s.lookAt();
    s.duringAsk(() => { current = BUILD_B; }); // rebuilt while the card was up
    const result = await s.press();
    expect(result).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(result.error).toContain('rebuilt or relaunched');
    expect(s.presses).toEqual([]);
  });

  it('the app gone since the look — nothing is pressed', async () => {
    let current: ProcessIdentity | null = BUILD_A;
    const s = setup({ identify: async () => current });
    await s.lookAt();
    current = null;
    expect(await s.press()).toMatchObject({ ok: false, value: { code: 'stale' } });
    expect(s.presses).toEqual([]);
  });
});
