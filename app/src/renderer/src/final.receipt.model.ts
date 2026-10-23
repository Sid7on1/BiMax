import type { ReviewSnapshot } from './protocol';

/**
 * The final receipt: what Bimax claims, and the evidence each claim rests on.
 *
 * `competitive/05_GAP_REGISTER.md` records this as an open gap ("Rivals show tools/diffs; Bimax
 * needs a stronger proof surface… code/Mac final-receipt unification remains later shared work"),
 * and `03_PRODUCT_EXAMPLES.md` names the two lanes a Bimax task can produce evidence in.
 *
 * The hard rule from `08_ACCEPTANCE_GATES.md` is that an evidence gap "cannot produce an
 * unqualified safe verdict". So this model has an explicit `gaps` list, and `proven` is false
 * whenever a claim has no supporting evidence — an unproven claim is still SHOWN, labelled
 * unproven, rather than dropped so the receipt can look complete.
 */

export type ReceiptLane = 'code';

export interface ReceiptEvidence {
  lane: ReceiptLane;
  label: string;
  detail: string;
  /** True only when the underlying record itself reported success. */
  ok: boolean | null;
}

export interface ReceiptClaim {
  id: string;
  claim: string;
  proven: boolean;
  evidence: ReceiptEvidence[];
  /** Why this claim is not proven. Empty when it is. */
  gap: string;
}

export interface FinalReceipt {
  /** True only when every claim carries at least one successful piece of evidence. */
  complete: boolean;
  claims: ReceiptClaim[];
  gaps: string[];
  /** Everything the task did that has no claim attached — never silently dropped. */
  summary: string;
}

export interface FinalReceiptInput {
  review: ReviewSnapshot | null;
  /** Retired compatibility input; ignored by the code-only product. */
  mac?: unknown;
}

export function buildFinalReceipt(input: FinalReceiptInput): FinalReceipt {
  const claims: ReceiptClaim[] = [];
  const review = input.review;

  if (review && review.changes.length > 0) {
    const verifications = review.verifications;
    const passing = verifications.filter(check => check.ok);
    const failing = verifications.filter(check => !check.ok);
    claims.push({
      id: 'code-changes',
      claim: `Changed ${review.changes.length} file${review.changes.length === 1 ? '' : 's'}`,
      // A change is proven by a check that passed AND nothing that failed. A green check beside a
      // red one is not a proof; it is a contradiction the user has to see.
      proven: passing.length > 0 && failing.length === 0,
      evidence: [
        ...review.changes.map((change): ReceiptEvidence => ({
          lane: 'code',
          label: change.file,
          detail: `${change.edits} edit${change.edits === 1 ? '' : 's'} · ${change.tools.join(', ') || 'no tool recorded'}`,
          // An edit record says the edit happened, not that it was correct. Only a check can say
          // that, so the file row deliberately carries no verdict.
          ok: null,
        })),
        ...verifications.map((check): ReceiptEvidence => ({
          lane: 'code',
          label: check.command,
          detail: check.ok ? 'passed' : 'failed',
          ok: check.ok,
        })),
      ],
      gap: failing.length > 0
        ? `${failing.length} check${failing.length === 1 ? '' : 's'} failed after these edits`
        : passing.length === 0
          ? 'no verification command was run against these edits'
          : '',
    });
  }

  const gaps = claims.filter(claim => claim.gap).map(claim => claim.gap);

  return {
    complete: claims.length > 0 && claims.every(claim => claim.proven) && gaps.length === 0,
    claims,
    gaps,
    summary: claims.length === 0
      ? 'This task has not produced a result to prove yet.'
      : claims.map(claim => claim.claim).join(' · '),
  };
}
