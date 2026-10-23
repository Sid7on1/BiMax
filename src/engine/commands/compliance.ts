import * as path from 'path';
import { globalCommandRegistry } from './registry';
import { loadRuleSet, InvalidRuleSet } from '../../compliance/catalog';
import { evaluateWithStore, StoreEvaluation } from '../../compliance/store';
import { RuleResult } from '../../compliance/rules';
import { getFactStore } from '../../memory/facts';

/**
 * `/compliance` — check the ingested corpus against a regulation, and say what could not be checked.
 *
 * The matrix this prints is the deliverable for a whole class of problem: does this label carry its
 * mandatory declarations, is this vessel above its minimum thickness, does this configuration meet
 * the benchmark. What makes it worth printing rather than asking a model is that every line names
 * the clause it applied and the page it read, and that the unchecked lines are *shown* rather than
 * quietly counted as passes.
 */

const MARK: Record<RuleResult['status'], string> = { fail: '✗', pass: '✓', undetermined: '?' };

function renderResult(result: RuleResult): string[] {
  const lines = [`  ${MARK[result.status]} [${result.severity}] ${result.ruleId} — ${result.title}`];
  lines.push(`      clause:   ${result.clause}`);
  lines.push(`      ${result.status === 'undetermined' ? 'not checked' : 'because'}: ${result.reason}`);
  if (result.observed) {
    lines.push(`      read from: ${result.observed.sourceName} · ${result.observed.locator}`
      + ` (${result.observed.subject})`);
  }
  if (result.remediation) lines.push(`      fix:      ${result.remediation}`);
  return lines;
}

function render(report: StoreEvaluation, setName: string, file: string): string {
  const { summary } = report;
  const lines = [
    `COMPLIANCE — ${setName}`,
    `Rules: ${file}  ·  rule set ${report.ruleSetVersion}  ·  engine ${report.engineVersion}`,
    '',
    `${summary.failed} failed · ${summary.undetermined} not checked · ${summary.passed} passed`
      + ` (of ${summary.total})`,
    '',
  ];

  if (summary.total === 0) {
    lines.push('The rule set contained no rules.');
    return lines.join('\n');
  }

  for (const result of report.results) lines.push(...renderResult(result), '');

  // The verdict, phrased so it cannot be read as more than it is. "Nothing failed" and "everything
  // was checked and passed" are different claims, and only the second is compliance.
  if (summary.compliant) {
    lines.push('COMPLIANT — every rule was checked against a fact that was actually read, and every one passed.');
  } else if (summary.failed > 0) {
    lines.push(`NOT COMPLIANT — ${summary.failed} rule${summary.failed === 1 ? '' : 's'} failed.`);
    if (summary.undetermined > 0) {
      lines.push(`A further ${summary.undetermined} could not be checked at all, so this is a floor, not a total.`);
    }
  } else {
    lines.push(`UNDETERMINED — nothing failed, but ${summary.undetermined} rule`
      + `${summary.undetermined === 1 ? '' : 's'} had no fact to check against.`);
    lines.push('That is not compliance. Ingest the documents those rules are about, then re-run.');
  }

  if (report.truncatedRules.length > 0) {
    lines.push('', `⚠ Too many matching measurements to read for: ${report.truncatedRules.join(', ')}. `
      + 'Those rules were not decided rather than decided over a partial set.');
  }
  return lines.join('\n');
}

globalCommandRegistry.register({
  name: '/compliance',
  category: 'Session & Context',
  description: 'Check ingested documents against a rule set, with the clause and page for every verdict',
  execute: async (args) => {
    const target = (args[0] || '').trim();
    if (!target) {
      return {
        type: 'message', level: 'error',
        content: 'Usage: /compliance <rules.yaml>\n\n'
          + 'A rule set is a regulation transcribed into predicates over the facts extracted at '
          + 'ingest — each rule naming the clause it enforces and what to do when it fails. Rules '
          + 'that have no fact to check against are reported as unchecked, never as passes.',
      };
    }

    let set;
    try {
      set = loadRuleSet(path.resolve(target));
    } catch (error) {
      return {
        type: 'message',
        level: 'error',
        content: error instanceof InvalidRuleSet
          ? error.message
          : `Could not load ${target}: ${(error as Error).message}`,
      };
    }

    const store = getFactStore();
    if (!store) {
      return {
        type: 'message', level: 'error',
        content: `Loaded ${set.rules.length} rule${set.rules.length === 1 ? '' : 's'} from `
          + `"${set.name}", but there is no fact store in this session, so nothing could be `
          + 'checked. Facts are extracted when documents are ingested — attach the documents '
          + 'first. Reporting every rule as passing against an empty store would be the exact '
          + 'failure this command is built to avoid.',
      };
    }

    const report = evaluateWithStore(set.rules, store, set.version);
    return {
      type: 'message',
      // Undetermined is not success. Green because nothing failed, when nothing was checked, is
      // the reading this whole subsystem exists to prevent.
      level: report.summary.compliant ? 'success' : report.summary.failed > 0 ? 'error' : 'info',
      content: render(report, set.name, path.resolve(target)),
    };
  },
});
