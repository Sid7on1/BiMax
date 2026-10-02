import { EventEmitter } from 'events';
import fs from 'node:fs';
import path from 'node:path';
import { ProtocolHost, HostCallResult } from '../protocol/host';
import { Outbound, HOST_CALL_EVENT } from '../protocol/protocol';
import { engineEvents } from '../engine/events';
import { createPressTool } from '../tools/implementations/press.tool';
import { createTypeTool } from '../tools/implementations/type.tool';
import { createScrollTool } from '../tools/implementations/scroll.tool';
import { fenceUntrusted, untrustedChannel } from '../mind/taint';
import { GovernorVetoError } from '../core/errors';
import { checkToolArgs } from '../tools/args.validate';

/**
 * Record 65 stages 3 and 6: the engine asks its app to press one control, or type into one box, in another app's
 * window, and only asks.
 *
 * The request is a `host_call` of capability `press` or `type`; the tool runs only after the governor's computer-control
 * floors (buildTool → COMPUTER_CONTROL); the app decides whether the person must see the step first (§6h); everything
 * the app says back is screen text.
 */
describe('PressInAppTool', () => {
  let approvals: Array<{ taskType: string; payload: any }>;
  let refuse: boolean;
  const governor = {
    approveTaskExecution: async (taskType: string, payload: any) => {
      approvals.push({ taskType, payload });
      if (refuse) throw new GovernorVetoError('Action declined. No permission was granted.');
    },
  } as any;
  let calls: Array<{ capability: string; op: string; args: any }>;
  let answer: HostCallResult;
  const listener = (capability: string, op: string, args: any, resolve: (r: HostCallResult) => void) => {
    calls.push({ capability, op, args });
    resolve(answer);
  };

  beforeEach(() => { approvals = []; calls = []; refuse = false; answer = { ok: true, value: { text: 'Pressed “Save”. The window changed.' } }; engineEvents.on(HOST_CALL_EVENT, listener); });
  afterEach(() => { engineEvents.off(HOST_CALL_EVENT, listener); });

  const run = (args: Record<string, unknown>) => (createPressTool(governor) as any).execute(args, { cwd: process.cwd() });

  it('names one app and one control; it is destructive and has no coordinates, keys or text', () => {
    const tool = createPressTool(governor) as any;
    expect(Object.keys(tool.schema.properties).sort()).toEqual(['app', 'control', 'option', 'role']);
    expect(tool.schema.required).toEqual(['app', 'control']);
    expect(tool.isDestructive).toBe(true);
  });

  it('meets the governor as computer control, then asks the app with capability press', async () => {
    const out = await run({ app: 'BimaxCuFixture', control: 'Fixture Button', role: 'AXButton' });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ taskType: 'COMPUTER_CONTROL', payload: { tool: 'PressInAppTool', app: 'BimaxCuFixture', control: 'Fixture Button' } });
    expect(calls).toEqual([{ capability: 'press', op: 'press', args: { app: 'BimaxCuFixture', control: 'Fixture Button', role: 'AXButton' } }]);
    expect(out).toBe('Pressed “Save”. The window changed.');
  });

  it('a refusal at the governor asks the app nothing', async () => {
    refuse = true;
    // A veto propagates to the agent loop, which reports it to the model; nothing reaches the app.
    await expect(run({ app: 'BimaxCuFixture', control: 'Fixture Button' })).rejects.toThrow('Action declined');
    expect(calls).toEqual([]);
  });

  it('a blank app or control fails argument validation, which runs before the governor, so no card asks about it', () => {
    const tool = createPressTool(governor) as any;
    expect(checkToolArgs(tool.schema, { app: 'BimaxCuFixture', control: '  ' }).violations).not.toEqual([]);
    expect(checkToolArgs(tool.schema, { app: ' ', control: 'Save' }).violations).not.toEqual([]);
    expect(checkToolArgs(tool.schema, { app: 'BimaxCuFixture', control: 'Fixture Button' }).violations).toEqual([]);
  });

  it('the app saying nothing changed reaches the model as a failure, never as success', async () => {
    answer = { ok: false, error: 'Pressed, but nothing in the window changed.', value: { code: 'no_effect' } };
    const out = await run({ app: 'BimaxCuFixture', control: 'Fixture Button' });
    expect(String(out)).toContain('nothing in the window changed');
  });
});

describe('TypeInAppTool', () => {
  let approvals: Array<{ taskType: string; payload: any }>;
  const governor = { approveTaskExecution: async (taskType: string, payload: any) => { approvals.push({ taskType, payload }); } } as any;
  let calls: Array<{ capability: string; op: string; args: any }>;
  const listener = (capability: string, op: string, args: any, resolve: (r: HostCallResult) => void) => {
    calls.push({ capability, op, args });
    resolve({ ok: true, value: { text: 'Typed into “Compose message”. The box now reads exactly: “hi”.' } });
  };
  beforeEach(() => { approvals = []; calls = []; engineEvents.on(HOST_CALL_EVENT, listener); });
  afterEach(() => { engineEvents.off(HOST_CALL_EVENT, listener); });
  const run = (args: Record<string, unknown>) => (createTypeTool(governor) as any).execute(args, { cwd: process.cwd() });

  it('names one app, optionally one box, and one text; destructive; no keys, coordinates or Return', () => {
    const tool = createTypeTool(governor) as any;
    expect(Object.keys(tool.schema.properties).sort()).toEqual(['app', 'field', 'role', 'submit', 'text']);
    expect(tool.schema.required).toEqual(['app', 'text']);
    expect(tool.isDestructive).toBe(true);
  });

  it('meets the governor as computer control, then asks the app with capability type', async () => {
    const out = await run({ app: 'WhatsApp', field: 'Compose message', role: 'AXTextArea', text: 'hi' });
    expect(approvals[0]).toMatchObject({ taskType: 'COMPUTER_CONTROL', payload: { tool: 'TypeInAppTool', app: 'WhatsApp', text: 'hi' } });
    expect(calls).toEqual([{ capability: 'type', op: 'type', args: { app: 'WhatsApp', field: 'Compose message', role: 'AXTextArea', text: 'hi' } }]);
    expect(out).toContain('reads exactly');
  });

  it('a line break never reaches the app', async () => {
    for (const text of ['hi\nthere', 'hi\rthere', `hi${String.fromCharCode(0x2028)}there`]) {
      expect(String(await run({ app: 'WhatsApp', text }))).toContain('no line breaks');
    }
    expect(calls).toEqual([]);
  });

  it('what it returns is screen text', () => {
    expect(untrustedChannel('TypeInAppTool')).toBe('screen');
  });

  it('submit is forwarded only when it is exactly true', async () => {
    await run({ app: 'Music', field: 'Search', text: 'x', submit: true });
    await run({ app: 'Music', field: 'Search', text: 'x', submit: 'yes' });
    expect(calls.map((c) => c.args.submit)).toEqual([true, undefined]);
  });
});

describe('ScrollInAppTool', () => {
  let calls: Array<{ capability: string; op: string; args: any }>;
  const governor = { approveTaskExecution: async () => {} } as any;
  const listener = (capability: string, op: string, args: any, resolve: (r: HostCallResult) => void) => {
    calls.push({ capability, op, args });
    resolve({ ok: false, error: 'Scrolled down at “Mom”, but nothing moved.', value: { code: 'no_effect' } });
  };
  beforeEach(() => { calls = []; engineEvents.on(HOST_CALL_EVENT, listener); });
  afterEach(() => { engineEvents.off(HOST_CALL_EVENT, listener); });

  it('names one app, one control and a direction; no coordinates, keys or text', async () => {
    const tool = createScrollTool(governor) as any;
    expect(Object.keys(tool.schema.properties).sort()).toEqual(['app', 'control', 'direction', 'pages', 'role']);
    expect(tool.schema.required).toEqual(['app', 'control', 'direction']);
    const out = await tool.execute({ app: 'WhatsApp', control: 'Mom', direction: 'down', pages: 2 }, { cwd: process.cwd() });
    expect(calls).toEqual([{ capability: 'scroll', op: 'scroll', args: { app: 'WhatsApp', control: 'Mom', direction: 'down', pages: 2 } }]);
    expect(String(out)).toContain('nothing moved');
    expect(untrustedChannel('ScrollInAppTool')).toBe('screen');
  });
});

describe('the press capability travels as its own host_call', () => {
  it('ProtocolHost writes the capability the tool asked for', () => {
    const emitter = new EventEmitter();
    const sent: Outbound[] = [];
    const host = new ProtocolHost((m) => sent.push(m));
    host.attach(emitter);
    emitter.emit(HOST_CALL_EVENT, 'press', 'press', { app: 'BimaxCuFixture', control: 'Fixture Button' }, () => {});
    expect(sent.find((m) => m.t === 'host_call')).toMatchObject({ t: 'host_call', capability: 'press', op: 'press' });
    host.detach();
  });
});

describe('what a press returns is screen text', () => {
  it('is fenced like a web page', () => {
    expect(untrustedChannel('PressInAppTool')).toBe('screen');
    expect(fenceUntrusted('PressInAppTool', '{"app":"BimaxCuFixture","control":"Fixture Button"}', 'presses=1'))
      .toBe('<untrusted source="screen: window of BimaxCuFixture">\npresses=1\n</untrusted>');
  });
});

describe('admission: the engine has the press and type tools only when the app turns on looking AND using', () => {
  it('registration needs both flags, and nothing in the engine sets either', () => {
    const root = path.resolve(__dirname, '..', '..');
    const container = fs.readFileSync(path.join(root, 'src/core/container.ts'), 'utf8');
    expect(container).toContain("if (process.env.BIMAX_COMPUTER_LOOK === '1' && process.env.BIMAX_COMPUTER_USE === '1') {\n    toolRegistry.register(createPressTool(governor));\n    toolRegistry.register(createTypeTool(governor));\n    toolRegistry.register(createScrollTool(governor));\n  }");
    expect(container).not.toContain('BIMAX_COMPUTER_PRESS');
    const setters = [] as string[];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(p); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const code = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        if (/BIMAX_COMPUTER_(?:USE|PRESS)['"]?\s*(?:=(?!=)|:)/.test(code)) setters.push(path.relative(root, p));
      }
    };
    walk(path.join(root, 'src'));
    expect(setters).toEqual([]);
  });
});
