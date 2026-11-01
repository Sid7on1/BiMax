import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../../../..');
const require = createRequire(path.join(root, 'app/package.json'));
const puppeteer = require('puppeteer-core');
const { ThreadStorage, THREAD_SNAPSHOT_MAX_BYTES } = require(path.join(root, 'app/src/main/thread.storage.ts'));
const { ThreadBinRecovery } = require(path.join(root, 'app/src/main/thread.bin.recovery.ts'));
const { recoveryExportAction } = require(path.join(root, 'app/src/main/thread.recovery.export.ts'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-recovery-browser-'));
const directory = path.join(scratch, 'threads'); fs.mkdirSync(directory);
const results = { scope: 'Actual ThreadsList and recovery components in headless Chromium, production storage/export action, inert native picker/IPC ports; not installed Electron or native visual qualification', cases: [], errors: [] };
let browser;
try {
  for (const folder of ['', 'archive', '.bin-recovery']) {
    fs.mkdirSync(path.join(directory, folder), { recursive: true });
    fs.writeFileSync(path.join(directory, folder, 'collision.json'), `retained ${folder || 'saved'} bytes 界`);
  }
  const large = path.join(directory, 'large.json'); fs.writeFileSync(large, 'retained large original'); fs.truncateSync(large, THREAD_SNAPSHOT_MAX_BYTES + 1);
  const store = new ThreadStorage(directory, { setTimeout: () => undefined });
  new ThreadBinRecovery(directory, { moveToBin: async () => null }, Date.now, id => store.noteRecoveryBackup(id));
  store.load(); await store.archived();
  let mode = 'success', release;
  const calls = [], exported = [];
  const act = recoveryExportAction(store, async () => {
    if (mode === 'cancel') return null;
    if (mode === 'refuse') return large;
    if (mode === 'hold') await new Promise(done => { release = done; });
    return path.join(scratch, `copy-${calls.length}.json`);
  });
  execFileSync('bun', ['build', path.join(here, 'recovery.browser.tsx'), '--production', '--target=browser', '--format=iife', '--outdir', scratch], { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(scratch, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="recovery.browser.js"></script>');
  browser = await puppeteer.launch({ executablePath: process.env.BIMAX_UI_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  page.on('pageerror', e => results.errors.push(e.message));
  await page.exposeFunction('auditEntries', () => store.recoverable());
  await page.exposeFunction('auditExport', async (id, archived, backup) => {
    calls.push({ id, archived, backup });
    const result = await act(id, archived, backup);
    if (result.ok) {
      const source = fs.readFileSync(store.recoveryFile(id, archived, backup)), copy = fs.readFileSync(path.join(scratch, `copy-${calls.length}.json`));
      assert.equal(createHash('sha256').update(source).digest('hex'), createHash('sha256').update(copy).digest('hex'));
      exported.push({ id, archived, backup, bytes: copy.length });
    }
    return result;
  });
  await page.goto(`file://${path.join(scratch, 'index.html')}`);
  await page.waitForFunction(() => document.body.textContent.includes('Too large to open safely'));
  const click = async label => {
    await page.evaluate(label => {
      const row = [...document.querySelectorAll('section[aria-label="Conversation recovery"] > div')].find(el => el.textContent.includes(label));
      if (!row) throw new Error(`Missing recovery row: ${label}`);
      row.querySelector('button').click();
    }, label);
  };
  const done = () => page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('exported'));
  for (const label of ['Saved conversation · large', 'Saved conversation · collision', 'Archived conversation · collision', 'Conversation recovery backup · collision']) {
    await click(label); await done();
  }
  assert.deepEqual(exported.map(({ id, archived, backup }) => ({ id, archived, backup })), [
    { id: 'large', archived: false, backup: false }, { id: 'collision', archived: false, backup: false },
    { id: 'collision', archived: true, backup: false }, { id: 'collision', archived: false, backup: true },
  ]);
  results.cases.push('saved/archive/Bin identities export exact independent source hashes; oversized bytes are streamed');
  mode = 'cancel'; const count = exported.length;
  await click('Saved conversation · collision');
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.disabled));
  assert.equal(exported.length, count);
  assert.equal(await page.evaluate(() => document.querySelector('[role="status"]')?.textContent || ''), '');
  results.cases.push('cancel exports nothing and shows no success');
  mode = 'refuse'; await click('Saved conversation · collision');
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('outside'));
  assert.equal(exported.length, count); results.cases.push('production export refusal remains visible with no successful export');
  mode = 'hold'; await click('Saved conversation · collision');
  await page.waitForFunction(() => document.body.textContent.includes('Exporting…'));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('section[aria-label="Conversation recovery"] button')].every(b => b.disabled)), true);
  release(); await done(); results.cases.push('pending native-picker port disables duplicate exports until completion');
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(directory, `extra-${i}.json`), 'retained unreadable bytes');
  store.load(); await page.evaluate(entries => window.auditPush(entries), store.recoverable());
  await page.waitForFunction(() => document.body.textContent.includes('Show more recovery copies'));
  const visible = () => page.evaluate(() => [...document.querySelectorAll('section[aria-label="Conversation recovery"] button')].filter(b => b.textContent.includes('Export recovery copy')).length);
  assert.equal(await visible(), 5);
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Show more recovery copies').click());
  await page.waitForFunction(() => [...document.querySelectorAll('button')].filter(b => b.textContent.includes('Export recovery copy')).length === 10);
  results.cases.push('recovery inventory pages five rows at a time in the actual sidebar');
  const overflow = { summary: { id: 'overflow', title: 'Overflow', root: '/fixture', updatedAt: 1, status: 'stopped', peers: [] }, state: { items: [], streaming: 'x'.repeat(THREAD_SNAPSHOT_MAX_BYTES) } };
  store.save(overflow); await store.flush();
  await page.evaluate(({ entries, error }) => window.auditPush(entries, error), { entries: store.recoverable(), error: store.lastError() });
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes('32 MiB'));
  store.save({ ...overflow, state: { items: [] } }); await store.flush();
  await page.evaluate(entries => window.auditPush(entries, null), store.recoverable());
  await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
  results.cases.push('actual coalesced save failure produces a persistent alert and clears only after successful saving');
  results.exports = exported; results.browser = await browser.version();
  assert.equal(results.errors.length, 0);
} catch (error) { results.invalid = error.stack || String(error); process.exitCode = 1; }
finally { await browser?.close(); fs.rmSync(scratch, { recursive: true, force: true }); fs.writeFileSync(path.join(here, 'browser.json'), JSON.stringify(results, null, 2) + '\n'); }
console.log(JSON.stringify(results, null, 2));
