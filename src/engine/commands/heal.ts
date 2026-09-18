import { globalCommandRegistry } from './registry';
import { TestHealer } from '../../sandbox/test.healer';

/**
 * /heal [test command] — run the test suite; if it's red, a fix agent works in an
 * isolated worktree until green, then the patch is surfaced on a branch for approval.
 */
globalCommandRegistry.register({
  name: '/heal',
  description: 'Run tests; auto-fix failures in an isolated worktree',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    const override = args.join(' ').trim() || undefined;
    const log = (level: 'info' | 'success' | 'error' | 'warn', msg: string) =>
      context.addSystemMessage(level === 'warn' ? 'info' : level, msg);

    context.addSystemMessage('info', '🩺 Self-healing test loop starting…');
    const healer = new TestHealer(context.cwd, context.options.governor?.mode || 'interactive', log);

    try {
      const r = await healer.heal({ testCommand: override });
      if (r.initiallyGreen) {
        return { type: 'message', level: 'success', content: `✅ Tests already pass (${r.testCommand}). Nothing to heal.` };
      }
      if (r.healed) {
        return {
          type: 'message',
          level: 'success',
          content: `🩹 Tests are green again. The fix is on branch \`${r.branch}\`.\n${r.diffStat ? r.diffStat + '\n' : ''}Review and merge with:\n  git merge ${r.branch}`,
        };
      }
      return {
        type: 'message',
        level: 'error',
        content: `Could not get tests green automatically.${r.branch ? ` Partial attempt left on branch \`${r.branch}\`.` : ''}\nLast failing output (tail):\n${(r.afterOutput || r.beforeFailure || '').slice(-1200)}`,
      };
    } catch (e: any) {
      return { type: 'message', level: 'error', content: `Heal failed: ${e.message}` };
    }
  }
});
