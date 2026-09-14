/**
 * Recovery for tool calls a model emits as plain text instead of through the
 * function-calling API. Some OpenAI-compatible models (notably minimax on NVIDIA)
 * intermittently answer with `{"name":"BashTool","parameters":{...}}` written into
 * the content channel. Left alone, that JSON leaks to the user and the tool never
 * runs — so the agent loop uses this to recover the call and execute it through the
 * normal, governor-gated path.
 *
 * Safety: a JSON blob is only treated as a call when its `name` matches a REAL
 * registered tool (checked via the `isRegisteredTool` predicate). Arbitrary JSON a
 * user asked the model to produce will not name a live tool, so it is never matched
 * and never executed.
 */

/** A tool call recovered from text, shaped like the native streaming tool_call. */
export interface ParsedToolCall {
  id: string;
  name: string;
  /** Arguments as a JSON string, matching the native function-calling path. */
  args: string;
}

/** The one tool an operation turn already requires, used to recover a NAMELESS argument object. */
export interface DefaultToolCandidate {
  name: string;
  /** JSON Schema of that tool's arguments; only `properties` and `required` are consulted. */
  schema: unknown;
}

export interface TextToolCallOptions {
  /**
   * When the loop has already required one specific tool for this turn, a bare argument object with
   * no `name` is still an unambiguous invocation of it. Supplying the tool here enables that
   * recovery; omitting it keeps the strict name-gated behaviour.
   */
  defaultTool?: DefaultToolCandidate;
}

export interface TextToolCallExtraction {
  toolCalls: ParsedToolCall[];
  /** The content with every recognized tool-call JSON blob removed. */
  cleanedText: string;
}

/** Index of the `}` that closes the `{` at `start`, respecting strings/escapes; -1 if unbalanced. */
function matchBalancedObject(s: string, start: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Parse a candidate object into a tool call if it has a registered name; else null. */
/**
 * A tool name without the harmony tokens gpt-oss sometimes glues to it (backlog Q1): `AskUserTool<|channel|>commentary`
 * and `functions.AskUserTool` both name AskUserTool. Left in, the fuzzy registry lookup could still run the tool, but the
 * garbled name went back to the model in its own history and showed in the thread.
 */
export function cleanToolName(name: string): string {
  return name.replace(/<\|[^|>]*\|>[\s\S]*$/, '').replace(/^functions\./, '').trim();
}

function asToolCall(candidate: string, isRegisteredTool: (name: string) => boolean): { name: string; args: string } | null {
  let obj: any;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  // Accept the common shapes: {name, parameters|arguments|input} and {function:{name, arguments}}.
  const raw = obj.name ?? obj.tool ?? obj.function?.name;
  const name = typeof raw === 'string' ? cleanToolName(raw) : raw;
  if (typeof name !== 'string' || !isRegisteredTool(name)) return null;

  const rawArgs = obj.parameters ?? obj.arguments ?? obj.input ?? obj.function?.arguments ?? {};
  let args: string;
  if (typeof rawArgs === 'string') {
    args = rawArgs; // already a JSON string (some models nest a stringified payload)
  } else {
    try { args = JSON.stringify(rawArgs); } catch { args = '{}'; }
  }
  return { name, args };
}

/** Everything that wraps a tool-call payload without being part of it. */
function unwrapToolCallPayload(content: string): string {
  return content
    .replace(/<\/?tool_call>/gi, '')
    .replace(/```(?:json|tool_code)?/gi, '```')
    .replace(/```/g, '')
    .trim();
}

/**
 * A nameless argument object, recovered ONLY against the tool this turn already requires.
 *
 * The observed failure: on a required-tool turn the model stops emitting a name and writes
 * just `{"action":"click","query":"mom","frameId":"…"}` into the content channel. That is a
 * complete, unambiguous invocation of the one tool the turn is about, but the name-gated path
 * cannot see it, so the operation silently ends one action short of sending the message.
 *
 * Kept safe by shape, not by trust: the payload must be the WHOLE message (bar fences/wrappers) —
 * never a JSON example embedded in prose — every key must exist in that tool's schema, and every
 * required key must be present. Arbitrary JSON a user asked the model to produce does not satisfy
 * a real tool's schema, and outside a required-tool turn this path never runs at all.
 */
function asDefaultToolCall(content: string, defaultTool: DefaultToolCandidate): ParsedToolCall | null {
  const payload = unwrapToolCallPayload(content);
  if (!payload.startsWith('{') || matchBalancedObject(payload, 0) !== payload.length - 1) return null;

  let value: any;
  try { value = JSON.parse(payload); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // A named object is the strict path's business; never let this one re-interpret a rejected name.
  if (value.name != null || value.tool != null || value.function != null) return null;

  const schema = defaultTool.schema as { properties?: Record<string, unknown>; required?: unknown } | undefined;
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every(key => Object.prototype.hasOwnProperty.call(properties, key))) return null;
  const required = Array.isArray(schema?.required) ? schema!.required as string[] : [];
  if (!required.every(key => value[key] !== undefined)) return null;

  return {
    id: `text-call-default-${Date.now()}`,
    name: defaultTool.name,
    args: JSON.stringify(value),
  };
}

/**
 * Scan `content` for tool calls written as JSON text and return them alongside the
 * content with those blobs stripped out. Only blobs naming a registered tool match,
 * unless `options.defaultTool` supplies the tool this turn already requires.
 */
export function extractTextToolCalls(
  content: string,
  isRegisteredTool: (name: string) => boolean,
  options?: TextToolCallOptions
): TextToolCallExtraction {
  const toolCalls: ParsedToolCall[] = [];
  const removals: Array<[number, number]> = [];

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue;
    const end = matchBalancedObject(content, i);
    // ponytail: this `{` never closes (a truncated snippet, a bare `${`), but a real tool-call
    // object can still appear later — keep scanning instead of giving up. O(n²) worst case is fine
    // on turn-sized content; revisit if calls are ever parsed over megabytes.
    if (end === -1) continue;
    const call = asToolCall(content.slice(i, end + 1), isRegisteredTool);
    if (call) {
      toolCalls.push({ id: `text-call-${toolCalls.length}-${Date.now()}`, name: call.name, args: call.args });
      removals.push([i, end + 1]);
      i = end; // skip past this object
    }
  }

  if (toolCalls.length === 0 && options?.defaultTool) {
    const recovered = asDefaultToolCall(content, options.defaultTool);
    // The whole message WAS the call, so nothing user-facing survives it.
    if (recovered) return { toolCalls: [recovered], cleanedText: '' };
  }

  let cleanedText = content;
  if (removals.length > 0) {
    let out = '';
    let last = 0;
    for (const [a, b] of removals) { out += content.slice(last, a); last = b; }
    out += content.slice(last);
    cleanedText = out.replace(/<\/?tool_call>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  return { toolCalls, cleanedText };
}
