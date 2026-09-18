import { globalCommandRegistry } from './registry';
import { engineEvents } from '../events';
import { getPlanManager } from '../../memory/plan.manager';

/**
 * /plan — Read-only planning mode + plan file management.
 *
 * /plan [on|off]      — toggle read-only plan mode (agent researches, doesn't write)
 * /plan list          — list all saved plan files
 * /plan show [slug]   — display a saved plan (or the most recent one)
 * /plan delete <slug> — delete a plan file
 */
globalCommandRegistry.register({
  name: '/plan',
  description: 'Enter read-only plan mode · /plan list · /plan show [slug]',
  category: 'General',
  execute: async (args, context) => {
    const governor = context.options.governor;
    const sub = (args[0] || '').toLowerCase();

    // --- Plan mode toggle ---
    if (sub === 'off' || sub === 'exit') {
      governor.mode = context.options.dangerouslySkipPermissions ? 'bypass' : 'interactive';
      engineEvents.emit('mode_change', '');
      return { type: 'message', level: 'success', content: 'Plan mode OFF — agent can make changes again. Ask it to execute the plan.' };
    }

    if (sub === '' || sub === 'on') {
      if (governor.mode === 'plan') {
        return { type: 'message', level: 'info', content: 'Already in plan mode. Use /plan off to allow changes.' };
      }
      governor.mode = 'plan';
      engineEvents.emit('mode_change', 'PLAN');
      return {
        type: 'message',
        level: 'success',
        content: 'Plan mode ON — read-only. Agent will research and propose a plan (all writes blocked).\nWhen ready: /plan off to execute, or ask the agent to call PlanTool to save the plan first.',
      };
    }

    // --- /plan list ---
    if (sub === 'list') {
      try {
        const pm = getPlanManager();
        const slugs = await pm.list();
        if (slugs.length === 0) {
          return { type: 'message', level: 'info', content: 'No saved plans. In /plan mode, ask the agent to call PlanTool(action:"write") to save one.' };
        }
        const lines: string[] = [];
        for (const slug of slugs) {
          const plan = await pm.load(slug);
          if (!plan) continue;
          const done = plan.steps.filter(s => s.done).length;
          const total = plan.steps.length;
          const bar = `[${done}/${total}]`;
          lines.push(`  • ${slug}  ${bar}  ${plan.title}`);
        }
        return {
          type: 'menu',
          title: `Saved plans (${slugs.length}) — select to view`,
          options: slugs.map(s => ({ label: s, value: s, desc: `view ${s}`, category: 'Plans' })),
          onSelect: async (opt: any) => {
            const pm2 = getPlanManager();
            const plan = await pm2.load(opt.value);
            if (plan) context.addSystemMessage('info', pm2.formatPlan(plan));
          },
        };
      } catch {
        return { type: 'message', level: 'error', content: 'Plan manager not initialized.' };
      }
    }

    // --- /plan show [slug] ---
    if (sub === 'show') {
      try {
        const pm = getPlanManager();
        const slug = args[1];
        if (slug) {
          const plan = await pm.load(slug);
          if (!plan) return { type: 'message', level: 'error', content: `No plan with slug "${slug}". Use /plan list.` };
          return { type: 'message', level: 'info', content: pm.formatPlan(plan) };
        }
        // No slug — show the most recently MODIFIED plan (not the last alphabetical one).
        const newest = await pm.newestSlug();
        if (!newest) return { type: 'message', level: 'info', content: 'No saved plans. Use /plan list.' };
        const plan = await pm.load(newest);
        if (!plan) return { type: 'message', level: 'error', content: 'Could not load plan.' };
        return { type: 'message', level: 'info', content: pm.formatPlan(plan) };
      } catch {
        return { type: 'message', level: 'error', content: 'Plan manager not initialized.' };
      }
    }

    // --- /plan delete <slug> ---
    if (sub === 'delete' || sub === 'rm') {
      const slug = args[1];
      if (!slug) return { type: 'message', level: 'error', content: 'Usage: /plan delete <slug>' };
      try {
        const ok = await getPlanManager().delete(slug);
        return ok
          ? { type: 'message', level: 'success', content: `Plan "${slug}" deleted.` }
          : { type: 'message', level: 'error', content: `No plan with slug "${slug}".` };
      } catch {
        return { type: 'message', level: 'error', content: 'Plan manager not initialized.' };
      }
    }

    return { type: 'message', level: 'error', content: 'Usage: /plan [on|off|list|show [slug]|delete <slug>]' };
  },
});
