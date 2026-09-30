// The renderer, served, and the stand-in for the preload bridge it talks to.
//
// Split out of harness.mjs (2026-09-30) so a runner that is not Puppeteer can use them: the morph
// regression check (morph-regression.mjs) drives the same built renderer with the same stand-in from
// an Electron window. Nothing here imports a browser driver.
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
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
export function installBridge(fixture) {
  window.__bimaxHarness = {
    callbacks: { msg: [], state: [], project: [], supervisor: [], pty: [], takeover: [], files: [], adaptive: [], windowChrome: [], menu: [], threadLists: [] },
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
    // The menu bar's commands (main/app.menu.ts). A runner fires one with `H.callbacks.menu.forEach(cb => cb(name))`,
    // which is exactly what a menu click does: the page runs the command its key runs.
    // A real unsubscribe, unlike the older listeners here: App re-subscribes whenever its command table changes, and a
    // stale second listener would run every toggle twice — measured: ⌘J opened and closed the panel in one command.
    onMenuCommand: (cb) => {
      H.callbacks.menu.push(cb);
      return () => { H.callbacks.menu = H.callbacks.menu.filter((other) => other !== cb); };
    },
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
      // A world may bring its own Bimax Threads (`fixture.threads`); by default there are none.
      list: async () => ({ activeId: H.fixture.threadsActive ?? null, threads: H.fixture.threads ?? [], shortcutAvailable: true }),
      onList: cb => { H.callbacks.threadLists.push(cb); return () => { H.callbacks.threadLists = H.callbacks.threadLists.filter(value => value !== cb); }; },
      onSelected: () => () => {},
      rename: async (id, title) => { record('threads.rename', {id,title}); return {ok:false,error:'No native storage in this harness'}; },
      search: async query => (H.fixture.threads ?? []).filter(t => `${t.title} ${t.root}`.toLowerCase().includes(query.toLowerCase())).map(t => t.id),
      archived: async () => [],
      archive: async id => { record('threads.archive',id); return {ok:false,error:'No native storage in this harness'}; },
      unarchive: async id => { record('threads.unarchive',id); return {ok:false,error:'No native storage in this harness'}; },
      moveToBin: async (id,archived) => { record('threads.moveToBin',{id,archived}); return {ok:false,error:'No native Bin in this harness'}; },
      undoBin: async id => { record('threads.undoBin',id); return {ok:false,error:'No native storage in this harness'}; },
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
      modelMenu: (mode) => record('threads.modelMenu', mode),
      moreMenu: () => record('threads.moreMenu'),
      onOpenRules: () => () => {},
      rulesGet: async () => null,
      rulesSet: async (rules) => { record('threads.rulesSet', rules); return { ok: false, error: 'No main process in the harness' }; },
      rulesPick: async () => [],
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
        // A world may replace any part of this — the morph check runs on a machine with motion ON.
        ...(H.fixture.adaptive ?? {}),
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
      search: async q => ({hits:Object.entries(H.fixture.files).flatMap(([parent,entries])=>entries.map(e=>({...e,rel:parent ? `${parent}/${e.name}` : e.name}))).filter(e=>e.rel.toLowerCase().includes(q.toLowerCase())),truncated:false}),
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
