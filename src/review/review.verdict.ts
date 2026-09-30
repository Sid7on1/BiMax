/**
 * Whether a set of changes has been verified — one definition, for the engine and the window.
 *
 * The engine's review lifecycle (`deriveReviewState` in review.model.ts) and the window's end-of-run summary
 * (`app/src/renderer/src/run.summary.model.ts`, UI fix list item 41) must never disagree about whether the work is
 * checked, so both call these. This file imports nothing: `src/protocol/protocol.ts` re-exports it, and a door may
 * only pass along a module with no imports of its own (app/src/__tests__/module.boundaries.test.ts).
 */

// Successful writes to prose/media are real task changes, but a compiler or test suite cannot
// verify them. Keep them in the review change list while excluding them from the epistemic
// build/test ledger so a story.txt edit never ends with "run a build/test to confirm".
const NON_BUILD_ARTIFACTS = new Set([
  '.txt', '.md', '.rtf', '.doc', '.docx', '.odt', '.pdf',
  '.csv', '.tsv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.mp3', '.wav', '.m4a', '.mp4', '.mov', '.webm',
]);

/** `path.extname` without `path`: the last dot of the last segment, and a leading dot names the file (`.env`). */
function extname(file: string): string {
  const base = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

export function requiresBuildVerification(file?: string): boolean {
  if (!file) return false;
  const ext = extname(file).toLowerCase();
  // Extensionless artifacts remain conservative: they may be scripts, Dockerfiles, Makefiles, etc.
  return ext === '' || !NON_BUILD_ARTIFACTS.has(ext);
}

export interface VerdictChange { file: string; lastAt: number }
export interface VerdictRun { ok: boolean; at: number; repoWide?: boolean; coveredFiles?: string[] }
export type VerificationState = 'unverified' | 'verification_failed' | 'verified';

function norm(file: string): string { return String(file || '').replace(/\\/g, '/').replace(/^\.\//, ''); }

/** Every change a build or test can verify is covered by a green run since `changedAt`. */
export function verificationCovers(changes: VerdictChange[], runs: VerdictRun[], changedAt: number): boolean {
  const required = changes.filter(change => requiresBuildVerification(change.file)).map(change => norm(change.file));
  if (required.length === 0) return true;
  const greens = runs.filter(v => v.ok && v.at >= changedAt);
  if (greens.some(v => v.repoWide)) return true;
  const covered = new Set(greens.flatMap(v => v.coveredFiles || []).map(norm));
  return required.every(file => [...covered].some(candidate => candidate === file || candidate.endsWith(`/${file}`) || file.endsWith(`/${candidate}`)));
}

/**
 * The verdict on `changes` (at least one) given the verification runs, oldest first.
 *
 * A run only counts if it ran AFTER the newest change: a retry supersedes a failure, and an edit after a green run
 * makes the work unverified again. The newest run decides red; green also has to cover every change a build or test
 * can verify.
 */
export function verificationState(changes: VerdictChange[], runs: VerdictRun[]): VerificationState {
  const changedAt = changes.reduce((m, c) => Math.max(m, c.lastAt), 0);
  const last = runs.length ? runs[runs.length - 1] : null;
  if (!last || last.at < changedAt) return 'unverified';
  if (!last.ok) return 'verification_failed';
  return verificationCovers(changes, runs, changedAt) ? 'verified' : 'unverified';
}
