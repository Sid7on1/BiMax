import { execFileSync } from 'child_process';
import { globalCommandRegistry } from './registry';
import { SwarmOrchestrator } from '../../evolution/swarm.orchestrator';

function isGitRepo(cwd: string): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf-8' }).trim() === 'true';
  } catch {
    return false;
  }
}

globalCommandRegistry.register({
  name: '/swarm',
  description: 'Decompose a goal and run sub-agents in parallel git worktrees',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    const goal = args.join(' ').trim();
    if (!goal) {
      return { type: 'message', level: 'error', content: 'Usage: /swarm <goal>. Example: /swarm add input validation to every route handler' };
    }
    if (!isGitRepo(context.cwd)) {
      return { type: 'message', level: 'error', content: 'Swarm needs a git repository (each sub-agent works in its own worktree). Run `git init` first.' };
    }
    const llmAdapter = context.options.llmAdapter;
    if (!llmAdapter) {
      return { type: 'message', level: 'error', content: 'LLM adapter unavailable in this context.' };
    }

    context.addSystemMessage('info', `🐝 Swarm starting for: "${goal}"`);
    const log = (level: 'info' | 'success' | 'error' | 'warn', msg: string) =>
      context.addSystemMessage(level === 'warn' ? 'info' : level, msg);

    const orchestrator = new SwarmOrchestrator(
      context.cwd,
      llmAdapter,
      context.options.governor?.mode || 'interactive',
      log
    );

    try {
      const report = await orchestrator.run(goal, { autoMerge: false });
      const lines = report.nodes.map(n => {
        const icon = n.status === 'completed' ? '✔' : n.status === 'conflict' ? '⚠' : n.status === 'skipped' ? '·' : '✖';
        return `  ${icon} ${n.id} — ${n.status}${n.detail ? ` (${n.detail})` : ''}`;
      });
      const ok = report.nodes.filter(n => n.status === 'completed').length;
      const summary =
        `🐝 Swarm complete: ${ok}/${report.nodes.length} task(s) succeeded.\n` +
        lines.join('\n') +
        `\n\nResult is on branch \`${report.integrationBranch}\`. Review it, then merge with:\n  git merge ${report.integrationBranch}`;
      return { type: 'message', level: ok === report.nodes.length ? 'success' : 'info', content: summary };
    } catch (e: any) {
      return { type: 'message', level: 'error', content: `Swarm failed: ${e.message}` };
    }
  }
});
