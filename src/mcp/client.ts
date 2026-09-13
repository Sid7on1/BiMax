import { outcomeError, outcomeOk } from '../tools/outcome';
import { reportCapability } from '../core/capability.status';
import { ToolRegistry } from '../tools/tool.registry';
import { buildTool, BuiltTool } from '../tools/tool.factory';
import { IGovernor } from '../core/interfaces';
import { Logger } from '../utils/logger';
import { withTimeout } from '../utils/withTimeout'; // shared, leak-safe — a hung server never blocks boot/add
import { recordMcpCall } from './stats';
import { McpServerSpec } from './config';
import { extractTaskRef, awaitTaskResult } from './tasks';

// The MCP SDK ships package "exports" maps that our classic TS moduleResolution can't follow
// for types; the dual-published CJS build resolves fine at runtime, so we require() it at the
// boundary and keep the SDK objects loosely typed inside this module only.
/* eslint-disable @typescript-eslint/no-require-imports */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
/* eslint-enable @typescript-eslint/no-require-imports */

// Baseline env a spawned server needs to function as a process — nothing secret in it.
// v2 threat model, cut #4: a stdio MCP server used to inherit the FULL parent env, so every
// API key on the machine leaked to every community server (one compromised npm package away
// from exfiltration). Now a server sees this baseline + ONLY the env its spec declares.
const MCP_ENV_BASELINE = [
  'PATH', 'HOME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME',
  // Node/npm plumbing many stdio servers (npx-launched) legitimately need:
  'NODE_ENV', 'NODE_PATH', 'NODE_OPTIONS', 'npm_config_cache', 'npm_config_prefix',
];

/** Scrubbed env for a stdio MCP server: toolchain baseline + the spec's declared env only. */
export function mcpChildEnv(spec: McpServerSpec): Record<string, string> {
  // Escape hatch for setups that rely on globally-exported keys instead of declaring them
  // per-server. Explicit and loud — inheriting everything is the insecure legacy behavior.
  if (!spec.forceScrubEnv && process.env.BIMAX_MCP_ENV_INHERIT === '1') {
    return { ...process.env as Record<string, string>, ...(spec.env || {}) };
  }
  const out: Record<string, string> = {};
  for (const k of MCP_ENV_BASELINE) {
    if (process.env[k] !== undefined) out[k] = process.env[k]!;
  }
  return { ...out, ...(spec.env || {}) };
}

/**
 * Open a transport+client for a spec. Local (stdio) specs launch a command; remote specs
 * connect to a URL — trying Streamable HTTP first, then falling back to SSE (older hosted
 * servers only speak SSE). Returns a connected client or throws.
 */
export async function openClient(spec: McpServerSpec): Promise<any> {
  const client = new Client({ name: 'bimax', version: '1.0.0' }, { capabilities: {} });

  if (spec.url) {
    const url = new URL(spec.url);
    const headers = spec.headers || undefined;
    const reqInit = headers ? { requestInit: { headers } } : undefined;
    // Honor an explicit transport choice; otherwise prefer HTTP and fall back to SSE.
    if (spec.type === 'sse') {
      await withTimeout(client.connect(new SSEClientTransport(url, reqInit)), 30000, `MCP '${spec.name}' (SSE)`);
      return client;
    }
    try {
      await withTimeout(client.connect(new StreamableHTTPClientTransport(url, reqInit)), 30000, `MCP '${spec.name}' (HTTP)`);
      return client;
    } catch (httpErr: any) {
      Logger.warn(`[MCP] '${spec.name}' HTTP transport failed (${httpErr.message}); trying SSE.`);
      try { await client.close?.(); } catch { /* failed transports are best-effort cleanup */ }
      const sseClient = new Client({ name: 'bimax', version: '1.0.0' }, { capabilities: {} });
      await withTimeout(sseClient.connect(new SSEClientTransport(url, reqInit)), 30000, `MCP '${spec.name}' (SSE)`);
      return sseClient;
    }
  }

  // `stderr: 'pipe'` is critical: the SDK default is 'inherit', which dumps the child server's
  // stderr straight into our Ink TUI (corrupting the display). Piping keeps it off the terminal,
  // and we drain it into the logger — and into the failure reason when a server exits on startup.
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args || [],
    // Scrubbed: baseline + declared env only — a server missing a key should have it
    // declared in its spec (or set BIMAX_MCP_ENV_INHERIT=1 to accept the legacy leak).
    env: mcpChildEnv(spec),
    stderr: 'pipe',
  });

  const stderrChunks: string[] = [];
  const drainStderr = () => {
    try {
      const s: any = (transport as any).stderr;
      if (s && typeof s.on === 'function') {
        s.on('data', (d: Buffer) => {
          const text = d.toString();
          stderrChunks.push(text);
          Logger.warn(`[MCP:${spec.name}] ${text.trim()}`);
        });
      }
    } catch { /* best-effort */ }
  };

  try {
    await withTimeout(client.connect(transport), 30000, `MCP '${spec.name}' (stdio)`);
    drainStderr(); // keep future stderr out of the terminal and in the log
    return client;
  } catch (e: any) {
    drainStderr();
    await new Promise(r => setTimeout(r, 50)); // let buffered stderr flush
    const detail = stderrChunks.join('').trim();
    if (detail) {
      const lastLines = detail.split('\n').filter(Boolean).slice(-3).join(' ');
      throw new Error(`${e?.message || e} — server said: ${lastLines}`, { cause: e });
    }
    throw e;
  }
}

/**
 * Coerce a single value to the type its JSON Schema declares. Only converts the safe, common cases
 * a weak model gets wrong — string→number/integer and string→boolean — and recurses into arrays and
 * nested objects. Anything that doesn't cleanly convert is left untouched so we never corrupt input.
 */
function coerceValueToSchema(value: any, schema: any): any {
  if (!schema || value == null) return value;
  // JSON Schema `type` may be a string or an array of allowed types; normalize to a set.
  const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];

  if ((types.includes('number') || types.includes('integer')) && typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed !== '' && !isNaN(Number(trimmed))) {
      const n = Number(trimmed);
      return types.includes('integer') && !types.includes('number') ? Math.trunc(n) : n;
    }
  }
  if (types.includes('boolean') && typeof value === 'string') {
    const l = value.trim().toLowerCase();
    if (l === 'true') return true;
    if (l === 'false') return false;
  }
  if (types.includes('array') && Array.isArray(value) && schema.items) {
    return value.map((v) => coerceValueToSchema(v, schema.items));
  }
  if (types.includes('object') && value && typeof value === 'object' && schema.properties) {
    return coerceArgsToSchema(value, schema);
  }
  return value;
}

/** Coerce each property of an args object to the types its tool input schema declares. */
export function coerceArgsToSchema(args: any, schema: any): any {
  if (!schema || !schema.properties || !args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out: any = { ...args };
  for (const [key, propSchema] of Object.entries<any>(schema.properties)) {
    if (key in out) out[key] = coerceValueToSchema(out[key], propSchema);
  }
  return out;
}

export interface ConnectedMcp {
  name: string;
  client: any;
  toolNames: string[];
  /** The exact spec this connection was opened with — lets the watchdog/healer reconnect a server
   *  that isn't in any config file (built-ins, tests) without a config round-trip. */
  spec: McpServerSpec;
}

/** List every page and return a stable order, as required by the MCP tools contract. */
export async function listAllMcpTools(client: any, maxPages = 32, maxTools = 2048): Promise<any[]> {
  const tools: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const listed = await client.listTools(cursor ? { cursor } : undefined);
    if (Array.isArray(listed?.tools)) tools.push(...listed.tools);
    if (tools.length > maxTools) throw new Error(`MCP tool catalog exceeds ${maxTools} entries`);
    const next = typeof listed?.nextCursor === 'string' && listed.nextCursor ? listed.nextCursor : undefined;
    if (!next) break;
    cursor = next;
    if (page === maxPages - 1) throw new Error(`MCP tool catalog exceeds ${maxPages} pages`);
  }
  return tools.sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')));
}

/**
 * Is this text block just a re-serialization of the same structured payload?
 *
 * Key order is not normalized: a server emits both fields from one object, so they agree on order,
 * and canonicalizing would make two genuinely different payloads look identical. Only formatting is
 * neutralized, which is the difference this is meant to see through.
 */
function sameJsonPayload(text: string, structured: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(structured);
  } catch {
    return false; // not JSON at all — a real summary, keep it
  }
}

/** Flatten an MCP tool result's content array into a plain string for the agent. */
export function contentToString(result: any): string {
  if (!result) return '';
  const content = result.content;
  if (Array.isArray(content)) {
    const rendered = content
      .map((c: any) => {
        if (c?.type === 'text') return c.text;
        if (c?.type === 'resource') return c.resource?.text || (c.resource ? JSON.stringify(c.resource) : '[resource content]');
        if (c?.type === 'image') return `[image content: ${c.mimeType || 'unknown type'}, ${c.data?.length || 0} encoded bytes]`;
        return c?.type ? `[${c.type} content]` : '';
      })
      .filter(Boolean)
      .join('\n');
    if (result.structuredContent !== undefined) {
      const structured = JSON.stringify(result.structuredContent, null, 2);
      if (!rendered) return structured;
      // MCP lets a server answer in both fields, and the spec ENCOURAGES mirroring the structured
      // payload into a text block for clients that cannot read `structuredContent`. Our own
      // `mac_control` does exactly that, so every computer-use result was being handed to the model
      // twice — an observe carrying 40+ elements paid for its whole element list, its guidance
      // prose and its screenshot metadata a second time, in the same turn that a small model has to
      // plan the next action from. Emit one copy when they are the same payload.
      //
      // Compared parsed, not textually: the two differ in whitespace by construction (the text
      // block is the server's own formatting, this one is 2-space). A server that puts a genuine
      // human summary in text and data in structured is NOT the same payload and keeps both.
      if (sameJsonPayload(rendered, result.structuredContent)) return structured;
      return `${rendered}\n${structured}`;
    }
    return rendered;
  }
  return typeof result === 'string' ? result : JSON.stringify(result);
}

/** Does this error mean the transport/process is gone (vs. the tool itself failing)? */
export function isDeadConnectionError(e: any): boolean {
  const msg = String(e?.message || e);
  return /connection closed|not connected|transport (?:closed|error)|EPIPE|ECONNRESET|write after end/i.test(msg);
}

/**
 * A healer the manager injects: given a server name, try to bring it back and return the FRESH
 * client (or null). Lets a tool call survive a crashed/expired server transparently: reconnect
 * once, retry the call on the new client — no recursion (the retry is a direct client call).
 */
export type McpHealer = (serverName: string) => Promise<any | null>;

/** Acting on the host computer is outside the code-only Bimax product boundary, even when an
 * arbitrary MCP server advertises the old tool name under a different server id. */
export function isDisabledComputerUseToolName(name: string): boolean {
  return /^(?:mac_control|computer_control|computer)$/i.test(String(name || '').trim());
}

/**
 * Bimax for Mac owns approval for its single native Computer Use entrypoint.
 *
 * A Control Mac instruction is explicitly selected in the desktop composer, then the provider
 * applies its resolved-target policy, sensitive-surface blocks and takeover gate to every action.
 * Sending that same entrypoint through the terminal engine's generic external-tool governor made
 * one task ask "Run mac_control?" before every observation and click. That was duplicate consent,
 * not an additional safety boundary. Keep every other MCP tool fail-closed.
 */
export function approvalHandledByAppOwnedProvider(serverName: string, toolName: string): boolean {
  return serverName === 'bimax-mac' && toolName === 'mac_control';
}

export function mcpToolCallRequest(
  _serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // This used to attach a signed `_meta.bimaxTrustedPlan` envelope for the app-owned `mac_control`
  // entrypoint. Bimax is a code-only agentic IDE (see archive/computer-use/): no Computer Use
  // provider is ever registered, and `isDisabledComputerUseToolName` above refuses `mac_control`
  // at registration, so the envelope had no reachable consumer. Keep the request shape plain.
  return { name: toolName, arguments: args };
}

/**
 * Connect to one MCP server (stdio) and register each of its tools into the registry as a
 * native-looking `mcp__<server>__<tool>` tool, governed like any other. Returns the
 * connection (for later close), or null if the server failed to start — never throws, so a
 * bad server never blocks boot.
 */
export async function connectAndRegister(
  spec: McpServerSpec,
  registry: ToolRegistry,
  governor: IGovernor,
  onError?: (message: string) => void,
  healer?: McpHealer,
): Promise<ConnectedMcp | null> {
  let client: any;
  const registered = new Map<string, BuiltTool | undefined>();
  try {
    client = await openClient(spec);

    const listed = await listAllMcpTools(client);
    const toolNames: string[] = [];
    for (const t of listed) {
      if (isDisabledComputerUseToolName(String(t.name || ''))) {
        Logger.warn(`[MCP] Skipping disabled Computer Use tool '${spec.name}/${t.name}'.`);
        continue;
      }
      const toolName = `mcp__${spec.name}__${t.name}`;
      registered.set(toolName, registry.getTool(toolName));
      registry.register(buildTool({
        name: toolName,
        description: `[MCP:${spec.name}] ${t.description || t.name}`,
        schema: t.inputSchema || { type: 'object', properties: {} },
        isDestructive: true, // external tools are fail-closed under the Governor
        approvalHandledInternally: approvalHandledByAppOwnedProvider(spec.name, String(t.name || '')),
        execute: async (args: any) => {
          // Weak models routinely emit numbers/booleans as strings ("1", "true"). MCP servers
          // validate strictly (zod) and reject those, so coerce each arg to its declared schema
          // type first. Native tools tolerate strings already; MCP is where strict validation bites.
          const coerced = coerceArgsToSchema(args || {}, t.inputSchema);
          const configuredTimeout = Number(process.env.BIMAX_MCP_CALL_TIMEOUT_MS || 120000);
          const timeoutMs = Number.isFinite(configuredTimeout)
            ? Math.min(Math.max(configuredTimeout, 1000), 10 * 60 * 1000)
            : 120000;
          const started = Date.now();
          try {
            let res: any;
            const call = mcpToolCallRequest(spec.name, String(t.name || ''), coerced);
            try {
              res = await withTimeout<any>(
                client.callTool(call),
                timeoutMs,
                `MCP tool '${spec.name}/${t.name}'`,
              );
            } catch (e: any) {
              // Self-heal: a crashed/expired server shows up as a dead transport, not a tool error.
              // Reconnect once and retry on the fresh client — the retry is a direct client call
              // (never back through the registry), so a still-dead server can't recurse.
              if (!healer || !isDeadConnectionError(e)) throw e;
              reportCapability({ id: `mcp:${spec.name}`, label: `MCP ${spec.name}`, state: 'unavailable',
                reason: 'The connection stopped responding during an operation.', impact: 'The operation requires a reconnect.',
                action: 'Bimax is attempting its bounded reconnect.' });
              Logger.warn(`[MCP] '${spec.name}' connection dead mid-call (${e?.message}); reconnecting to retry.`);
              const fresh = await healer(spec.name);
              if (!fresh) throw e;
              res = await withTimeout<any>(
                fresh.callTool(call),
                timeoutMs,
                `MCP tool '${spec.name}/${t.name}' (after reconnect)`,
              );
            }
            // MCP Tasks extension: a task-shaped response means the server accepted the work
            // and is running it asynchronously — poll it to completion (within the remaining
            // call budget) and substitute the real result, so the agent never sees the stub.
            const taskRef = extractTaskRef(res);
            if (taskRef) {
              const remaining = Math.max(1000, timeoutMs - (Date.now() - started));
              res = await awaitTaskResult(client, spec.name, t.name, taskRef, remaining);
            }
            const text = contentToString(res);
            recordMcpCall(spec.name, t.name, Date.now() - started, res?.isError ? text : undefined);
            return res?.isError ? outcomeError('unknown', `MCP tool ${t.name} reported an error: ${text}`) : outcomeOk(text);
          } catch (e: any) {
            recordMcpCall(spec.name, t.name, Date.now() - started, e?.message || String(e));
            throw e;
          }
        },
      }, governor));
      toolNames.push(toolName);
    }

    Logger.info(`[MCP] Connected '${spec.name}' — registered ${toolNames.length} tool(s).`);
    return { name: spec.name, client, toolNames, spec };
  } catch (e: any) {
    // A failed handshake/list/register must leave neither a child process nor half-registered tools.
    try { await client?.close?.(); } catch { /* best-effort */ }
    for (const [name, previous] of registered) {
      if (previous) registry.register(previous);
      else registry.unregister(name);
    }
    const msg = e?.message || String(e);
    Logger.warn(`[MCP] Failed to connect '${spec.name}': ${msg}`);
    onError?.(msg);
    return null;
  }
}

/** Connect every configured server and register its tools. Returns the live connections. */
export async function registerMcpTools(
  specs: McpServerSpec[],
  registry: ToolRegistry,
  governor: IGovernor
): Promise<ConnectedMcp[]> {
  const connected: ConnectedMcp[] = [];
  for (const spec of specs) {
    const c = await connectAndRegister(spec, registry, governor);
    if (c) connected.push(c);
  }
  return connected;
}
