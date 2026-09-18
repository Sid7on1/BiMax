import { globalCommandRegistry } from './registry';
import { getGoalManager, GoalStatus } from '../../memory/goal.manager';

function statusIcon(s: GoalStatus): string {
  return s === 'active' ? '◉' : s === 'completed' ? '✓' : '✗';
}

globalCommandRegistry.register({
  name: '/goals',
  aliases: ['/goal'],
  description: 'Manage persistent cross-session goals',
  category: 'Session & Context',
  execute: async (args, context) => {
    // getGoalManager() throws if the manager wasn't initialized (e.g. before container boot).
    // Guard so /goals reports cleanly instead of throwing into the command dispatcher.
    let gm: ReturnType<typeof getGoalManager>;
    try {
      gm = getGoalManager();
    } catch {
      return { type: 'message', level: 'error', content: 'Goal manager not initialized yet. Try again once the session has finished starting.' };
    }

    // /goals add <title> [:: description]
    if (args[0] === 'add') {
      const rest = args.slice(1).join(' ');
      const sepIdx = rest.indexOf('::');
      const title = (sepIdx >= 0 ? rest.slice(0, sepIdx) : rest).trim();
      const description = sepIdx >= 0 ? rest.slice(sepIdx + 2).trim() : '';
      if (!title) return { type: 'message', level: 'error', content: 'Usage: /goals add <title> [:: description]' };
      const goal = await gm.addGoal(title, description);
      return { type: 'message', level: 'success', content: `Goal added [${goal.id}]: "${goal.title}"` };
    }

    // /goals complete <id>
    if (args[0] === 'complete' || args[0] === 'done') {
      if (!args[1]) return { type: 'message', level: 'error', content: `Usage: /goals complete <id>` };
      const goal = await gm.setStatus(args[1], 'completed');
      if (!goal) return { type: 'message', level: 'error', content: `No goal with id "${args[1]}". Use /goals to see IDs.` };
      return { type: 'message', level: 'success', content: `Goal [${goal.id}] completed: "${goal.title}"` };
    }

    // /goals abandon <id>
    if (args[0] === 'abandon') {
      if (!args[1]) return { type: 'message', level: 'error', content: `Usage: /goals abandon <id>` };
      const goal = await gm.setStatus(args[1], 'abandoned');
      if (!goal) return { type: 'message', level: 'error', content: `No goal with id "${args[1]}". Use /goals to see IDs.` };
      return { type: 'message', level: 'success', content: `Goal [${goal.id}] abandoned: "${goal.title}"` };
    }

    // /goals list (default) — show interactive menu
    const all = gm.getAllGoals();
    if (all.length === 0) {
      return {
        type: 'message',
        level: 'info',
        content: 'No goals yet. Add one with /goals add <title>  or  tell the agent to set a goal and it will call GoalsTool.',
      };
    }

    const active = all.filter(g => g.status === 'active');
    const done = all.filter(g => g.status !== 'active');

    const options = [
      ...active.map(g => ({
        label: `${statusIcon('active')} [${g.id}] ${g.title}`,
        value: `complete:${g.id}`,
        desc: g.description || `active · ${g.sessions.length} session(s)`,
        category: 'Active',
      })),
      ...done.map(g => ({
        label: `${statusIcon(g.status)} [${g.id}] ${g.title}`,
        value: `none:${g.id}`,
        desc: `${g.status} · ${g.sessions.length} session(s)`,
        category: 'Done / Abandoned',
      })),
    ];

    return {
      type: 'menu',
      title: `Goals (${active.length} active, ${done.length} done) — select active goal to mark complete`,
      options,
      onSelect: async (opt: any) => {
        const [action, id] = opt.value.split(':');
        if (action === 'complete') {
          const goal = await gm.setStatus(id, 'completed');
          if (goal) context.addSystemMessage('success', `Goal [${id}] completed: "${goal.title}"`);
        }
      },
    };
  },
});
