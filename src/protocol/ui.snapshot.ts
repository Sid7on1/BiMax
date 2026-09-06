import { cliEvents } from '../cli/events';
import { IGraphStore } from '../graph/models';
import { summarizeGraph, isCodebase } from '../graph/graph.summary';
import { isCodememReady } from '../graph/codemem/backend';
import { getHeadroomSavedTokens } from '../memory/headroom.compress';
import type { ToolRegistry, ContextMode } from '../tools/tool.registry';

// Footer state that the Ink UI reads directly from engine singletons (getConfig, getGoalManager)
// rather than from events. An out-of-process front-end can't reach those, so we snapshot them into
// a `ui_snapshot` event the ProtocolHost forwards. Emitted once at startup and again whenever the
// underlying state changes (config / goals / graph), so the Go footer + map panel + token-meter
// stay live without polling.

export interface UiSnapshotModule {
  name: string;
  criticality?: string;
}

export interface UiSnapshotGraph {
  nodeCount: number;
  fileCount: number;
  aiGraphBuilt: boolean;
  modules: UiSnapshotModule[];
  // Which engine is backing the graph tools: 'codebase-memory' (baked-in 158-language engine with
  // local semantic search), 'native' (BiMax's in-memory AST graph), or 'none' (not indexed yet).
  // Lets the Go TUI badge the codebase map / footer so the user knows semantic search is live.
  engine: 'codebase-memory' | 'native' | 'none';
}

// Mind-layer strip for the footer: how many learned weak spots the self-model is routing
// around, how many drives are deviating (fresh measurements only), and compiled habit count.
// The detail arrays make the 🧠 chip EXPLAINABLE (v2 §3.11): the TUI's mind HUD renders the
// top weak spots with their posterior stats, the deviating drives with a measurement
// sparkline, and the compiled habit names — evidence, not an opaque counter.
export interface UiSnapshotMindWeak {
  tool: string;
  domain: string;
  failRate: number; // posterior mean failure rate
  pWeak: number;    // P(θ > weak level) — the decision statistic
  n: number;        // window samples behind it
  advice: string;
}

export interface UiSnapshotMindDrive {
  label: string;
  value: string;    // human-readable last measurement ("3 type errors", "41 TODOs")
  ok: boolean;      // at setpoint?
  // Recent measurement history, oldest → newest (1 = at setpoint, 0 = deviating) — sparkline fuel.
  spark: number[];
}

// The epistemic ledger's verification posture — the correctness half of the mind HUD's "receipts".
export interface UiSnapshotMindLedger {
  resolved: number;      // claims a build/test run confirmed
  open: number;          // edits whose correctness nothing has checked yet
  expired: number;       // claims that timed out unverified (a verification-coverage gap)
  coveragePct: number;   // resolved / (resolved + expired) — % of claims that ever met evidence
  overconfident: number; // domains with a statistically significant overconfidence gap
}

export interface UiSnapshotMind {
  weakSpots: number;
  driveDeviations: number;
  habits: number;
  weak?: UiSnapshotMindWeak[];
  drives?: UiSnapshotMindDrive[];
  habitNames?: string[];
  ledger?: UiSnapshotMindLedger;
}

// --- Protocol v2 additive fields ------------------------------------------------------------
// All optional: a v1 front-end ignores them, a v2 front-end hides the matching panel when absent.

/** One saved session for the front-end's session list (sidebar) — from db/session.meta. */
export interface UiSnapshotSession {
  id: string;
  title: string;
  startedAt: string; // ISO
  messageCount: number;
  cwd: string;
  current: boolean;  // the live session this engine process is writing
}

/** One Time Machine checkpoint (sandbox/checkpoint.manager) for the History strip. */
export interface UiSnapshotCheckpoint {
  id: string;
  label: string;
  ts: number;   // epoch ms
  auto: boolean;
}

export interface UiSnapshotGit {
  branch: string;
  dirty: number; // changed files (index + worktree + untracked)
  ahead: number;
  behind: number;
}

/** Live tool fabric: what the model can call now vs what remains load-on-demand. */
export interface UiSnapshotTools {
  registered: number;
  ready: number;
  deferred: number;
  discovered: number;
  mcp: number;
  graphReady: boolean;
}

/** One live/recent task workspace for the front-end task panel (task.registry.ts). */
export interface UiSnapshotTask {
  id: string;
  kind: string;       // 'shell' | 'browser' | 'subagent' | 'build' | 'test' | 'generic'
  title: string;
  state: string;      // TaskState — the 16-state machine in execution.ledger.ts
  elapsedMs: number;
  attention: boolean;
  pinned: boolean;
  lastEvent?: string;
  progress?: number;  // 0..1 where measurable
  canPause: boolean;  // honest capability flags — the TUI only offers what's real
  canResume: boolean;
  canCancel: boolean;
}

/**
 * The Composer's corpus, mirrored so a front-end can show what it is actually working from.
 *
 * `skipped` is the field that earns its place: a user who drops 200 inspection reports and is told
 * only "191 ingested" will proceed as though all 200 were read, and the nine unreadable scans are
 * precisely the ones that change an assessment. Silence about a failed attachment is the worst
 * available outcome, so the reasons ride all the way to the UI.
 */
export interface UiSnapshotComposer {
  /** Documents dropped for the task at hand. */
  session: number;
  /** Documents promoted into the standing knowledge library. */
  library: number;
  /** Indexed passages across both corpora. */
  passages: number;
  /** Measured values extracted from tables, queryable numerically. */
  facts: number;
  /** Outcome of the most recent ingest, including what could not be read and why. */
  lastIngest?: {
    ingested: number;
    chunks: number;
    skipped: { name: string; reason: string }[];
  };
}

export interface UiSnapshot {
  models: { coding: string; lite: string; vision?: string };
  goalCount: number;
  mind: UiSnapshotMind;
  // The codebase-map graph overview, mirrored so the Go front-end can render CodebaseMapPanel and
  // size its token-meter context window — neither of which it can compute from the engine singletons.
  graph: UiSnapshotGraph;
  // Effective context window (tokens) for the active model, so the Go token meter shows a real
  // "how full" fraction instead of a bare count. Resolved from config / model capabilities here.
  contextWindow: number;
  // The fixed cost every request pays — system prompt + tool-schema JSON — so the Go token meter
  // reflects real usage (thousands of tokens) instead of just the streamed reply (~tens). The
  // front-end adds the live conversation tokens on top. Mirrors Ink's systemPromptTokens.
  tokensBaseline: number;
  // Cumulative tokens saved this session by Headroom-style backlog compression — shown next to the
  // token meter so the user sees the compression paying off.
  compressionSaved: number;
  // Multi-repo workspace: how many repos are in context and their names, so the TUI status bar
  // always shows the working set (workspace.manager.ts). count <= 1 = single-repo session.
  workspace: { count: number; names: string[]; writable: number };
  // v2: recent sessions (newest first, capped) for the front-end sidebar; resume via `/resume <id>`.
  sessions?: UiSnapshotSession[];
  // v2: Time Machine checkpoints (newest first, capped) for the History strip; restore via `/rewind <id>`.
  checkpoints?: UiSnapshotCheckpoint[];
  // v2: coarse git state for header pills. Front-ends that can poll git natively (the Electron app)
  // may prefer their own fresher poll; this is for the ones that can't.
  git?: UiSnapshotGit;
  // v3 additive: live registry posture for desktop/tooling surfaces.
  tools?: UiSnapshotTools;
  // v3 additive: task workspaces (live + recent terminal tasks awaiting close) for the task panel.
  tasks?: UiSnapshotTask[];
  // v3 additive: the Composer's document corpus and extracted facts.
  composer?: UiSnapshotComposer;
  // NOTE: the Grok-port power/update footer chips were removed — no front-end ever consumed them
  // (silent TS→Go drift). Power posture is read via /power and update posture via /update.
}

/** Lazily-computed baseline (system prompt + tool schemas). Set by headless.entry, which has the
 *  personas + tool registry; ui.snapshot only sees the graph store. */
let baselineFn: (() => number) | undefined;
export function setTokensBaseline(fn: () => number): void { baselineFn = fn; }

export function buildUiSnapshot(graphStore?: IGraphStore, toolRegistry?: ToolRegistry): UiSnapshot {
  let models: { coding: string; lite: string; vision?: string } = { coding: '', lite: '' };
  let goalCount = 0;
  let contextWindow = 0;
  let contextMode: ContextMode = 'smart';
  try {
    const { getConfig } = require('../cli/config');
    const c = getConfig();
    models = { coding: c.model, lite: c.liteModel, vision: c.visionModel || undefined };
    contextWindow = c.contextWindowTokens || 0;
    contextMode = c.contextMode === 'full' ? 'full' : 'smart';
  } catch { /* config not ready */ }
  if (!contextWindow || contextWindow <= 0) {
    try {
      const { capabilitiesFor } = require('../core/capabilities');
      contextWindow = capabilitiesFor(undefined, models.coding || models.lite).contextWindow || 0;
    } catch { /* capabilities optional */ }
  }
  try {
    const { getGoalManager } = require('../memory/goal.manager');
    goalCount = getGoalManager().getActiveGoals().length;
  } catch { /* goal manager not initialized */ }

  const codememReady = (() => { try { return isCodememReady(); } catch { return false; } })();
  let graph: UiSnapshotGraph = { nodeCount: 0, fileCount: 0, aiGraphBuilt: false, modules: [], engine: codememReady ? 'codebase-memory' : 'none' };
  try {
    // Only surface the map in a real project root — never in a scratch dir like ~ or the Desktop,
    // where a stale/global graph would otherwise show hundreds of thousands of junk nodes.
    if (graphStore && isCodebase(process.cwd())) {
      const s = summarizeGraph(graphStore);
      graph = {
        nodeCount: s.nodeCount,
        fileCount: s.fileCount,
        aiGraphBuilt: s.aiGraphBuilt,
        modules: s.topModules.slice(0, 5).map((m) => ({ name: m.name, criticality: m.criticality })),
        // codebase-memory wins the badge when live; else native if the in-memory graph has nodes.
        engine: codememReady ? 'codebase-memory' : (s.nodeCount > 0 ? 'native' : 'none'),
      };
    }
  } catch { /* graph summary best-effort */ }

  let tokensBaseline = 0;
  try { tokensBaseline = baselineFn ? baselineFn() : 0; } catch { /* best-effort */ }

  let compressionSaved = 0;
  try { compressionSaved = getHeadroomSavedTokens(); } catch { /* best-effort */ }

  let mind: UiSnapshotMind = { weakSpots: 0, driveDeviations: 0, habits: 0 };
  try {
    const { getSelfModel } = require('../mind/self.model');
    const { getDrivesEngine } = require('../mind/drives.engine');
    const { getHabitMiner } = require('../mind/habit.compiler');
    const { getEpistemicLedger } = require('../mind/epistemic.ledger');
    const weakAll = getSelfModel().weakSpots();
    const drivesEngine = getDrivesEngine();
    const deviations = drivesEngine.deviations();
    const compiled = getHabitMiner().habits().filter((h: any) => h.compiled);
    // Drive detail: deviating drives first, then healthy measured ones, capped at 5 —
    // enough for the HUD without bloating every snapshot frame.
    const measured = (drivesEngine.list() as any[])
      .filter((d: any) => d.lastOk !== undefined)
      .sort((a: any, b: any) => Number(a.lastOk) - Number(b.lastOk))
      .slice(0, 5);
    mind = {
      weakSpots: weakAll.length,
      driveDeviations: deviations.length,
      habits: compiled.length,
      weak: weakAll.slice(0, 4).map((w: any) => ({
        tool: w.tool, domain: w.domain, failRate: w.failRate, pWeak: w.pWeak, n: w.n, advice: w.advice,
      })),
      drives: measured.map((d: any) => ({
        label: d.label,
        value: d.lastValue || '',
        ok: !!d.lastOk,
        spark: (d.history || []).slice(-16).map((h: any) => (h.ok ? 1 : 0)),
      })),
      habitNames: compiled.slice(0, 5).map((h: any) => h.slug || h.key),
      ledger: (() => {
        const st = getEpistemicLedger().stats();
        const met = st.resolved + st.expired;
        return {
          resolved: st.resolved, open: st.open, expired: st.expired,
          coveragePct: met > 0 ? Math.round((st.resolved / met) * 100) : 0,
          overconfident: (getEpistemicLedger().overconfidentDomains() || []).length,
        };
      })(),
    };
  } catch { /* mind layer best-effort */ }

  let workspace = { count: 0, names: [] as string[], writable: 0 };
  try {
    const { tryGetWorkspace } = require('../core/workspace.manager');
    const ws = tryGetWorkspace();
    if (ws) workspace = ws.snapshot();
  } catch { /* workspace best-effort */ }

  // v2 fields — each independently best-effort so one broken subsystem never blanks the others.
  let sessions: UiSnapshotSession[] | undefined;
  try {
    const { listSessionMeta, getCurrentSessionId } = require('../db/session.meta');
    const current = getCurrentSessionId();
    sessions = (listSessionMeta(20) as any[]).map((m) => ({
      id: m.id,
      title: m.title || '(no messages yet)',
      startedAt: m.startedAt || '',
      messageCount: m.messageCount || 0,
      cwd: m.cwd || '',
      current: m.id === current,
    }));
  } catch { /* session meta best-effort */ }

  let checkpoints: UiSnapshotCheckpoint[] | undefined;
  try {
    const { globalCheckpointManager } = require('../sandbox/checkpoint.manager');
    if (globalCheckpointManager.isGitRepo()) {
      checkpoints = (globalCheckpointManager.list() as any[]).slice(0, 15).map((c) => ({
        id: c.id, label: c.label, ts: c.timestamp, auto: !!c.auto,
      }));
    }
  } catch { /* checkpoints best-effort */ }

  let git: UiSnapshotGit | undefined;
  try {
    const { getGitStatus } = require('../cli/git');
    const s = getGitStatus(process.cwd());
    if (s) {
      git = {
        branch: s.branch,
        dirty: s.added.length + s.modified.length + s.deleted.length + s.unstaged.length,
        ahead: s.ahead,
        behind: s.behind,
      };
    }
  } catch { /* git best-effort */ }

  let composer: UiSnapshotComposer | undefined;
  try {
    const { getComposerCorpus } = require('../memory/corpus') as typeof import('../memory/corpus');
    const { getFactStore } = require('../memory/facts') as typeof import('../memory/facts');
    const corpus = getComposerCorpus();
    if (corpus) {
      // Synchronous by design: the snapshot is built on a debounce and must not await disk. The
      // manifest is already resident once anything has been ingested; before that the counts are
      // zero, which is the truth.
      const snap = corpus.snapshot();
      composer = {
        session: snap.session,
        library: snap.library,
        passages: snap.chunks,
        facts: getFactStore()?.count() ?? 0,
        lastIngest: snap.lastIngest ?? undefined,
      };
    }
  } catch { /* composer best-effort — a front-end without it simply shows no corpus chip */ }

  let tools: UiSnapshotTools | undefined;
  try {
    if (toolRegistry) {
      const names = toolRegistry.getToolNames();
      tools = {
        registered: names.length,
        ready: names.filter((name) => toolRegistry.isSent(name, contextMode)).length,
        deferred: names.filter((name) => toolRegistry.isDeferred(name) && !toolRegistry.isDiscovered(name)).length,
        discovered: names.filter((name) => toolRegistry.isDiscovered(name)).length,
        mcp: names.filter((name) => name.startsWith('mcp__')).length,
        graphReady: toolRegistry.isGraphReady(),
      };
    }
  } catch { /* registry posture best-effort */ }

  let tasks: UiSnapshotTask[] | undefined;
  try {
    const { getTaskRegistry } = require('../core/task.registry');
    const list = getTaskRegistry().list() as any[];
    if (list.length) {
      tasks = list.slice(0, 12).map((t) => ({
        id: t.id, kind: t.kind, title: t.title, state: t.state,
        elapsedMs: (t.endedAt || Date.now()) - (t.startedAt || t.createdAt),
        attention: !!t.attention, pinned: !!t.pinned,
        lastEvent: t.lastEvent, progress: t.progress,
        canPause: !!t.supports?.pause, canResume: !!t.supports?.resume, canCancel: !!t.supports?.cancel,
      }));
    }
  } catch { /* task registry best-effort */ }

  return { models, goalCount, mind, graph, contextWindow, tokensBaseline, compressionSaved, workspace, sessions, checkpoints, git, tools, tasks, composer };
}

/** Begin emitting `ui_snapshot` (immediately + on config/goal/graph changes). Call after the host attaches. */
export function startUiSnapshot(graphStore?: IGraphStore, toolRegistry?: ToolRegistry): void {
  // First snapshot is synchronous (the front-end needs footer state with the `ready` handshake);
  // afterwards a trailing 80ms debounce coalesces change bursts — a /beast step can fire
  // config+goals+graph+mind together, and each snapshot walks the whole graph summary.
  cliEvents.emit('ui_snapshot', buildUiSnapshot(graphStore, toolRegistry));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const emit = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      cliEvents.emit('ui_snapshot', buildUiSnapshot(graphStore, toolRegistry));
    }, 80);
    timer.unref?.();
  };
  cliEvents.on('config_changed', emit);
  cliEvents.on('goals_changed', emit);
  cliEvents.on('graph_changed', emit);
  // Context-token refresh (compression/compaction changed the estimate). Deliberately its own
  // event: it refreshes the footer meter WITHOUT the TUI printing "code graph updated".
  cliEvents.on('context_changed', emit);
  cliEvents.on('mcp_changed', emit);
  cliEvents.on('tools_changed', emit);
  // Mind layer: re-snapshot when self-model / drives / habits change so the footer's 🧠 strip
  // stays live.
  cliEvents.on('mind_changed', emit);
  // Workspace: repo registered / scoped / ignored → status-bar repo chip updates.
  cliEvents.on('workspace_changed', emit);
  // v2: checkpoint created / rewound → History strip updates; clear/resume → session list updates.
  cliEvents.on('timemachine_changed', emit);
  cliEvents.on('clear', emit);
  // Session recorder: thread created / titled / rotated / resumed → sidebar session list updates.
  cliEvents.on('session_changed', emit);
  // Task workspaces: create / transition / output activity → task panel updates.
  cliEvents.on('tasks_changed', emit);
  // Composer: a drop finished ingesting → the corpus chip updates without waiting for a config or
  // graph event that may never come during a document-only session.
  cliEvents.on('composer_changed', emit);
}
