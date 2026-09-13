#!/usr/bin/env node
/**
 * Does text still clear WCAG AA on the glass?
 *
 * `styles.css` picks `--glass-veil: 0.62` from a contrast table measured by hand against macOS 26
 * Tahoe's vibrancy. macOS 27 Golden Gate changes that material AND gives the user a slider from
 * "ultra-clear" to "fully tinted" which apps inherit with no code change. The thinnest margin in
 * that table is 4.92:1 against a 4.5 floor — 9% of headroom — so "we measured it once" stops being
 * an answer the moment the material underneath us moves. Re-run this on 27, at both ends of the
 * slider.
 *
 * Two assertions, matching what styles.css actually commits to:
 *
 *   1. PRIMARY ink clears AA everywhere. That is the documented table.
 *   2. Under `prefers-contrast: more`, EVERYTHING clears AA — including the quiet text. styles.css
 *      says of `--color-dim`: "That is a *foreground* problem … and the Increase Contrast block
 *      near the end of this file is what answers it." This checks that the answer works.
 *
 * Quiet text below AA at baseline is reported, not failed: it is a deliberate choice, and (1)+(2)
 * are the properties that would actually be regressions.
 *
 *   node scripts/check-glass-contrast.mjs            # assert
 *   node scripts/check-glass-contrast.mjs --report   # print only, always exit 0
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AA = 4.5, AA_LARGE = 3.0;
const REPORT_ONLY = process.argv.includes('--report');
const URL = 'http://localhost:5199/#shell';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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

const vite = spawn('npx', ['vite', '--config', 'design-preview/vite.config.ts', '--logLevel', 'silent'],
  { cwd: APP, stdio: 'ignore' });
const stop = () => { try { vite.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);
for (let i = 0; ; i++) {
  try { if ((await fetch('http://localhost:5199')).ok) break; } catch { /* not up */ }
  if (i > 40) { console.error('design-preview did not start'); process.exit(2); }
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
const cdp = await page.createCDPSession();

async function measure(features) {
  await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));

  const samples = await page.evaluate(() => {
    const out = [];
    for (const stage of document.querySelectorAll('[class*="theme-"][data-chrome]')) {
      const theme = stage.className.includes('starlight') ? 'starlight' : 'moonlight';
      const chrome = stage.getAttribute('data-chrome');
      // Resolve this stage's own ink, so "is this primary text?" is a fact rather than a guess.
      const probe = document.createElement('span');
      Object.assign(probe.style, { color: 'var(--color-ink)', position: 'absolute', opacity: '0' });
      stage.appendChild(probe);
      const ink = getComputedStyle(probe).color;
      probe.remove();
      for (const el of stage.querySelectorAll('*')) {
        const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3)
          .map((n) => n.textContent.trim()).join('');
        if (!text) continue;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        out.push({
          theme, chrome, text: text.slice(0, 24), color: cs.color, primary: cs.color === ink,
          size: parseFloat(cs.fontSize), weight: cs.fontWeight,
          x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
        });
      }
    }
    return out;
  });

  // Sample the COMPOSITED surface: getComputedStyle's backgroundColor is the declared value and
  // would miss everything backdrop-filter pulls through, which is the whole point here. Chrome
  // decodes its own screenshot through a canvas, so this needs no image library.
  const shot = await page.screenshot({ encoding: 'base64' });
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
  }, shot, samples.map((s) => ({ x: s.x, y: s.y + 12 })), 2);

  return samples.map((s, i) => {
    const fg = parse(s.color);
    const large = s.size >= 18.66 || (s.size >= 14 && Number(s.weight) >= 700);
    return { ...s, bg: backdrops[i], ratio: contrast(fg, backdrops[i]), floor: large ? AA_LARGE : AA };
  }).filter((r) => parse(r.color).length === 3);
}

const base = await measure([]);
const more = await measure([{ name: 'prefers-contrast', value: 'more' }]);
await browser.close();
stop();

const show = (rows, n = 10) => rows.slice(0, n).forEach((r) => console.log(
  `    ${r.ratio.toFixed(2).padStart(5)}:1  floor ${r.floor}  ${r.theme.padEnd(10)}${String(r.chrome).padEnd(9)}` +
  `${r.primary ? 'ink ' : 'quiet'} ${String(r.size).padStart(4)}px  ${r.text.padEnd(24)} on ${hex(r.bg)}`));

const byRatio = (a, b) => a.ratio - b.ratio;
const primaryFails = base.filter((r) => r.primary && r.ratio < r.floor).sort(byRatio);
const quietFails = base.filter((r) => !r.primary && r.ratio < r.floor).sort(byRatio);
const moreFails = more.filter((r) => r.ratio < r.floor).sort(byRatio);

console.log(`\nglass contrast — ${base.length} text nodes over their composited surface\n`);
console.log(`  [1] PRIMARY ink at baseline — ${primaryFails.length ? `${primaryFails.length} BELOW FLOOR` : 'all clear'}`);
if (primaryFails.length) show(primaryFails);
else {
  const worst = base.filter((r) => r.primary).sort(byRatio)[0];
  if (worst) console.log(`    worst ${worst.ratio.toFixed(2)}:1  ${worst.theme}/${worst.chrome}  "${worst.text}"`);
}

console.log(`\n  [2] EVERYTHING under prefers-contrast: more — ${moreFails.length ? `${moreFails.length} BELOW FLOOR` : 'all clear'}`);
if (moreFails.length) show(moreFails);

console.log(`\n  [i] quiet text below AA at baseline (deliberate; Increase Contrast is the remedy): ${quietFails.length}`);
show(quietFails, 6);

const failed = primaryFails.length > 0 || moreFails.length > 0;
if (failed && !REPORT_ONLY) { console.error('\n✗ contrast regression\n'); process.exit(1); }
console.log(`\n✓ primary ink clears AA, and Increase Contrast rescues ${quietFails.length - moreFails.length} of ${quietFails.length} quiet nodes\n`);
