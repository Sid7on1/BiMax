import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../../..');
const require = createRequire(path.join(root, 'app/package.json'));
const puppeteer = require('puppeteer-core');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'bimax-depth-browser-'));
let browser;
const report = { scope: 'Actual production Markdown component in isolated headless Chromium; synchronous render cost, not installed input latency or native frame presentation', platform: process.platform, arch: process.arch, cases: [], errors: [] };
try {
  execFileSync('bun', ['build', path.join(directory, 'renderer-probe.tsx'), '--production', '--target=browser', '--format=iife', '--outdir', scratch, '--entry-naming', '[name].[ext]'], { cwd: root, stdio: 'pipe' });
  writeFileSync(path.join(scratch, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="renderer-probe.js"></script>');
  browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--allow-file-access-from-files'] });
  report.browser = await browser.version();
  const page = await browser.newPage();
  page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(`file://${path.join(scratch, 'index.html')}`);
  await page.waitForFunction(() => typeof window.audit?.render === 'function');
  report.cases = await page.evaluate(async () => {
    const a = window.audit;
    const cases = [];
    for (const kind of ['prose', 'code']) for (const size of [8192, 32768, 131072]) {
      const unit = kind === 'prose' ? 'An audit paragraph with **emphasis**, a [link](https://example.com), and `code`.\n\n' : 'const example = "synthetic source only";\n';
      const body = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      const text = kind === 'code' ? '```typescript\n' + body : body;
      a.render(''); a.charsLexed = 0; a.lexCalls = 0; a.lexMs = 0;
      const samples = [];
      const stableNode = document.querySelector('.md');
      for (let end = 256; end < text.length + 256; end += 256) {
        const start = performance.now(); a.render(text.slice(0, end)); samples.push(performance.now() - start);
        if (samples.length % 16 === 0) await new Promise(r => setTimeout(r, 0));
      }
      const sorted = samples.slice().sort((a, b) => a - b);
      cases.push({ kind, finalChars: text.length, updates: samples.length, charsLexed: a.charsLexed, lexCalls: a.lexCalls, lexMs: a.lexMs,
        totalRenderMs: samples.reduce((a,b) => a+b,0), p50Ms: sorted[Math.floor(sorted.length*.5)], p95Ms: sorted[Math.floor(sorted.length*.95)], maxMs: sorted.at(-1), over16ms: samples.filter(t => t > 16.67).length,
        stableContainer: stableNode === document.querySelector('.md'), finalCodeExact: kind === 'code' ? document.querySelector('code')?.textContent === body : null, samples });
    }
    return cases;
  });
} catch (error) { report.invalid = error.stack || String(error); process.exitCode = 2; }
finally { await browser?.close(); rmSync(scratch, { recursive: true, force: true }); writeFileSync(path.join(directory, 'renderer-performance.json'), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify({ ...report, cases: report.cases.map(({ samples, ...rest }) => rest) }, null, 2));
