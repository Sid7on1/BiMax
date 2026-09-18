import { globalCommandRegistry, isHiddenCommand } from './registry';

// Friendlier ordering + naming for the palette's category tabs. Anything the registry knows that
// isn't listed here lands at the end under its own name.
const CATEGORY_ORDER = ['General', 'Session & Context', 'Configuration', 'Code & Intelligence', 'Source Control'];

globalCommandRegistry.register({
  name: '/help',
  description: 'All commands, grouped — with search and category tabs',
  category: 'General',
  execute: async (_args, _context) => {
    // Built FROM the registry, so /help can never drift out of date again (the old hand-written
    // list showed ~25 of 85 commands). Hidden commands stay hidden here too — they're reachable
    // by typing them in full, and listing all ~85 was the clutter /help existed to solve.
    const commands = globalCommandRegistry.getAllCommands()
      .filter(c => !isHiddenCommand(c))
      .sort((a, b) => {
        const ca = CATEGORY_ORDER.indexOf(a.category);
        const cb = CATEGORY_ORDER.indexOf(b.category);
        if (ca !== cb) return (ca < 0 ? 99 : ca) - (cb < 0 ? 99 : cb);
        return a.name.localeCompare(b.name);
      });

    return {
      type: 'menu',
      title: 'Command palette',
      subtitle: 'Enter runs the command · ←/→ move between groups · full docs: https://bimax-liard.vercel.app',
      options: commands.map(c => ({
        label: c.name,
        value: c.name,
        desc: c.description,
        category: c.category,
      })),
    };
  }
});

globalCommandRegistry.register({
  name: '/shortcuts',
  description: 'Show keyboard shortcuts',
  category: 'General',
  execute: async (_args, _context) => {
    // Handled entirely Go-side in the TUI, just registered here for autocomplete
    return { type: 'message', level: 'info', content: '' };
  }
});
