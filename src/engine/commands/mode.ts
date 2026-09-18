import { globalCommandRegistry } from './registry';
import { getAgentMode, AgentMode } from '../agentMode';
import { applyAgentMode } from '../applyMode';

/**
 * /mode — switch the agent's behavioral specialization (UPGRADE-PLAN 5.2).
 *
 * /mode explore   → read-only reconnaissance (writes blocked via the governor's plan gate)
 * /mode code      → execution focus (minimal reads, surgical edits, verify after)
 * /mode general   → default behaviour (no specialization)
 * /mode           → show the current mode + a picker
 *
 * This sits above the brand persona (/agents) and shapes the system prompt. Explore/sketch additionally
 * flip the governor into plan mode so the read-only guarantee is actually enforced, not just
 * suggested; switching to code/beast/general restores normal write permissions. The switch itself
 * lives in applyAgentMode() (shared with Shift+Tab and ModeTool).
 */
// Switch mode. Deliberately emits NO transcript message — the TUI shows the active mode as a bold
// footer chip (driven by the mode_change event), so cycling modes doesn't clutter the conversation.
function applyMode(mode: AgentMode, context: any): { type: 'none' } {
  applyAgentMode(mode, context.options.governor);
  return { type: 'none' };
}

globalCommandRegistry.register({
  name: '/mode',
  description: 'Switch agent behavioral mode — explore (read-only) · code (execution) · general',
  category: 'General',
  execute: async (args, context) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'explore' || sub === 'code' || sub === 'general' || sub === 'sketch' || sub === 'beast') {
      return applyMode(sub as AgentMode, context);
    }

    if (sub) {
      return { type: 'message', level: 'error', content: `Unknown mode "${sub}". Valid: explore, sketch, code, beast, general.` };
    }

    const current = getAgentMode();
    return {
      type: 'menu',
      title: `Agent mode (current: ${current})`,
      options: [
        { label: 'explore', value: 'explore', desc: 'Read-only reconnaissance — map the codebase, writes blocked', category: 'Modes' },
        { label: 'sketch', value: 'sketch', desc: 'Interactive architect — discuss an idea → level-by-level Blueprint (writes blocked)', category: 'Modes' },
        { label: 'code', value: 'code', desc: 'Execution focus — minimal reads, surgical edits, verify after', category: 'Modes' },
        { label: 'beast', value: 'beast', desc: 'Autonomous builder — drive a goal/Blueprint to a verified result', category: 'Modes' },
        { label: 'general', value: 'general', desc: 'Default behaviour — no specialization', category: 'Modes' },
      ],
      onSelect: (opt: any) => {
        // Switching emits a transient footer one-liner (mode_change) — no transcript message.
        applyMode(opt.value as AgentMode, context);
      },
    };
  },
});
