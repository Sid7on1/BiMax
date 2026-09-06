/**
 * Argument validation for model-emitted tool calls.
 *
 * Bimax previously handed a model's parsed arguments straight to `tool.execute`. A weak model that
 * omits a required parameter or sends `"3"` where a number is declared produced an internal
 * TypeError, and the model was told `Tool Error: Cannot read properties of undefined` — a message it
 * cannot act on. deepseek-harness validates against the declared parameter schema first and returns
 * every violation in schema-walk order (`packages/core/tools/src/schema.ts` → `ToolArgsError`), so
 * the model sees exactly which parameter is wrong and re-issues one corrected call.
 *
 * This is that mechanism, plus one thing dsh deliberately does NOT do: a bounded COERCION pass
 * before validation. dsh targets a frontier model that emits well-typed arguments; Bimax routinely
 * runs small tool-tuned models whose whole failure mode is the near-miss — `"true"` for a boolean,
 * `"12"` for a number, a single string where an array is declared, a JSON *string* where an object
 * is declared. Those are unambiguous repairs, so we repair them and run the call. Everything else is
 * a violation and nothing executes.
 */

/** The JSON Schema subset the tool schemas in this repo actually declare. */
export interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  additionalProperties?: boolean | JsonSchemaNode;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  nullable?: boolean;
  [k: string]: unknown;
}

/** JSON Schema's own type vocabulary for a runtime value. */
function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value as number) ? 'integer' : 'number';
  return t; // 'string' | 'boolean' | 'object' | 'undefined' | 'function' | ...
}

/** Does `value` satisfy a declared `type` (integer counts as number, not vice versa)? */
function typeMatches(declared: string, value: unknown): boolean {
  const actual = jsonTypeOf(value);
  if (declared === 'number') return actual === 'number' || actual === 'integer';
  if (declared === 'integer') return actual === 'integer';
  return declared === actual;
}

function declaredTypes(schema: JsonSchemaNode): string[] {
  if (Array.isArray(schema.type)) return schema.type;
  if (typeof schema.type === 'string') return [schema.type];
  return [];
}

/** `a.b[0]` style path for a violation message; the root reports the bare property name. */
function child(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

/**
 * Why a string that was clearly meant to be JSON would not parse.
 *
 * This exists because of a measured 4-attempt loop: a model emitted a large `spec` as a stringified
 * JSON object, the string was truncated mid-emission (an unclosed `{`), `JSON.parse` threw, the
 * coercion below silently declined, and validation reported the only thing it could see —
 * `spec: expected object, received string`. That is a TYPE complaint, so the model "fixed" the type
 * it was accused of by re-sending the same string, four times, before giving up. The type was never
 * the problem. The message has to name the actual defect or the model cannot act on it.
 *
 * Bracket depth is tracked outside string literals so an unclosed structure is reported as the
 * truncation it is, rather than as whatever position `JSON.parse` happened to give up at.
 */
function describeMalformedJson(text: string, error: unknown): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }

  const reason = error instanceof Error ? error.message : String(error);
  if (depth > 0 || inString) {
    const open = inString ? 'an unterminated string' : `${depth} unclosed bracket(s)`;
    return `the JSON is TRUNCATED — it ends with ${open}, so the value was cut off mid-emission`
      + ` (${reason}). This is an output-budget failure, not a type error: re-issue the call with`
      + ` LESS content (fewer items), or emit this parameter as a real JSON object rather than as a`
      + ` string — a stringified object doubles the escaping and spends far more of the budget.`;
  }
  return `the JSON is MALFORMED — ${reason}. Emit this parameter as a real JSON object, not as a`
    + ` string containing JSON.`;
}

/** What one coercion pass accumulates: the repairs it made, and the repairs it could not make. */
interface CoerceCtx {
  /** Human-readable repairs applied, for the log. */
  notes: string[];
  /** path → why a JSON string at that path would not parse. Replaces that path's type violation. */
  parseErrors: Map<string, string>;
}

/**
 * Repair a value into the declared type when the repair is unambiguous, else return it untouched.
 * Only the near-misses small models actually emit are repaired — never a lossy or guessing
 * conversion (an empty string is NOT 0, and an arbitrary string is NOT `true`).
 */
function coerceValue(schema: JsonSchemaNode | undefined, value: unknown, ctx: CoerceCtx, path: string): unknown {
  if (!schema || value === undefined) return value;

  const notes = ctx.notes;
  const types = declaredTypes(schema);
  const want = (t: string) => types.includes(t);

  // A JSON payload the model stringified instead of emitting structurally.
  if ((want('object') || want('array')) && typeof value === 'string') {
    const trimmed = value.trim();
    const looksStructural = (want('object') && trimmed.startsWith('{')) || (want('array') && trimmed.startsWith('['));
    if (looksStructural) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeMatches(want('object') ? 'object' : 'array', parsed)) {
          notes.push(`${path || 'arguments'}: parsed a JSON string into ${jsonTypeOf(parsed)}`);
          value = parsed;
        }
      } catch (e) {
        // The model DID try to send structure here — the string opens with `{`/`[`. Reporting a bare
        // type mismatch would accuse it of the wrong mistake, so record why the parse failed and let
        // `checkToolArgs` surface that in place of the type violation.
        ctx.parseErrors.set(path || 'arguments', describeMalformedJson(trimmed, e));
      }
    }
  }

  if ((want('number') || want('integer')) && typeof value === 'string') {
    const trimmed = value.trim();
    // Full-string numeric only: `Number('')` is 0 and `Number('3px')` is NaN, and neither is a repair.
    if (trimmed !== '' && Number.isFinite(Number(trimmed))) {
      const n = Number(trimmed);
      if (!want('integer') || Number.isInteger(n)) {
        notes.push(`${path || 'arguments'}: coerced the string "${value}" to the number ${n}`);
        value = n;
      }
    }
  }

  if (want('boolean') && typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true' || lowered === 'false') {
      notes.push(`${path || 'arguments'}: coerced the string "${value}" to ${lowered}`);
      value = lowered === 'true';
    }
  }

  if (want('string') && (typeof value === 'number' || typeof value === 'boolean')) {
    notes.push(`${path || 'arguments'}: coerced ${jsonTypeOf(value)} ${String(value)} to a string`);
    value = String(value);
  }

  // A single element where a list is declared — the most common list near-miss. Never applied to a
  // string whose JSON parse just failed: wrapping `'[[1,2],[3,4'` produces a structurally VALID
  // one-element array, which passes validation and hands the tool one broken JSON string as its
  // data. That is a silent corruption, strictly worse than the refusal it replaces.
  if (want('array') && !Array.isArray(value) && value !== null && typeof value !== 'object'
      && !ctx.parseErrors.has(path || 'arguments')) {
    notes.push(`${path || 'arguments'}: wrapped a single ${jsonTypeOf(value)} into a one-element array`);
    value = [value];
  }

  if (Array.isArray(value) && schema.items) {
    return value.map((item, i) => coerceValue(schema.items, item, ctx, child(path, i)));
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = { ...record };
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        out[key] = coerceValue(propSchema, record[key], ctx, child(path, key));
      } else if (propSchema && propSchema.default !== undefined) {
        // A declared default is what the model was told happens when it omits the property, so
        // materialize it rather than making the tool re-derive it from `undefined`.
        out[key] = propSchema.default;
      }
    }
    return out;
  }

  return value;
}

/**
 * Every violation of `schema` by `value`, in schema-walk order. An empty array means valid.
 * Unknown keywords are ignored rather than guessed at, so a schema this validator does not
 * understand can never manufacture a false violation.
 */
export function validateJsonSchemaValue(schema: JsonSchemaNode | undefined, value: unknown, path = ''): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const where = path || 'arguments';
  const violations: string[] = [];

  if (value === null && schema.nullable === true) return [];

  const types = declaredTypes(schema);
  if (types.length > 0 && !types.some(t => typeMatches(t, value))) {
    return [`${where}: expected ${types.join(' or ')}, received ${jsonTypeOf(value)}`];
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => candidate === value)) {
    return [`${where}: must be one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}, received ${JSON.stringify(value)}`];
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) {
    return [`${where}: must be ${JSON.stringify(schema.const)}, received ${JSON.stringify(value)}`];
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      violations.push(`${where}: must be at least ${schema.minLength} characters, received ${value.length}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      violations.push(`${where}: must be at most ${schema.maxLength} characters, received ${value.length}`);
    }
    if (typeof schema.pattern === 'string') {
      let re: RegExp | null = null;
      // A schema's own pattern can be an invalid RegExp; that is our bug, not the model's, so it
      // must never become a violation the model is asked to fix.
      try { re = new RegExp(schema.pattern); } catch { re = null; }
      if (re && !re.test(value)) violations.push(`${where}: must match ${schema.pattern}, received ${JSON.stringify(value)}`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      violations.push(`${where}: must be >= ${schema.minimum}, received ${value}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      violations.push(`${where}: must be <= ${schema.maximum}, received ${value}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      violations.push(`${where}: must have at least ${schema.minItems} item(s), received ${value.length}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      violations.push(`${where}: must have at most ${schema.maxItems} item(s), received ${value.length}`);
    }
    if (schema.items) {
      value.forEach((item, i) => violations.push(...validateJsonSchemaValue(schema.items, item, child(path, i))));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined) {
        violations.push(`${child(path, key)}: required, but missing`);
      }
    }
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined) {
          violations.push(...validateJsonSchemaValue(propSchema, record[key], child(path, key)));
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(record)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
          violations.push(`${child(path, key)}: not a declared parameter of this tool`);
        }
      }
    }
  }

  for (const branchKey of ['oneOf', 'anyOf'] as const) {
    const branches = schema[branchKey];
    if (Array.isArray(branches) && branches.length > 0) {
      const matches = branches.filter(branch => validateJsonSchemaValue(branch, value, path).length === 0);
      if (matches.length === 0) violations.push(`${where}: does not match any accepted shape`);
      else if (branchKey === 'oneOf' && matches.length > 1) violations.push(`${where}: matches more than one accepted shape`);
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) violations.push(...validateJsonSchemaValue(branch, value, path));
  }

  return violations;
}

export interface ToolArgsCheck {
  /** The arguments to execute with: coerced and default-filled when the call is valid. */
  args: unknown;
  /** Path-qualified violations in schema-walk order; empty means the call may run. */
  violations: string[];
  /** Human-readable repairs applied before validation, for the log. */
  coercions: string[];
}

/**
 * Coerce, then validate, one model-emitted argument object against a tool's declared schema.
 * A tool with no usable object schema is unvalidated — an undeclared surface is not a violation.
 */
export function checkToolArgs(schema: unknown, args: unknown): ToolArgsCheck {
  const node = schema as JsonSchemaNode | undefined;
  if (!node || typeof node !== 'object' || node.type !== 'object' || !node.properties) {
    return { args, violations: [], coercions: [] };
  }
  const ctx: CoerceCtx = { notes: [], parseErrors: new Map() };
  const coerced = coerceValue(node, args, ctx, '');
  const violations = validateJsonSchemaValue(node, coerced, '');

  // A parameter whose JSON string would not parse gets the parse diagnosis INSTEAD of the type
  // mismatch it also trivially produces. Reporting both would leave the type complaint on screen,
  // and that is the half a model acts on first.
  const explained = new Set<string>();
  const rewritten = violations.map(v => {
    for (const [path, diagnosis] of ctx.parseErrors) {
      if (v.startsWith(`${path}: `)) { explained.add(path); return `${path}: ${diagnosis}`; }
    }
    return v;
  });

  // A recorded parse failure with no violation to attach to means some later coercion made the
  // broken value look well-typed. It must still refuse: executing on a value we know is corrupt is
  // the one outcome worse than a failed call.
  for (const [path, diagnosis] of ctx.parseErrors) {
    if (!explained.has(path)) rewritten.push(`${path}: ${diagnosis}`);
  }

  return { args: coerced, violations: rewritten, coercions: ctx.notes };
}

/** The model-facing message for a call that failed validation. Nothing ran; say so, and say why. */
export function argsViolationMessage(toolName: string, violations: string[]): string {
  return `${toolName} was NOT executed — its arguments do not match the tool's schema:\n`
    + violations.map(v => `  - ${v}`).join('\n')
    + `\n\nRe-issue the call once with corrected arguments. Do not repeat the same arguments.`;
}
