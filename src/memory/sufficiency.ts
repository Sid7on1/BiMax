import { tokenize } from './bm25';

/**
 * Whether memory knows what a question is about (record 47 §4, record 50 step 7).
 *
 * Lexical retrieval cannot tell a note that answers from a note that shares one word with the question. "What is the
 * guest wifi password at the office?" retrieved "The office moves to the third floor in May; guests sign in at
 * reception." and recall injected it (context benchmark case S5). The signal used here is coarse and deliberate: the
 * question's content words that appear in no memory at all. When at least half of them are unknown, the store does not
 * know the subject, and a partial match is a coincidence.
 *
 * This is a heuristic about lexical evidence, not a judgement of relevance: a note phrased with none of the question's
 * words is invisible to it, which is the dense stage's job, so callers apply it only when no dense stage ran.
 */

/** Question and filler words that say nothing about the subject. `tokenize` already drops the commonest English ones. */
const FILLER = new Set([
  'what', 'how', 'do', 'does', 'did', 'done', 'when', 'which', 'why', 'who', 'whom', 'where', 'whose', 'can', 'could',
  'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'there', 'their', 'our', 'your', 'about', 'into', 'any',
  'some', 'not', 'no', 'yes', 'has', 'have', 'had', 'been', 'being', 'me', 'us', 'them', 'they', 'he', 'she', 'his',
  'her', 'its', 'than', 'then', 'so', 'if', 'but', 'tell', 'please', 'explain', 'show', 'know', 'need', 'want', 'just',
  'also', 'really', 'now', 'still', 'again', 'ever', 'there', 'here', 'these', 'those', 'am',
]);

/** The share of a question's content words that may be unknown to memory before recall abstains. */
export const UNKNOWN_SUBJECT_SHARE = 0.5;

/** A light English stem, so "blocks", "blocked" and "blocking" are one word. Other scripts are left as they are. */
export function stem(term: string): string {
  if (!/^[a-z]+$/.test(term)) return term;
  if (term.length > 5 && term.endsWith('ing')) return term.slice(0, -3);
  if (term.length > 4 && (term.endsWith('ied') || term.endsWith('ies'))) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && term.endsWith('ed')) return term.slice(0, -2);
  if (term.length > 4 && /(?:ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

/** The distinct stemmed content words of `text`. */
export function contentStems(text: string): string[] {
  return [...new Set(tokenize(text).filter((term) => !FILLER.has(term)).map(stem))];
}
