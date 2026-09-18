import { globalCommandRegistry } from './registry';
import { getKnownAgents, getCustomRules } from '../agentRouter';

// Orchestration HUD (`/orchestrate`) — the 4th cockpit from docs/TUI_GRAND_UPGRADE.md. BiMax's
// multi-agent routing (which persona handles a turn, and WHY) was invisible: /agents listed
// personas, /routes listed rules, but nothing showed them together with the active agent. This
// consolidates the orchestration picture in one view: the active persona, every known agent/persona,
// and the routing rules (pattern → agent) that steer work. Selecting a row jumps to the subsystem
// command. Read-only + registry-derived → also in the Ctrl+G palette.
globalCommandRegistry.register({
  name: '/orchestrate',
  aliases: ['/orch', '/orchestration'],
  category: 'Configuration',
  description: 'Orchestration map — active persona, all agents & routing rules',
  execute: async (_args, context) => {
    const active = context.options?.agent || 'default';
    const agents = getKnownAgents();
    const rules = getCustomRules();

    const options: { label: string; value: string; desc: string; category: string }[] = [];

    options.push({ label: active, value: '/agents', desc: 'the persona handling your turns now · Enter to switch', category: 'Active persona' });

    for (const a of agents) {
      options.push({ label: a, value: '/agents', desc: a === active ? 'active' : 'available — Enter to switch', category: 'Agents / Personas' });
    }
    if (agents.length === 0) options.push({ label: '(none registered)', value: '/agents', desc: 'Enter to manage personas', category: 'Agents / Personas' });

    if (rules.length === 0) {
      options.push({ label: '(no custom routes)', value: '/routes', desc: 'auto-routing only · Enter to add a rule', category: 'Routing Rules' });
    } else {
      for (const [pattern, agent] of rules) {
        options.push({ label: pattern, value: '/routes', desc: `→ ${agent}`, category: 'Routing Rules' });
      }
    }

    return {
      type: 'menu',
      title: 'Orchestration — who runs what, and why (Enter opens a subsystem)',
      options,
      onSelect: (opt: any) => context.executeCommand(opt.value),
    };
  },
});
