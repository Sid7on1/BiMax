import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { app } from 'electron';
import { existsSync, mkdirSync, createWriteStream, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { EngineHandle, SpawnCallbacks } from './supervisor/supervisor';
import { ProcessProvenanceTracker, type ProcessProvenanceRecord } from '../phase9/process.provenance';
import {
  resolveEngineCommand, describeRefusal, buildEngineChildEnv,
  type RuntimeLayout, type Resolution,
} from './coding.runtime.paths';

/**
 * Finder-launched macOS apps inherit launchd's minimal PATH (/usr/bin:/bin:...), not the user's
 * shell PATH — so the engine child can't find npx/node/git-hooks and every node-based MCP server
 * fails with "Executable not found in $PATH". Resolve the real PATH once from the user's login
 * shell and merge in the usual tool dirs as a fallback (shell probe can fail in odd setups).
 */
let resolvedPath: string | null = null;
function userShellPath(): string {
  if (resolvedPath) return resolvedPath;
  const parts = new Set((process.env.PATH || '').split(':').filter(Boolean));
  if (process.platform !== 'win32') {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const out = execFileSync(shell, ['-ilc', 'echo -n "$PATH"'], { encoding: 'utf8', timeout: 5000 });
      out.split(':').filter(Boolean).forEach((p) => parts.add(p));
    } catch { /* fall through to static dirs */ }
    const home = os.homedir();
    ['/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`, `${home}/.bun/bin`, `${home}/bin`]
      .forEach((p) => { if (existsSync(p)) parts.add(p); });
  }
  resolvedPath = [...parts].join(':');
  return resolvedPath;
}

/**
 * Engine process adapter — spawns and pipes the headless Bimax engine (BIMAX_HEADLESS=1), the
 * exact process the Go TUI drives (see tui/engine.go, which this ports). Outbound messages arrive
 * as NDJSON on the child's stdout; inbound commands go out as NDJSON on its stdin. Engine stderr
 * (boot logs) is diverted to <userData>/engine.log so it can never corrupt the protocol stream.
 *
 * Lifecycle policy lives in supervisor/supervisor.ts — this file is deliberately dumb: resolve
 * the command, spawn, decode lines, report exits. It never restarts anything itself.
 *
 * Command resolution differs by build, and the difference is the point — see runtime.paths.ts.
 * A PACKAGED app resolves from its own bundle and nowhere else:
 *   <resources>/engine/bimax-engine       — the bun-compiled standalone binary bundled by
 *                                           electron-builder; absent means fail visibly, never
 *                                           fall back to a development engine
 * DEVELOPMENT uses the pinned artifact staged at app/engine/bimax-engine. Contributors can opt
 * into a deliberate $BIMAX_ENGINE_CMD override; there is no implicit source compilation path.
 */

// S28-D starts with the process tree Bimax itself launches. This bounded tracker contains no raw
// argv, environment, project path, or network payload and needs no system-wide entitlement.
const processProvenance = new ProcessProvenanceTracker();

export function engineProcessProvenance(): ProcessProvenanceRecord[] {
  return processProvenance.snapshot();
}

// In dev the app lives at <repo>/app, so the engine repo is one level up from the app package.
// electron-vite bundles main to app/out/main/index.js — walk up to app/, then to the repo.
function devRepoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

/** The injected view of this build that runtime.paths.ts reasons about. */
function runtimeLayout(): RuntimeLayout {
  return {
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    devRepoRoot: devRepoRoot(),
    env: process.env,
    exists: existsSync,
  };
}

/**
 * The same resolution the spawn path uses, exposed for Trust diagnostics. Reporting must describe
 * exactly what a launch would do, so it deliberately shares one code path rather than re-deriving
 * paths — a diagnostics view that disagrees with the launcher is worse than none.
 */
export function componentResolutions(): Array<{ name: 'engine'; resolution: Resolution }> {
  const layout = runtimeLayout();

  // The engine is resolved by a different function because a packaged build with no engine throws.
  // For reporting, that condition is a missing component, not an exception.
  let engine: Resolution;
  try {
    const resolved = resolveEngineCommand(layout, layout.devRepoRoot);
    engine = {
      path: resolved.cmd || undefined,
      source: resolved.source,
      ...(resolved.refusedOverride ? { refusedOverride: resolved.refusedOverride } : {}),
    };
  } catch {
    engine = { source: 'missing' };
  }
  return [{ name: 'engine', resolution: engine }];
}

/** Retired compatibility hook for historical diagnostics; no native helper is resolvable. */
export function bimaxDesktopHelperBinary(): undefined {
  return undefined;
}

function resolveCommand(projectDir: string): { cmd: string; args: string[]; cwd: string; refusals: string[] } {
  const layout = runtimeLayout();
  const resolved = resolveEngineCommand(layout, projectDir);
  const refusals: string[] = [];
  if (resolved.refusedOverride) refusals.push(describeRefusal(resolved.refusedOverride));

  return { cmd: resolved.cmd, args: resolved.args, cwd: resolved.cwd, refusals };
}

function engineReleaseEnv(command: string): Record<string, string> {
  try {
    const manifest = JSON.parse(readFileSync(path.join(path.dirname(command), 'manifest.json'), 'utf8')) as {
      engine?: { version?: string; buildCommit?: string };
      artifacts?: Array<{ platform?: string; arch?: string; sizeBytes?: number }>;
    };
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const artifact = manifest.artifacts?.find((a) => a.platform === 'darwin' && a.arch === arch);
    if (!artifact) return {};
    // electron-builder signs nested Mach-O executables after staging, which changes their byte
    // size and digest while preserving the release artifact's code under the containing app seal.
    // Comparing the post-sign binary to the pre-sign manifest made every installed DMG advertise
    // `dev/unknown`. Bundle-only path resolution plus the app signature are the runtime integrity
    // boundary; the release/package gates verify the pre-sign artifact against this manifest.
    statSync(command); // still require the resolved engine to exist and be readable
    return {
      BIMAX_ENGINE_VERSION: String(manifest.engine?.version || 'unknown'),
      BIMAX_ENGINE_COMMIT: String(manifest.engine?.buildCommit || 'unknown'),
    };
  } catch {
    // Explicit contributor overrides are allowed to have no release manifest. Their hello identity
    // remains dev/unknown, which is more truthful than inventing release provenance.
    return {};
  }
}

// Desktop-owned rolling log: the last few hundred engine stderr / lifecycle lines, in memory,
// ACROSS launches — this is the crash journal's evidence when a SIGKILLed child couldn't flush
// anything. The on-disk engine.log keeps the full history (append mode) for deep dives.
const LOG_RING_MAX = 400;
const logRing: string[] = [];
function ringWrite(line: string): void {
  logRing.push(line.length > 500 ? line.slice(0, 500) + '…' : line);
  if (logRing.length > LOG_RING_MAX) logRing.splice(0, logRing.length - LOG_RING_MAX);
}

/** The bounded recent engine log — injected into the supervisor as its `logTail` dependency. */
export function recentEngineLog(maxChars = 6000): string {
  return logRing.join('\n').slice(-maxChars);
}

/**
 * Spawn one engine child for `projectDir`. Fits the supervisor's `deps.spawn` contract: callbacks
 * fire exactly once per event, the handle only exposes write/end/kill (no raw process access ever
 * reaches the renderer), and cleanup of streams + listeners happens on exit here.
 */
export function spawnEngineProcess(projectDir: string, extraEnv: Record<string, string>, cb: SpawnCallbacks): EngineHandle {
  const { cmd, args, cwd, refusals } = resolveCommand(projectDir);
  const startedAt = Date.now();
  const command = `${cmd} ${args.join(' ')}`.trim();

  const logDir = path.join(app.getPath('userData'));
  mkdirSync(logDir, { recursive: true });
  // Append instead of truncating: a force-killed child cannot flush a final message, so retaining
  // the previous boot and the desktop-owned lifecycle lines is essential crash evidence.
  const logStream = createWriteStream(path.join(logDir, 'engine.log'), { flags: 'a' });
  const logLine = (line: string): void => {
    ringWrite(line);
    logStream.write(line + '\n');
  };
  logLine(`[desktop] ${new Date().toISOString()} starting engine for ${projectDir}: ${command}`);

  for (const refusal of refusals) logLine(refusal);

  // The engine must START where its runtime resolves (repo root in dev), but the user's project
  // is projectDir — BIMAX_CWD tells the engine to chdir there (same contract as the Go TUI).
  // extraEnv is the supervisor's capability plan (headroom/codemem/autoIndex/drives gates).
  // buildEngineChildEnv owns the native-component stripping — see its doc comment.
  const child = spawn(cmd, args, {
    cwd,
    env: buildEngineChildEnv({
      parentEnv: process.env,
      extraEnv: { ...extraEnv, ...engineReleaseEnv(cmd) },
      path: userShellPath(),
      projectDir,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const provenanceLaunchId = processProvenance.begin({
    pid: child.pid,
    executableBasename: path.basename(cmd),
    cwdClass: 'project',
    argumentClasses: ['headless-agent-protocol'],
  });

  // stderr → engine.log + the in-memory ring (journal evidence), never the protocol stream.
  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    let nl: number;
    while ((nl = stderrBuf.indexOf('\n')) !== -1) {
      logLine(stderrBuf.slice(0, nl));
      stderrBuf = stderrBuf.slice(nl + 1);
    }
  });

  // NDJSON decode. readline handles arbitrarily long lines (command menus serialize to one very
  // long line), unlike a fixed-size scanner buffer.
  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg && typeof msg === 'object') cb.onMessage(msg as Record<string, unknown>);
      else cb.onMalformed(trimmed);
    } catch {
      // Never silently drop a malformed line — a desync is invisible otherwise.
      logLine(`[app] dropped malformed line (${trimmed.length} chars)`);
      cb.onMalformed(trimmed);
    }
  });

  let settled = false;
  child.on('exit', (code, signal) => {
    if (settled) return;
    settled = true;
    processProvenance.finish(provenanceLaunchId, { exitCode: code, signal });
    if (stderrBuf) logLine(stderrBuf); // flush a final partial stderr line
    logLine(`[desktop] engine exited after ${Date.now() - startedAt}ms: ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`);
    rl.close();
    logStream.end();
    cb.onExit(code, signal);
  });
  child.on('error', (err) => {
    if (settled) return;
    settled = true;
    processProvenance.finish(provenanceLaunchId, { spawnError: true });
    logLine(`[desktop] engine process error after ${Date.now() - startedAt}ms: ${err.message}`);
    rl.close();
    logStream.end();
    cb.onError(err);
  });

  return {
    pid: child.pid,
    command,
    write: (line: string) => {
      const stdin = child.stdin;
      if (stdin && stdin.writable) stdin.write(line);
    },
    endStdin: () => { try { child.stdin?.end(); } catch { /* already gone */ } },
    kill: (signal) => { try { child.kill(signal); } catch { /* already gone */ } },
  };
}
