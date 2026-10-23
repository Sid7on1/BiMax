import { globalCommandRegistry } from './registry';
import { isBlastGateEnabled } from '../blastGate';
import { isVerifyEnabled } from '../../sandbox/verify.loop';
import { isSandboxEnabled, sandboxAvailable } from '../../sandbox/exec.sandbox';
import { isGitAutoCommitEnabled } from '../../tools/git.autocommit';
import { isDiffApprovalEnabled } from '../diffApproval';
import { isSelfCriticEnabled } from '../selfCritic';

// Security Cockpit (`/security`) — one dedicated, single-glance view of BiMax's 7-layer safety
// governor (the docs/TUI_GRAND_UPGRADE.md flagship). The same toggles live scattered in /config's
// long settings list; this surfaces JUST the safety layers with their live ARMED/off state and a
// one-line "what it does", and selecting a layer jumps straight to its toggle. Trust-building:
// you can see, at a glance, exactly how locked-down the agent is. Blast-radius of a specific symbol
// stays in the dedicated /impact command (pointed to here).
globalCommandRegistry.register({
  name: '/security',
  aliases: ['/cockpit', '/sec'],
  category: 'Configuration',
  description: 'Security cockpit — armed state of all 7 governor safety layers',
  execute: async (_args, context) => {
    const mode = context.options?.governor?.mode;
    const governorArmed = mode !== 'bypass';

    // [armed, label, value(toggle cmd), what-it-does]
    const layers: [boolean, string, string, string][] = [
      [governorArmed, 'Governor (permissions)', '/governor', 'Gate tool actions behind approval (off = auto-approve everything)'],
      [isBlastGateEnabled(), 'Blast-radius gate', '/governor blast-gate', 'Confirm edits that touch HIGH/CRITICAL graph symbols'],
      [isVerifyEnabled(), 'Auto-verify edits', '/governor verify', 'Typecheck after edits and feed failures back for self-repair'],
      [isSandboxEnabled() && sandboxAvailable(), 'Bash sandbox', '/governor sandbox', sandboxAvailable() ? 'Restrict shell writes to the workspace + temp (sandbox-exec on macOS, bwrap on Linux)' : 'no OS sandbox backend on this OS (need sandbox-exec or bwrap)'],
      [isDiffApprovalEnabled(), 'Diff approval', '/diff-approval', 'Review every agent edit before it applies'],
      [isSelfCriticEnabled(), 'Self-critic', '/self-critic', 'Agent reviews its own work and fixes defects'],
      [isGitAutoCommitEnabled(), 'Auto-commit', '/autocommit', 'Commit after each successful edit (Aider-style)'],
    ];

    const armedCount = layers.filter(l => l[0]).length;
    const options = layers.map(([armed, label, value, what]) => ({
      label,
      value,
      desc: `${armed ? '● ARMED' : '○ off  '} — ${what}`,
      category: 'Safety Layers',
    }));
    // Blast-radius of a concrete symbol lives in /impact.
    options.push({ label: 'Blast radius of a symbol', value: '/impact', desc: 'Preview the downstream impact of changing a symbol', category: 'Inspect' });

    return {
      type: 'menu',
      title: `Security Cockpit — ${armedCount}/${layers.length} layers armed · Enter a layer to toggle it`,
      options,
      onSelect: (opt: any) => context.executeCommand(opt.value),
    };
  },
});
