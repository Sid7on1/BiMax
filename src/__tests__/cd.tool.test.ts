import * as os from 'os';
import * as path from 'path';
import { createCdTool } from '../tools/implementations/cd.tool';
import { cliEvents } from '../cli/events';

const governor: any = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) };

function cd() {
  const tool = createCdTool(governor) as any;
  return (args: any, ctx: any) => tool.execute(args, ctx);
}

// The engine chdir()s to the user's project at boot (BIMAX_CWD), so the model already starts there.
// Opening a task with `cd <that same project>` burned a turn AND re-emitted cwd_changed, which makes
// the front-end reload the project graph / map panel for a directory that never changed.
describe('ChangeDirectoryTool — already-there is a no-op', () => {
  it('reports no change and emits no cwd_changed when the target IS the cwd', async () => {
    const cwd = os.tmpdir();
    const seen: string[] = [];
    const onChanged = (dir: string) => seen.push(dir);
    cliEvents.on('cwd_changed', onChanged);
    try {
      const out = await cd()({ targetPath: cwd }, { cwd });
      expect(out).toMatch(/Already in/);
      expect(out).toContain(path.resolve(cwd));
    } finally {
      cliEvents.off('cwd_changed', onChanged);
    }
    expect(seen).toEqual([]);
  });

  it('treats "." as the current directory too', async () => {
    const cwd = os.tmpdir();
    await expect(cd()({ targetPath: '.' }, { cwd })).resolves.toMatch(/Already in/);
  });

  it('still moves — and announces the move — for a genuinely different directory', async () => {
    const cwd = path.join(os.tmpdir(), '.');
    const ctx = { cwd };
    const seen: string[] = [];
    const onChanged = (dir: string) => seen.push(dir);
    cliEvents.on('cwd_changed', onChanged);
    try {
      const out = await cd()({ targetPath: os.homedir() }, ctx);
      expect(out).toMatch(/^Now in /);
      expect(ctx.cwd).toBe(os.homedir());
    } finally {
      cliEvents.off('cwd_changed', onChanged);
    }
    expect(seen).toEqual([os.homedir()]);
  });
});
