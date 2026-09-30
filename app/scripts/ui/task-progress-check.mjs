// UI fix list 23/33/44: visible local acknowledgement, persistent context, honest live checks.
import { writeFileSync } from 'node:fs';
import { serveRenderer, openRenderer, feed, feedEvent, settle, pressChord } from './harness.mjs';
import { baseFixture, uiSnapshot, userMessage, assistantMessage, codingToolCall, PROJECT } from './fixtures.mjs';
const { server, base } = await serveRenderer();
const report = [];
let invalid = null;
try {
  for (const zoom of [1, 1.2]) {
    const { browser, page, pageErrors } = await openRenderer({ base, fixture: baseFixture(), size: { width: Math.round(1180 / zoom), height: Math.round(800 / zoom) } });
    const problems = [];
    try {
      await page.evaluate(project => { const H = window.__bimaxHarness; H.callbacks.project.forEach(cb => cb(project)); H.callbacks.state.forEach(cb => cb('ready', '')); }, PROJECT);
      await feed(page, { t: 'ready', protocol: 3 }); await feedEvent(page, 'ui_snapshot', [uiSnapshot()]); await settle(page, 350);
      const inspect = () => page.evaluate(() => {
        const el = document.querySelector('[data-task-progress]');
        const box = el?.getBoundingClientRect();
        return { present: !!el, text: el?.textContent, state: el?.dataset.taskState, labels: [...(el?.querySelectorAll('dt') ?? [])].map(x => x.textContent), height: box?.height,
          visible: !!box && box.width > 10 && box.height > 10 && box.top >= 0 && box.bottom <= innerHeight };
      });
      const empty = await inspect();
      if (!empty.present) { report.push({ zoom, empty, problems: ['no persistent task context'] }); continue; }
      if (empty.labels.join('|') !== 'Goal|Step|Files|Next' || !empty.visible) problems.push('missing or hidden task chunk');
      await feedEvent(page, 'message', [userMessage('old', 'Previous goal')]);
      for (let i = 0; i < 30; i++) await feedEvent(page, 'message', [assistantMessage(`a${i}`, `History ${i}\n\n${'The prior task is complete. '.repeat(40)}`)]);
      await settle(page, 250);
      await page.evaluate(() => { const area = document.querySelector('[data-virtuoso-scroller]'); if (area) area.scrollTop = 0; });
      const scrolled = await inspect(); if (!scrolled.visible || scrolled.height !== empty.height) problems.push('task context scrolls away or changes geometry');
      const input = await page.$('[data-bimax-composer]'); await input.focus(); await page.keyboard.type('Fix the current fetch client');
      const sendMs = await page.evaluate(() => new Promise(resolve => {
        const started = performance.now();
        const timer = setTimeout(() => { observer.disconnect(); resolve(null); }, 500);
        const observer = new MutationObserver(() => {
          const el = document.querySelector('[data-task-progress]');
          if (el?.dataset.taskState !== 'pending') return;
          observer.disconnect(); clearTimeout(timer);
          requestAnimationFrame(() => resolve(performance.now() - started));
        }); observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
        document.querySelector('button[aria-label="Send message"]').click();
      }));
      if (sendMs === null || sendMs >= 100) problems.push(`send acknowledgement exceeded 100ms: ${sendMs}`);
      const at = Date.now();
      const review = { sessionId: 's', state: 'unverified', nextAction: '', approvals: [], changes: [{ file: 'src/retry.ts', tools: ['Edit'], edits: 1, lastAt: at }], verifications: [], checkpoints: [], lastCheckpoint: null, todos: [], interrupted: false, updatedAt: at };
      await feedEvent(page, 'review_update', [review]);
      await feedEvent(page, 'spinner_state', ['working', '']);
      await feedEvent(page, 'tool_call', [{ ...codingToolCall({ id: 'check', toolName: 'Bash', input: 'npm test', output: '' }), status: 'running', startTime: new Date(at).toISOString(), endTime: undefined }]);
      await settle(page, 100);
      const checking = await inspect(); if (checking.state !== 'checking' || !checking.text.includes('npm test')) problems.push('actual check never appears as reviewing changes');
      const stopMs = await page.evaluate(() => new Promise(resolve => {
        const started = performance.now();
        const timer = setTimeout(() => { observer.disconnect(); resolve(null); }, 500);
        const observer = new MutationObserver(() => {
          if (document.querySelector('[data-task-progress]')?.dataset.taskState !== 'stopping') return;
          observer.disconnect(); clearTimeout(timer); requestAnimationFrame(() => resolve(performance.now() - started));
        }); observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        document.querySelector('button[aria-label="Stop current task"]').click();
      }));
      if (stopMs === null || stopMs >= 100) problems.push(`Stop acknowledgement exceeded 100ms: ${stopMs}`);
      await feedEvent(page, 'tool_call_result', [{ ...codingToolCall({ id: 'check', toolName: 'Bash', input: 'npm test', output: 'stopped' }), status: 'error' }]);
      await feedEvent(page, 'review_update', [{ ...review, interrupted: true }]);
      await feedEvent(page, 'spinner_state', ['idle', '']); await settle(page, 100);
      const stopped = await inspect(); if (stopped.step === 'Checking changes' || stopped.state === 'checking' || !stopped.text.includes('Stopped')) problems.push('review beat lingers after actual work ends');
      await pressChord(page, 'k'); await page.keyboard.type('Expand or restore'); await page.keyboard.press('Enter'); await settle(page, 450);
      const expanded = await inspect(); if (!expanded.visible) problems.push('enlarged editor hides task context');
      await page.screenshot({ path: `/tmp/bimax-task-progress-${zoom}.png` });
      if (pageErrors.length) throw new Error(pageErrors.join('\n'));
      report.push({ zoom, empty, scrolled, sendMs, checking, stopMs, stopped, expanded, problems });
    } finally { await browser.close(); }
  }
} catch (error) { invalid = error.stack ?? String(error); }
finally { server.close(); }
const result = { report, invalid };
writeFileSync(process.argv.find(arg => arg.startsWith('--json='))?.slice(7) ?? '/tmp/bimax-task-progress.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(invalid ? 2 : report.some(row => row.problems.length) ? 1 : 0);
