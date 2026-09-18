/**
 * Inline diff approval. When enabled, mutating tools render their proposed change
 * as a diff and wait for the user to accept or reject before writing. The approver
 * is registered by the interactive UI; in sub-agent worker threads and print mode
 * no approver exists, so requests auto-approve and never hang.
 */
import { getUserModel } from '../mind/user.model';

export type DiffApprover = (summary: string, diff: string) => Promise<boolean>;

let enabled = false;
let approver: DiffApprover | null = null;

export function setDiffApprovalEnabled(value: boolean): void {
  enabled = value;
}

export function isDiffApprovalEnabled(): boolean {
  return enabled;
}

export function registerDiffApprover(fn: DiffApprover | null): void {
  approver = fn;
}

/**
 * Returns true if the change may proceed. Auto-approves when the feature is off or
 * no interactive approver is registered (workers / non-interactive runs).
 */
export async function requestDiffApproval(summary: string, diff: string): Promise<boolean> {
  if (!enabled || !approver) return true;
  // Theory of mind: if this diff resembles ones the user has rejected before, say so
  // right in the approval summary — the learned taste is visible at decision time.
  let shownSummary = summary;
  try {
    const pred = getUserModel().predictApproval(summary, diff);
    if (pred && pred.riskyFeatures.length > 0) {
      shownSummary = `${summary}  ⚠ resembles diffs you've rejected: ${pred.riskyFeatures.join(', ')}`;
    }
  } catch { /* prediction is best-effort */ }
  try {
    const approved = await approver(shownSummary, diff);
    // A real interactive decision — labeled training data for the user model.
    try { getUserModel().recordDiffDecision(approved, summary, diff); } catch { /* best-effort */ }
    return approved;
  } catch {
    // Approval is ON and an approver is registered — the user asked to gate writes. A failure here
    // must fail CLOSED (reject), not silently auto-approve, or it's a security bypass.
    return false;
  }
}
