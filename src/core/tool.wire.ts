import * as crypto from 'crypto';

/**
 * The tool list as a PROVIDER will accept it.
 *
 * THE DEFECT THIS CLOSES. Tool names and input schemas went to the provider exactly as registered,
 * and an MCP server decides both. OpenAI and Anthropic reject a whole request when one function
 * name falls outside `^[a-zA-Z0-9_-]{1,64}$` (Gemini is similar), and MCP names routinely do: a
 * server called `github.com` or `my server`, a tool called `files.read`, or simply a long server
 * name plus a long tool name inside `mcp__<server>__<tool>`. Because MCP tools are deferred, the
 * failure arrived one turn AFTER the model discovered the tool — and from then on every request in
 * the session was refused, not just calls to that tool. Schemas had the same shape of problem:
 * `$schema`/`$ref`/`$defs`, a root without `type: "object"`, `type: ["string", "null"]`, all of
 * which some providers refuse outright.
 *
 * WHAT IT DOES. Maps every name to a provider-safe wire name (unchanged when already valid, so
 * every built-in tool and every well-named MCP tool keeps its exact name), and maps the model's
 * calls back. Normalizes every schema to the portable subset, with a stricter pass for Gemini.
 * Nothing about what a tool does, or which tools the model sees, changes here.
 */

/** OpenAI's documented function-name rule; Anthropic's allows 128, so 64 satisfies both. */
const VALID_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
export const WIRE_NAME_MAX = 64;

/**
 * The most tools one request may carry. OpenAI refuses more than 128; the others accept at least
 * that many. A registry this large is rare (deferred MCP tools only join once discovered), so the
 * cap drops the tail rather than failing every turn.
 */
export const MAX_TOOLS_PER_REQUEST = 128;

function shortHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/** A provider-safe spelling of `name`. Stable: the same input always gives the same output. */
export function wireToolName(name: string): string {
  if (VALID_NAME.test(name)) return name;
  const cleaned = String(name || '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
  if (cleaned.length <= WIRE_NAME_MAX && cleaned !== name) {
    // Cleaning can merge two names ("a.b" and "a_b"); the hash suffix below keeps them apart
    // only when needed — see ToolNameMap.
    return cleaned;
  }
  const suffix = `_${shortHash(name)}`;
  return `${cleaned.slice(0, WIRE_NAME_MAX - suffix.length)}${suffix}`;
}

/** The two-way mapping for one request's tool list. */
export class ToolNameMap {
  private readonly toWireMap = new Map<string, string>();
  private readonly fromWireMap = new Map<string, string>();

  constructor(names: string[]) {
    for (const name of names) this.add(name);
  }

  private add(name: string): string {
    const existing = this.toWireMap.get(name);
    if (existing) return existing;
    let wire = wireToolName(name);
    if (this.fromWireMap.has(wire) && this.fromWireMap.get(wire) !== name) {
      // Two different tools cleaned to the same spelling: disambiguate the later one by its own hash.
      const suffix = `_${shortHash(name)}`;
      wire = `${wire.slice(0, WIRE_NAME_MAX - suffix.length)}${suffix}`;
    }
    this.toWireMap.set(name, wire);
    this.fromWireMap.set(wire, name);
    return wire;
  }

  /** The name to send. A name absent from this request (an older call in history) is still made valid. */
  toWire(name: string): string {
    return this.toWireMap.get(name) ?? this.add(name);
  }

  /** The registered name for a name the model sent. Unknown names pass through for the loop to report. */
  fromWire(name: string): string {
    return this.fromWireMap.get(name) ?? name;
  }

  /** True when at least one name had to change — the only case where history needs rewriting. */
  get renamed(): boolean {
    for (const [name, wire] of this.toWireMap) if (name !== wire) return true;
    return false;
  }
}

export type SchemaFlavor = 'portable' | 'gemini';

/** Which schema subset a model/provider pair needs. */
export function schemaFlavorFor(provider: string | null | undefined, model: string | null | undefined): SchemaFlavor {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  if (p === 'google' || /(^|\/)gemini-/.test(m)) return 'gemini';
  return 'portable';
}

/** Keywords Gemini's function declarations refuse; everything else it supports is kept. */
const GEMINI_DROP = new Set([
  'additionalProperties', 'unevaluatedProperties', 'patternProperties', 'propertyNames',
  'dependentRequired', 'dependentSchemas', 'if', 'then', 'else', 'not', 'const', 'examples',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'contentEncoding', 'contentMediaType',
  'readOnly', 'writeOnly', 'deprecated', 'default', 'title',
]);
/** Metadata no provider needs and several refuse. */
const ALWAYS_DROP = new Set(['$schema', '$id', '$comment', '$anchor', '$dynamicAnchor', '$vocabulary']);
const MAX_DEPTH = 24;

type Json = any;

function resolveRef(ref: string, root: Json): Json | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let node: Json = root;
  for (const part of ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object' || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
}

function normalizeNode(node: Json, root: Json, flavor: SchemaFlavor, depth: number, refs: Set<string>): Json {
  if (Array.isArray(node)) return node.map((v) => normalizeNode(v, root, flavor, depth + 1, refs));
  if (!node || typeof node !== 'object') return node;
  if (depth > MAX_DEPTH) return { type: 'object' };

  // Local references are inlined (several providers refuse `$ref`); a cycle becomes a plain object.
  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    const target = refs.has(ref) ? undefined : resolveRef(ref, root);
    if (!target) return { type: 'object', ...(node.description ? { description: node.description } : {}) };
    const merged = { ...target, ...Object.fromEntries(Object.entries(node).filter(([k]) => k !== '$ref')) };
    return normalizeNode(merged, root, flavor, depth + 1, new Set([...refs, ref]));
  }

  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (ALWAYS_DROP.has(key) || key === '$defs' || key === 'definitions') continue;
    if (flavor === 'gemini' && GEMINI_DROP.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, normalizeNode(v, root, flavor, depth + 1, refs)]),
      );
    } else if (key === 'items' || key === 'anyOf' || key === 'oneOf' || key === 'allOf' || key === 'prefixItems') {
      out[key] = normalizeNode(value, root, flavor, depth + 1, refs);
    } else {
      out[key] = value;
    }
  }

  if (flavor === 'gemini') {
    // `type: ["string", "null"]` → `type: "string", nullable: true` (Gemini takes one type).
    if (Array.isArray(out.type)) {
      const types = out.type.filter((t: unknown) => t !== 'null');
      if (types.length < out.type.length) out.nullable = true;
      out.type = types[0] ?? 'string';
    }
    // Gemini's `enum` is a list of strings.
    if (Array.isArray(out.enum)) out.enum = out.enum.filter((v: unknown) => v !== null).map((v: unknown) => String(v));
    // `oneOf` is not in Gemini's subset; `anyOf` is, with the same meaning for a tool argument.
    if (out.oneOf && !out.anyOf) { out.anyOf = out.oneOf; delete out.oneOf; }
    if (out.allOf) {
      // Merge an allOf of object schemas; anything else keeps its first member.
      const parts: Json[] = Array.isArray(out.allOf) ? out.allOf : [];
      delete out.allOf;
      for (const part of parts) {
        if (part?.properties) out.properties = { ...(out.properties || {}), ...part.properties };
        if (Array.isArray(part?.required)) out.required = [...new Set([...(out.required || []), ...part.required])];
        if (!out.type && part?.type) out.type = part.type;
      }
    }
  }

  // `required` may only name properties that exist (OpenAI and Gemini both refuse otherwise).
  if (Array.isArray(out.required)) {
    const props = out.properties && typeof out.properties === 'object' ? out.properties : null;
    out.required = out.required.filter((r: unknown) => typeof r === 'string' && (!props || r in props));
    if (out.required.length === 0) delete out.required;
  }
  if (out.properties && !out.type) out.type = 'object';
  // An array without `items` is refused by OpenAI and Gemini alike.
  if (out.type === 'array' && !out.items) out.items = {};
  return out;
}

/**
 * The parameters schema one provider will accept. The root is always `type: "object"` with
 * `properties`: OpenAI refuses any other root, and a root `anyOf`/`oneOf` of object alternatives
 * is folded into one object whose properties are all optional (the tool validates for itself).
 */
export function normalizeToolSchema(schema: Json, flavor: SchemaFlavor = 'portable'): Json {
  const root = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : {};
  let out = normalizeNode(root, root, flavor, 0, new Set());
  const alternatives: Json[] | undefined = Array.isArray(out.anyOf) ? out.anyOf : Array.isArray(out.oneOf) ? out.oneOf : undefined;
  if (alternatives && !out.properties) {
    const properties: Json = {};
    for (const alt of alternatives) if (alt?.properties) Object.assign(properties, alt.properties);
    const { anyOf: _a, oneOf: _o, ...rest } = out;
    out = { ...rest, properties };
  }
  if (out.type !== 'object') out = { ...out, type: 'object' };
  if (!out.properties || typeof out.properties !== 'object') out.properties = {};
  return out;
}

/** One request's tools, in the provider's shape, and the map to read the model's calls back. */
export function buildWireTools(
  tools: Array<{ name: string; description?: string; input_schema?: Json; parameters?: Json }>,
  flavor: SchemaFlavor,
): { defs: Array<{ type: 'function'; function: { name: string; description: string; parameters: Json } }>; names: ToolNameMap; dropped: string[] } {
  const kept = tools.slice(0, MAX_TOOLS_PER_REQUEST);
  const dropped = tools.slice(MAX_TOOLS_PER_REQUEST).map((t) => t.name);
  const names = new ToolNameMap(kept.map((t) => t.name));
  const defs = kept.map((t) => ({
    type: 'function' as const,
    function: {
      name: names.toWire(t.name),
      description: String(t.description || t.name).slice(0, 4096),
      parameters: normalizeToolSchema(t.input_schema || t.parameters, flavor),
    },
  }));
  return { defs, names, dropped };
}

/** Rewrite the tool-call names already in the conversation to the spelling this request uses. */
export function renameHistoryToolCalls(messages: Json[], names: ToolNameMap): Json[] {
  let anyChanged = false;
  const out = messages.map((m) => {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) return m;
    let changed = false;
    const calls = m.tool_calls.map((c: Json) => {
      const name = c?.function?.name;
      if (typeof name !== 'string') return c;
      const wire = names.toWire(name);
      if (wire === name) return c;
      changed = true;
      return { ...c, function: { ...c.function, name: wire } };
    });
    if (!changed) return m;
    anyChanged = true;
    return { ...m, tool_calls: calls };
  });
  return anyChanged ? out : messages;
}
