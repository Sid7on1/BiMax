import '../engine/commands/security';
import { globalCommandRegistry } from '../engine/commands/registry';

function getCmd(name: string): any {
  return (globalCommandRegistry as any).commands.get(name);
}

function mockCtx(mode = 'interactive') {
  const executeCommand = jest.fn();
  return {
    cwd: '/tmp',
    options: { governor: { mode } },
    executeCommand,
    addSystemMessage: jest.fn(),
    saveConfig: jest.fn(),
    setActiveMenu: jest.fn(),
    setActivePrompt: jest.fn(),
    _spies: { executeCommand },
  } as any;
}

describe('/security — governor cockpit', () => {
  it('registers under /security with /cockpit + /sec aliases', () => {
    expect(getCmd('/security')).toBeDefined();
    expect(getCmd('/cockpit')).toBe(getCmd('/security'));
    expect(getCmd('/sec')).toBe(getCmd('/security'));
  });

  it('lists all 7 safety layers, each toggling a real command', async () => {
    const res = await getCmd('/security').execute([], mockCtx());
    expect(res.type).toBe('menu');
    const layerRows = res.options.filter((o: any) => o.category === 'Safety Layers');
    expect(layerRows).toHaveLength(7);
    expect(layerRows.map((o: any) => o.value)).toEqual(
      expect.arrayContaining(['/governor', '/governor blast-gate', '/governor verify', '/governor sandbox', '/diff-approval', '/self-critic', '/autocommit']),
    );
    expect(layerRows.every((o: any) => /● ARMED|○ off/.test(o.desc))).toBe(true);
  });

  it('reflects governor bypass in the armed count and Governor row', async () => {
    const armed = await getCmd('/security').execute([], mockCtx('interactive'));
    const bypassed = await getCmd('/security').execute([], mockCtx('bypass'));
    const governorRow = (res: any) => res.options.find((o: any) => o.value === '/governor');
    expect(governorRow(armed).desc).toMatch(/ARMED/);
    expect(governorRow(bypassed).desc).toMatch(/off/);
    // The title's armed count drops by one when the governor is bypassed.
    const count = (t: string) => parseInt(t.match(/(\d+)\/\d+ layers armed/)![1], 10);
    expect(count(armed.title)).toBe(count(bypassed.title) + 1);
  });

  it('selecting a layer redirects to its toggle command', async () => {
    const ctx = mockCtx();
    const res = await getCmd('/security').execute([], ctx);
    res.onSelect({ value: '/diff-approval' });
    expect(ctx._spies.executeCommand).toHaveBeenCalledWith('/diff-approval');
  });
});
