#!/usr/bin/env node
/**
 * Does text still clear WCAG AA on the glass?
 *
 * Measure the composited colours of the built design preview's real renderer components.
 * Both themes, both window layouts and both zooms are required evidence. This browser fixture
 * does not model native macOS vibrancy or every wallpaper; those need installed-app measurement.
 *
 * Two assertions, matching what styles.css actually commits to:
 *
 *   1. PRIMARY ink clears AA everywhere. That is the documented table.
 *   2. EVERY readable label clears 4.5:1 at baseline and under Increase Contrast (UI fix list item
 *      43 and the owner's handoff). Quiet type is still type; accessibility cannot require an
 *      opt-in setting. Inactive controls remain excluded, as WCAG 1.4.3 excludes them.
 *
 *   node scripts/check-glass-contrast.mjs            # assert
 *   node scripts/check-glass-contrast.mjs --report   # print only, always exit 0
 */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AA = 4.5;
const REPORT_ONLY = process.argv.includes('--report');
const JSON_PATH = process.argv.find((arg) => arg.startsWith('--json='))?.slice(7);
/* Every preview page that stages real surfaces. `#workbench` was added with the right panel's tab
   strip (2026-09-19): a new surface that this checker does not visit is a surface nobody measured,
   and the chips' quiet text sits on a raised veil over the pane's veil. `#transcript` (2026-09-30) is
   where a reply's code blocks are, with the editor's syntax colours. */
const PAGES = ['http://localhost:5199/#shell', 'http://localhost:5199/#workbench', 'http://localhost:5199/#transcript'];
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Equivalent physical viewport at 100% and the owner's 120%: fewer CSS pixels, proportionally
// more raster pixels. Sampling uses that exact DPR, so text and screenshot share coordinates.
const ZOOMS = [1, 1.2];

const srgb = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * srgb(r / 255) + 0.7152 * srgb(g / 255) + 0.0722 * srgb(b / 255);
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
/**
 * Parse a computed colour to 0-255 RGB.
 *
 * `color-mix()` resolves to `color(srgb 0.85 0.85 0.84)` — 0..1 floats — while everything else comes
 * back as `rgb(217, 217, 216)`. Reading the former on the 0..255 scale makes boosted text look
 * black, which is exactly backwards: it reported the Increase Contrast path as a catastrophic
 * regression when the path had just started working.
 */
const parse = (c) => {
  const n = (c.match(/[\d.]+(?:e-?\d+)?/g) || []).slice(0, 3).map(Number);
  if (n.length < 3) return [];
  return c.startsWith('color(') ? n.map((v) => Math.round(v * 255)) : n;
};

const VITE = path.join(APP, 'node_modules/vite/bin/vite.js');
try {
  execFileSync(process.execPath, [VITE, 'build', '--config', 'design-preview/vite.config.ts', '--logLevel', 'silent'],
    { cwd: APP, stdio: 'pipe' });
} catch (error) {
  console.error('INVALID: design-preview build failed', error.stderr?.toString() ?? error.message);
  process.exit(2);
}
const vite = spawn(process.execPath, [VITE, 'preview', '--config', 'design-preview/vite.config.ts', '--port', '5199', '--strictPort'],
  { cwd: APP, stdio: 'ignore' });
const stop = () => { try { vite.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);
for (let i = 0; ; i++) {
  if (vite.exitCode !== null) { console.error('INVALID: preview server exited'); process.exit(2); }
  try { if ((await fetch('http://localhost:5199')).ok) break; } catch { /* not up */ }
  if (i > 40) { console.error('design-preview did not start'); process.exit(2); }
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
const cdp = await page.createCDPSession();

async function measure(features) {
  const rows = [];
  for (const zoom of ZOOMS) {
    await page.setViewport({ width: Math.round(1400 / zoom), height: Math.round(900 / zoom), deviceScaleFactor: 2 * zoom });
    for (const url of PAGES) rows.push(...(await measurePage(features, url)).map((r) => ({ ...r, zoom })));
  }
  return rows;
}

async function measurePage(features, url) {
  await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features });
  // A hash-only navigation does NOT re-run the app: the preview reads `location.hash` once, at
  // mount, and then writes its own back. Without the reload the second page silently measured the
  // first one again — 138 nodes that were 69 counted twice, and the new surface unmeasured while
  // the total said otherwise.
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  // And back to the top. Element rects are viewport-relative while the screenshot below covers the
  // whole document, so a restored scroll offset shifts every sampling point — which reported real
  // primary ink as 1.11:1 "on #000000", i.e. on nothing at all.
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 800));

  const samples = await page.evaluate(() => {
    /**
     * Let the browser resolve the text colour.
     *
     * Tailwind v4 writes every alpha as `color-mix(in oklab, …)`, which computes to an `oklab(…)`
     * string. The script's own parser reads the first three numbers on a 0-255 scale, so
     * `oklab(0.79 0.06 0.13 / 0.85)` came back as RGB 0,0,0 — an amber warning line was reported at
     * 1.26:1 against its own pane, a "failure" that was pure arithmetic. Painting the colour into a
     * canvas makes the browser do the conversion it already knows how to do, alpha included.
     */
    const swatch = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const rgba = (value) => {
      swatch.clearRect(0, 0, 1, 1);
      swatch.fillStyle = value;
      swatch.fillRect(0, 0, 1, 1);
      const d = swatch.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const out = [];
    // Innermost stages only. The transcript renders the real `Transcript`, which publishes the window's chrome on
    // <html> just as the app does — and <html> also carries the page's theme class, so it matched as a stage wrapping
    // the two real ones. Every node was then measured a second time under the wrong theme and chrome, and text the
    // preview scrolls out of view was reported at 1.08:1 "on #1a1a1a".
    const STAGE = '[class*="theme-"][data-chrome]';
    for (const stage of [...document.querySelectorAll(STAGE)].filter((s) => !s.querySelector(STAGE))) {
      const theme = stage.className.includes('starlight') ? 'starlight' : 'moonlight';
      const chrome = stage.getAttribute('data-chrome');
      // Resolve this stage's own ink, so "is this primary text?" is a fact rather than a guess.
      const probe = document.createElement('span');
      Object.assign(probe.style, { color: 'var(--color-ink)', position: 'absolute', opacity: '0' });
      stage.appendChild(probe);
      const ink = getComputedStyle(probe).color;
      probe.remove();
      for (const el of stage.querySelectorAll('*')) {
        // The code editor IS measured now. It used to be skipped because it painted its own opaque
        // slab; since 2026-09-30 it is glass on the pane's veil, so its code is text over the glass
        // like any other — and text people read line by line, so it is held to AA as its own class
        // (`code`, assertion [3] below), syntax colours and comments included. The backdrop is the
        // dominant colour inside the token's own box (see below), not a point under it, so a token's
        // neighbours do not stand in for its ground. Inside the editor only the code and the line
        // numbers are text; its hidden measuring and accessibility nodes are not.
        if (el.closest('.cm-editor') && !el.closest('.cm-content, .cm-gutters')) continue;
        // Not a disabled control. WCAG 1.4.3 exempts inactive components, and ours are drawn at
        // `opacity-40`/`opacity-45` — which is exactly what the two last "failures" were: a Push
        // button with no remote and a commit button with no message, both painted at 45% and both
        // measured as if a user were meant to read them.
        if (el.closest('[disabled], [aria-disabled="true"]')) continue;
        const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3)
          .map((n) => n.textContent.trim()).join('');
        if (!text) continue;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        // MANY points over the element's box, and the winner is decided by agreement, not position.
        //
        // This used to be one point 12px under the text's centre. That works on the sidebar's tall
        // rows and fails on everything smaller: 12px below a 24px toolbar button's label is the
        // pane underneath it, so the check measured a button's light label against the dark pane
        // and called it a contrast failure. Five of them, all the probe leaving the element.
        //
        // A grid over the box has the opposite problem — for 10px text the box is mostly glyph — so
        // the points are not averaged. They are bucketed by colour and the biggest bucket wins: the
        // background repeats, while antialiased glyph edges spread across many values. See
        // `dominant` below.
        const stageBox = stage.getBoundingClientRect();
        const grid = [];
        for (const fx of [0.02, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.98]) {
          for (const fy of [0.06, 0.25, 0.5, 0.75, 0.94]) {
            const x = Math.round(r.left + r.width * fx);
            const y = Math.round(r.top + r.height * fy);
            // A chip scrolled out of a horizontal strip still has a rect — outside the stage, over
            // the page behind it. Sampling that reported the page's own background as the surface.
            if (x < stageBox.left || x > stageBox.right || y < stageBox.top || y > stageBox.bottom) continue;
            grid.push({ x, y });
          }
        }
        if (grid.length === 0) continue;
        out.push({
          theme, chrome, text: text.slice(0, 24), color: cs.color, fg: rgba(cs.color),
          primary: cs.color === ink,
          // The editor's code, and a reply's fenced code block (highlight.js spans inside `<pre>`).
          code: !!el.closest('.cm-content, .md pre'),
          size: parseFloat(cs.fontSize), weight: cs.fontWeight, grid,
        });
      }
    }
    return out;
  });

  // Sample the COMPOSITED surface: getComputedStyle's backgroundColor is the declared value and
  // would miss everything backdrop-filter pulls through, which is the whole point here. Chrome
  // decodes its own screenshot through a canvas, so this needs no image library.
  // `fullPage`, because a preview page can be taller than the viewport and every sampling point
  // below the fold otherwise reads pure black — which the check then reports as a catastrophic
  // contrast failure of text that is simply off-screen. Scroll is pinned at 0 above, so the
  // elements' viewport-relative rects and this document-sized image share one coordinate space.
  const shot = await page.screenshot({ encoding: 'base64', fullPage: true });
  /**
   * The colour the element actually sits on: the most agreed-upon sample.
   *
   * Buckets to 8 levels per channel, because the surface is a veil over a gradient and no two
   * pixels are bit-identical, then averages the winning bucket's members so the reported hex is a
   * real colour rather than the bucket's floor. Antialiased glyph pixels take every value between
   * ink and surface, so they scatter across buckets and lose.
   */
  const dominant = (points) => {
    const buckets = new Map();
    for (const p of points) {
      const key = `${p[0] >> 3}:${p[1] >> 3}:${p[2] >> 3}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(p);
      buckets.set(key, bucket);
    }
    const best = [...buckets.values()].sort((a, b) => b.length - a.length)[0];
    return [0, 1, 2].map((channel) => Math.round(best.reduce((sum, p) => sum + p[channel], 0) / best.length));
  };
  const backdrops = await page.evaluate(async (dataUrl, pts, dpr) => {
    const img = new Image();
    img.src = `data:image/png;base64,${dataUrl}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return pts.map(({ x, y }) => {
      const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
      return [d[0], d[1], d[2]];
    });
  }, shot, samples.flatMap((s) => s.grid), page.viewport().deviceScaleFactor);

  let cursor = 0;
  return samples.map((s) => {
    const points = backdrops.slice(cursor, cursor + s.grid.length);
    cursor += s.grid.length;
    const bg = dominant(points);
    // Semi-transparent text IS its blend with what it sits on; measuring the unblended colour
    // flatters it. Alpha comes back with the colour now, so the blend is a fact rather than an
    // assumption.
    const [r, g, b, alpha] = s.fg;
    const fg = [r, g, b].map((channel, i) => Math.round(channel * alpha + bg[i] * (1 - alpha)));
    return { ...s, page: new URL(url).hash, bg, ratio: contrast(fg, bg), floor: AA };
  }).filter((r) => r.fg[3] > 0.05);
}

const base = await measure([]);
const more = await measure([{ name: 'prefers-contrast', value: 'more' }]);
await browser.close();
stop();

const show = (rows, n = 10) => rows.slice(0, n).forEach((r) => console.log(
  `    ${r.ratio.toFixed(2).padStart(5)}:1  floor ${r.floor}  ${r.theme.padEnd(10)}${String(r.chrome).padEnd(9)}` +
  `${r.primary ? 'ink ' : 'quiet'} ${String(r.size).padStart(4)}px  ${r.text.padEnd(24)} on ${hex(r.bg)}`));

const byRatio = (a, b) => a.ratio - b.ratio;
const primaryFails = base.filter((r) => r.primary && !r.code && r.ratio < r.floor).sort(byRatio);
const codeFails = base.filter((r) => r.code && r.ratio < r.floor).sort(byRatio);
const quietFails = base.filter((r) => !r.primary && !r.code && r.ratio < r.floor).sort(byRatio);
const moreFails = more.filter((r) => r.ratio < r.floor).sort(byRatio);
// An absent theme/surface is missing evidence, never a pass. All three previews stage both
// themes, windowed and expanded; code must be measured in each theme too.
const missing = ZOOMS.flatMap((zoom) => PAGES.flatMap((url) => ['moonlight', 'starlight'].flatMap((theme) =>
  ['windowed', 'expanded'].flatMap((chrome) =>
    [base, more].some((rows) => !rows.some((r) => r.zoom === zoom && r.page === new URL(url).hash && r.theme === theme && r.chrome === chrome))
      ? [`${zoom * 100}%/${new URL(url).hash}/${theme}/${chrome}`] : []))));
for (const theme of ['moonlight', 'starlight']) if (!base.some((r) => r.code && r.theme === theme)) missing.push(`${theme}/code`);
if (JSON_PATH) writeFileSync(JSON_PATH, JSON.stringify({
  base: base.map(({ grid, ...row }) => row), more: more.map(({ grid, ...row }) => row), missing,
}, null, 2) + '\n');
if (missing.length) console.log(`MISSING EVIDENCE: ${missing.join(', ')}`);

console.log(`\nglass contrast — ${base.length} text nodes over their composited surface\n`);
console.log(`  [1] PRIMARY ink at baseline — ${primaryFails.length ? `${primaryFails.length} BELOW FLOOR` : 'all clear'}`);
if (primaryFails.length) show(primaryFails);
else {
  const worst = base.filter((r) => r.primary).sort(byRatio)[0];
  if (worst) console.log(`    worst ${worst.ratio.toFixed(2)}:1  ${worst.theme}/${worst.chrome}  "${worst.text}"`);
}

const code = base.filter((r) => r.code);
console.log(`\n  [3] CODE (editor and chat code blocks) at baseline, every token — ${code.length ? (codeFails.length ? `${codeFails.length} of ${code.length} BELOW FLOOR` : `all ${code.length} clear`) : 'NONE MEASURED'}`);
if (codeFails.length) show(codeFails);
else {
  for (const theme of ['moonlight', 'starlight']) {
    const worst = code.filter((r) => r.theme === theme).sort(byRatio)[0];
    if (worst) console.log(`    ${theme.padEnd(10)} worst ${worst.ratio.toFixed(2)}:1  ${worst.chrome}  "${worst.text}" (${worst.color})`);
  }
}
const gutter = base.filter((r) => !r.code && r.text && /^\d+$/.test(r.text) && r.size === 12.5).sort(byRatio)[0];
if (gutter) console.log(`    line numbers: worst ${gutter.ratio.toFixed(2)}:1  ${gutter.theme}/${gutter.chrome}`);

console.log(`\n  [2] EVERYTHING under prefers-contrast: more — ${moreFails.length ? `${moreFails.length} BELOW FLOOR` : 'all clear'}`);
if (moreFails.length) show(moreFails);

console.log(`\n  [4] QUIET text at baseline — ${quietFails.length ? `${quietFails.length} BELOW FLOOR` : 'all clear'}`);
show(quietFails, 20);

// No code at all is a failure too: the preview stages open files, so zero means the editor stopped rendering (or the
// selector drifted) and the code went unmeasured while the check said nothing.
const failed = primaryFails.length > 0 || quietFails.length > 0 || moreFails.length > 0 || codeFails.length > 0 || missing.length > 0;
if (failed && !REPORT_ONLY) { console.error('\n✗ contrast regression\n'); process.exit(1); }
console.log(failed ? '\nContrast findings above (report only).\n' : '\n✓ every readable label and code token clears 4.5:1 in both themes and contrast modes\n');
