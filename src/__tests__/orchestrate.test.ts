import '../engine/commands/orchestrate';
import { globalCommandRegistry } from '../engine/commands/registry';
import { addCustomRule, setCustomRoutingRules } from '../engine/agentRouter';

function getCmd(name: string): any {
  return (globalCommandRegistry as any).commands.get(name);
}

describe('/orchestrate — orchestration HUD', () => {
  afterEach(() => setCustomRoutingRules([]));

  it('registers with /orch + /orchestration aliases', () => {
    expect(getCmd('/orchestrate')).toBeDefined();
    expect(getCmd('/orch')).toBe(getCmd('/orchestrate'));
    expect(getCmd('/orchestration')).toBe(getCmd('/orchestrate'));
  });

  it('returns a menu grouping active persona, agents and routing rules', async () => {
    const res = await getCmd('/orchestrate').execute([], { options: { agent: 'hermes' } } as any);
    expect(res.type).toBe('menu');
    const cats = new Set(res.options.map((o: any) => o.category));
    expect(cats.has('Active persona')).toBe(true);
    expect(cats.has('Agents / Personas')).toBe(true);
    expect(cats.has('Routing Rules')).toBe(true);

    const activeRow = res.options.find((o: any) => o.category === 'Active persona');
    expect(activeRow.label).toBe('hermes');
  });

  it('falls back to "default" persona when no agent option is set', async () => {
    const res = await getCmd('/orchestrate').execute([], { options: {} } as any);
    const activeRow = res.options.find((o: any) => o.category === 'Active persona');
    expect(activeRow.label).toBe('default');
  });

  it('lists custom routing rules as pattern → agent', async () => {
    addCustomRule('deploy', 'opencode');
    const res = await getCmd('/orchestrate').execute([], { options: {} } as any);
    const ruleRow = res.options.find((o: any) => o.category === 'Routing Rules');
    expect(ruleRow.label).toBe('deploy');
    expect(ruleRow.desc).toContain('opencode');
    expect(ruleRow.value).toBe('/routes');
  });

  it('shows a placeholder when no custom routes exist', async () => {
    const res = await getCmd('/orchestrate').execute([], { options: {} } as any);
    const ruleRow = res.options.find((o: any) => o.category === 'Routing Rules');
    expect(ruleRow.label).toBe('(no custom routes)');
  });

  it('onSelect redirects to the row subsystem command', async () => {
    const executeCommand = jest.fn();
    const res = await getCmd('/orchestrate').execute([], { options: {}, executeCommand } as any);
    res.onSelect({ value: '/agents' });
    expect(executeCommand).toHaveBeenCalledWith('/agents');
  });
});
