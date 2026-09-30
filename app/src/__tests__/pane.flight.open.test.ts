import fs from 'fs';
import path from 'path';
import { followFlight, layoutWidth } from '../renderer/src/pane.flight';

/**
 * UI fix list item 11: "when the right panel opens … it has a jitter".
 *
 * Measured in the built renderer (Electron, per-frame widths): opening a side pane took its full width in ONE frame —
 * the conversation went 967px → 566px and rewrapped at once — and the glass swept in over it for ~600ms. Closing had
 * followed its shell since 2026-09-13; opening now does the same from the other end. After the fix the largest
 * single-frame step of the conversation was 42px (right panel) and 23px (sidebar), against 401px and 204px.
 *
 * The panel group and its panels are faked here with just what pane.flight.ts touches: attributes, inline custom
 * properties, children, and boxes.
 */

class FakeElement {
  attributes = new Map<string, string>();
  props = new Map<string, string>();
  children: FakeElement[] = [];
  width = 0;
  style = {
    setProperty: (name: string, value: string) => { this.props.set(name, value); },
    removeProperty: (name: string) => { this.props.delete(name); },
    getPropertyValue: (name: string) => this.props.get(name) ?? '',
  };
  constructor(attrs: Record<string, string> = {}, width = 0) {
    for (const [key, value] of Object.entries(attrs)) this.attributes.set(key, value);
    this.width = width;
  }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  getBoundingClientRect(): { width: number } { return { width: this.width }; }
  querySelector(selector: string): FakeElement | null {
    const id = selector.match(/id="([a-z]+)"/)?.[1];
    return this.children.find((child) => child.attributes.get('id') === id && child.hasAttribute('data-panel')) ?? null;
  }
}

/** Sidebar | separator | task | separator | inspector, 1180px wide, as the app lays it out. */
function makeGroup(inspectorWidth: number) {
  const group = new FakeElement({}, 1180);
  const sidebar = new FakeElement({ 'data-panel': '', id: 'sidebar' }, 212);
  const inspector = new FakeElement({ 'data-panel': '', id: 'inspector' }, inspectorWidth);
  group.children = [
    sidebar, new FakeElement({ 'data-separator': '' }, 1), new FakeElement({ 'data-panel': '', id: 'task' }, 566),
    new FakeElement({ 'data-separator': '' }, 1), inspector,
  ];
  return { group, el: group as unknown as HTMLElement };
}

const registered = { getLayout: () => ({ sidebar: 18, task: 48, inspector: 34 }), setLayout: () => undefined };
const unregistered = { getLayout: (): Record<string, number> => { throw new Error('Could not find Group with id ":r0:"'); }, setLayout: () => undefined };
const frame = (state: 'opening' | 'open' | 'closing' | 'closed', width: number) => ({ state, geometry: { width } });

test('the width a pane is heading for comes from the group’s layout, not from its placeholder box', () => {
  const { group, el } = makeGroup(11.7); // the library draws a just-mounted pane with `flex: 1` until it lays it out
  expect(layoutWidth(el, registered, 'inspector')).toBeCloseTo(0.34 * 1178, 5);
  expect(layoutWidth(el, registered, 'sidebar')).toBeCloseTo(0.18 * 1178, 5);
  // Before the group has registered, the handle throws; that is "not known yet", never a crash.
  expect(layoutWidth(el, unregistered, 'inspector')).toBeNull();
  expect(group.width).toBe(1180);
});

test('opening: the pane is zero wide from the very first frame, so its full width is never painted', () => {
  const { group, el } = makeGroup(0);
  followFlight(el, unregistered, 'inspector', frame('opening', 2), false);
  expect(group.hasAttribute('data-flight-inspector')).toBe(true);
  expect(group.props.get('--flight-inspector')).toBe('0px');
  // No target yet, so nothing claims one.
  expect(group.props.has('--flight-start-inspector')).toBe(false);
});

test('opening: the pane follows the shell and the content is held at the width it is heading for', () => {
  const { group, el } = makeGroup(11.7);
  followFlight(el, unregistered, 'inspector', frame('opening', 2), false);
  followFlight(el, registered, 'inspector', frame('opening', 150), false);
  expect(parseFloat(group.props.get('--flight-start-inspector')!)).toBeCloseTo(400.52, 1);
  expect(group.props.get('--flight-inspector')).toBe('150px');
  // The other bar is held at the width the layout gives it, so it does not drift while this one grows.
  expect(parseFloat(group.props.get('--hold-sidebar')!)).toBeCloseTo(212.04, 1);
  // A shell that overshoots its destination never pulls the pane wider than the layout will leave it.
  followFlight(el, registered, 'inspector', frame('opening', 404), false);
  expect(parseFloat(group.props.get('--flight-inspector')!)).toBeCloseTo(400.52, 1);
});

test('at rest the layout is handed back, and Reduce Motion never takes it', () => {
  const { group, el } = makeGroup(400);
  followFlight(el, registered, 'inspector', frame('opening', 200), false);
  followFlight(el, registered, 'inspector', frame('open', 400.5), false);
  expect(group.hasAttribute('data-flight-inspector')).toBe(false);
  expect(group.props.size).toBe(0);

  const reduced = makeGroup(400);
  followFlight(reduced.el, registered, 'inspector', frame('opening', 200), true);
  expect(reduced.group.hasAttribute('data-flight-inspector')).toBe(false);
});

test('closing is unchanged: it follows the shell from the width on screen, and the closed frame leaves it held', () => {
  const { group, el } = makeGroup(400);
  followFlight(el, registered, 'inspector', frame('closing', 300), false);
  expect(group.props.get('--flight-start-inspector')).toBe('400px');
  expect(group.props.get('--flight-inspector')).toBe('300px');
  // `settleCollapse` hands the layout back after the unmount; the `closed` frame comes before it.
  followFlight(el, registered, 'inspector', frame('closed', 0), false);
  expect(group.hasAttribute('data-flight-inspector')).toBe(true);
});

test('both bars use it, with the group’s layout, and the driver re-measures before the first paint', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', rel), 'utf8');
  const app = read('App.tsx');
  for (const pane of ['sidebar', 'inspector']) {
    expect(app).toContain(`onFrame={(frame) => followFlight(groupEl.current, groupRef.current, '${pane}', frame, prefersReducedMotion())}`);
  }
  const driver = read('components/ui/morph/use-morph.ts');
  const observer = driver.slice(driver.indexOf('Both ends of the morph move when the world does'));
  expect(observer).toMatch(/^[^]*?useLayoutEffect\(\(\) => \{\s*if \(!active\) return;\s*const onResize/);
});
