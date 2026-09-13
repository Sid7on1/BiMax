#!/usr/bin/env node
/** Render captured BUILT-engine frames in the production bundle. Preload is the repository's
 * fixture bridge, not Electron IPC; no claim about an installed app is inferred from this test. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { serveRenderer, openRenderer, feed, settle, shot, WINDOW_SIZES } from './harness.mjs';
import { baseFixture } from './fixtures.mjs';
const evidence = path.resolve(process.argv[2]);
const frames = fs.readFileSync(path.join(evidence, 'embedding-410.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
const fault = frames.find(m => m.args?.[0]?.payload?.capabilityStatus?.id === 'embeddings');
assert(fault, 'missing actual engine failure frame');
const { server, base } = await serveRenderer();
const results = [];
try {
  for (const size of WINDOW_SIZES.slice(0, 2)) {
    const { browser, page, pageErrors } = await openRenderer({ base, fixture: baseFixture(), size });
    try {
      await page.waitForFunction(() => window.__bimaxHarness?.calls.some(c => c.name === 'rendererReady'));
      await settle(page);
      for (const frame of frames) await feed(page, frame);
      await page.waitForSelector('[aria-label="Capability problems"]', { visible: true });
      const observed = await page.$eval('[aria-label="Capability problems"]', el => {
        const r = el.getBoundingClientRect();
        return { text: el.innerText, x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
      });
      assert(observed.scrollWidth <= observed.clientWidth, 'warning text requires horizontal scrolling');
      assert.match(observed.text, /Semantic retrieval: degraded/); assert.match(observed.text, /keywords only/);
      assert(observed.x >= 0 && observed.y >= 0 && observed.right <= observed.width && observed.bottom <= observed.height, 'banner outside viewport');
      await shot(page, evidence, `desktop-${size.name}-failure`);
      await page.click('[data-capability-id="embeddings"] summary');
      assert.match(await page.$eval('[data-capability-id="embeddings"]', el => el.innerText), /410/);
      // Recovery is a synthetic valid protocol frame; the binary recovery path is checked by Jest.
      const recovered = structuredClone(fault);
      recovered.args[0].payload.capabilityStatus.state = 'ready';
      recovered.args[0].content = 'Semantic retrieval recovered.';
      await feed(page, recovered); await settle(page);
      const after = await page.$eval('body', el => el.querySelector('[aria-label="Capability problems"]')?.textContent || '');
      assert(!after.includes('keywords only'), 'recovered warning remains');
      assert.deepEqual(pageErrors, []);
      results.push({ size: size.name, status: 'pass', observed, recoveryCleared: true, pageErrors });
    } finally { await browser.close(); }
  }
} finally { server.close(); fs.writeFileSync(path.join(evidence, 'desktop-result.json'), JSON.stringify({ boundary: 'production renderer with fixture preload, actual built-engine NDJSON', cases: results, status: results.length === 2 ? 'pass' : 'fail' }, null, 2)); }
console.log(JSON.stringify(results, null, 2));
