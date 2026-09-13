#!/usr/bin/env node
/** Actual Electron main -> staged binary -> loopback provider -> preload -> renderer proof.
 * Isolated Electron profile, engine config and git fixture. Uses no installed app or user project. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createRequire } from 'node:module';
const electronBinary = createRequire(import.meta.url)('electron');
import assert from 'node:assert/strict';
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repo = path.dirname(appDir);
const run = path.join(repo, 'docs/product-reset/evidence/capability-failures', `electron-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(run, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-electron-fault-'));
const project = path.join(temp, 'project'); const configDir = path.join(temp, 'config');
fs.mkdirSync(project); fs.mkdirSync(configDir);
execFileSync('git', ['init', '--quiet', project]);
fs.writeFileSync(path.join(project, 'a.ts'), 'export function sentinelAlpha() { return "fixture"; }');
fs.writeFileSync(path.join(project, 'b.ts'), 'export function sentinelBeta() { return "sentinelAlpha related fixture"; }');
const config = path.join(configDir, 'config.json');
fs.writeFileSync(config, JSON.stringify({ provider: 'ollama', model: 'mock', liteModel: 'mock', onboardingComplete: true, autoIndex: false, autoResumeAgents: false, autoContinueOutcome: false }));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const result = { status: 'fail', boundary: 'Electron main + real preload + staged compiled engine + loopback provider',
  binarySha256: hash(path.join(appDir, 'engine/bimax-engine')), scriptSha256: hash(fileURLToPath(import.meta.url)),
  configBefore: hash(config), failureAt: null, visibleAt: null, reloadedWarning: false };
let child; let browser; let page;
const frames = [];
const start = performance.now();
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const data = raw ? JSON.parse(raw) : {};
  res.setHeader('content-type', 'application/json');
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
  if (req.url.endsWith('/embeddings')) {
    result.failureAt ??= performance.now() - start;
    console.log('Injected embedding HTTP 410'); res.statusCode = 410; return res.end('{}');
  }
  if (req.url.endsWith('/rerank')) return res.end(JSON.stringify({ results: (data.documents || []).map((_, index) => ({ index, relevance_score: 1 / (index + 1) })) }));
  if (req.url.endsWith('/chat/completions')) {
    const done = data.messages?.some(m => m.role === 'tool');
    const delta = done ? { content: 'Fixture search finished.' } : { tool_calls: [{ index: 0, id: 'search-fixture', type: 'function', function: { name: 'CodeSearchTool', arguments: '{"query":"sentinelAlpha"}' } }] };
    res.setHeader('content-type', 'text/event-stream');
    return res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/v1`;
const portServer = net.createServer(); await new Promise(r => portServer.listen(0, '127.0.0.1', r));
const port = portServer.address().port; await new Promise(r => portServer.close(r));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  BIMAX_CWD: project, BIMAX_BREAKGLASS_DIR: configDir, BIMAX_AUTO_INDEX: '0', BIMAX_MCP_BOOT_DELAY_MS: '3600000',
  BIMAX_AUTO_RESUME_AGENTS: '0', BIMAX_AUTO_CONTINUE_OUTCOME: '0', BIMAX_CODE_INDEX: '1', BIMAX_CODE_INDEX_REMOTE: '1',
  BIMAX_EMBED_BASE_URL: url, BIMAX_EMBED_MODEL: 'fixture', BIMAX_EMBED_DIM: '2', BIMAX_RERANK_URL: `${url}/rerank`,
  BGW_BASE_URL: url, BGW_PROVIDER: 'ollama', BGW_CAP_PLAIN_CONTENT: 'true', BIMAX_RECORDER: '0', BIMAX_MAX_ITERATIONS: '4' };
const log = fs.createWriteStream(path.join(run, 'electron.log'));
try {
  child = spawn(electronBinary, [appDir, `--user-data-dir=${path.join(temp, 'profile')}`, `--remote-debugging-port=${port}`], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }); break; }
    catch { await new Promise(r => setTimeout(r, 250)); }
  }
  assert(browser, 'Electron remote debugging did not become available');
  for (let i = 0; i < 300; i++) {
    const pages = await browser.pages(); result.pageURLs = pages.map(p => p.url());
    page = pages.find(p => !p.url().startsWith('devtools://'));
    if (page) break; await new Promise(r => setTimeout(r, 100));
  }
  assert(page, 'no actual app renderer');
  await page.waitForFunction(() => window.bimax?.supervisor, { timeout: 20000 });
  await page.exposeFunction('captureProofFrame', frame => { frames.push(frame); });
  await page.evaluate(() => window.bimax.onMessage(frame => window.captureProofFrame(frame)));
  await page.waitForFunction(async () => ['ready', 'degraded'].includes((await window.bimax.supervisor.getStatus())?.phase), { timeout: 30000 });
  result.supervisor = await page.evaluate(() => window.bimax.supervisor.getStatus());
  await page.waitForSelector('textarea[data-bimax-composer]', { visible: true });
  await page.type('textarea[data-bimax-composer]', 'Find sentinelAlpha with code search.');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-capability-id="embeddings"] summary')?.innerText.includes('degraded'), { timeout: 45000 });
  result.visibleAt = performance.now() - start;
  result.warning = await page.$eval('[aria-label="Capability problems"]', el => el.innerText);
  assert(result.failureAt !== null); assert.match(result.warning, /keywords only/);
  const box = await page.$eval('[data-capability-id="embeddings"] summary', el => {
    const r = el.getBoundingClientRect(); const p = el.closest('section').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, parentTop: p.top, parentBottom: p.bottom };
  });
  assert(box.top >= box.parentTop && box.bottom <= box.parentBottom, 'failure summary clipped below another warning');
  result.summaryBounds = box;
  console.log('Caught automatically in the actual Electron warning banner');
  await page.screenshot({ path: path.join(run, 'electron-failure.png') });
  await page.waitForFunction(() => document.body.innerText.includes('Fixture search finished.'), { timeout: 20000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('[data-capability-id="embeddings"] summary')?.innerText.includes('degraded'), { timeout: 10000 });
  result.reloadedWarning = true;
  await page.screenshot({ path: path.join(run, 'electron-reloaded.png') });
  result.configAfter = hash(config); assert.equal(result.configBefore, result.configAfter);
  result.status = 'pass';
} catch (error) {
  if (page) {
    result.lastVisibleText = await page.$eval('body', el => el.innerText).catch(() => 'unavailable');
    await page.screenshot({ path: path.join(run, 'failure-observation.png') }).catch(() => {});
  }
  result.error = String(error?.stack || error); process.exitCode = 1; }
finally {
  browser?.disconnect();
  if (child && child.exitCode === null) {
    const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(kill);
  }
  log.end(); server.closeAllConnections(); await new Promise(r => server.close(r));
  fs.writeFileSync(path.join(run, 'frames.ndjson'), frames.map(f => JSON.stringify(f)).join('\n'));
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  fs.rmSync(temp, { recursive: true, force: true });
  console.log(JSON.stringify({ ...result, artifact: path.join(run, 'result.json') }, null, 2));
}
