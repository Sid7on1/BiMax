/**
 * Adversarial Verifier — a second review pass after self-critic, framed as red-team.
 *
 * Self-critic (lite model, ~300 tokens): "did you satisfy the request?"
 * Adversarial verifier (full model, ~800 tokens): "try to BREAK this — find bugs, edge
 * cases, security holes, missed requirements that the agent and self-critic both missed."
 *
 * Off by default (/governor redteam on). Only fires when:
 *   - Enabled
 *   - Not in plan mode
 *   - The turn touched code (contains a file path or function call)
 *   - Self-critic already ran and approved (avoid double-flagging known issues)
 */

import { getGlobalPatternStore } from '../genome/pattern.store';

let enabled = false;

export function setAdversarialVerifyEnabled(value: boolean): void { enabled = value; }
export function isAdversarialVerifyEnabled(): boolean { return enabled; }

const CODE_SIGNAL_RE = /\.(ts|tsx|js|jsx|py|go|rs|java|cpp|c|rb|swift|kt)\b|function\s+\w+|class\s+\w+|def\s+\w+/;

/** True when the execution log looks like it touched real code (not a doc/chat turn). */
export function looksLikeCodeWork(log: string): boolean {
  return CODE_SIGNAL_RE.test(log) && log.length > 100;
}

const REDTEAM_SYSTEM = `You are an adversarial red-team code reviewer. Your job is to FIND BUGS — not to be nice.

You are reviewing work done by an AI coding agent. The self-critic already approved it as "complete". Your job is to find what they MISSED.

Hunt for:
- Logic bugs: off-by-one, wrong operator, null/undefined dereference, missing await
- Edge cases: empty input, large input, concurrent calls, error paths not handled
- Security holes: injection, prototype pollution, path traversal, exposed secrets
- Missed requirements: parts of the user's request that were silently skipped
- Type safety: places where TypeScript types were bypassed or any-cast
- Performance traps: accidental O(n²), unbounded loops, missing index

Instructions:
- If you find NOTHING, reply with exactly: VERIFIED
- If you find issues, list each as a SHORT bullet: file:line — what the problem is and why it matters
- Be specific and actionable. Do not repeat what the self-critic already said.
- Do not invent requirements that weren't asked for. Stay inside the scope of what was requested.`;

/**
 * Run the adversarial verifier on a completed turn.
 * Returns null if nothing was found ("VERIFIED"), or a bulleted list of issues.
 */
export async function runAdversarialVerifier(
  originalPrompt: string,
  executionLog: string,
  llmAdapter: { chatCompletion: (msgs: any[], system: string, opts?: any) => Promise<string> }
): Promise<string | null> {
  if (!enabled || !looksLikeCodeWork(executionLog)) return null;

  // Cap what we send to avoid token blowout on massive logs
  const logSlice = executionLog.length > 6000
    ? executionLog.slice(0, 3000) + '\n\n[... middle truncated ...]\n\n' + executionLog.slice(-2000)
    : executionLog;

  try {
    const result = await llmAdapter.chatCompletion(
      [{
        role: 'user',
        content: `User's original request:\n${originalPrompt}\n\n--- Agent's work (self-critic already approved) ---\n${logSlice}`,
      }],
      REDTEAM_SYSTEM,
      { lite: false } // use the full model — adversarial pass needs depth
    );

    const trimmed = result.trim();
    if (!trimmed || /^verified$/i.test(trimmed)) return null;
    // Log verification failures to genome so self-evolution can learn failure patterns
    try { getGlobalPatternStore()?.appendVerificationFail(originalPrompt.slice(0, 120), trimmed.slice(0, 300)); } catch { /* ignore */ }
    return trimmed;
  } catch {
    return null; // adversarial pass is best-effort
  }
}
