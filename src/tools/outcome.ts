/**
 * Typed tool outcomes (BiMax v2, Phase 0).
 *
 * Tools historically signal failure by RETURNING prose ("Error: oldString not found…"), so
 * every learning system downstream (self-model, epistemic ledger, habit miner) had to
 * re-derive ok/err from regexes over result strings — guesses, not labels. This module is
 * the ground-truth channel: a tool that knows what happened returns a TypedOutcome (or
 * throws an error carrying errorClass), the factory unwraps `text` so every existing caller
 * still sees the same string, and the agent loop consumes the typed part for learning.
 * The regex classifier survives only as an explicit low-confidence fallback for tools that
 * haven't been swept and for MCP tools (whose output we don't control).
 */

export type OutcomeStatus = 'ok' | 'error' | 'rejected' | 'blocked';

export type ErrorClass =
  | 'not_found'        // target file/symbol/match does not exist
  | 'syntax'           // change refused or failed for syntax/corruption reasons
  | 'ambiguous_match'  // edit target matched more than once
  | 'invalid_args'     // the model supplied unusable arguments
  | 'permission'       // governor / hook / sandbox floor / OS permission denied
  | 'timeout'          // ran out of time
  | 'interrupted'      // user hit esc / abort signal
  | 'io'               // filesystem error while applying an accepted change
  | 'external'         // the command/service itself failed (non-zero exit, network…)
  | 'unknown';

export interface TypedOutcome {
  presentation?: import('../protocol/presentation').PresentationPart[];
  __typedOutcome: true;
  status: OutcomeStatus;
  errorClass?: ErrorClass;
  /** Exactly what the model sees — the wire behavior of the tool is unchanged. */
  text: string;
  /** 'high' = declared by the tool itself; 'low' = regex fallback over the result string. */
  confidence: 'high' | 'low';
  /**
   * BashTool only: the command's exit code. A non-zero exit with output is still status
   * 'ok' (the TOOL did its job — failing tsc/tests are useful results, not tool failures),
   * but the exit code is ground truth for the epistemic ledger's green/red evidence flag.
   */
  exitCode?: number;
}

export function isTypedOutcome(v: any): v is TypedOutcome {
  return !!v && typeof v === 'object' && v.__typedOutcome === true && typeof v.text === 'string';
}

export function outcomeOk(text: string, opts?: { exitCode?: number }): TypedOutcome {
  return { __typedOutcome: true, status: 'ok', text, confidence: 'high', ...(opts?.exitCode !== undefined ? { exitCode: opts.exitCode } : {}) };
}

export function outcomeError(errorClass: ErrorClass, text: string): TypedOutcome {
  return { __typedOutcome: true, status: 'error', errorClass, text, confidence: 'high' };
}

/** User said no (diff approval, blast-radius gate) — preference data, not incompetence. */
export function outcomeRejected(text: string): TypedOutcome {
  return { __typedOutcome: true, status: 'rejected', text, confidence: 'high' };
}

/** Policy said no (governor, hooks, sandbox floor) before/instead of running. */
export function outcomeBlocked(text: string): TypedOutcome {
  return { __typedOutcome: true, status: 'blocked', errorClass: 'permission', text, confidence: 'high' };
}

/** An Error that carries its outcome classification through the throw path. */
export function classifiedError(message: string, errorClass: ErrorClass, status: OutcomeStatus = 'error'): Error {
  const e: any = new Error(message);
  e.errorClass = errorClass;
  e.outcomeStatus = status;
  return e;
}

/**
 * Recover a typed outcome from a thrown error, when the thrower classified it
 * (classifiedError above, or GovernorVetoError). Returns undefined for unclassified
 * throws — the caller falls back to the regex classifier.
 */
export function typedFromError(e: any, text: string): TypedOutcome | undefined {
  if (!e) return undefined;
  if (e.errorClass || e.outcomeStatus) {
    return {
      __typedOutcome: true,
      status: (e.outcomeStatus as OutcomeStatus) || 'error',
      errorClass: (e.errorClass as ErrorClass) || 'unknown',
      text,
      confidence: 'high',
    };
  }
  if (e.name === 'GovernorVetoError') {
    return { __typedOutcome: true, status: 'blocked', errorClass: 'permission', text, confidence: 'high' };
  }
  return undefined;
}
