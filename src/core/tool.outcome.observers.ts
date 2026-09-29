import { engineEvents } from '../engine/events';
import { globalTelemetry } from '../telemetry/telemetry';
import { getFailureMemory } from './failure.memory';
import { getSelfModel, domainOf, pathOf, labelOutcome, currentModelKey } from '../mind/self.model';
import { getEventLedger } from '../mind/event.ledger';
import { markToolTaint } from '../mind/taint';
import { getHabitMiner } from '../mind/habit.compiler';
import { observeClaim, observeCommandOutcome } from '../mind/outcome.sensor';
import { isReplayActive } from '../mind/episode.recorder';
import { requiresBuildVerification } from '../review/verification.scope';
import { changesFiles, getCompletionChecks } from '../outcome/completion.check';
import type { TypedOutcome } from '../tools/outcome';

/** The mutating tools whose success opens a correctness claim and a Review entry. */
export const CLAIMING_TOOLS = new Set(['EditFileTool', 'WriteFileTool', 'MultiEditTool', 'SymbolEditTool']);

/** A span the observers can annotate — the tracer's execute_tool span. */
type ToolSpanLike = Parameters<typeof observeClaim>[0];

export interface ToolOutcome {
  call: { id: string; name: string; args: string };
  result: string;
  isError: boolean;
  typed?: TypedOutcome;
  durationMs: number;
  span: ToolSpanLike;
  cwd: string;
  /** The call ran in the background (`BashTool` with `background: true`): its exit code is not its outcome yet. */
  background: boolean;
}

/**
 * Everything that learns from one tool call's result, in one place (split out of AgentLoop.execute(), flaw list C14):
 * completion checks, telemetry, the failure memory, and the mind layer — taint, the event ledger, the self-model, the
 * habit miner, and correctness claims opened by edits and resolved by builds and tests.
 *
 * Each observer is best-effort: none of them may break tool execution. Returns the result the model should see, which
 * differs from the tool's own only when the failure memory has exhausted this action's retry budget and says so.
 */
export function observeToolOutcome(o: ToolOutcome): string {
  const { call, isError, typed, durationMs, span, cwd } = o;
  const args = call.args || '{}';
  let result = o.result;

  // Completion checks (F3): a call that changed files makes this a task that needs a check, and makes a check that
  // passed before it stale.
  if (!isError && changesFiles(call.name, args, result)) getCompletionChecks()?.noteChange(pathOf(args) || undefined);
  globalTelemetry.recordToolCall(call.name, durationMs);

  // ONE label for every observer below — see labelOutcome in mind/self.model.ts for why a low-confidence outcome
  // defers to the classifier instead of overruling it.
  const outcomeLabel = labelOutcome(typed, result, isError);

  // Generalized failure memory: consecutive identical failures of the SAME action exhaust a per-operation-class retry
  // budget, and the model is told to change strategy instead of looping. BrowserTool is excluded — its runtime has a
  // page-state-aware loop detector that sees URL/element state this layer can't.
  if (call.name !== 'BrowserTool') try {
    const verdict = getFailureMemory().report(
      { tool: call.name, args },
      {
        ok: outcomeLabel !== 'err',
        errorClass: typed?.errorClass,
        exitCode: typed?.exitCode,
        resultSample: isError ? result.slice(0, 500) : undefined,
      },
    );
    if (verdict.exhausted && verdict.note) result = `${result}\n\n⟳ ${verdict.note}`;
  } catch { /* failure memory is an observer — never breaks execution */ }

  // Mind layer: the self-model (learned failure rates → routing hints) and the habit miner (recurring tool sequences →
  // compiled habits). During a replay these stand down entirely: re-observing recorded experience as fresh evidence
  // would double-count every outcome the system already learned from.
  if (!isReplayActive()) try {
    // Typed outcome (v2 Phase 0): prefer the tool's own declaration — ground truth. The regex classifier is the
    // explicit low-confidence fallback for unswept/MCP tools. 'blocked' (policy said no) joins 'rejected' as
    // preference/policy data, never a failure-rate sample.
    const outcome: 'ok' | 'err' | 'rejected' = outcomeLabel;
    const domain = domainOf(call.name, args);
    // Taint (v2 D3): web/MCP output entering the conversation marks the session untrusted — the governor then denies
    // network capability until a human clears it.
    markToolTaint(call.name, args, result);
    let bashCmd: string | undefined;
    if (call.name === 'BashTool') {
      try { bashCmd = String(JSON.parse(args).command || '') || undefined; } catch { /* unparseable */ }
    }
    // Prefix the declared error class so weak-spot samples carry the label.
    const errSample = outcome === 'err'
      ? (typed?.errorClass ? `[${typed.errorClass}] ${result}` : result).slice(0, 200)
      : undefined;
    // Event ledger (v2 D1): every tool outcome lands in the append-only log with its typed label AND everything a
    // view rebuild needs (model key, bash cmd, touched file, error sample) — the raw material learned state is
    // refolded from.
    getEventLedger().append('tool_outcome', {
      tool: call.name, domain,
      status: typed?.status ?? outcome,
      errorClass: typed?.errorClass,
      exitCode: typed?.exitCode,
      confidence: typed ? 'high' : 'low',
      model: currentModelKey(),
      cmd: bashCmd,
      file: pathOf(args),
      errSample,
      durationMs, isError,
    });
    if (outcome !== 'rejected') {
      getSelfModel().record(call.name, domain, outcome === 'ok', errSample);
    }
    getHabitMiner().observe(call.name, domain, outcome === 'ok', bashCmd);
    // Epistemic ledger: a successful mutation opens a correctness claim (confidence grounded in the self-model, scoped
    // to the mutated FILE); a build/test/typecheck run is evidence that resolves only the claims it covers — red
    // output must name the claim's file, green repo-wide runs cover everything in the window.
    if (outcome === 'ok' && CLAIMING_TOOLS.has(call.name)) {
      const claimFile = pathOf(args);
      // Review records every successful mutation, including prose/media artifacts.
      engineEvents.emit('review_change', { tool: call.name, file: claimFile, callId: call.id });
      // Build/test verification is meaningful only for code/config-like artifacts. A story.txt or image still appears
      // in Review, but must not open a claim that ends the turn with the nonsensical instruction to run a build/test.
      if (requiresBuildVerification(claimFile)) {
        const conf = getSelfModel().confidenceFor(call.name, domain);
        observeClaim(span, call.name, domain, conf, claimFile, cwd);
      }
    } else if (call.name === 'BashTool' && bashCmd) {
      const resolution = observeCommandOutcome(span, {
        command: bashCmd, result, exitCode: typed?.exitCode,
        background: o.background,
        cwd,
      });
      if (resolution) engineEvents.emit('review_evidence', { command: bashCmd, ...resolution });
    }
  } catch { /* observers are best-effort */ }
  return result;
}
