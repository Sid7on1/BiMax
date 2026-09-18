import '../engine/commands/diagnostics';
import { globalCommandRegistry } from '../engine/commands/registry';

function getCmd(name: string): any {
  return (globalCommandRegistry as any).commands.get(name);
}

describe('/diagnostics — session health report', () => {
  it('registers under /diagnostics with /diag + /health aliases', () => {
    expect(getCmd('/diagnostics')).toBeDefined();
    expect(getCmd('/diag')).toBe(getCmd('/diagnostics'));
    expect(getCmd('/health')).toBe(getCmd('/diagnostics'));
  });

  it('returns a message covering process, system and active-model sections', async () => {
    const res = await getCmd('/diagnostics').execute([], { options: {} } as any);
    expect(res.type).toBe('message');
    const c = res.content as string;
    expect(c).toContain('**Process**');
    expect(c).toContain('Memory (RSS):');
    expect(c).toContain('Uptime:');
    expect(c).toContain('**System**');
    expect(c).toContain('CPUs:');
    expect(c).toContain('**Active model**');
    expect(c).toContain('Context window:');
    // Points to the dedicated commands rather than duplicating them.
    expect(c).toContain('/cost');
  });
});
