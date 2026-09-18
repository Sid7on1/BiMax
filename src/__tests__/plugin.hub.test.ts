import '../engine/commands/plugins';
import { globalCommandRegistry } from '../engine/commands/registry';

function getCmd(name: string): any {
  return (globalCommandRegistry as any).commands.get(name);
}

function mockCtx() {
  const executeCommand = jest.fn();
  return {
    cwd: '/tmp/bimax-hub-test',
    options: {},
    executeCommand,
    addSystemMessage: jest.fn(),
    saveConfig: jest.fn(),
    setActiveMenu: jest.fn(),
    setActivePrompt: jest.fn(),
    _spies: { executeCommand },
  } as any;
}

describe('/plugins — integration hub', () => {
  it('is registered under /plugins with /hub + /integrations aliases', () => {
    expect(getCmd('/plugins')).toBeDefined();
    expect(getCmd('/hub')).toBe(getCmd('/plugins'));
    expect(getCmd('/integrations')).toBe(getCmd('/plugins'));
  });

  it('returns a categorized menu covering every integration subsystem', async () => {
    const res = await getCmd('/plugins').execute([], mockCtx());
    expect(res.type).toBe('menu');
    expect(typeof res.onSelect).toBe('function');
    const categories = new Set(res.options.map((o: any) => o.category));
    for (const c of ['MCP Servers', 'Agent Skills', 'Routing Rules', 'Watchers', 'Commands']) {
      expect(categories.has(c)).toBe(true);
    }
    // Every row Enters into a real slash command.
    expect(res.options.every((o: any) => typeof o.value === 'string' && o.value.startsWith('/'))).toBe(true);
  });

  it('selecting a row redirects into the relevant subsystem command', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/plugins').execute([], ctx);
    const mcpRow = res.options.find((o: any) => o.category === 'MCP Servers');
    res.onSelect(mcpRow);
    expect(ctx._spies.executeCommand).toHaveBeenCalledWith('/mcp');
  });

  it('shows the live command count, derived from the registry', async () => {
    const res = await getCmd('/plugins').execute([], mockCtx());
    const cmdRow = res.options.find((o: any) => o.category === 'Commands');
    expect(cmdRow.label).toMatch(/^\d+ commands$/);
    expect(cmdRow.value).toBe('/help');
  });
});
