import { ThreadManager } from '../main/thread.manager';
import { engineReducer, initialEngineState, type EngineUiState } from '../renderer/src/engine.state';
import { INPUT_TOOLS, LOOK_TOOLS, NEVER_LOOK, lookManifest, runtimeManifest, validBundleId } from '../main/computer/look.manifest';
import { renderLook } from '../main/computer/look.observation';
import { LookGrants } from '../main/computer/look.grants';
import { createLookService, type LookDriver, type RunningApp } from '../main/computer/look.service';
import { sdkEntry } from '../main/computer/look.driver';
import { buildEngineChildEnv } from '../main/coding.runtime.paths';

/**
 * Computer Use, look only (record 65, stage 2): the app side.
 *
 * The driver enforces a look-only manifest; the app decides who may look at what (a card it raises itself), cuts the
 * menu bar and password values out of what the model reads, and answers the engine's host call on the engine's own
 * channel only.
 */

/** `cua-driver list-tools`, 0.31.0, measured 2026-10-01 (record 65 §6). */
const DRIVER_031_TOOLS = [
  'bring_to_front', 'browser_click', 'browser_dialog', 'browser_download', 'browser_navigate', 'browser_pointer',
  'browser_prepare', 'browser_set_input_files', 'browser_type', 'check_for_update', 'check_permissions', 'click',
  'clipboard_read', 'clipboard_write', 'double_click', 'drag', 'end_session', 'escalate_session', 'get_accessibility_tree',
  'get_agent_cursor_state', 'get_browser_state', 'get_config', 'get_cursor_position', 'get_desktop_state',
  'get_recording_state', 'get_screen_size', 'get_session', 'get_session_state', 'get_window_state', 'health_report',
  'hotkey', 'install_extension', 'install_ffmpeg', 'invoke_menu', 'kill_app', 'launch_app', 'list_apps', 'list_sessions',
  'list_windows', 'move_cursor', 'page', 'parse_visual_regions', 'press_key', 'replay_trajectory', 'right_click', 'scroll',
  'set_agent_cursor_enabled', 'set_agent_cursor_motion', 'set_agent_cursor_theme', 'set_config', 'set_value',
  'set_window_frame', 'start_recording', 'start_session', 'stop_recording', 'type_text', 'verify_state', 'zoom',
];
/** Every 0.31 tool that changes the user's Mac, the driver or what leaves it. */
const CHANGES_SOMETHING = [
  'bring_to_front', 'browser_click', 'browser_dialog', 'browser_download', 'browser_navigate', 'browser_pointer',
  'browser_prepare', 'browser_set_input_files', 'browser_type', 'click', 'clipboard_read', 'clipboard_write', 'double_click',
  'drag', 'hotkey', 'install_extension', 'install_ffmpeg', 'invoke_menu', 'kill_app', 'launch_app', 'move_cursor', 'page',
  'press_key', 'replay_trajectory', 'right_click', 'scroll', 'set_config', 'set_value', 'set_window_frame',
  'start_recording', 'type_text',
];

describe('the look-only manifest', () => {
  const manifest = lookManifest('com.apple.Notes');
  const list = (section: 'allow' | 'deny', text = manifest) =>
    (new RegExp(`^${section}:\\n  tools: \\[([^\\]]*)\\]`, 'm').exec(text)?.[1] ?? '').split(',').map((t) => t.trim()).filter(Boolean);

  it('is version 2, bounded, names one app and lets it be observed only', () => {
    expect(manifest).toMatch(/^version: 2\nmode: bounded\n/);
    expect(manifest).toContain('    - bundle_id: com.apple.Notes\n      windows: all');
    expect(list('allow')).toEqual(['list_apps', 'list_windows', 'get_window_state', 'get_screen_size']);
    expect(list('allow')).not.toContain('get_desktop_state'); // a screenshot of the whole display is not a look at one app
  });

  it('denies, by name, every 0.31 tool that changes something', () => {
    expect(CHANGES_SOMETHING.every((tool) => DRIVER_031_TOOLS.includes(tool))).toBe(true);
    const denied = new Set(list('deny'));
    expect(CHANGES_SOMETHING.filter((tool) => !denied.has(tool))).toEqual([]);
    expect([...INPUT_TOOLS].filter((tool) => (LOOK_TOOLS as readonly string[]).includes(tool))).toEqual([]);
  });

  it('the runtime outside any grant may only list apps', () => {
    expect(list('allow', runtimeManifest())).toEqual(['list_apps']);
    expect(runtimeManifest()).toContain('resources: {}');
  });

  it('a bundle id cannot smuggle YAML in', () => {
    expect(validBundleId('com.apple.Notes')).toBe(true);
    for (const bad of ['', 'x\n    - bundle_id: com.apple.Terminal', 'a b', '"x"', '../x', 'x: y']) {
      expect(validBundleId(bad)).toBe(false);
      expect(() => lookManifest(bad)).toThrow();
    }
  });
});

describe('what of a window reaches the model', () => {
  // Shaped as Cua Driver 0.31's tree_markdown for the fixture app, measured 2026-10-01 (record 65 §6).
  const WINDOW = [
    '- [0] AXWindow "Bimax-Cu Fixture" [id=bimax-cu-fixture-window actions=[raise]]',
    '  - [1] AXButton "Fixture Button" [id=fixture-button actions=[press]]',
    '  - [3] AXTextField = "transaction field" [id=fixture-textfield actions=[showmenu,confirm]]',
    '  - [4] AXSecureTextField = "hunter2-password" [id=pw actions=[confirm]]',
    '  - [6] AXButton [actions=[press]]',
    '  - AXStaticText = "presses=1 events=9 last=select"',
    '- [21] AXMenuBar [actions=[cancel]]',
    '  - [22] AXMenuBarItem "Apple" [actions=[cancel,press,pick]]',
    '    - [23] AXMenu [actions=[cancel]]',
    '      - [28] AXMenuItem "Recent Items" [actions=[cancel,press,pick]]',
    '      - [79] AXMenuItem "Log Out Vish Siddharth…" [id=_logOutRequested: actions=[cancel,press,pick]]',
    '- [90] AXWindow "Second" [actions=[raise]]',
    '  - AXStaticText = "after the menu bar"',
  ].join('\n');

  it('cuts the menu bar out whole: recent items and the account name never reach the model', () => {
    const shown = renderLook(WINDOW);
    expect(shown.menuBarRemoved).toBe(true);
    expect(shown.text).not.toMatch(/Log Out|Vish|Recent Items|AXMenuBar|AXMenuItem/);
    expect(shown.text).toContain('AXWindow "Second"'); // what follows the menu bar is kept
    expect(shown.text).toContain('AXStaticText = "after the menu bar"');
  });

  it('a password field keeps its place and loses its value', () => {
    const shown = renderLook(WINDOW);
    expect(shown.text).not.toContain('hunter2');
    expect(shown.text).toContain('AXSecureTextField = (hidden) (id pw)');
    expect(shown.hiddenSecureFields).toBe(1);
  });

  it('drops the driver bookkeeping and keeps the reading', () => {
    const shown = renderLook(WINDOW);
    expect(shown.text.split('\n').slice(0, 3)).toEqual([
      'AXWindow "Bimax-Cu Fixture" (id bimax-cu-fixture-window)',
      '  AXButton "Fixture Button" (id fixture-button)',
      '  AXTextField = "transaction field" (id fixture-textfield)',
    ]);
    expect(shown.text).not.toMatch(/\[\d+\]|actions=/);
    expect(shown.text).toContain('AXStaticText = "presses=1 events=9 last=select"');
  });

  it('is bounded, and says how much it left out', () => {
    const long = Array.from({ length: 900 }, (_, i) => `  - AXStaticText = "row ${i}"`).join('\n');
    const shown = renderLook(long, { maxLines: 400 });
    expect(shown.lines).toBe(400);
    expect(shown.text.split('\n').pop()).toBe('… 500 more lines not shown');
  });
});

describe('grants', () => {
  it('are per Thread and per app, a "no" is remembered, and ending a Thread drops all of it', () => {
    const g = new LookGrants();
    expect(g.decision('t1', 'com.apple.Notes')).toBe('unasked');
    g.allow('t1', 'com.apple.Notes');
    g.refuse('t1', 'com.apple.Mail');
    expect([g.decision('t1', 'com.apple.Notes'), g.decision('t1', 'com.apple.Mail'), g.decision('t2', 'com.apple.Notes')])
      .toEqual(['allowed', 'refused', 'unasked']);
    expect(g.end('t1')).toEqual(['com.apple.Notes']);
    expect(g.decision('t1', 'com.apple.Notes')).toBe('unasked');
  });
});

describe('the look service', () => {
  const NOTES: RunningApp = { name: 'Notes', bundleId: 'com.apple.Notes', pid: 11 };
  const BIMAX: RunningApp = { name: 'Bimax', bundleId: 'ai.bimax.app', pid: 12 };

  function setup(opts: { enabled?: boolean; answer?: string; lookError?: Error } = {}) {
    const asked: Array<{ question: string; options: string[] }> = [];
    const looks: Array<{ threadId: string; app: string; query?: string }> = [];
    const ended: string[] = [];
    const driver: LookDriver = {
      runningApps: async () => [NOTES, BIMAX],
      look: async (threadId, app, query) => {
        if (opts.lookError) throw opts.lookError;
        looks.push({ threadId, app: app.bundleId, query });
        return { title: 'Groceries', markdown: '- [0] AXWindow "Groceries"\n  - [1] AXTextArea = "eggs, milk"\n- [5] AXMenuBar\n  - [6] AXMenuItem "Log Out Someone…"' };
      },
      end: async (threadId) => { ended.push(threadId); },
    };
    let enabled = opts.enabled ?? true;
    const audit: any[] = [];
    const service = createLookService({
      enabled: () => enabled,
      driver: async () => driver,
      ask: async (_t, question, options) => { asked.push({ question, options }); return opts.answer ?? options[0]; },
      audit: (entry) => audit.push(entry),
    });
    let id = 0;
    const call = (op: string, args: Record<string, unknown> = {}) =>
      service.handle('t1', { t: 'host_call', id: ++id, capability: 'look', op, args } as any);
    return { service, call, asked, looks, ended, audit, off: () => { enabled = false; } };
  }

  it('does nothing while looking is turned off', async () => {
    const s = setup({ enabled: false });
    const result = await s.call('look', { app: 'Notes' });
    expect(result).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(result.error).toContain('Let Tasks Look at Other Apps');
    expect(s.asked).toEqual([]);
  });

  it('lists open apps, never Bimax itself', async () => {
    const result = await setup().call('list_apps');
    expect(result).toMatchObject({ ok: true, value: { text: 'Notes (com.apple.Notes)' } });
  });

  it('asks the person first, on a card with exactly two choices, then reads the window without the menu bar', async () => {
    const s = setup();
    const result = await s.call('look', { app: 'notes', query: 'eggs' });
    expect(s.asked).toEqual([{ question: 'Let this task look at Notes?', options: ['Allow looking at Notes', 'Not now'] }]);
    expect(s.looks).toEqual([{ threadId: 't1', app: 'com.apple.Notes', query: 'eggs' }]);
    expect(result.ok).toBe(true);
    const text = String((result.value as any).text);
    expect(text.split('\n')[0]).toBe('Notes — window “Groceries” (read only, lines matching “eggs”):');
    expect(text).toContain('AXTextArea = "eggs, milk"');
    expect(text).not.toContain('Log Out');
    // Allowed once, for this Thread: the next look does not ask again.
    await s.call('look', { app: 'Notes' });
    expect(s.asked).toHaveLength(1);
    expect(s.service.counts('t1')).toEqual({ lists: 0, looks: 2, refused: 0, asked: 1, inputCalls: 0 });
  });

  it('"Not now" is remembered: the task is told no again, the person is not asked again', async () => {
    const s = setup({ answer: 'Not now' });
    expect(await s.call('look', { app: 'Notes' })).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(await s.call('look', { app: 'Notes' })).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.asked).toHaveLength(1);
    expect(s.looks).toEqual([]);
  });

  it('no answer (the Thread stopped while the card was up) is never a yes', async () => {
    const s = setup({ answer: '' });
    expect(await s.call('look', { app: 'Notes' })).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.looks).toEqual([]);
  });

  it('never looks at Bimax itself, whatever is asked, and does not even ask', async () => {
    const s = setup();
    expect(await s.call('look', { app: 'Bimax' })).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(await s.call('look', { app: 'ai.bimax.app' })).toMatchObject({ ok: false, value: { code: 'denied' } });
    expect(s.asked).toEqual([]);
    expect(NEVER_LOOK.has('com.apple.SecurityAgent')).toBe(true);
  });

  it('has no other operation: anything but list_apps and look is refused', async () => {
    const s = setup();
    for (const op of ['click', 'type_text', 'set_value', 'press_key']) {
      expect(await s.call(op, { app: 'Notes' })).toMatchObject({ ok: false, value: { code: 'invalid_args' } });
    }
    expect(s.looks).toEqual([]);
    expect(s.service.counts('t1')?.inputCalls).toBe(0);
  });

  it('an app that is not open is not_found; a missing permission says where to grant it', async () => {
    expect(await setup().call('look', { app: 'Mail' })).toMatchObject({ ok: false, value: { code: 'not_found' } });
    const s = setup({ lookError: new Error('process is not trusted for accessibility') });
    const result = await s.call('look', { app: 'Notes' });
    expect(result).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(result.error).toContain('Privacy & Security → Accessibility');
  });

  it('turning it off stops the next look at once, even with a grant', async () => {
    const s = setup();
    await s.call('look', { app: 'Notes' });
    s.off();
    expect(await s.call('look', { app: 'Notes' })).toMatchObject({ ok: false, value: { code: 'not_permitted' } });
    expect(s.looks).toHaveLength(1);
  });

  it('the audit log keeps who asked what of which app and the answer — never the window', async () => {
    const s = setup();
    await s.call('look', { app: 'Notes', query: 'eggs' });
    await s.call('look', { app: 'Bimax' });
    await s.call('click', { app: 'Notes' });
    expect(s.audit.map((e) => [e.op, e.bundleId ?? null, e.ok, e.code ?? null])).toEqual([
      ['look', 'com.apple.Notes', true, null],
      ['look', 'ai.bimax.app', false, 'denied'],
      ['click', null, false, 'invalid_args'],
    ]);
    const logged = JSON.stringify(s.audit);
    expect(logged).not.toMatch(/eggs|milk|Groceries|Log Out/);
    expect(s.audit[2].counts).toEqual({ lists: 0, looks: 1, refused: 2, asked: 1, inputCalls: 0 });
  });

  it('ending a Thread ends its sessions, and a Thread that never looked does not start the driver', async () => {
    const s = setup();
    await s.service.end('t1');
    expect(s.ended).toEqual([]);
    await s.call('look', { app: 'Notes' });
    await s.service.end('t1');
    expect(s.ended).toEqual(['t1']);
    expect(s.service.grants.decision('t1', 'com.apple.Notes')).toBe('unasked');
  });
});

describe('the Thread manager carries host calls and its own cards', () => {
  type View = { state: EngineUiState };

  function fixture(hostCall?: (id: string, msg: any) => Promise<any>) {
    const approvals: any[] = [];
    const shown: any[] = [];
    const ended: string[] = [];
    const views = new Map<string, View>();
    const engine = { openProject: jest.fn(), sendFromRenderer: jest.fn(), dispose: jest.fn() };
    const threads = new ThreadManager({
      engine: () => engine, changed: jest.fn(), selected: jest.fn(), save: jest.fn(),
      approval: (value) => approvals.push(value),
      timer: () => () => {},
      hostCall, ended: (id) => ended.push(id),
      message: (id, msg) => {
        shown.push(msg);
        const view = views.get(id) ?? { state: { ...initialEngineState, threadId: id } };
        view.state = engineReducer(view.state, { type: 'outbound', msg });
        views.set(id, view);
      },
    });
    const id = threads.create('/fixture/look');
    threads.start(id);
    threads.receive(id, { t: 'ready', protocol: 3 } as any);
    return { threads, id, engine, approvals, shown, ended, card: () => views.get(id)?.state.request ?? null };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('a host_call goes to the app, its answer back to that engine, and no window ever sees either', async () => {
    const f = fixture(async () => ({ t: 'host_result', id: 999, ok: true, value: { text: 'Notes' } }));
    f.threads.receive(f.id, { t: 'host_call', id: 41, capability: 'look', op: 'list_apps', args: {} } as any);
    await settle();
    expect(f.shown.filter((m) => m.t === 'host_call' || m.t === 'host_result')).toEqual([]);
    // The id is the call's own, whatever the app put in its result.
    expect(f.engine.sendFromRenderer).toHaveBeenCalledWith({ t: 'host_result', id: 41, ok: true, value: { text: 'Notes' } });
  });

  it('with no app capability every host call is answered "not available", never left hanging', () => {
    const f = fixture();
    f.threads.receive(f.id, { t: 'host_call', id: 42, capability: 'look', op: 'look', args: { app: 'Notes' } } as any);
    expect(f.engine.sendFromRenderer).toHaveBeenCalledWith(expect.objectContaining({ t: 'host_result', id: 42, ok: false, value: { code: 'unavailable' } }));
  });

  it('a card the app raises is answered by the app with its token — never forwarded to the engine', async () => {
    const f = fixture();
    const answer = f.threads.askOnBehalf(f.id, 'Let this task look at Notes?', ['Allow looking at Notes', 'Not now'], 'read only');
    expect(f.card()).toMatchObject({ question: 'Let this task look at Notes?', options: ['Allow looking at Notes', 'Not now'] });
    const cardId = f.approvals[0].request.id;
    expect(cardId).toBeLessThanOrEqual(-100);
    expect(() => f.threads.send(f.id, { t: 'reply', id: cardId, value: 'Allow looking at Notes', approvalToken: 'forged' })).toThrow('expired');
    expect(() => f.threads.send(f.id, { t: 'reply', id: cardId, value: 'Yes', approvalToken: f.approvals[0].token })).toThrow('Invalid approval choice');
    f.threads.send(f.id, { t: 'reply', id: cardId, value: 'Allow looking at Notes', approvalToken: f.approvals[0].token });
    await expect(answer).resolves.toBe('Allow looking at Notes');
    expect(f.engine.sendFromRenderer).not.toHaveBeenCalledWith(expect.objectContaining({ t: 'reply', id: cardId }));
    expect(f.card()).toBeNull();
  });

  it('stopping the Thread answers its open card "no" and ends what it was granted', async () => {
    const f = fixture();
    const answer = f.threads.askOnBehalf(f.id, 'Let this task look at Notes?', ['Allow looking at Notes', 'Not now']);
    f.threads.stop(f.id);
    await expect(answer).resolves.toBe('');
    expect(f.ended).toEqual([f.id]);
  });

  it('an interrupt answers it "no" too', async () => {
    const f = fixture();
    const answer = f.threads.askOnBehalf(f.id, 'Let this task look at Notes?', ['Allow looking at Notes', 'Not now']);
    f.threads.send(f.id, { t: 'interrupt' });
    await expect(answer).resolves.toBe('');
  });
});

describe('admission into the engine environment', () => {
  const base = { path: '/usr/bin', projectDir: '/tmp/p' };
  it('only the app’s own decision for an engine turns looking on, never an inherited variable', () => {
    expect(buildEngineChildEnv({ ...base, parentEnv: { BIMAX_COMPUTER_LOOK: '1' }, extraEnv: {} }).BIMAX_COMPUTER_LOOK).toBeUndefined();
    expect(buildEngineChildEnv({ ...base, parentEnv: {}, extraEnv: { BIMAX_COMPUTER_LOOK: '1' } }).BIMAX_COMPUTER_LOOK).toBe('1');
    expect(buildEngineChildEnv({ ...base, parentEnv: {}, extraEnv: { BIMAX_COMPUTER_LOOK: 'yes' } }).BIMAX_COMPUTER_LOOK).toBeUndefined();
  });

  it('the SDK is imported by a real file path, from outside the archive when packaged', () => {
    expect(sdkEntry({ packaged: true, resourcesPath: '/Applications/Bimax.app/Contents/Resources', appPath: '/x' }))
      .toBe('file:///Applications/Bimax.app/Contents/Resources/app.asar.unpacked/node_modules/@trycua/cua-driver/dist/index.js');
    expect(sdkEntry({ packaged: false, resourcesPath: '/r', appPath: '/dev/app' }))
      .toBe('file:///dev/app/node_modules/@trycua/cua-driver/dist/index.js');
  });
});
