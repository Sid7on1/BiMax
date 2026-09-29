import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { MessageChannel, Worker } from 'node:worker_threads';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { existsSync, mkdirSync, createWriteStream, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { EngineHandle, SpawnCallbacks } from './supervisor/supervisor';
import { ProcessProvenanceTracker, type ProcessProvenanceRecord } from '../phase9/process.provenance';
import {
  resolveEngineCommand, describeRefusal, buildEngineChildEnv, EngineArtifactError, PackagedRuntimeError,
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
 * There are three transports, and the default is the worker thread — the monolith, record 64 (see
 * spawnEngine at the foot of this file). The engine is no longer a separately published artifact that
 * the app downloads and pins: the app builds it from its own src/index.ts, and every transport runs
 * that same bundle.
 *
 *   worker thread (default)   The engine runs inside this process, one worker thread per Bimax Thread,
 *                             never on the UI thread. See spawnEngineWorker.
 *   utilityProcess            BIMAX_ENGINE_TRANSPORT=process: a separate process per engine, the
 *                             default until 2026-09-29. Kept one release as the fallback (M4 removes it).
 *   child process             BIMAX_ENGINE_TRANSPORT=child and an explicit $BIMAX_ENGINE_CMD. Kept so
 *                             an older engine build can be dropped in to bisect a regression.
 *
 * A PACKAGED app resolves from its own bundle and nowhere else — absent means fail visibly, never
 * fall back to a development engine.
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
    // Report whichever transport a launch would actually take. Reporting the child-process command
    // while the default forks a module would be a diagnostics view that disagrees with the
    // launcher, which this function exists specifically not to be.
    if ((process.env.BIMAX_ENGINE_TRANSPORT || '').trim().toLowerCase() !== 'child') {
      const module = resolveEngineModule();
      engine = { path: module, source: layout.packaged || module.includes(`${path.sep}engine${path.sep}`) ? 'bundle' : 'artifact' };
    } else {
      const resolved = resolveEngineCommand(layout, layout.devRepoRoot);
      engine = {
        path: resolved.cmd || undefined,
        source: resolved.source,
        ...(resolved.refusedOverride ? { refusedOverride: resolved.refusedOverride } : {}),
      };
    }
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
 * Open <userData>/engine.log and the in-memory ring for one engine launch. Shared by both
 * transports so a lifecycle line, a crash tail and the Engine log panel read the same for an OS
 * child process and a utilityProcess — a second copy of this is how the log would quietly start
 * telling two different stories depending on how the engine happened to be hosted.
 *
 * Appends rather than truncates: a force-killed child cannot flush a final message, so retaining
 * the previous boot and the desktop-owned lifecycle lines is essential crash evidence.
 */
/**
 * Where V8 keeps the engine bundle's compiled code between launches.
 *
 * Under userData because it is disposable per-user state: deleting it costs one slower boot. See
 * buildEngineChildEnv's `compileCacheDir` for the measurement that justifies it.
 */
function engineCompileCacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'v8-compile-cache');
  try { mkdirSync(dir, { recursive: true }); } catch { /* a cache is best-effort by definition */ }
  return dir;
}

function openEngineLog(projectDir: string, command: string): {
  logLine: (line: string) => void;
  closeLog: () => void;
} {
  const logDir = path.join(app.getPath('userData'));
  mkdirSync(logDir, { recursive: true });
  const logStream = createWriteStream(path.join(logDir, 'engine.log'), { flags: 'a' });
  const logLine = (line: string): void => {
    ringWrite(line);
    logStream.write(line + '\n');
  };
  logLine(`[desktop] ${new Date().toISOString()} starting engine for ${projectDir}: ${command}`);
  return { logLine, closeLog: () => logStream.end() };
}

/**
 * One line naming the capability plan this launch got.
 *
 * The supervisor sheds optional subsystems by memory profile, and EngineStatusBanner suppresses the
 * `degraded` state on purpose — so when the sensor under that policy was wrong, an 8 GB Mac ran with
 * codebaseMemory, autoIndex and drivesBoot all off, permanently, with nothing anywhere saying so.
 * The reading is fixed (supervisor/resources.ts availableBytes), but a policy that can silently turn
 * the product's features off should leave a record either way.
 */
function logCapabilityPlan(logLine: (line: string) => void, extraEnv: Record<string, string>): void {
  const gates: Array<[string, string]> = [
    ['codebaseMemory', extraEnv.BIMAX_DISABLE_CODEMEM ?? extraEnv.BIMAX_DISABLE_CODEBASE_MEMORY ?? ''],
    ['autoIndex', extraEnv.BIMAX_AUTO_INDEX ?? ''],
    ['drivesBoot', extraEnv.BIMAX_DRIVES_BOOT ?? ''],
    ['headroomProxy', extraEnv.BIMAX_DISABLE_HEADROOM ?? ''],
  ];
  // A "disable" gate is on when it is '0'/absent; an "enable" gate is on when it is '1'.
  const state = gates.map(([id, raw]) => {
    const on = id === 'autoIndex' || id === 'drivesBoot' ? raw !== '0' : raw !== '1';
    return `${id}=${on ? 'on' : 'off'}`;
  });
  // WHY the plan looks like this, not just what it is. A ⌘2 task pins these off at the spawn site —
  // a folder-bound job must not index the folder or boot drives — whereas a project thread declines
  // to override and takes whatever the memory profile allows. Both can print "all off" while meaning
  // completely different things, and reading one as the other is what let this override hide.
  const kind = extraEnv.BIMAX_THREAD_ORIGIN === 'quick' ? '⌘2 task, fixed by design'
    : extraEnv.BIMAX_THREAD_ORIGIN === 'project' ? 'project thread, by memory profile'
      : 'by memory profile';
  logLine(`[desktop] capability plan (${kind}): ${state.join(' ')}`);
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

  const { logLine, closeLog } = openEngineLog(projectDir, command);
  const logStream = { end: closeLog };

  for (const refusal of refusals) logLine(refusal);
  logCapabilityPlan(logLine, extraEnv);

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
      compileCacheDir: engineCompileCacheDir(),
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
    send: (msg) => {
      const stdin = child.stdin;
      if (stdin && stdin.writable) stdin.write(JSON.stringify(msg) + '\n');
    },
    endStdin: () => { try { child.stdin?.end(); } catch { /* already gone */ } },
    kill: (signal) => { try { child.kill(signal); } catch { /* already gone */ } },
  };
}

// ─── utilityProcess transport ──────────────────────────────────────────────────────────────────

/**
 * The engine module a utilityProcess forks — always built from src/index.ts, never downloaded.
 *
 * PACKAGED: <resources>/engine/index.js, the bun bundle that scripts/prepare-engine.sh produces
 * (23 MB, architecture-independent, deps included). Missing means fail visibly; there is no
 * development fallback inside a shipped app, exactly as the binary path refused one.
 *
 * DEVELOPMENT: the `tsc` output at dist/index.js when it exists, because an unbundled module graph
 * gives real file paths in stack traces and a debugger that can step into src/. It falls back to
 * the same bundle a release ships, so a contributor who has run prepare-engine.sh but not `tsc`
 * still gets an engine. Which one was chosen is written to engine.log on every launch — a silent
 * preference between two artifacts is how "the packaged artifact is untested" happens, so the
 * choice is always on the record.
 */
function resolveEngineModule(): string {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'engine', 'index.js');
    if (!existsSync(bundled)) {
      throw new PackagedRuntimeError(
        `packaged Bimax.app is missing its engine bundle at ${bundled}; refusing a development fallback`,
      );
    }
    return bundled;
  }
  const compiled = path.join(devRepoRoot(), 'dist', 'index.js');
  const bundled = path.join(devRepoRoot(), 'app', 'engine', 'index.js');
  // The NEWER of the two. Preferring dist/ whenever it existed meant a `tsc` output from weeks ago beat a bundle
  // built minutes ago — on this Mac a Sep 21 dist/ without the worker folder fix, which as a worker thread would
  // have run every task in the app's folder (record 64, M2).
  const built = [compiled, bundled].filter((file) => existsSync(file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (built.length) return built[0]!;

  throw new EngineArtifactError(
    `no engine found: expected the compiled source at ${compiled} (run \`npx tsc\` in the repo root) `
    + `or the shipped bundle at ${bundled} (run \`npm --prefix app run prepare:engine\`)`,
  );
}

/**
 * Spawn the engine as an Electron `utilityProcess` instead of an OS child process.
 *
 * Fits the same `deps.spawn` contract, so the supervisor — phase machine, heartbeat watchdog,
 * generation fencing, crash journal, capability shedding — is untouched and keeps working exactly
 * as it does today. That is the point: the transport changes underneath a lifecycle owner that has
 * already been debugged.
 *
 * Two asymmetries with the child-process path, both forced by Electron and both deliberate:
 *
 *   • INBOUND goes over the MessagePort, because `utilityProcess` rejects any `stdio[0]` other than
 *     `'ignore'`. OUTBOUND stays on piped stdout, which keeps WireQueue's real backpressure — a
 *     MessagePort would accept unboundedly and make a stalled front-end invisible.
 *   • `kill()` takes no signal and `exit` carries none, so SIGTERM and SIGKILL both become the one
 *     graceful terminate Electron offers, and an exit is always reported as a code. The supervisor
 *     escalates by calling kill twice, which is still correct — the second call is simply not
 *     harder than the first.
 */
export function spawnEngineUtilityProcess(
  projectDir: string,
  extraEnv: Record<string, string>,
  cb: SpawnCallbacks,
): EngineHandle {
  const modulePath = resolveEngineModule();
  const startedAt = Date.now();
  const command = `${process.execPath} (utilityProcess) ${modulePath}`;
  const { logLine, closeLog } = openEngineLog(projectDir, command);
  logCapabilityPlan(logLine, extraEnv);

  // buildEngineChildEnv is shared with the child-process path on purpose: the native-component
  // stripping, the per-thread model override and the folder-rule scoping are transport-independent,
  // and the two env builders that drifted apart once already are why this is not re-derived here.
  const env = engineModuleEnv(projectDir, extraEnv, modulePath);

  const child: UtilityProcess = utilityProcess.fork(modulePath, [], {
    env,
    cwd: devRepoRoot(),
    serviceName: 'Bimax Engine',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const provenanceLaunchId = processProvenance.begin({
    pid: child.pid,
    executableBasename: path.basename(modulePath),
    cwdClass: 'project',
    argumentClasses: ['headless-agent-protocol'],
  });

  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBuf += chunk.toString();
    let nl: number;
    while ((nl = stderrBuf.indexOf('\n')) !== -1) {
      logLine(stderrBuf.slice(0, nl));
      stderrBuf = stderrBuf.slice(nl + 1);
    }
  });

  const rl = child.stdout ? createInterface({ input: child.stdout }) : null;
  rl?.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg && typeof msg === 'object') cb.onMessage(msg as Record<string, unknown>);
      else cb.onMalformed(trimmed);
    } catch {
      logLine(`[app] dropped malformed line (${trimmed.length} chars)`);
      cb.onMalformed(trimmed);
    }
  });

  let settled = false;
  const finish = (): void => {
    if (stderrBuf) { logLine(stderrBuf); stderrBuf = ''; }
    rl?.close();
    closeLog();
  };

  child.on('exit', (code: number) => {
    if (settled) return;
    settled = true;
    processProvenance.finish(provenanceLaunchId, { exitCode: code, signal: null });
    logLine(`[desktop] engine exited after ${Date.now() - startedAt}ms: code ${code}`);
    finish();
    cb.onExit(code, null);
  });

  // A utilityProcess reports a Node fatal error with a diagnostic report rather than an Error, and
  // it does NOT imply exit — so this is logged as evidence and surfaced, and the 'exit' above stays
  // the single place that settles the launch.
  child.on('error', (type: string, location: string, _report: string) => {
    logLine(`[desktop] engine ${type} at ${location} after ${Date.now() - startedAt}ms`);
    cb.onError(new Error(`engine ${type} at ${location}`));
  });

  return {
    pid: child.pid,
    command,
    send: (msg) => { try { child.postMessage(JSON.stringify(msg) + '\n'); } catch { /* already gone */ } },
    // There is no stdin to close. The supervisor calls this immediately before kill('SIGTERM') at
    // both of its shutdown sites, so the terminate below is what actually ends the process — this
    // is a genuine no-op rather than an unimplemented one.
    endStdin: () => { /* utilityProcess has no stdin: Electron allows only stdio[0]='ignore' */ },
    kill: () => { try { child.kill(); } catch { /* already gone */ } },
  };
}

/**
 * The environment an engine module is started with, for both module transports. buildEngineChildEnv is shared on
 * purpose (native-component stripping, the per-thread model, folder-rule scoping); BIMAX_ENGINE_MODULE tells the
 * engine which bundle it is, so its sub-agents run that same bundle (subagent.manager.ts) instead of looking for a
 * worker entry file the packaged app never had.
 */
function engineModuleEnv(projectDir: string, extraEnv: Record<string, string>, modulePath: string): Record<string, string> {
  const childEnv = buildEngineChildEnv({
    parentEnv: process.env,
    extraEnv: { ...extraEnv, BIMAX_ENGINE_MODULE: modulePath },
    path: userShellPath(),
    projectDir,
    compileCacheDir: engineCompileCacheDir(),
  });
  // Electron's Env type admits no undefined values, unlike process.env.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(childEnv)) if (v !== undefined) env[k] = v;
  return env;
}

// ─── worker-thread transport: the monolith (record 64) ────────────────────────────────────────

/**
 * The V8 heap limit of one engine worker, a MEMORY cap (named per AGENTS.md: it is not the Bimax Thread cap
 * MAX_LIVE_ENGINES and not a CPU budget). Every isolate in this process shares ONE 4 GB V8 heap (Electron's pointer
 * compression, Chromium's shared cage — record 64 §3), so an engine gets a bounded share: over it, that engine's
 * worker is terminated and its supervisor restarts it, instead of the whole app reaching the process-wide limit.
 *
 * Measured 2026-09-29: one engine indexing this entire repository peaked at 128 MB used heap (163 MB allocated).
 * 768 MB is six times that. MAX_LIVE_ENGINES (4) × 768 = 3 GB, leaving ~1 GB for this thread's own heap and the
 * sub-agent workers (SUBAGENT_WORKER_HEAP_MB each).
 */
export const ENGINE_WORKER_HEAP_MB = 768;

/** How long an engine worker gets to shut down on its own after its input closes, before it is terminated. */
const WORKER_SHUTDOWN_GRACE_MS = 3000;

/** Acknowledge handled engine output once this many bytes have piled up, or at the end of the current tick. */
const ACK_EVERY_BYTES = 64 * 1024;

/**
 * Run the engine as a worker thread inside this process — the monolith (record 64). Same `deps.spawn` contract as
 * the process transports, so the supervisor (phases, heartbeat watchdog, generation fencing, crash journal) is
 * unchanged.
 *
 *   • The engine module is the same bundle; `workerData.bimaxEngineRoot` gives it its own working folder
 *     (src/engine/worker.folder.ts), because a worker cannot chdir.
 *   • Messages travel over a MessageChannel, one protocol message per port message (M3): the engine posts each
 *     outbound message as one JSON string, this side posts inbound messages as objects. No pipe, no line framing.
 *     This side acknowledges what it has handled; the engine lets at most a window of unacknowledged output out and
 *     queues the rest with its usual bounds (src/protocol/port.host.ts), so a stalled main thread cannot turn engine
 *     output into unbounded memory.
 *   • The worker's stdout and stderr are logs, never protocol, and go to engine.log.
 *   • An uncaught exception inside the engine emits 'error' (logged with its stack, reported like a process error)
 *     and ends only that worker. Closing our end of the port asks the engine to shut down; `kill('SIGTERM')` then
 *     terminates it after a grace period, `kill('SIGKILL')` at once — which interrupts even a busy loop.
 */
export function spawnEngineWorker(
  projectDir: string,
  extraEnv: Record<string, string>,
  cb: SpawnCallbacks,
  modulePath: string = resolveEngineModule(),
): EngineHandle {
  const startedAt = Date.now();
  const { logLine, closeLog } = openEngineLog(projectDir, `worker thread ${modulePath}`);
  logCapabilityPlan(logLine, extraEnv);

  const { port1: port, port2: enginePort } = new MessageChannel();
  const worker = new Worker(modulePath, {
    env: engineModuleEnv(projectDir, extraEnv, modulePath),
    workerData: { bimaxEngineRoot: projectDir, bimaxEnginePort: enginePort },
    transferList: [enginePort],
    stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: ENGINE_WORKER_HEAP_MB },
    name: 'Bimax Engine',
  });
  const command = `worker thread ${worker.threadId} ${modulePath}`;
  const provenanceLaunchId = processProvenance.begin({
    pid: process.pid,
    executableBasename: path.basename(modulePath),
    cwdClass: 'project',
    argumentClasses: ['headless-agent-protocol'],
  });

  // Logs only: anything the engine prints is evidence, never protocol.
  const logStream = (stream: NodeJS.ReadableStream): (() => void) => {
    let buf = '';
    stream.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        logLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    return () => { if (buf) { logLine(buf); buf = ''; } };
  };
  const flushStdout = logStream(worker.stdout);
  const flushStderr = logStream(worker.stderr);

  let unacked = 0;
  let ackScheduled = false;
  let exited = false;
  const acknowledge = (): void => {
    ackScheduled = false;
    if (!unacked || exited) return;
    const bytes = unacked;
    unacked = 0;
    try { port.postMessage({ t: '__ack', bytes }); } catch { /* the engine is gone */ }
  };
  port.on('message', (frame: unknown) => {
    if (typeof frame !== 'string') {
      logLine(`[app] dropped a non-string engine message (${typeof frame})`);
      cb.onMalformed(String(frame));
      return;
    }
    try {
      const msg = JSON.parse(frame);
      if (msg && typeof msg === 'object') cb.onMessage(msg as Record<string, unknown>);
      else cb.onMalformed(frame);
    } catch {
      logLine(`[app] dropped malformed message (${frame.length} chars)`);
      cb.onMalformed(frame);
    }
    // Handled: tell the engine it may send more — in bulk, not per message.
    unacked += frame.length;
    if (unacked >= ACK_EVERY_BYTES) acknowledge();
    else if (!ackScheduled) { ackScheduled = true; setImmediate(acknowledge); }
  });

  let graceTimer: NodeJS.Timeout | null = null;
  worker.on('error', (err: Error) => {
    // An uncaught exception or an out-of-heap: the worker ends after this, and 'exit' settles the launch.
    logLine(`[desktop] engine worker error after ${Date.now() - startedAt}ms: ${err.stack || err.message}`);
    if (!exited) cb.onError(err);
  });
  worker.on('exit', (code: number) => {
    if (exited) return;
    exited = true;
    if (graceTimer) clearTimeout(graceTimer);
    processProvenance.finish(provenanceLaunchId, { exitCode: code, signal: null });
    flushStdout();
    flushStderr();
    try { port.close(); } catch { /* already closed */ }
    logLine(`[desktop] engine worker exited after ${Date.now() - startedAt}ms: code ${code}`);
    closeLog();
    cb.onExit(code, null);
  });

  const terminate = (): void => { if (!exited) void worker.terminate().catch(() => undefined); };
  return {
    command,
    send: (msg) => { if (!exited) { try { port.postMessage(msg); } catch { /* the engine is gone */ } } },
    // Closing our end is the engine's signal to shut down (port.host.ts), as the end of stdin was.
    endStdin: () => { try { port.close(); } catch { /* already closed */ } },
    kill: (signal) => {
      if (exited) return;
      if (signal === 'SIGKILL') { terminate(); return; }
      // SIGTERM: the port is closed (endStdin, just before), so the engine is shutting itself down; stop waiting after
      // the grace period.
      if (!graceTimer) graceTimer = setTimeout(terminate, WORKER_SHUTDOWN_GRACE_MS);
    },
  };
}

/**
 * Pick the transport. The default is the monolith (record 64): the engine as a worker thread in this process.
 *
 * `BIMAX_ENGINE_TRANSPORT=process` selects the separate utilityProcess engine, the default until 2026-09-29, kept
 * for one release as the fallback if a worker-only problem turns up. `child` still selects the OS child process,
 * useful with an explicit `BIMAX_ENGINE_CMD` to bisect a regression against an older engine build; without that
 * override it fails to resolve, which is the honest outcome rather than a silent fallback.
 */
export function spawnEngine(
  projectDir: string,
  extraEnv: Record<string, string>,
  cb: SpawnCallbacks,
): EngineHandle {
  const transport = engineTransport();
  if (transport === 'child') return spawnEngineProcess(projectDir, extraEnv, cb);
  if (transport === 'process') return spawnEngineUtilityProcess(projectDir, extraEnv, cb);
  return spawnEngineWorker(projectDir, extraEnv, cb);
}

/** Which transport a launch takes: 'worker' unless BIMAX_ENGINE_TRANSPORT names 'process' or 'child'. */
export function engineTransport(env: NodeJS.ProcessEnv = process.env): 'worker' | 'process' | 'child' {
  const named = (env.BIMAX_ENGINE_TRANSPORT || '').trim().toLowerCase();
  if (named === 'child') return 'child';
  if (named === 'process' || named === 'utility' || named === 'utilityprocess') return 'process';
  return 'worker';
}
