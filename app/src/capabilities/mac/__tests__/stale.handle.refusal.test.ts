import { BimaxComputerRuntime } from '../desktop.runtime';

/**
 * The stale-handle refusal must not advertise a truncated list as a complete one.
 *
 * Measured 2026-08-18 in Music: the observation carried 33 elements at indexes 0-32, and this
 * refusal announced "addressable indexes in the current frame: 0, 1, ... 11" plus eight labels —
 * every one of them sidebar chrome (Music, Sidebar, Search, Home, New, Radio, Library, Pins), and
 * not one of the user's playlists. A model that believes the refusal confines itself to the handles
 * it was shown, so the truncation steers it away from the content it is hunting for.
 */
function runtimeWith(elements: any[]) {
  const runtime = Object.create(BimaxComputerRuntime.prototype) as any;
  runtime.observedTarget = { pid: 1, windowId: 2, width: 100, height: 100 };
  runtime.observedElements = elements;
  runtime.indexedElements = new Map(
    elements.map((element, index) => [`index:${index}`, { ...element, role: element.role || 'AXRow' }]),
  );
  return runtime;
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
  role: 'AXRow', label: `Row ${i}`,
}));

describe('stale-handle refusal reports the whole frame', () => {
  it('gives an index RANGE and the total when there are many handles', () => {
    const runtime = runtimeWith(rows(33));
    let message = '';
    try { runtime.resolveObservedHandle({ pid: 1, windowId: 2 }, { elementIndex: 99 }); }
    catch (e: any) { message = String(e.message); }

    expect(message).toContain('0-32');
    expect(message).toContain('33 total');
    // The old message stopped at 11 and implied nothing beyond it existed.
    expect(message).not.toMatch(/current frame: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11\)/);
  });

  it('says how many labels were withheld instead of implying there are only eight', () => {
    const runtime = runtimeWith(rows(33));
    let message = '';
    try { runtime.resolveObservedHandle({ pid: 1, windowId: 2 }, { elementIndex: 99 }); }
    catch (e: any) { message = String(e.message); }

    expect(message).toMatch(/… and 25 more \(33 total\)/);
  });

  it('lists them plainly when the frame is small enough to show in full', () => {
    const runtime = runtimeWith(rows(3));
    let message = '';
    try { runtime.resolveObservedHandle({ pid: 1, windowId: 2 }, { elementIndex: 99 }); }
    catch (e: any) { message = String(e.message); }

    expect(message).toContain('0, 1, 2');
    expect(message).not.toContain('total');
    expect(message).not.toContain('more');
  });
});
