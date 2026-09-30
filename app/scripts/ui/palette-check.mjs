// Grade the built palette by keyboard end state, at both owner zooms. Exit 2 is INVALID.
import { writeFileSync } from 'node:fs';
import { serveRenderer, openRenderer, feed, feedEvent, settle, pressChord, clickByText, bridgeCalls } from './harness.mjs';
import { baseFixture, uiSnapshot, PROJECT } from './fixtures.mjs';
const report = [];
const { server, base } = await serveRenderer();
let invalid = null;
let failure = false;
try {
  for (const zoom of [1, 1.2]) {
    const { browser, page, pageErrors } = await openRenderer({ base, fixture: baseFixture(), size: { width: Math.round(1180 / zoom), height: Math.round(800 / zoom) } });
    try {
      await page.evaluate((project) => { window.__bimaxHarness.callbacks.project.forEach(cb => cb(project)); window.__bimaxHarness.callbacks.state.forEach(cb => cb('ready', '')); }, PROJECT);
      await feed(page, { t: 'ready', protocol: 3 });
      await feedEvent(page, 'ui_snapshot', [uiSnapshot()]);
      await settle(page, 500);
      await pressChord(page, 'k');
      await page.waitForSelector('[role="dialog"] input');
      const count = await page.$$eval('[role="dialog"] button', els => els.length);
      for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
      await settle(page, 100);
      const selection = await page.evaluate(() => {
        const row = document.querySelector('[role="dialog"] [aria-selected="true"], [role="dialog"] button.bg-selected');
        const list = row?.parentElement;
        const r = row?.getBoundingClientRect(), l = list?.getBoundingClientRect();
        return { text: row?.textContent, visible: !!r && r.top >= l.top - 1 && r.bottom <= l.bottom + 1, scrollTop: list?.scrollTop };
      });
      const problems = [];
      if (count < 20 || count > 30) problems.push(`only ${count} commands`);
      if (!selection.visible) problems.push('keyboard selection outside visible list');
      // Filtering to no results, then pressing an arrow, must never let Enter run a hidden row.
      const input = await page.$('[role="dialog"] input');
      await input.click(); await page.keyboard.type('qzx-no-command');
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      if (!await page.$('[role="dialog"] input')) problems.push('empty search executed a hidden command');
      await page.$eval('[role="dialog"] input', el => el.select()); await page.keyboard.press('Backspace');
      await page.keyboard.type('Find and replace'); await settle(page, 60); await page.keyboard.press('Enter');
      if (!await page.$('[role="dialog"] input')) problems.push('unavailable file command closed the palette');
      await page.$eval('[role="dialog"] input', el => el.select()); await page.keyboard.press('Backspace');
      await page.keyboard.type('Starlight'); await settle(page, 60); const search = await page.evaluate(() => ({ query: document.querySelector('[role="dialog"] input')?.value, selected: document.querySelector('[role="dialog"] [aria-selected="true"]')?.id })); await page.keyboard.press('Enter'); await settle(page, 350);
      if (!await page.evaluate(() => document.documentElement.classList.contains('theme-starlight'))) problems.push('Starlight command did not apply appearance');
      await pressChord(page, 'k');
      await page.keyboard.type('Write to Bimax'); await page.keyboard.press('Enter'); await settle(page, 400);
      if (!await page.evaluate(() => document.activeElement?.matches('[data-bimax-composer]'))) problems.push('write command did not focus the composer');
      await pressChord(page, 'k');
      await page.keyboard.type('floating bar'); await page.keyboard.press('Enter'); await settle(page, 300);
      if (!(await bridgeCalls(page)).some(call => call.name === 'threads.quickOpen')) problems.push('floating bar never reached main');
      if (pageErrors.length) throw new Error(pageErrors.join('\n'));
      report.push({ zoom, count, selection, search, problems });
      failure ||= problems.length > 0;
    } finally { await browser.close(); }
  }
} catch (e) { invalid = e.stack ?? String(e); }
finally { server.close(); }
writeFileSync(process.argv.find(arg => arg.startsWith('--json='))?.slice(7) ?? '/tmp/bimax-palette.json', JSON.stringify({ report, invalid }, null, 2));
console.log(JSON.stringify({ report, invalid }, null, 2));
process.exit(invalid ? 2 : failure ? 1 : 0);
