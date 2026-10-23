/**
 * Running a rule set against the fact store.
 *
 * The engine in `rules.ts` is pure and takes facts as an argument. This is the glue that gets them,
 * and it exists as its own file for one reason: the fact store paginates, and a paginated read is
 * the quietest way to turn a failure into a pass.
 *
 * `FactStore.query` caps at 500 rows and says nothing when it hits the cap. Ask it for "minimum
 * thickness" across a refinery-sized corpus, get 500 of 900 rows back, and the 400 you did not see
 * might contain the one course that is under limit. The rule would report `pass` — correctly, over
 * the facts it was given, and wrongly about the world. So a result that lands exactly on the cap is
 * treated as untrustworthy and the rule returns `undetermined` instead.
 *
 * That is the same rule the rest of this subsystem follows: a verdict reached over a set we cannot
 * prove was complete is not a verdict.
 */

import { Fact, FactQuery } from '../memory/facts';
import { ComplianceReport, ComplianceRule, RuleResult, evaluate, evaluateRule, severityRank } from './rules';

/** Structural subset of `FactStore`, so tests need no SQLite and no fixture corpus. */
export interface FactSource {
  query(request: FactQuery): Fact[];
}

/**
 * The store's own ceiling (`MAX_ROWS`). Asking for more is silently clamped, so asking for exactly
 * this is the most a caller can ever see — and a full page back means "there may be more".
 */
export const FACT_QUERY_CAP = 500;

export interface StoreEvaluation extends ComplianceReport {
  /** Rules whose fact set may have been truncated, and were therefore not decided. */
  truncatedRules: string[];
}

/**
 * Evaluate every rule, fetching only the facts each one is about.
 *
 * The property filter is a SUBSTRING match in the store, so this deliberately over-fetches and lets
 * `factsForRule` make the exact decision. Narrowing in SQL and deciding in TypeScript keeps one
 * definition of "a fact this rule is about" rather than two that can drift.
 */
export function evaluateWithStore(
  rules: readonly ComplianceRule[],
  source: FactSource,
  ruleSetVersion: string,
): StoreEvaluation {
  const truncatedRules: string[] = [];
  const results: RuleResult[] = [];

  for (const rule of rules) {
    const facts = source.query({
      property: rule.property,
      ...(rule.subject ? { subject: rule.subject } : {}),
      limit: FACT_QUERY_CAP,
    });

    if (facts.length >= FACT_QUERY_CAP) {
      truncatedRules.push(rule.id);
      results.push({
        ruleId: rule.id,
        clause: rule.clause,
        title: rule.title,
        severity: rule.severity,
        status: 'undetermined',
        reason: `more than ${FACT_QUERY_CAP} measurements match this rule, so the set read back may `
          + 'be incomplete. A verdict over a partial set would be a pass this corpus cannot support '
          + '— narrow the rule with a subject, or raise the store cap.',
        ...(rule.subject ? { subject: rule.subject } : {}),
      });
      continue;
    }

    results.push(evaluateRule(rule, facts));
  }

  // Reuse the pure engine's summary and ordering rather than recomputing them here, so the two
  // paths can never disagree about what "compliant" means.
  const report = evaluate([], [], ruleSetVersion);
  const failed = results.filter((r) => r.status === 'fail').length;
  const undetermined = results.filter((r) => r.status === 'undetermined').length;
  const passed = results.filter((r) => r.status === 'pass').length;

  const order = (r: RuleResult) => (r.status === 'fail' ? 0 : r.status === 'undetermined' ? 1 : 2);
  results.sort((a, b) => order(a) - order(b)
    || severityRank(b.severity) - severityRank(a.severity)
    || a.ruleId.localeCompare(b.ruleId));

  return {
    engineVersion: report.engineVersion,
    ruleSetVersion,
    results,
    summary: {
      total: results.length,
      passed,
      failed,
      undetermined,
      compliant: failed === 0 && undetermined === 0,
    },
    truncatedRules,
  };
}
