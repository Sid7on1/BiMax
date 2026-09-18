import { LlmAdapter } from '../core/llm.adapter';

/**
 * Model-tier routing. Two slots are configured: the QUICK model (fast, cheap — for chat and
 * trivially-answerable turns) and the WORK coding model (the user's chosen main model).
 *
 * ARCHITECTURE (2026-07-18 — replaces the remote pre-flight classifier):
 * Routing is now FULLY LOCAL and deterministic. Seven architectures were compared before this
 * design was chosen (docs/ROUTING_DECISION.md has the measured comparison):
 *
 *   1. Serial remote classification (the old design) — a non-streaming lite-model round-trip
 *      cost ~1.17s of first-token latency per ambiguous turn, measured against a 120ms mock;
 *      against real NIM it was the single largest local latency source after the key-cooldown
 *      bug was fixed.
 *   2. Parallel classification + main-call preparation — already partially in place (routing
 *      overlapped @-mention expansion); the turn was still blocked on the slowest leg, the
 *      classifier itself. Ceiling: ~150ms saved.
 *   3. Local deterministic routing for obvious cases — existed (heuristicTier); extended here.
 *   4. Local classifier + remote fallback — the remote leg re-introduces the exact tail latency
 *      being removed, on exactly the turns that hit it. Rejected.
 *   5. Optimistic Quick with escalation — serves real work from the weak model first (observed
 *      live: the quick model flails on tool loops), then pays double latency+cost to escalate.
 *      Rejected: quality-unsafe in the failure direction that matters.
 *   6. Default Work with later adaptation — correctness-safe: the Work model handles everything
 *      the Quick model can, so a misroute in this direction costs tokens, never quality.
 *      ADOPTED as the ambiguity default.
 *   7. Capability-driven routing — the informative capability signals (will this turn need
 *      tools/repo context?) are visible in the prompt locally: file paths, @mentions, code
 *      fences, repo-referring nouns, imperative verbs. ADOPTED as the signal set for the local
 *      classifier; mid-turn model switching was rejected as a separate, riskier change.
 *
 * What the old remote classifier handled correctly is preserved deterministically:
 *   - short imperatives outside HEAVY_VERB ("please rework the tokenizer") → Work, via the
 *     general-imperative detector (the old shape fallback misrouted these to Quick at <140 chars);
 *   - repo-referring questions ("what does the governor do here") → Work, via the repo-signal
 *     detector (answering requires reading code);
 *   - genuinely self-contained knowledge questions ("what's the difference between let and
 *     const?") → Quick, via the knowledge-question detector.
 * What it produced that is deliberately dropped: the one-line "task brief" (optional framing —
 * the Work model always received the user's original prompt anyway).
 */
export type Tier = 'lite' | 'heavy';

export interface RouteDecision {
  tier: Tier;
  /** How the decision was reached — for logging / the footer tooltip. */
  via: 'heuristic' | 'local' | 'pinned' | 'fallback' | 'unified';
}

// Obvious conversational turns that never need the heavy model. Anchored to the whole (short)
// message so "ok" matches but "ok now refactor the parser" does not.
const CHATTY = /^(hi|hey+|hello|yo|sup|howdy|thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|awesome|got it|gotcha|sure|yep|yeah|yes|no|nope|hmm|lol|wow|same|right)[!.…\s]*$/i;

// Obvious coding-work signals: an imperative "change/build code" verb, or unambiguous code context
// (a fenced block, a stack trace). These route straight to HEAVY with no further analysis.
const HEAVY_VERB = /\b(implement|refactor|debug|rewrite|redesign|optimi[sz]e|migrate|integrate|diagnose|troubleshoot|build (?:a|the|out|me)\b|write (?:a|the|some|me)? ?(?:code|tests?|script|function|class|module|component)\b|fix (?:the|this|that|a|my)? ?(?:bug|tests?|error|crash|issue|build|types?)\b|add (?:a|the)? ?(?:support|tests?|feature|endpoint|command|flag)\b|create (?:a|the)? ?(?:file|class|function|module|component|script|tests?)\b)/i;
const CODE_CONTEXT = /```|\bTraceback \(most recent call last\)|\n\s+at [\w$.<[\]]+ \([^)]*:\d+:\d+\)/;
// Browser operation loops (observe → act → verify) need the capable work model;
// on the quick model flails — observed live: it denied having the tools, then described tool JSON
// instead of looking. These verbs route straight to HEAVY, same as unmistakable coding work.
const BROWSER_OPERATION_CONTEXT = /\b(screenshot|browser ?tool|click (?:on|the|at)\b|scroll (?:the|down|up|to)\b|type into\b|drive (?:the )?browser\b)/i;

/**
 * Local, LLM-free pre-filter. Returns a definite tier for obvious cases, or null to mean
 * "not obvious — run the full local classifier".
 */
export function heuristicTier(prompt: string): Tier | null {
  const p = prompt.trim();
  if (!p) return 'lite';
  // Short greetings / acknowledgements / filler → lite, no model call.
  if (p.length <= 40 && CHATTY.test(p)) return 'lite';
  // Unmistakable coding work → heavy, no model call. Long prompts with code fences or stack
  // traces are equally unambiguous — and so is driving the browser.
  if (HEAVY_VERB.test(p) || CODE_CONTEXT.test(p) || BROWSER_OPERATION_CONTEXT.test(p)) return 'heavy';
  if (p.length > 600) return 'heavy'; // a request this detailed is never small talk
  return null;
}

// ——— Local deterministic classifier (replaces the remote lite-model round-trip) ———

// General imperative verbs that signal actionable work but are not in HEAVY_VERB. The old shape
// fallback (>140 chars → heavy) misrouted short imperatives like "please rework the tokenizer to
// stream" (38 chars) to the quick model; this detector is the fix, regression-tested.
const GENERAL_IMPERATIVE = /\b(make|change|update|remove|delete|rename|move|install|uninstall|upgrade|deploy|run|rerun|re-?index|test|check|verify|investigate|analy[sz]e|look (?:at|into)|search|find|audit|review|clean ?up|rework|adjust|improve|convert|port|split|merge|extract|document|configure|set ?up|enable|disable|wire|connect|bump|revert|rebase|commit|push|pull|release|publish|bundle|compile|lint|format|profile|benchmark|scaffold|generate|summari[sz]e)\b/i;

// Signals that answering will require the repo, the filesystem, or a tool: file paths and
// extensions, @mentions, backticked identifiers, URLs, and repo-referring nouns ("this function",
// "the governor", "my branch"). A question carrying one of these is work, not chat.
const REPO_SIGNAL = /[@`]|https?:\/\/|[\w.-]+\/[\w.-]+|\.[a-z]{1,4}\b|\b(?:this|that|the|my|our) +(?:repo|repository|codebase|project|file|folder|directory|function|method|class|module|component|test|tests|suite|bug|error|crash|branch|commit|pr|diff|build|code|script|config|governor|router|adapter|runtime|session|pipeline)\b/i;

// Self-contained knowledge questions the quick model answers well: interrogative shape, short,
// and — crucially — carrying NONE of the work signals above. Auxiliary verbs (do/can/is/…)
// only count as question-openers when followed by a pronoun-like subject — "do you know X" is a
// question, "do something about the flaky test" is an instruction.
const QUESTION_SHAPE = /^(what|what's|whats|why|how|when|where|who|which|explain|define|compare|tell me)\b|^(is|are|was|were|does|do|did|can|could|should|would|will)\s+(i|you|we|they|it|he|she|there|this|that|anyone|someone)\b/i;

/**
 * Deterministic local classifier for prompts the heuristic calls ambiguous. Never calls a model,
 * never fails, costs ~0ms. Direction of safety: an ambiguous prompt routes to HEAVY (the Work
 * model handles everything the Quick model can — a misroute in this direction costs tokens,
 * never quality), so the only lite routes are affirmatively-detected chat and self-contained
 * knowledge questions.
 */
export function localTier(prompt: string): Tier {
  const p = prompt.trim();
  const hasWorkSignal = GENERAL_IMPERATIVE.test(p) || REPO_SIGNAL.test(p);
  if (!hasWorkSignal && p.length <= 200 && QUESTION_SHAPE.test(p)) return 'lite';
  return 'heavy';
}

/**
 * Decide the tier for a turn. `pinned` (manual override) wins outright; a unified single-model
 * setup makes routing a no-op; otherwise the heuristic runs first and the local classifier
 * settles the remainder. Fully synchronous and deterministic — routing can never block a turn,
 * time out, or spend a model call. (Kept async-shaped: call sites treat routing as awaitable.)
 */
export async function decideTier(llm: LlmAdapter, prompt: string, pinned?: Tier | null): Promise<RouteDecision> {
  if (pinned) return { tier: pinned, via: 'pinned' };

  // Unified single-model setup — the tiers resolve to the same model, so routing is a no-op.
  const mainModel = llm.userModel || llm.defaultModel || '';
  if (!llm.liteModel || llm.liteModel === mainModel) return { tier: 'lite', via: 'unified' };

  const h = heuristicTier(prompt);
  if (h) return { tier: h, via: 'heuristic' };

  return { tier: localTier(prompt), via: 'local' };
}

// Obvious no-tool conversational messages beyond bare acks: identity/capability/meta questions the
// agent answers in one plain sentence. Anchored to the whole (short) message so real work never
// matches ("what does this function do" needs tools; "what can you do" does not).
const CONVO_META = /^(who\s+(are|r)\s+(you|u)|what\s+(are|r)\s+(you|u)|what\s+can\s+you\s+do|what\s+do\s+you\s+do|how\s+(are|r)\s+(you|u)|who\s+made\s+you|are\s+you\s+(there|real|alive|human|an?\s+ai))[\s?!.…]*$/i;

/**
 * Local, LLM-free gate for the lightweight CONVERSATION lane (P0-3). Returns true only for messages
 * that unambiguously need no tools, graph, memory, or verification — greetings, acknowledgements,
 * and a small set of identity/meta questions. Deliberately CONSERVATIVE: a false positive would send
 * real work down the no-tool lane, so anything with a coding verb, code/stack-trace context, an
 * @mention or file path, a URL, or non-trivial length is rejected and stays on the full harness.
 */
export function isConversational(prompt: string): boolean {
  const p = (prompt || '').trim();
  if (!p || p.length > 160) return false;
  if (/[@`]|https?:\/\/|[/\\]\w|\.[a-z]{1,4}\b/i.test(p)) return false; // file paths, code, URLs, extensions
  if (HEAVY_VERB.test(p) || CODE_CONTEXT.test(p)) return false;
  if (p.length <= 40 && CHATTY.test(p)) return true;
  if (CONVO_META.test(p)) return true;
  return false;
}
