import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';

// ─── BiMax Execution Ledger ─────────────────────────────────────────────────────────────────────
// A durable, structured, append-only record of meaningful task execution — the foundation under
// task workspaces (restoration after restart), crash recovery, failure-memory context, and honest
// resumability. Design informed by researched systems (docs/RESEARCH_LEDGER.md):
//   • Temporal's event history: an append-only log of typed events is the single source of truth;
//     progress is reconstructed by folding the log, never by trusting in-memory state.
//   • OpenHands' event stream: every state change is a typed event on one chronological log,
//     which makes recovery and inspection possible by construction.
//   • Zellij's session resurrection: serialize what is needed to RE-CREATE work (the command, the
//     cwd, the title) — never pretend a dead process is still alive.
// Deliberately NOT an uncontrolled event dump: only task lifecycle records land here (creation,
// transitions, checkpoints, retries, terminal results) — never stream tokens, never raw tool
// output beyond a bounded, redacted tail.

export const LEDGER_SCHEMA_VERSION = 1;

/** Task lifecycle states (docs/TASK_WORKSPACES.md §states — the full required set). */
export type TaskState =
  | 'queued' | 'starting' | 'running' | 'streaming'
  | 'waiting-model' | 'waiting-tool' | 'waiting-browser' | 'waiting-user'
  | 'retrying' | 'recovering' | 'paused' | 'cancelling'
  | 'cancelled' | 'completed' | 'failed' | 'failed-resumable';

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(['cancelled', 'completed', 'failed', 'failed-resumable']);

export interface LedgerRecord {
  v: number;            // schema version — readers skip records with v > LEDGER_SCHEMA_VERSION
  ts: number;           // epoch ms
  taskId: string;
  type: 'created' | 'transition' | 'checkpoint' | 'retry' | 'note';
  // created:
  kind?: string;        // 'shell' | 'browser' | 'subagent' | 'build' | 'test' | 'generic'
  title?: string;
  command?: string;     // what re-running the task means (shell); redacted
  cwd?: string;
  model?: string;
  sessionId?: string;
  // transition:
  state?: TaskState;
  reason?: string;
  // checkpoint / retry / note:
  data?: Record<string, unknown>;
  attempt?: number;
  fingerprint?: string; // failure-memory fingerprint associated with a retry
}

/** A task as reconstructed by folding the journal — last known state + how to resume. */
export interface ReconstructedTask {
  taskId: string;
  kind: string;
  title: string;
  command?: string;
  cwd?: string;
  model?: string;
  sessionId?: string;
  state: TaskState;
  createdAt: number;
  updatedAt: number;
  retries: number;
  lastCheckpoint?: Record<string, unknown>;
  failureReason?: string;
  /** True when the ledger holds enough to re-create the work (command + cwd for shell tasks). */
  resumable: boolean;
}

const MAX_FILE_BYTES = 512 * 1024;   // bounded retention: compact past this
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const KEEP_RECENT_RECORDS = 400;
const MAX_STRING = 2048;             // large-output exclusion: no field stores more than this

const SENSITIVE_KEY = /key|token|secret|password|authorization|credential|cookie/i;
// Credential-shaped values get redacted even under innocent key names — including when they are
// EMBEDDED inside a longer string (a shell command carrying `-H "auth: nvapi-…"` must not leak).
const SENSITIVE_VALUE = /(nvapi-|sk-|ghp_|gho_|xox[bap]-|AKIA)[\w-]{8,}/g;

/** Redact sensitive fields and bound string sizes — applied to every record before append. */
export function redactForLedger<T>(value: T, depth = 0): T {
  if (depth > 6) return undefined as unknown as T;
  if (typeof value === 'string') {
    const s = value.replace(SENSITIVE_VALUE, '[redacted]');
    return (s.length > MAX_STRING ? s.slice(0, MAX_STRING) + '…[truncated]' : s) as unknown as T;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redactForLedger(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactForLedger(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

export class ExecutionLedger {
  private file: string;

  constructor(dir?: string) {
    const base = dir || process.env.BIMAX_EXECUTION_DIR || path.join(stateDir('.bimax'), 'execution');
    this.file = path.join(base, 'ledger.ndjson');
  }

  get filePath(): string { return this.file; }

  append(record: Omit<LedgerRecord, 'v' | 'ts'>): void {
    const full: LedgerRecord = { v: LEDGER_SCHEMA_VERSION, ts: Date.now(), ...redactForLedger(record) };
    try {
      require('./fault.injection').faultPoint('ledger.append');
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(full) + '\n', 'utf-8');
    } catch { /* the ledger is an observer — it must never break execution */ }
    this.maybeCompact();
  }

  /** Read every valid record. Corrupt lines are skipped; a wholly unreadable file is preserved
   *  aside (`.corrupt-<ts>`) and treated as empty — corruption can cost history, never a crash. */
  readAll(): LedgerRecord[] {
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf-8'); } catch { return []; }
    const records: LedgerRecord[] = [];
    let bad = 0, total = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      total++;
      try {
        const r = JSON.parse(line);
        if (typeof r !== 'object' || r === null) { bad++; continue; }
        // Forward compatibility: a newer BiMax may write records this build can't interpret.
        if (typeof r.v === 'number' && r.v > LEDGER_SCHEMA_VERSION) continue;
        if (typeof r.taskId !== 'string' || typeof r.type !== 'string') { bad++; continue; }
        records.push(r as LedgerRecord);
      } catch { bad++; }
    }
    if (total > 0 && bad === total) {
      // Nothing parseable at all — preserve the evidence and start fresh.
      try { fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`); fs.unlinkSync(this.file); } catch { /* best-effort */ }
    }
    return records;
  }

  /** Fold the journal into per-task last-known state (Temporal-style reconstruction). */
  reconstruct(): ReconstructedTask[] {
    const tasks = new Map<string, ReconstructedTask>();
    for (const r of this.readAll()) {
      let t = tasks.get(r.taskId);
      if (r.type === 'created') {
        t = {
          taskId: r.taskId, kind: r.kind || 'generic', title: r.title || r.taskId,
          command: r.command, cwd: r.cwd, model: r.model, sessionId: r.sessionId,
          state: 'queued', createdAt: r.ts, updatedAt: r.ts, retries: 0,
          resumable: false,
        };
        tasks.set(r.taskId, t);
        continue;
      }
      if (!t) continue; // transition for a task whose creation was compacted away — ignore
      t.updatedAt = r.ts;
      if (r.type === 'transition' && r.state) {
        t.state = r.state;
        if (r.state === 'failed' || r.state === 'failed-resumable') t.failureReason = r.reason;
      } else if (r.type === 'checkpoint') {
        t.lastCheckpoint = r.data;
      } else if (r.type === 'retry') {
        t.retries = r.attempt ?? t.retries + 1;
      }
    }
    for (const t of tasks.values()) {
      // Honest resumability: resumable means "the ledger holds what re-creating the work needs",
      // currently a command + cwd for shell-kind tasks. Never claim a dead process can continue.
      t.resumable = !!(t.command && t.cwd);
    }
    return [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Tasks that were still live when the previous process died — crash-recovery candidates. */
  interruptedTasks(): ReconstructedTask[] {
    return this.reconstruct().filter(t => !TERMINAL_STATES.has(t.state));
  }

  /** User-controlled cleanup: drop terminal tasks, keep live/interrupted ones. */
  clearCompleted(): number {
    const all = this.readAll();
    const keepIds = new Set(this.interruptedTasks().map(t => t.taskId));
    const kept = all.filter(r => keepIds.has(r.taskId));
    this.rewrite(kept);
    return all.length - kept.length;
  }

  /** Wipe entirely (tests + explicit user request). */
  clearAll(): void {
    try { fs.unlinkSync(this.file); } catch { /* already gone */ }
  }

  // Bounded retention: when the file outgrows its budget, keep records of non-terminal tasks
  // plus the most recent KEEP_RECENT_RECORDS, drop everything older than MAX_AGE_MS.
  private maybeCompact(): void {
    try {
      const st = fs.statSync(this.file);
      if (st.size < MAX_FILE_BYTES) return;
    } catch { return; }
    const all = this.readAll();
    const liveIds = new Set(this.interruptedTasks().map(t => t.taskId));
    const cutoff = Date.now() - MAX_AGE_MS;
    const kept = all.filter((r, i) =>
      liveIds.has(r.taskId) || (r.ts >= cutoff && i >= all.length - KEEP_RECENT_RECORDS));
    this.rewrite(kept);
  }

  // Atomic rewrite (tmp + rename) — a crash mid-compaction can't lose the journal.
  private rewrite(records: LedgerRecord[]): void {
    try {
      require('./fault.injection').faultPoint('ledger.rewrite');
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf-8');
      fs.renameSync(tmp, this.file);
    } catch { /* best-effort — the un-compacted file remains valid */ }
  }
}

let singleton: ExecutionLedger | null = null;
export function getExecutionLedger(): ExecutionLedger {
  if (!singleton) singleton = new ExecutionLedger();
  return singleton;
}
export function __resetExecutionLedgerForTests(dir?: string): ExecutionLedger {
  singleton = dir ? new ExecutionLedger(dir) : null as any;
  return singleton || getExecutionLedger();
}
