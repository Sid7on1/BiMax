// Desktop's view of the causal evidence timeline — Phase 8, owner section 28.
//
// This is the renderer-facing half of the shared vocabulary in `evidence.schema.ts` (generated from the
// engine's `src/evidence/schema.ts`; regenerate with `npm run gen:app-protocol`). It is a pure view
// model: it takes evidence records and produces rows the evidence panel renders, and it holds the line
// on the two things 08_ACCEPTANCE_GATES.md says the section 28 surface must never do.
//
//   1. "an evidence gap, dropped event or unavailable sensor cannot produce an unqualified safe
//      verdict" — so a row's confidence is derived here, and there is no way for a caller to hand in
//      a "clean" row whose evidence does not support it.
//   2. "deterministic hard floors, learned anomaly ranking and model explanation are separate in
//      receipts" — so a row keeps the layer and the model attribution apart, and the model's words
//      are carried in their own field that the UI labels rather than mixed into the finding text.
//
// The renderer never receives a native handle, an audit token, a raw path outside the project, or a
// secret: everything here comes from records the schema already validated and redacted.

import {
  ActionReceipt, Decision, EvidenceBasis, EvidenceRecord, Finding, Observation, OperationIntent,
  TaskIntent, Verification, admissible,
} from './evidence.schema';

/** How much weight the UI may give a row. Derived, never supplied. */
export type RowConfidence =
  | 'measured'        // complete, fresh, observed evidence
  | 'declared'        // rests on what an operation said it would do
  | 'incomplete';     // a sensor dropped events or was unavailable

export interface TimelineRow {
  operationId: string;
  operation: string;
  subsystem: OperationIntent['subsystem'];
  /** Nearest-first causal path, as operation labels. Ends at the task's first operation. */
  causalPath: string[];
  disposition: Decision['disposition'] | null;
  findings: Finding[];
  confidence: RowConfidence;
  /** Present only when a model contributed; always labelled separately from the findings. */
  modelExplanation: { version: string; text: string } | null;
  /** Present when the row's evidence is incomplete. Rendered verbatim, never summarised away. */
  evidenceGap: string | null;
  receipt: { executor: string; outcome: ActionReceipt['outcome']; reason: string } | null;
  verification: { postcondition: string; satisfied: boolean | null; reason: string } | null;
}

export interface RetentionSummary {
  totalRecords: number;
  byKind: Record<string, number>;
  /** Records dropped and why, so a shorter timeline is never mistaken for a quieter machine. */
  evictions: { reason: string; droppedRecords: number }[];
  oldestAt: number | null;
  newestAt: number | null;
}

export interface EvidenceTimeline {
  task: { id: string; summary: string; projectRoot: string | null } | null;
  rows: TimelineRow[];
  retention: RetentionSummary;
  /** True when anything in this timeline rests on incomplete evidence. Drives the header banner. */
  hasEvidenceGap: boolean;
}

function confidenceOf(basis: EvidenceBasis, observations: Observation[]): RowConfidence {
  if (observations.some(o => !admissible(o.completeness))) return 'incomplete';
  return basis === 'observed' ? 'measured' : 'declared';
}

/**
 * Build the timeline.
 *
 * Rows are keyed by operation because that is the unit a user reasons about — "what did this tool
 * call do" — and a single operation can carry a proposal decision, a receipt decision, a receipt and
 * a verification. Merging them into one row is what makes the causal story readable; keeping their
 * fields distinct is what keeps it honest.
 */
export function buildEvidenceTimeline(records: EvidenceRecord[], evictions: { reason: string; droppedRecords: number }[] = []): EvidenceTimeline {
  const task = records.find((r): r is TaskIntent => r.kind === 'TaskIntent') ?? null;
  const operations = new Map<string, OperationIntent>();
  const decisions = new Map<string, Decision[]>();
  const observations = new Map<string, Observation[]>();
  const receipts = new Map<string, ActionReceipt>();
  const verifications = new Map<string, Verification>();
  const byKind: Record<string, number> = {};
  let oldestAt: number | null = null;
  let newestAt: number | null = null;

  for (const entry of records) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
    oldestAt = oldestAt === null ? entry.createdAt : Math.min(oldestAt, entry.createdAt);
    newestAt = newestAt === null ? entry.createdAt : Math.max(newestAt, entry.createdAt);
    switch (entry.kind) {
      case 'OperationIntent': operations.set(entry.id, entry); break;
      case 'Decision':
        decisions.set(entry.operationIntentId, [...(decisions.get(entry.operationIntentId) ?? []), entry]);
        break;
      case 'Observation':
        if (entry.operationIntentId) {
          observations.set(entry.operationIntentId, [...(observations.get(entry.operationIntentId) ?? []), entry]);
        }
        break;
      case 'ActionReceipt': receipts.set(entry.operationIntentId, entry); break;
      case 'Verification': verifications.set(entry.actionReceiptId, entry); break;
      default: break;
    }
  }

  const pathOf = (operationId: string): string[] => {
    const labels: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = operationId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const operation: OperationIntent | undefined = operations.get(cursor);
      if (!operation) break;
      labels.push(operation.operation);
      cursor = operation.parentOperationId;
    }
    return labels;
  };

  const rows: TimelineRow[] = [...operations.values()].map(operation => {
    const operationDecisions = decisions.get(operation.id) ?? [];
    // The last decision is the current verdict: a receipt-stage decision supersedes the proposal it
    // followed. Both remain in the ledger; the row shows where the operation ended up.
    const current = operationDecisions[operationDecisions.length - 1] ?? null;
    const operationObservations = observations.get(operation.id) ?? [];
    const receipt = receipts.get(operation.id) ?? null;
    const verification = receipt ? verifications.get(receipt.id) ?? null : null;
    const gapObservation = operationObservations.find(o => !admissible(o.completeness));
    return {
      operationId: operation.id,
      operation: operation.operation,
      subsystem: operation.subsystem,
      causalPath: pathOf(operation.id),
      disposition: current?.disposition ?? null,
      findings: operationDecisions.flatMap(d => d.findings),
      confidence: confidenceOf(current?.evidenceBasis ?? 'declared', operationObservations),
      modelExplanation: current?.modelExplanation && current.modelVersion
        ? { version: current.modelVersion, text: current.modelExplanation }
        : null,
      evidenceGap: gapObservation?.completeness.reason
        ?? (current && !admissible(current.factors.observationCompleteness)
          ? current.factors.observationCompleteness.reason ?? 'the evidence for this operation is incomplete'
          : null),
      receipt: receipt ? { executor: receipt.executor, outcome: receipt.outcome, reason: receipt.reason } : null,
      verification: verification
        ? { postcondition: verification.postcondition, satisfied: verification.satisfied, reason: verification.reason }
        : null,
    };
  });

  return {
    task: task ? { id: task.id, summary: task.summary, projectRoot: task.projectRoot } : null,
    rows,
    retention: { totalRecords: records.length, byKind, evictions, oldestAt, newestAt },
    hasEvidenceGap: rows.some(row => row.evidenceGap !== null) || evictions.length > 0,
  };
}

/**
 * The one-line header shown above the timeline.
 *
 * Silence has to be earned. A task with no findings and complete measured evidence says so; a task
 * with no findings whose evidence was partial says *that* instead, because those are different
 * states and only one of them is reassuring.
 */
export function timelineHeadline(timeline: EvidenceTimeline): string {
  const findings = timeline.rows.reduce((sum, row) => sum + row.findings.length, 0);
  const blocked = timeline.rows.filter(row => row.disposition === 'block').length;
  if (blocked) {
    return `${blocked} operation${blocked === 1 ? '' : 's'} refused; ${findings} finding${findings === 1 ? '' : 's'} recorded`;
  }
  if (findings) {
    return `${findings} finding${findings === 1 ? '' : 's'} recorded, none of which stopped an operation`;
  }
  if (timeline.hasEvidenceGap) {
    return 'no findings — but some evidence is incomplete, so this is not a clean bill of health';
  }
  if (!timeline.rows.length) return 'no operations recorded for this task yet';
  return `${timeline.rows.length} operation${timeline.rows.length === 1 ? '' : 's'} recorded, all within the approved boundary`;
}

/** Rows worth surfacing without the user opening the full timeline. */
export function notableRows(timeline: EvidenceTimeline): TimelineRow[] {
  return timeline.rows.filter(row => (
    row.findings.length > 0
    || row.evidenceGap !== null
    || row.verification?.satisfied === false
  ));
}

export interface RetentionControl {
  label: string;
  /** What clicking it removes, stated before it happens. */
  effect: string;
  /** Records this control would delete right now. */
  affectedRecords: number;
}

/**
 * The delete controls offered for the timeline, with their exact effect precomputed. §2.4 requires
 * "disable, delete, revoke, and diagnostic controls" and a stated retention — a control whose blast
 * radius the user learns about afterwards does not meet that bar.
 */
export function retentionControls(records: EvidenceRecord[], taskIntentId: string | null): RetentionControl[] {
  const forTask = taskIntentId
    ? records.filter(r => ('taskIntentId' in r && r.taskIntentId === taskIntentId) || r.id === taskIntentId)
    : [];
  const observations = records.filter(r => r.kind === 'Observation');
  return [
    {
      label: 'Delete this task\'s evidence',
      effect: 'removes the task intent, its operations, observations, decisions and receipts; findings already shown are gone',
      affectedRecords: forTask.length,
    },
    {
      label: 'Delete all observations',
      effect: 'keeps decisions and receipts but removes the raw observations behind them, so those decisions become unverifiable',
      affectedRecords: observations.length,
    },
    {
      label: 'Delete everything',
      effect: 'clears the whole local evidence store; nothing is retained and no finding can be re-derived',
      affectedRecords: records.length,
    },
  ];
}
