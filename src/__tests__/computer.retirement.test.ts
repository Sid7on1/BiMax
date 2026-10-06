import { Governor, SessionPermissionMode } from '../governor/governor';
import { GlobalPrompter } from '../engine/prompter';

test.each<SessionPermissionMode>(['interactive', 'plan', 'auto', 'strict', 'bypass', 'unattended'])(
  'retired capability is denied in %s mode, in and out of a Bimax Thread, before any approval shortcut', async mode => {
    const root = process.env.BIMAX_THREAD_ROOT;
    const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValue('Yes');
    try {
      for (const threadRoot of [undefined, '/tmp/bimax-retirement']) {
        if (threadRoot) process.env.BIMAX_THREAD_ROOT = threadRoot; else delete process.env.BIMAX_THREAD_ROOT;
        const governor = new Governor({ emit: jest.fn(), on: jest.fn() } as any);
        governor.mode = mode;
        governor.addRule({ tool: 'COMPUTER_CONTROL', effect: 'allow', persistent: true });
        for (const app of ['Notes', '1Password']) {
          await expect(governor.approveTaskExecution('COMPUTER_CONTROL', {
            tool: 'stale-plugin', app, isDestructive: false,
          })).rejects.toThrow('Computer Use has been removed');
        }
        expect(ask).not.toHaveBeenCalled();
      }
    } finally {
      ask.mockRestore();
      if (root === undefined) delete process.env.BIMAX_THREAD_ROOT; else process.env.BIMAX_THREAD_ROOT = root;
    }
  },
);
