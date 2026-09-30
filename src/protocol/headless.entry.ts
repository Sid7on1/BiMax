// The egress perimeter must go up before any module here opens a socket — see
// security/egress.perimeter.ts for why the guard lives beneath the code rather than beside it.
import { installEgressPerimeter } from '../security/egress.perimeter';
installEgressPerimeter();
import { engineEvents } from '../engine/events';
import { goalEvents } from '../memory/goal.manager';
import { buildPersonas } from '../engine/personas/factory';
import { HeadlessSession } from './headless.session';
import { startPortHost, type EnginePortLike } from './port.host';
import { startUiSnapshot, setTokensBaseline, setApprovalsReader } from './ui.snapshot';
import { getConfig, saveConfig } from '../engine/config';
import { estimateTokens } from '../graph/context.planner';
import { startAssignmentRecovery } from './headless.recovery';
import { startOutcomeContinuation } from './headless.continuation';
import { buildHostHandlers } from './headless.handlers';
import { startHeartbeat } from './headless.heartbeat';
import { offerKeySetupWhenPoolEmpty, wakeDrives, reportInterruptedTasks, healModelPins } from './headless.boot';
import { startIndexOnboarding } from './headless.onboarding';
// Register every slash command for its side effect. Commands self-register on import (each module
// calls globalCommandRegistry.register at top level), and the Ink path got them via FullScreen's
// imports — but headless imports only the bare registry, so without this the palette is EMPTY:
// no autocomplete for "/", and every slash command falls through as "Unknown command".
import '../engine/commands';

/**
 * Run the engine's session for the app: the engine is a worker thread in the app's process (the monolith, record 64)
 * and speaks over the MessagePort the app handed it, one protocol message per port message (port.host.ts). Called by
 * index.ts once the container is built.
 *
 * `container` is the createContainer() result; `config` the loaded config. Resolves only when the session shuts down:
 * when the app closes its end of the port, or an `engineEvents` 'shutdown'.
 *
 * Until record 64's M4 (2026-09-30) the engine could also run as its own process, speaking NDJSON on stdin/stdout;
 * that transport (stdio.host.ts, parent.port.ts, codec.ts) is in ~/Developer/bimax-archive and at the git tag
 * `keep/engine-process-fallback`.
 */
export interface HeadlessTransport {
  /** The port the app handed this engine worker. The app closing its end shuts the engine down. */
  port: EnginePortLike;
}

export async function startHeadless(container: any, config: any, transport: HeadlessTransport): Promise<void> {
  const { toolRegistry, llmAdapter, governor, graphStore, codebaseIndexer } = container;

  // The agent gates the user saved — diff approval, the blast-radius gate, self-critic and the rest —
  // are in force from the first message. Only their slash commands used to set them, so a choice made
  // in Settings was saved and never ran (engine/gate.flags.ts, fix list item 12).
  require('../engine/gate.flags').applyGateFlags(config);
  // Auto-verify and git auto-commit are PostToolUse hooks, and the Ink terminal's boot was the only
  // thing that registered them: when Ink was retired both went with it, so their switches — slash
  // command or Settings — did nothing at all (fix list item 12). Each hook returns at once until its
  // gate is on.
  {
    const { registerPostHook } = require('../tools/hooks') as typeof import('../tools/hooks');
    const verify = require('../sandbox/verify.loop') as typeof import('../sandbox/verify.loop');
    const autoCommit = require('../tools/git.autocommit') as typeof import('../tools/git.autocommit');
    verify.registerVerifyGraphStore(graphStore ?? null);
    registerPostHook(verify.VERIFY_TOOLS, verify.verifyHook);
    registerPostHook(autoCommit.GIT_AUTOCOMMIT_TOOLS, autoCommit.gitAutoCommitHook);
  }

  // User-defined slash commands: `.bimax/commands/<name>.md` in the project (winning) then
  // ~/.bimax/commands. The loader has existed and been unit-tested since A1, and nothing ever
  // called it — commands/index.ts imports its 53 siblings for their registration side effects, but
  // this one registers from the FILESYSTEM, so it needs invoking rather than importing. The feature
  // was complete and unreachable.
  //
  // Called here because it must run after the engine has chdir'd to the project (index.ts honours
  // BIMAX_CWD before the container is built), and before the first `query` can ask for completions.
  // A command body is dispatched as `redirect`, i.e. exactly as if the user had typed it, so it
  // faces the same governor and approval ladder as anything else — a project-supplied command still
  // cannot act without the user invoking it by name and approving what it does.
  try {
    const { loadCustomCommands } = require('../engine/commands/custom.loader') as typeof import('../engine/commands/custom.loader');
    const custom = loadCustomCommands();
    if (custom.length) {
      const { Logger } = require('../utils/logger') as typeof import('../utils/logger');
      Logger.info(`[commands] loaded ${custom.length} custom command(s): ${custom.join(' ')}`);
    }
  } catch { /* best-effort: a broken command file must never stop the engine booting */ }

  const options = {
    toolRegistry,
    llmAdapter,
    governor,
    maxToolIterations: config.maxToolIterations,
    notificationBell: config.notificationBell,
    persona: null,
  };

  // Session persistence: append every message/tool call to .breakglass/sessions/<id>.jsonl and
  // keep sessions-meta.jsonl current, so /sessions, /resume, and the desktop's thread surfaces
  // have real data. Attach BEFORE the host so nothing emitted during boot is lost.
  const { reportBootPhase } = require('./boot.status') as typeof import('./boot.status');
  reportBootPhase('restoring_session');
  const { startSessionRecorder } = require('../engine/session.recorder');
  const sessionRecorder = startSessionRecorder();
  // Recents names a session by what it is for, from its first reply (engine/session.summary.ts). After
  // the recorder, so the session it names already exists when the first message arrives.
  require('../engine/session.summary').startSessionSummaries(llmAdapter);

  // Review domain: fold approvals / attributed changes / verification evidence / checkpoints into
  // the per-thread review file and publish `review_update` snapshots. Rides the same thread
  // lifecycle as the recorder above (session_changed), so it must start after it.
  const { startReviewManager } = require('../review/review.manager');
  const reviewManager = startReviewManager();

  // Outcome runtime: one persistent acceptance/task/evidence contract per thread. It starts after
  // the recorder so session_changed always has a concrete id, and listens to the review domain's
  // mutation/evidence facts instead of inventing a second source of truth.
  const { startOutcomeManager } = require('../outcome/outcome.manager');
  const outcomeManager = startOutcomeManager();
  // Task grants (N13) end with the task: a new task in this engine, or a switch to another saved one.
  require('../governor/task.grants').endGrantsWithTask(engineEvents);
  // Completion checks (F3): per session, like the outcome contract, so they follow session_changed too.
  require('../outcome/completion.check').startCompletionChecks();

  const personas = buildPersonas(toolRegistry, llmAdapter);
  const session = new HeadlessSession({
    personas,
    options,
    graphStore,
    codebaseIndexer,
    saveConfig,
  });

  // Unattended crash recovery of interrupted assignments (headless.recovery.ts).
  const stopRecovery = startAssignmentRecovery({ session, outcomeManager, config });

  // Outcome auto-continuation: wake the coordinator when background work settles (headless.continuation.ts).
  const stopContinuation = startOutcomeContinuation({ session, outcomeManager, config });

  // Token-meter baseline = system prompt + tool-schema JSON (the fixed per-request cost), recomputed
  // on demand so a Smart↔Full context-mode toggle moves the meter. Mirrors FullScreen's calc.
  setTokensBaseline(() => {
    try {
      const mode = (getConfig().contextMode as 'smart' | 'full') || 'smart';
      const persona = personas.bimax || Object.values(personas)[0];
      const sys = persona?.getSystemPrompt({ planMode: governor?.mode === 'plan', contextMode: mode }) || '';
      let toolTokens = 0;
      try {
        toolTokens = estimateTokens(JSON.stringify(toolRegistry.getSchemas({ mode })));
      } catch {
        /* registry optional */
      }
      return estimateTokens(sys) + toolTokens;
    } catch {
      return 0;
    }
  });

  // What the engine does with each message the app sends (headless.handlers.ts).
  const handlers = buildHostHandlers({ session, graphStore, llmAdapter });
  const dispose = startPortHost({ emitter: engineEvents, port: transport.port, onClose: () => engineEvents.emit('shutdown'), ...handlers });

  // Liveness heartbeat for the supervisor's hang watchdog, on the host's queue (headless.heartbeat.ts).
  const stopHeartbeat = startHeartbeat((msg) => dispose.send(msg), () => session.isBusy);

  // Register the inline diff-approval gate over the protocol (Ink registers its own in FullScreen).
  // When the user enables /diff-approval, mutating tools surface their diff and wait for a reply.
  const { registerDiffApprover } = require('../engine/diffApproval');
  registerDiffApprover(
    (summary: string, diff: string) =>
      new Promise<boolean>((resolve) => {
        engineEvents.emit('diff_prompt', summary, diff, (answer: string) =>
          resolve(/^(a|y|approve|accept)/i.test(answer)),
        );
      }),
  );

  // Goal mutations land on a separate emitter; FullScreen bridges it to engineEvents for Ink, so the
  // headless path must too — otherwise the footer goal counter (refreshed by ui_snapshot on
  // goals_changed) never updates out-of-process.
  const onGoals = () => engineEvents.emit('goals_changed');
  goalEvents.on('goals_changed', onGoals);

  // The approval gates as the engine will apply them — the composer's permission pill shows this, not
  // what it last sent (fix list item 12).
  setApprovalsReader(() => ({
    askBeforeEdits: require('../engine/diffApproval').isDiffApprovalEnabled(),
    readOnly: governor?.mode === 'plan',
    unattended: governor?.mode === 'bypass' || governor?.mode === 'unattended',
  }));
  // Push footer + map-panel + token-meter state the Go front-end can't read from engine singletons.
  startUiSnapshot(graphStore, toolRegistry);

  // Boot chores, each best-effort (headless.boot.ts): open provider setup when there is no key, a quick drives check,
  // report background tasks the last shutdown interrupted, and heal a model pin that cannot run here.
  offerKeySetupWhenPoolEmpty(session);
  wakeDrives();
  reportInterruptedTasks();
  healModelPins(llmAdapter);

  // Offer (or start) the code map on a new codebase, then the AI layer once the map exists (headless.onboarding.ts).
  const stopOnboarding = startIndexOnboarding({ graphStore, codebaseIndexer });

  await new Promise<void>((resolve) => {
    let done = false;
    const shutdown = () => {
      if (done) return;
      done = true;
      // Flush every durable domain directly, so the latest assignment and evidence cannot vanish when the app closes
      // the port.
      try {
        outcomeManager.shutdown();
      } catch {
        /* best-effort */
      }
      try {
        reviewManager.shutdown();
      } catch {
        /* best-effort */
      }
      try {
        sessionRecorder.shutdown();
      } catch {
        /* best-effort */
      }
      stopHeartbeat();
      stopRecovery();
      stopContinuation();
      stopOnboarding();
      goalEvents.off('goals_changed', onGoals);
      dispose();
      resolve();
    };
    // The app closing the port emits 'shutdown' (port.host.ts). There is no stdin to watch and no signal to catch: a
    // worker thread receives no signals, so SIGINT/SIGTERM listeners here never ran once the engine became a worker.
    engineEvents.once('shutdown', shutdown);
  });
}
