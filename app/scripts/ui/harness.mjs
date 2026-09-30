// Phase 5 renderer journey harness.
//
// Serves the built renderer over 127.0.0.1 (file:// blanks on crossorigin module CORS), installs a
// scriptable stand-in for the preload bridge, and hands the journey back a controller that can feed
// protocol frames and read the resulting DOM.
//
// The stand-in is deliberately a MIRROR of the real preload surface, not a simplification: every
// method the renderer can call exists here, and `bridgeCalls` records what the renderer asked for.
// That is what lets a journey grade an END STATE ("the app told main to pause, and the UI now shows
// the user in control") instead of "a click happened".
import puppeteer from 'puppeteer';
import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { APP_DIR, RENDERER_ROOT, WINDOW_SIZES, serveRenderer, installBridge } from './renderer.mjs';

export { APP_DIR, RENDERER_ROOT, WINDOW_SIZES, serveRenderer };

export function chromeExecutable() {
  const candidate = process.env.BIMAX_UI_CHROME || puppeteer.executablePath();
  if (!candidate || !existsSync(candidate)) {
    throw new Error(
      'Puppeteer managed Chromium is missing. Run the repository dependency install, or set '
      + 'BIMAX_UI_CHROME explicitly for this test process.',
    );
  }
  return candidate;
}

export async function openRenderer({ base, fixture, size = WINDOW_SIZES[1] }) {
  const browser = await puppeteer.launch({
    executablePath: chromeExecutable(),
    headless: 'new',
    args: ['--no-sandbox', '--hide-scrollbars', '--force-prefers-reduced-motion', '--allow-file-access-from-files'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 2 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // The packaged app serves its own icon; this static harness does not, and a missing favicon is
    // not a renderer defect. Chrome reports it without the URL in the message body, so the origin
    // has to be read from the console location.
    const url = message.location?.().url || '';
    if (url.endsWith('/favicon.ico') || text.includes('favicon.ico')) return;
    pageErrors.push(`console: ${text}${url ? ` (${url})` : ''}`);
  });
  // The packaged app serves its own icon; this static harness does not, and a missing favicon is
  // not a renderer defect. Every other failed request still counts.
  page.on('requestfailed', (request) => pageErrors.push(`request failed: ${request.url()}`));
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      pageErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  await page.evaluateOnNewDocument(installBridge, fixture);
  await page.goto(base.startsWith('file:') ? base : `${base}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  return { browser, page, pageErrors };
}

// --- page-side helpers ------------------------------------------------------------------------

export const feed = (page, frame) =>
  page.evaluate((f) => window.__bimaxHarness.callbacks.msg.forEach((cb) => cb(f)), frame);

export const feedEvent = (page, name, args) => feed(page, { t: 'event', name, args });

export const setProject = (page, dir) =>
  page.evaluate((d) => window.__bimaxHarness.callbacks.project.forEach((cb) => cb(d)), dir);

export const setSupervisor = (page, status) =>
  page.evaluate((s) => {
    window.__bimaxHarness.fixture.supervisor = s;
    window.__bimaxHarness.callbacks.supervisor.forEach((cb) => cb(s));
  }, status);

export const setEngineState = (page, state, detail) =>
  page.evaluate(({ s, d }) => window.__bimaxHarness.callbacks.state.forEach((cb) => cb(s, d)), { s: state, d: detail });

export const bridgeCalls = (page) => page.evaluate(() => window.__bimaxHarness.calls);

export const settle = (page, ms = 220) => page.evaluate((wait) => new Promise((r) => setTimeout(r, wait)), ms);

/** Visible text of the whole shell — the thing a user could actually read. */
export const visibleText = (page) => page.evaluate(() => document.body.innerText);

/**
 * Type into the task composer specifically.
 *
 * `document.querySelector('textarea')` is not good enough: xterm keeps its own offscreen helper
 * textarea, so a bare selector can silently type into the terminal. The composer carries a stable
 * data attribute and an aria-label for exactly this reason.
 */
export async function typeInComposer(page, text) {
  const focused = await page.evaluate(() => {
    const composer = document.querySelector('textarea[data-bimax-composer]');
    if (!composer) return false;
    composer.focus();
    return document.activeElement === composer;
  });
  if (!focused) throw new Error('composer textarea not present or not focusable');
  await page.keyboard.type(text);
  await settle(page, 120);
}

export async function clickByText(page, text, { exact = false } = {}) {
  const clicked = await page.evaluate(({ wanted, isExact }) => {
    const candidates = [...document.querySelectorAll('button, [role="tab"], a')];
    const match = candidates.find((node) => {
      const label = (node.textContent || '').trim();
      const title = node.getAttribute('title') || '';
      const aria = node.getAttribute('aria-label') || '';
      return isExact
        ? label === wanted || title === wanted || aria === wanted
        : label.includes(wanted) || title.includes(wanted) || aria.includes(wanted);
    });
    if (!match) return false;
    match.click();
    return true;
  }, { wanted: text, isExact: exact });
  if (!clicked) throw new Error(`no clickable element matching "${text}"`);
  await settle(page);
}

export async function pressChord(page, key, modifiers = ['Meta']) {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
  await settle(page);
}

export function shot(page, dir, name) {
  mkdirSync(dir, { recursive: true });
  return page.screenshot({ path: path.join(dir, `${name}.png`) });
}

/**
 * Every enabled control must be nameable by a screen reader, and every tab must be reachable by
 * keyboard. Returns findings rather than throwing so the journey report can list them.
 */
export async function accessibilityFindings(page) {
  return page.evaluate(() => {
    const findings = [];
    for (const button of document.querySelectorAll('button:not([disabled])')) {
      const name = (button.textContent || '').trim() || button.title || button.getAttribute('aria-label');
      if (!name) findings.push(`unnamed control: ${button.outerHTML.slice(0, 160)}`);
    }
    for (const image of document.querySelectorAll('img')) {
      if (!image.getAttribute('alt')) findings.push(`image without alt text: ${image.src.slice(0, 120)}`);
    }
    for (const tab of document.querySelectorAll('[role="tab"]')) {
      if (tab.getAttribute('aria-selected') === null) findings.push(`tab without aria-selected: ${(tab.textContent || '').trim()}`);
      if (tab.tabIndex < 0) findings.push(`tab not keyboard reachable: ${(tab.textContent || '').trim()}`);
    }
    for (const list of document.querySelectorAll('[role="tablist"]')) {
      if (!list.getAttribute('aria-label')) findings.push('tablist without an accessible name');
    }
    return findings;
  });
}

/** Nothing may scroll the page body horizontally at any supported width. */
export const horizontalOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
