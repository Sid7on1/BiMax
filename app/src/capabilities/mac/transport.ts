import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { openClient, isDeadConnectionError } from './mcp.client';
import { capabilityEvents as cliEvents } from './events';

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Driver transport for the embedded native sidecar (Bimax Computer Use).
 *
 * This is the ONE place a sidecar RPC can happen: the runtime's action orchestration never touches
 * the MCP client directly — it goes through {@link SidecarTransportPort.call}. Keeping the
 * transport behind an explicit interface separates "how bytes reach the driver" (spawn, handshake,
 * timeouts, dead-connection teardown, heartbeat) from "what the action means" (desktop.runtime.ts).
 */
export interface SidecarTransportPort {
  /** Is the sidecar binary configured and present? (No spawn — a pure filesystem check.) */
  available(): boolean;
  /** One RPC to the sidecar; spawns/handshakes lazily on first use. */
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  /** Start the lazy cold-start now so boot time overlaps with human decision time. */
  warm(): void;
  /** Watchdog view: is the sidecar connected, and how long since the last real activity? */
  health(): { connected: boolean; idleMs: number; lastActivityAt: number };
  /** End the session and close the connection. `stopRecording` finalizes any active recording. */
  dispose(opts?: { stopRecording?: boolean }): Promise<void>;
}

/** Replace upstream implementation names in anything that can reach the model or user. */
export function bimaxBrand<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(/cua-driver-rs/gi, 'Bimax Computer Use')
      .replace(/cua[ -]driver/gi, 'Bimax Computer Use') as T;
  }
  if (Array.isArray(value)) return value.map(bimaxBrand) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as any).map(([k, v]) => [k, bimaxBrand(v)])) as T;
  }
  return value;
}

function mcpText(result: any): string {
  return (result?.content || [])
    .filter((part: any) => part?.type === 'text')
    .map((part: any) => String(part.text || ''))
    .join('\n');
}

function mcpStructured(result: any): any {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = mcpText(result).replace(/^✅[^\n]*\n?/, '').trim();
  try { return JSON.parse(text); } catch { return text ? { message: text } : {}; }
}

// Cold start (spawn the native sidecar + MCP handshake + start_session) and a steady-state RPC are
// different operations with different failure modes — a cold start doing real process/IPC work can
// legitimately take much longer than any single tool call. Budgeting them together made the FIRST
// gated action of a session race a clock that silently included both, so a slow-but-alive boot was
// indistinguishable from a hang. They get separate, honestly-labeled budgets.
const COLD_START_TIMEOUT_MS = 45_000;
const RPC_TIMEOUT_MS = 30_000;

/** The sidecar retires a session on its own (idle reap, daemon restart) and then rejects every
 * session-scoped tool call. The connection stays healthy, so this is NOT a dead-transport error —
 * it is repaired by re-issuing start_session for the same id, which is exactly what the driver's
 * own message asks for. Matched on the driver's wording, deliberately loose about the id. */
function isRetiredSessionError(message: string): boolean {
  return /session\b.*\bhas ended|call\s+start_session/i.test(String(message || ''));
}

/** The packaged TUI extracts a >40MB content-addressed binary; anything smaller is a stub/corrupt. */
const MIN_DRIVER_BYTES = 1 << 20;

/** Mirror of the Go launcher's engineCacheRoots(): where the packaged TUI extracts the driver. */
function driverCacheRoots(): string[] {
  const override = process.env.BIMAX_CACHE_DIR?.trim();
  if (override) return [override];
  const roots: string[] = [];
  if (process.platform === 'darwin') roots.push(path.join(os.homedir(), 'Library', 'Caches'));
  else if (process.platform === 'linux') roots.push(process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache'));
  roots.push(os.tmpdir());
  return roots;
}

/**
 * Find the sidecar driver without the launcher's help. The packaged TUI extracts the embedded
 * driver to <cacheRoot>/bimax/bimax-computer-use-<hash> and passes its path via
 * BIMAX_COMPUTER_USE_DRIVER — but dev builds embed nothing, so a dev engine run used to silently
 * degrade to the primitive fallback even with a perfectly good driver sitting in the cache from a
 * prior packaged run. The env var stays the explicit override; this scan is the fallback.
 * Newest binary wins when several roots have one (the launcher prunes stale siblings per dir).
 */
export function discoverCachedDriver(): string | null {
  let best: { path: string; mtimeMs: number } | null = null;
  for (const root of driverCacheRoots()) {
    const dir = path.join(root, 'bimax');
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.startsWith('bimax-computer-use-')) continue;
      const candidate = path.join(dir, name);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile() || stat.size < MIN_DRIVER_BYTES) continue;
        if (!best || stat.mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs: stat.mtimeMs };
      } catch { /* raced deletion — skip */ }
    }
  }
  return best?.path ?? null;
}

/** Every daemon this process ever spawned, so a normal exit never strands one listening on a
 * private socket. A hard crash can still orphan a daemon; it idles on a pid-scoped socket no
 * future engine will attach to, and the next launch of the same pid number replaces the file. */
const liveDaemons = new Set<ChildProcess>();
let daemonExitHookInstalled = false;
function reapDaemonsOnExit(): void {
  if (daemonExitHookInstalled) return;
  daemonExitHookInstalled = true;
  process.once('exit', () => { for (const d of liveDaemons) { try { d.kill(); } catch { /* already gone */ } } });
}

export class SidecarTransport implements SidecarTransportPort {
  private clientPromise: Promise<any> | null = null;
  /** Heartbeat: updated on every sidecar call so a watchdog can spot a wedged session. */
  private lastActivityAt = Date.now();
  /** Driver ≥0.12 daemon (`serve --embedded`); null when running a legacy single-process driver. */
  private daemon: ChildProcess | null = null;
  private daemonSocket: string | null = null;

  constructor(private readonly session: string) {}

  /** Cached cache-scan result; null = scanned and found nothing (re-scanned on demand). */
  private discoveredDriver: string | null = null;

  private driverPath(): string | null {
    const configured = process.env.BIMAX_COMPUTER_USE_DRIVER?.trim();
    if (configured) {
      // Explicit opt-out: never use the sidecar, not even a cache-discovered one.
      if (/^(0|off|none|disabled)$/i.test(configured)) return null;
      return fs.existsSync(configured) ? configured : null;
    }
    if (this.discoveredDriver && fs.existsSync(this.discoveredDriver)) return this.discoveredDriver;
    this.discoveredDriver = discoverCachedDriver();
    return this.discoveredDriver;
  }

  public available(): boolean { return this.driverPath() != null; }

  public warm(): void {
    if (this.available()) this.client().catch(() => { /* real error surfaces on the next call() */ });
  }

  public health(): { connected: boolean; idleMs: number; lastActivityAt: number } {
    return { connected: !!this.clientPromise, idleMs: Date.now() - this.lastActivityAt, lastActivityAt: this.lastActivityAt };
  }

  /** Driver ≥0.12 split the sidecar into a daemon (`serve --embedded`) plus a thin MCP stdio
   * proxy — `mcp --embedded` alone now exits with "no Cua Driver daemon listening". Spawn a
   * PRIVATE daemon on a Bimax-owned, pid-scoped socket so we never attach to (or fight over) a
   * user-level CuaDriver install. Returns the socket path, or null when the daemon never came up
   * — a pre-0.12 driver has no `serve` and exits immediately, which lands the caller on the
   * legacy single-process launch unchanged. */
  private async ensureDaemon(driver: string): Promise<string | null> {
    // Explicit compatibility seam for legacy drivers and unit harnesses whose MCP client is
    // injected. Production leaves this unset and probes the packaged >=0.12 daemon normally.
    if (/^(0|off|false|disabled)$/i.test(process.env.BIMAX_COMPUTER_USE_DAEMON?.trim() || '')) {
      return null;
    }
    if (this.daemon && this.daemon.exitCode === null && this.daemonSocket && fs.existsSync(this.daemonSocket)) {
      return this.daemonSocket;
    }
    const sock = path.join(os.tmpdir(), `bimax-cua-${process.pid}.sock`);
    try { fs.rmSync(sock, { force: true }); } catch { /* stale socket from a dead pid */ }
    let exited = false;
    let child: ChildProcess;
    try {
      child = spawn(driver, ['serve', '--embedded', '--socket', sock], {
        stdio: 'ignore',
        env: {
          PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '',
          CUA_DRIVER_EMBEDDED: '1',
          CUA_DRIVER_HOST_BUNDLE_ID: 'ai.bimax.cli',
          CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
          CUA_TELEMETRY_ENABLED: '0',
        },
      });
    } catch { return null; }
    child.on('error', () => { exited = true; });
    child.once('exit', () => {
      exited = true;
      liveDaemons.delete(child);
      if (this.daemon === child) this.daemon = null;
    });
    reapDaemonsOnExit();
    liveDaemons.add(child);
    for (let i = 0; i < 50 && !exited; i++) {
      if (fs.existsSync(sock)) { this.daemon = child; this.daemonSocket = sock; return sock; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    try { child.kill(); } catch { /* already gone */ }
    liveDaemons.delete(child);
    return null;
  }

  private async client(): Promise<any> {
    const driver = this.driverPath();
    if (!driver) throw new Error('embedded Bimax Computer Use driver is unavailable');
    if (!this.clientPromise) {
      cliEvents.emit('status', 'Starting native driver…');
      // Every teardown below is identity-guarded (clientPromise === promise): a late failure or
      // close event from a SUPERSEDED connection must never destroy its healthy replacement —
      // unconditional nulling here would strand duplicate live sidecars behind a respawn loop.
      const promise: Promise<any> = withTimeout<any>((async () => {
        const driverArgs = ['mcp', '--embedded', '--host-bundle-id', 'ai.bimax.cli'];
        const daemonSocket = await this.ensureDaemon(driver);
        if (daemonSocket) driverArgs.push('--socket', daemonSocket);
        // Live PiP is owned by NativeLivePip, which continuously streams the exact target window
        // through ScreenCaptureKit. Do not enable the driver's post-action screenshot viewer: two
        // preview processes would race and the old one is not continuous.
        const client = await openClient({
          name: 'bimax-computer-use',
          command: driver,
          args: driverArgs,
          forceScrubEnv: true,
          env: {
            CUA_DRIVER_EMBEDDED: '1',
            CUA_DRIVER_HOST_BUNDLE_ID: 'ai.bimax.cli',
            CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
            CUA_TELEMETRY_ENABLED: '0',
          },
        });
        await client.callTool({ name: 'start_session', arguments: { session: this.session } });
        // There is exactly one cursor: the native OS cursor. Never show the sidecar overlay cursor;
        // it is a visualization, not proof that an input event reached the target application.
        try {
          await client.callTool({
            name: 'set_agent_cursor_enabled',
            arguments: { enabled: false, cursor_id: this.session },
          });
        } catch { /* pinned driver supports this; older local overrides remain usable */ }
        return client;
      })(), COLD_START_TIMEOUT_MS, 'Bimax Computer Use driver start')
        .then(client => {
          // Detect a crashed/exited sidecar the moment it happens rather than waiting for the
          // next action to hang out a full RPC timeout before discovering the connection is dead.
          client.onclose = () => { if (this.clientPromise === promise) this.clientPromise = null; };
          cliEvents.emit('status', 'Native driver ready');
          return client;
        })
        .catch(err => {
          if (this.clientPromise === promise) this.clientPromise = null;
          throw err;
        });
      this.clientPromise = promise;
    }
    return this.clientPromise;
  }

  public async call(name: string, args: Record<string, unknown> = {}, revived = false): Promise<any> {
    const promise = this.client();
    const client = await promise;
    this.lastActivityAt = Date.now(); // heartbeat
    cliEvents.emit('status', `Running ${name}…`);
    const result = await withTimeout<any>(
      client.callTool({ name, arguments: args }),
      RPC_TIMEOUT_MS,
      `Bimax Computer Use '${name}'`,
    ).catch((err: any) => {
      // A wedged/crashed sidecar leaves clientPromise resolved-but-dead, and nothing else clears
      // it — but only a dead transport or our own timeout condemns the CONNECTION. An app-level
      // RPC rejection from a healthy sidecar must not cost the whole session (element caches,
      // plus a fresh cold start) on the next action.
      if (isDeadConnectionError(err) || String(err?.message || '').includes('timed out after')) {
        if (this.clientPromise === promise) this.clientPromise = null;
        // Close the condemned client: a timed-out action could otherwise still land on the
        // user's desktop later, unsupervised, and an unclosed client leaks the sidecar process.
        try { Promise.resolve(client.close?.()).catch(() => { /* best-effort teardown */ }); }
        catch { /* best-effort teardown */ }
      }
      throw err;
    });
    const data = bimaxBrand(mcpStructured(result));
    if (result?.isError) {
      const detail = bimaxBrand(mcpText(result)).trim();
      // A retired session arrives as an app-level isError RESULT, not a rejected promise, so it
      // never reaches the condemnation branch above — and the transport is genuinely healthy, so
      // condemning it would buy a cold start we do not need. The driver states the repair itself
      // ("call start_session with this id to revive it"); nothing was doing it, so the runtime kept
      // reusing a client whose session the daemon had already retired and EVERY stateful call
      // failed for the life of the process. Revive in place and retry exactly once.
      if (!revived && isRetiredSessionError(detail)) {
        try {
          await client.callTool({ name: 'start_session', arguments: { session: this.session } });
          // The revived session starts with driver defaults; re-assert that there is exactly one
          // cursor, the real OS one, as the original handshake does.
          try {
            await client.callTool({
              name: 'set_agent_cursor_enabled',
              arguments: { enabled: false, cursor_id: this.session },
            });
          } catch { /* pinned driver supports this; older local overrides remain usable */ }
        } catch {
          // The sidecar will not revive this session — now the connection IS condemned, so the
          // next call cold-starts a fresh one rather than looping on a corpse.
          if (this.clientPromise === promise) this.clientPromise = null;
          try { Promise.resolve(client.close?.()).catch(() => { /* best-effort teardown */ }); }
          catch { /* best-effort teardown */ }
          throw new Error(detail || `${name} failed`);
        }
        return this.call(name, args, true);
      }
      throw new Error(detail || `${name} failed`);
    }
    return data;
  }

  public async dispose(opts: { stopRecording?: boolean } = {}): Promise<void> {
    const pending = this.clientPromise;
    this.clientPromise = null;
    this.lastActivityAt = Date.now();
    if (pending) {
      try {
        const client = await pending;
        if (opts.stopRecording) {
          try { await client.callTool({ name: 'stop_recording', arguments: {} }); } catch { /* session teardown also finalizes */ }
        }
        await client.callTool({ name: 'end_session', arguments: { session: this.session } });
        await client.close?.();
      } catch { /* process teardown is best-effort */ }
    }
    const daemon = this.daemon;
    this.daemon = null;
    if (daemon) {
      liveDaemons.delete(daemon);
      try { daemon.kill(); } catch { /* already gone */ }
    }
    if (this.daemonSocket) {
      try { fs.rmSync(this.daemonSocket, { force: true }); } catch { /* daemon removes it on exit */ }
      this.daemonSocket = null;
    }
  }
}
