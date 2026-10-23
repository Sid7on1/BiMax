import '../engine/commands/meta';
import '../engine/commands/builtins';
import '../engine/commands/session';
import { globalCommandRegistry } from '../engine/commands/registry';

// Regression tests for the slash-menu fixes: /model must apply the model live (adapter +
// config), and /config must be a hub whose options are runnable slash commands.
function getCmd(name: string): any {
  return (globalCommandRegistry as any).commands.get(name);
}

function mockCtx() {
  const applyConfig = jest.fn();
  const saveConfig = jest.fn().mockResolvedValue(undefined);
  const addSystemMessage = jest.fn();
  const executeCommand = jest.fn();
  const setActivePrompt = jest.fn();
  return {
    cwd: '/tmp',
    options: { model: 'old/model', theme: 'dark', llmAdapter: { applyConfig }, governor: { mode: 'interactive' } },
    saveConfig, addSystemMessage, executeCommand,
    setActiveMenu: jest.fn(), setActivePrompt,
    _spies: { applyConfig, saveConfig, addSystemMessage, executeCommand, setActivePrompt },
  } as any;
}

describe('/model (menu fix)', () => {
  it('top level is a clutter-free hub whose rows are runnable commands', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/model').execute([], ctx);
    expect(res.type).toBe('menu');
    expect(typeof res.onSelect).toBe('function');
    const values = res.options.map((o: any) => o.value);
    expect(values).toEqual(['/model work', '/model quick', '/model vision', '/model advanced']);
    expect(res.options.every((o: any) => !o.category)).toBe(true);
    expect(values).not.toContain('minimaxai/minimax-m3');
    res.onSelect({ value: '/model work' });
    expect(ctx._spies.executeCommand).toHaveBeenCalledWith('/model work');
  });

  it('keeps provider and expert controls one level deeper', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/model').execute(['advanced'], ctx);
    expect(res.type).toBe('menu');
    expect(res.options.map((o: any) => o.value)).toEqual([
      '/provider', '/model subagent', '/reasoning', '/model one',
    ]);
  });

  it('the coding picker applies the model live + persists', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/model').execute(['coding'], ctx);
    expect(res.type).toBe('menu');
    expect(res.options.map((o: any) => o.value)).toContain('minimaxai/minimax-m3');

    res.onSelect({ value: 'gpt-4o' });
    expect(ctx._spies.applyConfig).toHaveBeenCalledWith({ model: 'gpt-4o' });
    expect(ctx._spies.saveConfig).toHaveBeenCalledWith({ model: 'gpt-4o' });
    expect(ctx.options.model).toBe('gpt-4o');
    expect(ctx._spies.addSystemMessage).toHaveBeenCalled();
  });

  it('`/model one <id>` pins one model everywhere (coding + lite + sub-agents inherit)', async () => {
    const ctx = mockCtx();
    await getCmd('/model').execute(['one', 'gpt-4o'], ctx);
    expect(ctx._spies.applyConfig).toHaveBeenCalledWith({ model: 'gpt-4o', liteModel: 'gpt-4o' });
    expect(ctx._spies.saveConfig).toHaveBeenCalledWith({ model: 'gpt-4o', liteModel: 'gpt-4o', subagentModel: '' });
    expect(ctx.options.model).toBe('gpt-4o');
  });

  it('`/model <id>` applies directly', async () => {
    const ctx = mockCtx();
    await getCmd('/model').execute(['claude-3-5-sonnet-20241022'], ctx);
    expect(ctx._spies.applyConfig).toHaveBeenCalledWith({ model: 'claude-3-5-sonnet-20241022' });
    expect(ctx.options.model).toBe('claude-3-5-sonnet-20241022');
  });

  it('`/model work` and `/model quick` are first-class spellings of the slot pickers', async () => {
    // The UI says Work/Quick — typing those words must open the matching picker, never set the
    // literal model id "work". (Regression: vocabulary drift between labels and arguments.)
    const ctx = mockCtx();
    const workRes = await getCmd('/model').execute(['work'], ctx);
    expect(workRes.type).toBe('menu');
    expect(ctx.options.model).toBe('old/model'); // untouched — a picker opened, nothing was set

    const quickRes = await getCmd('/model').execute(['quick'], ctx);
    expect(quickRes.type).toBe('menu');
    expect(quickRes.title).toContain('Quick');

    await getCmd('/model').execute(['work', 'gpt-4o'], ctx);
    expect(ctx._spies.applyConfig).toHaveBeenCalledWith({ model: 'gpt-4o' });
    await getCmd('/model').execute(['quick', 'gpt-4o'], ctx);
    expect(ctx._spies.applyConfig).toHaveBeenCalledWith({ liteModel: 'gpt-4o' });
  });
});

describe('/config (hub fix)', () => {
  it('returns a hub whose options are runnable slash commands, incl. the new toggles', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/config').execute([], ctx);
    expect(res.type).toBe('menu');
    expect(typeof res.onSelect).toBe('function');
    const values = res.options.map((o: any) => o.value);
    expect(values).toEqual(expect.arrayContaining(['/model', '/governor verify', '/governor sandbox', '/governor blast-gate', '/autocommit']));
    expect(values.every((v: string) => v.startsWith('/'))).toBe(true);

    res.onSelect({ value: '/model' });
    expect(ctx._spies.executeCommand).toHaveBeenCalledWith('/model');
  });

  it('`/config theme` opens a theme picker of slash commands', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/config').execute(['theme'], ctx);
    expect(res.type).toBe('menu');
    expect(res.options.map((o: any) => o.value)).toContain('/config set theme dark');
  });

  it('hub labels reflect live state and include the verbose/notify toggles', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/config').execute([], ctx);
    const values = res.options.map((o: any) => o.value);
    expect(values).toEqual(expect.arrayContaining(['/config verbose', '/config notify']));
    const model = res.options.find((o: any) => o.value === '/model');
    expect(model.desc).toContain('old/model'); // live current model, not hardcoded
  });

  it('`/config verbose` is a runnable on/off menu', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/config').execute(['verbose'], ctx);
    expect(res.type).toBe('menu');
    expect(res.options.map((o: any) => o.value)).toEqual(['/config set verbose true', '/config set verbose false']);
  });

  it('`/config set verbose true` applies live + persists', async () => {
    const ctx = mockCtx();
    await getCmd('/config').execute(['set', 'verbose', 'true'], ctx);
    expect(ctx.options.verbose).toBe(true);
    expect(ctx._spies.saveConfig).toHaveBeenCalledWith({ verbose: true });
  });
});

describe('/model custom entry', () => {
  it('the custom option opens a prompt that applies the typed id', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/model').execute(['coding'], ctx);
    expect(res.options.map((o: any) => o.value)).toContain('__custom__');
    res.onSelect({ value: '__custom__' });
    expect(ctx._spies.setActivePrompt).toHaveBeenCalled();
    // Drive the prompt's resolver as the TUI would on Enter.
    const prompt = ctx._spies.setActivePrompt.mock.calls[0][0];
    prompt.onResolve('vendor/some-model');
    expect(ctx._spies.applyConfig).toHaveBeenCalledWith({ model: 'vendor/some-model' });
    expect(ctx.options.model).toBe('vendor/some-model');
  });
});

describe('/provider & /keys (interactive)', () => {
  it('/provider returns a picker with an onSelect (no typing required)', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/provider').execute([], ctx);
    expect(res.type).toBe('menu');
    expect(typeof res.onSelect).toBe('function');
    expect(res.options.length).toBeGreaterThan(0);
  });

  it('/keys onSelect opens a masked prompt for the chosen provider', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/keys').execute([], ctx);
    expect(res.type).toBe('menu');
    expect(typeof res.onSelect).toBe('function');
    res.onSelect({ value: res.options[0].value });
    expect(ctx._spies.setActivePrompt).toHaveBeenCalled();
    const prompt = ctx._spies.setActivePrompt.mock.calls[0][0];
    expect(prompt.isMasked).toBe(true);
  });
});
