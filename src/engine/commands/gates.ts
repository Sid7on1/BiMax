import { globalCommandRegistry } from './registry';
import { GATES_FILE, loadGates, verdictFor } from '../../governor/change.gates';

/**
 * /gates — what would catch a mistake here?
 *
 * `/gates`               — the declared gates and what each one grades
 * `/gates <file> [file…]` — the verdict for a specific change: graded, partly graded, or unguarded
 *
 * The second form is the one that matters. It answers the question record 58 §5 left open — "can a
 * weaker model do this?" — with a property of the repository rather than a feeling about the model.
 */

globalCommandRegistry.register({
  name: '/gates',
  category: 'Code & Intelligence',
  description: 'Which deterministic check grades a change — and what is guarded by nothing',
  execute: async (args, context) => {
    const { gates, problems, declared } = loadGates(context.cwd);

    if (!declared) {
      return {
        type: 'message', level: 'info',
        content: [
          `## Gates`, '',
          `No \`${GATES_FILE}\` in this project, so **every change is unguarded** — nothing deterministic would catch a mistake, and no change is a safe candidate for a weaker model.`,
          '',
          'A gate declares four things: an `id`, the `command` that grades (exiting non-zero on failure), the `covers` globs it grades, and what a failure `meaning`s in plain language.',
        ].join('\n'),
      };
    }

    const lines: string[] = ['## Gates', ''];
    if (problems.length) {
      lines.push(`⚠ ${problems.length} declaration problem(s) — these gates were DROPPED, so the areas they claimed are unguarded:`, '');
      lines.push(...problems.map((p) => `- ${p}`), '');
    }

    const files = args.filter(Boolean);
    if (files.length === 0) {
      if (gates.length === 0) return { type: 'message', level: 'error', content: lines.concat('No usable gates.').join('\n') };
      lines.push(`${gates.length} gate(s) declared in \`${GATES_FILE}\`:`, '');
      for (const g of gates) {
        lines.push(`**\`${g.id}\`** — \`${g.command}\``);
        lines.push(`  covers: ${g.covers.map((c) => `\`${c}\``).join(', ')}${g.excludes?.length ? ` (except ${g.excludes.map((e) => `\`${e}\``).join(', ')})` : ''}`);
        lines.push(`  a failure means: ${g.meaning}`, '');
      }
      lines.push('_Run `/gates <file>` to see whether a specific change is graded by anything._');
      return { type: 'message', level: 'info', content: lines.join('\n') };
    }

    const v = verdictFor(gates, files);
    const glyph = v.cheapModelEligible ? '✅' : '⚠️';
    lines.push(
      `${glyph} **${v.routeClass}** — ${v.reason}`,
      '',
    );
    if (v.coverage.covered.length) {
      lines.push('**Graded**', '');
      for (const c of v.coverage.covered) lines.push(`- \`${c.file}\` → ${c.gates.map((g) => `\`${g}\``).join(', ')}`);
      lines.push('');
    }
    if (v.coverage.unguarded.length) {
      lines.push('**Guarded by nothing**', '');
      for (const f of v.coverage.unguarded) lines.push(`- \`${f}\``);
      lines.push('', `_Widening a gate to cover these is what makes this area cheap to work on — not trusting the model further._`);
    }
    if (v.coverage.gates.length) {
      lines.push('', '**Would run**', '', ...v.coverage.gates.map((g) => `- \`${g.command}\``));
    }

    return { type: 'message', level: v.cheapModelEligible ? 'success' : 'info', content: lines.join('\n') };
  },
});
