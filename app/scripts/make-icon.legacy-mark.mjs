// RETIRED — this draws the old procedural two-orbits mark, NOT the current brand icon.
// It writes the same buildResources/icon.png that app/scripts/make-icon.py now owns, so running
// it reverts the brand icon. Kept only as the source of the old mark. Use make-icon.py.
// Render the Bimax app icon (1024×1024 PNG) via system Chrome — a macOS-safe graphite tile with
// the product's two-orbits/one-core mark. Resolves puppeteer from the repo root's node_modules.
// Usage: node app/scripts/make-icon.mjs   (from anywhere; paths are script-relative)
// electron-builder converts buildResources/icon.png → .icns/.ico per target automatically.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(appDir, 'buildResources');
const out = path.join(outDir, 'icon.png');

const html = `<!doctype html><html><head><style>
  * { margin:0; padding:0; }
  body { width:1024px; height:1024px; background:transparent; }
  .tile {
    position:absolute; left:92px; top:92px; width:840px; height:840px;
    border-radius:202px;
    background:
      radial-gradient(90% 76% at 28% 12%, rgba(215,133,98,.13), transparent 58%),
      linear-gradient(145deg, #2b2925 0%, #1d1d1b 54%, #141413 100%);
    box-shadow:
      inset 0 3px 4px rgba(255,255,255,0.08),
      inset 0 -12px 30px rgba(0,0,0,0.42),
      0 18px 34px rgba(0,0,0,0.16);
    display:flex; align-items:center; justify-content:center; overflow:hidden;
  }
  .glow {
    position:absolute; width:610px; height:610px; border-radius:50%;
    background:radial-gradient(circle, rgba(215,133,98,0.19) 0%, rgba(215,133,98,0) 68%);
  }
  .mark { position:relative; width:530px; height:560px; }
  .orbit {
    position:absolute; left:50%; top:50%; width:250px; height:470px;
    margin-left:-125px; margin-top:-235px; border-radius:50%;
    border:30px solid transparent;
    background:linear-gradient(155deg,#F0A582 4%,#D78562 48%,#A85439 100%) border-box;
    -webkit-mask:linear-gradient(#000 0 0) padding-box,linear-gradient(#000 0 0);
    -webkit-mask-composite:xor; mask-composite:exclude;
    filter:drop-shadow(0 14px 18px rgba(74,30,18,.28));
  }
  .orbit.a { transform:rotate(-30deg) translateX(-39px); }
  .orbit.b {
    transform:rotate(30deg) translateX(39px);
    background:linear-gradient(155deg,#A9CCAF 4%,#82AD89 48%,#557C5C 100%) border-box;
    filter:drop-shadow(0 14px 18px rgba(26,60,35,.25));
  }
  .core {
    position:absolute; left:50%; top:50%; width:90px; height:90px;
    margin-left:-45px; margin-top:-45px; border-radius:50%;
    background:radial-gradient(circle at 35% 28%,#FFF9EE 0 11%,#F1EFE9 12% 36%,#D78562 38% 52%,#181817 54% 100%);
    box-shadow:0 0 0 16px rgba(24,24,23,.76),0 9px 24px rgba(0,0,0,.4);
  }
  .shine {
    position:absolute; inset:0; border-radius:inherit; pointer-events:none;
    background:linear-gradient(155deg,rgba(255,255,255,.09),transparent 32% 75%,rgba(0,0,0,.11));
  }
</style></head><body>
  <div class="tile"><div class="glow"></div><div class="mark"><div class="orbit a"></div><div class="orbit b"></div><div class="core"></div></div><div class="shine"></div></div>
</body></html>`;

const browser = await puppeteer.launch({
  executablePath: process.env.BIMAX_UI_CHROME || puppeteer.executablePath(),
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle0' });
mkdirSync(outDir, { recursive: true });
await page.screenshot({ path: out, omitBackground: true });
await browser.close();
console.log('icon written:', out);
