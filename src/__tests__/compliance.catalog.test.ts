import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseRuleSet, loadRuleSet, problemsWithRuleSet, InvalidRuleSet } from '../compliance/catalog';
import { evaluate } from '../compliance/rules';

/**
 * Loading is all-or-nothing, and that is the point of the suite.
 *
 * A rule set decides what gets reported as compliant, so a malformed one must never be partially
 * loaded. Three rules quietly dropped for a typo, followed by a matrix that says everything passed,
 * is invisible in the output — the dropped rules do not appear as failures or as unchecked, they
 * simply are not there, which reads exactly as though they had never been required.
 */

const VALID = `
name: Legal Metrology (Packaged Commodities) Rules, 2011
version: lm-2011@3
rules:
  - id: LM-2011-MRP
    clause: r.6(1)(e)
    title: Retail sale price is declared
    severity: major
    property: mrp
    requirement: { kind: present }
    remediation: Print "MRP Rs. <amount> inclusive of all taxes".
  - id: LM-2011-NET-QTY-MIN
    clause: r.6(1)(d)
    title: Net quantity is declared and non-zero
    severity: critical
    property: net quantity
    requirement: { kind: compare, op: gt, value: 0, unit: g }
    remediation: Declare the net quantity in grams.
`;

describe('a well-formed rule set loads', () => {
  it('parses YAML and keeps every rule', () => {
    const set = parseRuleSet(VALID);
    expect(set.name).toContain('Legal Metrology');
    expect(set.version).toBe('lm-2011@3');
    expect(set.rules).toHaveLength(2);
    expect(problemsWithRuleSet(set)).toEqual([]);
  });

  it('parses JSON too, because YAML is a superset and the extension should not decide', () => {
    const set = parseRuleSet(JSON.stringify({
      name: 'x', version: '1', rules: [{
        id: 'A', clause: 'c', title: 't', severity: 'minor', property: 'p',
        requirement: { kind: 'present' }, remediation: 'do the thing',
      }],
    }));
    expect(set.rules).toHaveLength(1);
  });

  it('feeds straight into the engine', () => {
    const set = parseRuleSet(VALID);
    const report = evaluate(set.rules, [], set.version);
    expect(report.ruleSetVersion).toBe('lm-2011@3');
    expect(report.summary.undetermined).toBe(2);
  });

  it('round-trips from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-rules-'));
    try {
      const file = path.join(dir, 'lm-2011.yaml');
      fs.writeFileSync(file, VALID);
      expect(loadRuleSet(file).rules).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('one bad rule rejects the whole set', () => {
  const withRule = (rule: Record<string, unknown>) =>
    JSON.stringify({ name: 'x', version: '1', rules: [rule] });

  const good = {
    id: 'A', clause: 'c', title: 't', severity: 'minor', property: 'p',
    requirement: { kind: 'present' }, remediation: 'do the thing',
  };

  it('a rule with no clause is refused — a finding that cannot cite is an opinion', () => {
    expect(() => parseRuleSet(withRule({ ...good, clause: '' }))).toThrow(InvalidRuleSet);
    expect(() => parseRuleSet(withRule({ ...good, clause: '' }))).toThrow(/cites no clause/);
  });

  it('a rule with no remediation is refused — it would produce an alarm, not a finding', () => {
    expect(() => parseRuleSet(withRule({ ...good, remediation: '' }))).toThrow(/no remediation/);
  });

  it('a comparison with no unit is refused, because the engine never assumes one', () => {
    const rule = { ...good, requirement: { kind: 'compare', op: 'gte', value: 9, unit: '' } };
    expect(() => parseRuleSet(withRule(rule))).toThrow(/states no unit/);
  });

  it('a comparison against a non-number is refused', () => {
    const rule = { ...good, requirement: { kind: 'compare', op: 'gte', value: 'nine', unit: 'mm' } };
    expect(() => parseRuleSet(withRule(rule))).toThrow(/non-numeric/);
  });

  it('an unknown severity or operator is refused rather than defaulted', () => {
    expect(() => parseRuleSet(withRule({ ...good, severity: 'catastrophic' }))).toThrow(/severity/);
    const badOp = { ...good, requirement: { kind: 'compare', op: 'approximately', value: 9, unit: 'mm' } };
    expect(() => parseRuleSet(withRule(badOp))).toThrow(/comparison/);
  });

  it('an unknown requirement kind is refused rather than ignored', () => {
    expect(() => parseRuleSet(withRule({ ...good, requirement: { kind: 'vibes' } }))).toThrow(/requirement kind/);
  });

  it('the message explains WHY silence would have been worse', () => {
    try {
      parseRuleSet(withRule({ ...good, clause: '' }), 'lm-2011.yaml');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('Nothing was loaded');
      expect((error as Error).message).toContain('as though they had never been required');
    }
  });
});

describe('every problem is reported, not just the first', () => {
  it('collects them across rules and fields', () => {
    const problems = problemsWithRuleSet({
      name: '',
      version: '',
      rules: [
        { id: 'A' },
        { id: 'B', clause: 'c', title: 't', severity: 'nope', property: 'p', requirement: { kind: 'present' }, remediation: 'r' },
      ],
    });

    // A loader that stopped at the first problem would make fixing a rule set a series of
    // one-error-at-a-time round trips.
    expect(problems.length).toBeGreaterThan(4);
    expect(problems.some((p) => p.includes('no name'))).toBe(true);
    expect(problems.some((p) => p.includes('no version'))).toBe(true);
    expect(problems.some((p) => p.includes('rule "A"') || p.includes('rule[0]'))).toBe(true);
    expect(problems.some((p) => p.includes('rule "B"'))).toBe(true);
  });

  it('duplicate ids are refused — a shared id makes a finding ambiguous', () => {
    const problems = problemsWithRuleSet({
      name: 'x',
      version: '1',
      rules: [
        { id: 'DUP', clause: 'c', title: 't', severity: 'minor', property: 'p', requirement: { kind: 'present' }, remediation: 'r' },
        { id: 'DUP', clause: 'c', title: 't', severity: 'minor', property: 'q', requirement: { kind: 'present' }, remediation: 'r' },
      ],
    });
    expect(problems.some((p) => p.includes('defined twice'))).toBe(true);
  });

  it('an empty rule set is a problem, not an empty pass', () => {
    expect(problemsWithRuleSet({ name: 'x', version: '1', rules: [] })).toContain('the rule set contains no rules');
  });

  it('unparseable input names the parse failure rather than reporting zero rules', () => {
    expect(() => parseRuleSet('name: [unclosed', 'broken.yaml')).toThrow(/could not be parsed/);
  });

  it('a missing file is refused by name', () => {
    expect(() => loadRuleSet('/nonexistent/rules.yaml')).toThrow(/could not be read/);
  });
});
