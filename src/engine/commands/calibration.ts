import { globalCommandRegistry } from './registry';
import { getEpistemicLedger, EpistemicLedger } from '../../mind/epistemic.ledger';

/**
 * /calibration — "How honest is my confidence?"
 *
 * A reliability diagram over the epistemic ledger's resolved claims: for each stated-confidence
 * decile, how often the agent was actually right. Pure presentation — it reuses the ledger's
 * existing calibration API (ece / calibration / isotonicCurve / overconfidentDomains), which is
 * populated as a normal side-effect of the agent working (a claim opens on an edit and resolves
 * when a build/test run names or clears the touched files). No new subsystem, no new state.
 *
 * This is the surface that makes BiMax's differentiator visible: an agent that shows you, with
 * receipts, whether its stated confidence is earned.
 */

// A width-cell reliability track: observed accuracy filled with █, the IDEAL (stated) point marked
// with ┃, remaining track dotted. When observed < ideal the fill stops left of the mark
// (overconfident); when observed > ideal it runs past it (underconfident).
export function reliabilityTrack(observed: number, ideal: number, width = 22): string {
  const clamp = (n: number) => Math.max(0, Math.min(width, n));
  const fill = clamp(Math.round(observed * width));
  const mark = clamp(Math.round(ideal * width));
  let out = '';
  for (let i = 0; i < width; i++) {
    if (i === mark) out += '┃';
    else if (i < fill) out += '█';
    else out += '·';
  }
  return out;
}

/** Pure renderer over any EpistemicLedger — the message content for /calibration. Testable. */
export function renderCalibration(ledger: EpistemicLedger): string {
    const rows = ledger.calibration();
    const s = ledger.stats();
    const resolved = Math.round(s.resolved * 10) / 10;

    if (rows.length === 0) {
      return (
        '● **Calibration** — not enough evidence yet.\n\n' +
        'A claim opens whenever I make a confident change and resolves when a build or test run ' +
        'names (or clears) the files it touched. Run a build/test after some edits and the ' +
        'reliability curve fills in.\n\n' +
        `_Currently: ${s.open} open claim(s), ${resolved} resolved, ${s.expired} expired unverified._`
      );
    }

    const ecePct = Math.round(ledger.ece() * 100);
    const verdict = ecePct <= 5 ? 'well-calibrated' : ecePct <= 12 ? 'slightly off' : 'poorly calibrated';
    const iso = ledger.isotonicCurve();
    const over = ledger.overconfidentDomains();

    const lines: string[] = [];
    lines.push(`● **Calibration — how honest my confidence is**`);
    lines.push('');
    lines.push(`  **ECE ${ecePct}%** · ${verdict} · ${resolved} resolved claim(s)`);
    lines.push('');
    lines.push('  `stated       n   observed   reliability  (┃ = ideal)`');
    for (const r of rows) {
      // Decile midpoint is the "ideal" the diagonal would predict for this bin.
      const midMatch = r.range.match(/^(\d+)/);
      const lo = midMatch ? parseInt(midMatch[1], 10) : 0;
      const ideal = (lo + 5) / 100;
      const track = reliabilityTrack(r.observed, ideal);
      const gap = Math.round((r.observed - ideal) * 100);
      const tag = gap <= -6 ? 'overconfident' : gap >= 6 ? 'underconfident' : 'on target';
      const range = r.range.padEnd(11);
      const n = String(Math.round(r.n * 10) / 10).padStart(4);
      const obs = `${Math.round(r.observed * 100)}%`.padStart(4);
      lines.push('  `' + `${range}${n}   ${obs}    ${track}` + '`' + `  ${gap >= 0 ? '+' : ''}${gap}% ${tag}`);
    }
    lines.push('');

    // The isotonic (monotone) fit is the honest "when I say X, I'm really right ~Y" translation.
    if (iso.length > 0) {
      const top = iso[iso.length - 1];
      lines.push(
        `  _Isotonic-corrected: when I claim **${Math.round(top.stated * 100)}%**, I'm actually ` +
        `right about **${Math.round(top.corrected * 100)}%** of the time._`,
      );
    }
    if (over.length > 0) {
      lines.push(
        `  ⚠ **Overconfident in:** ${over.map(o => `\`${o.domain}\` (${Math.round(o.stated * 100)}%→${Math.round(o.observed * 100)}%)`).join(', ')} ` +
        `— verification is escalated in these domains automatically.`,
      );
    } else {
      lines.push('  ✓ No domain shows a significant overconfidence gap.');
    }

    return lines.join('\n');
}

globalCommandRegistry.register({
  name: '/calibration',
  aliases: ['/calibrate'],
  description: 'Reliability diagram — how often my stated confidence turns out right',
  category: 'Code & Intelligence',
  execute: async () => ({ type: 'message', level: 'info', content: renderCalibration(getEpistemicLedger()) }),
});
