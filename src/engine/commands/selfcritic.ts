import { globalCommandRegistry } from './registry';
import { setSelfCriticEnabled, isSelfCriticEnabled } from '../selfCritic';

/**
 * /self-critic [on|off] — when on, the agent reviews its own work after each turn
 * and takes one extra pass to fix any defects it finds (costs extra tokens).
 */
globalCommandRegistry.register({
  name: '/self-critic',
  aliases: ['/critic'],
  description: 'Agent reviews & fixes its own work each turn',
  category: 'Configuration',
  execute: async (args, context) => {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      const on = sub === 'on';
      setSelfCriticEnabled(on);
      await context.saveConfig({ selfCritic: on });
      return { type: 'message', level: 'success', content: `Self-critic loop is ${on ? 'ON — the agent will review and revise its own work (uses extra tokens)' : 'OFF'}.` };
    }
    return {
      type: 'menu',
      title: `Self-critic loop (currently ${isSelfCriticEnabled() ? 'ON' : 'OFF'})`,
      options: [
        { label: 'ON', value: '/self-critic on', desc: 'Review and revise after each turn' },
        { label: 'OFF', value: '/self-critic off', desc: 'Present the first draft' },
      ],
      initialIndex: isSelfCriticEnabled() ? 0 : 1,
      onSelect: (opt: any) => context.executeCommand(opt.value),
    };
  }
});
