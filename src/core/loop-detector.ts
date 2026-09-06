import * as crypto from 'crypto';

export type LoopType =
  | 'generic_repeat'       // same (tool, args) called N times
  | 'no_progress_poll'     // same (tool, args, result) — calling but nothing changes
  | 'ping_pong'            // A→B→A→B alternation between two tools
  | 'unknown_tool_repeat'  // model keeps calling a non-existent tool name
  | 'error_thrashing'      // same tool keeps ERRORING across the window, even with DIFFERENT args
  | 'circuit_breaker';     // total tool calls for this session exceeded the budget

export interface LoopSignal {
  type: LoopType;
  tool: string;
  argsHash: string;
  count: number;
  severity: 'soft' | 'hard';
}

interface CallRecord {
  tool: string;
  argsHash: string;
  resultHash: string;
  /**
   * What "the same outcome" means for THIS tool. Normally the whole result, but a tool that reports
   * a `frameHash` has told us which part of its result carries the progress signal, so that field is
   * used instead. Without this the two guards cancelled out for exactly those tools: a frameHash
   * suppresses the generic_repeat check below (successive frames may legitimately differ), and the
   * no_progress_poll check meant to cover that gap compared the FULL result — which for a visual
   * tool embeds a fresh screenshot path every call, so its hash never repeated and the check could
   * never fire. A vision tool polling one unchanged frame was therefore caught by nothing at all.
   */
  progressHash: string;
  isError: boolean;
}

const SOFT_THRESHOLD = 3;  // warn, inject hint
const HARD_THRESHOLD = 5;  // intervene, push the model to stop
// Long workflows can legitimately span hundreds of calls. Repetition detectors remain the primary
// guard; this is only a last-resort session fuse.
const MAX_TOTAL_CALLS = 2_000;
// Error-thrashing: how many times a single tool may FAIL within the rolling window before we step in.
// This is deliberately independent of argsHash — the whole point is to catch the "keep tweaking the
// arguments and it keeps erroring" spiral (a mis-anchored EditFileTool, a Bash command that never
// succeeds) that the args-identical generic_repeat check cannot see.
const ERROR_SOFT_THRESHOLD = 3;
const ERROR_HARD_THRESHOLD = 4;

function sha256Short(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * LoopDetector — 5-detector loop pattern recognition for the agent loop.
 * Instantiated fresh per execute() call; carries state for one session turn series.
 * After each tool result, call record(). It returns a LoopSignal if a pattern fires,
 * null if the turn looks normal.
 */
export class LoopDetector {
  private history: CallRecord[] = [];
  private totalCalls = 0;
  // Latch: the circuit breaker is a one-shot. Without this, every call past MAX_TOTAL_CALLS would
  // re-fire a hard signal, spamming "[LOOP DETECTED — HARD STOP]" into history on calls 200, 201, …
  private breakerFired = false;
  // Cooldown for ping-pong: the A→B→A→B test matches on every subsequent call once an alternation
  // is established, so without a cooldown it re-warns each cycle. Suppress until this many further
  // calls have elapsed since the last ping-pong signal.
  private lastPingPongAt = -Infinity;
  private static readonly PING_PONG_COOLDOWN = 4;
  // Cooldown for error-thrashing: once a spiral is flagged, an every-call re-fire would spam history,
  // so wait this many further calls before flagging the same tool again.
  private lastErrorThrashAt = -Infinity;
  private lastErrorThrashSeverity: 'soft' | 'hard' | null = null;
  private static readonly ERROR_THRASH_COOLDOWN = 3;

  /**
   * Record a completed tool call.
   * @param isError whether the call failed (from the tool executor). When the caller can't determine
   *   it, a light heuristic on the result text is used as a fallback so the error-thrashing detector
   *   still has a signal. Defaults to that heuristic when omitted, keeping older call sites working.
   */
  record(toolName: string, argsJson: string, resultText: string, isError?: boolean): LoopSignal | null {
    this.totalCalls++;
    const argsHash = sha256Short(toolName + ':' + argsJson);
    const resultHash = sha256Short(resultText);
    const failed = isError ?? /^(tool error|error:|failed to|tool .* not found)/i.test((resultText || '').trimStart());
    // A host-provided visual tool can repeat the same action legitimately while successive frames
    // prove progress. Treat a structured frame hash as generic progress evidence; this keeps the
    // engine independent of any provider/tool name while still catching an unchanged-frame poll.
    let hasFrameProgressEvidence = false;
    let progressHash = resultHash;
    try {
      const parsed = JSON.parse(resultText);
      hasFrameProgressEvidence = typeof parsed?.frameHash === 'string' && parsed.frameHash.length > 0;
      if (hasFrameProgressEvidence) progressHash = sha256Short(String(parsed.frameHash));
    } catch { /* ordinary text result */ }

    this.history.push({ tool: toolName, argsHash, resultHash, progressHash, isError: failed });
    // Keep a rolling window — only the last 20 calls matter for pattern matching
    if (this.history.length > 20) this.history.shift();

    // Circuit breaker — fires once, regardless of what tool is being called.
    if (this.totalCalls >= MAX_TOTAL_CALLS && !this.breakerFired) {
      this.breakerFired = true;
      return {
        type: 'circuit_breaker',
        tool: toolName,
        argsHash,
        count: this.totalCalls,
        severity: 'hard',
      };
    }

    // Generic repeat — same (tool, argsHash) repeated across the window, NOT necessarily in a row.
    // Weak models interleave the same Read/grep/search between other calls (read A, read B, read A,
    // read C, read A …), so the old strict "N-in-a-row" check never fired and the agent thrashed for
    // minutes re-reading identical files. Count occurrences anywhere in the rolling window instead.
    const repeats = this.history.filter(c => c.tool === toolName && c.argsHash === argsHash).length;
    if (!hasFrameProgressEvidence && repeats >= HARD_THRESHOLD - 1) {
      return { type: 'generic_repeat', tool: toolName, argsHash, count: repeats, severity: 'hard' };
    }
    if (!hasFrameProgressEvidence && repeats >= SOFT_THRESHOLD) {
      return { type: 'generic_repeat', tool: toolName, argsHash, count: repeats, severity: 'soft' };
    }

    // Error thrashing — the same tool keeps FAILING across the window even as the model varies its
    // arguments (the args-identical generic_repeat check above can't see this). Only considered on a
    // failing call, and cooled down so a genuine retry-with-fix isn't punished. This catches the common
    // "edit fails to match → tweak → fails again → tweak …" spiral that used to eat 5–10 turns.
    if (failed) {
      const errorsForTool = this.history.filter(c => c.tool === toolName && c.isError).length;
      const severity: 'soft' | 'hard' | null =
        errorsForTool >= ERROR_HARD_THRESHOLD ? 'hard' :
        errorsForTool >= ERROR_SOFT_THRESHOLD ? 'soft' : null;
      if (severity) {
        // Escalating soft→hard bypasses the cooldown (the spiral just got worse and the model needs the
        // stronger nudge now); otherwise the cooldown throttles repeat signals of the same severity so a
        // long tail of failures doesn't spam an identical warning into history every single call.
        const escalated = severity === 'hard' && this.lastErrorThrashSeverity !== 'hard';
        if (escalated || this.totalCalls - this.lastErrorThrashAt >= LoopDetector.ERROR_THRASH_COOLDOWN) {
          this.lastErrorThrashAt = this.totalCalls;
          this.lastErrorThrashSeverity = severity;
          return { type: 'error_thrashing', tool: toolName, argsHash, count: errorsForTool, severity };
        }
      }
    }

    // No-progress poll — same (tool, argsHash, progressHash) SOFT_THRESHOLD times in a row.
    // Compared on progressHash, not resultHash: see CallRecord.progressHash for why the full result
    // is the wrong key for any tool that reports its own progress signal.
    if (this.history.length >= SOFT_THRESHOLD) {
      const tail = this.history.slice(-SOFT_THRESHOLD);
      if (tail.every(c => c.tool === toolName && c.argsHash === argsHash && c.progressHash === progressHash)) {
        return {
          type: 'no_progress_poll',
          tool: toolName,
          argsHash,
          count: SOFT_THRESHOLD,
          severity: 'soft',
        };
      }
    }

    // Ping-pong — A→B→A→B alternation over last 4 calls. Cooled down so a sustained alternation
    // warns once per few cycles instead of on every call.
    if (this.history.length >= 4 && this.totalCalls - this.lastPingPongAt >= LoopDetector.PING_PONG_COOLDOWN) {
      const [h0, h1, h2, h3] = this.history.slice(-4);
      if (
        h0.tool === h2.tool && h0.argsHash === h2.argsHash &&
        h1.tool === h3.tool && h1.argsHash === h3.argsHash &&
        h0.tool !== h1.tool
      ) {
        this.lastPingPongAt = this.totalCalls;
        return {
          type: 'ping_pong',
          tool: `${h0.tool} ↔ ${h1.tool}`,
          argsHash,
          count: 4,
          severity: 'soft',
        };
      }
    }

    // Unknown-tool repeat — model calling a tool name that returned "not found" twice
    if (resultText.startsWith('Tool ') && resultText.includes('not found') && this.history.length >= 2) {
      const prev = this.history[this.history.length - 2];
      if (prev.tool === toolName && prev.argsHash === argsHash) {
        return {
          type: 'unknown_tool_repeat',
          tool: toolName,
          argsHash,
          count: 2,
          severity: 'soft',
        };
      }
    }

    return null;
  }

  getSoftThreshold(): number { return SOFT_THRESHOLD; }
  getHardThreshold(): number { return HARD_THRESHOLD; }

  reset(): void {
    this.history = [];
    this.totalCalls = 0;
    this.breakerFired = false;
    this.lastPingPongAt = -Infinity;
    this.lastErrorThrashAt = -Infinity;
    this.lastErrorThrashSeverity = null;
  }
}
