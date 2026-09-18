import { execFileSync } from 'child_process';
import { globalCommandRegistry } from './registry';
import { CouncilOrchestrator } from '../../evolution/council.orchestrator';

function isGitRepo(cwd: string): boolean {
  try { return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf-8' }).trim() === 'true'; } catch { return false; }
}

/**
 * /council <task> — run the task through every installed external AI CLI (claude,
 * gemini, opencode, bimax), each in its own worktree, judge by the test suite, and
 * keep the winner on a branch.
 */
globalCommandRegistry.register({
  name: '/council',
  description: 'Run a task across multiple AI CLIs and keep the winner',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    const task = args.join(' ').trim();
    if (!task) return { type: 'message', level: 'error', content: 'Usage: /council <task>. Each installed AI CLI competes; the one whose changes pass tests wins.' };
    if (!isGitRepo(context.cwd)) return { type: 'message', level: 'error', content: 'Council needs a git repository. Run `git init` first.' };

    const log = (level: 'info' | 'success' | 'error' | 'warn', msg: string) =>
      context.addSystemMessage(level === 'warn' ? 'info' : level, msg);

    context.addSystemMessage('info', `🏛️ Convening the council for: "${task}"`);
    const council = new CouncilOrchestrator(context.cwd, undefined, log);
    try {
      const r = await council.run(task);
      const rows = r.members.map(m => {
        const icon = !m.available ? '∅' : m.testsPassed ? '✔' : m.changed ? '~' : '✖';
        return `  ${icon} ${m.name} — ${m.detail}${m.filesChanged ? ` (${m.filesChanged} files)` : ''}`;
      });
      if (!r.winner) {
        return { type: 'message', level: 'error', content: `🏛️ No winner.\n${rows.join('\n')}` };
      }
      return {
        type: 'message',
        level: 'success',
        content: `🏛️ Council winner: ${r.winner}\n${rows.join('\n')}\n\nResult is on branch \`${r.winnerBranch}\`. Merge with:\n  git merge ${r.winnerBranch}`,
      };
    } catch (e: any) {
      return { type: 'message', level: 'error', content: `Council failed: ${e.message}` };
    }
  }
});
