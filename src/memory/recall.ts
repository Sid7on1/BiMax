import { reportCapability } from '../core/capability.status';
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

import type { StoredChunk, VectorDocument, VectorStore } from './vector.store';
import { evidenceSpan, versionOfText, type EvidenceSpan } from '../context/evidence';
import { tokenize } from './bm25';

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
  /** What was injected, as evidence: the memory, the version of its stored text, and which part. */
  evidence: EvidenceSpan[];
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
    //
    // project-memory is EXCLUDED: the persona already injects those as a prompt block every turn
    // (conventions are deliberately re-shown), and one memory arriving twice — from two paths
    // that cannot see each other — is the exact token cost this module's guards exist to prevent.
    // code is EXCLUDED for the same reason from the other side: source chunks belong to
    // CodeSearchTool, and auto-recall injecting a wall of code into a user turn is displacement,
    // not help. Recall is for durable knowledge; code has its own door.
    documents = await store.semanticSearch(query, limit, 0, { excludeTags: ['project-memory', 'code'], passages: true });
  } catch {
    reportCapability({ id: 'memory-recall', label: 'Memory recall', state: 'degraded',
      reason: 'Memory lookup failed.', impact: 'This turn continues without recalled context.',
      action: 'Check memory storage and retrieval settings.' });
    return null;
  }
  reportCapability({ id: 'memory-recall', label: 'Memory recall', state: 'ready',
    reason: 'Memory lookup completed.', impact: '', action: '' });
  if (!documents.length) return null;

  const parts: string[] = [];
  const ids: string[] = [];
  const evidence: EvidenceSpan[] = [];
  let budget = maxChars;
  for (const doc of documents) {
    const passage = passageOf(doc, budget, query);
    const content = passage.text;
    if (!content) continue;
    // Truncate the last one that fits rather than dropping it: a partial memory is usually still
    // the fact that was wanted, and the alternative is silently recalling less than the budget.
    const shown = content.length <= budget ? content : content.slice(0, Math.max(0, budget - 1)).trimEnd();
    const slice = shown === content ? content : `${shown}…`;
    if (!shown) break;
    parts.push(`- ${slice}`);
    ids.push(doc.id);
    evidence.push(...memoryEvidence(doc, passage, shown.length));
    budget -= slice.length + 3;
    if (budget <= 80) break;
  }
  if (!parts.length) return null;

  return {
    ids,
    evidence,
    text: [
      `${RECALL_PREFIX} — retrieved for this turn, not stated by the user. May be outdated; verify before relying on it.`,
      ...parts,
    ].join('\n'),
  };
}

/**
 * The part of a recalled document worth injecting: its matched chunks, best first until `budget` is
 * spent, shown in document order with their position when the document has several. Injecting the start
 * of the document lost the answer whenever it sat further down a long note (record 47, A03). A result
 * without matched chunks, from a store that does not report them, falls back to the whole content.
 */
interface Passage {
  text: string;
  /**
   * What `text` is made of, in order, joined by PASSAGE_JOINER: each chunk's position label and the text shown from it,
   * which is an excerpt (`partial`) when the whole chunk did not fit.
   */
  segments: Array<{ chunk: StoredChunk | null; label: string; body: string; partial?: boolean }>;
}

/** Room left for a label such as "(part 12 of 12, excerpt) " and the joiner, per segment. */
const LABEL_ALLOWANCE = 28;
/** A later chunk is excerpted only when at least this much of the budget is left for it. */
const MIN_EXCERPT_CHARS = 120;

/**
 * The lines of `text` that best answer `query`, contiguous and within `budget` characters: the line holding the most
 * weight of query terms, widened by its neighbours while they fit. A term weighs more the fewer lines hold it, so a
 * word on every line does not choose the line. With no query term in `text`, its head, as before.
 *
 * This is the "exact span" representation of record 47 §3.4 for recall. Showing the head of a chunk the budget could
 * not hold cut the answer whenever it sat at the chunk's end (context benchmark case B5).
 */
export function answeringExcerpt(text: string, query: string, budget: number): string {
  if (budget <= 0) return '';
  if (text.length <= budget) return text;
  const lines = text.split('\n');
  const terms = [...new Set(tokenize(query))];
  const lineTerms = lines.map((line) => new Set(tokenize(line)));
  const weight = new Map(terms.map((term) => {
    const holding = lineTerms.filter((set) => set.has(term)).length;
    return [term, holding ? Math.log(1 + lines.length / holding) : 0] as const;
  }));
  let best = -1;
  let bestScore = 0;
  lineTerms.forEach((set, i) => {
    let score = 0;
    for (const term of terms) if (set.has(term)) score += weight.get(term)!;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  if (best < 0) return text.slice(0, budget).trimEnd();
  if (lines[best].length > budget) return lines[best].slice(0, budget).trimEnd();
  let start = best;
  let end = best + 1;
  let length = lines[best].length;
  for (let grew = true; grew;) {
    grew = false;
    if (end < lines.length && length + 1 + lines[end].length <= budget) { length += 1 + lines[end].length; end++; grew = true; }
    if (start > 0 && length + 1 + lines[start - 1].length <= budget) { start--; length += 1 + lines[start].length; grew = true; }
  }
  return lines.slice(start, end).join('\n').trim();
}

const PASSAGE_JOINER = '\n  ';

function passageOf(doc: VectorDocument, budget: number, query: string): Passage {
  const chunks = doc.chunks ?? [];
  const matched = doc.matchedChunks ?? [];
  if (!matched.length || !chunks.length) {
    const whole = (doc.metadata?.content || '').trim();
    const body = whole.length > budget ? answeringExcerpt(whole, query, Math.max(0, budget - LABEL_ALLOWANCE)) : whole;
    const partial = body.length < whole.length;
    return { text: `${partial ? '(excerpt) ' : ''}${body}`, segments: body ? [{ chunk: null, label: partial ? '(excerpt) ' : '', body, partial }] : [] };
  }
  const picked: Array<{ chunk: StoredChunk; body: string }> = [];
  let used = 0;
  for (const chunk of matched) {
    const whole = chunk.text.trim();
    if (used + whole.length + LABEL_ALLOWANCE <= budget) {
      picked.push({ chunk, body: whole });
      used += whole.length + LABEL_ALLOWANCE;
      continue;
    }
    // A chunk the budget cannot hold is shown as the lines that answer the query. The best chunk always gets its
    // excerpt; a later one only when enough budget is left to say something.
    const room = budget - used - LABEL_ALLOWANCE;
    if (picked.length && room < MIN_EXCERPT_CHARS) continue;
    const body = answeringExcerpt(whole, query, Math.max(0, room));
    if (!body) continue;
    picked.push({ chunk, body });
    used += body.length + LABEL_ALLOWANCE;
  }
  const segments = picked
    .map(({ chunk, body }) => ({ chunk, body, at: chunks.indexOf(chunk), partial: body.length < chunk.text.trim().length }))
    .sort((a, b) => a.at - b.at)
    .map(({ chunk, body, at, partial }) => {
      const position = chunks.length > 1 && at >= 0 ? `part ${at + 1} of ${chunks.length}` : '';
      const label = position || partial ? `(${[position, partial ? 'excerpt' : ''].filter(Boolean).join(', ')}) ` : '';
      return { chunk, body, label, partial };
    })
    .filter((segment) => segment.body);
  return { text: segments.map((segment) => segment.label + segment.body).join(PASSAGE_JOINER), segments };
}

/**
 * A recalled document as evidence: one span per injected chunk, or one for the whole note when no chunk was reported,
 * holding exactly the text the recall block shows. The first `shownChars` of the passage reached the prompt; a chunk
 * the budget cut is recorded as its visible part and marked partial, and one cut entirely is not recorded. Recording
 * the whole chunk claimed the model saw text it never did (audit 51, U07). The version is the hash of the stored text.
 * A memory records no date, so `validFrom` stays unset rather than guessed.
 */
function memoryEvidence(doc: VectorDocument, passage: Passage, shownChars: number): EvidenceSpan[] {
  const content = doc.metadata?.content || '';
  const chunks = doc.chunks ?? [];
  const base = {
    sourceId: `memory:${doc.id}`,
    sourceVersion: versionOfText(content),
    scope: { tags: doc.metadata?.tags ?? [] },
    derivedFrom: [],
    kind: 'source' as const,
  };
  const spans: EvidenceSpan[] = [];
  let offset = 0;
  passage.segments.forEach((segment, n) => {
    if (n > 0) offset += PASSAGE_JOINER.length;
    const start = offset + segment.label.length;
    offset = start + segment.body.length;
    const text = segment.body.slice(0, Math.max(0, Math.min(segment.body.length, shownChars - start))).trimEnd();
    if (!text) return;
    const partial = text.length < segment.body.length || segment.partial ? { partial: true } : {};
    const locator = segment.chunk
      ? { kind: 'memory' as const, documentId: doc.id, part: chunks.indexOf(segment.chunk) + 1, parts: chunks.length, ...partial }
      : { kind: 'memory' as const, documentId: doc.id, ...partial };
    spans.push(evidenceSpan({ ...base, locator, text }));
  });
  return spans;
}

/**
 * Whether compaction dropped a recall block: `before` held one that `after` no longer contains.
 *
 * Compaction drops recall blocks because they are evidence for the turn they were retrieved for. The
 * session's "already recalled" set has to forget when that happens, or a question whose evidence was
 * compacted away could never recall again (record 47, A04).
 */
export function droppedRecall(
  before: readonly { role: string; content?: unknown }[],
  after: readonly { role: string; content?: unknown }[],
): boolean {
  const kept = new Set(after);
  return before.some((message) =>
    message.role === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith(RECALL_PREFIX)
    && !kept.has(message));
}
