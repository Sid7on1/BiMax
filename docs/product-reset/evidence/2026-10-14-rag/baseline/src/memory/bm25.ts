/**
 * Okapi BM25 — the sparse half of hybrid retrieval.
 *
 * ## Why this replaces term-frequency cosine
 *
 * The store previously ranked by cosine over raw term-frequency vectors. That is a real similarity
 * measure and a poor *ranking* function, for two reasons it cannot express:
 *
 *   - **Every term counts the same.** A query for `MorphRegion clip-path` scores a document that
 *     says "the" a lot exactly as helpfully as one containing the rare word that identifies it.
 *     BM25 weights by inverse document frequency, so a term appearing in one document out of four
 *     hundred dominates a term appearing in three hundred of them. That is the entire difference
 *     between "shares words" and "is about this".
 *   - **Repetition scales linearly.** Under TF cosine a document that says "permission" nine times
 *     scores three times one that says it three times. BM25 saturates: `tf / (tf + k1)` approaches
 *     a ceiling, so the ninth mention adds almost nothing. Real relevance saturates too.
 *
 * BM25 also normalizes by document length, so a long document is not relevant merely by being long.
 *
 * ## The IDF trap
 *
 * The textbook IDF, `log((N - df + 0.5) / (df + 0.5))`, goes **negative** for any term appearing in
 * more than half the documents — at which point containing the query's own word actively *lowers* a
 * document's score, which is indefensible and produces rankings that look random on small corpora.
 * The `+1` inside the log keeps IDF positive, including for a ubiquitous term. Parameters and
 * tokenization stay unchanged when the query traversal uses inverted postings (record 88).
 */

/** Existing ranking parameters; changing them requires a relevance evaluation. */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

const STOP = new Set([
  'the', 'is', 'a', 'to', 'it', 'on', 'and', 'in', 'of', 'for', 'with', 'my', 'this', 'that',
  'says', 'an', 'be', 'are', 'as', 'at', 'or', 'from', 'was', 'were', 'by', 'we', 'you', 'i',
]);

/**
 * Words, lowercased, punctuation stripped.
 *
 * Single characters are dropped but **digits are kept**: version numbers, exit codes and error
 * numbers are among the most discriminating terms in this corpus, and a tokenizer that threw away
 * `0x8832` or `25208` would lose exactly the tokens a user searches for when something broke.
 *
 * Letters, combining marks and digits count in every script. An ASCII-only class deleted every
 * non-Latin letter, so a Hindi query tokenized to nothing and lexical search silently found nothing
 * (record 47, A07). Marks matter: Devanagari vowel signs are combining marks, and dropping them
 * splits one word into fragments.
 */
export function tokenize(text: string): string[] {
  // Keep each whole identifier and add only its components; prose terms keep their frequency.
  return text.replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ').split(/\s+/).flatMap(word => {
    const split = word.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
    return (split === word ? [word] : [word, ...split.split(' ')]).map(w => w.toLowerCase());
  }).filter(w => w.length > 1 && !STOP.has(w));
}

export interface Bm25Document {
  id: string;
  text: string;
}

interface IndexedDocument {
  id: string;
  length: number;
}

interface Posting {
  document: number;
  frequency: number;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

export class Bm25Index {
  private documents: IndexedDocument[] = [];
  /** Each term points only to the documents containing it; one posting per document. */
  private postings = new Map<string, Posting[]>();
  private averageLength = 0;

  constructor(documents: Bm25Document[] = []) {
    this.build(documents);
  }

  /**
   * Rebuild from scratch.
   *
   * Replace the corpus and all its statistics together. IDF and average length are computed from
   * the current corpus; no old postings survive a rebuild. Incremental updates are not exposed.
   */
  build(documents: Bm25Document[]): void {
    this.documents = [];
    this.postings = new Map();

    let totalLength = 0;
    for (const document of documents) {
      const tokens = tokenize(document.text);
      const termFrequency = new Map<string, number>();
      for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
      const documentIndex = this.documents.length;
      for (const [term, frequency] of termFrequency) {
        let list = this.postings.get(term);
        if (!list) this.postings.set(term, list = []);
        list.push({ document: documentIndex, frequency });
      }
      this.documents.push({ id: document.id, length: tokens.length });
      totalLength += tokens.length;
    }
    this.averageLength = this.documents.length ? totalLength / this.documents.length : 0;
  }

  get size(): number {
    return this.documents.length;
  }

  /** Positive Lucene-style IDF, including when every document contains the term. */
  idf(term: string): number {
    const n = this.documents.length;
    if (!n) return 0;
    const df = this.postings.get(term)?.length ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Every document with a non-zero score, best first. Callers slice; fusion wants the ranking. */
  search(query: string): Bm25Hit[] {
    if (!this.documents.length || !this.averageLength) return [];
    const terms = tokenize(query);
    if (!terms.length) return [];

    // Query term frequency matters: asking for "clip clip clip" should not triple the weight of a
    // term the user typed once by accident of phrasing. Terms are therefore de-duplicated.
    const unique = [...new Set(terms)].filter(term => this.postings.has(term));
    if (!unique.length) return [];
    // A single term needs no accumulator or union. This also avoids extra storage for ubiquitous
    // terms; postings already follow document order, preserving stable ties for duplicate IDs.
    if (unique.length === 1) {
      const weight = this.idf(unique[0]);
      const hits = this.postings.get(unique[0])!.map(posting => {
        const document = this.documents[posting.document];
        const tf = posting.frequency;
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (document.length / this.averageLength));
        return { id: document.id, score: weight * ((tf * (BM25_K1 + 1)) / denominator) };
      });
      return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    }
    // Dense numeric accumulators avoid Map/tuple overhead on common terms. Only matched ordinals
    // are sorted; the O(N) zeroed buffer costs eight bytes per document for a matching query.
    const scores = new Float64Array(this.documents.length);
    const matched: number[] = [];
    // Keep query-term order so each document's floating-point additions match the full scan.
    for (const term of unique) {
      const weight = this.idf(term);
      if (weight <= 0) continue;
      for (const posting of this.postings.get(term) ?? []) {
        const document = this.documents[posting.document];
        const tf = posting.frequency;
        // Saturating term frequency, normalized by how long this document is relative to the corpus.
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (document.length / this.averageLength));
        if (scores[posting.document] === 0) matched.push(posting.document);
        scores[posting.document] += weight * ((tf * (BM25_K1 + 1)) / denominator);
      }
    }
    // Ordinal tie-breaking also preserves stable input order when callers supply duplicate IDs.
    return matched.sort((a, b) => scores[b] - scores[a] || this.documents[a].id.localeCompare(this.documents[b].id) || a - b)
      .map(document => ({ id: this.documents[document].id, score: scores[document] }));
  }
}
