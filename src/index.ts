// The Bimax engine's one and only entry point.
//
// THERE IS NO CLI ANY MORE. This file used to be two front doors in one: the engine the desktop
// boots, and a `commander` program with flags (-p print mode, --acp, `bimax mcp`, terminal themes)
// left over from the Go/Bubble Tea TUI that was archived on 2026-09-06. The TUI was the CLI; once it
// left, the flags were parsing arguments no front-end ever passed, and print mode, the ACP agent and
// the MCP graph server were reachable only through them. All of it now lives in
// ~/Developer/bimax-archive at its repo path, cmp-verified, not deleted.
//
// What boots this process, and nothing else does:
//   • the desktop app — an Electron `utilityProcess` (MessagePort in, piped stdout out), or an OS
//     child process (stdin/stdout). The transport is DETECTED below, never configured.
//   • itself — a one-shot sub-agent re-exec carrying BIMAX_SUBAGENT_CONFIG.
// Every mode is chosen by ENVIRONMENT, never by argv, so there is no argument surface to drift.

// Buffer boot logs so they don't fight the front-end for stdout during boot
const bootLogs: string[] = [];
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

function startBootCapture() {
  console.log = (...args: any[]) => { bootLogs.push(args.join(' ')); };
  console.warn = (...args: any[]) => { bootLogs.push(`[WARN] ${args.join(' ')}`); };
  console.error = (...args: any[]) => { bootLogs.push(`[ERROR] ${args.join(' ')}`); };
}

// Start capturing IMMEDIATELY before imports trigger prints
startBootCapture();

import * as fs from 'fs';
import dotenv from 'dotenv';
import { loadGlobalEnv } from './engine/env.loader';
loadGlobalEnv();
dotenv.config();
// The egress perimeter goes up the instant the environment is readable and before any other module
// gets a chance to open a socket. It is what makes "nothing leaves the premises" a property of the
// process rather than a promise about sixteen call sites. See security/egress.perimeter.ts.
import { installEgressPerimeter } from './security/egress.perimeter';
installEgressPerimeter();
import { createContainer } from './core/container';
import { loadConfig } from './engine/config';
import { setCustomRoutingRules } from './engine/agentRouter';
import { engineEvents } from './engine/events';
import { setGlobalPatternStore, GenomePatternStore } from './genome/pattern.store';
import { setGlobalRecipeLoader, RecipeLoader } from './recipes/recipe.loader';
import { setBlueprintEngine, BlueprintEngine } from './blueprints/blueprint.engine';
import { setBlueprintCompiler, BlueprintCompiler } from './blueprints/blueprint.compiler';
import { setTrainMonitor, TrainMonitor } from './training/train.monitor';
import { setTrainLauncher, TrainLauncher } from './training/train.launcher';
import { setContextManagerGraphStore } from './memory/context.manager';

// Sovereign mode is resolved BEFORE the container boots, so the very first request any subsystem
// makes is already governed. Resolving it later would leave a window in which a start-up probe
// (an update check, a telemetry handshake) leaves the premises before the mode is on — and a
// window is exactly what an air-gap claim cannot have. It reads BIMAX_SOVEREIGN /
// BIMAX_SOVEREIGN_ALLOW, which is where it always resolved from — the old --sovereign flags only
// ever set the same two values one layer higher up.
{
  const { isSovereign, sovereignAllowlist } = require('./security/sovereign');
  if (isSovereign()) {
    const { ledgerPath } = require('./security/egress.ledger');
    const allow = sovereignAllowlist();
    // Printed, not logged: an operator who asked for air-gap mode must be able to SEE that it took
    // effect, and the boot-log buffer is replayed too late to serve as confirmation.
    originalConsoleLog(
      `\n  SOVEREIGN MODE — external egress fails closed.\n` +
      `  Local: loopback + private LAN${allow.length ? ` + allowlist (${allow.join(', ')})` : ' (no allowlist)'}\n` +
      `  Shell: network denied at the kernel; refused outright where the OS cannot enforce it\n` +
      `  Ledger: ${ledgerPath()}   ·   /sovereign report for the audit trail\n`
    );
  }
}

// 4. Graceful Boot Error Handling (API-006)
process.on('uncaughtException', (err) => {
  // A broken pipe means our reader — the desktop — closed stdout/stderr, i.e. it exited. That's a
  // normal shutdown, not a crash: leave quietly with no scary fatal-crash.log or CRITICAL CRASH banner.
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') { process.exit(0); }

  const msg = `[FATAL] Uncaught Exception: ${err.message}\n${err.stack}`;
  fs.appendFileSync('fatal-crash.log', new Date().toISOString() + ' ' + msg + '\n');

  if (bootLogs.length > 0) {
    originalConsoleError(msg);
  } else {
    engineEvents.emit('message', { id: `crash-${Date.now()}`, role: 'assistant', content: `❌ **CRITICAL CRASH:** ${err.message}`, timestamp: new Date() });
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  const msg = `[FATAL] Unhandled Rejection at: ${promise}, reason: ${reason}`;
  fs.appendFileSync('fatal-crash.log', new Date().toISOString() + ' ' + msg + '\n');
  if (bootLogs.length > 0) {
    originalConsoleError(msg);
  } else {
    engineEvents.emit('message', { id: `crash-${Date.now()}`, role: 'assistant', content: `❌ **UNHANDLED REJECTION:** ${reason}`, timestamp: new Date() });
  }
});

async function main() {
  // Sub-agent SUBPROCESS mode: the engine re-execs itself with BIMAX_SUBAGENT_CONFIG to run a
  // sub-agent (worker_threads can't carry their deps inside a bundled engine; a full re-exec can).
  // Intercept before ANY engine boot — this process is a one-shot worker, not a front-end's engine.
  if (process.env.BIMAX_SUBAGENT_CONFIG) {
    const { runAsSubprocess } = await import('./engine/worker.entry');
    await runAsSubprocess();
    return;
  }

  // Honor the front-end's working directory BEFORE anything reads config or the graph. The engine's
  // own cwd is wherever it was spawned; the user's actual PROJECT is passed as BIMAX_CWD. This must
  // run before loadConfig(), or the project config (`<cwd>/.breakglass/config.json`) is read from
  // the wrong directory and cached — e.g. a repo's pinned model overriding the user's default.
  if (process.env.BIMAX_CWD) {
    try { process.chdir(process.env.BIMAX_CWD); } catch { /* keep current cwd on failure */ }
  }

  // Supervised launches see real startup phases on stdout instead of silence until `ready`.
  const { reportBootPhase } = await import('./protocol/boot.status');
  reportBootPhase('booting');

  reportBootPhase('loading_storage');
  const config = await loadConfig();
  if (config.customRoutingRules.length > 0) {
    setCustomRoutingRules(config.customRoutingRules);
  }

  const container = await createContainer(config);
  const { governor, graphStore } = container;
  governor.mode = config.dangerouslySkipPermissions ? 'bypass' : 'interactive';

  // Wire genome pattern store, recipe loader, and graph store for context injection
  setGlobalPatternStore(new GenomePatternStore(process.cwd()));
  setGlobalRecipeLoader(new RecipeLoader(process.cwd()));
  setBlueprintEngine(new BlueprintEngine(process.cwd()));
  setBlueprintCompiler(new BlueprintCompiler(process.cwd()));
  setTrainMonitor(new TrainMonitor(process.cwd()));
  setTrainLauncher(new TrainLauncher(process.cwd()));
  if (graphStore) setContextManagerGraphStore(graphStore);

  // The engine speaks its NDJSON stdio protocol and nothing else. The import below evaluates the
  // whole command/persona tree — on a cold page cache that is the longest silent stretch of boot,
  // so report it or the front-end shows a hang between the container and `ready`.
  reportBootPhase('loading_interface');
  const { startHeadless } = await import('./protocol/headless.entry');
  // Transport is DETECTED, not configured, and this stays the only boot path. The desktop can host
  // this same engine either as an OS child process (stdin/stdout) or as an Electron utilityProcess
  // (MessagePort inbound, piped stdout outbound) — and a second entry file for the second case is
  // exactly how desktop.runtime.ts and the two env builders came to drift, with the copy nobody ran
  // quietly losing features the other had. One file, one boot, one place a fix lands.
  const { underUtilityProcess, parentPortInput } = await import('./protocol/parent.port');
  await startHeadless(container, config, underUtilityProcess() ? { input: parentPortInput() } : {});
  process.exit(0);
}

main().catch((e) => {
  // Restore console in case of crash
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
  console.error('Fatal error:', e);
  process.exit(1);
});
