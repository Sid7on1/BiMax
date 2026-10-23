/** Canonicalize tool-call arguments and conservatively repair common quote-boundary damage.
 *
 * Some OpenAI-compatible tool models emit the right object but displace one quote at a field
 * boundary, for example `{"action":"click, "query":""Search"}`. Rejecting that forever leaves a
 * capable desktop runtime unreachable. Repair is deliberately narrow: it runs only after strict
 * JSON parsing fails, makes only lexical quote-boundary corrections, and succeeds only when the
 * final value is a plain object. Tool schema and safety validation still run afterwards.
 */

export interface CanonicalToolArgs {
  json: string;
  value: Record<string, unknown>;
  repaired: boolean;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parsed(candidate: string, repaired: boolean): CanonicalToolArgs | null {
  try {
    const value = JSON.parse(candidate);
    return plainObject(value) ? { json: JSON.stringify(value), value, repaired } : null;
  } catch {
    return null;
  }
}

/** Recover a corrected JSON object appended after a damaged draft. If the prefix is also a valid
 * object, the two calls are ambiguous and neither is selected. */
function trailingCorrectedObject(source: string): CanonicalToolArgs | null {
  for (let index = source.lastIndexOf('{'); index > 0; index = source.lastIndexOf('{', index - 1)) {
    const suffix = parsed(source.slice(index).trim(), true);
    if (!suffix) continue;
    const prefix = source.slice(0, index).trim();
    if (!prefix || parsed(prefix, false)) return null;
    // A correction follows a COMPLETE draft. With containers still open before it, this `{` is inside the call — the
    // last slide's table, say — and running that inner object as the whole call is worse than refusing. Found
    // 2026-10-01: a deck cut off after its table ran as `{"columns":…,"rows":…}`.
    // Only when the draft's quotes balance can its brackets be read; a broken-quote draft is the case this rule is for.
    const draft = scanBrackets(prefix);
    if (!draft.mismatch && draft.openString === undefined && draft.stack.length > 0) continue;
    return suffix;
  }
  return null;
}

/** A container open at some point in the arguments, where it opened, and the key it is the value of. */
interface OpenContainer { kind: '{' | '['; at: number; key?: string }

interface BracketScan {
  stack: OpenContainer[];
  /** The first closing bracket that does not fit what is open. */
  mismatch?: { at: number; problem: string };
  /** Where an unterminated string began, if the input ends inside one. */
  openString?: number;
}

function describeContainer(container: OpenContainer): string {
  return `the ${container.kind === '{' ? 'object' : 'array'}${container.key !== undefined ? ` "${container.key}"` : ''} `
    + `opened at character ${container.at + 1}`;
}

/** Walk the bracket structure only — strings and escapes respected — and stop at the first closer that does not fit. */
function scanBrackets(source: string): BracketScan {
  const stack: OpenContainer[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let lastString = '';
  let key: string | undefined;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') { inString = false; lastString = source.slice(stringStart + 1, i); }
      continue;
    }
    if (ch === '"') { inString = true; stringStart = i; }
    else if (ch === ':') key = lastString;
    else if (ch === ',') key = undefined;
    else if (ch === '{' || ch === '[') { stack.push({ kind: ch, at: i, key }); key = undefined; }
    else if (ch === '}' || ch === ']') {
      const top = stack[stack.length - 1];
      if (!top) return { stack, mismatch: { at: i, problem: `found \`${ch}\` but nothing is open — one closing bracket too many` } };
      if (top.kind !== (ch === '}' ? '{' : '[')) {
        return { stack, mismatch: { at: i, problem: `found \`${ch}\`, but the innermost open container is ${describeContainer(top)}, which closes with \`${top.kind === '{' ? '}' : ']'}\`` } };
      }
      stack.pop();
      key = undefined;
    }
  }
  return inString ? { stack, openString: stringStart } : { stack };
}

/**
 * Rebuild the run of closing brackets after the last value.
 *
 * Measured 2026-10-01: gpt-oss-20b sent the same deck to DocumentTool six times and every attempt was valid JSON up to
 * its final closing run, which was wrong each time — `]]}]}]}` and `]]]}}}` where the structure needed `]]}}]}}`. After
 * the last value there is exactly one valid way to close what is open, so the run is replaced by it. Nothing before
 * the run changes, and a dangling `,` or `:` (something missing, not misclosed) is left alone.
 */
function repairClosingRun(source: string): string | null {
  let tail = source.length;
  while (tail > 0 && /[\s\]}]/.test(source[tail - 1])) tail--;
  if (tail === source.length) return null;
  const prefix = source.slice(0, tail);
  const last = prefix.trimEnd().slice(-1);
  if (!last || last === ',' || last === ':') return null;
  const scan = scanBrackets(prefix);
  if (scan.mismatch || scan.openString !== undefined || scan.stack.length === 0) return null;
  return prefix + [...scan.stack].reverse().map((c) => (c.kind === '{' ? '}' : ']')).join('');
}

/**
 * Where arguments stop being JSON, in words a model can act on: the character, what is wrong there, which containers
 * are open, and the text around it. The old message echoed the whole argument string back; a weak model resent it
 * almost unchanged, because nothing said where the problem was.
 */
export function describeJsonError(source: string): string {
  const scan = scanBrackets(source);
  let at: number;
  let problem: string;
  if (scan.mismatch) ({ at, problem } = scan.mismatch);
  else if (scan.openString !== undefined) { at = scan.openString; problem = 'a string starts here and is never closed'; }
  else if (scan.stack.length > 0) { at = source.length; problem = `the input ends while ${describeContainer(scan.stack[scan.stack.length - 1])} is still open`; }
  else {
    try { JSON.parse(source); return 'The arguments are valid JSON.'; }
    catch (error) {
      const message = String((error as Error).message);
      const position = /position (\d+)/.exec(message);
      at = position ? Number(position[1]) : source.length;
      problem = message.replace(/\s*in JSON at position \d+.*$/s, '').replace(/^JSON Parse error:\s*/, '');
    }
  }
  const open = scanBrackets(source.slice(0, at)).stack;
  const path = open.map((c) => `${c.key !== undefined ? `"${c.key}" ` : ''}${c.kind === '{' ? '{…}' : '[…]'}`).join(' › ');
  const before = source.slice(Math.max(0, at - 60), at);
  const after = source.slice(at + 1, at + 25);
  return `Character ${at + 1} of ${source.length}: ${problem}.`
    + (path ? `\nOpen at that point: ${path}.` : '')
    + `\nAround it: …${before}⟪${source[at] ?? 'end of input'}⟫${after}${at + 25 < source.length ? '…' : ''}`;
}

export interface CanonicalToolArgsOptions {
  /**
   * Rebuild a wrong closing-bracket run (`repairClosingRun`). Off for a call cut off at the output-token limit: closing
   * that would turn half a document into a valid, shorter one and run it.
   */
  closeBrackets?: boolean;
}

/** Return canonical JSON, a conservatively repaired object, or null when intent is ambiguous. */
export function canonicalToolArgs(raw: unknown, options: CanonicalToolArgsOptions = {}): CanonicalToolArgs | null {
  if (plainObject(raw)) {
    try { return { json: JSON.stringify(raw), value: raw, repaired: false }; }
    catch { return null; }
  }
  if (raw == null) return { json: '{}', value: {}, repaired: false };
  const source = String(raw).trim();
  if (!source) return { json: '{}', value: {}, repaired: false };
  const strict = parsed(source, false);
  if (strict) return strict;

  // Live decoder pattern: a malformed draft is immediately followed by its complete correction.
  // Extracting only a uniquely valid suffix avoids trying to lexically repair a concatenation.
  const correctedSuffix = trailingCorrectedObject(source);
  if (correctedSuffix) return correctedSuffix;

  let candidate = source;
  // Extra opening quote: `"query":""Search"` -> `"query":"Search"`.
  candidate = candidate.replace(/(:\s*)""([^"\\\r\n]+)"/g, '$1"$2"');
  // Lost closing quote immediately before the next object key:
  // `"action":"click, "x":20` -> `"action":"click", "x":20`.
  // Repeat because one call can contain several damaged enum/string fields.
  const missingTerminator = /("(?:\\.|[^"\\])*"\s*:\s*")((?:\\.|[^"\\])*?)(,\s*"[^"\r\n]+"\s*:)/g;
  for (let pass = 0; pass < 4; pass++) {
    const next = candidate.replace(missingTerminator, '$1$2"$3');
    if (next === candidate) break;
    candidate = next;
  }
  // Split array token seen from tool-tuned models: `[""]cmd` -> `["cmd"]`.
  candidate = candidate.replace(/\[\s*""\]\s*([A-Za-z][A-Za-z0-9_+.-]*)(?=\s*[,}])/g, '["$1"]');

  const quoted = candidate === source ? null : parsed(candidate, true);
  if (quoted) return quoted;
  if (options.closeBrackets === false) return null;
  const closed = repairClosingRun(candidate);
  return closed ? parsed(closed, true) : null;
}
