import '../engine/commands/session';
import { globalCommandRegistry } from '../engine/commands/registry';

function getCmd(name: string): any {
  return (globalCommandRegistry as any).commands.get(name);
}

describe('/sessions & /resume', () => {
  it('are registered (resume aliases /session)', () => {
    expect(getCmd('/sessions')).toBeDefined();
    expect(getCmd('/resume')).toBeDefined();
    expect(getCmd('/session')).toBe(getCmd('/resume'));
  });

  it('/sessions reports cleanly when there are no saved sessions', async () => {
    // Test cwd has no .breakglass/sessions → empty list → info message (not a crash/stub).
    const res = await getCmd('/sessions').execute([], { addSystemMessage: jest.fn() } as any);
    // Either a "no sessions" message or a populated menu — never the old migration stub.
    expect(['message', 'menu']).toContain(res.type);
    if (res.type === 'message') expect(res.content).toMatch(/no saved sessions/i);
    expect(JSON.stringify(res)).not.toMatch(/being migrated/i);
  });

  it('bare /resume redirects to the /sessions browser', async () => {
    const res = await getCmd('/resume').execute([], {} as any);
    expect(res).toEqual({ type: 'redirect', command: '/sessions' });
  });

  it('/resume with an unknown id errors instead of silently failing', async () => {
    const res = await getCmd('/resume').execute(['does-not-exist'], { addSystemMessage: jest.fn() } as any);
    expect(res.type).toBe('message');
    expect(res.level).toBe('error');
  });
});
