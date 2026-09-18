import * as fs from 'fs';
import * as path from 'path';
import { engineEvents, ToolCallEntry } from '../engine/events';
import { sessionDir } from '../engine/session';
import { getSessionRecorder } from '../engine/session.recorder';
import {
  ReviewFacts, ReviewApprovalKind, emptyFacts, toSnapshot, readsAsApproved, pendingApprovals,
} from './review.model';
import { CLAIMING_TOOLS } from '../core/agent.loop';
import { commandPathTokens } from '../mind/epistemic.ledger';

/**
 * The review recorder — the single producer of per-thread review state, shaped exactly like the
 * SessionRecorder it rides alongside: it listens on engineEvents at the engine's points of truth,
 * folds them into a ReviewFacts file at `<project>/.breakglass/sessions/<id>.review.json`, and
 * publishes the derived snapshot over the wire as a debounced `review_update` event (a full
 * snapshot, so a front-end that reconnects after missing events is correct on the next emit).
 *
 * Sources (all already flowing, or emitted one line from where truth is computed):
 *   request_pending / request_resolved  ← ProtocolHost — every approval round-trip, with real ids;
 *                                         late/duplicate replies never produce a second resolution
 *                                         because the host drops them before we ever hear of them.
 *   review_change                       ← agent.loop, beside the epistemic claim (attributed file).
 *   review_evidence                     ← agent.loop, beside ledger settlement (real exit codes).
 *   timemachine_changed / checkpoint_failed ← the Time Machine commands.
 *   todo_update                         ← the live plan.
 *   tool_call / tool_call_result        ← transient "applying" liveness (never persisted).
 *   session_changed                     ← thread lifecycle: rotate closes the facts file (pending
 *                                         approvals marked interrupted), resume loads the thread's
 *                                         own facts — approvals that were pending when a previous
 *                                         process died load as interrupted, never falsely pending.
 */

const APPROVAL_CAP = 50;
const VERIFICATION_CAP = 50;
const CHECKPOINT_CAP = 20;

function reviewPath(id: string): string {
  return path.join(sessionDir(), `${id}.review.json`);
}

export class ReviewManager {
  private facts: ReviewFacts = emptyFacts('');
  // Wire request-id → approval index guard: ids restart at 1 in every process, so only ids issued
  // by THIS process may resolve entries recorded by this process.
  private liveRequestIds = new Set<number>();
  private runningMutations = new Set<string>(); // tool_call ids of in-flight mutating tools
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  // --- thread lifecycle -------------------------------------------------------------------

  /** Reconcile with the SessionRecorder's current thread (driven by 'session_changed'). */
  syncSession(): void {
    const id = getSessionRecorder()?.currentId() ?? '';
    if (id === this.facts.sessionId) return;
    if (this.facts.sessionId) this.close(); // rotate/switch away: seal the old thread's facts
    if (id) {
      const loaded = this.loadFacts(id);
      if (loaded) {
        this.facts = loaded;
        this.markDanglingInterrupted('restored'); // a previous process may have died mid-approval
      } else {
        // Fresh thread adopts anything recorded before the session id existed (rare boot facts).
        this.facts.sessionId = id;
      }
    } else {
      this.facts = emptyFacts('');
    }
    this.touch();
  }

  /** Seal the current thread: pending approvals can never be answered once we leave it. */
  private close(): void {
    this.markDanglingInterrupted('rotated');
    this.saveNow();
    this.facts = emptyFacts('');
  }

  private markDanglingInterrupted(_why: 'restored' | 'rotated'): void {
    const pending = pendingApprovals(this.facts);
    if (pending.length === 0) return;
    const at = Date.now();
    for (const a of pending) a.resolution = { value: '', approved: false, at, interrupted: true };
    this.facts.interrupted = true;
  }

  // --- fact intake ------------------------------------------------------------------------

  onRequestPending(req: { id: number; kind: string; question: string; isAsk?: boolean }): void {
    if (!req || req.kind === 'input') return; // free-form input prompts (API keys…) are not review
    const kind: ReviewApprovalKind = req.kind === 'diff' ? 'diff' : req.isAsk ? 'question' : 'permission';
    this.liveRequestIds.add(req.id);
    this.facts.approvals.push({ id: req.id, kind, question: String(req.question || ''), requestedAt: Date.now() });
    if (this.facts.approvals.length > APPROVAL_CAP) this.facts.approvals.splice(0, this.facts.approvals.length - APPROVAL_CAP);
    this.touch();
  }

  onRequestResolved(res: { id: number; value: string; interrupted?: boolean }): void {
    if (!res || !this.liveRequestIds.has(res.id)) return; // late/foreign id — never resurrect
    this.liveRequestIds.delete(res.id);
    const a = [...this.facts.approvals].reverse().find(x => x.id === res.id && !x.resolution);
    if (!a) return;
    a.resolution = {
      value: String(res.value ?? ''),
      approved: !res.interrupted && readsAsApproved(a.kind, String(res.value ?? '')),
      at: Date.now(),
      ...(res.interrupted ? { interrupted: true } : {}),
    };
    this.touch();
  }

  onChange(c: { tool: string; file?: string; callId?: string }): void {
    if (!c || !c.tool) return;
    const file = c.file || '(unattributed)';
    const now = Date.now();
    const existing = this.facts.changes.find(x => x.file === file);
    if (existing) {
      existing.edits++;
      existing.lastAt = now;
      existing.lastCallId = c.callId ?? existing.lastCallId;
      if (!existing.tools.includes(c.tool)) existing.tools.push(c.tool);
    } else {
      this.facts.changes.push({ file, tools: [c.tool], edits: 1, lastCallId: c.callId, lastAt: now });
    }
    this.touch();
  }

  onEvidence(e: { command: string; ok: boolean; settled: number; coveredFiles?: string[]; repoWide?: boolean }): void {
    if (!e || !e.command) return;
    this.facts.verifications.push({
      command: String(e.command).slice(0, 200), ok: !!e.ok, settled: Number(e.settled) || 0, at: Date.now(),
      coveredFiles: Array.isArray(e.coveredFiles) ? [...new Set(e.coveredFiles.map(String))] : [],
      repoWide: e.repoWide === true || (e.repoWide === undefined && !!e.ok && commandPathTokens(e.command).length === 0),
    });
    if (this.facts.verifications.length > VERIFICATION_CAP) {
      this.facts.verifications.splice(0, this.facts.verifications.length - VERIFICATION_CAP);
    }
    this.touch();
  }

  onCheckpointChanged(): void {
    try {
      const { globalCheckpointManager } = require('../sandbox/checkpoint.manager');
      const latest = globalCheckpointManager.list()[0];
      if (!latest) return;
      if (this.facts.checkpoints.some(c => c.id === latest.id)) return;
      this.facts.checkpoints.push({ id: latest.id, label: latest.label, ts: latest.timestamp, auto: !!latest.auto, ok: true });
      if (this.facts.checkpoints.length > CHECKPOINT_CAP) {
        this.facts.checkpoints.splice(0, this.facts.checkpoints.length - CHECKPOINT_CAP);
      }
      this.touch();
    } catch { /* checkpoint manager optional (non-git projects) */ }
  }

  onCheckpointFailed(label: string): void {
    this.facts.checkpoints.push({ id: '', label: String(label || 'checkpoint'), ts: Date.now(), auto: false, ok: false });
    if (this.facts.checkpoints.length > CHECKPOINT_CAP) {
      this.facts.checkpoints.splice(0, this.facts.checkpoints.length - CHECKPOINT_CAP);
    }
    this.touch();
  }

  onTodos(todos: unknown): void {
    this.facts.todos = Array.isArray(todos)
      ? todos.map((t: any) => ({ content: String(t?.content ?? ''), status: String(t?.status ?? 'pending') })).slice(0, 50)
      : [];
    this.touch();
  }

  onToolCall(call: ToolCallEntry): void {
    if (!call?.id || !CLAIMING_TOOLS.has(call.toolName)) return;
    if (call.status === 'running') this.runningMutations.add(call.id);
    else this.runningMutations.delete(call.id);
    this.scheduleEmit();
  }

  onToolResult(call: ToolCallEntry): void {
    if (!call?.id) return;
    if (this.runningMutations.delete(call.id)) this.scheduleEmit();
  }

  // --- publication & persistence ------------------------------------------------------------

  snapshot() {
    return toSnapshot(this.facts, { applying: this.runningMutations.size > 0 });
  }

  private touch(): void {
    this.facts.updatedAt = Date.now();
    this.scheduleEmit();
    this.scheduleSave();
  }

  private scheduleEmit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      engineEvents.emit('review_update', this.snapshot());
    }, 80);
    this.emitTimer.unref?.();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 400);
    this.saveTimer.unref?.();
  }

  saveNow(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.facts.sessionId) return; // nothing durable to attach the facts to yet
    try {
      fs.mkdirSync(sessionDir(), { recursive: true });
      fs.writeFileSync(reviewPath(this.facts.sessionId), JSON.stringify(this.facts, null, 2), 'utf8');
    } catch { /* persistence is best-effort — never break the live turn */ }
  }

  private loadFacts(id: string): ReviewFacts | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(reviewPath(id), 'utf8'));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.approvals)) return null;
      return {
        version: 1,
        sessionId: id,
        approvals: parsed.approvals,
        changes: Array.isArray(parsed.changes) ? parsed.changes : [],
        verifications: Array.isArray(parsed.verifications) ? parsed.verifications.map((v: any) => ({
          ...v,
          coveredFiles: Array.isArray(v.coveredFiles) ? v.coveredFiles.map(String) : [],
          repoWide: v.repoWide === true || (v.repoWide === undefined && !!v.ok && commandPathTokens(String(v.command || '')).length === 0),
        })) : [],
        checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
        todos: Array.isArray(parsed.todos) ? parsed.todos : [],
        interrupted: !!parsed.interrupted,
        updatedAt: Number(parsed.updatedAt) || Date.now(),
      };
    } catch {
      return null; // pre-review thread / unreadable file → fresh facts, never an error
    }
  }

  /** Engine shutdown — pending approvals died with the process; say so on disk. */
  shutdown(): void {
    this.markDanglingInterrupted('rotated');
    this.saveNow();
  }
}

let manager: ReviewManager | null = null;

/** Attach the review recorder to engineEvents (idempotent). Called once from the headless entry. */
export function startReviewManager(): ReviewManager {
  if (manager) return manager;
  manager = new ReviewManager();
  engineEvents.on('request_pending', (r: any) => manager?.onRequestPending(r));
  engineEvents.on('request_resolved', (r: any) => manager?.onRequestResolved(r));
  engineEvents.on('review_change', (c: any) => manager?.onChange(c));
  engineEvents.on('review_evidence', (e: any) => manager?.onEvidence(e));
  engineEvents.on('timemachine_changed', () => manager?.onCheckpointChanged());
  engineEvents.on('checkpoint_failed', (label: any) => manager?.onCheckpointFailed(String(label ?? '')));
  engineEvents.on('todo_update', (todos: any) => manager?.onTodos(todos));
  engineEvents.on('tool_call', (c: any) => manager?.onToolCall(c));
  engineEvents.on('tool_call_result', (c: any) => manager?.onToolResult(c));
  engineEvents.on('session_changed', () => manager?.syncSession());
  engineEvents.on('shutdown', () => manager?.shutdown());
  manager.syncSession(); // adopt an already-live thread, then publish the initial state
  return manager;
}

export function getReviewManager(): ReviewManager | null {
  return manager;
}
