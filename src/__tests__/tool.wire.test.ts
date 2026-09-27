import { buildWireTools, MAX_TOOLS_PER_REQUEST, normalizeToolSchema, renameHistoryToolCalls, schemaFlavorFor, ToolNameMap, wireToolName } from '../core/tool.wire';

/**
 * Every tool, including every MCP tool, in a shape each provider accepts. One bad name used to make
 * the provider refuse every request for the rest of the session.
 */

const VALID = /^[a-zA-Z0-9_-]{1,64}$/;

describe('tool names on the wire', () => {
  test('valid names are sent unchanged — built-in tools keep their exact names', () => {
    for (const name of ['ReadFileTool', 'mcp__github__create_issue', 'BashTool', 'a-b_c']) {
      expect(wireToolName(name)).toBe(name);
    }
  });

  test('MCP names with dots, spaces, slashes or unicode become valid', () => {
    for (const name of ['mcp__github.com__issues.list', 'mcp__my server__run', 'mcp__fs__read/file', 'mcp__日本__検索', 'mcp__x__']) {
      expect(wireToolName(name)).toMatch(VALID);
    }
  });

  test('over-long names are cut to 64 and stay distinct', () => {
    const a = `mcp__${'very-long-server-name-'.repeat(3)}__${'tool_'.repeat(10)}alpha`;
    const b = `mcp__${'very-long-server-name-'.repeat(3)}__${'tool_'.repeat(10)}beta`;
    expect(wireToolName(a)).toMatch(VALID);
    expect(wireToolName(b)).toMatch(VALID);
    expect(wireToolName(a)).not.toBe(wireToolName(b));
  });

  test('two names that clean to the same spelling are kept apart, and both map back', () => {
    const map = new ToolNameMap(['mcp__a.b__run', 'mcp__a_b__run']);
    const w1 = map.toWire('mcp__a.b__run');
    const w2 = map.toWire('mcp__a_b__run');
    expect(w1).not.toBe(w2);
    expect(map.fromWire(w1)).toBe('mcp__a.b__run');
    expect(map.fromWire(w2)).toBe('mcp__a_b__run');
  });

  test('a call the model makes is mapped back to the registered name', () => {
    const { defs, names } = buildWireTools([{ name: 'mcp__docs.site__search', input_schema: { type: 'object', properties: {} } }], 'portable');
    expect(defs[0].function.name).toMatch(VALID);
    expect(names.fromWire(defs[0].function.name)).toBe('mcp__docs.site__search');
  });

  test('earlier calls in the history are renamed to the spelling this request uses', () => {
    const names = new ToolNameMap(['mcp__a.b__run']);
    const history = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', tool_calls: [{ id: '1', type: 'function', function: { name: 'mcp__a.b__run', arguments: '{}' } }] },
      { role: 'assistant', tool_calls: [{ id: '2', type: 'function', function: { name: 'mcp__gone.tool__x', arguments: '{}' } }] },
    ];
    const out = renameHistoryToolCalls(history, names);
    expect(out[1].tool_calls[0].function.name).toBe(names.toWire('mcp__a.b__run'));
    expect(out[2].tool_calls[0].function.name).toMatch(VALID); // a tool no longer offered is still made valid
    expect(history[1].tool_calls![0].function.name).toBe('mcp__a.b__run'); // input untouched
  });

  test('a history with nothing to rename is returned as the same array', () => {
    const history = [{ role: 'assistant', tool_calls: [{ id: '1', type: 'function', function: { name: 'ReadFileTool', arguments: '{}' } }] }];
    expect(renameHistoryToolCalls(history, new ToolNameMap(['ReadFileTool']))).toBe(history);
  });

  test('more tools than a request may carry are capped, and the dropped ones are named', () => {
    const tools = Array.from({ length: MAX_TOOLS_PER_REQUEST + 5 }, (_, i) => ({ name: `t${i}` }));
    const { defs, dropped } = buildWireTools(tools, 'portable');
    expect(defs).toHaveLength(MAX_TOOLS_PER_REQUEST);
    expect(dropped).toEqual(['t128', 't129', 't130', 't131', 't132']);
  });
});

describe('tool schemas on the wire', () => {
  test('a missing or non-object root becomes an object with properties', () => {
    expect(normalizeToolSchema(undefined)).toEqual({ type: 'object', properties: {} });
    expect(normalizeToolSchema({ properties: { a: { type: 'string' } } })).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
  });

  test('$schema/$id are dropped and local $refs are inlined', () => {
    const out = normalizeToolSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'x',
      type: 'object',
      properties: { user: { $ref: '#/$defs/User' } },
      $defs: { User: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    });
    expect(JSON.stringify(out)).not.toMatch(/\$schema|\$id|\$ref|\$defs/);
    expect(out.properties.user).toEqual({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
  });

  test('a recursive $ref ends in a plain object instead of looping', () => {
    const out = normalizeToolSchema({
      type: 'object',
      properties: { node: { $ref: '#/definitions/Node' } },
      definitions: { Node: { type: 'object', properties: { child: { $ref: '#/definitions/Node' } } } },
    });
    expect(out.properties.node.properties.child).toEqual({ type: 'object' });
  });

  test('required only names properties that exist; an array always has items', () => {
    const out = normalizeToolSchema({ type: 'object', properties: { a: { type: 'array' } }, required: ['a', 'ghost'] });
    expect(out.required).toEqual(['a']);
    expect(out.properties.a.items).toEqual({});
  });

  test('a root anyOf of objects folds into one object', () => {
    const out = normalizeToolSchema({ anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'number' } } }] });
    expect(out.type).toBe('object');
    expect(Object.keys(out.properties).sort()).toEqual(['a', 'b']);
    expect(out.anyOf).toBeUndefined();
  });

  test('the Gemini subset: one type + nullable, string enums, no additionalProperties', () => {
    const out = normalizeToolSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: ['integer', 'null'], default: 10, exclusiveMinimum: 0 },
        mode: { enum: [1, 2, null] },
        pick: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
    }, 'gemini');
    expect(out.additionalProperties).toBeUndefined();
    expect(out.properties.limit).toEqual({ type: 'integer', nullable: true });
    expect(out.properties.mode.enum).toEqual(['1', '2']);
    expect(out.properties.pick.anyOf).toHaveLength(2);
    expect(out.properties.pick.oneOf).toBeUndefined();
  });

  test('other providers keep the keywords they accept', () => {
    const out = normalizeToolSchema({ type: 'object', additionalProperties: false, properties: { n: { type: 'integer', default: 3 } } });
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.n.default).toBe(3);
  });

  test('Gemini is recognised by provider or by model id, including through OpenRouter', () => {
    expect(schemaFlavorFor('google', 'anything')).toBe('gemini');
    expect(schemaFlavorFor('openrouter', 'google/gemini-3.8-flash')).toBe('gemini');
    expect(schemaFlavorFor('openai', 'gpt-6-sol')).toBe('portable');
    expect(schemaFlavorFor('nvidia', 'google/gemma-3-4b-it')).toBe('portable');
  });
});
