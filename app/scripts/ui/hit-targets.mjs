// The hit-target check (UI fix list item 34): `npm run check:hit-targets`.
//
// "Minimum 24×24 pt hit regions on small glyphs." A box size says nothing about that: a 16px icon can take clicks over
// 24×24 through an invisible ring (`.hit-24` in styles.css), and a 30px button can lose half of itself to a sibling
// drawn over it. So this measures what a click would hit. For every visible control in each view it walks out from the
// control's centre, left/right and up/down, asking the page which element a click there would land on, and reports any
// control whose clickable region is under 24 × 24 CSS px.
//
// It drives the SHIPPED renderer (out/renderer, the real App with the journeys' bridge stand-in) in an offscreen
// Electron window, like the morph regression check, at 100% and at the owner's 120%. Views: the conversation (a
// thought line, tool rows, a code block), the sidebar with Bimax Threads, the right panel with a file open, find in a
// file, Settings, and the Model menu.
//
// Exempt, as WCAG 2.5.8 exempts them: a link inside running text. Exit status: 0 every control passes, 1 at least one
// is too small, 2 the run could not complete.

import { app, BrowserWindow } from 'electron';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installBridge, serveRenderer } from './renderer.mjs';
import { baseFixture, uiSnapshot, userMessage, assistantMessage, codingToolCall, PROJECT } from './fixtures.mjs';

const MIN = 24;
const SIZE = { width: 1180, height: 800 };
const ZOOMS = [1, 1.2];

/** Page side, self-contained. Every control on screen whose clickable region is under `min` in either direction. */
function measure(min) {
  const SELECTOR = [
    'button', 'a[href]', 'summary', 'select', 'input[type="checkbox"]', 'input[type="radio"]',
    '[role="button"]', '[role="menuitem"]', '[role="tab"]', '[role="checkbox"]', '[role="switch"]', '[role="option"]',
  ].join(', ');
  const owns = (el, x, y) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit));
  };
  // How far a click still lands on `el`, walking from (x, y) in steps of 0.5px, up to `cap`.
  const reach = (el, x, y, dx, dy, cap) => {
    let d = 0;
    while (d < cap && owns(el, x + dx * (d + 0.5), y + dy * (d + 0.5))) d += 0.5;
    return d;
  };
  const out = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
    if (el.tagName === 'A' && style.display === 'inline') continue; // a link inside running text
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    if (!owns(el, x, y)) continue; // covered by something else right now: not clickable in this view
    // Is there SOME spot a 24×24 click region fits around? The centre, then the quarter points: a large row whose
    // hover actions sit over its middle is still easy to click beside them.
    const half = min / 2 + 1;
    let wide = 0;
    let tall = 0;
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
      const px = r.x + r.width * fx;
      const py = r.y + r.height * fy;
      if (!owns(el, px, py)) continue;
      const w = reach(el, px, py, -1, 0, half) + reach(el, px, py, 1, 0, half);
      const t = reach(el, px, py, 0, -1, half) + reach(el, px, py, 0, 1, half);
      if (Math.min(w, t) > Math.min(wide, tall)) { wide = w; tall = t; }
    }
    if (wide >= min - 0.5 && tall >= min - 0.5) continue;
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim().slice(0, 48) || el.tagName.toLowerCase();
    const where = el.closest('[data-panel]')?.id
      || (el.closest('.morph-surface') ? 'menu' : el.closest('[role="dialog"]') ? 'dialog' : 'window');
    out.push({ where, label, clickable: `${Math.min(wide, min + 2)}×${Math.min(tall, min + 2)}`, drawn: `${Math.round(r.width * 10) / 10}×${Math.round(r.height * 10) / 10}` });
  }
  return out;
}

async function main() {
  const { server, base } = await serveRenderer();
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'bimax-hit-'));
  const preload = path.join(scratch, 'preload.cjs');
  const now = Date.now();
  // Two Bimax Threads, so the sidebar's rows and their hover actions are on screen.
  const threads = [
    { id: 'th1', title: 'Sort the Downloads folder', root: '/Users/dev/Downloads', updatedAt: now - 60_000, status: 'working', peers: [], origin: 'quick' },
    { id: 'th2', title: 'Rename the holiday photos', root: '/Users/dev/Pictures', updatedAt: now - 3_600_000, status: 'stopped', peers: [], origin: 'quick', outcome: 'completed', check: 'passed' },
  ];
  writeFileSync(preload, `(${installBridge})(${JSON.stringify(baseFixture({ threads, threadsActive: 'th1' }))});\n`);
  const win = new BrowserWindow({ ...SIZE, show: false, webPreferences: { offscreen: true, preload, contextIsolation: false, sandbox: false } });
  const js = (fn, ...args) => win.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (fn, arg, ms = 5000) => {
    for (const start = Date.now(); Date.now() - start < ms; await wait(100)) if (await js(fn, arg)) return true;
    return false;
  };

  const found = [];
  let invalid = null;
  try {
    for (const zoom of ZOOMS) {
      await win.loadURL(`${base}/`);
      win.webContents.setZoomFactor(zoom);
      await js((project, snapshot, events) => {
        const H = window.__bimaxHarness;
        H.callbacks.project.forEach((cb) => cb(project));
        H.callbacks.msg.forEach((cb) => cb({ t: 'ready', protocol: 3 }));
        H.callbacks.state.forEach((cb) => cb('ready', ''));
        H.callbacks.msg.forEach((cb) => cb({ t: 'event', name: 'ui_snapshot', args: [snapshot] }));
        for (const [name, arg] of events) H.callbacks.msg.forEach((cb) => cb({ t: 'event', name, args: [arg] }));
      }, PROJECT, uiSnapshot(), [
        ['message', userMessage('u1', 'Add retry with backoff to the fetch client')],
        ['tool_call', codingToolCall({ id: 't1' })],
        ['tool_call', codingToolCall({ id: 't2', toolName: 'Bash', input: 'npm test', output: '12 passing' })],
        ['message', assistantMessage('a1', 'Added a shared `retry` helper and wired the three call sites.\n\n```ts\nexport async function retry() {}\n```')],
      ]);
      if (!(await until(() => !!document.querySelector('button[aria-haspopup="menu"][aria-label="Model"]')))) throw new Error('the shell never rendered');
      await wait(800);
      const views = [];
      const look = async (view, only) => {
        // Measure at rest: a surface caught mid-entrance is still scaled down (the find card's pop-in measured 0.86×).
        // Looping animations (a working spinner) never end, so only the finite ones are waited for.
        await until(() => !document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity));
        const list = await js(measure, MIN);
        for (const item of list) if (!only || only.includes(item.where)) views.push({ view, ...item });
      };

      await look('conversation and sidebar');
      await js(() => [...document.querySelectorAll('[data-panel][id="inspector"] [role="button"]')].find((el) => el.textContent.trim().startsWith('package.json'))?.click());
      if (!(await until(() => !!document.querySelector('button[aria-label="Find in this file"]')))) throw new Error('the file never opened');
      await look('a file open', ['inspector']);
      await js(() => document.querySelector('button[aria-label="Find in this file"]').click());
      if (!(await until(() => !!document.querySelector('.find-widget')))) throw new Error('find never opened');
      await look('find in a file', ['inspector']);
      await js(() => window.__bimaxHarness.callbacks.menu.forEach((cb) => cb('settings')));
      await wait(1000);
      await look('Settings', ['dialog']);
      await js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await wait(700);
      await js(() => document.querySelector('button[aria-haspopup="menu"][aria-label="Model"]').click());
      await wait(800);
      await look('the Model menu', ['menu']);

      const seen = new Set();
      for (const item of views) {
        const key = `${item.view}|${item.where}|${item.label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ zoom, ...item });
      }
    }
  } catch (error) {
    invalid = error?.message ?? String(error);
  } finally {
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`hit targets — every control at least ${MIN}×${MIN} CSS px where a click lands, ${SIZE.width}×${SIZE.height} at ${ZOOMS.map((z) => `${z * 100}%`).join(' and ')}`);
  if (invalid) {
    console.log(`\nINVALID RUN — ${invalid}`);
    return 2;
  }
  if (found.length) {
    console.log(`\n${found.length} too small:`);
    for (const f of found) console.log(`  - ${f.zoom * 100}% · ${f.view} · ${f.where}: "${f.label}" takes clicks over ${f.clickable} (drawn ${f.drawn})`);
    return 1;
  }
  console.log('\nevery control passes.');
  return 0;
}

// Not a top-level await — see morph-regression.mjs. A throwaway profile, so no zoom carries over between runs.
app.disableHardwareAcceleration();
const PROFILE = mkdtempSync(path.join(os.tmpdir(), 'bimax-hit-profile-'));
app.setPath('userData', PROFILE);
app.on('quit', () => rmSync(PROFILE, { recursive: true, force: true }));
app.whenReady()
  .then(main)
  .then((code) => app.exit(code), (error) => { console.error(error); app.exit(2); });
