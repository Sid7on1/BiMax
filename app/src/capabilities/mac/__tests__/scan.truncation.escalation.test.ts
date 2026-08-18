import { nextScanCapForTruncatedWalk } from '../desktop.runtime';

/**
 * A plain `observe` that filled its element cap returned a PARTIAL window and then told the model
 * to "use pixel clicks for elements not visible in this partial tree" — i.e. to guess coordinates
 * for everything it could not see. That is how a click lands off target.
 *
 * Measured 2026-08-18 in Music: cap 120 returned 33 elements, every one a sidebar row; the songs
 * the request was about were never scanned. The existing ladder did not help, because it escalates
 * only for a NAMED query that was not found, or for a walk that yielded zero window elements.
 */
const CEILING = 2000;

describe('a truncated element walk is escalated once', () => {
  it('escalates the live Music case (cap 120, walk filled)', () => {
    expect(nextScanCapForTruncatedWalk({
      hasQuery: false, scanned: 120, returned: 120, ceiling: CEILING,
    })).toBe(600);
  });

  it('accepts a complete walk that stopped short of its cap', () => {
    expect(nextScanCapForTruncatedWalk({
      hasQuery: false, scanned: 120, returned: 33, ceiling: CEILING,
    })).toBeNull();
  });

  it('leaves a named query to its own progressive search', () => {
    expect(nextScanCapForTruncatedWalk({
      hasQuery: true, scanned: 120, returned: 120, ceiling: CEILING,
    })).toBeNull();
  });

  it('doubles a large cap rather than nudging it, and never exceeds the ceiling', () => {
    expect(nextScanCapForTruncatedWalk({
      hasQuery: false, scanned: 600, returned: 600, ceiling: CEILING,
    })).toBe(1200);
    expect(nextScanCapForTruncatedWalk({
      hasQuery: false, scanned: 1500, returned: 1500, ceiling: CEILING,
    })).toBe(CEILING);
  });

  it('stops at the ceiling instead of looping', () => {
    expect(nextScanCapForTruncatedWalk({
      hasQuery: false, scanned: CEILING, returned: CEILING, ceiling: CEILING,
    })).toBeNull();
  });
});
