/**
 * Reciprocal Rank Fusion — how the sparse and dense rankings become one ranking.
 *
 * ## Why not just add the scores
 *
 * Because they are not on the same scale, and nothing makes them so. BM25 is unbounded above and
 * corpus-dependent: the same query against the same documents produces scores in the single digits
 * on one corpus and the tens on another. Cosine over unit vectors is bounded in [-1, 1] and its
 * useful range is usually compressed into [0.3, 0.9]. Adding them lets BM25 drown the dense signal
 * on one corpus and vanish under it on the next, with no error and no way to notice from the
 * output. Min-max normalizing first is the usual patch and it is worse than it looks: it makes
 * every score depend on the best and worst result *in that particular query's result set*, so a
 * single outlier silently rescales everything.
 *
 * RRF sidesteps the whole problem by throwing the scores away and keeping only the **ranks**. A
 * document's contribution from a list is `1 / (k + rank)`. Rank is comparable across any two
 * rankers by construction, there is nothing to tune per corpus, and it is the default fusion in
 * Elasticsearch and Qdrant for exactly this reason.
 *
 * ## What k does
 *
 * `k` damps how much the top of a list dominates. At k=60 the first result contributes 1/61 and the
 * tenth 1/70 — close enough that a document ranked 1st by one retriever and 30th by the other
 * loses to a document both rank in their top ten. That is the desired behaviour: agreement between
 * two different notions of relevance is stronger evidence than one retriever's enthusiasm. 60 is
 * the published default and is not a number worth inventing a new value for.
 */

export const RRF_K = 60;

export interface RankedList {
  /** Document ids, best first. Only order is read — any scores have already done their job. */
  ids: string[];
  /**
   * Relative influence. 1 for both lists is the honest default and what ships; the knob exists so
   * a caller with a measured reason (a corpus where one retriever is known weaker) can act on it
   * rather than reaching back into this file.
   */
  weight?: number;
}

export interface FusedHit {
  id: string;
  score: number;
  /** Which lists contributed, and at what rank — the only way to debug a surprising ordering. */
  ranks: Record<string, number>;
}

/**
 * Fuse any number of ranked lists.
 *
 * A document missing from a list simply contributes nothing from it — no penalty, no imputed rank.
 * That is what makes RRF safe when one retriever is unavailable: with the dense list empty, the
 * result is exactly the sparse ranking, in order, rather than a degraded blend of a real ranking
 * and an absent one.
 */
export function reciprocalRankFusion(
  lists: Record<string, RankedList>,
  k: number = RRF_K,
): FusedHit[] {
  const fused = new Map<string, FusedHit>();

  for (const [name, list] of Object.entries(lists)) {
    const weight = list.weight ?? 1;
    list.ids.forEach((id, index) => {
      const rank = index + 1;
      let hit = fused.get(id);
      if (!hit) {
        hit = { id, score: 0, ranks: {} };
        fused.set(id, hit);
      }
      hit.score += weight * (1 / (k + rank));
      hit.ranks[name] = rank;
    });
  }

  // Tie-breaking, in order of evidential strength:
  //   1. fused score (the actual RRF result);
  //   2. AGREEMENT — the doc ranked by more retrievers beats the single-list enthusiast. A
  //      lexical-only rank-1 and a dense-only rank-1 fuse to the same score (1/(k+1) each), and
  //      that exact tie is common whenever one retriever is weak or absent for a query. Breaking
  //      it by id (the old rule) let alphabetically-early noise outrank a real exact-token hit;
  //   3. the LEXICAL rank — with membership still tied, exact tokens are the stronger signal
  //      (that is grep's home ground, and the one place lexical never hallucinates);
  //   4. id — determinism only, never preference.
  const lexicalRank = (hit: FusedHit): number => hit.ranks.lexical ?? Number.MAX_SAFE_INTEGER;
  return [...fused.values()].sort(
    (a, b) =>
      b.score - a.score
      || Object.keys(b.ranks).length - Object.keys(a.ranks).length
      || lexicalRank(a) - lexicalRank(b)
      || a.id.localeCompare(b.id),
  );
}
