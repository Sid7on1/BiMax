import {
  maxSim, scorePages, toPage, toQuery, storageEstimate, VisualPageIndex, MultiVectorPage,
} from '../memory/visual.retrieval';
import { normalize, dot } from '../memory/embeddings';

/**
 * Late interaction is the whole reason this lane exists, so it is tested as the property it claims
 * rather than as a handful of remembered numbers: a page that contains ONE patch matching the query
 * must beat a page that is vaguely similar all over, and it must keep beating it as the page grows.
 * That is exactly what a single pooled vector per page cannot do, and the fourth test below measures
 * the gap rather than asserting it.
 */

const src = (page: number) => ({ file: 'E-204 Inspection Report.pdf', page });

describe('MaxSim scores a query against a page', () => {
  it('takes the best patch per query token and sums them', () => {
    // Orthogonal unit patches: each query token matches exactly one of them, at 1.0.
    const page = [[1, 0], [0, 1]];
    expect(maxSim([[1, 0]], page)).toBeCloseTo(1);
    expect(maxSim([[1, 0], [0, 1]], page)).toBeCloseTo(2);
  });

  it('sums rather than averages, so matching more of the query scores higher', () => {
    const page = [[1, 0], [0, 1]];
    const one = maxSim([[1, 0]], page);
    const both = maxSim([[1, 0], [0, 1]], page);
    expect(both).toBeGreaterThan(one);
  });

  it('an empty query or an empty page scores zero, never NaN', () => {
    expect(maxSim([], [[1, 0]])).toBe(0);
    expect(maxSim([[1, 0]], [])).toBe(0);
    expect(maxSim([], [])).toBe(0);
  });

  it('THE PROPERTY — one exact patch survives a page full of irrelevant ones', () => {
    // Nine patches about something else, one about the query. This is a figure on a page of prose,
    // or one cell in a table of readings.
    const patches: number[][] = [...Array<number[]>(9).fill([0, 1]), [1, 0]];
    const query: number[][] = [[1, 0]];

    const late = maxSim(query, patches);

    // What a single-vector retriever would have scored: mean-pool the page, then cosine.
    const pooled = normalize(patches[0].map((_, i) => patches.reduce((s, p) => s + p[i], 0) / patches.length));
    const dense = dot(query[0], pooled);

    expect(late).toBeCloseTo(1);          // the exact patch is found intact
    expect(dense).toBeLessThan(0.2);      // and would have been diluted to near-nothing
    expect(late / dense).toBeGreaterThan(5);
  });

  it('a malformed patch row cannot poison the page total', () => {
    // A zero-width row contributes 0, not -Infinity.
    expect(Number.isFinite(maxSim([[1, 0]], [[]]))).toBe(true);
    expect(maxSim([[1, 0]], [[]])).toBe(0);
  });
});

describe('pages are ranked, cited and bounded', () => {
  const pages: MultiVectorPage[] = [
    toPage('p1', src(1), [[0, 1], [0, 1]]),
    toPage('p2', src(2), [[1, 0], [0, 1]]),
    toPage('p3', src(3), [[0.7, 0.7]]),
  ];

  it('ranks by MaxSim, best first, and carries the citation through', () => {
    const hits = scorePages(toQuery([[1, 0]]), pages);
    expect(hits[0].id).toBe('p2');
    expect(hits[0].source).toEqual({ file: 'E-204 Inspection Report.pdf', page: 2 });
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('respects the limit', () => {
    expect(scorePages(toQuery([[1, 0]]), pages, 2)).toHaveLength(2);
    expect(scorePages(toQuery([[1, 0]]), pages, 0)).toHaveLength(0);
  });

  it('keeps equally scored pages in input order, so a run is reproducible', () => {
    const tied: MultiVectorPage[] = [
      toPage('a', src(1), [[1, 0]]),
      toPage('b', src(2), [[1, 0]]),
      toPage('c', src(3), [[1, 0]]),
    ];
    expect(scorePages(toQuery([[1, 0]]), tied).map((h) => h.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('vectors are normalized on the way in, and ragged ones are refused', () => {
  it('normalizes patches so the dot product is a cosine', () => {
    const page = toPage('p', src(1), [[3, 4]]);      // length 5
    expect(page.vectors[0][0]).toBeCloseTo(0.6);
    expect(page.vectors[0][1]).toBeCloseTo(0.8);
  });

  it('refuses a page whose patches differ in width rather than scoring it', () => {
    // Padding would invent similarity in the dimensions that were never measured.
    expect(() => toPage('p', src(1), [[1, 0], [1, 0, 0]])).toThrow(/differing width/);
  });

  it('an empty page is allowed — a blank scan is a real page that matches nothing', () => {
    const page = toPage('blank', src(7), []);
    expect(page.vectors).toEqual([]);
    expect(maxSim([[1, 0]], page.vectors)).toBe(0);
  });
});

describe('the storage cost is visible before it is paid', () => {
  it('reproduces the published per-page figure', () => {
    // 1024 patches x 128 dims x 2 bytes = 262,144 — the paper's "256 KB per page".
    expect(storageEstimate(1)).toBe(262_144);
    expect(storageEstimate(1) / 1024).toBe(256);
  });

  it('is the number that makes a large corpus a decision', () => {
    // ~2.5 GB for 10k pages, against ~86 MB for the same pages densely embedded at 8.6 KB.
    expect(storageEstimate(10_000) / 1024 ** 3).toBeGreaterThan(2);
  });
});

describe('the page index', () => {
  it('adds, searches, removes and reports what it actually holds', () => {
    const index = new VisualPageIndex();
    index.add(toPage('p1', src(1), [[1, 0]]));
    index.add(toPage('p2', src(2), [[0, 1]]));
    expect(index.size).toBe(2);

    expect(index.search(toQuery([[1, 0]]), 1)[0].id).toBe('p1');

    // Footprint is measured from the real patch counts, not the nominal estimate.
    expect(index.footprint(8)).toBe(2 * 2 * 8);

    expect(index.remove('p1')).toBe(true);
    expect(index.remove('p1')).toBe(false);
    expect(index.size).toBe(1);
  });

  it('re-adding an id replaces rather than duplicates', () => {
    const index = new VisualPageIndex();
    index.add(toPage('p1', src(1), [[1, 0]]));
    index.add(toPage('p1', src(1), [[0, 1]]));
    expect(index.size).toBe(1);
    expect(index.search(toQuery([[0, 1]]), 1)[0].score).toBeCloseTo(1);
  });
});
