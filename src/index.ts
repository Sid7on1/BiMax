#!/usr/bin/env node
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
import { loadGlobalEnv } from './cli/env.loader';
loadGlobalEnv();
dotenv.config();
// The egress perimeter goes up the instant the environment is readable and before any other module
// gets a chance to open a socket. It is what makes "nothing leaves the premises" a property of the
// process rather than a promise about sixteen call sites. See security/egress.perimeter.ts.
import { installEgressPerimeter } from './security/egress.perimeter';
installEgressPerimeter();
import { Command } from 'commander';
import { createContainer } from './core/container';
import { readPackageVersion } from './core/self.update';
import { resolveTheme } from './cli/themes';
import { loadConfig, getConfig } from './cli/config';
import { setCustomRoutingRules } from './cli/agentRouter';
import { cliEvents } from './cli/events';
import { setGlobalPatternStore, GenomePatternStore } from './genome/pattern.store';
import { setGlobalRecipeLoader, RecipeLoader } from './recipes/recipe.loader';
import { setBlueprintEngine, BlueprintEngine } from './blueprints/blueprint.engine';
import { setBlueprintCompiler, BlueprintCompiler } from './blueprints/blueprint.compiler';
import { setTrainMonitor, TrainMonitor } from './training/train.monitor';
import { setTrainLauncher, TrainLauncher } from './training/train.launcher';
import { setContextManagerGraphStore } from './memory/context.manager';

const program = new Command();

program
  .name('bimax')
  .description('BiMax — Autonomous AI agent for your terminal')
  .version(readPackageVersion())
  .argument('[prompt]', 'Prompt to run in non-interactive mode')
  .option('-p, --print', 'Non-interactive mode: print response and exit')
  .option('-m, --model <model>', 'Model override (e.g. gpt-4, claude-opus)')
  .option('-t, --theme <theme>', 'Color theme: dark, light, dark-ansi, light-ansi, dark-daltonized, light-daltonized, auto', 'auto')
  .option('-a, --agent <agent>', 'Agent persona: bimax, hermes, opencode, openclaw', 'bimax')
  .option('-v, --verbose', 'Verbose output')
  .option('-o, --output-format <format>', 'Output format: text, json, stream-json', 'text')
  .option('-y, --yes', 'Skip all permission prompts')
  .option('--print-with-tools', 'Include tool call output in print mode')
  .option('--acp', 'Run as an Agent Client Protocol agent over stdio (embed in Zed/editors)')
  // Checked below as `cliFlags.headless`, and routed to by bin/bimax.js, but never registered here —
  // so `bimax --headless` died in the argument parser ("unknown option") and only BIMAX_HEADLESS=1
  // worked. The flag the launcher documents has to exist.
  .option('--headless', 'Run the engine over the NDJSON stdio protocol for an embedded front-end')
  .option('--dangerously-skip-permissions', 'Skip all permission prompts')
  .option('--sovereign', 'Air-gap mode: external egress fails closed and the shell is denied the network')
  .option('--sovereign-allow <hosts>', 'Comma-separated on-premises hosts to treat as local under --sovereign');

program.parse(process.argv);

const cliFlags = program.opts();
const prompt = program.args[0];

// Sovereign mode is resolved BEFORE the container boots, so the very first request any subsystem
// makes is already governed. Resolving it later would leave a window in which a start-up probe
// (an update check, a telemetry handshake) leaves the premises before the mode is on — and a
// window is exactly what an air-gap claim cannot have.
if (cliFlags.sovereign) {
  const { setSovereignMode, setSovereignAllowlist } = require('./security/sovereign');
  setSovereignMode(true);
  if (typeof cliFlags.sovereignAllow === 'string' && cliFlags.sovereignAllow.trim()) {
    setSovereignAllowlist(cliFlags.sovereignAllow.split(/[,\s]+/).filter(Boolean));
  }
  const { sovereignAllowlist } = require('./security/sovereign');
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

// Boot log capture moved to top of file

function replayBootLogs() {
  // Give the front-end a moment to attach before replaying buffered boot logs as events
  setTimeout(() => {
    for (const msg of bootLogs) {
      cliEvents.emit('log', { id: 0, level: 'info', text: msg, timestamp: new Date() });
    }
    bootLogs.length = 0;
  }, 100);
}

// 4. Graceful Boot Error Handling (API-006)
process.on('uncaughtException', (err) => {
  // A broken pipe means our reader (the Go TUI) closed stdout/stderr — i.e. it exited. That's a normal
  // shutdown, not a crash: leave quietly with no scary fatal-crash.log or CRITICAL CRASH banner.
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') { process.exit(0); }

  const msg = `[FATAL] Uncaught Exception: ${err.message}\n${err.stack}`;
  fs.appendFileSync('fatal-crash.log', new Date().toISOString() + ' ' + msg + '\n');

  if (bootLogs.length > 0) {
    originalConsoleError(msg);
  } else {
    cliEvents.emit('message', { id: `crash-${Date.now()}`, role: 'assistant', content: `❌ **CRITICAL CRASH:** ${err.message}`, timestamp: new Date() });
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  const msg = `[FATAL] Unhandled Rejection at: ${promise}, reason: ${reason}`;
  fs.appendFileSync('fatal-crash.log', new Date().toISOString() + ' ' + msg + '\n');
  if (bootLogs.length > 0) {
    originalConsoleError(msg);
  } else {
    cliEvents.emit('message', { id: `crash-${Date.now()}`, role: 'assistant', content: `❌ **UNHANDLED REJECTION:** ${reason}`, timestamp: new Date() });
  }
});

async function main() {
  // Sub-agent SUBPROCESS mode: the bun-compiled binary re-execs itself with BIMAX_SUBAGENT_CONFIG to
  // run a sub-agent (worker_threads can't carry their deps inside a bun --compile binary; a full
  // re-exec can). Intercept before ANY engine boot — this process is a one-shot worker, not the CLI.
  if (process.env.BIMAX_SUBAGENT_CONFIG) {
    const { runAsSubprocess } = await import('./cli/worker.entry');
    await runAsSubprocess();
    return;
  }

  // `bimax mcp` — serve the project's code graph over MCP stdio (A4). Must intercept before
  // any other boot so "mcp" isn't treated as a prompt, and before normal logging starts.
  if (program.args[0] === 'mcp') {
    const { runGraphMcpStdioServer } = await import('./mcp/server');
    await runGraphMcpStdioServer(process.cwd());
    return;
  }

  // Honor the front-end's working directory BEFORE anything reads config or the graph. In dev the Go
  // TUI launches the engine with its CWD set to the repo (so `tsx src/index.ts` resolves), but the
  // user's actual PROJECT is wherever they ran the TUI — passed as BIMAX_CWD. This must run before
  // loadConfig(), or the project config (`<cwd>/.breakglass/config.json`) is read from the engine's
  // repo and cached — e.g. the repo's pinned llama model would override the user's minimax default.
  if (process.env.BIMAX_CWD) {
    try { process.chdir(process.env.BIMAX_CWD); } catch { /* keep current cwd on failure */ }
  }

  // Supervised launches (the desktop) see real startup phases on stdout instead of silence until
  // `ready`. No-ops outside headless mode (boot.status gates on BIMAX_HEADLESS).
  const { reportBootPhase } = await import('./protocol/boot.status');
  reportBootPhase('booting');

  reportBootPhase('loading_storage');
  const config = await loadConfig();
  if (config.customRoutingRules.length > 0) {
    setCustomRoutingRules(config.customRoutingRules);
  }

  const effectiveAgent = cliFlags.agent || config.defaultAgent;
  const effectiveModel = cliFlags.model || config.model;
  const effectiveVerbose = cliFlags.verbose || config.verbose;
  const effectiveTheme = resolveTheme(cliFlags.theme === 'auto' ? config.theme : cliFlags.theme);
  const effectiveSkipPerms = cliFlags.dangerouslySkipPermissions || cliFlags.yes || config.dangerouslySkipPermissions;

  const container = await createContainer(config);
  const { toolRegistry, llmAdapter, governor, codebaseIndexer, taskPipeline, graphStore } = container;
  governor.mode = effectiveSkipPerms ? 'bypass' : 'interactive';

  // Wire genome pattern store, recipe loader, and graph store for context injection
  setGlobalPatternStore(new GenomePatternStore(process.cwd()));
  setGlobalRecipeLoader(new RecipeLoader(process.cwd()));
  setBlueprintEngine(new BlueprintEngine(process.cwd()));
  setBlueprintCompiler(new BlueprintCompiler(process.cwd()));
  setTrainMonitor(new TrainMonitor(process.cwd()));
  setTrainLauncher(new TrainLauncher(process.cwd()));
  if (graphStore) setContextManagerGraphStore(graphStore);

  if (prompt && cliFlags.print) {
    const { executePrintMode } = await import('./cli/print');
    await executePrintMode(prompt, {
      agent: effectiveAgent,
      model: effectiveModel,
      theme: effectiveTheme,
      verbose: effectiveVerbose,
      outputFormat: cliFlags.outputFormat,
      ...container,
    });
    process.exit(0);
  }

  // ACP mode — run as an Agent Client Protocol agent over stdio, so an editor (Zed and other ACP
  // clients) can embed the full Bimax engine. Speaks newline-delimited JSON-RPC instead of Bimax's
  // own NDJSON protocol. Checked before headless so `--acp` wins if both are somehow set.
  if (process.env.BIMAX_ACP === '1' || cliFlags.acp) {
    const { startAcpAgent } = await import('./protocol/acp/entry');
    await startAcpAgent(container, config);
    process.exit(0);
  }

  // Headless mode — drive the engine over an NDJSON stdio protocol. This is the process the
  // out-of-process front-end (the Go / Bubble Tea TUI) spawns, forked after the container is
  // wired. This is the only interactive path; there is no in-process UI below (see §below).
  if (process.env.BIMAX_HEADLESS === '1' || cliFlags.headless) {
    // The interface import below evaluates the whole command/persona tree — on a cold page cache
    // (compiled binary, memory-pressured host) that is the longest silent stretch of boot. Report
    // it so the front-end shows progress instead of appearing hung between the container and ready.
    reportBootPhase('loading_interface');
    const { startHeadless } = await import('./protocol/headless.entry');
    await startHeadless(container, config);
    process.exit(0);
  }

  // Restore console — no Ink to fight for stdout anymore.
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;

  // The interactive TUI is now the `bimax` binary (Go / Bubble Tea), which spawns this engine
  // headless (BIMAX_HEADLESS=1) and drives it over the NDJSON stdio protocol. The old in-process
  // Ink frontend has been retired (archived under ~/Desktop/ink-bimax). Reaching here means the
  // engine was launched directly without a front-end, so there's nothing to render.
  originalConsoleError(
    'BiMax engine started with no front-end.\n' +
    '  • Interactive use:   run the `bimax` binary (the Go/Bubble Tea TUI).\n' +
    '  • One-shot use:      bimax -p "<prompt>"\n' +
    '  • Embed a front-end: spawn this with BIMAX_HEADLESS=1 and speak the stdio protocol.',
  );
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
