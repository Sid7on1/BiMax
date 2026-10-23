import { globalCommandRegistry } from './registry';
import { powerMonitor, powerSummary, powerStatusLine, powerAwarenessEnabled } from '../../governor/power.monitor';

/**
 * /power — Phase 3a. Inspect the live power posture and the throttle it's driving.
 *
 * /power         — show battery/thermal state + whether power-aware backoff is engaged
 * /power refresh — force an immediate hardware read before showing (bypasses the poll cache)
 *
 * Parity with /update: read-only, advisory. Disable the whole feature with BIMAX_POWER_AWARE=off.
 */
globalCommandRegistry.register({
  name: '/power',
  description: 'Show battery/thermal power state and any power-aware sub-agent/loop backoff',
  category: 'Configuration',
  execute: async (args) => {
    if (!powerAwarenessEnabled()) {
      return { type: 'message', level: 'info', content: 'Power-awareness is disabled (BIMAX_POWER_AWARE=off). Battery/thermal state is not being monitored.' };
    }

    if ((args[0] || '').toLowerCase() === 'refresh') {
      await powerMonitor.refresh();
    }

    const sum = powerSummary();
    const lines: string[] = [powerStatusLine(sum)];

    if (!sum.known) {
      lines.push('No hardware reading yet — the first background poll may still be pending, or this platform has no supported sensor (Bimax then assumes AC and never throttles).');
      return { type: 'message', level: 'info', content: lines.join('\n') };
    }

    if (sum.level === 'soft') {
      lines.push('');
      lines.push(`⚠️  Power-aware backoff is ACTIVE — ${sum.reason}.`);
      lines.push(`   • Parallel sub-agents capped at ${sum.maxConcurrentSubagents}.`);
      lines.push(`   • Autonomous loop paused ${Math.round(sum.loopBackoffMs / 1000)}s between steps.`);
    } else {
      lines.push('');
      lines.push('✅ No backoff — full concurrency and loop cadence.');
    }

    return { type: 'message', level: sum.level === 'soft' ? 'info' : 'success', content: lines.join('\n') };
  },
});
