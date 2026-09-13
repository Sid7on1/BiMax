import { Fact, FactQuery } from '../memory/facts';
import { ComplianceRule } from '../compliance/rules';
import { evaluateWithStore, FACT_QUERY_CAP, FactSource } from '../compliance/store';

/**
 * The store paginates, and a paginated read is the quietest way to turn a failure into a pass.
 *
 * `FactStore.query` caps at 500 rows and says nothing when it hits the cap. Ask for "minimum
 * thickness" across a large corpus, get 500 of 900 back, and the 400 unseen rows might hold the one
 * course that is under limit. The rule would report `pass` — correctly over the facts it was handed,
 * and wrongly about the world. These tests pin the refusal.
 */

const fact = (over: Partial<Fact> = {}): Fact => ({
  subject: 'E-204',
  property: 'minimum thickness',
  value: 9.4,
  unit: 'mm',
  measuredOn: '2026-08-12',
  sourceFile: '/drop/inspection.pdf',
  sourceName: 'inspection.pdf',
  locator: 'page 3',
  entryId: 'e1',
  ...over,
});

const rule: ComplianceRule = {
  id: 'API-510-MIN-THICKNESS',
  clause: 'API 510 §5.6',
  title: 'Shell thickness at or above the design minimum',
  severity: 'critical',
  property: 'minimum thickness',
  requirement: { kind: 'compare', op: 'gte', value: 9.0, unit: 'mm' },
  remediation: 'Replace the affected shell course.',
};

/** A store that records what it was asked and returns what it was told to. */
function sourceOf(facts: Fact[]): FactSource & { asked: FactQuery[] } {
  const asked: FactQuery[] = [];
  return {
    asked,
    query(request: FactQuery) {
      asked.push(request);
      return facts;
    },
  };
}

describe('a full page back means the set may be incomplete', () => {
  it('refuses to decide a rule whose facts hit the cap', () => {
    // Every one of these passes. The verdict is still withheld, because the rows we did NOT see
    // are exactly where a failure would hide.
    const source = sourceOf(Array.from({ length: FACT_QUERY_CAP }, () => fact({ value: 9.4 })));

    const report = evaluateWithStore([rule], source, 'v1');

    expect(report.results[0].status).toBe('undetermined');
    expect(report.results[0].status).not.toBe('pass');
    expect(report.results[0].reason).toContain('may');
    expect(report.truncatedRules).toEqual(['API-510-MIN-THICKNESS']);
    expect(report.summary.compliant).toBe(false);
  });

  it('one row below the cap is decided normally', () => {
    const source = sourceOf(Array.from({ length: FACT_QUERY_CAP - 1 }, () => fact({ value: 9.4 })));

    const report = evaluateWithStore([rule], source, 'v1');

    expect(report.results[0].status).toBe('pass');
    expect(report.truncatedRules).toEqual([]);
    expect(report.summary.compliant).toBe(true);
  });

  it('a truncated rule does not suppress a real failure elsewhere', () => {
    const other: ComplianceRule = { ...rule, id: 'OTHER', property: 'design pressure' };
    const source: FactSource = {
      query: (request) => (request.property === 'design pressure'
        ? [fact({ property: 'design pressure', value: 1.0 })]
        : Array.from({ length: FACT_QUERY_CAP }, () => fact())),
    };

    const report = evaluateWithStore([rule, other], source, 'v1');

    expect(report.summary.failed).toBe(1);
    expect(report.summary.undetermined).toBe(1);
    expect(report.results[0].status).toBe('fail');   // failures sort first
  });
});

describe('each rule fetches only the facts it is about', () => {
  it('filters by property, and by subject when the rule names one', () => {
    const source = sourceOf([fact()]);
    const scoped: ComplianceRule = { ...rule, id: 'SCOPED', subject: 'E-204' };

    evaluateWithStore([rule, scoped], source, 'v1');

    expect(source.asked[0]).toEqual({ property: 'minimum thickness', limit: FACT_QUERY_CAP });
    expect(source.asked[1]).toEqual({ property: 'minimum thickness', subject: 'E-204', limit: FACT_QUERY_CAP });
  });

  it('asks for the largest page the store will serve, so the cap is the store\'s and not ours', () => {
    const source = sourceOf([]);
    evaluateWithStore([rule], source, 'v1');
    expect(source.asked[0].limit).toBe(FACT_QUERY_CAP);
  });

  it('over-fetching on a substring match is corrected by the exact filter', () => {
    // The store matches `property LIKE %minimum thickness%`, so a neighbouring property comes back
    // too. The exact decision stays in one place rather than being duplicated in SQL.
    const source = sourceOf([
      fact({ property: 'nominal minimum thickness margin', value: 0.1 }),
      fact({ value: 9.4 }),
    ]);

    expect(evaluateWithStore([rule], source, 'v1').results[0].status).toBe('pass');
  });
});

describe('the summary keeps the same meaning as the pure engine', () => {
  it('nothing to check is not compliance', () => {
    const report = evaluateWithStore([rule], sourceOf([]), 'v1');

    expect(report.summary).toMatchObject({ total: 1, passed: 0, failed: 0, undetermined: 1 });
    expect(report.summary.compliant).toBe(false);
  });

  it('stamps both versions so a verdict can be re-derived', () => {
    const report = evaluateWithStore([rule], sourceOf([fact()]), 'api-510@2');
    expect(report.ruleSetVersion).toBe('api-510@2');
    expect(report.engineVersion).toContain('bimax.compliance/');
  });
});
