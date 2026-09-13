import { QUICK_BAR, quickBarBounds, quickBarOrigin } from '../main/quick.bar';

const SCREEN = { x: 0, y: 25, width: 1440, height: 875 };
const SECOND = { x: 1440, y: 0, width: 1920, height: 1080 };

describe('where the ⌘2 bar opens', () => {
  test('with no remembered spot it opens like Spotlight: centred, a quarter of the way down', () => {
    expect(quickBarOrigin(undefined, [SCREEN], SCREEN)).toEqual({ x: (1440 - QUICK_BAR.width) / 2, y: Math.round(25 + 875 * QUICK_BAR.topShare) });
  });

  test('it reopens where the user dragged it, on any screen', () => {
    expect(quickBarOrigin({ x: 1600, y: 200 }, [SCREEN, SECOND], SCREEN)).toEqual({ x: 1600, y: 200 });
  });

  test('a spot that is no longer on a screen — a display was unplugged — falls back to the default', () => {
    expect(quickBarOrigin({ x: 1600, y: 200 }, [SCREEN], SCREEN)).toEqual(quickBarOrigin(undefined, [SCREEN], SCREEN));
    expect(quickBarOrigin({ x: 1000, y: 200 }, [SCREEN], SCREEN).x).toBe((1440 - QUICK_BAR.width) / 2);
  });
});

describe('how the ⌘2 bar grows', () => {
  const anchor = { x: 380, y: 235 };

  test('it never shrinks below the pill and grows downward from where it sits', () => {
    expect(quickBarBounds(anchor, 10, SCREEN)).toEqual({ ...anchor, width: QUICK_BAR.width, height: QUICK_BAR.collapsedHeight });
    expect(quickBarBounds(anchor, 400, SCREEN)).toEqual({ ...anchor, width: QUICK_BAR.width, height: 400 });
  });

  test('it is capped at a share of the screen, and the conversation scrolls inside beyond that', () => {
    expect(quickBarBounds(anchor, 5000, SCREEN).height).toBe(Math.floor(875 * QUICK_BAR.maxHeightShare));
  });

  test('near the bottom it moves up to fit, then returns to its spot when it shrinks again', () => {
    const low = { x: 380, y: 700 };
    const grown = quickBarBounds(low, 500, SCREEN);
    expect(grown.y + grown.height).toBeLessThanOrEqual(25 + 875);
    expect(grown.y).toBeLessThan(low.y);
    expect(quickBarBounds(low, QUICK_BAR.collapsedHeight, SCREEN).y).toBe(700);
  });

  test('a nonsense height request collapses to the pill instead of producing a broken window', () => {
    expect(quickBarBounds(anchor, Number.NaN, SCREEN).height).toBe(QUICK_BAR.collapsedHeight);
  });
});
