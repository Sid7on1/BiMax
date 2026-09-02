import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A3 — MCP client config. Servers are declared in `.bimax/mcp.json`. Two shapes are
// accepted: our `{ servers: [{ name, command, args, env }] }`, and the Claude-style
// `{ mcpServers: { "<name>": { command, args, env } } }` for drop-in compatibility.
//
// A server is either LOCAL (stdio — `command`/`args`) or REMOTE (`url`, optionally
// `type: 'http' | 'sse'` and `headers`). Remote servers cover hosted endpoints like the
// ones mcpmarket / Smithery hand out as a single `https://…/mcp` link.

export interface McpServerSpec {
  name: string;
  // Local (stdio) transport:
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Internal trusted runtimes can forbid the legacy full-parent-env escape hatch. */
  forceScrubEnv?: boolean;
  /** Host-owned capability schemas that must be available without model-side discovery. */
  eager?: boolean;
  // Remote transport:
  url?: string;
  type?: 'http' | 'sse' | 'stdio';
  headers?: Record<string, string>;
  // When true, the server is kept in config but NOT started at boot until re-enabled.
  disabled?: boolean;
}

export const HOST_CAPABILITIES_ENV = 'BIMAX_HOST_CAPABILITIES_JSON';

/** Computer Use was removed from the product. Keep the name reservation at the generic MCP seam
 * so neither an embedding host nor a project config can silently restore the old mac_control path. */
export function isDisabledProductCapabilityName(name: string): boolean {
  return String(name || '').trim().toLowerCase() === 'bimax-mac';
}

/**
 * Parse the narrow, process-local capability contract supplied by an embedding host.
 *
 * This deliberately accepts only absolute stdio commands, string arguments and string-valued
 * environment entries. It cannot add a remote endpoint or opt into parent-environment inheritance.
 * The embedding application owns the process and lifecycle; the engine only consumes MCP schemas
 * and results through the same generic connector used for every other provider.
 */
export function loadHostCapabilityServers(raw = process.env[HOST_CAPABILITIES_ENV]): McpServerSpec[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const candidates = Array.isArray(parsed) ? parsed : parsed?.servers;
    if (!Array.isArray(candidates)) return [];
    const seen = new Set<string>();
    const out: McpServerSpec[] = [];
    for (const value of candidates.slice(0, 8)) {
      const name = typeof value?.name === 'string' ? value.name.trim() : '';
      const command = typeof value?.command === 'string' ? value.command.trim() : '';
      if (
        !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)
        || isDisabledProductCapabilityName(name)
        || seen.has(name)
        || !path.isAbsolute(command)
      ) continue;
      const args = Array.isArray(value.args) && value.args.every((arg: unknown) => typeof arg === 'string')
        ? value.args.slice(0, 32) : [];
      const envEntries = value.env && typeof value.env === 'object' && !Array.isArray(value.env)
        ? Object.entries(value.env).filter((entry): entry is [string, string] =>
          /^[A-Z][A-Z0-9_]{0,127}$/.test(entry[0]) && typeof entry[1] === 'string')
        : [];
      seen.add(name);
      out.push({ name, command, args, env: Object.fromEntries(envEntries), type: 'stdio', forceScrubEnv: true, eager: true });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Coerce `args` into a string[]. Tolerates the many shapes a weak model emits:
 *   - a real array:                 ["-y", "pkg"]
 *   - a JSON string:                "[\"-y\", \"pkg\"]"
 *   - a single-quoted literal:      "['-y', 'pkg']"   (Python/JS style — not valid JSON)
 *   - a plain space-separated line: "-y pkg"
 */
export function normalizeArgs(args: any): string[] | undefined {
  if (args == null) return undefined;
  if (Array.isArray(args)) return args.map(String);
  if (typeof args !== 'string') return undefined;

  const trimmed = args.trim();
  if (!trimmed) return undefined;

  // Bracketed literal — try strict JSON, then a tolerant comma-split that handles single quotes.
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fall through to tolerant parse */ }
    const inner = trimmed.replace(/^\[/, '').replace(/\]$/, '');
    const parts = inner
      .split(',')
      .map(s => s.trim().replace(/^['"]+|['"]+$/g, '').trim())
      .filter(s => s.length > 0);
    return parts.length ? parts : undefined;
  }

  // Plain string → whitespace split.
  return trimmed.split(/\s+/);
}

/** A spec is usable if it has either a launch command or a remote URL. */
function isValidSpec(s: any): s is McpServerSpec {
  return !!(s && s.name && !isDisabledProductCapabilityName(s.name) && (s.command || s.url));
}

/**
 * Returns the absolute-path arguments that DON'T exist on disk. Servers like
 * @modelcontextprotocol/server-filesystem take real directories to expose; pasting a docs
 * template leaves placeholders like "/path/to/allowed/folder/one" that make the server exit
 * on startup. Catching these up front turns a cryptic ENOENT into a clear, fixable message.
 */
export function missingPathArgs(args?: string[]): string[] {
  if (!args) return [];
  return args.filter(a => {
    if (typeof a !== 'string') return false;
    // Only check things that look like filesystem paths, not flags or package names.
    if (!/^(\/|~\/|~$|\.\.?\/)/.test(a)) return false;
    const resolved = a.startsWith('~') ? path.join(os.homedir(), a.slice(1)) : a;
    return !fs.existsSync(resolved);
  });
}

/** Apply arg normalization to a raw spec object. */
function cleanSpec(s: any): McpServerSpec {
  return { ...s, args: normalizeArgs(s.args) };
}

export function loadMcpServers(dir: string = process.cwd()): McpServerSpec[] {
  const file = path.join(dir, '.bimax', 'mcp.json');
  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }

  if (Array.isArray(cfg.servers)) {
    return cfg.servers.filter(isValidSpec).map(cleanSpec);
  }
  if (cfg.mcpServers && typeof cfg.mcpServers === 'object') {
    return Object.entries(cfg.mcpServers)
      .map(([name, v]: [string, any]) => ({
        name,
        command: v?.command,
        args: v?.args,
        env: v?.env,
        url: v?.url,
        type: v?.type,
        headers: v?.headers,
        disabled: v?.disabled,
      }))
      .filter(isValidSpec)
      .map(cleanSpec);
  }
  return [];
}
