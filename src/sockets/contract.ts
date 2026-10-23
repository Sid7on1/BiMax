import * as fs from 'fs';
import * as path from 'path';

/**
 * The Open Socket — a retrieval-only window onto an external datastore.
 *
 * ## The requirement, stated honestly
 *
 * The ask was "a socket that can take information in but never send anything out". Taken literally
 * that is impossible: asking a database a question *is* an outbound send. Pretending otherwise would
 * ship a component whose safety label is false, which is worse than one whose limits are written
 * down. So this module implements the three properties that requirement actually needs:
 *
 * 1. **Read-only by construction.** Not "we check for a DELETE keyword" — the model never authors
 *    query text at all. A human writes named templates; the model may only invoke a template by
 *    name with typed parameters. There is no code path that carries model-authored SQL or a Redis
 *    command to a server.
 *
 * 2. **The outbound channel is bounded.** This is the property a read-only flag does NOT give you.
 *    If a model can write `SELECT * FROM t WHERE note = '<the confidential document it just read>'`,
 *    the query string is an exfiltration channel and the read-only verb is irrelevant — the secret
 *    already left in the WHERE clause. Parameters are therefore length-capped, type-checked, and
 *    pattern-constrained, so the total model-controlled bytes leaving the process is small and
 *    shaped. A 40-character equipment tag cannot smuggle a 4-page strategy memo.
 *
 * 3. **Every byte is on the record.** Each call appends to the egress ledger: template, parameters,
 *    host, bytes out, rows in. An operator can answer "what did this thing ever send?" exactly,
 *    rather than by assertion.
 *
 * ## Why templates rather than a query parser
 *
 * A verb allowlist over model-authored SQL is a parser problem, and parser problems are lost by the
 * defender: stacked statements, comment tricks, CTEs that wrap a write, vendor-specific syntax. The
 * template approach deletes the entire category — there is nothing to parse because there is no
 * model-authored query.
 */

/** Parameter types a template may declare. Deliberately narrow. */
export type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'enum';

export interface ParamSpec {
  name: string;
  type: ParamType;
  /** Max characters for a string. Hard-capped by MAX_PARAM_CHARS regardless of what is declared. */
  maxLength?: number;
  /**
   * Anchored regular expression a string must match. This is the sharpest available limit on the
   * outbound channel: `^[A-Z]-\d{3}$` admits "E-204" and nothing else, so the parameter cannot
   * carry prose at all.
   */
  pattern?: string;
  /** Permitted values, for `enum`. */
  values?: string[];
  min?: number;
  max?: number;
  required?: boolean;
  description?: string;
}

export interface QueryTemplate {
  name: string;
  description: string;
  /** Which connector this runs on, by name. */
  connector: string;
  /**
   * The query, with `$1`, `$2` … placeholders for SQL, or a Redis command form. Never interpolated
   * by string concatenation — the adapter binds parameters through its driver's own parameterised
   * path, so even a parameter that slipped the checks cannot change the query's shape.
   */
  statement: string;
  params: ParamSpec[];
  /** Hard row cap applied on top of whatever the statement says. */
  maxRows?: number;
}

export interface ConnectorConfig {
  name: string;
  kind: 'postgres' | 'redis';
  /** Host and port are declared here, never chosen by the model. */
  host: string;
  port: number;
  database?: string;
  user?: string;
  /** Environment variable holding the password. The secret itself is never written in config. */
  passwordEnv?: string;
  /** Connection and query timeout. */
  timeoutMs?: number;
  tls?: boolean;
}

export interface SocketConfig {
  connectors: ConnectorConfig[];
  templates: QueryTemplate[];
}

/**
 * The absolute ceiling on any single string parameter, whatever a template declares. A template
 * author who writes `maxLength: 100000` does not get to widen the exfiltration channel.
 */
export const MAX_PARAM_CHARS = 128;
/** Ceiling on the summed length of all parameters in one call. */
export const MAX_TOTAL_PARAM_CHARS = 512;
/** Rows a template may ever return, whatever it declares. */
export const MAX_ROWS = 500;
/** Characters of result text handed back to the model. */
export const MAX_RESULT_CHARS = 60_000;

export class SocketConfigError extends Error {}

/**
 * Validate one parameter against its spec. Returns the coerced value or throws.
 *
 * Order matters: type first, then bounds, then pattern. A number that arrives as the string "5" is
 * coerced (weak models emit numbers as strings routinely — see the MCP arg-coercion work), but a
 * string that arrives where a number is declared and does not parse is refused rather than
 * stringified, because a silently-stringified parameter changes what the query means.
 */
export function validateParam(spec: ParamSpec, raw: unknown): string | number | boolean {
  const missing = raw === undefined || raw === null || raw === '';
  if (missing) {
    if (spec.required === false) return '';
    throw new SocketConfigError(`parameter "${spec.name}" is required`);
  }

  if (spec.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new SocketConfigError(`parameter "${spec.name}" must be a boolean`);
  }

  if (spec.type === 'number' || spec.type === 'integer') {
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(value)) throw new SocketConfigError(`parameter "${spec.name}" must be a number`);
    if (spec.type === 'integer' && !Number.isInteger(value)) {
      throw new SocketConfigError(`parameter "${spec.name}" must be an integer`);
    }
    if (spec.min !== undefined && value < spec.min) {
      throw new SocketConfigError(`parameter "${spec.name}" must be >= ${spec.min}`);
    }
    if (spec.max !== undefined && value > spec.max) {
      throw new SocketConfigError(`parameter "${spec.name}" must be <= ${spec.max}`);
    }
    return value;
  }

  const value = String(raw);
  if (spec.type === 'enum') {
    const allowed = spec.values || [];
    if (!allowed.includes(value)) {
      throw new SocketConfigError(`parameter "${spec.name}" must be one of: ${allowed.join(', ')}`);
    }
    return value;
  }

  // string
  const limit = Math.min(spec.maxLength ?? MAX_PARAM_CHARS, MAX_PARAM_CHARS);
  if (value.length > limit) {
    throw new SocketConfigError(
      `parameter "${spec.name}" is ${value.length} characters; the limit is ${limit}. `
      + 'Socket parameters are deliberately short — they identify a record, they do not carry content.',
    );
  }
  if (spec.pattern) {
    // Anchored on both ends whether or not the author remembered to.
    const source = spec.pattern.startsWith('^') ? spec.pattern : `^${spec.pattern}`;
    const anchored = source.endsWith('$') ? source : `${source}$`;
    if (!new RegExp(anchored).test(value)) {
      throw new SocketConfigError(`parameter "${spec.name}" does not match the permitted form ${anchored}`);
    }
  }
  return value;
}

/** Validate a whole call. Returns positional bind values in the template's declared order. */
export function bindParams(template: QueryTemplate, args: Record<string, unknown>): (string | number | boolean)[] {
  const bound = template.params.map((spec) => validateParam(spec, args[spec.name]));
  const totalChars = bound.reduce<number>(
    (sum, value) => sum + (typeof value === 'string' ? value.length : String(value).length), 0,
  );
  if (totalChars > MAX_TOTAL_PARAM_CHARS) {
    throw new SocketConfigError(
      `parameters total ${totalChars} characters; the per-call limit is ${MAX_TOTAL_PARAM_CHARS}.`,
    );
  }
  const unknown = Object.keys(args).filter(
    (key) => !template.params.some((spec) => spec.name === key),
  );
  if (unknown.length) {
    // An undeclared parameter is refused rather than ignored: silently dropping it would let a
    // caller believe a filter was applied that never was.
    throw new SocketConfigError(
      `unknown parameter(s) for template "${template.name}": ${unknown.join(', ')}. `
      + `Declared: ${template.params.map((p) => p.name).join(', ') || '(none)'}`,
    );
  }
  return bound;
}

function assertShape(config: unknown): asserts config is SocketConfig {
  const value = config as SocketConfig;
  if (!value || typeof value !== 'object') throw new SocketConfigError('socket config must be an object');
  if (!Array.isArray(value.connectors)) throw new SocketConfigError('socket config needs a "connectors" array');
  if (!Array.isArray(value.templates)) throw new SocketConfigError('socket config needs a "templates" array');
  for (const connector of value.connectors) {
    if (!connector.name || !connector.kind || !connector.host) {
      throw new SocketConfigError('each connector needs name, kind and host');
    }
    if (connector.kind !== 'postgres' && connector.kind !== 'redis') {
      throw new SocketConfigError(`connector "${connector.name}": kind must be postgres or redis`);
    }
  }
  for (const template of value.templates) {
    if (!template.name || !template.statement || !template.connector) {
      throw new SocketConfigError('each template needs name, connector and statement');
    }
    if (!value.connectors.some((c) => c.name === template.connector)) {
      throw new SocketConfigError(`template "${template.name}" names unknown connector "${template.connector}"`);
    }
    if (!Array.isArray(template.params)) {
      throw new SocketConfigError(`template "${template.name}" needs a "params" array (use [] for none)`);
    }
  }
}

/** Default location. Config is operator-owned; nothing writes it programmatically. */
export function defaultConfigPath(): string {
  return path.join(process.cwd(), '.breakglass', 'sockets.json');
}

export async function loadSocketConfig(file?: string): Promise<SocketConfig | null> {
  const target = file || defaultConfigPath();
  let raw: string;
  try {
    raw = await fs.promises.readFile(target, 'utf8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw);
  assertShape(parsed);
  return parsed;
}
