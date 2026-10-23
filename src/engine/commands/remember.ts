import { globalCommandRegistry } from './registry';
import { globalProjectMemory } from '../../memory/project.memory';

/**
 * /remember <fact> — manually add a durable project memory that will be recalled
 * and injected into context on future turns.
 */
globalCommandRegistry.register({
  name: '/remember',
  description: 'Save a durable project memory (convention/decision/gotcha)',
  category: 'Session & Context',
  execute: async (args) => {
    const content = args.join(' ').trim();
    if (!content) {
      return { type: 'message', level: 'error', content: 'Usage: /remember <fact to remember about this project>' };
    }
    const id = await globalProjectMemory.remember(content, 'note', ['manual']);
    return { type: 'message', level: 'success', content: id ? `🧠 Remembered: ${content}` : 'Nothing to remember.' };
  }
});
