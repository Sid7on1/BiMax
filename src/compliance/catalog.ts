/**
 * Rule sets as data on disk.
 *
 * A rule set is a regulation transcribed into predicates: the Legal Metrology declarations, a CIS
 * benchmark, the minimum thicknesses in an inspection standard. It is data rather than code so that
 * adding a domain is a file someone can review against the statute, side by side, without reading
 * TypeScript — and so that the person who can check the transcription is the person who can change
 * it.
 *
 * ## Rule content is untrusted input
 *
 * `capability/manifest.ts` is emphatic that parsing a manifest grants nothing, and the same applies
 * here for a different reason. A rule set decides whether something is reported as compliant, so a
 * malformed one must never be quietly partially loaded. Three rules silently dropped for a typo,
 * followed by a report that says everything passed, is precisely the failure this subsystem exists
 * to prevent — and it would be invisible, because the dropped rules leave no trace in the output.
 *
 * So validation is all-or-nothing and it names every problem it found, not just the first.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ComplianceRule, Comparison, Severity, SEVERITIES } from './rules';

export interface RuleSet {
  /** Human name of the regulation, e.g. "Legal Metrology (Packaged Commodities) Rules, 2011". */
  name: string;
  /** Bumped by the author when a rule changes. Recorded in every report so a verdict is re-derivable. */
  version: string;
  rules: ComplianceRule[];
}

export class InvalidRuleSet extends Error {
  constructor(public readonly problems: string[], source: string) {
    super(
      `${source} is not a usable rule set:\n  - ${problems.join('\n  - ')}\n`
      + 'Nothing was loaded. A partially loaded rule set would report the rules it dropped as '
      + 'neither passed nor failed — they would simply be absent from the matrix, which reads as '
      + 'though they had never been required.',
    );
    this.name = 'InvalidRuleSet';
  }
}

const COMPARISONS: ReadonlySet<string> = new Set<Comparison>(['lt', 'lte', 'gt', 'gte', 'eq', 'ne']);

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validate one rule, returning every problem with it rather than the first. */
function problemsWithRule(raw: unknown, index: number): string[] {
  const where = `rule[${index}]`;
  if (!raw || typeof raw !== 'object') return [`${where} is not an object`];
  const rule = raw as Record<string, unknown>;
  const problems: string[] = [];
  const label = nonEmptyString(rule.id) ? `rule "${rule.id}"` : where;

  if (!nonEmptyString(rule.id)) problems.push(`${where} has no id`);
  if (!nonEmptyString(rule.clause)) {
    // The clause is what makes a finding checkable by someone who does not trust us.
    problems.push(`${label} cites no clause — a finding that cannot name the rule it applied is an opinion`);
  }
  if (!nonEmptyString(rule.title)) problems.push(`${label} has no title`);
  if (!nonEmptyString(rule.property)) problems.push(`${label} names no property to measure`);
  if (!nonEmptyString(rule.remediation)) {
    problems.push(`${label} has no remediation — a rule that cannot say what to do about a failure produces an alarm, not a finding`);
  }
  if (!SEVERITIES.includes(rule.severity as Severity)) {
    problems.push(`${label} has severity "${String(rule.severity)}"; expected one of ${SEVERITIES.join(', ')}`);
  }
  if (rule.subject !== undefined && !nonEmptyString(rule.subject)) {
    problems.push(`${label} has an empty subject; omit it entirely to apply to every subject`);
  }

  const requirement = rule.requirement as Record<string, unknown> | undefined;
  if (!requirement || typeof requirement !== 'object') {
    problems.push(`${label} has no requirement`);
  } else if (requirement.kind === 'present') {
    // Nothing further to check.
  } else if (requirement.kind === 'compare') {
    if (!COMPARISONS.has(String(requirement.op))) {
      problems.push(`${label} has comparison "${String(requirement.op)}"; expected one of ${[...COMPARISONS].join(', ')}`);
    }
    if (typeof requirement.value !== 'number' || !Number.isFinite(requirement.value)) {
      problems.push(`${label} compares against a non-numeric value`);
    }
    if (!nonEmptyString(requirement.unit)) {
      // No unit means the engine cannot refuse a mismatched comparison, which is the one guard
      // standing between a millimetre and an inch.
      problems.push(`${label} states no unit; the engine never assumes one, so the rule could never be applied`);
    }
  } else {
    problems.push(`${label} has requirement kind "${String(requirement.kind)}"; expected "present" or "compare"`);
  }

  return problems;
}

/** Validate a parsed rule set. Returns the problems; an empty array means it is usable. */
export function problemsWithRuleSet(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return ['the file does not contain an object'];
  const set = raw as Record<string, unknown>;
  const problems: string[] = [];

  if (!nonEmptyString(set.name)) problems.push('the rule set has no name');
  if (!nonEmptyString(set.version)) {
    problems.push('the rule set has no version — a report that cannot name the rules it applied cannot be re-derived');
  }
  if (!Array.isArray(set.rules)) {
    problems.push('the rule set has no rules array');
    return problems;
  }
  if (set.rules.length === 0) problems.push('the rule set contains no rules');

  set.rules.forEach((rule, index) => problems.push(...problemsWithRule(rule, index)));

  // Duplicate ids are worse than a typo: two rules sharing an id make the report ambiguous about
  // which one produced a finding, and a fix applied to one silently leaves the other in place.
  const seen = new Map<string, number>();
  set.rules.forEach((rule, index) => {
    const id = (rule as { id?: unknown })?.id;
    if (!nonEmptyString(id)) return;
    if (seen.has(id)) problems.push(`rule "${id}" is defined twice (rule[${seen.get(id)}] and rule[${index}])`);
    else seen.set(id, index);
  });

  return problems;
}

/** Parse and validate a rule set from JSON or YAML. Throws {@link InvalidRuleSet} on any problem. */
export function parseRuleSet(text: string, source = '<inline>'): RuleSet {
  let raw: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('js-yaml');
    // YAML is a superset of JSON, so one parser reads both and the file extension does not decide.
    raw = yaml.load(text);
  } catch (error) {
    throw new InvalidRuleSet([`could not be parsed: ${(error as Error).message}`], source);
  }

  const problems = problemsWithRuleSet(raw);
  if (problems.length > 0) throw new InvalidRuleSet(problems, source);
  return raw as RuleSet;
}

export function loadRuleSet(file: string): RuleSet {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new InvalidRuleSet([`could not be read: ${(error as Error).message}`], file);
  }
  return parseRuleSet(text, path.basename(file));
}
