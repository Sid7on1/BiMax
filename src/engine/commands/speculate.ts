import { execFileSync } from 'child_process';
import { globalCommandRegistry } from './registry';
import { SpeculativeSolver } from '../../evolution/speculative.solver';
import { getGlobalPatternStore } from '../../genome/pattern.store';

function isGitRepo(cwd: string): boolean {
  try { return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf-8' }).trim() === 'true'; } catch { return false; }
}

/**
 * /speculate <task> — generate a few distinct approaches, implement each in parallel
 * in its own worktree, test them, and present the trade-offs (no auto-merge).
 */
globalCommandRegistry.register({
  name: '/speculate',
  aliases: ['/spec'],
  description: 'Try several distinct approaches in parallel; compare trade-offs',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    const task = args.join(' ').trim();
    if (!task) return { type: 'message', level: 'error', content: 'Usage: /speculate <task>. Generates competing approaches and tests each.' };
    if (!isGitRepo(context.cwd)) return { type: 'message', level: 'error', content: 'Speculate needs a git repository. Run `git init` first.' };
    const llmAdapter = context.options.llmAdapter;
    if (!llmAdapter) return { type: 'message', level: 'error', content: 'LLM adapter unavailable.' };

    const log = (level: 'info' | 'success' | 'error' | 'warn', msg: string) =>
      context.addSystemMessage(level === 'warn' ? 'info' : level, msg);

    context.addSystemMessage('info', `🔀 Speculating distinct approaches for: "${task}"`);
    const solver = new SpeculativeSolver(context.cwd, llmAdapter, context.options.governor?.mode || 'interactive', log);
    try {
      const r = await solver.run(task);
      const rows = r.arms.map(a => {
        const icon = a.testsPassed ? '✔' : a.changed ? '~' : '✖';
        const star = a.index === r.recommended ? ' ⭐' : '';
        const br = a.branch ? `  [${a.branch}]` : '';
        return `  ${icon} #${a.index} ${a.approach}${star}\n      ${a.detail}${a.filesChanged ? `, ${a.filesChanged} files` : ''}${br}`;
      });
      const usable = r.arms.filter(a => a.changed);
      if (usable.length === 0) {
        return { type: 'message', level: 'error', content: `🔀 No approach produced usable changes.\n${rows.join('\n')}` };
      }
      // Log winner to genome pattern store so self-evolution can learn which approaches succeed
      if (r.recommended != null) {
        const winner = r.arms.find(a => a.index === r.recommended);
        if (winner) {
          try { getGlobalPatternStore()?.appendSpeculateWinner(task, winner.approach, winner.index); } catch { /* ignore */ }
        }
      }
      const rec = r.recommended ? `\n\n⭐ Recommended: approach #${r.recommended}. Inspect a branch and merge with \`git merge <branch>\`.` : '';
      return { type: 'message', level: 'success', content: `🔀 Speculative results (each on its own branch):\n${rows.join('\n')}${rec}` };
    } catch (e: any) {
      return { type: 'message', level: 'error', content: `Speculate failed: ${e.message}` };
    }
  }
});
