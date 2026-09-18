import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { getAgentMode, AgentMode } from '../../engine/agentMode';
import { applyAgentMode } from '../../engine/applyMode';

interface ModeArgs {
  mode: AgentMode;
  reason?: string;
}

/**
 * ModeTool — lets the agent switch its OWN behavioral mode autonomously, the same modes the user
 * cycles with Shift+Tab. This is what makes the Sketch→Build loop self-driving: after concluding a
 * Blueprint in sketch mode the agent can switch itself to beast mode and build it; if it realizes
 * mid-build it needs to rethink, it can switch back to sketch. The user can always override.
 *
 * Switching to explore/sketch flips the read-only gate (the agent's own writes get blocked);
 * switching to code/beast/general restores writes — so the agent is choosing its own permissions,
 * which is the point. The governor still gates individual destructive actions in interactive mode.
 */
export const createModeTool = (governor: IGovernor) => buildTool({
  name: 'ModeTool',
  description: `Switch your own behavioral mode (the same modes the user cycles with Shift+Tab). Use this to drive the workflow yourself instead of waiting to be told.

# Modes
- **explore**: read-only reconnaissance — writes blocked. Use to map an unfamiliar codebase first.
- **sketch**: interactive architect — discuss an idea and build a level-by-level Blueprint (writes blocked except Blueprint/Plan files). Use when the user describes something to build.
- **code**: execution focus — surgical edits, verify after. Writes allowed.
- **beast**: autonomous builder — drive a goal or a saved Blueprint to a verified result (mega-pipeline, training config + monitoring). Writes allowed.
- **general**: default, no specialization.

# When to switch yourself
- Finished a Blueprint in sketch mode and the user is ready → switch to **beast** and build it.
- The build reveals the plan was wrong → switch back to **sketch** to rework it with the user.
- Asked to "just look / don't change anything" → switch to **explore**.
Always pass a short reason. Tell the user which mode you switched to and why. Prefer to confirm with the user before self-promoting from a read-only mode (sketch/explore) into a write mode (code/beast) if the change is large or risky.`,
  isDestructive: false,
  isConcurrencySafe: true,
  schema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['explore', 'sketch', 'code', 'beast', 'general'], description: 'The mode to switch into.' },
      reason: { type: 'string', description: 'One short sentence on why you are switching (shown to the user).' },
    },
    required: ['mode'],
  },
  execute: async (args: ModeArgs) => {
    const valid: AgentMode[] = ['explore', 'sketch', 'code', 'beast', 'general'];
    if (!valid.includes(args.mode)) return `Error: unknown mode "${args.mode}". Valid: ${valid.join(', ')}.`;
    const from = getAgentMode();
    if (from === args.mode) return `Already in ${args.mode} mode.`;
    applyAgentMode(args.mode, governor);
    const writes = args.mode === 'explore' || args.mode === 'sketch' ? 'writes are now BLOCKED (read-only)' : 'writes are now allowed';
    return `Switched mode: ${from} → ${args.mode}${args.reason ? ` (${args.reason})` : ''}. ${writes}. Continue working in this mode.`;
  },
}, governor);
