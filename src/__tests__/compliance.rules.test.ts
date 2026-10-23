import { Fact } from '../memory/facts';
import {
  ComplianceRule, evaluate, evaluateRule, factsForRule, ENGINE_VERSION,
} from '../compliance/rules';

/**
 * The engine's whole value is that it refuses to guess, so most of this suite is about the verdicts
 * it declines to reach.
 *
 * A compliance matrix that renders a missing declaration as a tick is worse than no matrix at all:
 * it converts "we did not look" into "we checked and it was fine", and the reader cannot tell the
 * difference. `facts.ts` already refuses to invent a fact it did not read. These tests pin the
 * matching refusal one layer up — no verdict without a fact, and no comparison across units.
 */

const fact = (over: Partial<Fact> = {}): Fact => ({
  subject: 'E-204',
  property: 'minimum thickness',
  value: 7.8,
  unit: 'mm',
  measuredOn: '2026-08-12',
  sourceFile: '/drop/inspection.pdf',
  sourceName: 'E-204 Inspection Report.pdf',
  locator: 'page 3',
  entryId: 'e1',
  ...over,
});

const thicknessRule: ComplianceRule = {
  id: 'API-510-MIN-THICKNESS',
  clause: 'API 510 §5.6 — minimum allowable thickness',
  title: 'Shell thickness at or above the design minimum',
  severity: 'critical',
  property: 'minimum thickness',
  requirement: { kind: 'compare', op: 'gte', value: 9.0, unit: 'mm' },
  remediation: 'Replace the affected shell course, or perform a Fitness-For-Service assessment.',
};

const mrpRule: ComplianceRule = {
  id: 'LM-2011-MRP',
  clause: 'Legal Metrology (Packaged Commodities) Rules, 2011, r.6(1)(e)',
  title: 'Retail sale price is declared',
  severity: 'major',
  property: 'mrp',
  requirement: { kind: 'present' },
  remediation: 'Print the retail sale price as "MRP Rs. <amount> inclusive of all taxes".',
};

describe('a rule with nothing to check is UNDETERMINED, never a pass', () => {
  it('reports the absence rather than silently succeeding', () => {
    const result = evaluateRule(mrpRule, [fact({ property: 'net quantity' })]);

    expect(result.status).toBe('undetermined');
    expect(result.status).not.toBe('pass');
    expect(result.reason).toContain('could not be checked');
    // Nothing failed, so there is nothing to remediate — printing a fix here would train the reader
    // to ignore the ones that matter.
    expect(result.remediation).toBeUndefined();
  });

  it('an empty corpus leaves every rule unchecked, and the summary refuses to call that compliant', () => {
    const report = evaluate([thicknessRule, mrpRule], [], 'v1');

    expect(report.summary).toMatchObject({ total: 2, passed: 0, failed: 0, undetermined: 2 });
    // The headline property. Nothing failed — and it is still not compliant.
    expect(report.summary.compliant).toBe(false);
  });

  it('names the subject when the rule is scoped to one', () => {
    const scoped = { ...thicknessRule, subject: 'E-999' };
    const result = evaluateRule(scoped, [fact()]);

    expect(result.status).toBe('undetermined');
    expect(result.reason).toContain('E-999');
  });
});

describe('units are never assumed and never converted', () => {
  it('a value with no stated unit cannot be compared', () => {
    const result = evaluateRule(thicknessRule, [fact({ unit: null })]);

    expect(result.status).toBe('undetermined');
    expect(result.reason).toContain('no unit');
    expect(result.reason).toContain('No unit was assumed');
  });

  it('a value in a different unit cannot be compared', () => {
    // 0.31 inches is ~7.9 mm and would FAIL the 9.0 mm rule. Converting silently would produce a
    // correct-looking verdict from an assumption the document never made.
    const result = evaluateRule(thicknessRule, [fact({ value: 0.31, unit: 'in' })]);

    expect(result.status).toBe('undetermined');
    expect(result.reason).toContain('No conversion was performed');
  });

  it('matches units case-insensitively, which is a spelling difference and not a unit difference', () => {
    expect(evaluateRule(thicknessRule, [fact({ value: 9.4, unit: 'MM' })]).status).toBe('pass');
  });

  it('a presence rule does not care about units at all', () => {
    expect(evaluateRule(mrpRule, [fact({ property: 'mrp', value: 249, unit: null })]).status).toBe('pass');
  });
});

describe('comparisons produce citable verdicts', () => {
  it('fails when the measurement is below the minimum, and says by how much', () => {
    const result = evaluateRule(thicknessRule, [fact({ value: 7.8 })]);

    expect(result.status).toBe('fail');
    expect(result.reason).toBe('7.8 mm is not at least 9 mm');
    expect(result.remediation).toBe(thicknessRule.remediation);
    // The verdict stays as citable as a quotation.
    expect(result.observed).toMatchObject({ sourceName: 'E-204 Inspection Report.pdf', locator: 'page 3' });
    expect(result.clause).toBe('API 510 §5.6 — minimum allowable thickness');
  });

  it('passes at the boundary for an inclusive comparison', () => {
    expect(evaluateRule(thicknessRule, [fact({ value: 9.0 })]).status).toBe('pass');
  });

  it('every comparison operator behaves', () => {
    const at = (op: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'ne', value: number) =>
      evaluateRule({ ...thicknessRule, requirement: { kind: 'compare', op, value, unit: 'mm' } }, [fact({ value: 7.8 })]).status;

    expect(at('lt', 9)).toBe('pass');
    expect(at('lte', 7.8)).toBe('pass');
    expect(at('gt', 9)).toBe('fail');
    expect(at('gte', 9)).toBe('fail');
    expect(at('eq', 7.8)).toBe('pass');
    expect(at('ne', 7.8)).toBe('fail');
  });
});

describe('several facts for one rule', () => {
  const courses = [
    fact({ subject: 'E-204', value: 9.4, locator: 'page 3' }),
    fact({ subject: 'E-204', value: 7.8, locator: 'page 4' }),
    fact({ subject: 'E-204', value: 9.9, locator: 'page 5' }),
  ];

  it('one failure among passes is a failure, and it reports the failing one', () => {
    const result = evaluateRule(thicknessRule, courses);

    expect(result.status).toBe('fail');
    expect(result.observed?.locator).toBe('page 4');
  });

  it('an uncheckable fact outranks a pass — partially checked is not checked', () => {
    const result = evaluateRule(thicknessRule, [fact({ value: 9.4 }), fact({ unit: null })]);
    expect(result.status).toBe('undetermined');
  });

  it('selects only the facts a rule is about', () => {
    const mixed = [...courses, fact({ property: 'design pressure' }), fact({ subject: 'P-310A' })];
    const scoped = { ...thicknessRule, subject: 'E-204' };

    expect(factsForRule(scoped, mixed)).toHaveLength(3);
  });
});

describe('the report is ordered for the person who reads only the top of it', () => {
  it('failures first, then the unchecked, then the passes', () => {
    const passing = { ...mrpRule, id: 'PASSES', property: 'mrp' };
    const unchecked = { ...mrpRule, id: 'UNCHECKED', property: 'net quantity' };

    const report = evaluate(
      [passing, unchecked, thicknessRule],
      [fact({ property: 'mrp', value: 249 }), fact({ value: 7.8 })],
      'v1',
    );

    expect(report.results.map((r) => r.status)).toEqual(['fail', 'undetermined', 'pass']);
    expect(report.results[0].ruleId).toBe('API-510-MIN-THICKNESS');
  });

  it('ranks a critical failure above a major one', () => {
    const major = { ...thicknessRule, id: 'MAJOR-FAIL', severity: 'major' as const };
    const report = evaluate([major, thicknessRule], [fact({ value: 7.8 })], 'v1');

    expect(report.results.map((r) => r.severity)).toEqual(['critical', 'major']);
  });

  it('stamps the engine and rule-set versions so a verdict can be re-derived', () => {
    const report = evaluate([mrpRule], [fact({ property: 'mrp', value: 249 })], 'lm-2011@3');

    expect(report.engineVersion).toBe(ENGINE_VERSION);
    expect(report.ruleSetVersion).toBe('lm-2011@3');
    expect(report.summary.compliant).toBe(true);
  });
});
