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
 * Small corpora are exactly this store's case (a few hundred memories), where a term can easily be
 * in most of them. The `+1` inside the log floors IDF at zero: a ubiquitous term contributes
 * nothing rather than doing harm.
 */

/** Free parameters. These are the values the literature settled on; they are not arbitrary. */
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
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

export interface Bm25Document {
  id: string;
  text: string;
}

interface IndexedDocument {
  id: string;
  termFrequency: Map<string, number>;
  length: number;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

export class Bm25Index {
  private documents: IndexedDocument[] = [];
  /** How many documents contain each term. The denominator of IDF. */
  private documentFrequency = new Map<string, number>();
  private averageLength = 0;

  constructor(documents: Bm25Document[] = []) {
    this.build(documents);
  }

  /**
   * Rebuild from scratch.
   *
   * Not incremental, deliberately: IDF is a property of the whole corpus, so adding one document
   * changes the score of every other. An "incremental" index that skipped that would drift away
   * from correct ranking silently, and this corpus is small enough (hundreds) that a full rebuild
   * is microseconds.
   */
  build(documents: Bm25Document[]): void {
    this.documents = [];
    this.documentFrequency = new Map();

    let totalLength = 0;
    for (const document of documents) {
      const tokens = tokenize(document.text);
      const termFrequency = new Map<string, number>();
      for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
      for (const term of termFrequency.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
      this.documents.push({ id: document.id, termFrequency, length: tokens.length });
      totalLength += tokens.length;
    }
    this.averageLength = this.documents.length ? totalLength / this.documents.length : 0;
  }

  get size(): number {
    return this.documents.length;
  }

  /** Floored at 0 — see the header. A term in every document is uninformative, not harmful. */
  idf(term: string): number {
    const n = this.documents.length;
    if (!n) return 0;
    const df = this.documentFrequency.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Every document with a non-zero score, best first. Callers slice; fusion wants the ranking. */
  search(query: string): Bm25Hit[] {
    if (!this.documents.length || !this.averageLength) return [];
    const terms = tokenize(query);
    if (!terms.length) return [];

    // Query term frequency matters: asking for "clip clip clip" should not triple the weight of a
    // term the user typed once by accident of phrasing. Terms are therefore de-duplicated.
    const unique = [...new Set(terms)];
    const idf = new Map(unique.map((term) => [term, this.idf(term)]));

    const hits: Bm25Hit[] = [];
    for (const document of this.documents) {
      let score = 0;
      for (const term of unique) {
        const tf = document.termFrequency.get(term);
        if (!tf) continue;
        const weight = idf.get(term) ?? 0;
        if (weight <= 0) continue;
        // Saturating term frequency, normalized by how long this document is relative to the corpus.
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (document.length / this.averageLength));
        score += weight * ((tf * (BM25_K1 + 1)) / denominator);
      }
      if (score > 0) hits.push({ id: document.id, score });
    }

    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits;
  }
}
