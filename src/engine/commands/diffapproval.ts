import { globalCommandRegistry } from './registry';
import { setDiffApprovalEnabled, isDiffApprovalEnabled } from '../diffApproval';

/**
 * /diff-approval [on|off] — when on, the agent's file edits are shown as a diff and
 * must be accepted before they are written.
 */
globalCommandRegistry.register({
  name: '/diff-approval',
  aliases: ['/diffapproval'],
  description: 'Review agent edits as a diff before they apply',
  category: 'Configuration',
  execute: async (args, context) => {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      const on = sub === 'on';
      setDiffApprovalEnabled(on);
      await context.saveConfig({ diffApproval: on });
      return { type: 'message', level: 'success', content: `Inline diff approval is ${on ? 'ON — edits will be shown for Accept/Reject before applying' : 'OFF'}.` };
    }
    return {
      type: 'menu',
      title: `Inline diff approval (currently ${isDiffApprovalEnabled() ? 'ON' : 'OFF'})`,
      options: [
        { label: '[ ON ]', value: '/diff-approval on', desc: 'Review each edit as a diff before it writes' },
        { label: '[ OFF ]', value: '/diff-approval off', desc: 'Apply edits immediately' },
      ],
      initialIndex: isDiffApprovalEnabled() ? 0 : 1,
      onSelect: (opt: any) => context.executeCommand(opt.value),
    };
  }
});
