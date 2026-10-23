/**
 * Per-task counters — the denominator this project has been claiming numbers without.
 *
 * The master refactor plan's headline success criterion is "at least 50% fewer model/tool turns on
 * forms and menus" (§24.2). The porting ledger then records that the turn-count gates "cannot
 * honestly be measured yet". Nothing between those two sentences counted turns per task, so every
 * later performance claim had no denominator. This module is that denominator.
 *
 * Deliberately narrow:
 *
 * - It COUNTS. It does not classify beyond what the tool trace actually proves. `surface` is derived
 *   from which tools ran, which is observable; the finer distinction a benchmark cares about
 *   ("form" vs "menu") is NOT derivable from a tool trace, so it is an optional `label` the fixture
 *   harness sets, never a guess made here. A fabricated classifier would put fake precision under
 *   the exact number the plan is trying to move.
 * - It holds no thresholds and asserts no budgets. `docs/RESEARCH_LEDGER.md` and two shipped
 *   regressions record what happens when a perf constant is written before it is measured: the test
 *   pins the wrong number and the system can no longer contradict it. Measure first; constants come
 *   later, from this data, in a separate change.
 * - It is additive and free when idle. `globalTelemetry` forwards to whichever task is live; with no
 *   live task the forward is a null check. Nothing in the loop changes behavior because of it.
 *
 * Disk is opt-in (`BIMAX_TASK_METRICS=1`), memory is always on — a session holds a handful of
 * numbers per task, and `/diagnostics` can then answer "how many turns did that take" without the
 * user having planned ahead to enable anything.
 */

import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';

/**
 * What the task actually touched, derived from the tools that ran. Honest by construction: every
 * value here is a statement about the recorded trace, not an inference about intent.
 */
export type TaskSurface =
  | 'computer'   // desktop control only
  | 'browser'    // browser control only
  | 'code'       // file reads/edits only
  | 'shell'      // shell only
  | 'mixed'      // more than one of the above
  | 'none';      // answered with no tools at all

export interface TaskRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  wallClockMs: number;
  /** Derived from the tool trace. See TaskSurface. */
  surface: TaskSurface;
  /**
   * Set by a benchmark fixture that knows what it is exercising ("form", "menu", "navigation").
   * Never inferred. Absent for organic sessions.
   */
  label?: string;
  /** Model round-trips. This is the number the ≥50% criterion is about. */
  turns: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  promptTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Which computer-use backend served this task, when one did. */
  computerBackend?: 'native' | 'compatibility';
  /** True when the user interrupted, so a short turn count is not read as efficiency. */
  interrupted: boolean;
}

const COMPUTER_TOOLS = new Set(['ComputerTool', 'NativeComputerTool', 'NativeComputerTransactionTool']);
const BROWSER_TOOLS = new Set(['BrowserTool']);
const CODE_TOOLS = new Set([
  'ReadFileTool', 'WriteFileTool', 'EditFileTool', 'MultiEditTool', 'SymbolEditTool',
  'GrepTool', 'GlobTool', 'DeleteTool', 'CreateDirectoryTool', 'NotebookEditTool',
]);
const SHELL_TOOLS = new Set(['BashTool']);

/** Native tool names are registered dynamically, so match the family rather than an exact list. */
function isComputerTool(name: string): boolean {
  return COMPUTER_TOOLS.has(name) || name.startsWith('NativeComputer');
}

function deriveSurface(byName: Record<string, number>): TaskSurface {
  const names = Object.keys(byName);
  if (names.length === 0) return 'none';
  const touched = new Set<TaskSurface>();
  for (const name of names) {
    if (isComputerTool(name)) touched.add('computer');
    else if (BROWSER_TOOLS.has(name)) touched.add('browser');
    else if (CODE_TOOLS.has(name)) touched.add('code');
    else if (SHELL_TOOLS.has(name)) touched.add('shell');
  }
  if (touched.size === 0) return 'none';
  if (touched.size > 1) return 'mixed';
  return [...touched][0];
}

class LiveTask {
  readonly id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  readonly startedAtMs = Date.now();
  readonly startedAt = new Date().toISOString();
  turns = 0;
  toolCalls = 0;
  readonly toolCallsByName: Record<string, number> = {};
  promptTokens = 0;
  cacheReadTokens = 0;
  cacheCreationTokens = 0;
  label?: string;
  computerBackend?: 'native' | 'compatibility';
  interrupted = false;
}

/** Cap so a very long session cannot grow this unboundedly; the JSONL file keeps the full record. */
const MAX_RETAINED_RUNS = 200;

class TaskMetricsStore {
  private live: LiveTask | null = null;
  private runs: TaskRun[] = [];
  private warnedOnWriteFailure = false;

  /**
   * Begin a task. A nested call (a sub-agent running inside a task) is deliberately ignored rather
   * than replacing the outer task: the outer turn count is the one the criterion is about, and
   * silently rebinding it would under-count the parent.
   */
  begin(label?: string): void {
    if (this.live) return;
    this.live = new LiveTask();
    if (label) this.live.label = label;
  }

  /** True when a task is in flight — lets callers skip work entirely when nothing is recording. */
  get isRecording(): boolean {
    return this.live !== null;
  }

  recordTurn(): void {
    if (this.live) this.live.turns++;
  }

  recordToolCall(toolName: string): void {
    if (!this.live) return;
    this.live.toolCalls++;
    this.live.toolCallsByName[toolName] = (this.live.toolCallsByName[toolName] || 0) + 1;

    // Attribute the backend from the tool that actually ran, rather than asking the computer
    // runtime to report it. The native tools are only ever registered when `assessNativeCutover`
    // has already cleared the route, so their presence in the trace IS the evidence — and deriving
    // it here means no computer-use file needs an instrumentation edit.
    if (!this.live.computerBackend) {
      if (toolName.startsWith('NativeComputer')) this.live.computerBackend = 'native';
      else if (toolName === 'ComputerTool') this.live.computerBackend = 'compatibility';
    }
  }

  recordUsage(promptTokens: number, cacheRead: number, cacheCreation: number): void {
    if (!this.live) return;
    this.live.promptTokens += promptTokens;
    this.live.cacheReadTokens += cacheRead;
    this.live.cacheCreationTokens += cacheCreation;
  }

  /**
   * Override the derived backend. `recordToolCall` already infers it from the tool family, which
   * is correct today; this exists for the case where the runtime knows something the tool name
   * does not (a shadow run, say) and should not require a rewrite to express it.
   */
  recordComputerBackend(backend: 'native' | 'compatibility'): void {
    if (this.live) this.live.computerBackend = backend;
  }

  markInterrupted(): void {
    if (this.live) this.live.interrupted = true;
  }

  /** Set or correct the fixture label mid-task. No-op with no live task. */
  setLabel(label: string): void {
    if (this.live) this.live.label = label;
  }

  /** End the live task and retain it. Safe to call when nothing is live. */
  end(): TaskRun | undefined {
    const live = this.live;
    if (!live) return undefined;
    this.live = null;

    const run: TaskRun = {
      id: live.id,
      startedAt: live.startedAt,
      finishedAt: new Date().toISOString(),
      wallClockMs: Date.now() - live.startedAtMs,
      surface: deriveSurface(live.toolCallsByName),
      ...(live.label ? { label: live.label } : {}),
      turns: live.turns,
      toolCalls: live.toolCalls,
      toolCallsByName: { ...live.toolCallsByName },
      promptTokens: live.promptTokens,
      cacheReadTokens: live.cacheReadTokens,
      cacheCreationTokens: live.cacheCreationTokens,
      ...(live.computerBackend ? { computerBackend: live.computerBackend } : {}),
      interrupted: live.interrupted,
    };

    this.runs.push(run);
    if (this.runs.length > MAX_RETAINED_RUNS) this.runs.shift();
    this.appendToDisk(run);
    return run;
  }

  getRuns(): TaskRun[] {
    return [...this.runs];
  }

  /**
   * Turn/tool/token medians per surface. Medians rather than means because one interrupted or
   * pathological task should not move the number the criterion is judged on.
   */
  summarize(): Array<{
    surface: TaskSurface;
    label?: string;
    tasks: number;
    medianTurns: number;
    medianToolCalls: number;
    medianPromptTokens: number;
  }> {
    const groups = new Map<string, TaskRun[]>();
    for (const run of this.runs) {
      // Interrupted tasks are excluded: a task the user stopped early has an artificially low turn
      // count and would flatter any comparison it landed in.
      if (run.interrupted) continue;
      const key = `${run.surface}\u0000${run.label || ''}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(run); else groups.set(key, [run]);
    }

    const median = (values: number[]): number => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : sorted[mid];
    };

    return [...groups.entries()].map(([key, group]) => {
      const [surface, label] = key.split('\u0000');
      return {
        surface: surface as TaskSurface,
        ...(label ? { label } : {}),
        tasks: group.length,
        medianTurns: median(group.map(r => r.turns)),
        medianToolCalls: median(group.map(r => r.toolCalls)),
        medianPromptTokens: median(group.map(r => r.promptTokens)),
      };
    }).sort((a, b) => b.tasks - a.tasks);
  }

  reset(): void {
    this.live = null;
    this.runs = [];
  }

  /**
   * Append one JSON line. Opt-in, best-effort, and never allowed to fail a task: a metrics write
   * that throws into the agent loop would be a self-inflicted outage in the name of measurement.
   */
  private appendToDisk(run: TaskRun): void {
    if (process.env.BIMAX_TASK_METRICS !== '1') return;
    try {
      const dir = process.env.BIMAX_TASK_METRICS_DIR
        || path.join(stateDir('.breakglass'), 'metrics');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'task-runs.jsonl'), JSON.stringify(run) + '\n');
    } catch (e: any) {
      // Warn once. A user who opted into metrics deserves to know the file is not being written,
      // but a broken path must not produce one warning per task for the rest of the session.
      if (!this.warnedOnWriteFailure) {
        this.warnedOnWriteFailure = true;
        Logger.warn(`[TaskMetrics] disk append disabled for this session: ${e?.message}`);
      }
    }
  }
}

export const taskMetrics = new TaskMetricsStore();
