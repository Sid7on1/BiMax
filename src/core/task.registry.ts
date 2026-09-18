import { engineEvents } from '../engine/events';
import { getExecutionLedger, TaskState, TERMINAL_STATES } from './execution.ledger';

// ─── Task registry: the live half of task workspaces ────────────────────────────────────────────
// The execution ledger is the durable record; this registry is the in-memory truth for tasks in
// THIS process — long shell commands, browser sessions, builds — with a validated state machine,
// honest capability flags (pause/resume only where the underlying process supports it — a shell
// child takes SIGSTOP/SIGCONT; a model stream does not), bounded output storage, and actions
// (cancel/pause/resume/pin/close). Every transition is appended to the ledger, which is what makes
// tasks reconstructible after a crash. Model: docs/TASK_WORKSPACES.md (panels + chips — the
// conversation stays primary; tasks get a focusable panel, not stolen tabs).

export type TaskKind = 'shell' | 'browser' | 'subagent' | 'build' | 'test' | 'generic';

export interface TaskCapabilities {
  cancel: boolean;
  pause: boolean;   // true ONLY when a real suspend exists (SIGSTOP) — never faked
  resume: boolean;
}

export interface TaskHandle {
  /** Kill/abort the underlying work. Must be idempotent. */
  cancel?: () => void;
  /** Real suspension (e.g. SIGSTOP). Only set when genuinely supported. */
  pause?: () => void;
  resume?: () => void;
}

export interface WorkspaceTask {
  id: string;
  kind: TaskKind;
  title: string;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  model?: string;
  activeTool?: string;
  lastEvent?: string;      // last meaningful event, human-readable, short
  progress?: number;       // 0..1 where measurable; undefined otherwise
  attention: boolean;      // needs the user's eyes (failed, waiting-user, finished long task)
  retries: number;
  pinned: boolean;
  command?: string;        // shell tasks: what re-running means
  cwd?: string;
  exitCode?: number;
  failure?: string;        // short failure summary
  supports: TaskCapabilities;
}

// Legal state transitions. Anything not listed is a programming error — surfaced loudly in tests,
// tolerated (ignored + logged) at runtime so a bad caller can't wedge the registry.
const LEGAL: Record<TaskState, TaskState[]> = {
  'queued':           ['starting', 'cancelled'],
  'starting':         ['running', 'streaming', 'waiting-model', 'waiting-tool', 'waiting-browser', 'failed', 'failed-resumable', 'cancelling', 'cancelled'],
  'running':          ['streaming', 'waiting-model', 'waiting-tool', 'waiting-browser', 'waiting-user', 'retrying', 'recovering', 'paused', 'cancelling', 'completed', 'failed', 'failed-resumable'],
  'streaming':        ['running', 'waiting-model', 'waiting-tool', 'completed', 'failed', 'failed-resumable', 'cancelling'],
  'waiting-model':    ['running', 'streaming', 'retrying', 'cancelling', 'failed', 'failed-resumable'],
  'waiting-tool':     ['running', 'retrying', 'cancelling', 'failed', 'failed-resumable'],
  'waiting-browser':  ['running', 'recovering', 'retrying', 'cancelling', 'failed', 'failed-resumable'],
  'waiting-user':     ['running', 'cancelling', 'cancelled'],
  'retrying':         ['running', 'starting', 'failed', 'failed-resumable', 'cancelling'],
  'recovering':       ['running', 'starting', 'failed', 'failed-resumable', 'cancelling'],
  'paused':           ['running', 'cancelling', 'cancelled'],
  'cancelling':       ['cancelled', 'failed'],
  'cancelled':        [],
  'completed':        [],
  'failed':           [],
  'failed-resumable': ['retrying', 'starting'],
};

let seq = 0;

export class TaskRegistry {
  private tasks = new Map<string, WorkspaceTask>();
  private handles = new Map<string, TaskHandle>();
  private outputs = new Map<string, string[]>(); // bounded ring buffers (OUTPUT_MAX_LINES)

  static readonly OUTPUT_MAX_LINES = 400;

  create(opts: {
    kind: TaskKind; title: string; command?: string; cwd?: string; model?: string;
    handle?: TaskHandle; supports?: Partial<TaskCapabilities>;
  }): WorkspaceTask {
    const id = `tk-${Date.now().toString(36)}-${++seq}`;
    const task: WorkspaceTask = {
      id, kind: opts.kind, title: opts.title.slice(0, 80), state: 'queued',
      createdAt: Date.now(), retries: 0, attention: false, pinned: false,
      command: opts.command, cwd: opts.cwd, model: opts.model,
      supports: {
        cancel: opts.supports?.cancel ?? !!opts.handle?.cancel,
        pause: opts.supports?.pause ?? !!opts.handle?.pause,
        resume: opts.supports?.resume ?? !!opts.handle?.resume,
      },
    };
    this.tasks.set(id, task);
    if (opts.handle) this.handles.set(id, opts.handle);
    getExecutionLedger().append({
      taskId: id, type: 'created', kind: opts.kind, title: task.title,
      command: opts.command, cwd: opts.cwd, model: opts.model,
    });
    this.changed();
    return task;
  }

  get(id: string): WorkspaceTask | undefined { return this.tasks.get(id); }
  /** Match a task by id or unambiguous prefix (CLI ergonomics). */
  find(idOrPrefix: string): WorkspaceTask | undefined {
    if (this.tasks.has(idOrPrefix)) return this.tasks.get(idOrPrefix);
    const matches = [...this.tasks.values()].filter(t => t.id.startsWith(idOrPrefix));
    return matches.length === 1 ? matches[0] : undefined;
  }
  list(): WorkspaceTask[] {
    return [...this.tasks.values()].sort((a, b) =>
      Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt);
  }
  live(): WorkspaceTask[] { return this.list().filter(t => !TERMINAL_STATES.has(t.state)); }

  transition(id: string, to: TaskState, reason?: string): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (!LEGAL[t.state]?.includes(to)) {
      console.warn(`[Tasks] illegal transition ${t.state} → ${to} for ${id} (ignored)`);
      return false;
    }
    t.state = to;
    if (to === 'running' && !t.startedAt) t.startedAt = Date.now();
    if (TERMINAL_STATES.has(to)) {
      t.endedAt = Date.now();
      this.handles.delete(id); // the underlying work is gone; never hold a dead handle
    }
    if (to === 'failed' || to === 'failed-resumable') { t.failure = reason?.slice(0, 200); t.attention = true; }
    if (to === 'waiting-user') t.attention = true;
    if (to === 'completed') t.attention = (Date.now() - t.createdAt) > 30_000; // long tasks announce completion
    if (reason) t.lastEvent = reason.slice(0, 120);
    getExecutionLedger().append({ taskId: id, type: 'transition', state: to, reason });
    this.changed();
    return true;
  }

  /** Record activity without a state change (active tool, progress, last event). */
  touch(id: string, patch: { activeTool?: string; lastEvent?: string; progress?: number; model?: string }): void {
    const t = this.tasks.get(id);
    if (!t) return;
    if (patch.activeTool !== undefined) t.activeTool = patch.activeTool;
    if (patch.lastEvent !== undefined) t.lastEvent = patch.lastEvent.slice(0, 120);
    if (patch.progress !== undefined) t.progress = Math.max(0, Math.min(1, patch.progress));
    if (patch.model !== undefined) t.model = patch.model;
    this.changed();
  }

  checkpoint(id: string, data: Record<string, unknown>): void {
    getExecutionLedger().append({ taskId: id, type: 'checkpoint', data });
  }

  retry(id: string, fingerprint?: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    t.retries++;
    getExecutionLedger().append({ taskId: id, type: 'retry', attempt: t.retries, fingerprint });
    this.changed();
  }

  appendOutput(id: string, chunk: string): void {
    let buf = this.outputs.get(id);
    if (!buf) { buf = []; this.outputs.set(id, buf); }
    for (const line of chunk.split('\n')) {
      buf.push(line.length > 500 ? line.slice(0, 500) + '…' : line);
    }
    // Bounded storage: keep the newest OUTPUT_MAX_LINES lines (virtualized tail, not the world).
    if (buf.length > TaskRegistry.OUTPUT_MAX_LINES) buf.splice(0, buf.length - TaskRegistry.OUTPUT_MAX_LINES);
  }
  output(id: string, lastN = 40): string {
    const buf = this.outputs.get(id) || [];
    return buf.slice(-lastN).join('\n');
  }

  // ── Actions — each returns a short human-readable result (surfaced by /tasks) ──
  cancel(id: string): string {
    const t = this.find(id);
    if (!t) return `No task ${id}.`;
    if (TERMINAL_STATES.has(t.state)) return `${t.title} already ${t.state}.`;
    if (!this.transition(t.id, 'cancelling', 'cancel requested')) return `Cannot cancel from ${t.state}.`;
    try { this.handles.get(t.id)?.cancel?.(); } catch { /* dying anyway */ }
    return `Cancelling ${t.title}.`;
  }

  pause(id: string): string {
    const t = this.find(id);
    if (!t) return `No task ${id}.`;
    // HONEST pause: refuse (with the reason) for work that cannot actually suspend.
    if (!t.supports.pause) return `${t.title} can't pause — ${t.kind === 'shell' ? 'its process handle is gone' : `a ${t.kind} task has no real suspend`}. Cancel is available.`;
    if (t.state !== 'running' && t.state !== 'streaming') return `Can only pause a running task (currently ${t.state}).`;
    try { this.handles.get(t.id)?.pause?.(); } catch (e: any) { return `Pause failed: ${e?.message}`; }
    this.transition(t.id, 'paused', 'paused (SIGSTOP)');
    return `Paused ${t.title} (real suspend — resume with /tasks resume ${t.id}).`;
  }

  resume(id: string): string {
    const t = this.find(id);
    if (!t) return `No task ${id}.`;
    if (t.state !== 'paused') return `${t.title} is ${t.state}, not paused.`;
    try { this.handles.get(t.id)?.resume?.(); } catch (e: any) { return `Resume failed: ${e?.message}`; }
    this.transition(t.id, 'running', 'resumed (SIGCONT)');
    return `Resumed ${t.title}.`;
  }

  pin(id: string): string {
    const t = this.find(id);
    if (!t) return `No task ${id}.`;
    t.pinned = !t.pinned;
    this.changed();
    return `${t.pinned ? 'Pinned' : 'Unpinned'} ${t.title}.`;
  }

  /** Close (remove from the strip) — terminal tasks only; live work must be cancelled first. */
  close(id: string): string {
    const t = this.find(id);
    if (!t) return `No task ${id}.`;
    if (!TERMINAL_STATES.has(t.state)) return `${t.title} is still ${t.state} — cancel it first.`;
    this.tasks.delete(t.id);
    this.outputs.delete(t.id);
    this.changed();
    return `Closed ${t.title}.`;
  }

  /** Clear attention (the user looked at it). */
  seen(id: string): void {
    const t = this.tasks.get(id);
    if (t) { t.attention = false; this.changed(); }
  }

  private changed(): void {
    try { engineEvents.emit('tasks_changed'); } catch { /* wiring optional in tests */ }
  }
}

let registry: TaskRegistry | null = null;
export function getTaskRegistry(): TaskRegistry {
  if (!registry) registry = new TaskRegistry();
  return registry;
}
export function __resetTaskRegistryForTests(): TaskRegistry {
  registry = new TaskRegistry();
  return registry;
}
