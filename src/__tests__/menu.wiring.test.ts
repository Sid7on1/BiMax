import '../engine/commands/meta';
import '../engine/commands/file';
import { globalCommandRegistry } from '../engine/commands/registry';
import { getKnownAgents } from '../engine/agentRouter';

// These menus previously returned `type: 'menu'` with NO onSelect — so selecting a row in the TUI
// did nothing (the legacy menuType branches in FullScreen only fire for hand-built menus, not
// command-registry results). This locks the fix: every interactive command menu carries a working
// onSelect that drives the right follow-up action.
function getCmd(name: string): any {
  return (globalCommandRegistry as any).commands.get(name);
}

function mockCtx() {
  const saveConfig = jest.fn().mockResolvedValue(undefined);
  const addSystemMessage = jest.fn();
  const executeCommand = jest.fn();
  const setActivePrompt = jest.fn();
  return {
    cwd: '/tmp',
    options: { model: 'old/model', agent: 'bimax', governor: { mode: 'interactive' } },
    saveConfig, addSystemMessage, executeCommand,
    setActiveMenu: jest.fn(), setActivePrompt,
    _spies: { saveConfig, addSystemMessage, executeCommand, setActivePrompt },
  } as any;
}

describe('/agents (menu wiring)', () => {
  it('menu has an onSelect that applies the picked persona live + persists', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/agents').execute([], ctx);
    expect(res.type).toBe('menu');
    expect(typeof res.onSelect).toBe('function');

    const pick = res.options[0].value;
    res.onSelect({ value: pick });
    expect(ctx.options.agent).toBe(pick);
    expect(ctx._spies.saveConfig).toHaveBeenCalledWith({ defaultAgent: pick });
    expect(ctx._spies.addSystemMessage).toHaveBeenCalled();
  });

  it('`/agents <name>` applies a known persona directly', async () => {
    const ctx = mockCtx();
    const known = getKnownAgents()[0];
    const res = await getCmd('/agents').execute([known], ctx);
    expect(res.type).toBe('none');
    expect(ctx.options.agent).toBe(known);
  });

  it('rejects an unknown persona name', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/agents').execute(['definitely-not-an-agent'], ctx);
    expect(res.type).toBe('message');
    expect(res.level).toBe('error');
  });
});

describe('/routes (menu wiring)', () => {
  it('selecting "Add New Rule" chains two prompts then applies the rule', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/routes').execute([], ctx);
    expect(res.type).toBe('menu');
    expect(typeof res.onSelect).toBe('function');

    res.onSelect({ value: 'add_rule' });
    expect(ctx._spies.setActivePrompt).toHaveBeenCalledTimes(1);
    // First prompt: the regex. Drive it as the TUI would on Enter.
    const p1 = ctx._spies.setActivePrompt.mock.calls[0][0];
    p1.onResolve('fix.*bug');
    // Second prompt: the target agent.
    const p2 = ctx._spies.setActivePrompt.mock.calls[1][0];
    p2.onResolve('debugger');
    expect(ctx._spies.executeCommand).toHaveBeenCalledWith('/routes add fix.*bug debugger');
  });

  it('selecting an existing rule deletes it by index', async () => {
    const ctx = mockCtx();
    // Seed a rule so the menu lists one.
    await getCmd('/routes').execute(['add', 'foo', 'bar'], ctx);
    const res = await getCmd('/routes').execute([], ctx);
    const ruleRow = res.options.find((o: any) => o.value !== 'add_rule');
    expect(ruleRow).toBeTruthy();
    res.onSelect({ value: ruleRow.value });
    expect(ctx._spies.executeCommand).toHaveBeenCalledWith(`/routes remove ${ruleRow.value}`);
  });
});

describe('backup menus (/undo, /diff-file, /backups) wiring', () => {
  // These return a menu only when backups exist; mock getBackups via the fileEditor module so the
  // menu branch runs deterministically without touching the filesystem.
  beforeAll(() => {
    jest.spyOn(require('../engine/fileEditor'), 'getBackups').mockResolvedValue([
      { file: 'src_app.ts_1700000000000', original: '', timestamp: 0 },
    ]);
  });
  afterAll(() => jest.restoreAllMocks());

  it.each([
    ['/undo', '/undo '],
    ['/diff-file', '/diff-file '],
    ['/backups', '/diff-file '],
  ])('%s menu carries an onSelect that runs the follow-up command', async (cmd, expectedPrefix) => {
    const ctx = mockCtx();
    const res = await getCmd(cmd).execute([], ctx);
    expect(res.type).toBe('menu');
    expect(typeof res.onSelect).toBe('function');
    const row = res.options[0];
    res.onSelect({ value: row.value });
    expect(ctx._spies.executeCommand).toHaveBeenCalledWith(expectedPrefix + row.value);
  });
});

describe('/cost (real readout)', () => {
  it('reports the model + session usage instead of a migration stub', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/cost').execute([], ctx);
    expect(res.type).toBe('message');
    expect(res.content).toContain('old/model');
    expect(res.content).not.toMatch(/migrat/i);
  });
});
