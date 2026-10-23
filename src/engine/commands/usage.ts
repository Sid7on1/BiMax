import { globalCommandRegistry } from './registry';
import { getUsageCounters } from '../../mind/usage.counters';
import { getActiveToolRegistry } from '../../tools/tool.registry';

/**
 * /usage — what does this install actually use?
 *
 * The retirement pass on 2026-09-19 removed ~4,300 lines on the strength of a SQLite query and five
 * empty directories (docs/product-reset/58), and then had to stop: the remaining candidates leave no
 * trace, so nobody could say whether they were load-bearing or dead. This command is the answer to
 * that, and it is deliberately blunt about what it does NOT know yet.
 *
 * `/usage`        — commands and tools by count, plus what has never run
 * `/usage tools`  — tools only
 * `/usage unused` — only the never-run list, which is the retirement question
 */

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function table(title: string, entries: Array<[string, { n: number; last: number }]>, now: number): string[] {
  if (entries.length === 0) return [`**${title}** — nothing recorded yet.`, ''];
  const width = Math.max(...entries.map(([name]) => name.length));
  return [
    `**${title}** (${entries.length})`,
    '',
    ...entries.map(([name, e]) => `- \`${name.padEnd(width)}\`  ${String(e.n).padStart(5)} ×   ${ago(e.last, now)}`),
    '',
  ];
}

globalCommandRegistry.register({
  name: '/usage',
  category: 'Code & Intelligence',
  description: 'What this install actually uses — command and tool counts, and what has never run',
  execute: async (args) => {
    const sub = (args[0] || '').toLowerCase();
    const counters = getUsageCounters();
    counters.flush();
    const snap = counters.snapshot();
    const now = Date.now();

    const registeredCommands = globalCommandRegistry.getAllCommands().map((c) => c.name);
    // Null outside an interactive container (a worker, a proof harness). Then we know the counts
    // but not the denominator, so the never-run list is withheld rather than guessed at from an
    // empty array — which would report every tool as dead.
    const registeredTools = getActiveToolRegistry()?.getToolNames() ?? null;
    const unusedCommands = counters.neverUsed('command', registeredCommands);
    const unusedTools = registeredTools ? counters.neverUsed('tool', registeredTools) : null;

    const byCount = (b: Record<string, { n: number; last: number }>) =>
      Object.entries(b).sort((x, y) => y[1].n - x[1].n || x[0].localeCompare(y[0]));

    const observed = Math.max(0, now - snap.since);
    const lines: string[] = [
      '## Usage',
      '',
      `Counting since ${new Date(snap.since).toISOString().slice(0, 16).replace('T', ' ')} — **${ago(snap.since, now).replace(' ago', '')} of observation**.`,
      '',
    ];

    // The honest caveat first, because a short window makes "never used" meaningless and this is
    // exactly the number someone will quote in a retirement argument.
    if (observed < 7 * 24 * 3600_000) {
      lines.push(
        `> ⚠ Short window. "Never run" below means *not seen in this window*, not *dead*. A seasonal`,
        `> command (\`/changelog\`, \`/compliance\`) can be entirely healthy and absent for a month.`,
        `> Treat this as evidence only once the window is longer than the feature's natural cadence.`,
        '',
      );
    }

    if (sub !== 'tools' && sub !== 'unused') lines.push(...table('Commands used', byCount(snap.commands), now));
    if (sub !== 'unused' && sub !== 'commands') lines.push(...table('Tools used', byCount(snap.tools), now));

    if (sub !== 'tools' && sub !== 'commands') {
      lines.push(
        `**Never run in this window**`,
        '',
        `- commands: ${unusedCommands.length}/${registeredCommands.length}${unusedCommands.length ? ` — ${unusedCommands.map((c) => `\`${c}\``).join(', ')}` : ''}`,
        unusedTools && registeredTools
          ? `- tools: ${unusedTools.length}/${registeredTools.length}${unusedTools.length ? ` — ${unusedTools.map((t) => `\`${t}\``).join(', ')}` : ''}`
          : '- tools: not available here (no tool registry in this process)',
        '',
        '_Names only — no arguments, prompts or paths are recorded. Stored in `.bimax/usage.json`._',
      );
    }

    return { type: 'message', level: 'info', content: lines.join('\n') };
  },
});
