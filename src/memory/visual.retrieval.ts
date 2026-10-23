/**
 * Visual document retrieval — searching pages as images, with no OCR in the path.
 *
 * ## The failure this removes
 *
 * Every other retriever in this codebase reads text. That is fine while there IS text: a born-digital
 * PDF has a layer, and `extract.ts` takes it. It stops being fine on the documents this product was
 * built for. A photocopied inspection report, a P&ID, a scanned register — recognizer accuracy on
 * those is reported to fall from the 95-99% of clean text to roughly 60-80%, and the errors are not
 * uniform noise: they cluster on exactly the tokens that carry meaning, the equipment tags and the
 * measurements. Retrieval then fails on the one document class where a miss is expensive, and it
 * fails quietly, because a page that OCR'd badly still produces text and still gets indexed.
 *
 * ColPali-family models skip the transcription step. The page image is embedded directly, so layout,
 * table ruling, figures and small print are part of the representation rather than casualties of it.
 *
 * ## Late interaction, and why it needs its own store
 *
 * A dense retriever gives one vector per document. These give one per image patch — roughly a
 * thousand of them — and relevance is computed by MaxSim: for each query token, the single
 * best-matching patch, summed across the query. The consequence is that a query about one cell of a
 * table can match the patch holding that cell, instead of being averaged into a page-wide blur.
 *
 * That is also why this cannot be folded into `vector.store.ts`. A `StoredChunk` holds one vector,
 * `dot()` scores a pair, and the whole file assumes both. Multi-vector pages are a different shape
 * with a different cost model, so they live here and are fused with the text lane by rank, never by
 * score — the two produce numbers on incomparable scales.
 *
 * ## The cost, stated plainly
 *
 * ~256 KB per page in float16, against ~8.6 KB for a dense embedding of the same page: about thirty
 * times. A 10,000-page corpus is ~2.5 GB of vectors. {@link storageEstimate} exists so that number
 * is visible before someone indexes an archive, and pooling is exposed so it can be traded down.
 */

import { normalize } from './embeddings';

/** One page, as the patch vectors that represent it. */
export interface MultiVectorPage {
  id: string;
  /** Where the page came from, kept so a hit can be cited. */
  source: { file: string; page: number };
  /** `vectors[i]` is one patch. All must share a length. */
  vectors: number[][];
}

export interface VisualHit {
  id: string;
  source: { file: string; page: number };
  /** MaxSim total. Comparable WITHIN one query's results and meaningless across queries. */
  score: number;
}

/**
 * MaxSim: the late-interaction score of one query against one page.
 *
 * For each query token take its single best-matching patch and sum those maxima. Summed, not
 * averaged: a query that matches four things well should outrank one that matches one thing well,
 * and averaging would make them equal. The consequence — longer queries score higher in absolute
 * terms — is why the score is documented as comparable only within one query's results.
 *
 * Both sides are assumed unit-length so the dot product IS cosine; {@link toPage} and
 * {@link toQuery} normalize on the way in rather than trusting the server to have done it.
 */
export function maxSim(query: number[][], page: number[][]): number {
  if (query.length === 0 || page.length === 0) return 0;
  let total = 0;
  for (const token of query) {
    let best = -Infinity;
    for (const patch of page) {
      const n = Math.min(token.length, patch.length);
      let sum = 0;
      for (let i = 0; i < n; i++) sum += token[i] * patch[i];
      if (sum > best) best = sum;
    }
    // A patch set that shares no dimensions with the query contributes nothing rather than -Infinity,
    // which would otherwise poison the whole page's total on one malformed row.
    total += Number.isFinite(best) ? best : 0;
  }
  return total;
}

/**
 * Rank pages against an embedded query, best first.
 *
 * Ties keep their input order: `sort` is stable in Node, and an arbitrary reshuffle of equally
 * scored pages makes results non-reproducible between runs for no benefit.
 */
export function scorePages(query: number[][], pages: readonly MultiVectorPage[], limit = 10): VisualHit[] {
  const hits = pages.map((p) => ({ id: p.id, source: p.source, score: maxSim(query, p.vectors) }));
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit));
}

/** Normalize every patch of a page. Rejects a ragged page rather than scoring one silently. */
export function toPage(id: string, source: { file: string; page: number }, vectors: number[][]): MultiVectorPage {
  if (vectors.length > 0) {
    const width = vectors[0].length;
    for (const v of vectors) {
      if (v.length !== width) {
        throw new Error(
          `page ${id} has patches of differing width (${width} vs ${v.length}) — the encoder returned `
          + 'something this store cannot score, and padding it would invent similarity',
        );
      }
    }
  }
  return { id, source, vectors: vectors.map(normalize) };
}

export function toQuery(vectors: number[][]): number[][] {
  return vectors.map(normalize);
}

/**
 * What indexing this many pages will cost on disk, in bytes.
 *
 * Surfaced because the number is genuinely surprising — thirty times a dense index — and finding
 * that out after a 40,000-page ingest fills a disk is the kind of discovery this codebase keeps
 * writing memories about.
 */
export function storageEstimate(pages: number, patchesPerPage = 1024, dims = 128, bytesPerValue = 2): number {
  return pages * patchesPerPage * dims * bytesPerValue;
}

/** An in-memory page index. Deliberately small: persistence belongs with the corpus, not here. */
export class VisualPageIndex {
  private readonly pages = new Map<string, MultiVectorPage>();

  add(page: MultiVectorPage): void {
    this.pages.set(page.id, page);
  }

  remove(id: string): boolean {
    return this.pages.delete(id);
  }

  get size(): number {
    return this.pages.size;
  }

  all(): readonly MultiVectorPage[] {
    return [...this.pages.values()];
  }

  search(query: number[][], limit = 10): VisualHit[] {
    return scorePages(query, this.all(), limit);
  }

  /** Bytes actually held, from the real patch counts rather than the nominal estimate. */
  footprint(bytesPerValue = 8): number {
    let total = 0;
    for (const page of this.pages.values()) {
      for (const patch of page.vectors) total += patch.length * bytesPerValue;
    }
    return total;
  }
}
