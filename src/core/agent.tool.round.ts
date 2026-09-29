import type { Message, LLMProvider } from './llm.provider';
import type { ToolRegistry } from '../tools/tool.registry';
import type { AgentLoopOptions } from './agent.loop';
import { reportCapability } from './capability.status';
import { Logger } from '../utils';
import { engineEvents, ToolCallEntry } from '../engine/events';
import { getGlobalPatternStore } from '../genome/pattern.store';
import { recordUsage } from '../mind/usage.counters';
import { TypedOutcome, typedFromError } from '../tools/outcome';
import { fenceUntrusted } from '../mind/taint';
import { isReplayActive } from '../mind/episode.recorder';
import { getTracer } from '../telemetry/trace';
import { type ScreenshotObservationContext, screenshotFromToolResult, buildScreenshotObservation, appendScreenshotObservation, pruneScreenshotObservations } from './multimodal';
import { checkToolArgs, argsViolationMessage } from '../tools/args.validate';
import { canonicalToolArgs } from './tool.args';
import { planToolBatches, runWithConcurrencyLimit, maxParallelToolCalls } from './tool.schedule';
import { LoopDetector, LoopSignal } from './loop-detector';
import { observeToolOutcome } from './tool.outcome.observers';
import type { RunState, RoundState } from './agent.run.state';

/**
 * Running one round's tool calls for the agent loop (split out of AgentLoop.execute(), flaw list C14): model-ordered
 * batches with bounded concurrency, each call validated against its tool's own schema and observed, every call
 * answered in the history in the order the model asked, then the batch's consequences — a terminal capability blocker,
 * a screenshot for a vision model, loop signals.
 */

/** What the tool round needs from the loop. `messages` is read live: the loop replaces its array between rounds. */
export interface ToolRoundHost {
  readonly tools: ToolRegistry;
  readonly llm: LLMProvider;
  readonly messages: Message[];
}

/**
 * Capability verbs that only acquire or inspect a target.
 *
 * None of them can change anything the user asked to change, so a turn whose every capability call
 * came from this set has prepared to act and then stopped. Kept as a deny-list of the preparatory
 * verbs rather than an allow-list of acting ones: a new acting verb must count as progress the day
 * it ships, whereas a new preparatory verb merely delays a nudge by one round.
 */
export const PREPARATORY_MOTION_ACTIONS = new Set([
  'open', 'focus', 'status', 'observe', 'screenshot', 'apps', 'windows',
  'cursor', 'frontmost', 'desktop', 'record_status',
]);

const RECOVERABLE_MOTION_BLOCKS = new Set([
  'invalid_arguments',
  'postcondition_required',
  'native_target_required',
  'native_selector_unresolved',
  'native_snapshot_required',
  'native_snapshot_unavailable',
  'native_perception_not_ready',
]);

/**
 * A packaged Mac provider stop receipt is a state-machine boundary, not an ordinary failed tool.
 * Only refusals whose code names a supported, state-changing correction remain recoverable. This
 * catches alternating open/focus/observe thrash that an identical-call detector cannot see.
 */
export function terminalCapabilityBlocker(result: string): string | null {
  try {
    const value = JSON.parse(result);
    if (value?.ok !== false || value?.blocked !== true || value?.executor !== 'stop') return null;
    const code = typeof value.code === 'string' ? value.code : 'native_operation_blocked';
    if (RECOVERABLE_MOTION_BLOCKS.has(code)) return null;
    const reason = [value.reason, value.error].find(candidate => typeof candidate === 'string' && candidate.trim());
    return `${code}: ${reason || 'the native provider stopped the operation'}`;
  } catch { return null; }
}

/** Mutating tools whose success is an implicit "this change is correct" claim. */
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

/**
 * Run one tool call: parse and validate its arguments against the tool's own schema, execute it with the turn's
 * signal and context, and report the result — to the UI, the trace, and every observer that learns from it.
 * Also advances the operation gates' flags on the run (required tool used, progress made, draft pending).
 */
async function executeToolCall(
  host: ToolRoundHost, st: RunState, tc: { id: string, name: string, args: string, truncated?: boolean }, options: AgentLoopOptions | undefined,
  context: any, signal: AbortSignal | undefined, rootSpan: ReturnType<ReturnType<typeof getTracer>['startSpan']>,
): Promise<{ id: string; result: string; isError: boolean }> {
  const tracer = getTracer();
  if (options?.requireTool && tc.name === options.requireTool) {
    st.requiredToolUsed = true;
    // Preparatory verbs acquire or inspect a target; they never change anything the user
    // asked to change. Parsed defensively: an unreadable argument blob must not be counted
    // as progress, but must not block the turn either — the bounded nudge below decides.
    try {
      const action = String(JSON.parse(tc.args || '{}')?.action || '').toLowerCase();
      if (action && !PREPARATORY_MOTION_ACTIONS.has(action)) st.sawAdvancingAction = true;
    } catch { /* unparseable args are judged by the runtime, not here */ }
  }
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
  engineEvents.emit('tool_call', entry);

  const finish = (result: string, isError: boolean, typed?: TypedOutcome) => {
    // A preparatory call that FAILED is a legitimate place to stop: the honest answer is the
    // blocker it proves. Only a preparatory call that SUCCEEDED leaves the operation merely
    // set up, which is the state the completion gate exists to interrupt.
    if (options?.requireTool && tc.name === options.requireTool) {
      st.lastCapabilitySucceeded = !isError;
      if (tc.name === 'DocumentTool' && typed?.status === 'ok' && !result.startsWith('Draft retained')) st.sawAdvancingAction = true;
      if (!isError) reportCapability({ id: 'tool-activation', label: 'Requested capability', state: 'ready',
        reason: 'The requested tool completed a subsequent operation.', impact: '', action: '' });
      if (!isError) {
        try { if (JSON.parse(result)?.ok === false) st.lastCapabilitySucceeded = false; }
        catch { /* non-JSON capability output counts as delivered */ }
      }
    }
    if (tc.name === 'DocumentTool' && !isError) st.documentDraftPending = result.startsWith('Draft retained');
    const endTime = new Date();
    const durationMs = endTime.getTime() - entry.startTime.getTime();
    // Everything that learns from this result — completion checks, telemetry, failure memory, the mind layer.
    result = observeToolOutcome({
      call: tc, result, isError, typed, durationMs, span: toolSpan,
      cwd: context?.cwd || process.cwd(), background: argsObj?.background === true,
    });
    engineEvents.emit('tool_call_result', {
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

  const tool = host.tools.getTool(tc.name);
  if (!tool) {
    return finish(`Tool ${tc.name} not found.`, true);
  }

  // Validate the call against the tool's OWN declared schema before it runs. Without this a
  // near-miss (a missing required property, `"12"` where a number is declared) reached the
  // implementation and surfaced as an internal TypeError — a message naming our private
  // variables, which the model cannot act on. Coerce the unambiguous near-misses small
  // models actually emit, then refuse the rest with the exact violations.
  const check = checkToolArgs(tool.schema, argsObj);
  if (check.violations.length > 0) {
    Logger.warn(`[AgentLoop] ${tc.name} rejected before execution: ${check.violations.join('; ')}`);
    return finish(argsViolationMessage(tc.name, check.violations), true);
  }
  if (check.coercions.length > 0) {
    Logger.warn(`[AgentLoop] Coerced ${tc.name} arguments: ${check.coercions.join('; ')}`);
  }
  argsObj = check.args;

  try {
    // Thread the interrupt signal into the tool so a long-running one (e.g. a 30s Bash)
    // is killed the instant esc is hit, rather than running to completion first.
    // reportOutcome is the typed-outcome side-channel: the factory fires it when the
    // tool declared its own status (v2 Phase 0), so learning gets labels, not guesses.
    let typed: TypedOutcome | undefined;
    const toolContext = {
      ...(context || { cwd: process.cwd() }), signal,
      sessionId: options?.sessionId,
      learningTrace: isReplayActive() ? undefined : toolSpan.context,
      reportOutcome: (o: TypedOutcome) => { typed = o; },
      // The LIVE conversation array for this loop, so context-management tools
      // (FreeContextTool) can act on the real session context, not a stale copy.
      sessionMessages: host.messages,
    };
    // Counted at the point the tool actually RUNS — after the governor, the arg validation
    // and the hooks have all let it through. A tool the model asked for and was refused is
    // not a tool in use, and counting the request would make a blocked tool look popular.
    recordUsage('tool', tool.name);
    const result = await tool.execute(argsObj, toolContext);
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return finish(resultStr, !!typed && typed.status !== 'ok', typed);
  } catch (e: any) {
    const text = `Tool Error: ${e.message}`;
    return finish(text, true, typedFromError(e, text));
  }
}

/**
 * React to the loop detector's signals from one batch: log the worst to the pattern store, and steer the model —
 * a hard stop for a repeated identical call or error thrashing, a warning for a soft loop.
 */
function applyLoopSignals(host: ToolRoundHost, loopSignals: LoopSignal[]): void {
  if (loopSignals.length === 0) return;
  const worst = loopSignals.sort((a, b) => b.count - a.count)[0];
  // Log to genome pattern store (best-effort, non-blocking)
  try { getGlobalPatternStore()?.appendLoopSignal(worst.type, worst.tool, worst.argsHash, worst.severity); } catch { /* ignore */ }
  if (worst.severity === 'hard') {
    // The loop_detected event renders its own visible line in the TUI — no reply-stream
    // narration on top of it (the answer must stay the model's voice alone).
    engineEvents.emit('status', `Loop broken — "${worst.tool}" repeated ${worst.count}×, steering the model away`);
    engineEvents.emit('loop_detected' as any, worst);
    host.messages.push({
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
    host.messages.push({
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

/**
 * Vision observation loop: a browser screenshot this batch produced becomes an image the
 * model actually SEES on its next turn — but only when the active model advertises vision
 * (text-only models keep the plain JSON result). Old observations are pruned so image
 * bytes never pile up in history. Best-effort end to end: no vision, no file, or an
 * adapter without capability introspection simply attaches nothing.
 */
async function attachNewestScreenshot(host: ToolRoundHost, screenshotPaths: Array<{ path: string } & ScreenshotObservationContext>): Promise<void> {
  if (screenshotPaths.length === 0) return;
  try {
    // canSeeImages covers BOTH a vision-capable primary AND a configured vision slot —
    // the adapter reroutes image turns to the vision model automatically.
    const canSee = (host.llm as any).canSeeImages?.()
      ?? (await (host.llm as any).activeCapabilities?.())?.visionInput;
    if (canSee) {
      const newest = screenshotPaths[screenshotPaths.length - 1];
      const observation = buildScreenshotObservation(newest.path, newest);
      if (observation) {
        appendScreenshotObservation(host.messages, observation);
        pruneScreenshotObservations(host.messages);
      }
    }
  } catch { /* vision attachment must never break the loop */ }
}

export async function runToolRound(
  host: ToolRoundHost, st: RunState, round: RoundState, options: AgentLoopOptions | undefined, context: any,
  signal: AbortSignal | undefined, loopDetector: LoopDetector, rootSpan: ReturnType<ReturnType<typeof getTracer>['startSpan']>,
): Promise<'ok' | 'stop'> {
  const tracer = getTracer();
  // Interrupted right after the model asked for tools: don't start running them. The
  // assistant turn is already persisted above; we just stop before side effects.
  if (signal?.aborted) return 'stop';
  // Build the tool_calls payload for the assistant message
  const asstMsg: Message = {
    role: 'assistant', tool_calls: [],
    ...(round.replayableReasoning ? { reasoning_content: round.replayableReasoning } : {}),
  };
  if (round.currentContent) asstMsg.content = round.currentContent;

  for (const tc of round.toolCalls) {
    asstMsg.tool_calls!.push({
      id: tc.id,
      type: 'function',
      // CRITICAL: tool-call arguments MUST be valid JSON before they go into history. A model can
      // emit truncated/malformed args (e.g. a cut-off `{"query": "`); storing that raw poisons
      // EVERY later request — providers re-validate the arguments string as JSON and reject the
      // whole call ("Unterminated string … char 10"), so the session wedges until /clear. Coerce
      // to canonical JSON, falling back to `{}` so a bad emission can never corrupt the history.
      function: { name: tc.name, arguments: sanitizeToolArgs(tc.args) },
      // Echo provider data that belongs to the call (Gemini 3's thought signature): the
      // provider refuses the next tool round without it. See ToolCallSlot.extra.
      ...(tc.extra !== undefined ? { extra_content: tc.extra } : {}),
    });
  }
  
  // Replace the plain assistant message with the one containing tool_calls
  if (round.currentContent) {
      host.messages.pop(); 
  }
  host.messages.push(asstMsg);

  const executableCalls = round.toolCalls;

  // Group into MODEL-ORDERED batches: a maximal run of concurrency-safe calls overlaps inside
  // a bounded pool, and every other call is its own barrier. This replaces the old
  // "all safe calls first, then the rest", which reordered the model's intent — a turn of
  // [EditFileTool(x), ReadFileTool(x)] ran the read FIRST and verified the pre-edit file.
  // Safety is decided per CALL, so a read-only Bash joins the pool while a mutating one does not.
  const batches = planToolBatches(executableCalls, tc => {
    const tool = host.tools.getTool(tc.name);
    if (!tool) return false; // an unknown tool is answered with an error; never overlap it
    let parsed: any;
    try { parsed = JSON.parse(tc.args || '{}'); } catch { return false; }
    // `concurrencySafeFor` is the per-call answer; a registry entry that predates it (or a
    // test double) still has the static flag, and either way an absent answer means exclusive.
    if (typeof tool.concurrencySafeFor === 'function') return tool.concurrencySafeFor(parsed);
    return tool.isConcurrencySafe === true;
  });

  const resultById = new Map<string, { result: string; isError: boolean }>();
  let interrupted = false;
  const limit = maxParallelToolCalls();
  for (const batch of batches) {
    // Interrupted between batches: stop before starting the next one so esc halts a continuous
    // run of tool calls promptly, instead of waiting out the whole turn + another model call.
    if (signal?.aborted) { interrupted = true; break; }
    // Calls already dispatched inside a batch are DRAINED rather than abandoned — an
    // interrupt stops replenishment, and every un-run call still gets an explicit stub below.
    const settled = await runWithConcurrencyLimit(
      batch.calls, limit, tc => executeToolCall(host, st, tc, options, context, signal, rootSpan), () => signal?.aborted === true,
    );
    for (const res of settled) {
      if (res) resultById.set(res.id, { result: res.result, isError: res.isError });
    }
    if (signal?.aborted) { interrupted = true; break; }
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
  for (const tc of round.toolCalls) {
    const ran = resultById.get(tc.id);
    const result = ran ? ran.result : 'Tool call interrupted before it ran.';
    // Web and MCP output goes to the model fenced as untrusted data (flaw list A5); every check below reads the
    // tool's own unfenced result.
    host.messages.push({ role: 'tool', tool_call_id: tc.id, content: ran ? fenceUntrusted(tc.name, tc.args || '{}', result) : result });
    if (ran) {
      let structuredFailure = false;
      try { structuredFailure = JSON.parse(result)?.ok === false; } catch { /* text result */ }
      const sig = loopDetector.record(tc.name, tc.args, result, ran.isError || structuredFailure);
      if (sig) loopSignals.push(sig);
      if (!st.operationTerminalBlocker && options?.requireTool && tc.name === options.requireTool) {
        st.operationTerminalBlocker = terminalCapabilityBlocker(result);
      }
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
  if (interrupted) return 'stop';

  if (st.operationTerminalBlocker && !st.terminalBlockerNudged) {
    st.terminalBlockerNudged = true;
    st.forceRequiredToolNextRound = false;
    host.messages.push({
      role: 'user',
      content:
        `[OPERATION BLOCKED — ANSWER ONLY] The required native capability stopped with: ` +
        `${st.operationTerminalBlocker}. Do not call or invent another tool and do not retry ` +
        `open/focus/observe. Tell the user this concrete blocker plainly.`,
    });
    engineEvents.emit('status', 'Mac operation blocked — reporting the verified blocker');
  }

  await attachNewestScreenshot(host, screenshotPaths);

  // One mind-strip refresh per tool batch (not per call): the footer's 🧠 counters
  // (weak spots / drive deviations / habits) re-snapshot after the batch lands.
  try { engineEvents.emit('mind_changed' as any); } catch { /* best-effort */ }

  applyLoopSignals(host, loopSignals);
  return 'ok';
}
