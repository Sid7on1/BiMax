/**
 * The review domain model — one authoritative description of "where does this task's change
 * stand?", derived from recorded FACTS rather than stored as mutable status flags.
 *
 * Facts are appended by the ReviewManager at the engine's existing points of truth:
 *   - approvals      ← ProtocolHost request/reply round-trips (veto, diff, ask)
 *   - changes        ← agent.loop's successful-mutation site (CLAIMING_TOOLS + pathOf; prose/media
 *                      remain reviewable even though they deliberately open no build/test claim)
 *   - verifications  ← agent.loop's evidence site (isEvidenceCommand + real exit codes)
 *   - checkpoints    ← the Time Machine (/checkpoint, /rewind, auto-snapshots)
 *   - todos          ← the live plan (todo_update)
 *
 * The lifecycle STATE is a pure function of those facts plus transient liveness — it can never
 * drift from what actually happened, survives crash/restart by construction (facts persist per
 * thread), and old threads with no facts degrade to 'idle' instead of erroring.
 */

import { requiresBuildVerification, verificationState } from './review.verdict';

export type ReviewApprovalKind = 'permission' | 'diff' | 'question';

export interface ReviewApproval {
  id: number;                 // the ProtocolHost request id (wire-visible)
  kind: ReviewApprovalKind;
  question: string;
  requestedAt: number;
  resolution?: {
    value: string;
    approved: boolean;
    at: number;
    /** True when the answer never arrived — process died / host detached / thread rotated. */
    interrupted?: boolean;
  };
}

export interface ReviewChange {
  file: string;
  tools: string[];            // distinct mutating tools that touched this file, in first-seen order
  edits: number;              // successful mutating tool calls attributed to this file
  lastCallId?: string;        // last tool_call id — deep link into the transcript
  lastAt: number;
}

export interface ReviewVerification {
  command: string;
  ok: boolean;
  settled: number;            // how many open claims this evidence run settled
  coveredFiles: string[];     // exact mutation claims covered by this run
  repoWide: boolean;          // successful command had no path restriction
  at: number;
}

export interface ReviewCheckpointFact {
  id: string;                 // '' when the attempt failed
  label: string;
  ts: number;
  auto: boolean;
  ok: boolean;
}

export interface ReviewTodo { content: string; status: string }

export interface ReviewFacts {
  version: 1;
  sessionId: string;
  approvals: ReviewApproval[];
  changes: ReviewChange[];
  verifications: ReviewVerification[];
  checkpoints: ReviewCheckpointFact[];
  todos: ReviewTodo[];
  /** Set when this facts file was reloaded with approvals still pending — the resolvers died. */
  interrupted?: boolean;
  updatedAt: number;
}

export type ReviewStateName =
  | 'idle'                 // no plan, no changes
  | 'planning'             // a plan exists, nothing mutated yet
  | 'awaiting_approval'    // an unresolved approval request is blocking the engine
  | 'applying'             // a mutating tool is running right now
  | 'unverified'           // changes exist; no evidence run has covered them since the last edit
  | 'verification_failed'  // the most recent evidence run since the last edit was red
  | 'verified'             // evidence since the last edit was green — ready to checkpoint
  | 'checkpointed';        // verified AND a checkpoint was taken after the last edit

/** The wire/persisted snapshot — everything a front-end needs to render the review surface. */
export interface ReviewSnapshot {
  sessionId: string;
  state: ReviewStateName;
  nextAction: string;
  approvals: ReviewApproval[];
  changes: ReviewChange[];
  verifications: ReviewVerification[];
  /** Recent checkpoint attempts, including failures; lastCheckpoint remains the latest success. */
  checkpoints: ReviewCheckpointFact[];
  lastCheckpoint: ReviewCheckpointFact | null;
  todos: ReviewTodo[];
  interrupted: boolean;
  updatedAt: number;
}

export function emptyFacts(sessionId: string): ReviewFacts {
  return {
    version: 1, sessionId,
    approvals: [], changes: [], verifications: [], checkpoints: [], todos: [],
    updatedAt: Date.now(),
  };
}

export function pendingApprovals(facts: ReviewFacts): ReviewApproval[] {
  return facts.approvals.filter(a => !a.resolution);
}

function lastChangeAt(facts: ReviewFacts): number {
  return facts.changes.reduce((m, c) => Math.max(m, c.lastAt), 0);
}

function lastVerification(facts: ReviewFacts): ReviewVerification | null {
  return facts.verifications.length ? facts.verifications[facts.verifications.length - 1] : null;
}


function lastGoodCheckpoint(facts: ReviewFacts): ReviewCheckpointFact | null {
  for (let i = facts.checkpoints.length - 1; i >= 0; i--) {
    if (facts.checkpoints[i].ok) return facts.checkpoints[i];
  }
  return null;
}

/**
 * The lifecycle, derived. Precedence (highest wins):
 *   awaiting_approval → applying → (no changes: planning|idle) →
 *   verification_failed | verified | checkpointed | unverified   (ordered by fact timestamps)
 *
 * A verification only counts if it ran AFTER the newest change (retries supersede failures;
 * an edit after a green run makes the task unverified again). 'checkpointed' additionally
 * requires a successful checkpoint after the newest change — a stale snapshot from before this
 * batch of edits is history, not safety.
 */
export function deriveReviewState(facts: ReviewFacts, live?: { applying?: boolean }): ReviewStateName {
  if (pendingApprovals(facts).length > 0) return 'awaiting_approval';
  if (live?.applying) return 'applying';
  const changedAt = lastChangeAt(facts);
  if (facts.changes.length === 0) {
    return facts.todos.some(t => t.status !== 'completed') ? 'planning' : 'idle';
  }
  // The verdict itself is shared with the window's end-of-run summary (./review.verdict).
  const verdict = verificationState(facts.changes, facts.verifications);
  if (verdict !== 'verified') return verdict;
  const cp = lastGoodCheckpoint(facts);
  return cp && cp.ts >= changedAt ? 'checkpointed' : 'verified';
}

/** One calm sentence: current status + the user's next action. */
export function nextActionFor(state: ReviewStateName, facts: ReviewFacts): string {
  switch (state) {
    case 'idle':
      return 'No changes in this task yet.';
    case 'planning': {
      const total = facts.todos.length;
      const done = facts.todos.filter(t => t.status === 'completed').length;
      return `Plan in progress — ${done} of ${total} steps done, nothing changed yet.`;
    }
    case 'awaiting_approval': {
      const p = pendingApprovals(facts)[0];
      const q = (p?.question || '').replace(/\s+/g, ' ').slice(0, 80);
      return `Waiting on you: ${q}`;
    }
    case 'applying':
      return 'Applying changes…';
    case 'unverified':
      if (!facts.changes.some(change => requiresBuildVerification(change.file))) {
        return `${facts.changes.length} non-code file${facts.changes.length === 1 ? '' : 's'} changed — no build/test needed.`;
      }
      return `${facts.changes.length} file${facts.changes.length === 1 ? '' : 's'} changed, unverified — run a build or test to confirm.`;
    case 'verification_failed': {
      const v = lastVerification(facts);
      return `Verification failed (${(v?.command || '').slice(0, 60)}) — fix and re-run.`;
    }
    case 'verified':
      return 'All changes verified — good point to checkpoint.';
    case 'checkpointed':
      return 'Verified and checkpointed — safe to finish or continue.';
  }
  return 'Review state unavailable.';
}

/** True when the heuristic reply text reads as consent (Approve / Yes / Always / Allow…). */
export function readsAsApproved(kind: ReviewApprovalKind, value: string): boolean {
  if (kind === 'question') return true; // informational — an answer is not a grant/deny
  return /^\s*(a(pprove)?|y(es)?|always|allow|accept|ok)\b/i.test(value || '');
}

export function toSnapshot(facts: ReviewFacts, live?: { applying?: boolean }): ReviewSnapshot {
  const state = deriveReviewState(facts, live);
  return {
    sessionId: facts.sessionId,
    state,
    nextAction: nextActionFor(state, facts),
    approvals: facts.approvals.slice(-30),
    changes: facts.changes,
    verifications: facts.verifications.slice(-10),
    checkpoints: facts.checkpoints.slice(-10),
    lastCheckpoint: lastGoodCheckpoint(facts),
    todos: facts.todos,
    interrupted: !!facts.interrupted,
    updatedAt: facts.updatedAt,
  };
}
