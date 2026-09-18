import { globalCommandRegistry } from './registry';
import { engineEvents } from '../events';

// /tier — manual model-tier control, the discoverable twin of the Ctrl+T chord. BiMax routes each
// turn to the LITE model and auto-escalates to the HEAVY coding model when a turn needs it. This
// pins that choice: `/tier heavy` forces every turn onto the coding model, `/tier lite` forces the
// fast model, `/tier auto` restores automatic routing. Drives the same pin Ctrl+T toggles, via the
// `set_tier` event handled in FullScreen.
const VALID = new Set(['auto', 'lite', 'heavy']);

globalCommandRegistry.register({
  name: '/tier',
  aliases: ['/model-tier', '/route'],
  category: 'Configuration',
  description: 'Pin turn routing — auto (default) · Quick · Work (also: Ctrl+T)',
  execute: async (args, context) => {
    const sub = (args[0] || '').toLowerCase();

    if (VALID.has(sub)) {
      // set_tier already emits a `status` (shown in the footer) AND `model_tier` (flips the footer's
      // model pointer), so the change is visible without a transcript line. Returning a message too
      // means rapid Ctrl+T cycling stacks redundant "Routing pinned →" lines in the chat — so we don't.
      engineEvents.emit('set_tier', sub as 'auto' | 'lite' | 'heavy');
      return { type: 'none' } as any;
    }

    return {
      type: 'menu',
      title: 'Turn routing — which model handles your turns',
      options: [
        { label: 'Auto', value: '/tier auto', desc: 'Quick answers; escalates to the Work model when a turn needs it (default)' },
        { label: 'Quick', value: '/tier lite', desc: 'Pin the Quick model for every turn' },
        { label: 'Work', value: '/tier heavy', desc: 'Pin the Work model for every turn' },
      ],
      onSelect: (opt: any) => context.executeCommand(opt.value),
    };
  },
});
