import type { LLMProvider } from './llm.provider';

/**
 * The bookkeeping of one AgentLoop run: its limits, and the counters and flags that bound every retry and nudge so no
 * failure mode can spin the loop. It used to be twenty-odd `let`s at the top of a 1,230-line generator; as one object
 * it can be handed to the loop's phases, each of which is now a method (flaw list C14).
 *
 * Every counter is bounded by the limit next to it. A limit names the thing it bounds; none of them is a CPU or
 * memory budget (AGENTS.md).
 */
export class RunState {
  // ── limits ───────────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * Rounds per run. An env override for headless/benchmark runs: a hard task can legitimately need hundreds of rounds,
   * and there the wall clock (container/task timeout) is the real budget, not this.
   */
  readonly maxIter: number;
  /**
   * Re-asks after a transient provider/model error. One bounded provider attempt in strict Desktop mode: retrying the
   * same model/key after a first-token timeout only multiplies visible dead air; the user gets the exact failure and
   * can retry deliberately. Elsewhere, two changing retries and the configured failover.
   */
  readonly MAX_TRANSIENT_RETRIES: number;
  /** Passes through the graded context-recovery ladder (drain, compact, truncate) for one rejection. */
  readonly MAX_CONTEXT_RECOVERIES = 3;
  /**
   * Auto-continues after an output-token cutoff. Long code-writing answers legitimately need several rounds, but a
   * model stuck re-emitting the ceiling forever must not spin the loop. Headless runs depend on this — there is no
   * user there to say "continue".
   */
  readonly MAX_TRUNCATION_CONTINUES: number;
  /**
   * The highest per-call output budget the loop will ask for. An override above the model's own max-output limit can
   * be rejected outright, so escalation stays conservative; operators may lower it.
   */
  readonly MAX_OUTPUT_TOKENS_CEILING: number;
  readonly MAX_REASONING_ESCALATIONS = 3;
  /** "Keep going while todos are open": bounded so a model that refuses to finish can't spin the loop forever. */
  readonly MAX_PERSISTENCE_NUDGES = 4;
  readonly MAX_REQUIRED_TOOL_NUDGES = 2;
  readonly MAX_COMPLETION_NUDGES = 2;
  /** The provider's configured output budget, or 4096. */
  readonly configuredBudget: number;

  // ── counters and flags ───────────────────────────────────────────────────────────────────────────────────────────
  /** A DocumentTool draft receipt is not a delivered file; the turn may not end on one. */
  documentDraftPending = false;
  /** Bounds the regenerate-on-empty correction to one retry, so a model that keeps emitting pure filler can't spin. */
  pureFillerRetried = false;
  /**
   * Bounds the recovery for a turn that produced NOTHING — no text and no tool call (a reasoning model that streamed
   * only `reasoning_content` then ended empty, or one that went silent right after a tool result). Without it the loop
   * would end on the empty turn and the user would see a stopped spinner and no answer.
   */
  emptyTurnRetried = false;
  /** Bounds the re-ask for a reply that was only a stray fragment (isStrayFragment) to one per run. */
  strayFragmentRetried = false;
  /** Whether any visible text has been streamed across the whole run; if not, the loop says so instead of going silent. */
  anyTextYielded = false;
  /** Re-asks spent on transient errors, counted CONSECUTIVELY: a clean round resets it. */
  transientRetries = 0;
  contextRecoveries = 0;
  truncationContinues = 0;
  /** A raised output budget for the next call only (a pure-reasoning cutoff), then back to the configured one. */
  nextOutputTokenBudget: number | undefined = undefined;
  reasoningEscalations = 0;
  persistenceNudges = 0;
  requiredToolUsed = false;
  requiredToolNudges = 0;
  /**
   * The activation gate proves the model CAN call the capability; it does not prove the operation was attempted —
   * `requiredToolUsed` flips on the first call of any kind, so a single target-acquisition verb satisfies it and the
   * model is free to stop and narrate (measured 2026-08-18: "send hi to my mom using Messages" called open once, then
   * answered with text lifted off the screen). This tracks whether anything ADVANCED the operation.
   */
  sawAdvancingAction = false;
  lastCapabilitySucceeded = false;
  completionNudges = 0;
  /**
   * Armed only after an unresolved operation round returned prose/emptiness instead of acting. The next request then
   * names the required function explicitly; successful action rounds return to auto so AskUserTool stays reachable.
   */
  forceRequiredToolNextRound = false;
  /**
   * Once a required capability proves a terminal native stop, the next round is answer-only: removing schemas enforces
   * the transition even when a small controller ignores prose nudges.
   */
  operationTerminalBlocker: string | null = null;
  terminalBlockerNudged = false;
  llmRounds = 0;

  constructor(llm: LLMProvider, maxIterations: number | undefined, env: NodeJS.ProcessEnv = process.env) {
    this.maxIter = maxIterations ?? (parseInt(env.BIMAX_MAX_ITERATIONS || '', 10) || 500);
    this.MAX_TRANSIENT_RETRIES = String(env.BIMAX_DESKTOP_STRICT_MODEL || '').trim() ? 0 : 2;
    this.MAX_TRUNCATION_CONTINUES = parseInt(env.BIMAX_MAX_CONTINUES || '', 10) || 12;
    this.MAX_OUTPUT_TOKENS_CEILING = parseInt(env.BIMAX_MAX_OUTPUT_CEILING || '', 10) || 16384;
    const providerConfiguredBudget = Number((llm as LLMProvider & { maxTokens?: number }).maxTokens);
    this.configuredBudget = Number.isFinite(providerConfiguredBudget) && providerConfiguredBudget > 0
      ? Math.floor(providerConfiguredBudget)
      : 4096;
  }
}

/** One tool call as the model emitted it. `truncated`: cut off at the output-token ceiling mid-arguments. */
export interface ToolCallDraft { id: string; name: string; args: string; truncated?: boolean; extra?: unknown }

/** What one model round produced, and how the loop is to treat it. Fresh for every round. */
export class RoundState {
  /** `truncated` is set when the model hit the output-token ceiling while still writing a call's arguments. */
  toolCalls: ToolCallDraft[] = [];
  currentContent = '';
  /**
   * Kimi K3 requires its exact out-of-band reasoning to accompany the assistant tool-call message on the next request.
   * Most models do not, so the adapter marks only required chunks replayable; ordinary hidden thinking is never
   * persisted into provider history.
   */
  replayableReasoning = '';
  /** The partial round must be discarded and re-asked (after context recovery or a transient-error retry). */
  discardTurn = false;
  /** The model hit the output-token ceiling (finish_reason: length); handled after the stream ends. */
  turnTruncated = false;
  /** The opening of the reply, held until it contains a space or outgrows a word, so a stray fragment never shows. */
  heldFragment = '';
  releasedText = false;
  /** The provider error that ended the round, if any — for the chat span. */
  chatErrorMsg: string | undefined = undefined;
}
