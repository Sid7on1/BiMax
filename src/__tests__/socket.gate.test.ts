import { validateParam, bindParams, QueryTemplate, ParamSpec, MAX_PARAM_CHARS, MAX_TOTAL_PARAM_CHARS } from '../sockets/contract';
import { assertReadOnly, SocketQueryError } from '../sockets/adapters';

/**
 * The Open Socket's security claims, graded.
 *
 * The requirement was "it can only take information in, never send anything out". A query is
 * necessarily an outbound send, so the claim that has to hold instead is: *the only thing that
 * leaves is a pre-declared statement plus short, shaped parameters.* These tests grade that, and
 * each block ends with the mutation the assertion exists to catch — a test that passes against a
 * neutered implementation is not evidence.
 */

const template = (over: Partial<QueryTemplate> = {}): QueryTemplate => ({
  name: 'equipment_history',
  description: 'Inspection history for one equipment tag',
  connector: 'historian',
  statement: 'SELECT tag, thickness_mm, inspected_on FROM inspections WHERE tag = $1 ORDER BY inspected_on DESC',
  params: [{ name: 'tag', type: 'string', pattern: '[A-Z]-\\d{3}', maxLength: 16 }],
  ...over,
});

describe('the outbound channel is bounded, not merely read-only', () => {
  it('refuses a parameter long enough to carry a document', () => {
    const spec: ParamSpec = { name: 'tag', type: 'string' };
    // A confidential paragraph is exactly what exfiltration through a WHERE clause looks like.
    const leak = 'Board strategy: divest the Mangaluru aromatics complex in Q3. '.repeat(20);
    expect(() => validateParam(spec, leak)).toThrow(/limit is/);
  });

  it('caps a string parameter even when the template author declared a larger limit', () => {
    // A template author who writes maxLength 100000 must not be able to widen the channel.
    const spec: ParamSpec = { name: 'note', type: 'string', maxLength: 100_000 };
    expect(() => validateParam(spec, 'x'.repeat(MAX_PARAM_CHARS + 1))).toThrow(/limit is 128/);
    expect(validateParam(spec, 'x'.repeat(MAX_PARAM_CHARS))).toHaveLength(MAX_PARAM_CHARS);
  });

  it('caps the SUM of parameters, so many short fields cannot be assembled into a long one', () => {
    const many: ParamSpec[] = Array.from({ length: 8 }, (_, i) => ({ name: `p${i}`, type: 'string' as const }));
    const args = Object.fromEntries(many.map((spec) => [spec.name, 'y'.repeat(MAX_PARAM_CHARS)]));
    expect(() => bindParams(template({ params: many }), args)).toThrow(/per-call limit/);
  });

  it('a pattern constrains a parameter to an identifier, so it cannot carry prose at all', () => {
    const spec: ParamSpec = { name: 'tag', type: 'string', pattern: '[A-Z]-\\d{3}' };
    expect(validateParam(spec, 'E-204')).toBe('E-204');
    expect(() => validateParam(spec, 'E-204 and also the merger terms')).toThrow(/permitted form/);
  });

  it('anchors a pattern the author left unanchored', () => {
    // Without anchoring, "E-204<payload>" matches an unanchored /[A-Z]-\d{3}/ and the payload rides along.
    const spec: ParamSpec = { name: 'tag', type: 'string', pattern: '[A-Z]-\\d{3}' };
    expect(() => validateParam(spec, 'E-204' + 'PAYLOAD')).toThrow(/permitted form/);
  });

  it('MUTANT — dropping the length cap would let a whole memo leave in one parameter', () => {
    const unbounded = (value: string): string => value; // the neutered implementation
    const memo = 'z'.repeat(5_000);
    expect(unbounded(memo)).toHaveLength(5_000);
    expect(() => validateParam({ name: 'tag', type: 'string' }, memo)).toThrow();
  });
});

describe('the model cannot widen its own interface', () => {
  it('refuses an undeclared parameter rather than ignoring it', () => {
    // Ignoring it silently would let a caller believe a filter applied that never did.
    expect(() => bindParams(template(), { tag: 'E-204', extra: 'anything' })).toThrow(/unknown parameter/);
  });

  it('requires a declared parameter to be supplied', () => {
    expect(() => bindParams(template(), {})).toThrow(/required/);
  });

  it('binds parameters positionally in the template’s declared order', () => {
    const two = template({
      statement: 'SELECT * FROM r WHERE unit = $1 AND year = $2',
      params: [
        { name: 'unit', type: 'string', pattern: '[A-Z]{3}' },
        { name: 'year', type: 'integer', min: 1990, max: 2100 },
      ],
    });
    expect(bindParams(two, { year: '2026', unit: 'CDU' })).toEqual(['CDU', 2026]);
  });

  it('coerces a numeric string but refuses text where a number is declared', () => {
    const spec: ParamSpec = { name: 'year', type: 'integer', min: 1990, max: 2100 };
    expect(validateParam(spec, '2026')).toBe(2026);
    expect(() => validateParam(spec, 'last year')).toThrow(/must be a number/);
    expect(() => validateParam(spec, 2500)).toThrow(/<= 2100/);
    expect(() => validateParam(spec, 2026.5)).toThrow(/integer/);
  });

  it('enum parameters admit only declared values', () => {
    const spec: ParamSpec = { name: 'status', type: 'enum', values: ['open', 'closed'] };
    expect(validateParam(spec, 'open')).toBe('open');
    expect(() => validateParam(spec, 'open OR 1=1')).toThrow(/must be one of/);
  });
});

describe('read-only is enforced at config load, before anything reaches a server', () => {
  it('accepts the read forms', () => {
    for (const statement of [
      'SELECT 1',
      'WITH recent AS (SELECT * FROM t) SELECT * FROM recent',
      '  -- a leading comment\n SELECT tag FROM inspections',
      'EXPLAIN SELECT 1',
    ]) {
      expect(() => assertReadOnly(template({ statement }), 'postgres')).not.toThrow();
    }
  });

  it('refuses a write however it is dressed up', () => {
    for (const statement of [
      'UPDATE inspections SET thickness_mm = 9 WHERE tag = $1',
      'DELETE FROM inspections',
      'INSERT INTO inspections VALUES (1)',
      'DROP TABLE inspections',
      'TRUNCATE inspections',
    ]) {
      expect(() => assertReadOnly(template({ statement }), 'postgres')).toThrow(SocketQueryError);
    }
  });

  it('refuses a write hidden inside a CTE behind a SELECT head', () => {
    // This is the case a naive "starts with SELECT" check waves through.
    const sneaky = 'WITH gone AS (DELETE FROM inspections RETURNING *) SELECT * FROM gone';
    expect(() => assertReadOnly(template({ statement: sneaky }), 'postgres')).toThrow(/write keyword/);
  });

  it('refuses stacked statements', () => {
    const stacked = 'SELECT 1; DROP TABLE inspections';
    expect(() => assertReadOnly(template({ statement: stacked }), 'postgres')).toThrow(/more than one statement/);
  });

  it('permits a single trailing semicolon', () => {
    expect(() => assertReadOnly(template({ statement: 'SELECT 1;' }), 'postgres')).not.toThrow();
  });

  it('allows Redis reads and refuses Redis writes', () => {
    for (const statement of ['GET insp:$1', 'HGETALL equipment:$1', 'ZRANGE hist:$1 0 -1', 'FT.SEARCH idx $1']) {
      expect(() => assertReadOnly(template({ statement }), 'redis')).not.toThrow();
    }
    for (const statement of ['SET insp:$1 1', 'DEL insp:$1', 'FLUSHALL', 'PUBLISH ch $1', 'EVAL "..." 0']) {
      expect(() => assertReadOnly(template({ statement }), 'redis')).toThrow(SocketQueryError);
    }
  });

  it('MUTANT — a head-only check would admit the CTE delete', () => {
    const sneaky = 'WITH gone AS (DELETE FROM inspections RETURNING *) SELECT * FROM gone';
    const headOnly = (s: string): boolean => /^(SELECT|WITH)\b/i.test(s.trim());
    expect(headOnly(sneaky)).toBe(true);                 // the neutered check passes it
    expect(() => assertReadOnly(template({ statement: sneaky }), 'postgres')).toThrow(); // ours does not
  });
});
