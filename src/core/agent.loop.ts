import { setTimeout as delay } from 'node:timers/promises';
import { reportCapability } from './capability.status';
import { LLMProvider, Message, ChatEvent } from './llm.provider';
import { responseSanitizer } from './response.sanitizer';
import { cleanToolName, extractTextToolCalls } from './tool.call.parser';
import { ToolRegistry } from '../tools/tool.registry';
import { IGovernor } from './interfaces';
import { Logger } from '../utils';
import { ContextManager, type ContextMode } from '../memory/context.manager';
import type { VectorStore } from '../memory/vector.store';
import { droppedRecall, recallForTurn, recallKey, recallQuery } from '../memory/recall';
import { derivedEvidence } from '../context/evidence';
import { overflowMessage, planRequest } from '../context/request.budget';
import { engineEvents, ToolCallEntry } from '../engine/events';
import { getActiveTodos, todosTouchedThisTurn } from '../tools/implementations/todo.tool';
import { getCompletionChecks } from '../outcome/completion.check';
// These were inline require()s, a workaround for import cycles that no longer exist (flaw list C24, 2026-09-30).
// import.cycles.test.ts now fails on any load-time cycle.
import { getOutcomeManager } from '../outcome/outcome.manager';
import { getConfig } from '../engine/config';
import { autoSelectCandidates } from '../engine/models';
import { CLAIMING_TOOLS } from './tool.outcome.observers';
import { drainSteer, hasSteer, steerMessage } from './steering';
import { LoopDetector } from './loop-detector';
import { RunState, RoundState } from './agent.run.state';
import { runToolRound, type ToolRoundHost } from './agent.tool.round';
// Re-exported: tests and callers import these from the loop.
export { PREPARATORY_MOTION_ACTIONS, terminalCapabilityBlocker, sanitizeToolArgs } from './agent.tool.round';
import { taskMetrics } from '../telemetry/task.metrics';
import type { TypedOutcome } from '../tools/outcome';
import { startEpisodeRecording } from '../mind/episode.recorder';
import { getTracer } from '../telemetry/trace';
import { applyImplicitWriteConstraints, applyImplicitDocumentConstraints } from '../tools/write.constraints';
import { canonicalToolArgs } from './tool.args';

/** How long a completion check's command may run (F3). Test suites are the usual check, and they are not quick. */
const CHECK_TIMEOUT_MS = 300_000;

// Re-exported: review.manager reads it from here.
export { CLAIMING_TOOLS };

export interface AgentLoopOptions {
  maxIterations?: number;
  /** The longest this run may take, in minutes (backlog F5). Unset or 0: no limit. */
  maxMinutes?: number;
  contextMode?: 'smart' | 'full';
  useLite?: boolean;
  signal?: AbortSignal;
  /** Stable Bimax task/thread id used to isolate stateful tools. */
  sessionId?: string;
  /** Restrict the schemas exposed for a specialized provider turn. */
  toolNames?: readonly string[];
  /** Do not inject code-navigation context into a turn that is not working on code. */
  skipRepoMap?: boolean;
  /** The turn may not terminate before this tool has actually been attempted. */
  requireTool?: string;
  /**
   * Benchmark-fixture label ("form", "menu", "navigation") recorded on this task's metrics. Set
   * only by a harness that knows what it is exercising — never inferred from the prompt, because
   * a guessed class would put fake precision under the turn-count criterion it feeds.
   */
  metricsLabel?: string;
}



/** The longest opening a round holds back while it could still turn out to be a stray fragment. */
const FRAGMENT_HOLD_CHARS = 12;
/** One-word replies people genuinely answer with; these are never re-asked. */
const SHORT_ANSWERS = new Set([
  'yes', 'no', 'ok', 'okay', 'done', 'sure', 'hi', 'hello', 'hey', 'thanks', 'correct', 'true', 'false',
  'none', 'nothing', 'maybe', 'yep', 'nope', 'fine', 'ready', 'agreed', 'understood', 'noted',
]);

/**
 * A whole reply that is one short run of letters and not a word people answer with is not an answer.
 * Measured 2026-09-13: nemotron-3.5-lightning on NVIDIA ended a full turn ("what files do you see ?") with
 * the five characters "Thead" — no tool call, no truncation — and the loop presented it as the answer.
 * Numbers, punctuation ("Done.") and real one-word replies are answers. A genuine one-word answer such as
 * "Paris" costs one extra round and is then shown.
 */
export function isStrayFragment(text: string): boolean {
  const t = text.trim();
  return /^[A-Za-z]{1,12}$/.test(t) && !SHORT_ANSWERS.has(t.toLowerCase());
}

export class AgentLoop {
  private contextManager: ContextManager;
  public messages: Message[] = [];
  // Model fallback chain (the Claude Code `fallbackModel` analogue): armed once per loop
  // instance, so a session that failed over doesn't ping-pong between two broken models.
  private fallbackApplied = false;

  constructor(
    private llm: LLMProvider,
    private tools: ToolRegistry,
    // Reserved/optional: the loop itself does not enforce policy — each tool carries its own injected
    // governor (set at buildTool time), so this is unused today. Kept positional for callers that pass
    // one (worker.agent) and for future loop-level gating. Personas pass `undefined`.
    private governor?: IGovernor,
    // The active model's context window (tokens). Compaction thresholds scale to this so bimax
    // works correctly whether the chosen model has a 32k or a 1M window. Falls back to a safe default.
    maxContextTokens?: number,
    // Session-scoped context manager owned by the caller (the persona). When provided, token
    // calibration, warning latches, and compaction epochs survive across turns instead of being
    // silently reset by each fresh AgentLoop. Omitted → a private per-loop instance (workers/tests).
    contextManager?: ContextManager,
    // Memory store for AUTOMATIC recall. Optional: workers and tests run without one, and a loop
    // without a store behaves exactly as before. See ../memory/recall.
    private memoryStore?: VectorStore,
    /**
     * Queries already recalled against this SESSION. The persona owns the set because it owns the
     * session: it builds a fresh AgentLoop per turn, so a loop-owned set reset with every turn and
     * the "never recall the same question twice" guard never actually applied across turns.
     * Omitted (workers, tests) → per-loop, same as before.
     */
    sessionRecall?: Set<string>
  ) {
    this.contextManager = contextManager ?? new ContextManager(llm, maxContextTokens);
    this.recalled = sessionRecall ?? new Set();
  }

  /**
   * The fallback model to fail over to, or null when there's nothing sensible to do: none
   * configured, already failed over, or the fallback IS the currently failing model.
   */
  private async fallbackModelFor(failing?: string): Promise<string | null> {
    // Bimax for Mac can opt into an exact model contract. A fallback under that contract would be
    // a lie: the UI would still name the locked model while another model performed the work.
    if (String(process.env.BIMAX_DESKTOP_STRICT_MODEL || '').trim()) return null;
    if (this.fallbackApplied) return null;
    // Env beats config so headless/autonomous runs (and tests) can arm the chain per-process.
    let fb = String(process.env.BIMAX_FALLBACK_MODEL || '').trim();
    if (!fb) {
      try {
        fb = String(getConfig().fallbackModel || '').trim();
      } catch { return null; }
    }
    const llm = this.llm as any;
    // The model that actually failed: the quick model on a lite-routed turn, else the work model.
    const current = String(failing || llm?.userModel || llm?.defaultModel || '');

    // A CONFIGURED fallback is the user's own choice, so only evidence may disqualify it: the
    // provider must have actually rejected it this session. `avoidAutoSelect` used to disqualify it
    // too, which inverted the outcome — measured 2026-09-02, a configured fallback of
    // `nemotron-3.5-lightning-30b-a3b` (6.7s, calls tools) was discarded for carrying the note
    // "task probe pending", and the derived replacement was a model the provider does not serve.
    // The flag gates AUTOMATIC candidates, which is what its name says and where it still applies
    // (autoSelectCandidates, below); it is not authority over a value the user set.
    if (fb) {
      let unsafe = false;
      try { unsafe = !!llm?.isUnservable?.(fb); } catch { /* optional capability */ }
      if (unsafe) {
        Logger.warn(`[AgentLoop] Configured fallback model "${fb}" was rejected by the provider this session; deriving one instead.`);
        fb = '';
      }
    }

    // No usable configured fallback — derive one from the curated policy, restricted to what the
    // provider actually serves. Better a working model than none: the alternative is a dead turn.
    if (!fb) {
      try {
        const served = await llm?.listProviderModels?.();
        if (Array.isArray(served) && served.length) {
          fb = autoSelectCandidates('coding', served).find((id: string) => id !== current) || '';
        }
      } catch { /* derivation is best-effort */ }
    }
    return fb && fb !== current ? fb : null;
  }

  /**
   * Last-resort context reduction: preserve every system instruction and only the newest
   * non-system turns. If the slice starts inside a tool exchange, discard leading orphaned tool
   * results until the first user/assistant message so the provider contract remains valid.
   */
  /** Queries already recalled against this session — re-injecting one is pure token cost. */
  private recalled: Set<string>;

  /**
   * Retrieve against the latest user message and inject what comes back.
   *
   * Guarded by `recallQuery`, which is pure and tested separately. Lookup failures are reported by recallForTurn without failing the user's turn.
   */
  private async injectRecall(): Promise<void> {
    if (!this.memoryStore) return;
    const last = [...this.messages].reverse().find((m) => m.role === 'user');
    if (!last) return;

    const query = recallQuery(last.role, last.content, this.recalled);
    if (!query) return;
    this.recalled.add(recallKey(query));

    const recalled = await recallForTurn(this.memoryStore, query).catch(() => {
      reportCapability({ id: 'memory-recall', label: 'Memory recall', state: 'degraded',
        reason: 'Memory lookup failed.', impact: 'This turn continues without recalled context.', action: 'Check memory storage and retrieval settings.' });
      return null;
    });
    if (!recalled) return;

    // Placed before the user's message, so the model reads the evidence and then the question —
    // and so the block is attributable to the system rather than appearing to be something the
    // user said.
    const at = this.messages.lastIndexOf(last);
    this.messages.splice(at, 0, { role: 'system', content: recalled.text } as typeof last);
    // Record what was shown and where it came from. The block is derived from its memories, so it goes stale
    // with any of them.
    this.contextManager.evidence.admitAll(recalled.evidence);
    this.contextManager.evidence.admit(derivedEvidence('recall-block', recalled.text, recalled.evidence));
  }

  /**
   * One round's context: recall, then compaction. Compaction drops recall blocks (they are evidence for
   * the turn they were retrieved for), so the session forgets what it recalled when that happens, and the
   * question still being worked on recalls its evidence again on the next round instead of losing it for
   * the rest of the session (record 47, A04).
   */
  private async prepareContext(contextMode: ContextMode): Promise<void> {
    await this.injectRecall();
    const beforeCompaction = this.messages;
    this.messages = await this.contextManager.checkAndCompact(this.messages, contextMode);
    if (droppedRecall(beforeCompaction, this.messages)) {
      this.recalled.clear();
      // The request about to be sent needs that evidence too: recall it again now, after compaction, rather than a
      // round later. A round that ends in a final answer had no later round, so it went without (audit 51, U08).
      await this.injectRecall();
    }
  }

  private truncateContext(messages: Message[], keepRecentTurns = 4): Message[] {
    const systemMessages = messages.filter(message => message.role === 'system');
    const nonSystemMessages = messages.filter(message => message.role !== 'system');
    let recentMessages = nonSystemMessages.slice(-keepRecentTurns);
    while (recentMessages[0]?.role === 'tool') recentMessages = recentMessages.slice(1);
    return [...systemMessages, ...recentMessages];
  }

  /** Move the user's steering words into the conversation, in order, and say they were taken (F7). */
  /** The loop's side of the tool round (agent.tool.round.ts): its tools, its model, and its live message list. */
  private toolRoundHost(): ToolRoundHost {
    const loop = this;
    return { tools: this.tools, llm: this.llm, get messages() { return loop.messages; } };
  }

  private takeSteering(): void {
    for (const text of drainSteer()) {
      this.messages.push({ role: 'user', content: steerMessage(text) });
      engineEvents.emit('steered', { text });
    }
  }

  /**
   * Run a completion check's command through the task's own shell tool — so the same permission rules, sandbox and
   * folder apply as to any command the model runs — shown as a tool call, and return the exit code the tool observed.
   */
  private async runCheckCommand(command: string, context: any, signal: AbortSignal | undefined, sessionId?: string): Promise<{ exitCode: number | null; output: string }> {
    const tool = this.tools.getTool('BashTool');
    if (!tool) return { exitCode: null, output: 'No shell tool is available to run the check.' };
    const args = { command, timeout: CHECK_TIMEOUT_MS };
    const entry: ToolCallEntry = {
      id: `check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      toolName: 'BashTool', input: JSON.stringify(args), output: '', status: 'running', startTime: new Date(),
    };
    engineEvents.emit('tool_call', entry);
    let typed: TypedOutcome | undefined;
    let output: string;
    let failed = false;
    try {
      const result = await tool.execute(args, { ...(context || { cwd: process.cwd() }), signal, sessionId, reportOutcome: (o: TypedOutcome) => { typed = o; } });
      output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    } catch (e: any) {
      output = `Tool Error: ${e?.message ?? e}`;
      failed = true;
    }
    engineEvents.emit('tool_call_result', { ...entry, output, status: failed || (typed && typed.status !== 'ok') ? 'error' : 'success', endTime: new Date() } as ToolCallEntry);
    return { exitCode: failed ? null : typed?.exitCode ?? null, output };
  }

  /**
   * One run of the loop, stopped at the task's time limit when it has one (backlog F5). The limit rides the same abort
   * signal as the Stop button, so a model call or a command in flight ends at once rather than at the next round; the
   * run then says it stopped at the limit, and `turn_limit` tells the front-end it was the limit and not the user.
   */
  async *execute(
    initialMessages: Message[],
    systemPrompt: string,
    options?: AgentLoopOptions,
    context?: any
  ): AsyncGenerator<string> {
    const minutes = options?.maxMinutes ?? 0;
    if (!(minutes > 0)) { yield* this.run(initialMessages, systemPrompt, options, context); return; }
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(), minutes * 60_000);
    const signal = options?.signal ? AbortSignal.any([options.signal, limit.signal]) : limit.signal;
    try {
      yield* this.run(initialMessages, systemPrompt, { ...options, signal }, context);
    } finally {
      clearTimeout(timer);
    }
    if (limit.signal.aborted && !options?.signal?.aborted) {
      const shown = Number.isInteger(minutes) ? `${minutes} minute${minutes === 1 ? '' : 's'}` : `${minutes} minutes`;
      engineEvents.emit('turn_limit', { kind: 'time', minutes });
      yield `\n\n⏱ Stopped: this run reached its time limit of ${shown}. Say "continue" to pick up where it stopped.\n`;
    }
  }

  /**
   * Read one model round from the provider: stream visible text (holding a possible stray fragment back), route
   * reasoning, tool calls and usage, and handle a provider error — recover the context, retry, fail over, or stop.
   * Returns 'stop' when the run must end here (interrupted, or an unrecoverable error was reported); a round to be
   * re-asked is marked `round.discardTurn`.
   */
  private async *streamRound(
    st: RunState, round: RoundState, generator: AsyncGenerator<ChatEvent>, chatSpan: ReturnType<ReturnType<typeof getTracer>['startSpan']>,
    options: AgentLoopOptions | undefined, signal: AbortSignal | undefined,
  ): AsyncGenerator<string, 'ok' | 'stop'> {
    for await (const event of generator) {
      // Interrupted mid-stream: stop pulling tokens. Returning here runs the generator's
      // cleanup (.return()), which closes the underlying LLM stream.
      if (signal?.aborted) {
        // Text that already arrived is kept for the user, even while it was still held as a possible fragment.
        if (round.heldFragment) { st.anyTextYielded = true; yield round.heldFragment; round.heldFragment = ''; }
        return 'stop';
      }
      if (event.type === 'token') {
        round.currentContent += event.text;
        // On an operation turn, prose before the first required tool call is not an answer: it is
        // commonly a canned "I cannot access your apps" refusal from a model that ignored the
        // schema. Hold it back until the activation gate below can decide whether the tool was
        // actually called, so a bad first sample never leaks a false capability claim to the UI.
        if (!options?.requireTool || st.requiredToolUsed) {
          if (!round.releasedText) {
            round.heldFragment += event.text;
            if (round.heldFragment.length <= FRAGMENT_HOLD_CHARS && !/\s/.test(round.heldFragment)) continue;
            round.releasedText = true;
            const opening = round.heldFragment;
            round.heldFragment = '';
            if (opening) st.anyTextYielded = true;
            yield opening;
          } else {
            if (event.text) st.anyTextYielded = true;
            yield event.text;
          }
        }
      } else if (event.type === 'truncated') {
        // The model hit the output-token ceiling mid-answer (finish_reason: length), so this reply
        // is CUT OFF, not finished. Decided after the stream ends: auto-continue the turn (persist
        // the partial reply, re-ask) so long answers stitch together — or, past the cap, surface
        // the cutoff in the reply's own voice rather than presenting a half-answer as complete.
        round.turnTruncated = true;
        chatSpan.setAttribute('gen_ai.response.finish_reasons', 'length');
      } else if (event.type === 'thinking') {
        // Internal reasoning: surface to the UI status area, never into the reply
        if (event.replay) round.replayableReasoning += event.text;
        engineEvents.emit('thinking', event.text);
      } else if (event.type === 'tool_call') {
        // gpt-oss can glue harmony tokens to the name; the call and the history keep the clean one (backlog Q1).
        round.toolCalls.push({ ...event, name: cleanToolName(event.name) });
      } else if (event.type === 'tool_call_partial') {
        // Live activity only: show the call forming in the UI while args still stream. The
        // authoritative entry is (re-)emitted by executeTool with the same id, which the UI
        // dedupes, so this never double-runs anything.
        engineEvents.emit('tool_call', {
          id: event.id,
          toolName: event.name,
          input: event.args || '',
          output: '',
          status: 'running',
          startTime: new Date(),
        } as ToolCallEntry);
      } else if (event.type === 'usage') {
        this.contextManager.updateTokens(event.prompt);
        chatSpan.setAttributes({
          'gen_ai.usage.input_tokens': event.prompt,
          'gen_ai.usage.output_tokens': event.completion,
        });
      } else if (event.type === 'error') {
        // An error ends or discards this round here; show a held opening exactly as it would have been shown
        // before fragments were held back.
        if (round.heldFragment) { st.anyTextYielded = true; yield round.heldFragment; round.heldFragment = ''; round.releasedText = true; }
        round.chatErrorMsg = event.message;
        if (event.recoverable && event.kind === 'context') {
          if (await this.recoverFromContextOverflow(st, event.message)) { round.discardTurn = true; break; }

          const diagnostic = 'The task context stayed over the model\'s limit after draining, summarizing, and truncating — stopping this turn to avoid a compaction loop.';
          st.anyTextYielded = true;
          yield diagnostic;
          return 'stop';
        } else {
          const next = yield* this.afterProviderError(st, event, options, signal);
          if (next === 'stop') return 'stop';
          round.discardTurn = true;
          break;
        }
      }
    }
    return 'ok';
  }

  /**
   * The graded recovery for a context rejection: drain old tool results, then compact older context, then truncate to
   * recent turns. A tier earns a retry only when it strictly shrinks the estimated request; a no-op tier falls through at
   * once, so no LLM retry is ever spent on an identically sized request. True when the round should be re-asked.
   */
  private async recoverFromContextOverflow(st: RunState, message: string): Promise<boolean> {
    // Tag the error as a context overflow explicitly: the classifier already decided this
    // (kind === 'context' covers HTTP 413 and provider-specific codes whose MESSAGE text
    // doesn't match reactiveCompact's patterns — e.g. a bare "Request Entity Too Large").
    // Without the tag, reactiveCompact would rethrow and the turn would die un-compacted.
    const ctxErr: any = new Error(message);
    ctxErr.code = 'context_length_exceeded';

    // A no-op tier falls through immediately in THIS error handler; it never spends an LLM
    // retry on an identically-sized request. The strict token comparison is the loop-safety
    // invariant, independent of whether a transform reported that it changed objects.
    while (st.contextRecoveries < st.MAX_CONTEXT_RECOVERIES) {
      const tier = st.contextRecoveries;
      const beforeTokens = this.contextManager.estimateTokens(this.messages);
      let recoveredMessages = this.messages;
      let transformChanged = true;
      let action: string;

      switch (tier) {
        case 0: {
          action = 'draining old tool results';
          const drained = this.contextManager.reactiveDrain(this.messages);
          recoveredMessages = drained.messages;
          transformChanged = drained.changed;
          break;
        }
        case 1:
          action = 'compacting older context';
          recoveredMessages = await this.contextManager.reactiveCompact(this.messages, ctxErr);
          break;
        default:
          action = 'truncating to recent turns';
          recoveredMessages = this.truncateContext(this.messages);
          break;
      }

      const afterTokens = this.contextManager.estimateTokens(recoveredMessages);
      const strictlyShrank = transformChanged && afterTokens < beforeTokens;
      st.contextRecoveries++;

      if (strictlyShrank) {
        if (droppedRecall(this.messages, recoveredMessages)) this.recalled.clear();
        this.messages = recoveredMessages;
        engineEvents.emit('status', `Context overflow — ${action} and retrying (${st.contextRecoveries}/${st.MAX_CONTEXT_RECOVERIES})…`);
        engineEvents.emit('log', {
          id: Date.now(),
          level: 'warn',
          text: `Context recovery tier ${tier} (${action}) reduced the estimate ${beforeTokens} → ${afterTokens} tokens; re-asking.`,
          timestamp: new Date(),
        });
        return true;
      }

      engineEvents.emit('log', {
        id: Date.now(),
        level: 'warn',
        text: `Context recovery tier ${tier} (${action}) did not shrink the estimate (${beforeTokens} → ${afterTokens} tokens); advancing immediately.`,
        timestamp: new Date(),
      });
    }
    return false;
  }

  /**
   * After a provider error that is not a context overflow: back off and re-ask while the transient budget lasts; then
   * fail over to the configured fallback model once; otherwise report the error in the reply. 'retry' re-asks the round.
   */
  private async *afterProviderError(
    st: RunState, event: Extract<ChatEvent, { type: 'error' }>, options: AgentLoopOptions | undefined, signal: AbortSignal | undefined,
  ): AsyncGenerator<string, 'retry' | 'stop'> {
    if (event.recoverable && event.kind === 'transient' && st.transientRetries < st.MAX_TRANSIENT_RETRIES) {
      // A stalled stream, rate limit, or a single bad model emission — discard the partial
      // turn and re-ask. A fresh chat() call rotates the API key and re-samples. BACK OFF
      // first: honor the provider's Retry-After if it sent one, else exponential (1s, 2s),
      // so a 429 isn't immediately hammered (which only deepens the limit).
      st.transientRetries++;
      const backoffMs = event.retryAfterSecs != null
        ? Math.min(event.retryAfterSecs * 1000, 30_000)
        : Math.min(1000 * 2 ** (st.transientRetries - 1), 8000);
      engineEvents.emit('status', `Provider hiccup — retrying in ${Math.round(backoffMs / 1000)}s (${st.transientRetries}/${st.MAX_TRANSIENT_RETRIES})`);
      engineEvents.emit('log', { id: Date.now(), level: 'warn', text: `Transient API error (${event.message}); backing off ${Math.round(backoffMs / 1000)}s.`, timestamp: new Date() });
      // The wait observes cancellation: a 30-second Retry-After used to hold Stop until it ran out
      // (record 49).
      try { await delay(backoffMs, undefined, { signal }); } catch (error) {
        if (signal?.aborted) return 'stop';
        throw error;
      }
      return 'retry';
    }
    // Before declaring the turn dead — transient budget exhausted OR a hard provider
    // rejection — try the configured fallback model ONCE. This is what keeps a day-long
    // autonomous run alive through a model outage or a rate-limit storm: switch the whole
    // session to the fallback, restore the retry budget, and re-ask the same turn.
    // A lite-routed turn runs every step on the QUICK model, so that is the model that failed.
    // The fallback used to replace only the work model: measured live 2026-09-28, the status
    // said "switched to fallback moonshotai/kimi-k3" and both remaining retries still went to the
    // stalled quick model (gpt-oss-20b in both slots), so the failover changed nothing.
    const llmAny = this.llm as any;
    const failing = options?.useLite ? String(llmAny?.liteModel || llmAny?.userModel || '') : undefined;
    const fb = await this.fallbackModelFor(failing);
    if (fb) {
      this.fallbackApplied = true;
      llmAny.applyConfig?.({ model: fb, ...(options?.useLite ? { liteModel: fb } : {}) });
      st.transientRetries = 0;
      engineEvents.emit('status', `Model failing — switched to fallback "${fb}"`);
      engineEvents.emit('log', { id: Date.now(), level: 'warn', text: `Active model kept failing (${event.message}); failed over to fallback model "${fb}".`, timestamp: new Date() });
      // Session-scoped, exactly like the boot healer. This used to persist `fb` so a dead
      // pin would not survive restart — but `fb` is frequently DERIVED (autoSelectCandidates
      // below), so persisting it wrote a machine guess over the model the user chose in the
      // picker, permanently and silently. One failing turn was enough. The user's stored
      // choice is theirs; the failover keeps THIS session alive and says so in the status
      // line, and the next launch starts from what they actually picked.
      engineEvents.emit('config_changed');
      return 'retry';
    }
    // Unrecoverable: this IS the turn's outcome, so it belongs in the reply — but in a human
    // voice, not a "[AgentLoop]" log line. A bad/unknown model ID 400s every turn until
    // changed, so lead with the one thing that fixes it rather than the raw provider dump.
    const m = String(event.message || '');
    if (/model/i.test(m) && /(not a valid|not found|does not exist|unknown model|invalid)/i.test(m)) {
      yield `\n⚠ The provider rejected the current model id — run /model to pick one it serves.\n  (provider said: ${m})\n`;
    } else {
      yield `\n⚠ The provider returned an error: ${event.message}\n`;
    }
    return 'stop';
  }

  /**
   * Run the round's tool calls and put every result into the conversation, in the order the model asked for them —
   * then the checks that react to a batch: a terminal capability blocker, a screenshot to show a vision model, and
   * loop signals. Returns 'stop' when the run was interrupted (the history is left well-formed first).
   */
  /**
   * Get one round's request ready: context passes and recall, this round's tool schemas (none once a terminal blocker is
   * proven), whether the required tool is forced, and the history fitted into what the window leaves after the system
   * prompt, the schemas and the reply's reserve. `overflow` when even the fitted history cannot be sent.
   */
  private async prepareRound(
    st: RunState, systemPrompt: string, options: AgentLoopOptions | undefined, contextMode: ContextMode,
  ): Promise<{ schemas: any[]; forceRequiredTool: boolean; callOutputTokenBudget: number | undefined } | { overflow: string }> {
    await this.prepareContext(contextMode);
    if (options?.skipRepoMap) {
      // ContextManager refreshes the code RepoMap on every round. It is valuable for coding, but
      // actively harmful during a visual-control loop: it adds thousands of irrelevant tokens and
      // invites weak models to inspect the repository instead of the live screen.
      this.messages = this.messages.filter(message => !(
        (message.role === 'system' || message.role === 'user')
        && typeof message.content === 'string'
        && message.content.startsWith('[RepoMap]')
      ));
    }
    // In smart mode the registry returns only the core working set + ToolSearch + any tools the
    // model has already surfaced via ToolSearchTool; in full mode it returns every schema. This
    // is recomputed each turn so a tool discovered mid-task becomes available immediately.
    const callOutputTokenBudget = st.nextOutputTokenBudget;
    const allowedToolNames = options?.toolNames ? new Set(options.toolNames) : null;
    // A specialized turn's explicit allow-list is authoritative. Start from the full registry for
    // an explicit allow-list, then narrow it so dynamically supplied tools remain selectable.
    const schemaPool = allowedToolNames
      ? this.tools.getAllSchemas()
      : this.tools.getSchemas({ mode: contextMode });
    const schemas = (st.operationTerminalBlocker ? [] : schemaPool)
      .filter((schema: any) => !allowedToolNames || allowedToolNames.has(String(schema?.name || '')));
    // Once an external operation starts, prose cannot advance it. Ask the provider to require the
    // named native function until evidence proves the operation complete; then return to auto so
    // the model can provide its final answer. This closes the live failure where a capable model
    // called `open` once, then narrated "I will type" forever despite repeated textual nudges.
    const forceRequiredTool = !st.operationTerminalBlocker
      && options?.requireTool && (!st.requiredToolUsed || st.forceRequiredToolNextRound);
    st.forceRequiredToolNextRound = false;
    // The request boundary (record 50 step 6c): the system prompt, the tool schemas, the reply's reserve and the history
    // share one budget, measured before the request leaves rather than learned from a usage report afterwards.
    const plan = planRequest({
      window: this.contextManager.contextWindow, systemPrompt, tools: schemas, outputBudget: callOutputTokenBudget ?? st.configuredBudget,
    });
    const fitted = plan.messageBudget > 0
      ? await this.contextManager.fitWithin(this.messages, plan.messageBudget)
      : { messages: this.messages, tokens: this.contextManager.requestTokens(this.messages), steps: [] as string[] };
    const recallDropped = droppedRecall(this.messages, fitted.messages);
    this.messages = fitted.messages;
    let messageTokens = fitted.tokens;
    if (recallDropped) {
      // Fitting removed this round's recall block: put it back if there is still room for it (audit 51, U08).
      this.recalled.clear();
      const before = this.messages;
      await this.injectRecall();
      messageTokens = this.contextManager.requestTokens(this.messages);
      if (messageTokens > plan.messageBudget) { this.messages = before; messageTokens = fitted.tokens; }
    }
    const sendable = plan.messageBudget > 0 && messageTokens <= plan.messageBudget;
    this.contextManager.recordRequest({
      ...plan, messages: messageTokens, sent: sendable, steps: fitted.steps,
      residentEvidenceIds: this.contextManager.residentEvidence(this.messages), at: new Date().toISOString(),
    });
    if (!sendable) return { overflow: overflowMessage(plan, messageTokens) };
    return { schemas, forceRequiredTool: !!forceRequiredTool, callOutputTokenBudget };
  }

  /**
   * The reply or a tool call was cut off at the output-token ceiling. A pure-reasoning cutoff raises the next call's
   * budget (bounded); otherwise an unrunnable trailing call is dropped and the answer is continued automatically —
   * headless runs have no one to say "continue" — until the cap, when the cutoff is said in the reply's own voice.
   */
  private async *afterTruncation(
    st: RunState, round: RoundState, pureReasoningOverflow: boolean, callOutputTokenBudget: number | undefined,
  ): AsyncGenerator<string, 'continue' | 'proceed'> {
    if (!round.turnTruncated) return 'proceed';
      if (pureReasoningOverflow && st.reasoningEscalations < st.MAX_REASONING_ESCALATIONS) {
        const previousBudget = callOutputTokenBudget ?? st.configuredBudget;
        st.nextOutputTokenBudget = Math.min(previousBudget * 2, st.MAX_OUTPUT_TOKENS_CEILING);
        st.reasoningEscalations++;
        const message =
          `Reasoning exceeded output budget — raising to ${st.nextOutputTokenBudget} and retrying ` +
          `(${st.reasoningEscalations}/${st.MAX_REASONING_ESCALATIONS}).`;
        engineEvents.emit('status', message);
        engineEvents.emit('log', {
          id: Date.now(),
          level: 'warn',
          text: message,
          timestamp: new Date(),
        });
        return 'continue';
      }
      // A trailing tool call whose args were cut mid-JSON is unrunnable — drop it so the model
      // re-issues it whole next round. Earlier calls in the same turn parsed fine and still run.
      while (round.toolCalls.length > 0) {
        try { JSON.parse(round.toolCalls[round.toolCalls.length - 1].args || '{}'); break; }
        catch { round.toolCalls.pop(); }
      }
      if (round.toolCalls.length === 0 && st.truncationContinues < st.MAX_TRUNCATION_CONTINUES) {
        st.truncationContinues++;
        if (round.currentContent) this.messages.push({
          role: 'assistant', content: round.currentContent,
          ...(round.replayableReasoning ? { reasoning_content: round.replayableReasoning } : {}),
        });
        this.messages.push({
          role: 'user',
          content:
            'Your previous response was cut off by the output-token limit before it finished. ' +
            'Continue from exactly where it stopped — do not repeat anything already written and ' +
            'do not restart the answer. If a tool call was cut off, re-issue it in full; for ' +
            'large files, write them in several smaller pieces (write the first part, then ' +
            'append the rest) so no single call hits the limit.',
        });
        engineEvents.emit('status', `Output limit hit — continuing automatically (${st.truncationContinues}/${st.MAX_TRUNCATION_CONTINUES})`);
        engineEvents.emit('log', { id: Date.now(), level: 'warn', text: `Response hit the output-token ceiling; auto-continuing (${st.truncationContinues}/${st.MAX_TRUNCATION_CONTINUES}).`, timestamp: new Date() });
        return 'continue';
      }
      if (round.toolCalls.length === 0) {
        // Cap exhausted: stop stitching and tell the user, in the reply's own voice.
        const note = '\n\n⚠ *(response hit the max output limit — say "continue" for the rest, or raise it with `/config`)*';
        round.currentContent += note;
        st.anyTextYielded = true;
        yield note;
      }
    return 'proceed';
  }

  /** A tool call the model wrote as plain-text JSON instead of through function calling (see below). */
  private recoverTextToolCalls(st: RunState, round: RoundState, options: AgentLoopOptions | undefined): void {
    // Recover any tool call the model wrote as plain-text JSON instead of via the
    // function-calling API. Gated on real tool names, so user JSON is never run.
    // On an operation turn the required tool is also offered as the owner of a NAMELESS argument
    // object: mid-operation, models drop the wrapper and emit bare `{"action":…}`, which is a
    // complete invocation of the one tool the turn requires. Without this the operation ends
    // silently one action short — the observed "printed the click instead of clicking" failure.
    if (round.toolCalls.length === 0 && round.currentContent) {
      const requiredTool = !st.operationTerminalBlocker && options?.requireTool
        ? this.tools.getTool(options.requireTool) : undefined;
      const recovered = extractTextToolCalls(round.currentContent, (n) => !!this.tools.getTool(n), {
        ...(requiredTool ? { defaultTool: { name: requiredTool.name, schema: requiredTool.schema } } : {}),
      });
      if (recovered.toolCalls.length > 0) {
        round.toolCalls.push(...recovered.toolCalls);
        // The visible text was just a malformed invocation wrapper ("The final
        // answer is {json}"); drop it — the real prose answer arrives after the
        // tool returns and the loop runs again.
        round.currentContent = '';
        Logger.warn(`[AgentLoop] Recovered ${round.toolCalls.length} tool call(s) the model emitted as text.`);
      }
    }
  }

  /**
   * The operation gates of a turn that requires a capability (`options.requireTool`): the activation gate (the model must
   * call it) and the completion gate (a turn that only opened or observed has not done what was asked). Both bounded,
   * so a model that cannot proceed still ends honestly.
   */
  private async *operationGates(
    st: RunState, round: RoundState, options: AgentLoopOptions | undefined,
  ): AsyncGenerator<string, 'continue' | 'stop' | 'proceed'> {
    // Specialized operation turns must begin by attempting their real capability. The generic
    // empty-turn correction says "reply in plain text"; on a required-capability task that can cause
    // the exact observed failure: hidden reasoning ended empty, then the retry confidently claimed
    // it had no app access. Re-ask for the required tool instead, bounded so a model that cannot
    // call tools still terminates honestly. This is capability-level routing, not an app workflow.
    if (!st.operationTerminalBlocker && options?.requireTool && !st.requiredToolUsed) {
      const hasRequiredCall = round.toolCalls.some(tc => tc.name === options.requireTool);
      if (hasRequiredCall) {
        // Drop any pre-tool narration/refusal that was deliberately withheld above. The post-tool
        // round will produce the real, evidence-backed user-facing answer.
        round.currentContent = '';
      } else if (round.toolCalls.length > 0) {
        // Let bookkeeping/approval tools run before the operation tool. Multi-step provider work
        // may legitimately create a checklist or outcome contract first; the gate applies to
        // termination, not to the exact ordering of preparatory tool calls.
        round.currentContent = '';
      } else if (st.requiredToolNudges < st.MAX_REQUIRED_TOOL_NUDGES) {
        st.requiredToolNudges++;
        round.currentContent = '';
        this.messages.push({
          role: 'user',
          content:
            `[OPERATION ACTIVATION GATE] This request requires ${options.requireTool}, which is ` +
            `available in this session, but your last turn did not call it. Do not answer with ` +
            `instructions or claim you lack access. Call ${options.requireTool} now with the ` +
            `smallest safe first action grounded in the user's request.`,
        });
        engineEvents.emit('status', `Activating ${options.requireTool} for this operation…`);
        return 'continue';
      } else {
        reportCapability({ id: 'tool-activation', label: 'Requested capability', state: 'unavailable',
          reason: `The model did not invoke ${options.requireTool} after ${st.MAX_REQUIRED_TOOL_NUDGES} retries.`,
          impact: 'The requested operation was not performed.', action: 'Retry with a tool-capable model.' });
        const note = `\nThe active model did not invoke ${options.requireTool} after ${st.MAX_REQUIRED_TOOL_NUDGES} attempts, so the operation was not performed. Try a tool-capable model or retry the task.\n`;
        st.anyTextYielded = true;
        yield note;
        return 'stop';
      }
    }

    // [OPERATION COMPLETION GATE] The activation gate proves the capability was reached; this one
    // asks whether the operation was actually attempted. A turn that only opened, focused or
    // observed has acquired a target and nothing more, so ending it here would present setup as
    // completion — and, with a small controller, the "answer" is often text read off the very
    // screenshot it just captured.
    //
    // Bounded exactly like the activation gate, and for the same reason: a model that genuinely
    // cannot proceed must still terminate honestly rather than loop. A request that truly only
    // asked to open an app costs one extra round here and then finishes, which is the right
    // trade against silently reporting an unperformed operation as done.
    if (!st.operationTerminalBlocker && options?.requireTool && st.requiredToolUsed && !st.sawAdvancingAction
      && st.lastCapabilitySucceeded && round.toolCalls.length === 0) {
      if (st.completionNudges < st.MAX_COMPLETION_NUDGES) {
        st.completionNudges++;
        round.currentContent = '';
        this.messages.push({
          role: 'user',
          content:
            `[OPERATION COMPLETION GATE] So far this turn has only acquired or inspected a target ` +
            `with ${options.requireTool}; nothing the user asked for has been changed yet. Do not ` +
            `answer with what you saw, and never repeat text read off the screen as your reply. ` +
            `Either call ${options.requireTool} now with the next action that actually advances ` +
            `the user's request, or state the one concrete blocker the newest result proves. If ` +
            `the request was only to open or inspect something, say so plainly in one sentence.`,
        });
        engineEvents.emit('status', 'Completing the requested operation…');
        return 'continue';
      }
      Logger.warn('[AgentLoop] Operation ended after preparatory capability calls only.');
    }
    return 'proceed';
  }

  /**
   * The round's tool calls made safe to record and run: exact duplicates dropped, arguments repaired into JSON, and the
   * user's own constraints (an exact word count, a document's requirements) applied before anything is persisted.
   */
  private prepareToolCalls(round: RoundState): void {
    // Drop identical tool calls the model sometimes emits twice in one turn (e.g. cd x2): same name
    // + same args = redundant work and duplicate output. Keep the first of each.
    if (round.toolCalls.length > 1) {
      const seen = new Set<string>();
      const unique = round.toolCalls.filter(tc => {
        const key = `${tc.name}:${tc.args}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (unique.length < round.toolCalls.length) {
        Logger.warn(`[AgentLoop] Dropped ${round.toolCalls.length - unique.length} duplicate tool call(s).`);
        round.toolCalls.length = 0;
        round.toolCalls.push(...unique);
      }
    }

    // Exact prose lengths are user constraints, not optional model hints. Enrich Write calls from
    // the live conversation BEFORE persisting their arguments or executing them: this recognizes
    // typo-tolerant requests such as "200 wrd" and carries the target through follow-ups like
    // "make it horror". WriteFileTool then rejects an approximate draft before disk mutation.
    for (const tc of round.toolCalls) {
      // Repair into a parseable object BEFORE applying deterministic user constraints. Small
      // tool-tuned models often emit the right rough call with one broken quote. Previously the
      // constraint compilers saw invalid JSON and had to leave it untouched; the generic repair
      // ran afterwards, producing a valid but unconstrained coordinate click.
      // A call cut off at the output-token limit is never bracket-closed: that would run half of it as if it were whole.
      const emitted = canonicalToolArgs(tc.args, { closeBrackets: !tc.truncated });
      if (emitted?.repaired) {
        Logger.warn(`[AgentLoop] Repaired malformed ${tc.name} argument JSON before execution.`);
        tc.args = emitted.json;
      }
      if (tc.name === 'WriteFileTool') tc.args = applyImplicitWriteConstraints(tc.args, this.messages);
      if (tc.name === 'DocumentTool') tc.args = applyImplicitDocumentConstraints(tc.args, this.messages);
      const canonical = canonicalToolArgs(tc.args, { closeBrackets: !tc.truncated });
      if (canonical?.repaired) {
        Logger.warn(`[AgentLoop] Repaired malformed ${tc.name} argument JSON before execution.`);
        tc.args = canonical.json;
      }
    }
  }

  /**
   * The model answered without a tool call: may the turn end? Not while steering is unread, the reply was pure filler or
   * empty, its own todo list or outcome contract is open, a document is only a draft, or a completion check fails —
   * each re-asks, bounded. Then the checks' verdict and, if nothing was ever shown, a note instead of silence.
   */
  private async *endOfTurn(
    st: RunState, round: RoundState, sanitized: { wasPureFiller: boolean }, options: AgentLoopOptions | undefined,
    context: any, signal: AbortSignal | undefined,
  ): AsyncGenerator<string, 'continue' | 'stop'> {
    // Steering that arrived during this last step: the task is not over until it has been read (F7).
    if (hasSteer()) { this.takeSteering(); return 'continue'; }
    // A turn with no tool call that collapsed to pure filler gave the user
    // nothing. Rather than silently ending on an empty reply, nudge the model
    // once to answer directly and let the loop run again. Guarded against spin.
    if (sanitized.wasPureFiller && !st.pureFillerRetried) {
      st.pureFillerRetried = true;
      this.messages.push({
        role: 'user',
        content:
          'Your previous reply contained no answer — only a remark about tool usage. ' +
          'Respond now with the actual answer to the request. If no tool is needed, ' +
          'give the answer directly; do not mention tools or function calls.',
      });
      return 'continue';
    }
    // Persistence ("beast mode"): if the model tries to stop but its own todo list still has open
    // items, push it to keep going instead of handing back half-done. Bounded so it can't spin.
    // Only auto-continue when THIS turn is actively working the checklist. The list is now
    // durable across turns (for prompt injection), so without this gate a stray follow-up
    // message after a task with open items would wrongly force a continue.
    const incomplete = todosTouchedThisTurn()
      ? getActiveTodos().filter(t => t.status !== 'completed')
      : [];
    if (incomplete.length > 0 && st.persistenceNudges < st.MAX_PERSISTENCE_NUDGES) {
      st.persistenceNudges++;
      this.messages.push({
        role: 'user',
        content:
          `You stopped, but the task isn't finished — these items on your own todo list are still open:\n` +
          incomplete.map(t => `- ${t.content} (${t.status})`).join('\n') +
          `\nKeep working through them now. Don't hand back until they're all completed — or, if you're genuinely blocked, say exactly what's blocking and why.`,
      });
      return 'continue';
    }
    // Outcome convergence: TodoWrite covers procedural steps; the engine-owned contract covers
    // the actual user outcome and attributed proof. If this turn actively touched a contract and
    // its gate is still closed (or open but not formally finished), keep working instead of
    // allowing a confident prose "done" to terminate the run. A genuine user-required blocker
    // returns an empty nudge, so the agent can hand control back honestly.
    if (st.documentDraftPending && st.persistenceNudges < st.MAX_PERSISTENCE_NUDGES) {
      st.persistenceNudges++;
      this.messages.push({ role: 'user', content: 'The DocumentTool draft has NOT been written to an output file. Continue the retained draft with new paragraphs or replace a block to meet the requested word count, then call finalize. Do not claim that the PDF exists while it is only a draft.' });
      return 'continue';
    }
    let outcomeNudge = '';
    try {
      outcomeNudge = getOutcomeManager().continuationPrompt();
    } catch { /* root outcome runtime is optional in workers/tests */ }
    if (outcomeNudge && st.persistenceNudges < st.MAX_PERSISTENCE_NUDGES) {
      st.persistenceNudges++;
      this.messages.push({ role: 'user', content: outcomeNudge });
      return 'continue';
    }
    // A turn that produced nothing the user can see — no streamed text this turn, no
    // tool call, and not caught by the pure-filler path above (e.g. a reasoning/coding
    // model that emitted only `reasoning_content` then ended empty, or a model that went
    // silent right after a tool result). Ending here would leave the user staring at a
    // stopped spinner. Nudge once for a direct answer; bounded so it can't spin.
    // Note: st.anyTextYielded is intentionally NOT checked here — text from earlier tool-call
    // rounds (or leaked think> fragments) must not suppress the retry for an empty final turn.
    if (!round.currentContent && !st.emptyTurnRetried) {
      st.emptyTurnRetried = true;
      this.messages.push({
        role: 'user',
        content:
          'You returned an empty response. Reply now with your actual answer to the ' +
          'request in plain text. If you already have everything you need (including any ' +
          'tool results above), just write the answer directly.',
      });
      return 'continue';
    }
    // Completion checks (F3): before the turn may end "done", the engine runs the task's checks itself and grades
    // them by the exit code and files it observed. A failure within the retry limit sends the task back to work.
    const completion = getCompletionChecks();
    if (completion && !signal?.aborted) {
      const verdict = await completion.settle((command) => this.runCheckCommand(command, context, signal, options?.sessionId), context?.cwd || process.cwd());
      if ('continue' in verdict) {
        this.messages.push({ role: 'user', content: verdict.continue });
        return 'continue';
      }
      if (verdict.end) { yield verdict.end; st.anyTextYielded = true; }
    }
    // No tool calls and nothing left open — task complete. If the entire call produced
    // no visible text at all, say so rather than returning dead silence.
    if (!st.anyTextYielded) {
      yield `\nNo response was produced. Try rephrasing, or press Ctrl+T to pin the model tier.\n`;
    }
    return 'stop';
  }

  private async *run(
    initialMessages: Message[],
    systemPrompt: string,
    options?: AgentLoopOptions,
    context?: any
  ): AsyncGenerator<string> {
    this.messages = [...initialMessages];
    const latestRequest = [...initialMessages].reverse().find(m => m.role === 'user')?.content;
    // A narrow, explicit export request has an observable delivery requirement. Reuse the bounded
    // activation gate; making the schema visible alone did not make weak models call it.
    if (!options?.requireTool && typeof latestRequest === 'string'
      && /^(?:(?:please|can you|could you)\s+)?(?:create|produce|generate|write|export|make|build)\b[\s\S]{0,160}?(?:\bword document\b|\bpowerpoint\b|\bexcel (?:workbook|spreadsheet)\b|\bpdf\b|\.docx\b|\.pptx\b|\.xlsx\b)/i.test(latestRequest.trim())
      && this.tools.getTool('DocumentTool')) {
      options = { ...options, requireTool: 'DocumentTool' };
    }
    // Limits, counters and flags of this run (agent.run.state.ts).
    const st = new RunState(this.llm, options?.maxIterations);
    const contextMode = options?.contextMode ?? 'smart';
    // Cooperative cancellation: the front-end's interrupt aborts this signal. We don't tear the
    // in-flight fetch down mid-byte; we stop at the next safe boundary (next streamed token, or
    // before the next tool batch / loop iteration) so history stays well-formed.
    const signal = options?.signal;
    // Fresh loop detector per execute() call — tracks tool-call patterns across turns.
    const loopDetector = new LoopDetector();
    // Black-box recorder: every execute() is an episode — each LLM call in this run is
    // recorded (request hash + response stream) to a bundle under .bimax/episodes/,
    // self-flushing per call. /episodes replays it; BIMAX_RECORDER=0 disables.
    const recordedLlm = startEpisodeRecording(this.llm).llm;

    // OTel GenAI trace: one invoke_agent span per execute(), with a chat span per LLM round and
    // an execute_tool span per tool call nested under it. Exported as JSONL (+OTLP when
    // configured) — see src/telemetry/trace.ts. The finally below covers every return path,
    // including generator cleanup when the consumer stops iterating.
    const tracer = getTracer();
    const rootSpan = tracer.startSpan('invoke_agent bimax', {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'bimax',
    });
    // Per-task counters. A nested execute() (sub-agent) is ignored by begin(), so the outer task
    // keeps owning the turn count — see src/telemetry/task.metrics.ts.
    taskMetrics.begin(options?.metricsLabel);
    try {

    for (let i = 0; i < st.maxIter; i++) {
      // Interrupted between turns: stop cleanly before spending another model call.
      if (signal?.aborted) return;
      // Steering (F7): what the user added while the task worked joins the conversation before the next model call.
      this.takeSteering();
      // NOTE: the Grok-ported power-aware 4s backoff between tool iterations was removed. Power
      // policy may constrain NEW background/sub-agent work (see spawn.tool.ts) but must never
      // stall the user's active interactive turn.
      // 1. Layered context management (smart mode runs the cheap passes + summarize-on-pressure;
      //    full mode is a no-op here and relies on reactive compaction if the API rejects the size).
      // 0. Automatic recall, BEFORE compaction so the injected block is subject to the same
      //    passes as everything else — a recall that could not be compacted would be the one thing
      //    in the window that grows without limit.
      const prepared = await this.prepareRound(st, systemPrompt, options, contextMode);
      if ('overflow' in prepared) {
        st.anyTextYielded = true;
        yield prepared.overflow;
        return;
      }
      const { schemas, forceRequiredTool, callOutputTokenBudget } = prepared;
      const generator = recordedLlm.chat(this.messages, {
        system: systemPrompt,
        tools: schemas as any,
        ...(callOutputTokenBudget !== undefined ? { maxTokens: callOutputTokenBudget } : {}),
        // Tier routing: when the turn was routed to the lite model, every step of this loop
        // (incl. tool-call follow-ups) runs on lite. Heavy turns leave this unset → coding model.
        lite: options?.useLite,
        ...(forceRequiredTool ? {
          toolChoice: { type: 'function' as const, function: { name: options!.requireTool! } },
        } : {}),
        // CRITICAL: thread the interrupt signal into the request so Ctrl+C/esc aborts the underlying
        // fetch IMMEDIATELY. Without it the signal only took effect between stream events — so a hung
        // cold-starting model (no chunks) couldn't be stopped until the 60–180s timeout ("no stop
        // button"). Now an abort cancels the in-flight request at once.
        signal,
      });
      // The escalation applies to this retry only. A later pure-reasoning overflow may schedule
      // another bounded override after observing the budget this call consumed.
      st.nextOutputTokenBudget = undefined;

      // What this round produces (agent.run.state.ts).
      const round = new RoundState();

      st.llmRounds++;
      taskMetrics.recordTurn();
      const chatSpan = tracer.startSpan(
        `chat ${String((this.llm as any)?.userModel || (this.llm as any)?.defaultModel || 'unknown')}`,
        {
          'gen_ai.operation.name': 'chat',
          'gen_ai.request.model': String((this.llm as any)?.userModel || (this.llm as any)?.defaultModel || 'unknown'),
          'bimax.chat.round': i + 1,
          ...(options?.useLite ? { 'bimax.chat.lite': true } : {}),
        },
        rootSpan.context
      );

      let streamed: 'ok' | 'stop' = 'ok';
      try {
        streamed = yield* this.streamRound(st, round, generator, chatSpan, options, signal);
      } finally {
        // Covers clean completion, round.discardTurn breaks, unrecoverable returns, AND abort-driven
        // generator cleanup. Error status only for real provider errors — a discarded/compacted
        // turn is a normal control-flow event, not a failure.
        chatSpan.setAttribute('bimax.chat.tool_calls', round.toolCalls.length);
        chatSpan.end(round.chatErrorMsg && !round.discardTurn ? 'error' : 'ok', round.discardTurn ? undefined : round.chatErrorMsg);
      }

      if (streamed === 'stop') return;
      // Discard the partial turn and let the outer loop re-ask (after compaction or a
      // transient retry). Any tokens already streamed to stdout are intentionally not
      // persisted to history, so the message log stays well-formed.
      if (round.discardTurn) continue;

      // A reply still held back is decided now that the whole round is in: show it, or — when it is the
      // entire answer, with no tool call and no cutoff, and only a stray fragment — ask once more.
      if (round.heldFragment) {
        const fragment = round.heldFragment;
        round.heldFragment = '';
        if (round.toolCalls.length === 0 && !round.turnTruncated && !st.strayFragmentRetried && isStrayFragment(fragment)) {
          st.strayFragmentRetried = true;
          Logger.warn(`[AgentLoop] Reply was only the fragment ${JSON.stringify(fragment)}; asking the model once more.`);
          this.messages.push({
            role: 'user',
            content: `[INCOMPLETE REPLY] Your last reply was only "${fragment}", which does not answer the request. ` +
              `Answer my last message fully, or call the tool you need.`,
          });
          continue;
        }
        st.anyTextYielded = true;
        yield fragment;
      }

      // Enforce the output contract: strip leaked tool-meta filler before it can
      // land in the reply or the history, and learn whether the turn was nothing but.
      const sanitized = responseSanitizer.sanitize(round.currentContent);
      round.currentContent = sanitized.text;
      const pureReasoningOverflow = round.turnTruncated && round.toolCalls.length === 0 && !round.currentContent;

      // Reached here ⇒ the stream completed cleanly (no transient error broke us out). Reset the
      // transient budget so it means "2 CONSECUTIVE failures", not "2 per entire run". Without this a
      // single early network blip permanently spends the budget, and a later unrelated blip — hours
      // into a long autonomous run — would kill the loop instead of retrying.
      st.transientRetries = 0;
      st.contextRecoveries = 0;
      // A pure-reasoning cutoff is not a completed turn: retain its escalation state for the retry.
      // Any content/tool-producing or otherwise clean turn returns subsequent calls to the normal
      // configured budget and starts a fresh escalation ladder.
      if (!pureReasoningOverflow) {
        st.nextOutputTokenBudget = undefined;
        st.reasoningEscalations = 0;
      }

      // Output-token cutoff: the reply (or a tool call) was severed mid-stream. A human can say
      // "continue"; headless/print runs cannot — so the loop continues for them, stitching the
      // answer together across rounds. Bounded by st.MAX_TRUNCATION_CONTINUES.
      if ((yield* this.afterTruncation(st, round, pureReasoningOverflow, callOutputTokenBudget)) === 'continue') continue;

      this.recoverTextToolCalls(st, round, options);

      const gate = yield* this.operationGates(st, round, options);
      if (gate === 'stop') return;
      if (gate === 'continue') continue;

      if (round.currentContent) {
        this.messages.push({
          role: 'assistant', content: round.currentContent,
          ...(round.replayableReasoning ? { reasoning_content: round.replayableReasoning } : {}),
        });
      }

      this.prepareToolCalls(round);

      if (round.toolCalls.length > 0) {
        if (await runToolRound(this.toolRoundHost(), st, round, options, context, signal, loopDetector, rootSpan) === 'stop') return;
        // Loop continues so LLM can react to tool results
      } else {
        if ((yield* this.endOfTurn(st, round, sanitized, options, context, signal)) === 'continue') continue;
        return;
      }
    }

    yield `\n⚠ Stopped after ${st.maxIter} rounds without finishing — say "continue" to pick up where this left off.\n`;

    } finally {
      rootSpan.setAttributes({
        'bimax.agent.llm_rounds': st.llmRounds,
        ...(signal?.aborted ? { 'bimax.agent.interrupted': true } : {}),
      });
      rootSpan.end();
      // Close the task on every exit path, including throw and interrupt. An interrupted task is
      // recorded but flagged, so its short turn count is never read as efficiency.
      if (signal?.aborted) taskMetrics.markInterrupted();
      taskMetrics.end();
    }
  }
}
