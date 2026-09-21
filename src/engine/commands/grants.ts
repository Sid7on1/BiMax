import { globalCommandRegistry } from './registry';
import { taskGrants } from '../../governor/task.grants';

/**
 * /grants — what "Allow for this task" has allowed in this task (backlog N13), and `/grants clear` to take it back.
 */
globalCommandRegistry.register({
  name: '/grants',
  category: 'Configuration',
  description: 'What "Allow for this task" has allowed; /grants clear to ask again',
  execute: async (args) => {
    if (args[0] === 'clear') {
      const n = taskGrants.clear();
      return { type: 'message', level: 'success', content: n ? `Cleared ${n} permission${n === 1 ? '' : 's'}. Bimax asks again from now on.` : 'Nothing was allowed for this task.' };
    }
    const list = taskGrants.list();
    if (!list.length) return { type: 'message', level: 'info', content: 'Nothing is allowed for this task yet. Choose “Allow for this task” on an approval to stop being asked about the same change.' };
    return {
      type: 'message', level: 'info',
      content: ['## Allowed for this task', '', ...list.map((g) => `- ${g.label} — used ${g.uses} time${g.uses === 1 ? '' : 's'} since`), '', 'Run `/grants clear` to be asked again.'].join('\n'),
    };
  },
});
