import { globalCommandRegistry } from './registry';
import { getConfig } from '../config';
import { engineEvents } from '../events';

// /a11y — accessibility / reduced-motion toggle. Turns off the animated spinner + thinking shimmer
// in favor of calm static glyphs, which are easier on screen readers and low-noise terminals. The
// flag is read by prefersReducedMotion() (ShimmerText, WorkingIndicator). Equivalent to the
// BGW_REDUCED_MOTION env, but toggleable live without a restart.
globalCommandRegistry.register({
  name: '/a11y',
  aliases: ['/reduced-motion', '/motion'],
  category: 'Configuration',
  description: 'Accessibility: toggle reduced motion (calm static UI, no spinner/shimmer)',
  execute: async (args, context) => {
    const sub = (args[0] || '').toLowerCase();
    const cur = (() => { try { return (getConfig() as any).reducedMotion === true; } catch { return false; } })();

    if (sub === 'on' || sub === 'off') {
      const on = sub === 'on';
      await context.saveConfig({ reducedMotion: on });
      engineEvents.emit('config_changed');
      return { type: 'message', level: 'success', content: `Reduced motion is ${on ? 'ON — spinner & shimmer are static' : 'OFF — animations restored'}.` };
    }

    return {
      type: 'menu',
      title: `Reduced motion (currently ${cur ? 'ON' : 'OFF'})`,
      options: [
        { label: '[ ON ]', value: '/a11y on', desc: 'Static glyphs — calmer, screen-reader friendly' },
        { label: '[ OFF ]', value: '/a11y off', desc: 'Restore the animated spinner + thinking shimmer' },
      ],
      initialIndex: cur ? 0 : 1,
      onSelect: (opt: any) => context.executeCommand(opt.value),
    };
  },
});
