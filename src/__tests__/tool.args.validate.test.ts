import { checkToolArgs, validateJsonSchemaValue, argsViolationMessage } from '../tools/args.validate';

const readFileSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    startLine: { type: 'number' },
    endLine: { type: 'number' },
  },
  required: ['path'],
};

describe('checkToolArgs — schema-gated tool calls', () => {
  it('accepts a well-formed call unchanged', () => {
    const check = checkToolArgs(readFileSchema, { path: 'src/index.ts', startLine: 1 });
    expect(check.violations).toEqual([]);
    expect(check.coercions).toEqual([]);
    expect(check.args).toEqual({ path: 'src/index.ts', startLine: 1 });
  });

  it('names the missing required property instead of letting the tool throw', () => {
    const check = checkToolArgs(readFileSchema, { startLine: 1 });
    expect(check.violations).toEqual(['path: required, but missing']);
    expect(argsViolationMessage('ReadFileTool', check.violations))
      .toContain('ReadFileTool was NOT executed');
  });

  it('reports the wrong type with both the expected and the received type', () => {
    const check = checkToolArgs(readFileSchema, { path: { file: 'x' } });
    expect(check.violations).toEqual(['path: expected string, received object']);
  });

  it('coerces a numeric string into the declared number', () => {
    const check = checkToolArgs(readFileSchema, { path: 'a.ts', startLine: '12' });
    expect(check.violations).toEqual([]);
    expect(check.args).toEqual({ path: 'a.ts', startLine: 12 });
    expect(check.coercions[0]).toContain('coerced the string "12"');
  });

  it('coerces "true"/"false" but never an arbitrary string', () => {
    const schema = { type: 'object', properties: { background: { type: 'boolean' } }, required: [] };
    expect(checkToolArgs(schema, { background: 'true' }).args).toEqual({ background: true });
    expect(checkToolArgs(schema, { background: 'yes' }).violations)
      .toEqual(['background: expected boolean, received string']);
  });

  it('never turns an empty or non-numeric string into a number', () => {
    expect(checkToolArgs(readFileSchema, { path: 'a', startLine: '' }).violations.length).toBe(1);
    expect(checkToolArgs(readFileSchema, { path: 'a', startLine: '3px' }).violations.length).toBe(1);
  });

  it('parses a JSON string the model emitted where an object is declared', () => {
    const schema = {
      type: 'object',
      properties: { edit: { type: 'object', properties: { old: { type: 'string' } }, required: ['old'] } },
      required: ['edit'],
    };
    const check = checkToolArgs(schema, { edit: '{"old":"a"}' });
    expect(check.violations).toEqual([]);
    expect(check.args).toEqual({ edit: { old: 'a' } });
  });

  it('wraps a lone value into a declared array', () => {
    const schema = { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: [] };
    expect(checkToolArgs(schema, { paths: 'a.ts' }).args).toEqual({ paths: ['a.ts'] });
  });

  it('fills a declared default for an absent property', () => {
    const schema = { type: 'object', properties: { limit: { type: 'number', default: 10 } }, required: [] };
    expect(checkToolArgs(schema, {}).args).toEqual({ limit: 10 });
  });

  it('rejects a value outside a declared enum and lists the accepted ones', () => {
    const schema = { type: 'object', properties: { action: { type: 'string', enum: ['status', 'log'] } }, required: ['action'] };
    expect(checkToolArgs(schema, { action: 'commit' }).violations[0])
      .toBe('action: must be one of "status", "log", received "commit"');
  });

  it('validates items inside an array by index', () => {
    const schema = { type: 'object', properties: { n: { type: 'array', items: { type: 'number' } } }, required: [] };
    expect(checkToolArgs(schema, { n: [1, 'two', 3] }).violations)
      .toEqual(['n[1]: expected number, received string']);
  });

  it('leaves a tool with no usable object schema unvalidated', () => {
    const args = { anything: 1 };
    expect(checkToolArgs(undefined, args)).toEqual({ args, violations: [], coercions: [] });
    expect(checkToolArgs({ type: 'string' }, args).violations).toEqual([]);
  });

  it('ignores an unknown keyword rather than inventing a violation', () => {
    const schema = { type: 'object', properties: { p: { type: 'string', contentEncoding: 'base64' } }, required: [] };
    expect(checkToolArgs(schema, { p: 'x' }).violations).toEqual([]);
  });

  it('does not report a schema-authoring mistake as a model mistake', () => {
    // An invalid `pattern` is our bug; the model cannot fix it, so it must not become a violation.
    expect(validateJsonSchemaValue({ type: 'string', pattern: '([' }, 'anything')).toEqual([]);
  });

  it('reports every violation, not just the first', () => {
    const check = checkToolArgs(readFileSchema, { startLine: {}, endLine: [] });
    expect(check.violations).toHaveLength(3);
  });
});

describe('a stringified JSON parameter that will not parse', () => {
  // DocumentTool's real schema — `spec` is the parameter the measured 4-attempt loop stalled on.
  const documentSchema = {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['docx', 'pdf', 'pptx', 'xlsx'] },
      path: { type: 'string' },
      spec: { type: 'object' },
    },
    required: ['format', 'path', 'spec'],
  };

  const call = (spec: string) => checkToolArgs(documentSchema, {
    format: 'pptx', path: '~/Desktop/deck.pptx', spec,
  });

  it('still parses a well-formed stringified object', () => {
    const check = call('{"title":"Deck","slides":[{"title":"One"}]}');
    expect(check.violations).toEqual([]);
    expect((check.args as { spec: unknown }).spec).toEqual({ title: 'Deck', slides: [{ title: 'One' }] });
  });

  it('names truncation, not the type, when the value was cut off mid-emission', () => {
    // Exactly the shape that looped: `slides` closes, the outer object never does.
    const check = call('{"title":"Deck","slides":[{"title":"One"},{"kind":"pagebreak"}]');
    expect(check.violations).toHaveLength(1);
    expect(check.violations[0]).toContain('TRUNCATED');
    expect(check.violations[0]).toContain('1 unclosed bracket(s)');
    // The type complaint is what the model previously acted on, and it is the wrong instruction.
    expect(check.violations[0]).not.toContain('expected object, received string');
  });

  it('reports an unterminated string as truncation too', () => {
    const check = call('{"title":"Deck","slides":[{"title":"One');
    expect(check.violations[0]).toContain('TRUNCATED');
    expect(check.violations[0]).toContain('unterminated string');
  });

  it('distinguishes malformed-but-complete JSON from truncated JSON', () => {
    const check = call('{"title":"Deck",,}');
    expect(check.violations[0]).toContain('MALFORMED');
    expect(check.violations[0]).not.toContain('TRUNCATED');
  });

  it('leaves an ordinary string parameter alone — it is a real type violation', () => {
    // No leading `{`, so the model was not attempting structure and the type complaint is correct.
    const check = call('just some prose');
    expect(check.violations).toEqual(['spec: expected object, received string']);
  });

  it('diagnoses a nested stringified array, not just a top-level parameter', () => {
    const schema = {
      type: 'object',
      properties: { outer: { type: 'object', properties: { rows: { type: 'array' } } } },
      required: [],
    };
    const check = checkToolArgs(schema, { outer: { rows: '[[1,2],[3,4' } });
    expect(check.violations).toHaveLength(1);
    expect(check.violations[0]).toContain('outer.rows:');
    expect(check.violations[0]).toContain('TRUNCATED');
  });
});
