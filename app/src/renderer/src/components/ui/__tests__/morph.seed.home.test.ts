import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { clearIntent, installIntentTracking } from '../intent';
import { homeOf, intentSeed } from '../morph/use-seed';

/**
 * A surface opened from a menu row folds home into the menu's button (owner, 2026-10-01).
 *
 * The model window opens from the Model menu's "Change model…" row, and the menu closes at once. Its close used to fold
 * into where that row had been: a glass box left in empty space above the text bar, which then vanished — the owner saw
 * it "flickers when closing and has not actual closing seed". The menu's panel now names its button
 * (`data-seed-trigger`), the seed reads that while the row still exists, and folds into the button once the row is gone.
 *
 * The node lane has no DOM, so this is the smallest stand-in that `intent.ts` and `use-seed.ts` read.
 */
type Box = { left: number; top: number; width: number; height: number };

class FakeElement {
  id = '';
  attrs: Record<string, string> = {};
  parent: FakeElement | null = null;
  isConnected = true;
  constructor(public box: Box, private activatable = true) {}
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  getBoundingClientRect() {
    const { left, top, width, height } = this.box;
    return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height };
  }
  matches(selector: string): boolean {
    return selector === '[data-seed-trigger]' ? 'data-seed-trigger' in this.attrs : this.activatable;
  }
  closest(selector: string): FakeElement | null {
    for (let el: FakeElement | null = this; el; el = el.parent) if (el.matches(selector)) return el;
    return null;
  }
}

const saved: Record<string, unknown> = {};
const byId: Record<string, FakeElement> = {};
let press: (event: { target: unknown }) => void = () => {};

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['Element', 'HTMLElement', 'document', 'getComputedStyle']) saved[key] = g[key];
  g.Element = FakeElement;
  g.HTMLElement = FakeElement;
  g.document = { getElementById: (id: string) => byId[id] ?? null };
  g.getComputedStyle = () => ({ borderTopLeftRadius: '12px' });
  installIntentTracking({
    addEventListener: (type: string, handler: (event: { target: unknown }) => void) => { if (type === 'pointerdown') press = handler; },
    removeEventListener: () => {},
  } as unknown as Document);
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete g[key];
    else g[key] = value;
  }
  clearIntent();
});

/** The Model button in the text bar, its open menu, and the "Change model…" row in it. */
function modelMenu() {
  const button = new FakeElement({ left: 490, top: 610, width: 91, height: 28 });
  button.id = 'seed-trigger-1';
  byId[button.id] = button;
  const panel = new FakeElement({ left: 300, top: 300, width: 280, height: 320 }, false);
  panel.attrs['data-seed-trigger'] = button.id;
  const row = new FakeElement({ left: 308, top: 550, width: 268, height: 47 });
  row.parent = panel;
  return { button, row };
}

describe('a surface opened from a menu row', () => {
  test('grows from the row, and folds home into the menu\'s button once the row is gone', () => {
    const { button, row } = modelMenu();
    expect(homeOf(row as unknown as Element)).toBe(button);

    press({ target: row });
    const seed = intentSeed();
    expect(seed.measure()).toMatchObject({ x: 308, y: 550, width: 268, height: 47 });

    row.isConnected = false; // the menu closed
    expect(seed.measure()).toMatchObject({ x: 490, y: 610, width: 91, height: 28 });
  });

  test('a control in no menu has no home, and keeps folding into where it was', () => {
    const lone = new FakeElement({ left: 40, top: 60, width: 120, height: 30 });
    expect(homeOf(lone as unknown as Element)).toBeNull();

    press({ target: lone });
    const seed = intentSeed();
    lone.isConnected = false;
    expect(seed.measure()).toMatchObject({ x: 40, y: 60, width: 120, height: 30 });
  });
});
