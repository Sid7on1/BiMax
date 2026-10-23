import { MorphController, type MorphFrame } from '../morph/controller';
import type { MorphGeometry, DestinationKind } from '../morph/geometry';

// Speed is pinned by `check:morph`'s golden baseline (the owner's chosen feel). What this pins is the one property every
// exit must keep whatever its speed: it folds INTO its seed and never shrinks past it. An exit that dips below its seed
// and grows back is a bounce on the way out.
const rect = (x: number, y: number, width: number, height: number): MorphGeometry => ({ x, y, width, height, radius: 14 });
const cases: [string, DestinationKind, MorphGeometry, MorphGeometry][] = [
  ['menu', 'popover', rect(620, 743, 91, 28), rect(431, 356, 280, 379)],
  ['panel', 'floatingPanel', rect(438, 682, 268, 47), rect(210, 40, 760, 720)],
];

test.each(cases)('%s exit lands on its seed without shrinking past it', (_name, kind, seed, destination) => {
  const frames: MorphFrame[] = [];
  const controller = new MorphController({ kind: () => kind, resolve: () => ({ seed, destination }) });
  const off = controller.subscribe((frame) => frames.push(frame));
  try {
    controller.open();
    for (let i = 0; i < 240 && controller.state !== 'open'; i++) controller.advance(1 / 60);
    expect(controller.state).toBe('open');
    frames.length = 0;
    controller.close();
    for (let i = 0; i < 240 && controller.state !== 'closed'; i++) controller.advance(1 / 60);
    expect(controller.state).toBe('closed');
    for (const frame of frames) {
      expect(frame.geometry.width).toBeGreaterThanOrEqual(seed.width - 1.5);
      expect(frame.geometry.height).toBeGreaterThanOrEqual(seed.height - 1.5);
    }
  } finally {
    off();
    controller.dispose();
  }
});
