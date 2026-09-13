/**
 * Deterministic compliance rules over extracted facts.
 *
 * ## Why the model does not decide this
 *
 * "Does this packaged commodity declare an MRP?" and "is this shell course above its minimum
 * allowable thickness?" are the same shape of question: a regulation states a requirement, a
 * document states a measurement, and something has to compare them. Asking a language model to do
 * the comparing puts the one step that must be reproducible inside the one component that is not.
 * Two runs can disagree, neither can cite the clause it applied, and a regulator cannot re-derive
 * the verdict.
 *
 * So the model reads documents and `facts.ts` turns table rows into `Fact`s; this file compares
 * those facts to rules that are data. The division is the same one `evidence/boundary.ts` makes for
 * a different domain and for the same reason: an authorization path carries "precompiled, bounded,
 * deterministic policy" and nothing else.
 *
 * ## The decision that matters most: absence is not compliance
 *
 * A rule whose fact is missing returns `undetermined`, never `pass`. This is the whole reason to
 * write the engine carefully. A compliance matrix that renders a missing declaration as a tick is
 * worse than having no matrix, because it converts "we did not look" into "we checked and it was
 * fine" — and the person reading it cannot tell the difference. `facts.ts` already refuses to invent
 * a fact it did not read; this refuses to invent a verdict it did not reach.
 *
 * The same applies to units. `facts.ts` never guesses a unit the document does not state, so a value
 * whose unit is unknown, or stated in something other than what the rule names, is `undetermined`.
 * No conversion happens here. A silent inches-to-millimetres assumption is exactly the sort of thing
 * that produces a confident number and a wrong answer.
 */

import { Fact } from '../memory/facts';

/** Bump when the semantics of evaluation change. Every report records it. */
export const ENGINE_VERSION = 'bimax.compliance/1.0.0';

export type Comparison = 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'ne';

/** How much a failure matters. Ordered, so a report can rank without a lookup table. */
export const SEVERITIES = ['minor', 'major', 'critical'] as const;
export type Severity = typeof SEVERITIES[number];
export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

export type Requirement =
  /** The fact must exist at all — the shape most declaration rules take. */
  | { kind: 'present' }
  /** The fact's value must stand in this relation to `value`, in `unit`. */
  | { kind: 'compare'; op: Comparison; value: number; unit: string };

export interface ComplianceRule {
  /** Stable identifier, carried into every result and never reused for different semantics. */
  id: string;
  /**
   * The normative citation this rule enforces — a statute rule number, a standard clause, a
   * benchmark control. Required, because a finding that cannot name the clause it applied is an
   * opinion, and the entire point of the exercise is to produce something a regulator can check.
   */
  clause: string;
  title: string;
  severity: Severity;
  /** Which measured property this is about. Matched case-insensitively and trimmed. */
  property: string;
  /** Restrict to one subject (an equipment tag, a product id). Absent means every subject. */
  subject?: string;
  requirement: Requirement;
  /**
   * What to do about a failure. Required: a rule that can say something is wrong but not what to do
   * about it produces an alarm, and alarms without remedies are the reason compliance dashboards
   * get ignored.
   */
  remediation: string;
}

export type RuleStatus = 'pass' | 'fail' | 'undetermined';

/** The fact that decided a result, kept so the verdict stays as citable as a quotation. */
export interface ObservedFact {
  subject: string;
  value: number;
  unit: string | null;
  sourceName: string;
  locator: string;
}

export interface RuleResult {
  ruleId: string;
  clause: string;
  title: string;
  severity: Severity;
  status: RuleStatus;
  /** Why this status, in the operator's language. Always present, including on a pass. */
  reason: string;
  /** The subject this result is about, when the rule resolved to one. */
  subject?: string;
  observed?: ObservedFact;
  /** Only on a failure. A remediation printed beside a pass trains people to ignore it. */
  remediation?: string;
}

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

function compare(op: Comparison, left: number, right: number): boolean {
  switch (op) {
    case 'lt': return left < right;
    case 'lte': return left <= right;
    case 'gt': return left > right;
    case 'gte': return left >= right;
    case 'eq': return left === right;
    case 'ne': return left !== right;
  }
}

/** How the comparison reads in a sentence, so the reason states the rule rather than an operator. */
const PHRASE: Record<Comparison, string> = {
  lt: 'below', lte: 'at most', gt: 'above', gte: 'at least', eq: 'exactly', ne: 'other than',
};

function observedOf(fact: Fact): ObservedFact {
  return {
    subject: fact.subject,
    value: fact.value,
    unit: fact.unit,
    sourceName: fact.sourceName,
    locator: fact.locator,
  };
}

/** Facts a rule is about: matching property, and matching subject when the rule names one. */
export function factsForRule(rule: ComplianceRule, facts: readonly Fact[]): Fact[] {
  const property = normalise(rule.property);
  const subject = rule.subject ? normalise(rule.subject) : null;
  return facts.filter((fact) =>
    normalise(fact.property) === property && (!subject || normalise(fact.subject) === subject));
}

/**
 * Evaluate one rule against one fact.
 *
 * Split out from {@link evaluateRule} because the unit reasoning is the subtle part and deserves to
 * be readable and testable on its own.
 */
export function evaluateFact(rule: ComplianceRule, fact: Fact): RuleResult {
  const base = {
    ruleId: rule.id,
    clause: rule.clause,
    title: rule.title,
    severity: rule.severity,
    subject: fact.subject,
    observed: observedOf(fact),
  };

  if (rule.requirement.kind === 'present') {
    return { ...base, status: 'pass', reason: `${rule.property} is declared (${fact.value}${fact.unit ? ` ${fact.unit}` : ''})` };
  }

  const { op, value, unit } = rule.requirement;

  // Units first. A comparison between quantities in different units is not a strict comparison, and
  // converting silently is how a confident number becomes a wrong answer.
  if (fact.unit === null) {
    return {
      ...base,
      status: 'undetermined',
      reason: `the document states no unit for ${rule.property}, and the rule is expressed in ${unit}. `
        + 'No unit was assumed.',
    };
  }
  if (normalise(fact.unit) !== normalise(unit)) {
    return {
      ...base,
      status: 'undetermined',
      reason: `measured in ${fact.unit} but the rule is expressed in ${unit}. No conversion was `
        + 'performed, so this could not be checked.',
    };
  }

  const passed = compare(op, fact.value, value);
  return passed
    ? { ...base, status: 'pass', reason: `${fact.value} ${fact.unit} is ${PHRASE[op]} ${value} ${unit}` }
    : {
      ...base,
      status: 'fail',
      reason: `${fact.value} ${fact.unit} is not ${PHRASE[op]} ${value} ${unit}`,
      remediation: rule.remediation,
    };
}

/**
 * Evaluate one rule against a fact set.
 *
 * With several matching facts the WORST status wins — a rule that holds for four shell courses and
 * fails on the fifth has failed. `undetermined` outranks `pass` for the same reason absence does:
 * a partially checked rule has not been checked.
 */
export function evaluateRule(rule: ComplianceRule, facts: readonly Fact[]): RuleResult {
  const matching = factsForRule(rule, facts);

  if (matching.length === 0) {
    return {
      ruleId: rule.id,
      clause: rule.clause,
      title: rule.title,
      severity: rule.severity,
      status: 'undetermined',
      // Deliberately not "pass". Nothing was read that bears on this rule, and saying otherwise
      // converts "we did not look" into "we checked and it was fine".
      reason: rule.subject
        ? `no ${rule.property} was read for ${rule.subject}, so this could not be checked`
        : `no ${rule.property} was read in any ingested document, so this could not be checked`,
      ...(rule.subject ? { subject: rule.subject } : {}),
    };
  }

  const results = matching.map((fact) => evaluateFact(rule, fact));
  const worst = (status: RuleStatus): number => (status === 'fail' ? 2 : status === 'undetermined' ? 1 : 0);
  return results.reduce((a, b) => (worst(b.status) > worst(a.status) ? b : a));
}

export interface ComplianceReport {
  engineVersion: string;
  /** Version of the rule set that produced this, so a verdict can be re-derived. */
  ruleSetVersion: string;
  results: RuleResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    undetermined: number;
    /** True only when every rule reached a verdict AND every verdict was a pass. */
    compliant: boolean;
  };
}

/**
 * Evaluate a rule set and summarise it.
 *
 * `compliant` requires that nothing is undetermined. A document that failed nothing because nothing
 * could be checked is not compliant, and a summary that reported it as such would be the exact lie
 * this module is built to avoid.
 */
export function evaluate(
  rules: readonly ComplianceRule[],
  facts: readonly Fact[],
  ruleSetVersion: string,
): ComplianceReport {
  const results = rules.map((rule) => evaluateRule(rule, facts));
  const failed = results.filter((r) => r.status === 'fail').length;
  const undetermined = results.filter((r) => r.status === 'undetermined').length;
  const passed = results.filter((r) => r.status === 'pass').length;

  // Worst first: failures by severity, then the unchecked, then the passes. An operator reads the
  // top of this list and nothing else.
  const order = (r: RuleResult) => (r.status === 'fail' ? 0 : r.status === 'undetermined' ? 1 : 2);
  results.sort((a, b) => order(a) - order(b)
    || severityRank(b.severity) - severityRank(a.severity)
    || a.ruleId.localeCompare(b.ruleId));

  return {
    engineVersion: ENGINE_VERSION,
    ruleSetVersion,
    results,
    summary: { total: results.length, passed, failed, undetermined, compliant: failed === 0 && undetermined === 0 },
  };
}
