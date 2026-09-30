// UI fix list 23/28/30: finite feedback for real state, no ambient status spectacle.
import { writeFileSync } from 'node:fs';
import { serveRenderer, openRenderer, feed, feedEvent, settle } from './harness.mjs';
import { baseFixture, uiSnapshot, userMessage, PROJECT } from './fixtures.mjs';
const { server, base } = await serveRenderer(); const report = []; let invalid = null;
try {
  for (const zoom of [1, 1.2]) {
    const { browser, page, pageErrors } = await openRenderer({ base, fixture: baseFixture(), size: { width: Math.round(1180/zoom), height: Math.round(800/zoom) } });
    try {
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.evaluate(project => { const H = window.__bimaxHarness; H.callbacks.project.forEach(cb => cb(project)); H.callbacks.state.forEach(cb => cb('ready', '')); }, PROJECT);
      await feed(page, { t: 'ready', protocol: 3 }); await feedEvent(page, 'ui_snapshot', [uiSnapshot()]); await settle(page, 300);
      const starter = await page.$('.workspace-starter');
      const home = await page.$eval('.workspace-starter', el => { const cs = getComputedStyle(el); return { animation: cs.animationName, duration: cs.animationDuration }; });
      await starter.hover(); await settle(page, 300);
      const hover = await page.$eval('.workspace-starter', el => { const matrix = getComputedStyle(el).transform; return { matrix, travels: matrix !== 'none' && !new DOMMatrixReadOnly(matrix).isIdentity }; });
      const box = await starter.boundingBox(); await page.mouse.move(box.x+box.width/2, box.y+box.height/2); await page.mouse.down();
      const press = await page.$eval('.workspace-starter', el => ({ active: el.matches(':active'), outline: getComputedStyle(el).outlineStyle, width: parseFloat(getComputedStyle(el).outlineWidth) }));
      await page.mouse.move(0, 0); await page.mouse.up();
      await feedEvent(page, 'message', [userMessage('u', 'Explain the fetch client')]); await feedEvent(page, 'spinner_state', ['working']); await settle(page, 150);
      const words = await page.$$eval('.thinking-verb', els => els.map(el => el.textContent));
      const loops = await page.evaluate(() => document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations === Infinity && a.effect.target.closest('.thinking-verb, .reading-column')).map(a => a.animationName));
      const textChanges = await page.evaluate(() => new Promise(resolve => { let changes = 0; const node = document.querySelector('.thinking-verb'); const observer = new MutationObserver(() => changes++); observer.observe(node, { childList: true, characterData: true, subtree: true }); setTimeout(() => { observer.disconnect(); resolve(changes); }, 2800); }));
      const problems = [];
      if (home.animation !== 'none') problems.push('home starter still stages a decorative entrance');
      if (hover.travels) problems.push('home starter still travels on hover');
      if (!press.active || press.outline === 'none' || press.width < 1) problems.push('press has no immediate visible acknowledgement');
      if (words.some(word => word !== 'Working') || textChanges > 0 || loops.length) problems.push('status still runs a decorative loop');
      if (pageErrors.length) throw new Error(pageErrors.join('\n'));
      report.push({ zoom, home, hover, press, words, loops, textChanges, problems });
    } finally { await browser.close(); }
  }
} catch(error) { invalid = error.stack ?? String(error); } finally { server.close(); }
writeFileSync(process.argv.find(arg => arg.startsWith('--json='))?.slice(7) ?? '/tmp/bimax-quiet.json', JSON.stringify({ report, invalid }, null, 2));
console.log(JSON.stringify({ report, invalid }, null, 2)); process.exit(invalid ? 2 : report.some(row => row.problems.length) ? 1 : 0);
