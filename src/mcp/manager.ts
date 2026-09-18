import { reportCapability } from '../core/capability.status';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry } from '../tools/tool.registry';
import { IGovernor } from '../core/interfaces';
import { Logger } from '../utils/logger';
import { McpServerSpec, loadHostCapabilityServers, loadMcpServers, normalizeArgs, missingPathArgs } from './config';
import { connectAndRegister, ConnectedMcp } from './client';
import { engineEvents } from '../engine/events';
import { codebaseMemorySpec } from './builtin/codebaseMemory';
import { withTimeout } from '../utils/withTimeout';
import { serverCallSummary } from './stats';

export type McpHealthState = 'connected' | 'disabled' | 'connecting' | 'disconnected' | 'error';

export interface McpHealth {
  name: string;
  state: McpHealthState;
  transport: 'stdio' | 'http' | 'sse';
  toolCount: number;
  error?: string;
  missingPaths?: string[];
  /** Lifetime call telemetry for this server's tools (0s when unused this session). */
  calls: number;
  callErrors: number;
  avgMs: number;
}

/**
 * Built-in engines baked into Bimax (auto-provisioned, not user-configured). Seeded into the
 * connect set before user config so a same-named entry in .bimax/mcp.json still wins. Failures
 * are swallowed — a missing engine must never block boot.
 *
 * codebase-memory is fronted natively by the GraphQueryTool/GraphContextTool backend (approach b),
 * so by default we do NOT also register its 14 raw `mcp__codebase-memory__*` tools (that would dump
 * redundant tools on the model and spawn a second engine process). Power users can opt into the raw
 * tools with BIMAX_CODEMEM_RAW_TOOLS=1.
 */
async function optionalBuiltinServers(): Promise<McpServerSpec[]> {
  const out: McpServerSpec[] = [];
  if (process.env.BIMAX_CODEMEM_RAW_TOOLS === '1') {
    try {
      const cbm = await codebaseMemorySpec();
      if (cbm) out.push(cbm);
    } catch { /* best-effort */ }
  }
  return out;
}

/** Defend every entry point: a model may pass `args` as a JSON string — coerce it to a real array. */
function cleanSpec(spec: McpServerSpec): McpServerSpec {
  return { ...spec, args: normalizeArgs(spec.args) };
}

// Runtime manager for MCP servers: holds the live connections so they can be listed, tested,
// added, and removed at runtime (the boot path, the /mcp command, and the agent's McpManageTool
// all go through here). Config lives in `.bimax/mcp.json`.

export class McpManager {
  private connections: Map<string, ConnectedMcp> = new Map();
  /** Server names currently in the middle of a connect attempt. Used by ToolSearchTool to warn the
   *  model that a missing MCP tool might appear once the server finishes connecting. */
  private pending: Set<string> = new Set();
  /** The reason the most recent connect attempt failed (for surfacing to the user/agent). */
  public lastError: string | null = null;
  /** Failure state is tracked per server so one bad connector cannot hide another one's cause. */
  private errors: Map<string, string> = new Map();

  // MCP servers are stored GLOBALLY by default (~/.bimax/mcp.json) so a server added in any
  // directory persists everywhere — just like API keys. Passing an explicit `cwd` targets that
  // project's `.bimax/mcp.json` instead (used by tests and project-local team configs).
  private configRoot(cwd?: string): string {
    return cwd ?? os.homedir();
  }

  private configPath(cwd?: string): string {
    return path.join(this.configRoot(cwd), '.bimax', 'mcp.json');
  }

  /** Connect one server and retain the connection. Returns the live connection or null. */
  private reportConnection(name: string, ready: boolean): void {
    reportCapability({ id: `mcp:${name}`, label: `MCP ${name}`, state: ready ? 'ready' : 'unavailable',
      reason: ready ? 'The connection answered successfully.' : 'The configured connection failed.',
      impact: ready ? '' : 'Its tools may be unavailable.', action: ready ? '' : 'Check the server or use /mcp reconnect.' });
  }

  public async connectSpec(
    spec: McpServerSpec,
    registry: ToolRegistry,
    governor: IGovernor,
  ): Promise<ConnectedMcp | null> {
    this.lastError = null;
    this.pending.add(spec.name);
    let failure: string | null = null;
    try {
      const conn = await connectAndRegister(cleanSpec(spec), registry, governor, (msg) => {
        failure = msg;
        this.lastError = msg;
      }, async () => {
        // Self-heal hook for a dead transport mid-call: reconnect with the SAME spec (not a config
        // lookup — built-ins/tests aren't in any file) and hand back the fresh client so the
        // in-flight call can retry once on it.
        const fresh = await this.connectSpec(spec, registry, governor);
        return fresh?.client ?? null;
      });
      if (!conn) {
        this.errors.set(spec.name, failure || 'Connection failed without an error message.');
        this.reportConnection(spec.name, false);
        return null;
      }

      // A live reconfigure must not leak the old process or leave tools that the replacement no
      // longer exposes. Common tool names have already been replaced in the registry by the new
      // connection, so unregister only stale names before closing the previous client.
      const previous = this.connections.get(conn.name);
      if (previous && previous !== conn) {
        const currentNames = new Set(conn.toolNames);
        for (const oldName of previous.toolNames) {
          if (!currentNames.has(oldName)) registry.unregister(oldName);
        }
        try { await previous.client?.close?.(); } catch { /* best-effort */ }
      }

      this.connections.set(conn.name, conn);
      if (spec.eager) registry.markDiscovered(conn.toolNames);
      this.errors.delete(spec.name);
      this.reportConnection(spec.name, true);
      return conn;
    } catch (error) {
      this.reportConnection(spec.name, false);
      throw error;
    } finally {
      this.pending.delete(spec.name);
    }
  }

  /**
   * Connect embedding-host capabilities before the headless protocol reports ready.
   *
   * These are not optional user integrations: in Bimax.app this is the sole app-owned Computer
   * Use authority. Delaying it with npm-backed MCP servers created a window where an explicit
   * Control Mac turn was accepted as an ordinary coding turn. Terminal supplies no descriptor, so
   * this remains a zero-work no-op there.
   */
  public async connectHostCapabilities(
    registry: ToolRegistry,
    governor: IGovernor,
  ): Promise<number> {
    const specs = loadHostCapabilityServers();
    const results = await Promise.allSettled(specs.map(async (spec) => {
      if (spec.disabled) return false;
      const connection = await this.connectSpec(spec, registry, governor);
      if (connection) {
        engineEvents.emit('status', `Host capability '${spec.name}' connected — ${connection.toolNames.length} tool(s)`);
        return true;
      }
      const why = this.lastErrorFor(spec.name);
      if (why) engineEvents.emit('status', `Host capability '${spec.name}' failed: ${why}`);
      return false;
    }));
    const connected = results.filter(result => result.status === 'fulfilled' && result.value).length;
    if (connected > 0) engineEvents.emit('mcp_changed');
    return connected;
  }

  /**
   * Connect every configured server. Merges the GLOBAL store (~/.bimax/mcp.json) with the
   * project-local one (<projectRoot>/.bimax/mcp.json) — project entries override globals of the
   * same name. Best-effort. Used at boot.
   */
  public async connectAll(registry: ToolRegistry, governor: IGovernor, projectRoot?: string): Promise<number> {
    const byName = new Map<string, McpServerSpec>();
    // Host capabilities are reserved by the embedding app. A project MCP config must never replace
    // `bimax-mac` with a same-named third-party process after the trusted provider connected.
    const host = loadHostCapabilityServers();
    const reservedHostNames = new Set(host.map(spec => spec.name));
    for (const s of host) byName.set(s.name, s);
    for (const s of await optionalBuiltinServers()) byName.set(s.name, s);
    for (const s of loadMcpServers(os.homedir())) {
      if (!reservedHostNames.has(s.name)) byName.set(s.name, s);
    }
    if (projectRoot && projectRoot !== os.homedir()) {
      for (const s of loadMcpServers(projectRoot)) {
        if (!reservedHostNames.has(s.name)) byName.set(s.name, s);
      }
    }
    // Connect all servers IN PARALLEL — boot used to pay the sum of every server's handshake
    // (npx cold-starts routinely take seconds each); now it pays only the slowest one. Each
    // connectSpec tracks its own pending/error state, so concurrency is safe here.
    const results = await Promise.allSettled(Array.from(byName.values()).map(async (spec) => {
      // The critical host provider was connected synchronously before protocol readiness. Do not
      // restart it when the delayed optional-MCP sweep begins.
      if (spec.eager && this.connections.has(spec.name)) return true;
      // Skip servers the user turned off — they stay in config until re-enabled.
      if (spec.disabled) {
        Logger.info(`[MCP] Skipping disabled server '${spec.name}'.`);
        return false;
      }
      // Skip servers whose path args don't exist — they would just fail and slow the others.
      const missing = missingPathArgs(normalizeArgs(spec.args));
      if (missing.length) {
        this.reportConnection(spec.name, false);
        Logger.warn(`[MCP] Skipping '${spec.name}': path(s) do not exist: ${missing.join(', ')}`);
        engineEvents.emit('status', `MCP '${spec.name}' skipped — missing path(s): ${missing.join(', ')}`);
        return false;
      }
      const c = await this.connectSpec(spec, registry, governor);
      if (c) {
        engineEvents.emit('status', `MCP '${spec.name}' connected — ${c.toolNames.length} tool(s)`);
        return true;
      }
      const why = this.lastErrorFor(spec.name);
      if (why) engineEvents.emit('status', `MCP '${spec.name}' failed: ${why}`);
      return false;
    }));
    const n = results.filter(r => r.status === 'fulfilled' && r.value).length;
    if (n > 0) engineEvents.emit('mcp_changed');
    return n;
  }

  /** Enable or disable a server in config. Disconnects it live when disabling. */
  public async setEnabled(name: string, enabled: boolean, registry?: ToolRegistry, cwd?: string): Promise<boolean> {
    const root = this.configRoot(cwd);
    const specs = loadMcpServers(root);
    const spec = specs.find(s => s.name === name);
    if (!spec) return false;
    spec.disabled = !enabled;
    const file = this.configPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ servers: specs }, null, 2), 'utf8');
    if (!enabled) await this.disconnect(name, registry);
    engineEvents.emit('mcp_changed');
    return true;
  }

  /** Is a configured server currently turned off? */
  public isDisabled(name: string, cwd?: string): boolean {
    return !!loadMcpServers(this.configRoot(cwd)).find(s => s.name === name)?.disabled;
  }

  /** Server names still connecting — used by ToolSearchTool to warn the model of pending tools. */
  public getPendingServers(): string[] {
    return Array.from(this.pending);
  }

  public list(): ConnectedMcp[] {
    return Array.from(this.connections.values());
  }

  public get(name: string): ConnectedMcp | undefined {
    return this.connections.get(name);
  }

  /** Last failure for one server (unlike lastError, this survives other servers connecting). */
  public lastErrorFor(name: string): string | null {
    return this.errors.get(name) ?? null;
  }

  /** Snapshot connector health without making network requests. */
  public health(cwd?: string): McpHealth[] {
    const specs = loadMcpServers(this.configRoot(cwd));
    const byName = new Map(specs.map(spec => [spec.name, spec]));
    // Include a live connector even if its config was removed or changed out-of-band.
    for (const conn of this.connections.values()) {
      if (!byName.has(conn.name)) byName.set(conn.name, { name: conn.name, command: 'live' });
    }

    return Array.from(byName.values()).map(spec => {
      const conn = this.connections.get(spec.name);
      const missing = missingPathArgs(normalizeArgs(spec.args));
      const error = this.errors.get(spec.name);
      let state: McpHealthState = 'disconnected';
      if (spec.disabled) state = 'disabled';
      else if (this.pending.has(spec.name)) state = 'connecting';
      else if (conn) state = error ? 'error' : 'connected';
      else if (error || missing.length) state = 'error';

      const usage = serverCallSummary(spec.name);
      return {
        name: spec.name,
        state,
        transport: spec.url ? (spec.type === 'sse' ? 'sse' : 'http') : 'stdio',
        toolCount: conn?.toolNames.length ?? 0,
        calls: usage.calls,
        callErrors: usage.errors,
        avgMs: usage.avgMs,
        ...(error ? { error } : {}),
        ...(missing.length ? { missingPaths: missing } : {}),
      } as McpHealth;
    });
  }

  /** Actively probe connected servers. This is intentionally read-only and bounded. */
  public async diagnose(cwd?: string): Promise<McpHealth[]> {
    for (const conn of this.connections.values()) {
      try {
        const probe = typeof conn.client?.ping === 'function'
          ? conn.client.ping()
          : conn.client.listTools();
        await withTimeout(Promise.resolve(probe), 5000, `MCP '${conn.name}' health check`);
        this.errors.delete(conn.name);
        this.reportConnection(conn.name, true);
      } catch (e: any) {
        this.errors.set(conn.name, e?.message || String(e));
        this.reportConnection(conn.name, false);
      }
    }
    return this.health(cwd);
  }

  /** Reconnect one configured server while preserving a working old connection on failure. */
  public async reconnect(
    name: string,
    registry: ToolRegistry,
    governor: IGovernor,
    cwd?: string,
  ): Promise<ConnectedMcp | null> {
    this.healFailures.delete(name); // a manual reconnect resets the watchdog's give-up counter
    const spec = loadMcpServers(this.configRoot(cwd)).find(s => s.name === name);
    if (!spec) {
      const msg = `No MCP server named '${name}' is configured.`;
      this.lastError = msg;
      this.errors.set(name, msg);
      return null;
    }
    if (spec.disabled) {
      const msg = `MCP server '${name}' is disabled.`;
      this.lastError = msg;
      this.errors.set(name, msg);
      return null;
    }
    return this.connectSpec(spec, registry, governor);
  }

  /** Live tool names contributed by all connected servers. */
  public toolNames(): string[] {
    return this.list().flatMap(c => c.toolNames);
  }

  // --- Watchdog: background self-healing -----------------------------------------------------

  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** Consecutive failed heal attempts per server — after 3 the watchdog stops trying (manual /mcp reconnect resets it). */
  private healFailures: Map<string, number> = new Map();
  private static readonly MAX_HEAL_ATTEMPTS = 3;

  /**
   * Start the background auto-doctor: every `intervalMs` (default 60s) probe each live connector
   * and auto-reconnect dead ones. Backs off after MAX_HEAL_ATTEMPTS consecutive failures so a
   * permanently-broken server isn't relaunched forever. Never prompts — connect/reconnect paths
   * don't gate through the Governor. The interval is unref'd so it can't keep the process alive.
   */
  public startWatchdog(registry: ToolRegistry, governor: IGovernor, intervalMs = 60000): void {
    if (this.watchdog || process.env.BIMAX_MCP_WATCHDOG === '0') return;
    let sweeping = false; // a slow sweep must not overlap the next tick
    this.watchdog = setInterval(async () => {
      if (sweeping) return;
      sweeping = true;
      try {
        for (const conn of this.list()) {
          try {
            const probe = typeof conn.client?.ping === 'function' ? conn.client.ping() : conn.client.listTools();
            await withTimeout(Promise.resolve(probe), 5000, `MCP '${conn.name}' watchdog probe`);
            this.healFailures.delete(conn.name);
            this.reportConnection(conn.name, true);
          } catch (probeErr: any) {
            this.reportConnection(conn.name, false);
            const attempts = this.healFailures.get(conn.name) ?? 0;
            if (attempts >= McpManager.MAX_HEAL_ATTEMPTS) continue; // gave up — manual reconnect resets
            this.errors.set(conn.name, probeErr?.message || String(probeErr));
            Logger.warn(`[MCP] Watchdog: '${conn.name}' failed its probe (${probeErr?.message}); auto-reconnecting (attempt ${attempts + 1}/${McpManager.MAX_HEAL_ATTEMPTS}).`);
            // Reconnect with the connection's own spec — config-file lookup would miss built-ins.
            const fresh = await this.connectSpec(conn.spec, registry, governor);
            if (fresh) {
              this.healFailures.delete(conn.name);
              engineEvents.emit('status', `MCP '${conn.name}' auto-healed — ${fresh.toolNames.length} tool(s) back.`);
              engineEvents.emit('mcp_changed');
            } else {
              this.healFailures.set(conn.name, attempts + 1);
              if (attempts + 1 >= McpManager.MAX_HEAL_ATTEMPTS) {
                engineEvents.emit('status', `MCP '${conn.name}' is down (${McpManager.MAX_HEAL_ATTEMPTS} heal attempts failed) — run /mcp doctor.`);
              }
            }
          }
        }
      } finally {
        sweeping = false;
      }
    }, intervalMs);
    this.watchdog.unref?.();
  }

  public stopWatchdog(): void {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
  }

  /** Disconnect a server, drop its tools from the registry, and forget the connection. */
  public async disconnect(name: string, registry?: ToolRegistry): Promise<boolean> {
    const conn = this.connections.get(name);
    if (!conn) return false;
    try { await conn.client?.close?.(); } catch { /* best-effort */ }
    if (registry) for (const t of conn.toolNames) registry.unregister(t);
    this.connections.delete(name);
    this.pending.delete(name);
    return true;
  }

  /** Persist a server into `.bimax/mcp.json` (normalized `{ servers: [...] }` shape). Global by default. */
  public addToConfig(spec: McpServerSpec, cwd?: string): void {
    const file = this.configPath(cwd);
    const specs = loadMcpServers(this.configRoot(cwd)).filter(s => s.name !== spec.name);
    specs.push(cleanSpec(spec));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ servers: specs }, null, 2), 'utf8');
    Logger.info(`[McpManager] Saved server '${spec.name}' to ${file}`);
  }

  /** Remove a server from `.bimax/mcp.json`. Returns true if it was present. Global by default. */
  public removeFromConfig(name: string, cwd?: string): boolean {
    const file = this.configPath(cwd);
    const specs = loadMcpServers(this.configRoot(cwd));
    const next = specs.filter(s => s.name !== name);
    if (next.length === specs.length) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ servers: next }, null, 2), 'utf8');
    this.errors.delete(name);
    return true;
  }

  /** Names of servers declared in config (whether or not currently connected). Global by default. */
  public configuredNames(cwd?: string): string[] {
    return loadMcpServers(this.configRoot(cwd)).map(s => s.name);
  }
}

export const globalMcpManager = new McpManager();
