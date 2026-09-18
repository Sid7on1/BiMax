import { globalCommandRegistry } from './registry';
import { GenomeEvolver } from '../../evolution/genome.evolver';
import { getConfig } from '../config';

/**
 * /evolve — gated genome self-evolution. The agent improves one of BiMax's own
 * components in an isolated worktree; the result is kept only if it passes the
 * architectural guardian, and is NEVER auto-merged. Disabled until /evolve enable.
 *
 *   /evolve enable | disable | status
 *   /evolve <Component> <improvement…>
 */
globalCommandRegistry.register({
  name: '/evolve',
  description: 'Gated self-evolution of BiMax\'s own source',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    const sub = (args[0] || '').toLowerCase();
    const enabled = () => {
      try { return !!getConfig().allowSelfEvolution; } catch { return false; }
    };

    if (sub === 'enable') {
      await context.saveConfig({ allowSelfEvolution: true });
      return { type: 'message', level: 'success', content: '⚠️ Self-evolution ENABLED. BiMax may now modify its own source (in an isolated worktree, guarded by genome contracts, never auto-merged). Use /evolve disable to turn off.' };
    }
    if (sub === 'disable') {
      await context.saveConfig({ allowSelfEvolution: false });
      return { type: 'message', level: 'success', content: 'Self-evolution disabled.' };
    }

    const evolver = new GenomeEvolver(context.cwd, context.options.governor?.mode || 'interactive',
      (level, msg) => context.addSystemMessage(level === 'warn' ? 'info' : level, msg));

    if (!sub || sub === 'status') {
      const components = await evolver.listComponents();
      return { type: 'message', level: 'info', content: `Self-evolution: ${enabled() ? 'ENABLED' : 'disabled'}.\nEvolvable components: ${components.join(', ') || '(none)'}\nUsage: /evolve enable, then /evolve <Component> <improvement>` };
    }

    if (!enabled()) {
      return { type: 'message', level: 'error', content: 'Self-evolution is disabled. Run /evolve enable first (it lets BiMax modify its own source; changes are guarded and never auto-merged).' };
    }

    const component = args[0];
    const improvement = args.slice(1).join(' ').trim();
    if (!improvement) {
      return { type: 'message', level: 'error', content: 'Usage: /evolve <Component> <improvement>. See /evolve status for components.' };
    }

    context.addSystemMessage('info', `🧬 Evolving ${component}: "${improvement}"`);
    try {
      const r = await evolver.evolve(component, improvement);
      if (!r.changed) return { type: 'message', level: 'info', content: `🧬 ${r.detail}` };
      if (!r.guardianPassed) return { type: 'message', level: 'error', content: `🧬 ${r.detail}` };
      return {
        type: 'message',
        level: 'success',
        content: `🧬 ${r.detail}\nReview and merge with:\n  git merge ${r.branch}`,
      };
    } catch (e: any) {
      return { type: 'message', level: 'error', content: `Evolve failed: ${e.message}` };
    }
  }
});
