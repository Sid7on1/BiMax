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
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RENDERER_ROOT = path.join(APP_DIR, 'out/renderer');

/** Window sizes this product supports: the packaging minimum, the shipped default, and a large Mac. */
export const WINDOW_SIZES = [
  { name: 'minimum', width: 720, height: 480 },
  { name: 'default', width: 1180, height: 800 },
  { name: 'large', width: 1680, height: 1050 },
];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

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

export async function serveRenderer() {
  const indexPath = path.join(RENDERER_ROOT, 'index.html');
  if (!existsSync(indexPath)) {
    throw new Error(`renderer build missing at ${RENDERER_ROOT} — run "npm run build" in app/ first`);
  }
  const server = createServer((request, response) => {
    const file = path.join(RENDERER_ROOT, request.url === '/' ? 'index.html' : request.url.split('?')[0]);
    try {
      response.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      response.end(readFileSync(file));
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  } catch (error) {
    // Managed CI/sandbox environments may prohibit even loopback binds. Chromium can still load
    // the production bundle directly when file access is explicitly enabled, so preserve the
    // exact journey and mutation grader instead of silently skipping visual verification.
    if (!['EACCES', 'EPERM'].includes(error?.code)) throw error;
    return { server: { close() {} }, base: pathToFileURL(indexPath).href };
  }
}

/**
 * Install the bridge stand-in. `fixture` is plain data so a journey can hand the SAME renderer a
 * different world (permissions denied, evidence stale, engine crashed) without new code paths.
 */
function installBridge(fixture) {
  window.__bimaxHarness = {
    callbacks: { msg: [], state: [], project: [], supervisor: [], pty: [], takeover: [], files: [], adaptive: [], windowChrome: [] },
    calls: [],
    fixture,
  };
  const H = window.__bimaxHarness;
  const record = (name, payload) => H.calls.push({ name, payload, at: Date.now() });

  window.bimax = {
    send: (message) => {
      record('send', message);
      if (message?.t === 'query') {
        setTimeout(() => H.callbacks.msg.forEach((cb) => cb({ t: 'queryResult', id: message.id, items: [] })), 20);
      }
      if (message?.t === 'configGet' || message?.t === 'configSet') {
        if (message.t === 'configSet') Object.assign(H.fixture.config, message.patch || {});
        setTimeout(() => H.callbacks.msg.forEach((cb) => cb({ t: 'configResult', id: message.id, config: H.fixture.config })), 20);
      }
      if (message?.t === 'catalogGet' || message?.t === 'providerSet') {
        if (message.t === 'providerSet') {
          H.fixture.catalog.providers = H.fixture.catalog.providers.map((provider) => ({
            ...provider,
            active: provider.name === message.name,
            hasKey: provider.name === message.name && message.apiKey ? true : provider.hasKey,
          }));
        }
        setTimeout(() => H.callbacks.msg.forEach((cb) => cb({
          t: 'catalogResult', id: message.id,
          providers: H.fixture.catalog.providers, models: H.fixture.catalog.models,
          error: H.fixture.catalog.error,
        })), 20);
      }
    },
    onMessage: (cb) => { H.callbacks.msg.push(cb); return () => {}; },
    onEngineState: (cb) => { H.callbacks.state.push(cb); return () => {}; },
    onProject: (cb) => { H.callbacks.project.push(cb); return () => {}; },
    supervisor: {
      onStatus: (cb) => { H.callbacks.supervisor.push(cb); return () => {}; },
      getStatus: async () => H.fixture.supervisor,
      action: async (action) => { record('supervisor.action', action); return true; },
      crashHistory: async () => H.fixture.crashHistory,
      diagnostics: async () => 'bimax diagnostics',
    },
    setAppearance: (appearance) => record('setAppearance', appearance),
    pickFolder: async () => { record('pickFolder'); return null; },
    pickFiles: async () => [],
    restartEngine: async () => { record('restartEngine'); return ''; },
    providers: {
      credentialStatus: async () => H.fixture.catalog.providers.map((provider) => ({
        name: provider.name,
        hasKey: provider.hasKey,
        keyHint: provider.keyHint,
        storage: provider.hasKey ? 'keychain' : 'none',
        active: provider.active,
      })),
      configure: async (input) => {
        record('providers.configure', { ...input, ...(input.apiKey ? { apiKey: '[REDACTED]' } : {}) });
        H.fixture.catalog.providers = H.fixture.catalog.providers.map((provider) => ({
          ...provider,
          active: provider.name === input.name,
          hasKey: provider.name === input.name && input.apiKey ? true : provider.hasKey,
        }));
        return { ok: true };
      },
    },
    getProject: async () => H.fixture.project,
    recentProjects: async () => H.fixture.recentProjects,
    openProject: async (dir) => { H.callbacks.project.forEach((cb) => cb(dir)); return dir; },
    rendererReady: () => record('rendererReady'),
    // Bimax Threads. The harness drives one renderer with no main process, so there is never a thread list,
    // a Finder context or a pending approval; calls are recorded so a journey can assert what was asked.
    threads: {
      list: async () => ({ activeId: null, threads: [], shortcutAvailable: true }),
      onList: () => () => {},
      onSelected: () => () => {},
      create: async () => { record('threads.create'); return null; },
      select: async (id) => { record('threads.select', id); return false; },
      start: async (id) => { record('threads.start', id); return false; },
      stop: async (id) => { record('threads.stop', id); return false; },
      link: async (a, b, enabled) => { record('threads.link', { a, b, enabled }); return false; },
      context: async () => ({ root: null, source: 'Choose a folder' }),
      onContext: () => () => {},
      pickFolder: async () => null,
      quickSubmit: async (prompt) => { record('threads.quickSubmit', prompt); return { ok: false, error: 'No main process in the harness' }; },
      hide: () => record('threads.hide'),
      approvals: async () => [],
      onApprovals: () => () => {},
      reply: async (id, requestId, value) => { record('threads.reply', { id, requestId, value }); return false; },
      quickCurrent: async () => null,
      onQuickThread: () => () => {},
      onQuickMsg: () => () => {},
      quickReset: () => record('threads.quickReset'),
      quickInterrupt: () => record('threads.quickInterrupt'),
      quickResize: () => {},
      quickOpen: () => record('threads.quickOpen'),
      undoInfo: async () => null,
      undo: async (id) => { record('threads.undo', id); return { ok: false, error: 'No main process in the harness' }; },
      pathForFile: () => '',
      openPath: async (raw, mode) => { record('threads.openPath', { raw, mode }); return { ok: false, error: 'No main process in the harness' }; },
      quickSwitch: async (direction) => { record('threads.quickSwitch', direction); return null; },
    },
    windowChrome: {
      get: async () => ({ fullScreen: false, maximized: false }),
      onState: (cb) => { H.callbacks.windowChrome.push(cb); return () => {}; },
    },
    phase9: {
      adaptiveState: async () => ({
        signals: {
          observedAt: Date.now(), architecture: 'arm64', cpuCount: 8, availableMemoryMb: 12_288,
          thermal: 'nominal', memoryPressure: 'normal', powerSource: 'ac', lowPowerMode: null,
          network: 'unknown', activeInteraction: false, reduceMotion: true,
          simulatorReservationMb: 0, localModelReservationMb: 0,
        },
        decision: {
          decisionClass: 'background-concurrency', policyVersion: 'bimax-adaptive/1', snapshotHash: 'sha256:fixture',
          previous: 2, selected: 2, automatic: true, changed: false, reasons: ['Fixture is inside the bounded baseline.'],
          thresholds: { minimumResidenceMs: 30000, interactionCooldownMs: 2000, minimumHeadroomMb: 1536 },
          expiresAt: Date.now() + 60000,
        },
        rendering: { mode: 'reduced-motion', preferredFps: 30, nonessentialAnimation: false, automatic: true, reasons: ['Reduce Motion is enabled.'] },
      }),
      processProvenance: async () => [],
      environment: async () => ({
        generatedAt: new Date().toISOString(), projectName: 'bimax-fixture',
        declarations: [{ file: 'package.json', ecosystem: 'Node' }],
        tools: [
          { id: 'node', label: 'Node.js', category: 'runtime', state: 'ready', version: '22.5.0', executable: '/usr/local/bin/node', note: 'fixture' },
          { id: 'npm', label: 'npm', category: 'package-manager', state: 'ready', version: '10.8.0', executable: '/usr/local/bin/npm', note: 'fixture' },
          { id: 'mlx', label: 'MLX', category: 'ml', state: 'missing', version: null, executable: null, note: 'fixture' },
        ],
        safety: { mutating: false, sourcedShellProfiles: false, executedProjectScripts: false },
      }),
      alchemistStatus: async () => ({
        generatedAt: new Date().toISOString(), state: 'partial',
        backends: [
          { id: 'mlx', label: 'MLX', role: 'Apple-silicon research', state: 'missing', version: null },
          { id: 'coremltools', label: 'Core ML Tools', role: 'Conversion and deployment', state: 'missing', version: null },
          { id: 'llama.cpp', label: 'llama.cpp', role: 'GGUF inference', state: 'ready', version: '1.0.0' },
          { id: 'ollama', label: 'Ollama', role: 'Local serving', state: 'missing', version: null },
        ],
        workflows: [
          { id: 'inspect', label: 'Inspect architecture', available: true, detail: 'Read compatibility before loading.' },
          { id: 'quantize', label: 'Quantize & compress', available: true, detail: 'Compare candidates to baseline.' },
          { id: 'fine-tune', label: 'LoRA / QLoRA experiment', available: false, detail: 'Requires MLX.' },
          { id: 'compare', label: 'Compare candidates', available: true, detail: 'Quality, latency and memory.' },
          { id: 'export', label: 'Verify & export', available: true, detail: 'Export verified artifacts.' },
        ],
        boundary: 'Fixture isolation boundary.',
      }),
      reportInteraction: (active, reduceMotion) => record('phase9.interaction', { active, reduceMotion }),
      onAdaptiveChanged: (cb) => { H.callbacks.adaptive.push(cb); return () => {}; },
    },
    git: {
      status: async () => H.fixture.git.status,
      diff: async () => H.fixture.git.diff,
      branches: async () => ({ current: H.fixture.git.status?.branch ?? '', all: [] }),
      log: async () => [],
    },
    files: {
      list: async (rel) => H.fixture.files[rel] ?? [],
      read: async () => ({ content: H.fixture.fileContent, truncated: false, size: 42, binary: false }),
      reveal: async () => {},
      write: async () => {},
      onChanged: (cb) => { H.callbacks.files.push(cb); return () => {}; },
    },
    sessionsMeta: async () => H.fixture.sessionsMeta,
    trustReport: async () => H.fixture.trustReport,
    manualAlpha: {
      status: async () => H.fixture.manualAlphaStatus,
      approve: async (codeDirectoryHash) => {
        record('manualAlpha.approve', codeDirectoryHash);
        if (codeDirectoryHash !== H.fixture.manualAlphaStatus?.codeDirectoryHash) return H.fixture.manualAlphaStatus;
        H.fixture.manualAlphaStatus = {
          ...H.fixture.manualAlphaStatus,
          state: 'approved-ad-hoc', ready: true, canApprove: false, approvedAt: new Date().toISOString(),
          detail: 'This exact local Computer Use service build is approved on this Mac.',
        };
        return H.fixture.manualAlphaStatus;
      },
      revoke: async () => {
        record('manualAlpha.revoke');
        H.fixture.manualAlphaStatus = {
          ...H.fixture.manualAlphaStatus,
          state: 'approval-required', ready: false, canApprove: true, approvedAt: undefined,
          detail: 'This local Computer Use service build needs exact-hash approval.',
        };
        return H.fixture.manualAlphaStatus;
      },
    },
    evidence: {
      timeline: async () => null,
      retentionControls: async () => [],
      remove: async (scope, taskIntentId) => { record('evidence.remove', { scope, taskIntentId }); return 0; },
    },
    exportDiagnostics: async () => { record('exportDiagnostics'); return 'saved'; },
    permissionCoach: {
      start: async (which) => { record('permissionCoach.start', which); return true; },
      startService: async (which) => { record('permissionCoach.startService', which); return false; },
      stop: async () => { record('permissionCoach.stop'); return true; },
      setInteractive: () => {},
      dragBundle: () => {},
      bundlePath: async () => '/Applications/Bimax.app',
      probe: async () => ({
        readings: {
          accessibility: H.fixture.trustReport?.permissions?.accessibility ?? 'unavailable',
          screenRecording: H.fixture.trustReport?.permissions?.screenRecording ?? 'unavailable',
          fullDisk: 'not-determined',
          microphone: 'not-determined',
        },
        responsibleBundle: '/Applications/Bimax.app',
        responsibleName: 'Bimax',
        isDevHost: false,
      }),
      relaunch: async () => true,
    },
    openPermissionSettings: async (which) => { record('openPermissionSettings', which); return true; },
    takeover: {
      get: async () => H.fixture.takeover,
      // Main owns the latch; the stand-in behaves like main does — it applies the change and then
      // pushes the authoritative state back, so the renderer can never be seen flipping optimistically.
      set: async (request) => {
        record('takeover.set', request);
        if (request.paused !== H.fixture.takeover.paused) {
          H.fixture.takeover = {
            paused: request.paused,
            generation: H.fixture.takeover.generation + 1,
            reason: request.paused ? (request.reason || 'You took control') : '',
            actor: 'user',
            changedAtMs: Date.now(),
          };
        }
        H.callbacks.takeover.forEach((cb) => cb(H.fixture.takeover));
        return H.fixture.takeover;
      },
      onState: (cb) => { H.callbacks.takeover.push(cb); return () => {}; },
    },
    pty: {
      create: async () => {
        setTimeout(() => H.callbacks.pty.forEach((cb) => cb(1, 'dev@mac bimax % npm test\r\n\r\n  ✓ 605 tests passing\r\n\r\ndev@mac bimax % ')), 60);
        return 1;
      },
      input: () => {},
      resize: () => {},
      kill: () => {},
      onData: (cb) => { H.callbacks.pty.push(cb); return () => {}; },
      onExit: () => () => {},
    },
  };
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
