import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromeExecutable } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const evidence = path.join(root, 'docs/product-reset/evidence/2026-10-06-chat-experience-sprint');
const scratch = mkdtempSync(path.join(tmpdir(), 'bimax-chat-renderer-'));
const receiptFile = process.argv.find(arg => arg.startsWith('--json='))?.slice(7) ?? path.join(evidence, 'renderer-fixed.json');
const baseline = process.argv.includes('--baseline');
let browser;
let report = { baseline, invalid: null, problems: [] };
try {
  const entry = path.join(evidence, 'renderer-probe.tsx');
  execFileSync('bun', ['build', entry, '--production', '--target=browser', '--format=iife', '--outfile', path.join(scratch, 'probe.js')], { cwd: root, stdio: 'pipe' });
  writeFileSync(path.join(scratch, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="probe.js"></script>');
  browser = await puppeteer.launch({ executablePath: chromeExecutable(), headless: true, args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  const errors = []; report.browserErrors = errors;
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`file://${path.join(scratch, 'index.html')}`);
  await page.waitForFunction(() => window.probe && document.querySelector('#markdown code'));
  report = { ...report, ...await page.evaluate(async () => {
    const p = window.probe;
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const initial = { ...p.metrics };
    const originalHtml = document.querySelector('#markdown').innerHTML;
    const codeBefore = document.querySelector('#standalone code').innerHTML;
    for (let i = 0; i < 20; i++) p.renderSame();
    const afterSame = { ...p.metrics };
    const preservedHtml = document.querySelector('#markdown').innerHTML === originalHtml;
    const copyBefore = { ...p.metrics };
    document.querySelector('#standalone button[title="Copy code"]').click();
    await frame();
    const afterCopy = { ...p.metrics };
    const copiedExactly = p.clipboard.at(-1) === '<img src=x onerror=alert(1)>\nconst safe = true;';
    const safeHtml = !document.querySelector('#standalone img') && document.querySelector('#standalone code').innerHTML === codeBefore;
    document.querySelector('#markdown button.md-path').click(); const firstLink = window.lastLink;
    p.changeLink(); document.querySelector('#markdown button.md-path').click();
    const freshContext = firstLink === 0 && window.lastLink === 1;
    p.changeText(); const afterChange = { ...p.metrics };
    const changedVisible = document.querySelector('#markdown strong').textContent === 'chat';
    p.changeCode(); const changedCodeVisible = document.querySelector('#standalone code').textContent === 'function changed() { return "fresh chat"; }';
    p.changeLang(); const langVisible = document.querySelector('#standalone code').textContent === 'function changed() { return "fresh chat"; }'
      && !document.querySelector('#standalone code [class^="hljs-"]');

    window.selectChat('A'); await frame();
    const config = p.engine().configGet(); const catalog = p.engine().catalogGet(); const attachment = p.engine().ingestAttachment('/fixture/report.txt');
    const attachmentDone = { done: false }; void attachment.then(() => { attachmentDone.done = true; });
    const oneSubscription = p.listeners() === 1;
    window.selectChat('B'); await frame();
    const attachmentRetired = attachmentDone.done;
    if (attachmentRetired) await Promise.all([config, catalog, attachment]);
    const selected = document.querySelector('#thread').textContent;
    p.emit('messages', { t: 'request', id: 1, kind: 'prompt', approvalToken: 'old' }, 'B'); await frame();
    p.engine().reply(1, 'Yes');
    window.selectChat('C');
    p.emit('messages', { t: 'request', id: 2, kind: 'prompt', approvalToken: 'new' }, 'C');
    await frame(); p.replyDone(true); await frame();
    const currentApproval = document.querySelector('#approval').textContent;
    const draftPreserved = document.querySelector('#composer').value === 'kept draft';
    return { initial, afterSame, copyBefore, afterCopy, afterChange, preservedHtml, copiedExactly, safeHtml, freshContext, changedVisible,
      changedCodeVisible, langVisible, oneSubscription, attachmentRetired, selected, currentApproval, draftPreserved };
  }) };
  if (errors.length) throw new Error(errors.join('\n'));
  for (const name of ['preservedHtml', 'copiedExactly', 'safeHtml', 'freshContext', 'changedVisible', 'changedCodeVisible', 'langVisible', 'draftPreserved']) assert.equal(report[name], true, name);
  if (!baseline) {
    if (report.afterSame.lex !== report.initial.lex) report.problems.push('unchanged history reparsed');
    if (report.afterSame.highlight !== report.initial.highlight) report.problems.push('unchanged code rehighlighted');
    if (report.afterCopy.highlight !== report.copyBefore.highlight) report.problems.push('Copy rehighlighted unchanged code');
    if (!report.oneSubscription) report.problems.push('attachment added an owner listener');
    if (!report.attachmentRetired) report.problems.push('switched attachment remained pending');
    if (report.selected !== 'B' || report.currentApproval !== '2') report.problems.push('stale acknowledgement changed selected chat/card');
  }
  report.fixtureHash = createHash('sha256').update(readFileSync(entry)).digest('hex');
} catch (error) {
  if (error.code === 'ERR_ASSERTION') report.problems.push(error.message);
  else report.invalid = error.stack ?? String(error);
}
finally {
  await browser?.close(); rmSync(scratch, { recursive: true, force: true });
  writeFileSync(receiptFile, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
process.exitCode = report.invalid ? 2 : report.problems.length ? 1 : 0;
