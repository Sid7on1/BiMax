import { LLMProvider, Message, ChatEvent } from './llm.provider';
import { responseSanitizer } from './response.sanitizer';
import { extractTextToolCalls } from './tool.call.parser';
import { ToolRegistry } from '../tools/tool.registry';
import { IGovernor } from './interfaces';
import { Logger } from '../utils';
import { ContextManager } from '../memory/context.manager';
import type { VectorStore } from '../memory/vector.store';
import { recallForTurn, recallKey, recallQuery } from '../memory/recall';
import { cliEvents, ToolCallEntry } from '../cli/events';
import { getActiveTodos, todosTouchedThisTurn } from '../tools/implementations/todo.tool';
import { LoopDetector, LoopSignal } from './loop-detector';
import { getGlobalPatternStore } from '../genome/pattern.store';
import { globalTelemetry } from '../telemetry/telemetry';
import { taskMetrics } from '../telemetry/task.metrics';
import { getSelfModel, domainOf, pathOf, classifyOutcome, currentModelKey } from '../mind/self.model';
import { TypedOutcome, typedFromError } from '../tools/outcome';
import { getEventLedger } from '../mind/event.ledger';
import { markToolTaint } from '../mind/taint';
import { getHabitMiner } from '../mind/habit.compiler';
import { getEpistemicLedger, isEvidenceCommand } from '../mind/epistemic.ledger';
import { startEpisodeRecording, isReplayActive } from '../mind/episode.recorder';
import { getTracer } from '../telemetry/trace';
import { requiresBuildVerification } from '../review/verification.scope';
import { applyImplicitWriteConstraints } from '../tools/write.constraints';
import { screenshotFromToolResult, buildScreenshotObservation, appendScreenshotObservation, pruneScreenshotObservations, contentToText, isScreenshotObservationMessage } from './multimodal';
import { canonicalToolArgs } from './tool.args';

/** Mutating tools whose success is an implicit "this change is correct" claim. */
export const CLAIMING_TOOLS = new Set(['EditFileTool', 'WriteFileTool', 'MultiEditTool', 'SymbolEditTool']);

export interface AgentLoopOptions {
  maxIterations?: number;
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

/**
 * Coerce a model-emitted tool-call arguments string to VALID JSON before it enters the message
 * history. The OpenAI tool-call contract requires `function.arguments` to be a JSON string, and many
 * providers (NVIDIA NIM) re-parse it on the NEXT request — so one truncated emission like `{"query": "`
 * would otherwise 400 every subsequent turn ("Unterminated string … char 10") until the user /clears.
 * Valid args are re-stringified canonically; anything unparseable becomes `{}`.
 */
export function sanitizeToolArgs(raw: any): string {
  return canonicalToolArgs(raw)?.json || '{}';
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
    private memoryStore?: VectorStore
  ) {
    this.contextManager = contextManager ?? new ContextManager(llm, maxContextTokens);
  }

  /**
   * The fallback model to fail over to, or null when there's nothing sensible to do: none
   * configured, already failed over, or the fallback IS the currently failing model.
   */
  private async fallbackModelFor(): Promise<string | null> {
    if (this.fallbackApplied) return null;
    // Env beats config so headless/autonomous runs (and tests) can arm the chain per-process.
    let fb = String(process.env.BIMAX_FALLBACK_MODEL || '').trim();
    if (!fb) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        fb = String((require('../cli/config') as typeof import('../cli/config')).getConfig().fallbackModel || '').trim();
      } catch { return null; }
    }
    const llm = this.llm as any;
    const current = String(llm?.userModel || llm?.defaultModel || '');

    // Failing over is the machine choosing a model on the user's behalf, so it obeys the same
    // safety policy as healing. Two ways a configured fallback disqualifies itself:
    //   • the provider already rejected it outright this session (proven dead), or
    //   • the catalog flags it avoidAutoSelect (documented to time out or to not call tools).
    // Honouring such a fallback converts a visible model error into an invisible 180s hang, which
    // is strictly worse: the user sees a spinner and no reply. (Live case: the configured fallback
    // was stepfun-ai/step-3.7-flash, which sent no response headers for 180s.)
    if (fb) {
      let unsafe = false;
      try { unsafe = !!llm?.isUnservable?.(fb); } catch { /* optional capability */ }
      if (!unsafe) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { MODEL_CATALOG } = require('../cli/models') as typeof import('../cli/models');
        unsafe = MODEL_CATALOG.some(m => m.value === fb && m.avoidAutoSelect);
      }
      if (unsafe) {
        Logger.warn(`[AgentLoop] Configured fallback model "${fb}" is not a safe automatic target; deriving one instead.`);
        fb = '';
      }
    }

    // No usable configured fallback — derive one from the curated policy, restricted to what the
    // provider actually serves. Better a working model than none: the alternative is a dead turn.
    if (!fb) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { autoSelectCandidates } = require('../cli/models') as typeof import('../cli/models');
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
  private recalled = new Set<string>();

  /**
   * Retrieve against the latest user message and inject what comes back.
   *
   * Guarded by `recallQuery`, which is pure and tested separately. Failure is silent by design:
   * recall is an enhancement, and a memory lookup must never be able to fail a user's turn.
   */
  private async injectRecall(): Promise<void> {
    if (!this.memoryStore) return;
    const last = [...this.messages].reverse().find((m) => m.role === 'user');
    if (!last) return;

    const query = recallQuery(last.role, last.content, this.recalled);
    if (!query) return;
    this.recalled.add(recallKey(query));

    const recalled = await recallForTurn(this.memoryStore, query).catch(() => null);
    if (!recalled) return;

    // Placed before the user's message, so the model reads the evidence and then the question —
    // and so the block is attributable to the system rather than appearing to be something the
    // user said.
    const at = this.messages.lastIndexOf(last);
    this.messages.splice(at, 0, { role: 'system', content: recalled.text } as typeof last);
  }

  private truncateContext(messages: Message[], keepRecentTurns = 4): Message[] {
    const systemMessages = messages.filter(message => message.role === 'system');
    const nonSystemMessages = messages.filter(message => message.role !== 'system');
    let recentMessages = nonSystemMessages.slice(-keepRecentTurns);
    while (recentMessages[0]?.role === 'tool') recentMessages = recentMessages.slice(1);
    return [...systemMessages, ...recentMessages];
  }

  async *execute(
    initialMessages: Message[],
    systemPrompt: string,
    options?: AgentLoopOptions,
    context?: any
  ): AsyncGenerator<string> {
    this.messages = [...initialMessages];
    // Env override for headless/benchmark runs: a hard task can legitimately need hundreds of
    // rounds, and there the wall clock (container/task timeout) is the real budget, not this.
    const maxIter = options?.maxIterations
      ?? (parseInt(process.env.BIMAX_MAX_ITERATIONS || '', 10) || 500);
    const contextMode = options?.contextMode ?? 'smart';
    // Cooperative cancellation: the front-end's interrupt aborts this signal. We don't tear the
    // in-flight fetch down mid-byte; we stop at the next safe boundary (next streamed token, or
    // before the next tool batch / loop iteration) so history stays well-formed.
    const signal = options?.signal;
    // Fresh loop detector per execute() call — tracks tool-call patterns across turns.
    const loopDetector = new LoopDetector();
    // Bounds the regenerate-on-empty correction below to a single retry, so a model
    // that keeps emitting pure filler can never spin the loop.
    let pureFillerRetried = false;
    // Bounds the recovery for a turn that produced NOTHING at all — no text and no tool
    // call (e.g. a reasoning/coding model that streamed only `reasoning_content` then ended
    // with empty content, or a model that went silent right after a tool result). Without
    // this the loop would `return` on the empty turn and the user would see a stopped
    // spinner and no answer. Single retry so a persistently-empty model can't spin.
    let emptyTurnRetried = false;
    // Whether any visible text has been streamed to the user across the whole call. If the
    // loop is about to end having shown nothing, we surface a note instead of silent silence.
    let anyTextYielded = false;
    // Bounds re-asks after a transient provider/model error (stalled stream, 5xx, a
    // single malformed tool-call emission) so a deterministically-failing turn can't
    // spin the loop, while a flaky one still gets a fresh attempt (new key / re-sample).
    let transientRetries = 0;
    const MAX_TRANSIENT_RETRIES = 2;
    // A context rejection gets one bounded pass through the graded recovery ladder: cheap tool
    // result draining, existing reactive compaction, then a hard recent-turn truncation. A tier
    // only earns a retry when it strictly reduces the estimated request size.
    let contextRecoveries = 0;
    const MAX_CONTEXT_RECOVERIES = 3;
    // Bounds the auto-continue after an output-token cutoff (finish_reason: length). Long
    // code-writing answers legitimately need several rounds to finish, but a model stuck
    // re-emitting the ceiling forever must not spin the loop. Headless/print runs depend on
    // this — there is no user there to say "continue".
    let truncationContinues = 0;
    const MAX_TRUNCATION_CONTINUES =
      parseInt(process.env.BIMAX_MAX_CONTINUES || '', 10) || 12;
    // A per-call override above the active model's own max-output limit can be rejected outright;
    // keep automatic escalation conservative and let operators lower this ceiling when necessary.
    const MAX_OUTPUT_TOKENS_CEILING =
      parseInt(process.env.BIMAX_MAX_OUTPUT_CEILING || '', 10) || 16384;
    const MAX_REASONING_ESCALATIONS = 3;
    let nextOutputTokenBudget: number | undefined;
    let reasoningEscalations = 0;
    const providerConfiguredBudget = Number((this.llm as LLMProvider & { maxTokens?: number }).maxTokens);
    const configuredBudget = Number.isFinite(providerConfiguredBudget) && providerConfiguredBudget > 0
      ? Math.floor(providerConfiguredBudget)
      : 4096;
    // Bounds the "keep going while todos are open" persistence below, so a model that refuses to
    // finish (or keeps re-opening items) can't spin the loop forever.
    let persistenceNudges = 0;
    const MAX_PERSISTENCE_NUDGES = 4;
    let requiredToolUsed = false;
    let requiredToolNudges = 0;
    const MAX_REQUIRED_TOOL_NUDGES = 2;
    // Armed only after an unresolved operation round returned prose/emptiness instead of acting.
    // The next provider request then names the required function explicitly. Successful action
    // rounds return to auto selection so AskUserTool remains reachable for real ambiguities.
    let forceRequiredToolNextRound = false;
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
    let llmRounds = 0;
    // Per-task counters. A nested execute() (sub-agent) is ignored by begin(), so the outer task
    // keeps owning the turn count — see src/telemetry/task.metrics.ts.
    taskMetrics.begin(options?.metricsLabel);
    try {

    for (let i = 0; i < maxIter; i++) {
      // Interrupted between turns: stop cleanly before spending another model call.
      if (signal?.aborted) return;
      // NOTE: the Grok-ported power-aware 4s backoff between tool iterations was removed. Power
      // policy may constrain NEW background/sub-agent work (see spawn.tool.ts) but must never
      // stall the user's active interactive turn.
      // 1. Layered context management (smart mode runs the cheap passes + summarize-on-pressure;
      //    full mode is a no-op here and relies on reactive compaction if the API rejects the size).
      // 0. Automatic recall, BEFORE compaction so the injected block is subject to the same
      //    passes as everything else — a recall that could not be compacted would be the one thing
      //    in the window that grows without limit.
      await this.injectRecall();
      this.messages = await this.contextManager.checkAndCompact(this.messages, contextMode);
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
      const callOutputTokenBudget = nextOutputTokenBudget;
      const allowedToolNames = options?.toolNames ? new Set(options.toolNames) : null;
      // A specialized turn's explicit allow-list is authoritative. Start from the full registry for
      // an explicit allow-list, then narrow it so dynamically supplied tools remain selectable.
      const schemaPool = allowedToolNames
        ? this.tools.getAllSchemas()
        : this.tools.getSchemas({ mode: contextMode });
      const schemas = schemaPool
        .filter((schema: any) => !allowedToolNames || allowedToolNames.has(String(schema?.name || '')));
      // Once an external operation starts, prose cannot advance it. Ask the provider to require the
      // named native function until evidence proves the operation complete; then return to auto so
      // the model can provide its final answer. This closes the live failure where a capable model
      // called `open` once, then narrated "I will type" forever despite repeated textual nudges.
      const forceRequiredTool = options?.requireTool && (!requiredToolUsed || forceRequiredToolNextRound);
      forceRequiredToolNextRound = false;
      const generator = recordedLlm.chat(this.messages, {
        system: systemPrompt,
        tools: schemas as any,
        ...(callOutputTokenBudget !== undefined ? { maxTokens: callOutputTokenBudget } : {}),
        // Tier routing: when the turn was routed to the lite model, every step of this loop
        // (incl. tool-call follow-ups) runs on lite. Heavy turns leave this unset → coding model.
        lite: options?.useLite,
        ...(forceRequiredTool ? {
          toolChoice: { type: 'function' as const, function: { name: options.requireTool! } },
        } : {}),
        // CRITICAL: thread the interrupt signal into the request so Ctrl+C/esc aborts the underlying
        // fetch IMMEDIATELY. Without it the signal only took effect between stream events — so a hung
        // cold-starting model (no chunks) couldn't be stopped until the 60–180s timeout ("no stop
        // button"). Now an abort cancels the in-flight request at once.
        signal,
      });
      // The escalation applies to this retry only. A later pure-reasoning overflow may schedule
      // another bounded override after observing the budget this call consumed.
      nextOutputTokenBudget = undefined;

      // `truncated` is set when the model hit the output-token ceiling while still writing this
      // call's arguments — see the parse-failure branch, which needs to tell the two causes apart.
      const toolCalls: { id: string; name: string; args: string; truncated?: boolean }[] = [];
      let currentContent = '';
      // Set when the partial turn must be discarded and re-asked (after compaction or
      // a transient-error retry); triggers the `continue` below.
      let discardTurn = false;
      // Set when the model hit the output-token ceiling this round (finish_reason: length);
      // handled after the stream ends — auto-continue, or surface the cutoff if capped.
      let turnTruncated = false;

      llmRounds++;
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
      let chatErrorMsg: string | undefined;

      try {
      for await (const event of generator) {
        // Interrupted mid-stream: stop pulling tokens. Returning here runs the generator's
        // cleanup (.return()), which closes the underlying LLM stream.
        if (signal?.aborted) return;
        if (event.type === 'token') {
          currentContent += event.text;
          // On an operation turn, prose before the first required tool call is not an answer: it is
          // commonly a canned "I cannot access your apps" refusal from a model that ignored the
          // schema. Hold it back until the activation gate below can decide whether the tool was
          // actually called, so a bad first sample never leaks a false capability claim to the UI.
          if (!options?.requireTool || requiredToolUsed) {
            if (event.text) anyTextYielded = true;
            yield event.text;
          }
        } else if (event.type === 'truncated') {
          // The model hit the output-token ceiling mid-answer (finish_reason: length), so this reply
          // is CUT OFF, not finished. Decided after the stream ends: auto-continue the turn (persist
          // the partial reply, re-ask) so long answers stitch together — or, past the cap, surface
          // the cutoff in the reply's own voice rather than presenting a half-answer as complete.
          turnTruncated = true;
          chatSpan.setAttribute('gen_ai.response.finish_reasons', 'length');
        } else if (event.type === 'thinking') {
          // Internal reasoning: surface to the UI status area, never into the reply
          cliEvents.emit('thinking', event.text);
        } else if (event.type === 'tool_call') {
          toolCalls.push(event);
        } else if (event.type === 'tool_call_partial') {
          // Live activity only: show the call forming in the UI while args still stream. The
          // authoritative entry is (re-)emitted by executeTool with the same id, which the UI
          // dedupes, so this never double-runs anything.
          cliEvents.emit('tool_call', {
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
          chatErrorMsg = event.message;
          if (event.recoverable && event.kind === 'context') {
            // Tag the error as a context overflow explicitly: the classifier already decided this
            // (kind === 'context' covers HTTP 413 and provider-specific codes whose MESSAGE text
            // doesn't match reactiveCompact's patterns — e.g. a bare "Request Entity Too Large").
            // Without the tag, reactiveCompact would rethrow and the turn would die un-compacted.
            const ctxErr: any = new Error(event.message);
            ctxErr.code = 'context_length_exceeded';

            // A no-op tier falls through immediately in THIS error handler; it never spends an LLM
            // retry on an identically-sized request. The strict token comparison is the loop-safety
            // invariant, independent of whether a transform reported that it changed objects.
            while (contextRecoveries < MAX_CONTEXT_RECOVERIES) {
              const tier = contextRecoveries;
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
              contextRecoveries++;

              if (strictlyShrank) {
                this.messages = recoveredMessages;
                cliEvents.emit('status', `Context overflow — ${action} and retrying (${contextRecoveries}/${MAX_CONTEXT_RECOVERIES})…`);
                cliEvents.emit('log', {
                  id: Date.now(),
                  level: 'warn',
                  text: `Context recovery tier ${tier} (${action}) reduced the estimate ${beforeTokens} → ${afterTokens} tokens; re-asking.`,
                  timestamp: new Date(),
                });
                discardTurn = true;
                break;
              }

              cliEvents.emit('log', {
                id: Date.now(),
                level: 'warn',
                text: `Context recovery tier ${tier} (${action}) did not shrink the estimate (${beforeTokens} → ${afterTokens} tokens); advancing immediately.`,
                timestamp: new Date(),
              });
            }

            if (discardTurn) break;

            const diagnostic = 'The task context stayed over the model\'s limit after draining, summarizing, and truncating — stopping this turn to avoid a compaction loop.';
            anyTextYielded = true;
            yield diagnostic;
            return;
          } else if (event.recoverable && event.kind === 'transient' && transientRetries < MAX_TRANSIENT_RETRIES) {
            // A stalled stream, rate limit, or a single bad model emission — discard the partial
            // turn and re-ask. A fresh chat() call rotates the API key and re-samples. BACK OFF
            // first: honor the provider's Retry-After if it sent one, else exponential (1s, 2s),
            // so a 429 isn't immediately hammered (which only deepens the limit).
            transientRetries++;
            const backoffMs = event.retryAfterSecs != null
              ? Math.min(event.retryAfterSecs * 1000, 30_000)
              : Math.min(1000 * 2 ** (transientRetries - 1), 8000);
            cliEvents.emit('status', `Provider hiccup — retrying in ${Math.round(backoffMs / 1000)}s (${transientRetries}/${MAX_TRANSIENT_RETRIES})`);
            cliEvents.emit('log', { id: Date.now(), level: 'warn', text: `Transient API error (${event.message}); backing off ${Math.round(backoffMs / 1000)}s.`, timestamp: new Date() });
            await new Promise(r => setTimeout(r, backoffMs));
            discardTurn = true;
            break;
          } else {
            // Before declaring the turn dead — transient budget exhausted OR a hard provider
            // rejection — try the configured fallback model ONCE. This is what keeps a day-long
            // autonomous run alive through a model outage or a rate-limit storm: switch the whole
            // session to the fallback, restore the retry budget, and re-ask the same turn.
            const fb = await this.fallbackModelFor();
            if (fb) {
              this.fallbackApplied = true;
              (this.llm as any).applyConfig?.({ model: fb });
              transientRetries = 0;
              cliEvents.emit('status', `Model failing — switched to fallback "${fb}"`);
              cliEvents.emit('log', { id: Date.now(), level: 'warn', text: `Active model kept failing (${event.message}); failed over to fallback model "${fb}".`, timestamp: new Date() });
              // Persist it. Without this the dead pin survives restart, and because /models still
              // lists it, startup healing calls it healthy — so every future session burns a
              // guaranteed-404 round trip before failing over to this same model again.
              // origin:'runtime' keeps the volatility guard's protection for BGW_MODEL sessions.
              // Awaited, not fire-and-forget: an unawaited write outlives the turn and can land
              // after the process (or a test's environment) has torn down.
              try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                await (require('../cli/config') as typeof import('../cli/config')).saveConfig({ model: fb } as any, { origin: 'runtime' });
                cliEvents.emit('config_changed');
              } catch { /* persistence optional */ }
              discardTurn = true;
              break;
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
            return;
          }
        }
      }
      } finally {
        // Covers clean completion, discardTurn breaks, unrecoverable returns, AND abort-driven
        // generator cleanup. Error status only for real provider errors — a discarded/compacted
        // turn is a normal control-flow event, not a failure.
        chatSpan.setAttribute('bimax.chat.tool_calls', toolCalls.length);
        chatSpan.end(chatErrorMsg && !discardTurn ? 'error' : 'ok', discardTurn ? undefined : chatErrorMsg);
      }

      // Discard the partial turn and let the outer loop re-ask (after compaction or a
      // transient retry). Any tokens already streamed to stdout are intentionally not
      // persisted to history, so the message log stays well-formed.
      if (discardTurn) continue;

      // Enforce the output contract: strip leaked tool-meta filler before it can
      // land in the reply or the history, and learn whether the turn was nothing but.
      const sanitized = responseSanitizer.sanitize(currentContent);
      currentContent = sanitized.text;
      const pureReasoningOverflow = turnTruncated && toolCalls.length === 0 && !currentContent;

      // Reached here ⇒ the stream completed cleanly (no transient error broke us out). Reset the
      // transient budget so it means "2 CONSECUTIVE failures", not "2 per entire run". Without this a
      // single early network blip permanently spends the budget, and a later unrelated blip — hours
      // into a long autonomous run — would kill the loop instead of retrying.
      transientRetries = 0;
      contextRecoveries = 0;
      // A pure-reasoning cutoff is not a completed turn: retain its escalation state for the retry.
      // Any content/tool-producing or otherwise clean turn returns subsequent calls to the normal
      // configured budget and starts a fresh escalation ladder.
      if (!pureReasoningOverflow) {
        nextOutputTokenBudget = undefined;
        reasoningEscalations = 0;
      }

      // Output-token cutoff: the reply (or a tool call) was severed mid-stream. A human can say
      // "continue"; headless/print runs cannot — so the loop continues for them, stitching the
      // answer together across rounds. Bounded by MAX_TRUNCATION_CONTINUES.
      if (turnTruncated) {
        if (pureReasoningOverflow && reasoningEscalations < MAX_REASONING_ESCALATIONS) {
          const previousBudget = callOutputTokenBudget ?? configuredBudget;
          nextOutputTokenBudget = Math.min(previousBudget * 2, MAX_OUTPUT_TOKENS_CEILING);
          reasoningEscalations++;
          const message =
            `Reasoning exceeded output budget — raising to ${nextOutputTokenBudget} and retrying ` +
            `(${reasoningEscalations}/${MAX_REASONING_ESCALATIONS}).`;
          cliEvents.emit('status', message);
          cliEvents.emit('log', {
            id: Date.now(),
            level: 'warn',
            text: message,
            timestamp: new Date(),
          });
          continue;
        }
        // A trailing tool call whose args were cut mid-JSON is unrunnable — drop it so the model
        // re-issues it whole next round. Earlier calls in the same turn parsed fine and still run.
        while (toolCalls.length > 0) {
          try { JSON.parse(toolCalls[toolCalls.length - 1].args || '{}'); break; }
          catch { toolCalls.pop(); }
        }
        if (toolCalls.length === 0 && truncationContinues < MAX_TRUNCATION_CONTINUES) {
          truncationContinues++;
          if (currentContent) this.messages.push({ role: 'assistant', content: currentContent });
          this.messages.push({
            role: 'user',
            content:
              'Your previous response was cut off by the output-token limit before it finished. ' +
              'Continue from exactly where it stopped — do not repeat anything already written and ' +
              'do not restart the answer. If a tool call was cut off, re-issue it in full; for ' +
              'large files, write them in several smaller pieces (write the first part, then ' +
              'append the rest) so no single call hits the limit.',
          });
          cliEvents.emit('status', `Output limit hit — continuing automatically (${truncationContinues}/${MAX_TRUNCATION_CONTINUES})`);
          cliEvents.emit('log', { id: Date.now(), level: 'warn', text: `Response hit the output-token ceiling; auto-continuing (${truncationContinues}/${MAX_TRUNCATION_CONTINUES}).`, timestamp: new Date() });
          continue;
        }
        if (toolCalls.length === 0) {
          // Cap exhausted: stop stitching and tell the user, in the reply's own voice.
          const note = '\n\n⚠ *(response hit the max output limit — say "continue" for the rest, or raise it with `/config`)*';
          currentContent += note;
          anyTextYielded = true;
          yield note;
        }
      }

      // Recover any tool call the model wrote as plain-text JSON instead of via the
      // function-calling API. Gated on real tool names, so user JSON is never run.
      // On an operation turn the required tool is also offered as the owner of a NAMELESS argument
      // object: mid-operation, models drop the wrapper and emit bare `{"action":…}`, which is a
      // complete invocation of the one tool the turn requires. Without this the operation ends
      // silently one action short — the observed "printed the click instead of clicking" failure.
      if (toolCalls.length === 0 && currentContent) {
        const requiredTool = options?.requireTool ? this.tools.getTool(options.requireTool) : undefined;
        const recovered = extractTextToolCalls(currentContent, (n) => !!this.tools.getTool(n), {
          ...(requiredTool ? { defaultTool: { name: requiredTool.name, schema: requiredTool.schema } } : {}),
        });
        if (recovered.toolCalls.length > 0) {
          toolCalls.push(...recovered.toolCalls);
          // The visible text was just a malformed invocation wrapper ("The final
          // answer is {json}"); drop it — the real prose answer arrives after the
          // tool returns and the loop runs again.
          currentContent = '';
          Logger.warn(`[AgentLoop] Recovered ${toolCalls.length} tool call(s) the model emitted as text.`);
        }
      }

      // Specialized operation turns must begin by attempting their real capability. The generic
      // empty-turn correction says "reply in plain text"; on a required-capability task that can cause
      // the exact observed failure: hidden reasoning ended empty, then the retry confidently claimed
      // it had no app access. Re-ask for the required tool instead, bounded so a model that cannot
      // call tools still terminates honestly. This is capability-level routing, not an app workflow.
      if (options?.requireTool && !requiredToolUsed) {
        const hasRequiredCall = toolCalls.some(tc => tc.name === options.requireTool);
        if (hasRequiredCall) {
          // Drop any pre-tool narration/refusal that was deliberately withheld above. The post-tool
          // round will produce the real, evidence-backed user-facing answer.
          currentContent = '';
        } else if (toolCalls.length > 0) {
          // Let bookkeeping/approval tools run before the operation tool. Multi-step provider work
          // may legitimately create a checklist or outcome contract first; the gate applies to
          // termination, not to the exact ordering of preparatory tool calls.
          currentContent = '';
        } else if (requiredToolNudges < MAX_REQUIRED_TOOL_NUDGES) {
          requiredToolNudges++;
          currentContent = '';
          this.messages.push({
            role: 'user',
            content:
              `[OPERATION ACTIVATION GATE] This request requires ${options.requireTool}, which is ` +
              `available in this session, but your last turn did not call it. Do not answer with ` +
              `instructions or claim you lack access. Call ${options.requireTool} now with the ` +
              `smallest safe first action grounded in the user's request.`,
          });
          cliEvents.emit('status', `Activating ${options.requireTool} for this operation…`);
          continue;
        } else {
          const note = `\nThe active model did not invoke ${options.requireTool} after ${MAX_REQUIRED_TOOL_NUDGES} attempts, so the operation was not performed. Try a tool-capable model or retry the task.\n`;
          anyTextYielded = true;
          yield note;
          return;
        }
      }

      if (currentContent) {
        this.messages.push({ role: 'assistant', content: currentContent });
      }

      // Drop identical tool calls the model sometimes emits twice in one turn (e.g. cd x2): same name
      // + same args = redundant work and duplicate output. Keep the first of each.
      if (toolCalls.length > 1) {
        const seen = new Set<string>();
        const unique = toolCalls.filter(tc => {
          const key = `${tc.name}:${tc.args}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (unique.length < toolCalls.length) {
          Logger.warn(`[AgentLoop] Dropped ${toolCalls.length - unique.length} duplicate tool call(s).`);
          toolCalls.length = 0;
          toolCalls.push(...unique);
        }
      }

      // Exact prose lengths are user constraints, not optional model hints. Enrich Write calls from
      // the live conversation BEFORE persisting their arguments or executing them: this recognizes
      // typo-tolerant requests such as "200 wrd" and carries the target through follow-ups like
      // "make it horror". WriteFileTool then rejects an approximate draft before disk mutation.
      for (const tc of toolCalls) {
        // Repair into a parseable object BEFORE applying deterministic user constraints. Small
        // tool-tuned models often emit the right rough call with one broken quote. Previously the
        // constraint compilers saw invalid JSON and had to leave it untouched; the generic repair
        // ran afterwards, producing a valid but unconstrained coordinate click.
        const emitted = canonicalToolArgs(tc.args);
        if (emitted?.repaired) {
          Logger.warn(`[AgentLoop] Repaired malformed ${tc.name} argument JSON before execution.`);
          tc.args = emitted.json;
        }
        if (tc.name === 'WriteFileTool') tc.args = applyImplicitWriteConstraints(tc.args, this.messages);
        const canonical = canonicalToolArgs(tc.args);
        if (canonical?.repaired) {
          Logger.warn(`[AgentLoop] Repaired malformed ${tc.name} argument JSON before execution.`);
          tc.args = canonical.json;
        }
      }

      if (toolCalls.length > 0) {
        // Interrupted right after the model asked for tools: don't start running them. The
        // assistant turn is already persisted above; we just stop before side effects.
        if (signal?.aborted) return;
        // Build the tool_calls payload for the assistant message
        const asstMsg: Message = { role: 'assistant', tool_calls: [] };
        if (currentContent) asstMsg.content = currentContent;

        for (const tc of toolCalls) {
          asstMsg.tool_calls!.push({
            id: tc.id,
            type: 'function',
            // CRITICAL: tool-call arguments MUST be valid JSON before they go into history. A model can
            // emit truncated/malformed args (e.g. a cut-off `{"query": "`); storing that raw poisons
            // EVERY later request — providers re-validate the arguments string as JSON and reject the
            // whole call ("Unterminated string … char 10"), so the session wedges until /clear. Coerce
            // to canonical JSON, falling back to `{}` so a bad emission can never corrupt the history.
            function: { name: tc.name, arguments: sanitizeToolArgs(tc.args) }
          });
        }
        
        // Replace the plain assistant message with the one containing tool_calls
        if (currentContent) {
            this.messages.pop(); 
        }
        this.messages.push(asstMsg);

        const executableCalls = toolCalls;

        // Partition into parallel (safe) and sequential (destructive).
        const parallel = executableCalls.filter(tc => this.tools.getTool(tc.name)?.isConcurrencySafe);
        const sequential = executableCalls.filter(tc => !this.tools.getTool(tc.name)?.isConcurrencySafe);

        const executeTool = async (tc: { id: string, name: string, args: string, truncated?: boolean }) => {
          if (options?.requireTool && tc.name === options.requireTool) requiredToolUsed = true;
          const toolSpan = tracer.startSpan(`execute_tool ${tc.name}`, {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': tc.name,
          }, rootSpan.context);
          // Announce the call so the UI can render live tool activity
          const entry: ToolCallEntry = {
            id: tc.id,
            toolName: tc.name,
            input: tc.args || '{}',
            output: '',
            status: 'running',
            startTime: new Date(),
          };
          cliEvents.emit('tool_call', entry);

          const finish = (result: string, isError: boolean, typed?: TypedOutcome) => {
            const endTime = new Date();
            const durationMs = endTime.getTime() - entry.startTime.getTime();
            globalTelemetry.recordToolCall(tc.name, durationMs);
            // Generalized failure memory (docs/RESEARCH_LEDGER.md): consecutive identical failures
            // of the SAME action exhaust a per-operation-class retry budget, and the model is told
            // to change strategy instead of looping. BrowserTool is excluded — its runtime has a
            // page-state-aware loop detector that sees URL/element state this layer can't.
            if (tc.name !== 'BrowserTool') try {
              const { getFailureMemory } = require('./failure.memory');
              const verdict = getFailureMemory().report(
                { tool: tc.name, args: tc.args || '{}' },
                {
                  ok: !isError && typed?.status !== 'error',
                  errorClass: typed?.errorClass,
                  exitCode: typed?.exitCode,
                  resultSample: isError ? result.slice(0, 500) : undefined,
                },
              );
              if (verdict.exhausted && verdict.note) result = `${result}\n\n⟳ ${verdict.note}`;
            } catch { /* failure memory is an observer — never breaks execution */ }
            // Mind layer: feed the self-model (learned failure rates → routing hints) and the
            // habit miner (recurring tool sequences → compiled habits). Both are best-effort
            // observers — they must never be able to break tool execution. During a replay
            // these stand down entirely: re-observing recorded experience as fresh evidence
            // would double-count every outcome the system already learned from.
            if (!isReplayActive()) try {
              // Typed outcome (v2 Phase 0): prefer the tool's own declaration — ground truth.
              // The regex classifier is the explicit low-confidence fallback for unswept/MCP tools.
              // 'blocked' (policy said no) joins 'rejected' as preference/policy data, never a
              // failure-rate sample.
              const outcome: 'ok' | 'err' | 'rejected' = typed
                ? (typed.status === 'ok' ? 'ok' : typed.status === 'error' ? 'err' : 'rejected')
                : classifyOutcome(result, isError);
              const domain = domainOf(tc.name, tc.args || '{}');
              // Taint (v2 D3): web/MCP output entering the conversation marks the session
              // untrusted — the governor then denies network capability until a human clears it.
              markToolTaint(tc.name, tc.args || '{}', result);
              let bashCmd: string | undefined;
              if (tc.name === 'BashTool') {
                try { bashCmd = String(JSON.parse(tc.args || '{}').command || '') || undefined; } catch { /* unparseable */ }
              }
              // Prefix the declared error class so weak-spot samples carry the label.
              const errSample = outcome === 'err'
                ? (typed?.errorClass ? `[${typed.errorClass}] ${result}` : result).slice(0, 200)
                : undefined;
              // Event ledger (v2 D1): every tool outcome lands in the append-only log with
              // its typed label AND everything a view rebuild needs (model key, bash cmd,
              // touched file, error sample) — the raw material learned state is refolded from.
              getEventLedger().append('tool_outcome', {
                tool: tc.name, domain,
                status: typed?.status ?? outcome,
                errorClass: typed?.errorClass,
                exitCode: typed?.exitCode,
                confidence: typed ? 'high' : 'low',
                model: currentModelKey(),
                cmd: bashCmd,
                file: pathOf(tc.args || '{}'),
                errSample,
                durationMs, isError,
              });
              if (outcome !== 'rejected') {
                getSelfModel().record(tc.name, domain, outcome === 'ok', errSample);
              }
              getHabitMiner().observe(tc.name, domain, outcome === 'ok', bashCmd);
              // Epistemic ledger: a successful mutation opens a correctness claim (confidence
              // grounded in the self-model, scoped to the mutated FILE); a build/test/typecheck
              // run is evidence that resolves only the claims it covers — red output must name
              // the claim's file, green repo-wide runs cover everything in the window.
              if (outcome === 'ok' && CLAIMING_TOOLS.has(tc.name)) {
                const claimFile = pathOf(tc.args || '{}');
                // Review records every successful mutation, including prose/media artifacts.
                cliEvents.emit('review_change', { tool: tc.name, file: claimFile, callId: tc.id });
                // Build/test verification is meaningful only for code/config-like artifacts. A
                // story.txt or image still appears in Review, but must not open a claim that ends
                // the turn with the nonsensical instruction to run a build/test.
                if (requiresBuildVerification(claimFile)) {
                  const conf = getSelfModel().confidenceFor(tc.name, domain);
                  getEpistemicLedger().openClaim(domain, conf, claimFile);
                  getEventLedger().append('claim', { tool: tc.name, domain, file: claimFile, confidence: conf });
                  toolSpan.setAttribute('bimax.claim.confidence', Number(conf.toFixed(4)));
                }
              } else if (tc.name === 'BashTool' && bashCmd && isEvidenceCommand(bashCmd)) {
                // Exit code (when Bash declared it) beats the regex guess: a red tsc/test run
                // returns its output with exit≠0 and used to classify 'ok', silently settling
                // claims as GREEN. Ground truth ends that.
                const evidenceOk = typed?.exitCode !== undefined ? typed.exitCode === 0 : outcome === 'ok';
                const resolution = getEpistemicLedger().resolveDetailed(evidenceOk, { command: bashCmd, output: result });
                const { settled, coveredFiles, repoWide } = resolution;
                getEventLedger().append('evidence', {
                  command: bashCmd.slice(0, 200), ok: evidenceOk, settled, coveredFiles, repoWide,
                });
                // Review domain: verification truth with the REAL exit code, at the moment it lands.
                cliEvents.emit('review_evidence', { command: bashCmd, ok: evidenceOk, settled, coveredFiles, repoWide });
              }
            } catch { /* observers are best-effort */ }
            cliEvents.emit('tool_call_result', {
              ...entry,
              output: result,
              status: isError ? 'error' : 'success',
              endTime,
              // Additive typed-outcome fields — the TUI ignores unknown JSON keys.
              ...(typed ? { outcome: typed.status, errorClass: typed.errorClass } : {}),
            } as ToolCallEntry);
            if (typed?.errorClass) toolSpan.setAttribute('bimax.tool.error_class', typed.errorClass);
            toolSpan.end(isError ? 'error' : 'ok', isError ? result.slice(0, 200) : undefined);
            return { id: tc.id, result, isError };
          };

          let argsObj: any;
          try {
            argsObj = JSON.parse(tc.args || '{}');
          } catch (e) {
            // Distinguish the two causes, because the fix differs and the model can only act on one
            // of them. A call cut off at the output-token ceiling is OUR limit being reached — the
            // model did nothing wrong and re-emitting the same call verbatim would fail again;
            // splitting the work is what helps. Genuinely malformed JSON is a re-emit.
            return finish(
              tc.truncated
                ? `Tool call was cut off at the output-token limit, so its arguments are incomplete JSON `
                  + `(received ${(tc.args || '').length} characters). Nothing was executed. Re-issue it as a `
                  + `smaller call — fewer arguments, or the work split across several calls.`
                : `Failed to parse arguments as JSON, so nothing was executed. Re-issue the call with `
                  + `valid JSON. Received: ${tc.args}`,
              true,
            );
          }

          const tool = this.tools.getTool(tc.name);
          if (!tool) {
            return finish(`Tool ${tc.name} not found.`, true);
          }

          try {
            // Thread the interrupt signal into the tool so a long-running one (e.g. a 30s Bash)
            // is killed the instant esc is hit, rather than running to completion first.
            // reportOutcome is the typed-outcome side-channel: the factory fires it when the
            // tool declared its own status (v2 Phase 0), so learning gets labels, not guesses.
            let typed: TypedOutcome | undefined;
            const toolContext = {
              ...(context || { cwd: process.cwd() }), signal,
              sessionId: options?.sessionId,
              reportOutcome: (o: TypedOutcome) => { typed = o; },
              // The LIVE conversation array for this loop, so context-management tools
              // (FreeContextTool) can act on the real session context, not a stale copy.
              sessionMessages: this.messages,
            };
            const result = await tool.execute(argsObj, toolContext);
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            return finish(resultStr, false, typed);
          } catch (e: any) {
            const text = `Tool Error: ${e.message}`;
            return finish(text, true, typedFromError(e, text));
          }
        };

        const resultById = new Map<string, { result: string; isError: boolean }>();
        const parallelResults = await Promise.all(parallel.map(tc => executeTool(tc)));
        for (const res of parallelResults) resultById.set(res.id, { result: res.result, isError: res.isError });
        let interrupted = false;
        for (const tc of sequential) {
          // Interrupted mid-chain: stop before starting the next tool so esc halts a continuous
          // run of tool calls promptly, instead of waiting out the whole batch + another model call.
          if (signal?.aborted) { interrupted = true; break; }
          const res = await executeTool(tc);
          resultById.set(res.id, { result: res.result, isError: res.isError });
        }

        // Push tool results in the SAME order the model emitted the calls, and answer EVERY
        // tool_call. Two correctness reasons: (1) an assistant tool_calls message left partially
        // answered — any id without a matching tool result — makes the NEXT request 400 on strict
        // OpenAI-compatible backends (so un-run tools after an interrupt get an explicit stub, never
        // a gap); (2) results were previously pushed as "all parallel, then all sequential", an order
        // that didn't match the tool_calls order — order-sensitive servers reject that, and weaker
        // models misread which result belongs to which call.
        const loopSignals: LoopSignal[] = [];
        const screenshotPaths: Array<{
          path: string;
          source: string;
          action?: string;
          width?: number;
          height?: number;
          frameId?: string;
          app?: string;
          pid?: number;
          windowId?: number;
          displayScreenshot?: string;
          displayWidth?: number;
          displayHeight?: number;
        }> = [];
        for (const tc of toolCalls) {
          const ran = resultById.get(tc.id);
          const result = ran ? ran.result : 'Tool call interrupted before it ran.';
          this.messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          if (ran) {
            const sig = loopDetector.record(tc.name, tc.args, result, ran.isError);
            if (sig) loopSignals.push(sig);
            const shot = screenshotFromToolResult(tc.name, result);
            if (shot) {
              let metadata: any = {};
              try { metadata = JSON.parse(result); } catch { /* path alone remains useful */ }
              screenshotPaths.push({
                path: shot,
                source: tc.name,
                action: typeof metadata?.action === 'string' ? metadata.action : undefined,
                width: Number.isFinite(Number(metadata?.width)) ? Number(metadata.width) : undefined,
                height: Number.isFinite(Number(metadata?.height)) ? Number(metadata.height) : undefined,
                frameId: typeof metadata?.frameId === 'string' ? metadata.frameId : undefined,
                app: typeof metadata?.app === 'string' ? metadata.app : undefined,
                pid: Number.isFinite(Number(metadata?.pid)) ? Number(metadata.pid) : undefined,
                windowId: Number.isFinite(Number(metadata?.windowId)) ? Number(metadata.windowId) : undefined,
                displayScreenshot: typeof metadata?.displayScreenshot === 'string' ? metadata.displayScreenshot : undefined,
                displayWidth: Number.isFinite(Number(metadata?.displayWidth)) ? Number(metadata.displayWidth) : undefined,
                displayHeight: Number.isFinite(Number(metadata?.displayHeight)) ? Number(metadata.displayHeight) : undefined,
              });
            }
          }
        }
        // History is now well-formed (every tool_call answered) even on interrupt — so stop here
        // instead of leaving a dangling turn, and the next user message appends to a valid log.
        if (interrupted) return;

        // Vision observation loop: a browser screenshot this batch produced becomes an image the
        // model actually SEES on its next turn — but only when the active model advertises vision
        // (text-only models keep the plain JSON result). Old observations are pruned so image
        // bytes never pile up in history. Best-effort end to end: no vision, no file, or an
        // adapter without capability introspection simply attaches nothing.
        if (screenshotPaths.length > 0) {
          try {
            // canSeeImages covers BOTH a vision-capable primary AND a configured vision slot —
            // the adapter reroutes image turns to the vision model automatically.
            const canSee = (this.llm as any).canSeeImages?.()
              ?? (await (this.llm as any).activeCapabilities?.())?.visionInput;
            if (canSee) {
              const newest = screenshotPaths[screenshotPaths.length - 1];
              const observation = buildScreenshotObservation(newest.path, newest);
              if (observation) {
                appendScreenshotObservation(this.messages, observation);
                pruneScreenshotObservations(this.messages);
              }
            }
          } catch { /* vision attachment must never break the loop */ }
        }

        // One mind-strip refresh per tool batch (not per call): the footer's 🧠 counters
        // (weak spots / drive deviations / habits) re-snapshot after the batch lands.
        try { cliEvents.emit('mind_changed' as any); } catch { /* best-effort */ }

        // Handle any loop signals collected this turn
        if (loopSignals.length > 0) {
          const worst = loopSignals.sort((a, b) => b.count - a.count)[0];
          // Log to genome pattern store (best-effort, non-blocking)
          try { getGlobalPatternStore()?.appendLoopSignal(worst.type, worst.tool, worst.argsHash, worst.severity); } catch { /* ignore */ }
          if (worst.severity === 'hard') {
            // The loop_detected event renders its own visible line in the TUI — no reply-stream
            // narration on top of it (the answer must stay the model's voice alone).
            cliEvents.emit('status', `Loop broken — "${worst.tool}" repeated ${worst.count}×, steering the model away`);
            cliEvents.emit('loop_detected' as any, worst);
            this.messages.push({
              role: 'user',
              content: worst.type === 'error_thrashing'
                ? `[LOOP DETECTED — HARD STOP] "${worst.tool}" has FAILED ${worst.count} times in a row, even as you ` +
                  `changed its arguments. Retrying with another small tweak is not working. STOP and change strategy: ` +
                  `re-read the current state before acting again (e.g. read the exact file/region you're editing, or run a ` +
                  `command to inspect reality), fix the root cause of the error, or use a different tool entirely. ` +
                  `If you are genuinely blocked, explain exactly what is blocking you instead of trying again.`
                : `[LOOP DETECTED — HARD STOP] You called "${worst.tool}" ${worst.count} times with the same ` +
                  `arguments and got the same result. This is a loop. STOP immediately. ` +
                  `Take a completely different approach — try a different tool, a different strategy, or a different argument. ` +
                  `If you are genuinely blocked, explain exactly what is blocking you instead of repeating the same call.`,
            });
          } else {
            Logger.warn(`[LoopGuard] Soft loop: ${worst.type} on "${worst.tool}" (${worst.count}×)`);
            this.messages.push({
              role: 'user',
              content: worst.type === 'error_thrashing'
                ? `[Loop Warning] "${worst.tool}" has failed ${worst.count} times. Before trying again, verify your ` +
                  `assumptions — re-read the exact target or inspect the current state so the next attempt fixes the ` +
                  `real cause instead of guessing.`
                : `[Loop Warning] "${worst.tool}" has been called with similar arguments ${worst.count} times. ` +
                  `Consider whether this approach is making progress, or try a different strategy.`,
            });
          }
        }

        // Loop continues so LLM can react to tool results
      } else {
        // A turn with no tool call that collapsed to pure filler gave the user
        // nothing. Rather than silently ending on an empty reply, nudge the model
        // once to answer directly and let the loop run again. Guarded against spin.
        if (sanitized.wasPureFiller && !pureFillerRetried) {
          pureFillerRetried = true;
          this.messages.push({
            role: 'user',
            content:
              'Your previous reply contained no answer — only a remark about tool usage. ' +
              'Respond now with the actual answer to the request. If no tool is needed, ' +
              'give the answer directly; do not mention tools or function calls.',
          });
          continue;
        }
        // Persistence ("beast mode"): if the model tries to stop but its own todo list still has open
        // items, push it to keep going instead of handing back half-done. Bounded so it can't spin.
        // Only auto-continue when THIS turn is actively working the checklist. The list is now
        // durable across turns (for prompt injection), so without this gate a stray follow-up
        // message after a task with open items would wrongly force a continue.
        const incomplete = todosTouchedThisTurn()
          ? getActiveTodos().filter(t => t.status !== 'completed')
          : [];
        if (incomplete.length > 0 && persistenceNudges < MAX_PERSISTENCE_NUDGES) {
          persistenceNudges++;
          this.messages.push({
            role: 'user',
            content:
              `You stopped, but the task isn't finished — these items on your own todo list are still open:\n` +
              incomplete.map(t => `- ${t.content} (${t.status})`).join('\n') +
              `\nKeep working through them now. Don't hand back until they're all completed — or, if you're genuinely blocked, say exactly what's blocking and why.`,
          });
          continue;
        }
        // Outcome convergence: TodoWrite covers procedural steps; the engine-owned contract covers
        // the actual user outcome and attributed proof. If this turn actively touched a contract and
        // its gate is still closed (or open but not formally finished), keep working instead of
        // allowing a confident prose "done" to terminate the run. A genuine user-required blocker
        // returns an empty nudge, so the agent can hand control back honestly.
        let outcomeNudge = '';
        try {
          const { getOutcomeManager } = require('../outcome/outcome.manager') as typeof import('../outcome/outcome.manager');
          outcomeNudge = getOutcomeManager().continuationPrompt();
        } catch { /* root outcome runtime is optional in workers/tests */ }
        if (outcomeNudge && persistenceNudges < MAX_PERSISTENCE_NUDGES) {
          persistenceNudges++;
          this.messages.push({ role: 'user', content: outcomeNudge });
          continue;
        }
        // A turn that produced nothing the user can see — no streamed text this turn, no
        // tool call, and not caught by the pure-filler path above (e.g. a reasoning/coding
        // model that emitted only `reasoning_content` then ended empty, or a model that went
        // silent right after a tool result). Ending here would leave the user staring at a
        // stopped spinner. Nudge once for a direct answer; bounded so it can't spin.
        // Note: anyTextYielded is intentionally NOT checked here — text from earlier tool-call
        // rounds (or leaked think> fragments) must not suppress the retry for an empty final turn.
        if (!currentContent && !emptyTurnRetried) {
          emptyTurnRetried = true;
          this.messages.push({
            role: 'user',
            content:
              'You returned an empty response. Reply now with your actual answer to the ' +
              'request in plain text. If you already have everything you need (including any ' +
              'tool results above), just write the answer directly.',
          });
          continue;
        }
        // No tool calls and nothing left open — task complete. If the entire call produced
        // no visible text at all, say so rather than returning dead silence.
        if (!anyTextYielded) {
          yield `\nNo response was produced. Try rephrasing, or press Ctrl+T to pin the model tier.\n`;
        }
        return;
      }
    }

    yield `\n⚠ Stopped after ${maxIter} rounds without finishing — say "continue" to pick up where this left off.\n`;

    } finally {
      rootSpan.setAttributes({
        'bimax.agent.llm_rounds': llmRounds,
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
