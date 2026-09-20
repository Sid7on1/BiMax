import { applyRenderMode, renderModeFor, startRenderMode, type RenderModeTarget } from '../renderer/src/render.mode';
import { renderingPolicy, type RuntimeSignals } from '../phase9/adaptive.policy';
import type { AdaptiveRuntimeSnapshot } from '../renderer/src/global';

/**
 * WP-2 (docs/product-reset/57): the rendering half of the adaptive policy is applied.
 *
 * Before this it was computed every 30 s at `renderingPolicy(signals, false)` and read by nothing —
 * `RenderingDecision` was declared in global.d.ts and had no consumer anywhere in the renderer.
 *
 * These assert PROPERTIES: which class of motion stops, and that the failure direction is more
 * motion rather than less. No timing and no frame count is asserted (bimax-perf-constants-pinned).
 */

const signals = (over: Partial<RuntimeSignals> = {}): RuntimeSignals => ({
  observedAt: 0, architecture: 'arm64', cpuCount: 8, availableMemoryMb: 4096, totalMemoryMb: 8192,
  thermal: 'nominal', memoryPressure: 'normal', powerSource: 'ac', lowPowerMode: false,
  network: 'normal', activeInteraction: false, reduceMotion: false,
  simulatorReservationMb: 0, localModelReservationMb: 0, ...over,
});

/** Stands in for `document.documentElement`; app/src/__tests__ runs without a DOM by design. */
function target(initial?: string): RenderModeTarget & { value: string | undefined } {
  return {
    value: initial,
    setAttribute(name, value) { if (name === 'data-render-mode') this.value = value; },
    removeAttribute(name) { if (name === 'data-render-mode') this.value = undefined; },
  };
}

describe('quiet is driven by sustained pressure, not by interaction', () => {
  test.each([
    ['Low Power Mode', { lowPowerMode: true }],
    ['a serious thermal state', { thermal: 'serious' as const }],
    ['a critical thermal state', { thermal: 'critical' as const }],
    ['critical memory pressure', { memoryPressure: 'critical' as const }],
    ['battery power', { powerSource: 'battery' as const }],
  ])('%s asks for quiet', (_label, over) => {
    expect(renderingPolicy(signals(over), true).mode).toBe('quiet');
  });

  test('typing does NOT ask for quiet', () => {
    // It does constrain background concurrency, and should. For rendering it would stop decoration
    // on every keystroke and restart it two seconds later — visible churn, worse than either state.
    expect(renderingPolicy(signals({ activeInteraction: true }), true).mode).toBe('full');
  });

  test('a healthy Mac on AC renders fully', () => {
    expect(renderingPolicy(signals(), true).mode).toBe('full');
  });

  test('Reduce Motion outranks the canary in both directions', () => {
    for (const canary of [true, false]) {
      const decision = renderingPolicy(signals({ reduceMotion: true }), canary);
      expect(decision).toMatchObject({ mode: 'reduced-motion', nonessentialAnimation: false, automatic: true });
    }
  });
});

describe('shadow mode changes nothing on screen', () => {
  test('a decision main has not been told to act on is not applied', () => {
    const shadow = renderingPolicy(signals({ thermal: 'critical' }), false);
    expect(shadow.mode).toBe('quiet');          // main still reports what it would do …
    expect(renderModeFor(shadow)).toBe('full'); // … and the renderer still does nothing about it.
  });

  test('Reduce Motion is applied even in shadow mode, because it is not a canary', () => {
    expect(renderModeFor(renderingPolicy(signals({ reduceMotion: true }), false))).toBe('reduced-motion');
  });

  test('an unreadable decision falls back to more motion, not less', () => {
    // A renderer that silently stopped animating would look broken; a missed saving is invisible.
    expect(renderModeFor(null)).toBe('full');
    expect(renderModeFor(undefined)).toBe('full');
  });
});

describe('the attribute CSS and JS both key off', () => {
  const snapshot = (over: Partial<RuntimeSignals>): AdaptiveRuntimeSnapshot => ({
    signals: signals(over), decision: {} as AdaptiveRuntimeSnapshot['decision'],
    rendering: renderingPolicy(signals(over), true),
  });

  test('quiet is stamped, full is cleared rather than written as a default', () => {
    const root = target();
    applyRenderMode(root, 'quiet');
    expect(root.value).toBe('quiet');
    applyRenderMode(root, 'full');
    expect(root.value).toBeUndefined();
  });

  test('a later broadcast moves the document, and stopping ends the subscription', async () => {
    const root = target();
    let push: ((s: AdaptiveRuntimeSnapshot) => void) | null = null;

    const stop = startRenderMode({
      adaptiveState: async () => snapshot({}),
      onAdaptiveChanged: (handler) => { push = handler; return () => { push = null; }; },
    }, root);
    await Promise.resolve();
    expect(root.value).toBeUndefined();

    const send = push!;
    send(snapshot({ thermal: 'critical' }));
    expect(root.value).toBe('quiet');

    send(snapshot({}));
    expect(root.value).toBeUndefined();

    stop();
    send(snapshot({ thermal: 'critical' }));
    expect(root.value).toBeUndefined(); // a stopped subscription cannot still repaint the document
  });

  test('a bridge that fails leaves the document where it was, never forced darker', async () => {
    const root = target('quiet');
    startRenderMode({
      adaptiveState: async () => { throw new Error('no bridge'); },
      onAdaptiveChanged: () => () => {},
    }, root);
    await Promise.resolve();
    await Promise.resolve();
    expect(root.value).toBe('quiet');
  });
});
