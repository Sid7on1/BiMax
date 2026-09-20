import { globalCommandRegistry } from './registry';
import { SafetyPolicy } from '../../governor/policy.engine';
import { SpendLedger, resolveSpendContext } from '../../governor/spend.ledger';

/**
 * /spend — what today has cost, across every Bimax Thread on this Mac.
 *
 * Backlog N6/F5: Bimax measured turn time per model and never showed money. Worse, until
 * `spend.ledger.ts` there was no single number to show — each Bimax Thread kept its own daily total
 * under its own state directory, so "the" daily spend did not exist.
 */

function money(n: number): string {
  return `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}`;
}

globalCommandRegistry.register({
  name: '/spend',
  aliases: ['/budget', '/cost'],
  category: 'Configuration',
  description: "Today's spend for this Mac, by task, against the daily cap",
  execute: async () => {
    const { path: ledgerPath, scope } = resolveSpendContext();
    const cap = SafetyPolicy.maxDailySpendUsd;

    if (!ledgerPath) {
      return {
        type: 'message', level: 'info',
        content: [
          '## Spend', '',
          'No shared ledger is configured for this process, so only this engine’s own daily total applies.',
          '',
          'The desktop sets `BIMAX_SPEND_LEDGER_PATH` when it starts a Bimax Thread; a bare CLI run keeps its',
          'own per-folder total, which is the behaviour that predates the shared ledger.',
          '',
          `Daily cap: **${money(cap)}** (raise with \`MAX_DAILY_SPEND\`, or turn the cap off with \`/governor off\`).`,
        ].join('\n'),
      };
    }

    let state;
    let breakdown: Array<{ scope: string; spent: number }>;
    try {
      const ledger = new SpendLedger(ledgerPath);
      state = ledger.read(scope);
      breakdown = ledger.breakdown();
    } catch (e: any) {
      return {
        type: 'message', level: 'error',
        content: `Could not read the spend ledger at \`${ledgerPath}\`: ${e?.message || e}\n\nSpending is not blocked by this — the governor falls back to this engine’s own daily total.`,
      };
    }

    const remaining = cap > 0 ? Math.max(0, cap - state.total) : null;
    const pct = cap > 0 ? Math.round((state.total / cap) * 100) : null;

    const lines = [
      '## Spend', '',
      cap > 0
        ? `**${money(state.total)} of ${money(cap)}** today (${pct}%), **${money(remaining!)} left** — across every Bimax Thread on this Mac.`
        : `**${money(state.total)}** today. No cap is set (\`MAX_DAILY_SPEND\` is 0 or the governor is off).`,
      '',
    ];

    if (scope) {
      const share = parseFloat(process.env.BIMAX_SPEND_SCOPE_CAP || '');
      lines.push(
        Number.isFinite(share) && share > 0
          ? `This task: **${money(state.scopeTotal)} of ${money(share)}** of its own share.`
          : `This task: **${money(state.scopeTotal)}** (no per-task share set — bounded only by the Mac’s cap).`,
        '',
      );
    }

    if (breakdown.length) {
      lines.push('**By task**', '');
      for (const row of breakdown) {
        lines.push(`- \`${row.scope}\`${row.scope === scope ? ' *(this one)*' : ''} — ${money(row.spent)}`);
      }
      lines.push('');
    } else if (state.total === 0) {
      lines.push('_Nothing spent yet today._', '');
    }

    lines.push(
      `_Resets at UTC midnight. Ledger: \`${ledgerPath}\`. A per-task share is set in Bimax’s settings (\`perTaskSpendUsd\`)._`,
    );

    return { type: 'message', level: 'info', content: lines.join('\n') };
  },
});
