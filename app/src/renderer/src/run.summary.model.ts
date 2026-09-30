/**
 * What the latest run did, for the one quiet line the conversation ends on (UI fix list item 41: "stream the work,
 * design the ending — the completion summary controls what the user remembers about the whole run").
 *
 * The engine's review snapshot covers the whole session; a run is everything after the person's latest message. So
 * the run's changes are the files edited since that message, and whether they are checked is decided by the engine's
 * own verdict (`verificationState`, one definition shared through the protocol) applied to those files only — the
 * Review panel and this line can never disagree about what "checked" means.
 *
 * No line when the run changed nothing: a question answered needs no receipt, and a receipt on every reply is noise.
 */

import type { TranscriptItem } from './engine.state';
import { requiresBuildVerification, verificationState, type ReviewSnapshot } from './protocol';

export type RunVerdict = 'verified' | 'failed' | 'unchecked' | 'no-check-needed' | 'stopped';

export interface RunSummary {
  /** Stable for one run: the id of the message that started it. */
  key: string;
  verdict: RunVerdict;
  /** What happened, in one line: "Changed retry.ts · npm test passed". */
  headline: string;
  /** What the person might do next, only when something is left to do. */
  next: string;
  files: { file: string; edits: number }[];
  /** The checks that ran during this run, oldest first. */
  checks: { command: string; ok: boolean }[];
}

const MAX_COMMAND = 48;

function shortCommand(command: string): string {
  const one = command.replace(/\s+/g, ' ').trim();
  return one.length > MAX_COMMAND ? `${one.slice(0, MAX_COMMAND - 1)}…` : one;
}

function baseName(file: string): string {
  return file.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? file;
}

/** The summary of the latest run, or null while it is still running, before any run, or when it changed nothing. */
export function runSummary(items: TranscriptItem[], review: ReviewSnapshot | null, busy: boolean): RunSummary | null {
  if (busy || !review) return null;
  // A question waiting on the person is not an ending.
  if (review.state === 'awaiting_approval' || review.state === 'applying') return null;

  let start: { id: string; at: number } | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'msg' && item.msg.role === 'user') {
      const at = Date.parse(item.msg.timestamp);
      if (Number.isFinite(at)) start = { id: item.msg.id, at };
      break;
    }
  }
  if (!start) return null;
  const from = start;

  const changes = review.changes.filter((change) => change.lastAt >= from.at);
  if (changes.length === 0) return null;
  const checks = review.verifications.filter((run) => run.at >= from.at);

  const verdict: RunVerdict = review.interrupted
    ? 'stopped'
    : !changes.some((change) => requiresBuildVerification(change.file))
      ? 'no-check-needed'
      : (() => {
        const state = verificationState(changes, review.verifications);
        return state === 'verified' ? 'verified' : state === 'verification_failed' ? 'failed' : 'unchecked';
      })();

  const what = changes.length === 1 ? `Changed ${baseName(changes[0].file)}` : `Changed ${changes.length} files`;
  const last = checks[checks.length - 1];
  const lastGreen = [...checks].reverse().find((run) => run.ok);
  const headline = {
    verified: `${what} · ${lastGreen ? `${shortCommand(lastGreen.command)} passed` : 'checked'}`,
    failed: `${what} · ${last ? `${shortCommand(last.command)} failed` : 'a check failed'}`,
    unchecked: `${what} · not checked yet`,
    'no-check-needed': `${what} · no test needed for text or media`,
    stopped: `Stopped · ${what.charAt(0).toLowerCase()}${what.slice(1)} so far`,
  }[verdict];
  const next = {
    verified: '',
    failed: 'Needs a fix before it can be trusted — the details are in Review.',
    unchecked: 'Not proven yet: no build or test ran after these edits.',
    'no-check-needed': '',
    stopped: 'The run was stopped before it finished; check what it left.',
  }[verdict];

  return {
    key: `run-${from.id}`,
    verdict,
    headline,
    next,
    files: changes.map((change) => ({ file: change.file, edits: change.edits })),
    checks: checks.map((run) => ({ command: run.command, ok: run.ok })),
  };
}
