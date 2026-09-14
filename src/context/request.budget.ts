import { encode } from 'gpt-tokenizer';

/**
 * The request boundary: one budget for everything a model request carries (record 47 §3.4, record 50 step 6c).
 *
 *   messageBudget = window − system prompt − tool schemas − reply reserve − margin
 *
 * Compaction budgeted only the history, against thresholds, and learned how large the system prompt and tool schemas
 * were from the provider's usage report after a request had already gone out, so a request could leave larger than the
 * window (context benchmark case R1). Here the fixed parts are measured with the same tokenizer as the history before
 * anything is sent, the reply keeps its reserve, and a request that cannot fit even after the history gives way is not
 * sent at all (R2).
 */

/** Share of the window held back for the reply, never more than the configured output budget. */
const OUTPUT_RESERVE_SHARE = 0.15;
/** Share of the window left unused for differences between this tokenizer and the provider's. */
const MARGIN_SHARE = 0.03;
/** Tokens a provider adds to each message for its role and framing. */
export const MESSAGE_FRAMING_TOKENS = 4;

export interface RequestPlan {
  window: number;
  system: number;
  tools: number;
  outputReserve: number;
  margin: number;
  /** What is left for the messages; zero or less when the fixed parts alone do not fit. */
  messageBudget: number;
}

export interface RequestRecord extends RequestPlan {
  /** Tokens the messages took, as sent or as they stood when the request was refused. */
  messages: number;
  sent: boolean;
  /** What gave way to fit, in the order it happened. Empty when the request fitted as it was. */
  steps: string[];
  /** Evidence spans whose text was in the request (the residency ledger, record 47 §3.5). */
  residentEvidenceIds: string[];
  at: string;
}

/** Tokens in `text` under the tokenizer the history is measured with. */
export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

// The system prompt and the schema list are the same strings round after round; measure each once.
const measured = new Map<string, number>();
function cachedTokens(text: string): number {
  const hit = measured.get(text);
  if (hit !== undefined) return hit;
  const tokens = countTokens(text);
  measured.set(text, tokens);
  if (measured.size > 8) measured.delete(measured.keys().next().value as string);
  return tokens;
}

export function planRequest(input: { window: number; systemPrompt: string; tools: readonly unknown[]; outputBudget: number }): RequestPlan {
  const window = Math.max(1, Math.floor(input.window));
  const system = cachedTokens(input.systemPrompt ?? '');
  const tools = input.tools.length ? cachedTokens(JSON.stringify(input.tools)) : 0;
  const outputReserve = Math.max(0, Math.min(Math.floor(input.outputBudget), Math.floor(window * OUTPUT_RESERVE_SHARE)));
  const margin = Math.ceil(window * MARGIN_SHARE);
  return { window, system, tools, outputReserve, margin, messageBudget: window - system - tools - outputReserve - margin };
}

/** What the user reads when a request is not sent: the numbers, and what would make it fit. */
export function overflowMessage(plan: RequestPlan, messageTokens: number): string {
  const fixed = plan.system + plan.tools;
  if (plan.messageBudget <= 0) {
    return `This request does not fit the model's context window, so nothing was sent. The instructions and tool definitions alone need about ${fixed} tokens, and with ${plan.outputReserve} held back for the reply that is more than the ${plan.window}-token window. Switch to a model with a larger context window, or turn off instructions or tools this task does not need.`;
  }
  return `This request does not fit the model's context window, so nothing was sent. After clearing old tool results, summarizing and moving the oldest turns out, the conversation still needs about ${messageTokens} tokens, and ${plan.messageBudget} are left once the instructions (${fixed}) and the reply's reserve (${plan.outputReserve}) are counted. The latest message and the work since it are too large on their own: split the request, or switch to a model with a larger context window.`;
}
