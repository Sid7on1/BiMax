/**
 * Automatic recall — the stage that decides whether any of the rest is ever used.
 *
 * ## The gap this closes
 *
 * Retrieval was reachable only through `MemoryQueryTool`: the model had to *decide* to search. That
 * makes recall conditional on the model noticing it might not know something, which is the one
 * thing models are reliably bad at. A perfect retrieval pipeline behind a tool the model never
 * calls contributes exactly nothing, and the failure is invisible — the answer is simply worse,
 * with no missing-tool-call to point at.
 *
 * So retrieval runs on the turn, not on request. The tool stays, because an explicit "search my
 * memory for X" is a different and legitimate act; this is the involuntary half.
 *
 * ## Why it does not run on every turn
 *
 * Because most turns do not need it, and a block of recalled memory injected into a turn that was
 * about the previous tool result is not neutral — it is a distraction with a token cost, and at the
 * volume of an agent loop it displaces the working context that turn actually depends on. Three
 * guards, cheapest first:
 *
 *   1. **Only on a user turn.** The turns in between are the model reacting to its own tool output;
 *      it has not asked anything new, so there is nothing new to recall against.
 *   2. **Only on a substantial one.** "yes", "continue", "try again" carry no retrievable intent,
 *      and searching on them returns whatever the store happens to rank highest for noise.
 *   3. **Never twice for the same thing.** A repeated query inside one session re-injects text the
 *      model can already see, which is pure cost.
 *
 * ## Why it is injected as a system note and marked
 *
 * The recalled text is *evidence the system found*, not something the user said, and attributing it
 * to the user would let the model treat a half-relevant old note as a fresh instruction. The block
 * is prefixed so the compaction passes can find and drop it — `ContextManager` already strips
 * `[RepoMap]` blocks the same way — and so a reader of the transcript can tell what the model was
 * given from what it was told.
 */

import type { VectorStore } from './vector.store';

export const RECALL_PREFIX = '[Recalled memory]';

/** Below this a message is an acknowledgement, not a question. Measured in characters. */
const MIN_QUERY_CHARS = 24;

export interface RecallOptions {
  limit?: number;
  /** How much recalled text may be injected. A recall bigger than the turn is not help. */
  maxChars?: number;
}

export interface RecalledMemory {
  text: string;
  ids: string[];
}

/**
 * Whether this turn should trigger a recall, and on what.
 *
 * Pure and exported so the policy is testable without a store, a model or a loop — every one of the
 * guards above is a decision that can regress silently otherwise.
 */
export function recallQuery(
  role: string,
  content: unknown,
  alreadyAsked: ReadonlySet<string>,
): string | null {
  if (role !== 'user') return null;
  if (typeof content !== 'string') return null;

  const text = content.trim();
  if (text.length < MIN_QUERY_CHARS) return null;
  // Slash commands are instructions to the CLI, not questions about the work.
  if (text.startsWith('/')) return null;
  // Our own injected blocks must never become a query — that recalls against a recall.
  if (text.startsWith(RECALL_PREFIX)) return null;

  const key = text.toLowerCase().replace(/\s+/g, ' ');
  if (alreadyAsked.has(key)) return null;
  return text;
}

/** Normalized form used to remember what has already been recalled against this session. */
export function recallKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Run the pipeline for this turn and format what it found.
 *
 * Returns null when there is nothing worth injecting, which includes the case where retrieval
 * itself failed — a recall block that says "no memories found" is noise the model has to read.
 */
export async function recallForTurn(
  store: VectorStore,
  query: string,
  options: RecallOptions = {},
): Promise<RecalledMemory | null> {
  const limit = options.limit ?? 3;
  const maxChars = options.maxChars ?? 1_800;

  let documents;
  try {
    // A floor of 0: the whole point is finding things phrased differently, and a lexical-overlap
    // threshold would filter out exactly those.
    documents = await store.semanticSearch(query, limit, 0);
  } catch {
    // Recall is an enhancement. A retrieval failure must never fail the user's turn.
    return null;
  }
  if (!documents.length) return null;

  const parts: string[] = [];
  const ids: string[] = [];
  let budget = maxChars;
  for (const doc of documents) {
    const content = (doc.metadata?.content || '').trim();
    if (!content) continue;
    // Truncate the last one that fits rather than dropping it: a partial memory is usually still
    // the fact that was wanted, and the alternative is silently recalling less than the budget.
    const slice = content.length <= budget ? content : content.slice(0, Math.max(0, budget - 1)).trimEnd() + '…';
    if (!slice) break;
    parts.push(`- ${slice}`);
    ids.push(doc.id);
    budget -= slice.length + 3;
    if (budget <= 80) break;
  }
  if (!parts.length) return null;

  return {
    ids,
    text: [
      `${RECALL_PREFIX} — retrieved for this turn, not stated by the user. May be outdated; verify before relying on it.`,
      ...parts,
    ].join('\n'),
  };
}
