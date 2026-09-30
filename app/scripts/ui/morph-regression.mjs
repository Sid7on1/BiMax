// The morph regression check (UI fix list item 22): `npm run check:morph`.
//
// The morph system had its physics under unit test (morph.controller/region/spring/geometry tests) and nothing over the
// path from a click to pixels: which surface a control opens, what the DOM box does on each frame, whether a CSS rule
// or a React change starts fighting the driver, whether a side pane still moves the conversation with it. Those are
// the regressions that "silently break the feel" — item 11's 401px one-frame jump lived in exactly that gap.
//
// So this drives the SHIPPED renderer (out/renderer, the real App with the journeys' bridge stand-in) in an offscreen
// Electron window, and plays every morph path the app has: a chooser menu, a menu that appears in place, the seeded
// model window, both side panes, interruptions, and Reduce Motion. The page's animation clock is taken over, so each
// real frame advances the morph by exactly 1/60 s: the run is deterministic, and layout, ResizeObservers and paint
// still happen between frames as they do in the app. On every frame it reads what the DOM actually holds.
//
// Two kinds of verdict:
//   - Invariants — always true or the feel is broken: a flight starts on its trigger, nothing jumps 120px in a frame,
//     the driver alone moves the box, content is never clickable before it is visible, a closing menu folds into its
//     trigger, the conversation moves with a pane instead of snapping, and nothing is left behind at rest.
//   - The baseline (morph.golden.json) — how each flight feels: frames to rest, the shape of its progress curve, the
//     content's reveal, the overshoot. A change here may be intended; then `-- --update` rewrites the baseline, and
//     the change says why.
//
// Exit status: 0 held, 1 regression, 2 invalid run (the renderer threw, a flight ran long enough in real time for the
// controller's 1.4 s watchdog to interfere, or there is no baseline) — an invalid run is not a pass and not a failure.
//
// Not covered: glass, blur and colour (numbers, not pixels); the native window; timing on a real GPU. This is the
// software-rendered harness — it grades geometry and state, frame by frame.

import { app, BrowserWindow } from 'electron';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_DIR, installBridge, serveRenderer } from './renderer.mjs';
import { baseFixture, uiSnapshot, PROJECT } from './fixtures.mjs';

const GOLDEN = path.join(APP_DIR, 'scripts/ui/morph.golden.json');
const UPDATE = process.argv.includes('--update');
const SIZE = { width: 1180, height: 800 };
/**
 * Every flight is played twice: at 100%, and at 120% — the owner's own window runs at 120% (UI fix list item 10), so
 * that is the geometry the owner actually watches. A fresh page for each, so no state carries from one to the other.
 */
const ZOOMS = [{ factor: 1, prefix: '' }, { factor: 1.2, prefix: 'at120%.' }];

/** A frame may move an edge this far and still read as one object moving (the controller's own no-teleport bound). */
const MAX_STEP = 120;
/**
 * How far the conversation may move in one frame while a pane flies. Measured after item 11: 42px (inspector) and
 * 23px (sidebar); before it, 401px and 204px. The bound sits well clear of both.
 */
const MAX_COLUMN_STEP = 80;
/** A flight that takes this long in real time is at the mercy of the controller's 1.4 s watchdog: not gradeable. */
const REAL_TIME_LIMIT_MS = 1200;

/**
 * The owner's motion ladder (UI fix list item 32): popovers 180–220ms, panels 240–300ms, exits no slower than their
 * entrance (item 36). Measured as `settleMs` — the frame after which nothing moves more than 1px — with one frame of
 * slack for the 60Hz grid. A closing menu's and the model window's exits sit at 84% and 100% of their entrances: the
 * 120px-per-frame rule, which a spring fast enough for 75% would break on a long flight home, wins.
 */
const LADDER = {
  'menu.open': 220, 'inplace-menu.open': 220, 'menu.close': 220, 'inplace-menu.close': 220,
  'dialog.open': 300, 'dialog.close': 300,
  'inspector.open': 300, 'inspector.close': 300, 'sidebar.open': 300, 'sidebar.close': 300,
};
const EXITS = [['menu.close', 'menu.open'], ['dialog.close', 'dialog.open'], ['inspector.close', 'inspector.open'], ['sidebar.close', 'sidebar.open']];
const FRAME_MS = 1000 / 60;

/** How far a flight's feel may drift from the baseline before it is a regression. */
const TOLERANCE = { frames: 2, curve: 0.05, reveal: 0.1, overshootPct: 1 };

/* -------------------------------------------------------------------------------------------- page side */

/**
 * Installed before the renderer's own scripts. Self-contained: it is serialized into the preload.
 *
 * `requestAnimationFrame` is taken over while armed. Each real frame then (1) reads what the previous frame put on
 * screen and (2) runs the callbacks the page queued, with a clock advanced by exactly 1/60 s — so the morph steps at
 * 60 Hz whatever this machine manages, and ResizeObservers, layout and paint still run between steps.
 */
function installMorphProbe() {
  const realRAF = window.requestAnimationFrame.bind(window);
  const realCAF = window.cancelAnimationFrame.bind(window);
  const queue = new Map();
  let manual = false;
  let now = 0;
  let next = 1;
  window.requestAnimationFrame = (callback) => {
    if (!manual) return realRAF(callback);
    const id = -(next++);
    queue.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => (id < 0 ? queue.delete(id) : realCAF(id));

  const r2 = (value) => Math.round(value * 100) / 100;
  const px = (text) => {
    const value = parseFloat(text);
    return Number.isFinite(value) ? value : null;
  };
  const nameOf = (el) => el.getAttribute('aria-label')
    || (el.classList.contains('liquid-glass-panel') ? 'dialog' : el.getAttribute('aria-hidden') === 'true' ? 'shell' : 'surface');

  function sample() {
    const surfaces = {};
    for (const el of document.querySelectorAll('.morph-surface')) {
      const rect = el.getBoundingClientRect();
      const [tx, ty] = (el.style.translate || '').split(' ').map(px);
      const [sx, sy] = (el.style.scale || '1').split(' ').map(Number);
      const content = el.firstElementChild;
      surfaces[nameOf(el)] = {
        rect: [r2(rect.x), r2(rect.y), r2(rect.width), r2(rect.height)],
        driven: tx === null || tx === undefined
          ? null
          : [tx, ty ?? 0, px(el.style.width), px(el.style.height), px(el.style.borderRadius)],
        scale: [sx || 1, sy || sx || 1],
        opacity: el.style.opacity === '' ? null : Number(el.style.opacity),
        armed: el.style.willChange !== '',
        content: content
          ? { opacity: content.style.opacity === '' ? 1 : Number(content.style.opacity), inert: getComputedStyle(content).pointerEvents === 'none' }
          : null,
      };
    }
    const panels = {};
    let group = null;
    for (const panel of document.querySelectorAll('[data-panel]')) {
      panels[panel.id || panel.getAttribute('data-panel')] = r2(panel.getBoundingClientRect().width);
      group = group ?? panel.parentElement;
    }
    const flight = group ? [...group.attributes].map((a) => a.name).filter((name) => name.startsWith('data-flight-')) : [];
    const regions = {};
    for (const region of document.querySelectorAll('.morph-region')) {
      const id = region.closest('[data-panel]')?.id;
      if (!id) continue;
      // Between the region and its pane nothing should scroll: a box that does shows a styled (space-taking) scrollbar.
      let scrollbar = false;
      for (let el = region.parentElement; el && !el.hasAttribute('data-panel'); el = el.parentElement) {
        if (el.offsetHeight - el.clientHeight > 1 || el.offsetWidth - el.clientWidth > 1) scrollbar = true;
      }
      const box = region.getBoundingClientRect();
      regions[id] = { clip: region.style.clipPath || null, opacity: region.style.opacity === '' ? null : Number(region.style.opacity), scrollbar, height: r2(box.height), rect: [r2(box.x), r2(box.width)] };
    }
    return { surfaces, panels, flight, regions, viewport: [window.innerWidth, window.innerHeight] };
  }

  /** The boxes the driver has just written — read after a step, before anything can unmount what it wrote. */
  function driven() {
    const out = {};
    for (const el of document.querySelectorAll('.morph-surface')) {
      const [tx, ty] = (el.style.translate || '').split(' ').map(px);
      if (tx !== null && tx !== undefined) out[nameOf(el)] = [tx, ty ?? 0, px(el.style.width), px(el.style.height)];
    }
    return out;
  }

  function find(target) {
    if (target.text) {
      const scope = target.within ? document.querySelector(target.within) : document;
      return [...(scope?.querySelectorAll(target.selector) ?? [])].find((el) => el.textContent.trim().startsWith(target.text)) ?? null;
    }
    return document.querySelector(target.selector);
  }

  /** A press as the app sees one: pointerdown (which the intent tracker and outside-press dismissal read), then click. */
  function press(target) {
    const el = find(target);
    if (!el) throw new Error(`nothing to press: ${JSON.stringify(target)}`);
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerId: 1, button: 0, isPrimary: true }));
    el.click();
  }

  function act(action) {
    if (action.press) return press(action.press);
    if (action.key) {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true, cancelable: true }));
      return undefined;
    }
    // The menu bar's path: the page runs the command its key runs (main/app.menu.ts).
    if (action.command) return window.__bimaxHarness.callbacks.menu.forEach((cb) => cb(action.command));
    throw new Error(`unknown action ${JSON.stringify(action)}`);
  }

  function frame() {
    return new Promise((resolve) => realRAF(() => {
      const snap = sample();
      const due = [...queue.values()];
      queue.clear();
      now += 1000 / 60;
      for (const callback of due) {
        try { callback(now); } catch (error) { snap.error = String(error?.stack ?? error); }
      }
      snap.ticked = due.length > 0;
      // A close's last step and its unmount fall in one frame, so its final box is painted once and never read at
      // the start of a frame. This is that box.
      snap.post = driven();
      resolve(snap);
    }));
  }

  window.__morph = {
    arm() { manual = true; now = performance.now(); },
    release() {
      manual = false;
      const due = [...queue.values()];
      queue.clear();
      due.forEach((callback) => realRAF(callback));
    },
    rect(target) {
      const el = find(target);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [r2(r.x), r2(r.y), r2(r.width), r2(r.height)];
    },
    exists: (target) => !!find(target),
    /**
     * Take the clock and run it until nothing is flying. A morph started before `arm` holds a REAL frame request, and
     * that one frame would tick every live morph with the wall clock — measured: the sidebar's opening at boot, still
     * settling, advanced the first menu flight one step before its first frame was read.
     */
    async drain(quiet = 3, max = 600) {
      this.arm();
      let still = 0;
      for (let i = 0; i < max && still < quiet; i++) still = (await frame()).ticked ? 0 : still + 1;
      return still >= quiet;
    },
    /**
     * Do `action`, then step until the morph clock has been idle for `quiet` frames. `at` holds interruptions keyed
     * by frame index, applied before that frame so they land on an exact point of the flight.
     */
    async fly({ action, at = {}, max = 240, quiet = 3 }) {
      const before = sample();
      const started = performance.now();
      if (action) act(action);
      const frames = [];
      let still = 0;
      for (let i = 0; i < max && still < quiet; i++) {
        if (at[i]) act(at[i]);
        const snap = await frame();
        frames.push(snap);
        still = snap.ticked || at[i + 1] ? 0 : still + 1;
      }
      return { before, frames, ms: performance.now() - started };
    },
  };
}

/* ------------------------------------------------------------------------------------------- scenarios */

const MODEL = { selector: 'button[aria-haspopup="menu"][aria-label="Model"]' };
const CHANGE_MODEL = { selector: '[data-menuitem]', text: 'Change model', within: '.morph-surface[aria-label="Model"]' };
const TREE_FILE = { selector: '[role="button"]', text: 'package.json', within: '[data-panel][id="inspector"]' };
const FILE_MENU = { selector: 'button[aria-haspopup="menu"][aria-label="More actions for this file"]' };
const ESC = { key: 'Escape' };

/**
 * Each flight names what to grade: a `surface` (by the name the probe gives it) and the trigger it must start from or
 * fold into, or a `pane`. `seed` is measured just before the flight, as the controller would measure it.
 */
const SCENARIOS = [
  {
    name: 'chooser menu (Model)',
    steps: [
      { flight: 'menu.open', action: { press: MODEL }, surface: 'Model', seed: MODEL, seeded: true },
      { flight: 'menu.close', action: ESC, surface: 'Model', seed: MODEL, seeded: true, closing: true },
    ],
  },
  {
    name: 'menu interrupted',
    steps: [
      // Closed four frames into its opening: it must curve back into the trigger, not jump there or finish opening.
      { flight: 'menu.close-mid-open', action: { press: MODEL }, at: { 4: ESC }, surface: 'Model', seed: MODEL, seeded: true, closing: true },
      { action: { press: MODEL } },
      // Reopened three frames into its closing: it must turn round where it is, not restart from the trigger.
      { flight: 'menu.reopen-mid-close', action: ESC, at: { 3: { press: MODEL } }, surface: 'Model', seed: MODEL, seeded: true, reopened: true },
      { action: ESC },
    ],
  },
  {
    name: 'seeded model window',
    steps: [
      { action: { press: MODEL } },
      { flight: 'dialog.open', action: { press: CHANGE_MODEL }, surface: 'dialog', seed: CHANGE_MODEL, seeded: true },
      // The row it grew from is gone (its menu closed), so it folds into where that row was: the open's seed.
      { flight: 'dialog.close', action: ESC, surface: 'dialog', seed: 'previous', seeded: true, closing: true },
    ],
  },
  {
    name: 'menu that appears in place (file actions)',
    steps: [
      { action: { press: TREE_FILE } },
      { flight: 'inplace-menu.open', action: { press: FILE_MENU }, surface: 'More actions for this file', seed: FILE_MENU, seeded: false },
      { flight: 'inplace-menu.close', action: ESC, surface: 'More actions for this file', seeded: false, closing: true },
    ],
  },
  {
    name: 'inspector pane',
    steps: [
      { flight: 'inspector.close', action: { command: 'toggle-panel' }, pane: 'inspector', closing: true },
      { flight: 'inspector.open', action: { command: 'toggle-panel' }, pane: 'inspector' },
    ],
  },
  {
    name: 'sidebar pane',
    steps: [
      { flight: 'sidebar.close', action: { command: 'toggle-sidebar' }, pane: 'sidebar', closing: true },
      { flight: 'sidebar.open', action: { command: 'toggle-sidebar' }, pane: 'sidebar' },
    ],
  },
  {
    name: 'Reduce Motion',
    reduceMotion: true,
    steps: [
      { flight: 'reduced.menu.open', action: { press: MODEL }, surface: 'Model', seed: MODEL, seeded: false, reduced: true },
      { flight: 'reduced.menu.close', action: ESC, surface: 'Model', seeded: false, reduced: true, closing: true },
      { flight: 'reduced.inspector.close', action: { command: 'toggle-panel' }, pane: 'inspector', closing: true, reduced: true },
      { flight: 'reduced.inspector.open', action: { command: 'toggle-panel' }, pane: 'inspector', reduced: true },
    ],
  },
];

/* ------------------------------------------------------------------------------------------- analysis */

const round = (value, places = 3) => Math.round(value * 10 ** places) / 10 ** places;

/** The box the inline styles say the surface should occupy: `translate` + size, scaled about its centre by `scale`. */
function expectedRect(surface) {
  const [x, y, w, h] = surface.driven;
  const [sx, sy] = surface.scale;
  return [x + (w * (1 - sx)) / 2, y + (h * (1 - sy)) / 2, w * sx, h * sy];
}

const maxDelta = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** When a flight visibly stops: the first frame from which every later box is within 1px of `target`, in ms. */
function settleMs(boxes, target) {
  let i = boxes.length;
  while (i > 0 && maxDelta(boxes[i - 1], target) <= 1) i -= 1;
  return Math.round((Math.min(i, boxes.length - 1) * 1000) / 60);
}

/** Frames up to and including the last one the clock ticked on, plus the one that shows its result. */
function activeFrames(frames) {
  let last = -1;
  frames.forEach((f, i) => { if (f.ticked) last = i; });
  return frames.slice(0, Math.min(frames.length, last + 2));
}

/** Progress along the channel that travels furthest, 0 at `from` and 1 at `to`. */
function progressCurve(boxes, from, to) {
  const spans = to.map((v, i) => v - from[i]);
  let channel = 0;
  spans.forEach((span, i) => { if (Math.abs(span) > Math.abs(spans[channel])) channel = i; });
  const span = spans[channel];
  if (Math.abs(span) < 1) {
    // Starts where it ends — an interrupted flight that went out and came back. Its shape is the excursion: how far
    // from its end it is on each frame, as a share of the furthest it got.
    const away = boxes.map((box) => maxDelta(box, to));
    const furthest = Math.max(...away);
    return { curve: away.map((d) => (furthest < 1 ? 0 : round(d / furthest))), overshootPx: 0, overshootPct: 0, span: 0 };
  }
  const curve = boxes.map((box) => round((box[channel] - from[channel]) / span));
  const peak = Math.max(...curve);
  return { curve, overshootPx: round(Math.max(0, peak - 1) * Math.abs(span), 1), overshootPct: round(Math.max(0, peak - 1) * 100, 2), span };
}

function analyseSurface(step, run, seedRect) {
  const faults = [];
  const frames = activeFrames(run.frames);
  const present = frames.filter((f) => f.surfaces[step.surface]);
  if (!present.length) return { faults: [`the ${step.surface} surface never appeared`], fingerprint: null };

  const boxes = present.map((f) => f.surfaces[step.surface].driven).filter(Boolean).map((d) => d.slice(0, 4));
  const first = present[0].surfaces[step.surface];
  const final = run.frames[run.frames.length - 1].surfaces[step.surface];

  // Nothing but the driver moves the box: a CSS transition, a class clamping width, a stray transform all show here.
  for (const [i, f] of present.entries()) {
    const s = f.surfaces[step.surface];
    if (!s.driven) continue;
    const off = maxDelta(s.rect, expectedRect(s));
    if (off > 1) { faults.push(`frame ${i}: the box on screen is ${round(off, 1)}px off the one the driver set — something else is moving it`); break; }
  }
  // One object moving, not two: no edge jumps more than MAX_STEP between frames.
  let maxStep = 0;
  for (let i = 1; i < present.length; i++) maxStep = Math.max(maxStep, maxDelta(present[i].surfaces[step.surface].rect, present[i - 1].surfaces[step.surface].rect));
  if (maxStep > MAX_STEP) faults.push(`an edge moved ${round(maxStep, 1)}px in one frame (bound ${MAX_STEP}px)`);
  // Content that has not arrived is not clickable.
  for (const [i, f] of present.entries()) {
    const content = f.surfaces[step.surface].content;
    if (content && content.opacity < 0.6 && !content.inert) { faults.push(`frame ${i}: content at ${content.opacity} opacity takes clicks`); break; }
  }

  if (step.reopened) {
    // Turned round where it was: after the reopen it never goes back to the trigger, and it ends open at rest.
    const reopenAt = Number(Object.keys(step.at ?? {})[0] ?? 0);
    const after = present.slice(reopenAt + 1).map((f) => f.surfaces[step.surface].driven?.slice(0, 4)).filter(Boolean);
    if (seedRect && after.some((box) => maxDelta(box, seedRect) < 2)) faults.push('reopened mid-close, it restarted from its trigger instead of turning round');
    if (!final) faults.push('reopened mid-close, it is gone at rest');
    else if (final.armed) faults.push('reopened mid-close, it never came to rest');
  } else if (!step.closing) {
    // Where it starts. A seeded flight starts ON its trigger; one that appears in place starts inside where it lands.
    const start = first.driven.slice(0, 4);
    const end = final?.driven?.slice(0, 4) ?? final?.rect;
    if (step.seeded) {
      if (!seedRect) faults.push('the trigger could not be measured');
      else if (maxDelta(start, seedRect) > 1) faults.push(`it starts ${round(maxDelta(start, seedRect), 1)}px from its trigger (${start.map((v) => round(v, 0))} vs ${seedRect.map((v) => round(v, 0))})`);
    } else if (end && (start[0] < end[0] - 24 || start[1] < end[1] - 24 || start[0] + start[2] > end[0] + end[2] + 24 || start[1] + start[3] > end[1] + end[3] + 24)) {
      faults.push(`it travels: it starts at ${start.map((v) => round(v, 0))}, outside where it lands (${end.map((v) => round(v, 0))})`);
    }
    if (step.reduced) {
      for (const box of boxes) {
        if (end && maxDelta([box[0] + box[2] / 2, box[1] + box[3] / 2], [end[0] + end[2] / 2, end[1] + end[3] / 2]) > 24) { faults.push('under Reduce Motion it crosses the window'); break; }
      }
    }
    // At rest: present, released, and on screen where the driver left it.
    if (!final) faults.push('it is gone at rest');
    else {
      if (final.armed) faults.push('at rest it still holds its will-change layer');
      if (final.driven && maxDelta(final.rect, final.driven.slice(0, 4)) > 0.5) faults.push('at rest the box on screen is not the box it arrived at');
      if (final.content && final.content.inert) faults.push('at rest its content does not take clicks');
    }
  } else {
    // Closing: it leaves, and a seeded one folds into its trigger as it is NOW.
    if (final) faults.push('it is still mounted after its close finished');
    const landed = frames.map((f) => f.post?.[step.surface]).filter(Boolean).pop();
    if (step.seeded && seedRect && landed && maxDelta(landed, seedRect) > 1) faults.push(`it folds ${round(maxDelta(landed, seedRect), 1)}px away from its trigger (${landed.map((v) => round(v, 0))} vs ${seedRect.map((v) => round(v, 0))})`);
    if (!step.seeded) {
      const opacities = present.map((f) => f.surfaces[step.surface].opacity ?? 1);
      if (opacities[opacities.length - 1] > 0.35) faults.push(`it pops out at ${opacities[opacities.length - 1]} opacity instead of fading`);
    }
  }

  const from = boxes[0];
  const to = step.closing && step.seeded && seedRect ? seedRect : (final?.driven?.slice(0, 4) ?? boxes[boxes.length - 1]);
  const { curve, overshootPx, overshootPct } = progressCurve(boxes, from, to);
  return {
    faults,
    fingerprint: {
      frames: present.length,
      curve,
      reveal: present.map((f) => round(f.surfaces[step.surface].content?.opacity ?? 1, 2)),
      overshootPct,
      overshootPx,
      maxStepPx: round(maxStep, 1),
      box: to.map((v) => round(v, 0)),
      settleMs: settleMs(boxes, to),
    },
  };
}

function analysePane(step, run) {
  const faults = [];
  const frames = [run.before, ...activeFrames(run.frames)];
  const column = frames.map((f) => f.panels.task).filter((v) => v !== undefined);
  let maxStep = 0;
  for (let i = 1; i < column.length; i++) maxStep = Math.max(maxStep, Math.abs(column[i] - column[i - 1]));
  // Under Reduce Motion the pane is simply there or gone — one step is the design, not a jump to catch.
  if (!step.reduced && maxStep > MAX_COLUMN_STEP) faults.push(`the conversation moved ${round(maxStep, 1)}px in one frame (bound ${MAX_COLUMN_STEP}px) — the pane is not carrying it`);

  // Under Reduce Motion the shell starts inset on its destination (the controller's launch without the journey), so it
  // neither hugs the edge nor keeps its height; the no-travel rule for that is the controller's own test.
  const shells = step.reduced ? [] : frames.map((f) => f.surfaces.shell).filter(Boolean);
  // A bar is an edge moving, so its glass never takes the momentum stretch a flying menu does.
  const stretched = shells.find((sh) => sh.scale[0] !== 1 || sh.scale[1] !== 1);
  if (stretched) faults.push(`the shell's glass stretched (${stretched.scale.join(' × ')}) — a pane is an edge moving, not an object with momentum`);
  // A bar grows from its own window edge: that edge stays put on every frame while the other one travels.
  const edges = shells.map((s) => s.driven).filter(Boolean).map(([x, , w]) => (step.pane === 'inspector' ? x + w : x)).map((v, i, all) => Math.abs(v - all[all.length - 1]));
  // 3px, not 0: measured 2px on the inspector's opening, where the pane's target width is filled in a frame late and
  // lands ~1px off the panel group's own rounding. A broken edge origin moves it by the pane's whole width.
  if (edges.some((off) => off > 3)) faults.push(`the shell's window edge moved ${round(Math.max(...edges), 1)}px — it should grow from that edge`);
  if (shells.length > 1) {
    const ys = shells.filter((s) => s.driven).map((s) => [s.driven[1], s.driven[3]]);
    const off = Math.max(...ys.map((v) => Math.max(Math.abs(v[0] - ys[0][0]), Math.abs(v[1] - ys[0][1]))));
    if (off > 0.5) faults.push(`the shell moved ${round(off, 1)}px vertically — a pane is a width transition`);
  }

  const barred = frames.findIndex((f) => f.regions[step.pane]?.scrollbar);
  if (barred >= 0) faults.push(`frame ${barred - 1}: a scrollbar showed inside the flying pane`);

  const end = run.frames[run.frames.length - 1];
  if (end.flight.length) faults.push(`at rest the layout override is still on (${end.flight.join(', ')})`);
  if (end.surfaces.shell) faults.push('at rest the flying shell is still mounted');
  const region = end.regions[step.pane];
  if (region && (region.clip || region.opacity !== null)) faults.push('at rest the pane is still clipped or faded');
  if (step.closing && end.panels[step.pane] !== undefined) faults.push('the pane is still in the layout after closing');
  if (!step.closing && !(end.panels[step.pane] > 0)) faults.push('the pane is not in the layout after opening');

  const from = column[0];
  const to = column[column.length - 1];
  const span = to - from;
  const curve = Math.abs(span) < 1 ? column.map(() => 1) : column.map((v) => round((v - from) / span));
  const peak = Math.max(...curve);
  return {
    faults,
    fingerprint: {
      frames: column.length,
      curve,
      reveal: frames.map((f) => round(f.regions[step.pane]?.opacity ?? 1, 2)),
      overshootPct: round(Math.max(0, peak - 1) * 100, 2),
      overshootPx: round(Math.max(0, peak - 1) * Math.abs(span), 1),
      maxStepPx: round(maxStep, 1),
      box: [round(from, 0), round(to, 0)],
      settleMs: settleMs(column.map((w) => [w]), [to]),
    },
  };
}

/** MORPH_DUMP=<flight>: the raw frames of one flight, for looking at a failure. */
function dump(step, run, seedRect) {
  console.log(`--- ${step.flight}: seed ${JSON.stringify(seedRect)}, ${run.frames.length} frames, ${Math.round(run.ms)}ms`);
  for (const [i, f] of [run.before, ...run.frames].entries()) {
    const s = step.surface ? f.surfaces[step.surface] : f.surfaces.shell;
    const reg = step.pane ? f.regions[step.pane] : null;
    console.log(`${String(i - 1).padStart(3)} ${f.ticked ? 't' : ' '} panels ${JSON.stringify(f.panels)} ${f.flight.join(',')} ${reg ? `region ${JSON.stringify(reg.rect)} ` : ''}`
      + (s ? `driven ${JSON.stringify(s.driven)} rect ${JSON.stringify(s.rect)} op ${s.opacity} content ${JSON.stringify(s.content)} armed ${s.armed}` : '—'));
  }
}

/** Where a flight's feel moved from its baseline, in words. Empty when it is within tolerance. */
function drift(name, golden, now) {
  const out = [];
  if (Math.abs(golden.frames - now.frames) > TOLERANCE.frames) out.push(`${now.frames} frames to rest, baseline ${golden.frames}`);
  const curveOff = seriesOff(golden.curve, now.curve, 1);
  if (curveOff.by > TOLERANCE.curve) out.push(`its progress is ${curveOff.by} off the baseline at frame ${curveOff.at} (${curveOff.was} → ${curveOff.is})`);
  const revealOff = seriesOff(golden.reveal, now.reveal, golden.reveal[golden.reveal.length - 1] ?? 1);
  if (revealOff.by > TOLERANCE.reveal) out.push(`its content reveal is ${revealOff.by} off at frame ${revealOff.at} (${revealOff.was} → ${revealOff.is})`);
  if (Math.abs(golden.overshootPct - now.overshootPct) > TOLERANCE.overshootPct) out.push(`overshoot ${now.overshootPct}%, baseline ${golden.overshootPct}%`);
  return out.map((line) => `${name}: ${line}`);
}

/** Largest pointwise gap between two series, the shorter one held at its resting value. */
function seriesOff(a, b, rest) {
  let worst = { by: 0, at: 0, was: 0, is: 0 };
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const was = a[i] ?? a[a.length - 1] ?? rest;
    const is = b[i] ?? b[b.length - 1] ?? rest;
    const by = round(Math.abs(was - is));
    if (by > worst.by) worst = { by, at: i, was, is };
  }
  return worst;
}

/** The baseline, arrays of numbers kept on one line so a diff shows which flight moved. */
function serialize(value) {
  return JSON.stringify(value, null, 2).replace(/\[\s*(-?[\d.]+(?:,\s*-?[\d.]+)*)\s*\]/g, (_, list) => `[${list.split(/,\s*/).join(', ')}]`) + '\n';
}

/* ------------------------------------------------------------------------------------------- runner */

async function main() {
  const { server, base } = await serveRenderer();
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'bimax-morph-'));
  const preload = path.join(scratch, 'preload.cjs');
  // A world with motion ON: the stand-in's default adaptive state is Reduce Motion, which is right for the journeys
  // and would grade nothing here.
  const fixture = baseFixture({
    adaptive: {
      signals: { observedAt: Date.now(), architecture: 'arm64', cpuCount: 8, availableMemoryMb: 12_288, thermal: 'nominal', memoryPressure: 'normal', powerSource: 'ac', lowPowerMode: false, network: 'unknown', activeInteraction: false, reduceMotion: false, simulatorReservationMb: 0, localModelReservationMb: 0 },
      rendering: { mode: 'full', preferredFps: 60, nonessentialAnimation: true, automatic: true, reasons: ['Fixture: a machine with motion on.'] },
    },
  });
  writeFileSync(preload, `(${installBridge})(${JSON.stringify(fixture)});\n(${installMorphProbe})();\n`);

  const win = new BrowserWindow({
    ...SIZE,
    show: false,
    webPreferences: { offscreen: true, preload, contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(60);
  const pageErrors = [];
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' && !String(event.message).includes('favicon')) pageErrors.push(event.message);
  });
  win.webContents.on('render-process-gone', (_e, details) => pageErrors.push(`renderer gone: ${details.reason}`));

  const js = (fn, ...args) => win.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const results = [];
  const invalid = [];
  let lastSeed = null;

  try {
   for (const zoom of ZOOMS) {
    lastSeed = null;
    await win.loadURL(`${base}/`);
    win.webContents.setZoomFactor(zoom.factor);
    // The shell at a live project with the engine ready, as the journeys boot it.
    await js((project, snapshot) => {
      const H = window.__bimaxHarness;
      H.callbacks.project.forEach((cb) => cb(project));
      H.callbacks.msg.forEach((cb) => cb({ t: 'ready', protocol: 3 }));
      H.callbacks.state.forEach((cb) => cb('ready', ''));
      H.callbacks.msg.forEach((cb) => cb({ t: 'event', name: 'ui_snapshot', args: [snapshot] }));
    }, PROJECT, uiSnapshot());
    for (let i = 0; i < 60 && !(await js((t) => window.__morph.exists(t), MODEL)); i++) await wait(100);
    if (!(await js((t) => window.__morph.exists(t), MODEL))) throw new Error('the composer never rendered its Model control');
    await wait(400);

    for (const scenario of SCENARIOS) {
      if (scenario.reduceMotion) {
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      }
      if (!(await js(() => window.__morph.drain()))) throw new Error(`${scenario.name}: something was still animating after 10 s`);
      for (const step of scenario.steps) {
        const measureSeed = () => (step.seed === 'previous' ? lastSeed : step.seed ? js((t) => window.__morph.rect(t), step.seed) : null);
        // An opening starts from the trigger as it is before the press; a close folds into the trigger as it is once
        // the menu has let go of it (a pill drawn open and drawn closed need not be the same box).
        let seedRect = step.closing ? null : await measureSeed();
        const run = await js((opts) => window.__morph.fly(opts), { action: step.action, at: step.at ?? {} });
        if (step.closing) seedRect = await measureSeed();
        if (step.seed && step.seed !== 'previous') lastSeed = seedRect;
        if (step.flight && process.env.MORPH_DUMP === zoom.prefix + step.flight) dump(step, run, seedRect);
        const thrown = run.frames.find((f) => f.error);
        if (thrown) invalid.push(`${scenario.name}: the page threw during a frame: ${thrown.error.split('\n')[0]}`);
        if (!step.flight) continue;
        if (run.ms > REAL_TIME_LIMIT_MS) invalid.push(`${zoom.prefix}${step.flight}: took ${Math.round(run.ms)}ms of real time — the 1.4 s watchdog may have ended it`);
        // A closing flight folds into the trigger as it is when the close starts — which is `seedRect` here too.
        const graded = step.pane ? analysePane(step, run) : analyseSurface(step, run, seedRect);
        results.push({ name: zoom.prefix + step.flight, ...graded });
      }
      await js(() => window.__morph.release());
      if (scenario.reduceMotion) {
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
        win.webContents.debugger.detach();
      }
      await wait(150);
    }
   }
  } catch (error) {
    invalid.push(`the run could not complete: ${error?.message ?? error}`);
  } finally {
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  }

  /* ----------------------------------------------------------------------------------------- verdict */

  // The ladder, per zoom.
  for (const zoom of ZOOMS) {
    const at = (name) => results.find((r) => r.name === zoom.prefix + name)?.fingerprint;
    for (const [name, limit] of Object.entries(LADDER)) {
      const f = at(name);
      if (f && f.settleMs > limit + FRAME_MS) results.find((r) => r.name === zoom.prefix + name).faults.push(`settles in ${f.settleMs}ms — the ladder allows ${limit}ms (UI fix list item 32)`);
    }
    for (const [exit, entrance] of EXITS) {
      const out = at(exit);
      const into = at(entrance);
      if (out && into && out.settleMs > into.settleMs + FRAME_MS) results.find((r) => r.name === zoom.prefix + exit).faults.push(`the exit (${out.settleMs}ms) outlasts its entrance (${into.settleMs}ms) (UI fix list item 36)`);
    }
    // Reduce Motion: no geometry animation at all — a surface does not move a pixel (item 32).
    for (const name of ['reduced.menu.open', 'reduced.menu.close']) {
      const f = at(name);
      if (f && f.maxStepPx > 0.5) results.find((r) => r.name === zoom.prefix + name).faults.push(`under Reduce Motion it moved ${f.maxStepPx}px in a frame — nothing may move (UI fix list item 32)`);
    }
  }

  const faults = results.flatMap((r) => r.faults.map((f) => `${r.name}: ${f}`));
  const fingerprints = Object.fromEntries(results.filter((r) => r.fingerprint).map((r) => [r.name, r.fingerprint]));
  const golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : null;
  const drifts = [];
  if (golden && !UPDATE) {
    for (const [name, now] of Object.entries(fingerprints)) {
      if (!golden.flights[name]) drifts.push(`${name}: no baseline for this flight (run with --update to add one)`);
      else drifts.push(...drift(name, golden.flights[name], now));
    }
    for (const name of Object.keys(golden.flights)) if (!fingerprints[name]) drifts.push(`${name}: the baseline has this flight and the run did not produce it`);
  }

  console.log(`morph regression — ${results.length} flights, ${SIZE.width}×${SIZE.height} window at ${ZOOMS.map((z) => `${z.factor * 100}%`).join(' and ')}, built renderer`);
  for (const r of results) {
    const f = r.fingerprint;
    const mark = r.faults.length ? '✗' : '✓';
    console.log(`  ${mark} ${r.name.padEnd(34)} ${f ? `${String(f.frames).padStart(3)} frames  settles ${String(f.settleMs).padStart(3)}ms  overshoot ${f.overshootPct}%  max step ${f.maxStepPx}px` : ''}`);
  }
  for (const line of pageErrors) invalid.push(`renderer error: ${line}`);

  if (invalid.length) {
    console.log('\nINVALID RUN — not a pass, not a failure:');
    for (const line of invalid) console.log(`  - ${line}`);
  }
  if (faults.length) {
    console.log('\nINVARIANTS BROKEN:');
    for (const line of faults) console.log(`  - ${line}`);
  }
  if (drifts.length) {
    console.log('\nFEEL DRIFTED FROM THE BASELINE (scripts/ui/morph.golden.json):');
    for (const line of drifts) console.log(`  - ${line}`);
    console.log('  If the change is intended, run `npm run check:morph -- --update` and say why in the commit.');
  }

  if (UPDATE && !invalid.length && !faults.length) {
    writeFileSync(GOLDEN, serialize({
      note: 'Baseline for scripts/ui/morph-regression.mjs. Each flight: frames to rest, progress of its longest-travelling '
        + 'channel per frame (0 = start, 1 = rest), content reveal per frame, overshoot, largest per-frame move, and the '
        + 'box it ends on (informational). Rewrite only with --update, and say why.',
      window: SIZE,
      zooms: ZOOMS.map((z) => z.factor),
      flights: fingerprints,
    }));
    console.log(`\nbaseline written: ${path.relative(APP_DIR, GOLDEN)}`);
    return 0;
  } else if (UPDATE) {
    console.log('\nbaseline NOT written: the run was invalid or broke an invariant.');
  }

  if (invalid.length) return 2;
  if (faults.length || drifts.length) return 1;
  if (!golden && !UPDATE) {
    console.log('\nno baseline yet — run with --update to write one.');
    return 2;
  }
  console.log('\nall invariants held; every flight within tolerance of its baseline.');
  return 0;
}

// Not a top-level await: Electron waits for the ESM entry to finish evaluating before `ready`, so awaiting
// `whenReady()` at the top level never returns (measured: the process sat silent until killed).
app.disableHardwareAcceleration();
// A profile of its own. Electron's default one keeps per-site zoom, and a harness run at the owner's 120% (item 10)
// left 127.0.0.1 zoomed: every box in this run came out at 1/1.2 scale. Nothing may carry over between runs.
const PROFILE = mkdtempSync(path.join(os.tmpdir(), 'bimax-morph-profile-'));
app.setPath('userData', PROFILE);
app.on('quit', () => rmSync(PROFILE, { recursive: true, force: true }));
app.whenReady()
  .then(main)
  .then((code) => app.exit(code), (error) => { console.error(error); app.exit(2); });
