// Visual smoke-test for the renderer without Electron: serve out/renderer over localhost
// (file:// blanks on crossorigin module CORS), stub the preload bridge, feed fake protocol
// events, drive the shell (dock tabs, ⌘K palette), and screenshot each state.
// Usage: node app/scripts/screenshot-ui.mjs → full suite
//        node app/scripts/screenshot-ui.mjs --quick → welcome + home only
import puppeteer from 'puppeteer';
import path from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(appDir, 'release');
mkdirSync(outDir, { recursive: true });

// This script writes to the desktop app's own output directory and nowhere else.
//
// The website publishes some of these same shots, but it is a separate product and keeps its own
// copies under site/public/media, which it updates on its own schedule. An earlier version of this
// script pushed into that directory directly — which made a website concern a step of the app
// build, so `npm run build` for the app could not succeed without the site checked out. The two
// builds are independent; if the site's copies go stale, that is the site's build to fix.

const root = path.join(appDir, 'out/renderer');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const p = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  try {
    res.setHeader('Content-Type', mime[path.extname(p)] || 'application/octet-stream');
    res.end(readFileSync(p));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// puppeteer 22+ returns a Promise from executablePath(), and 23 removed `headless: 'new'`.
// Passing the unawaited promise through produced "Browser was not found at the configured
// executablePath ([object Promise])" — a launch failure that reads like a missing install.
// Omitting executablePath entirely lets puppeteer resolve its own bundled browser, which is what
// this script always wanted; the env var stays as the explicit override.
const uiChrome = process.env.BIMAX_UI_CHROME;
const browser = await puppeteer.launch({
  ...(uiChrome ? { executablePath: uiChrome } : {}),
  headless: true,
  args: ['--no-sandbox', '--hide-scrollbars'],
});
const page = await browser.newPage();
// A render crash still produces a screenshot — of the error card. Without this, the suite looks
// like it passed and every shot silently becomes a picture of a caught exception.
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('[console.error]', m.text().slice(0, 300)); });
await page.setViewport({ width: 1440, height: 860, deviceScaleFactor: 2 });

await page.evaluateOnNewDocument(() => {
  window.__cbs = { msg: [], state: [], project: [], supervisor: [] };
  const FAKE_COMMANDS = [
    { value: '/beast', label: '/beast', desc: 'Mega-pipeline: swarm → heal → self-critic → checkpoint', kind: 'command' },
    { value: '/swarm', label: '/swarm', desc: 'Parallel sub-agents on a shared blackboard', kind: 'command' },
    { value: '/mode', label: '/mode', desc: 'Switch agent mode (general/explore/sketch/code/beast)', kind: 'command' },
    { value: '/model', label: '/model', desc: 'Pick model + tier; key-pool health', kind: 'command' },
    { value: '/index', label: '/index', desc: 'Build the AST codebase map', kind: 'command' },
    { value: '/ledger', label: '/ledger', desc: 'Hash-chained event ledger', kind: 'command' },
  ];
  const FAKE_CONFIG = {
    model: 'moonshotai/kimi-k3', liteModel: 'moonshotai/kimi-k3', fallbackModel: '', subagentModel: '',
    temperature: 1, topP: 0.95, maxTokens: 4096, reasoningEffort: 'low', contextMode: 'smart',
    contextWindowTokens: 1048576, parallelToolCalls: false, maxToolIterations: 50, maxSubAgents: 5,
    notificationBell: true, verbose: false, reducedMotion: false, autoIndex: true,
    gitAutoCommit: false, autoVerify: true, sandboxBash: false, selfCritic: true,
    adversarialVerify: false, diffApproval: true, blastGate: false, showMapPanel: true, showTokenMeter: true,
  };
  window.bimax = {
    send: (m) => {
      if (m && m.t === 'query') {
        setTimeout(() => {
          const q = (m.text || '').toLowerCase();
          const items = FAKE_COMMANDS.filter((c) => c.value.startsWith(q) || q === '/');
          window.__cbs.msg.forEach((cb) => cb({ t: 'queryResult', id: m.id, items }));
        }, 30);
      }
      if (m && m.t === 'configGet') {
        setTimeout(() => window.__cbs.msg.forEach((cb) => cb({ t: 'configResult', id: m.id, config: FAKE_CONFIG })), 30);
      }
      if (m && m.t === 'configSet') {
        Object.assign(FAKE_CONFIG, m.patch || {});
        setTimeout(() => window.__cbs.msg.forEach((cb) => cb({ t: 'configResult', id: m.id, config: FAKE_CONFIG })), 30);
      }
    },
    onMessage: (cb) => { window.__cbs.msg.push(cb); return () => {}; },
    onEngineState: (cb) => { window.__cbs.state.push(cb); return () => {}; },
    onProject: (cb) => { window.__cbs.project.push(cb); return () => {}; },
    pickFolder: async () => null,
    restartEngine: async () => '',
    // Start without a project so the visual smoke covers the project-first welcome. The script
    // switches to the fake Bimax project after that screenshot and continues the normal suite.
    getProject: async () => '',
    recentProjects: async () => [
      '/Users/dev/projects/bimax',
      '/Users/dev/projects/payments-service',
      '/Users/dev/projects/design-system',
    ],
    openProject: async (dir) => {
      window.__cbs.project.forEach((cb) => cb(dir));
      return dir;
    },
    rendererReady: () => {},
    setAppearance: () => {},
    // useWindowChrome subscribes on mount; without this the whole renderer throws
    // "Cannot read properties of undefined (reading 'onState')" and every screenshot below becomes
    // a picture of the error card.
    windowChrome: {
      get: async () => ({ fullScreen: false, zoomed: false }),
      onState: () => () => {},
    },
    supervisor: {
      getStatus: async () => ({
        phase: 'ready', enteredAt: Date.now(), attempt: 1, generation: 1,
        message: 'Engine ready', reason: 'ready', profile: 'full',
        capabilities: [], degradedCapabilities: [], lastHeartbeat: {
          at: Date.now(), uptimeMs: 42000, rssMb: 286, heapMb: 121,
          eventLoopDelayMs: 2, activeTurn: false,
        },
      }),
      onStatus: (cb) => { window.__cbs.supervisor.push(cb); return () => {}; },
      action: async () => true,
      crashHistory: async () => [],
      diagnostics: async () => 'Bimax engine diagnostics',
    },
    phase9: {
      adaptiveState: async () => null,
      processProvenance: async () => [],
      environment: async () => null,
      alchemistStatus: async () => null,
      reportInteraction: () => {},
      onAdaptiveChanged: () => () => {},
    },
    git: {
      status: async () => ({
        branch: 'feat/retry-backoff', ahead: 2, behind: 0,
        files: [
          { path: 'src/api/client.ts', status: 'M', staged: true, insertions: 14, deletions: 3 },
          { path: 'src/api/retry.ts', status: '?', staged: false, insertions: 0, deletions: 0 },
          { path: 'src/sync/pull.ts', status: 'M', staged: false, insertions: 6, deletions: 2 },
          { path: 'src/legacy/poll.ts', status: 'D', staged: true, insertions: 0, deletions: 41 },
        ],
      }),
      remote: async () => ({
        isRepo: true, branch: 'main', remoteUrl: 'https://github.com/example/bimax',
        remoteName: 'origin', slug: 'example/bimax', hasUpstream: true, upstream: 'origin/main',
        ahead: 2, behind: 0, dirty: 4, lastFetch: '',
      }),
      fetch: async () => ({ ok: true, output: 'Already up to date.' }),
      pull: async () => ({ ok: true, output: 'Already up to date.' }),
      push: async () => ({ ok: true, output: 'Everything up-to-date' }),
      diff: async () => [
        'diff --git a/src/api/client.ts b/src/api/client.ts',
        'index 3f1c2aa..9e4d7b1 100644',
        '--- a/src/api/client.ts',
        '+++ b/src/api/client.ts',
        '@@ -10,9 +10,11 @@ export class ApiClient {',
        '   async get(url: string): Promise<Response> {',
        '-    const res = await fetch(url);',
        '+    const res = await retry(3, () => fetch(url));',
        '     if (!res.ok) throw new ApiError(res);',
        '     return res;',
        '   }',
        '@@ -31,4 +33,12 @@ export class ApiClient {',
        '+  // exponential backoff: 250ms → 500ms → 1s',
        '+  private backoff(attempt: number): number {',
        '+    return 2 ** attempt * 250;',
        '+  }',
        ' }',
      ].join('\n'),
      branches: async () => ({ current: 'feat/retry-backoff', all: ['main', 'feat/retry-backoff', 'fix/pty-resize'] }),
      log: async () => [
        { hash: '3055c4f', subject: 'feat(tui): /keys pool health', when: '2 hours ago' },
        { hash: '4832d1f', subject: 'feat(core): capability-driven request shaping', when: '5 hours ago' },
        { hash: '3243d50', subject: 'feat(context): cache-tiered prompt architecture', when: 'yesterday' },
      ],
    },
    files: {
      // Deliberately unsorted and mixed: the panel is responsible for putting directories first,
      // so a stub that arrives pre-sorted would hide a regression in exactly that.
      search: async (q) => {
        const all = [
          { rel: 'src/api/client.ts', name: 'client.ts', dir: false },
          { rel: 'src/api/retry.ts', name: 'retry.ts', dir: false },
          { rel: 'src/protocol.ts', name: 'protocol.ts', dir: false },
          { rel: 'docs/README.md', name: 'README.md', dir: false },
          { rel: 'src/api', name: 'api', dir: true },
        ];
        const hits = all.filter((h) => h.name.toLowerCase().includes(String(q).toLowerCase()));
        return { hits, truncated: false };
      },
      list: async (rel) => (rel === ''
        ? [
          // Dot-directories must be hidden by default; dotFILES must stay visible.
          { name: '.bimax', dir: true }, { name: '.breakglass', dir: true },
          { name: '.bimax-toolcheck', dir: true },
          { name: 'README.md', dir: false }, { name: 'src', dir: true },
          { name: '.gitignore', dir: false }, { name: 'tui', dir: true },
          { name: 'package.json', dir: false }, { name: 'docs', dir: true },
          { name: 'build.sh', dir: false }, { name: 'node_modules', dir: true },
          { name: 'config.yml', dir: false }, { name: 'logo.png', dir: false },
        ]
        : rel === 'src'
          ? [{ name: 'api', dir: true }, { name: 'index.ts', dir: false }, { name: 'protocol.ts', dir: false }]
          : [{ name: 'client.ts', dir: false }, { name: 'retry.ts', dir: false }]),
      read: async () => ({
        content: [
          "import { sleep } from './util';",
          '',
          '/** Exponential backoff: 250ms → 500ms → 1s, then rethrow. */',
          'export async function retry<T>(n: number, fn: () => Promise<T>): Promise<T> {',
          '  for (let i = 0; ; i++) {',
          '    try { return await fn(); }',
          '    catch (e) {',
          '      if (i >= n) throw e;',
          '      await sleep(2 ** i * 250);',
          '    }',
          '  }',
          '}',
          '',
          'export const DEFAULT_ATTEMPTS = 3;',
          '',
        ].join('\n'),
        truncated: false, size: 214, binary: false,
      }),
      reveal: async () => {},
      write: async () => {},
      onChanged: () => () => {},
    },
    sessionsMeta: async () => {
      const out = [];
      const titles = [
        'Add retry with backoff to the fetch client', 'Fix pty resize race in terminal panel',
        'Wire word-level diffs into Review', 'Cache-tiered prompt architecture',
        'Sub-agent worktree isolation', 'MCP self-healing layer', 'Beast pipeline on the billing repo',
        'Blueprint compiler artifacts', 'Ledger attribution weights', 'Dream-mode curriculum tuning',
      ];
      for (let i = 0; i < 64; i++) {
        const daysAgo = Math.floor(i * 1.7 + (i % 3));
        out.push({
          id: `2026-0${(i % 6) + 1}-1${i % 9}_10-0${i % 6}-00`,
          title: titles[i % titles.length],
          cwd: '/Users/dev/projects/bimax',
          startedAt: new Date(Date.now() - daysAgo * 86400e3 - (i % 12) * 3600e3).toISOString(),
          messageCount: 8 + ((i * 13) % 90),
          tokenEstimate: 120000 + ((i * 77773) % 700000),
        });
      }
      return out;
    },
    pty: {
      create: async () => {
        setTimeout(() => {
          const write = (s) => (window.__cbs.ptyData || []).forEach((cb) => cb(1, s));
          write('\x1b[38;5;180mdev@mac\x1b[0m \x1b[38;5;173mbimax\x1b[0m % npm test\r\n');
          write('\r\n  \x1b[32m✓\x1b[0m 605 tests passing (12.4s)\r\n\r\n');
          write('\x1b[38;5;180mdev@mac\x1b[0m \x1b[38;5;173mbimax\x1b[0m % ');
        }, 80);
        return 1;
      },
      input: () => {},
      resize: () => {},
      kill: () => {},
      onData: (cb) => { (window.__cbs.ptyData ||= []).push(cb); return () => {}; },
      onExit: () => () => {},
    },
  };
});

const pageErrors = [];
page.on('pageerror', (e) => {
  pageErrors.push(e.message);
  console.error('[pageerror]', e.message);
});
// The renderer keeps long-lived app bridges/listeners open; DOM readiness is the stable visual
// boundary, while networkidle can wait forever in both Electron-like and CI environments.
await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 15_000 });

const feed = (msg) => page.evaluate((m) => window.__cbs.msg.forEach((cb) => cb(m)), msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickButton = async ({ title, text: buttonText }) => {
  const clicked = await page.evaluate(({ title: wantedTitle, text: wantedText }) => {
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find((candidate) => (
      (wantedTitle && candidate.title === wantedTitle)
      || (wantedText && candidate.textContent.trim() === wantedText)
    ));
    button?.click();
    return Boolean(button);
  }, { title, text: buttonText });
  // BIMAX_UI_LENIENT lets a partial run continue past a control that a UI change removed, so a
  // single stale step cannot block screenshotting the surfaces further down. It is opt-in: the
  // default still fails loudly, because a silently-skipped step is a silently-unverified screenshot.
  if (!clicked) {
    if (process.env.BIMAX_UI_LENIENT === '1') {
      console.warn(`[skip] missing button: ${title || buttonText}`);
      return;
    }
    throw new Error(`Missing button: ${title || buttonText}`);
  }
};
const assertVisible = async (selector, description) => {
  const visible = await page.$eval(selector, (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }).catch(() => false);
  if (!visible) throw new Error(`Expected visible ${description}`);
};

// Project-first welcome — no engine is running and no chat controls should be visible.
await sleep(500);
await page.screenshot({ path: path.join(outDir, 'ui-welcome.png') });
await page.evaluate(() => window.__cbs.project.forEach((cb) => cb('/Users/dev/projects/bimax')));
await sleep(200);

await feed({ t: 'ready', protocol: 3 });
await feed({ t: 'event', name: 'ui_snapshot', args: [{
  models: { coding: 'moonshotai/kimi-k3', lite: 'mistralai/mistral-7b-instruct-v0.3' },
  goalCount: 2,
  mind: {
    weakSpots: 2, driveDeviations: 1, habits: 3,
    weak: [
      { tool: 'Edit', domain: 'go', failRate: 0.31, pWeak: 0.92, n: 26, advice: 'Prefer SymbolEdit for Go receivers — plain Edit misses method bodies.' },
      { tool: 'Bash', domain: 'tests', failRate: 0.22, pWeak: 0.81, n: 41, advice: 'Run jest with --maxWorkers=2; full suite overheats the machine.' },
    ],
    drives: [
      { label: 'Type errors', value: '0 errors', ok: true, spark: [1, 1, 1, 1, 1, 1] },
      { label: 'TODO debt', value: '41 TODOs', ok: false, spark: [1, 1, 0, 0, 1, 0] },
      { label: 'Test health', value: '605 passing', ok: true, spark: [1, 1, 1, 0, 1, 1] },
    ],
    habitNames: ['build-after-edit', 'targeted-jest-only', 'graph-before-grep'],
    ledger: { resolved: 128, open: 4, expired: 9, coveragePct: 0.93, overconfident: 1 },
  },
  graph: {
    nodeCount: 48213, fileCount: 512, aiGraphBuilt: true,
    modules: [
      { name: 'src/core', criticality: 'high' },
      { name: 'src/mind', criticality: 'high' },
      { name: 'src/protocol', criticality: 'med' },
      { name: 'tui', criticality: 'med' },
    ],
    engine: 'codebase-memory',
  },
  contextWindow: 128000, tokensBaseline: 8948, compressionSaved: 12400,
  workspace: { count: 1, names: ['bimax'], writable: 1 },
  tools: { registered: 47, ready: 21, deferred: 24, discovered: 2, mcp: 1, graphReady: true },
  computer: {
    browserUrl: 'http://localhost:5173/checkout',
    desktop: 'connected', desktopTools: 9,
    vision: true,
    grants: ['domain:localhost'],
    tainted: true,
  },
  sessions: [
    { id: '2026-07-10_14-02-11', title: 'Add retry with backoff to the fetch client', startedAt: new Date(Date.now() - 40 * 60e3).toISOString(), messageCount: 12, cwd: '/Users/dev/projects/bimax', current: true },
    { id: '2026-07-10_09-31-52', title: 'Fix pty resize race in terminal panel', startedAt: new Date(Date.now() - 5 * 3600e3).toISOString(), messageCount: 34, cwd: '/Users/dev/projects/bimax', current: false },
    { id: '2026-07-09_18-20-05', title: 'Wire word-level diffs into Review', startedAt: new Date(Date.now() - 20 * 3600e3).toISOString(), messageCount: 58, cwd: '/Users/dev/projects/bimax', current: false },
    { id: '2026-07-08_11-05-40', title: 'Cache-tiered prompt architecture', startedAt: new Date(Date.now() - 2 * 86400e3).toISOString(), messageCount: 91, cwd: '/Users/dev/projects/bimax', current: false },
  ],
  checkpoints: [
    { id: 'cp-9f2', label: 'before beast run', ts: Date.now() - 8 * 60e3, auto: false },
    { id: 'cp-8a1', label: 'auto: pre-edit src/api/client.ts', ts: Date.now() - 22 * 60e3, auto: true },
    { id: 'cp-77c', label: 'green baseline', ts: Date.now() - 3 * 3600e3, auto: false },
  ],
  git: { branch: 'feat/retry-backoff', dirty: 4, ahead: 2, behind: 0 },
}] });

// Home dashboard — transcript still empty, so the greeting + stats + heatmap render.
await sleep(500);
await page.screenshot({ path: path.join(outDir, 'ui-home.png') });

if (process.argv.includes('--quick')) {
  await browser.close();
  server.close();
  console.log('screenshots: release/ui-welcome.png, release/ui-home.png');
  process.exit(0);
}

// Sessions gallery via the sidebar's "view all".
await clickButton({ title: 'Browse all sessions' });
await sleep(450);
await page.screenshot({ path: path.join(outDir, 'ui-gallery.png') });
await clickButton({ title: 'Back to chat' });
await sleep(250);

await feed({ t: 'event', name: 'message', args: [{
  id: 'u1', role: 'user', content: 'Add retry with backoff to the fetch client', timestamp: new Date().toISOString(),
}] });
await feed({ t: 'event', name: 'tool_call', args: [{
  id: 't1', toolName: 'GraphQuery', input: 'callers of fetchJson', output: '3 call sites: api/client.ts, sync/pull.ts, auth/session.ts',
  status: 'success', startTime: new Date().toISOString(),
}] });
await feed({ t: 'event', name: 'tool_call', args: [{
  id: 't2', toolName: 'Edit', input: 'src/api/client.ts — wrap fetchJson in retry(3, expBackoff)', output: '',
  status: 'running', startTime: new Date().toISOString(), parentId: 'agent-1', agentLabel: 'coder',
}] });
await feed({ t: 'event', name: 'thinking', args: ['The three call sites share a fetch wrapper, so one retry helper in api/retry.ts covers them all. Exponential backoff starting at 250ms, capped at 3 attempts, keeps worst-case latency under 2s.'] });
// A run of consecutive edits → should fold into one "Edited N files" activity chip.
for (const [i, f] of ['src/api/retry.ts', 'src/api/client.ts', 'src/sync/pull.ts'].entries()) {
  await feed({ t: 'event', name: 'tool_call', args: [{
    id: `e${i}`, toolName: 'Edit', input: `${f} — wire retry()`, output: 'ok',
    status: 'success', startTime: new Date(Date.now() - 5000).toISOString(), endTime: new Date().toISOString(),
  }] });
}
await feed({ t: 'event', name: 'message', args: [{
  id: 'a1', role: 'assistant', thoughtMs: 3400,
  content: 'I found **3 call sites** of `fetchJson`. Added a shared retry helper:\n```ts\nexport async function retry<T>(n: number, fn: () => Promise<T>): Promise<T> {\n  for (let i = 0; ; i++) {\n    try { return await fn(); }\n    catch (e) { if (i >= n) throw e; await sleep(2 ** i * 250); }\n  }\n}\n```\n### What changed\n| File | Change |\n|---|---|\n| `api/retry.ts` | new helper |\n| `api/client.ts` | wraps `fetchJson` |\n| `sync/pull.ts` | wraps `pullOnce` |\n\n- backoff: 250ms → 500ms → 1s\n- errors rethrown after attempt 3\n\nRunning the related tests next.',
  timestamp: new Date().toISOString(),
}] });
await feed({ t: 'event', name: 'message', args: [{
  id: 'd1', role: 'system', uiComponent: 'StatsDashboard', content: '',
  payload: { title: 'Session cost', items: [
    { label: 'Streamed tokens', value: '18,204' },
    { label: 'Tool calls', value: '23' },
    { label: 'Compression saved', value: '12,400 tokens' },
  ] },
  timestamp: new Date().toISOString(),
}] });
await feed({ t: 'event', name: 'spinner_state', args: ['tool', 'editing src/api/client.ts'] });
await feed({ t: 'event', name: 'todo_update', args: [[
  { content: 'Locate fetch call sites', status: 'completed' },
  { content: 'Add retry helper', status: 'in_progress' },
  { content: 'Wire into client', status: 'pending' },
]] });
await feed({ t: 'event', name: 'subagent_update', args: [[
  { taskId: 'sa-1', agentType: 'coder', scope: 'src/api/**', prompt: 'Wrap fetchJson call sites in retry()', status: 'running', startedAt: Date.now() - 42000, toolCalls: 7 },
  { taskId: 'sa-2', agentType: 'tester', scope: 'src/__tests__/**', prompt: 'Add retry/backoff unit tests', status: 'done', startedAt: Date.now() - 90000, endedAt: Date.now() - 8000, toolCalls: 12, result: '4 tests added, all green' },
]] });
await feed({ t: 'event', name: 'review_update', args: [{
  sessionId: '2026-07-10_14-02-11',
  state: 'verification_failed',
  nextAction: 'Verification failed (npm test -- retry) — fix and re-run.',
  approvals: [
    { id: 1, kind: 'permission', question: 'Allow edits under src/api?', requestedAt: Date.now() - 8 * 60e3, resolution: { value: 'Approve', approved: true, at: Date.now() - 7 * 60e3 } },
    { id: 2, kind: 'diff', question: 'Apply retry backoff changes?', requestedAt: Date.now() - 4 * 60e3, resolution: { value: 'Approve', approved: true, at: Date.now() - 3 * 60e3 } },
  ],
  changes: [
    { file: 'src/api/client.ts', tools: ['EditFileTool'], edits: 2, lastCallId: 'tc-2', lastAt: Date.now() - 2 * 60e3 },
    { file: 'src/api/retry.ts', tools: ['WriteFileTool'], edits: 1, lastCallId: 'tc-3', lastAt: Date.now() - 2 * 60e3 },
  ],
  verifications: [
    { command: 'npm test -- retry', ok: false, settled: 2, at: Date.now() - 45e3 },
  ],
  checkpoints: [
    { id: '', label: 'verified task', ts: Date.now() - 30e3, auto: false, ok: false },
  ],
  lastCheckpoint: null,
  todos: [
    { content: 'Locate fetch call sites', status: 'completed' },
    { content: 'Add retry helper', status: 'completed' },
    { content: 'Fix failing retry test', status: 'in_progress' },
  ],
  interrupted: false,
  updatedAt: Date.now(),
}] });

await sleep(400);
await page.screenshot({ path: path.join(outDir, 'ui-transcript.png') });

// Composer selectors: open the permission preset dropdown.
await clickButton({ text: 'Work automatically' });
await sleep(250);
const hasAskPreset = await page.evaluate(() => [...document.querySelectorAll('button')]
  .some((button) => button.textContent.includes('Ask before changes')));
if (!hasAskPreset) {
  // Another surface removed with the permissions UI. Same rule as clickButton: loud by default,
  // skippable only for an explicitly partial run.
  if (process.env.BIMAX_UI_LENIENT !== '1') throw new Error('Permission preset menu did not open');
  console.warn('[skip] permission preset menu is gone');
}
await page.screenshot({ path: path.join(outDir, 'ui-composer.png') });
await page.keyboard.press('Escape');
await sleep(150);

// Dock: Agents tab (⌘J opens, default tab agents)
await page.keyboard.down('Meta');
await page.keyboard.press('j');
await page.keyboard.up('Meta');
await sleep(300);
await page.screenshot({ path: path.join(outDir, 'ui-agents.png') });

const clickTab = async (label) => {
  const clicked = await page.evaluate((l) => {
    const btns = [...document.querySelectorAll('button')];
    const button = btns.find((b) => b.getAttribute('aria-label') === l || b.textContent.trim().startsWith(l));
    button?.click();
    return Boolean(button);
  }, label);
  if (!clicked) {
    if (process.env.BIMAX_UI_LENIENT === '1') { console.warn(`[skip] missing dock tab: ${label}`); return false; }
    throw new Error(`Missing dock tab: ${label}`);
  }
};

// Mind tab
await clickTab('Memory');
await sleep(300);
await page.screenshot({ path: path.join(outDir, 'ui-mind.png') });

// Review tab (P3): changed-file list + branch pill, then a file's word-level diff.
await clickTab('Review');
await sleep(350);
await page.screenshot({ path: path.join(outDir, 'ui-review.png') });
await clickButton({ title: 'src/api/client.ts' });
await sleep(350);
await page.screenshot({ path: path.join(outDir, 'ui-diff.png') });

// Files lane: open the right panel, choose the lane from its picker, expand one level.
// The old dock tab this used to click no longer exists — the panel is now four lanes behind a
// <select>, so drive that instead of a control that was removed.
await page.evaluate(() => {
  const toggle = [...document.querySelectorAll('button')]
    .find((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || '').includes('evidence'));
  toggle?.click();
});
await sleep(400);
await page.evaluate(() => {
  const select = document.querySelector('select[aria-label="Choose evidence lane"]');
  if (select) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'files');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
await sleep(400);
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[role="button"], button')];
  rows.find((b) => b.getAttribute('title') === 'src')?.click();
});
await sleep(250);
await page.screenshot({ path: path.join(outDir, 'ui-files.png') });

// Files tab, filtering: the filter searches the whole project, not the expanded rows.
await page.evaluate(() => {
  const input = document.querySelector('input[aria-label="Filter files"]');
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'ts');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
await sleep(500);
await page.screenshot({ path: path.join(outDir, 'ui-files-filter.png') });
await page.evaluate(() => {
  const input = document.querySelector('input[aria-label="Filter files"]');
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
await sleep(300);

// Clicking a file in the Files LANE must reveal the editor. This is the regression that shipped:
// every other piece of state was set correctly and the panel kept rendering the tree, so the click
// looked inert. Screenshot proves the code is on screen, highlighted.
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[role="button"]')];
  rows.find((b) => (b.getAttribute('title') || '').startsWith('src/protocol.ts'))?.click();
});
await sleep(700);
await page.screenshot({ path: path.join(outDir, 'ui-files-editor.png') });

// IDE editor pane: open a file from the tree — CodeMirror takes over the right side.
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[role="button"]')];
  rows.find((b) => (b.getAttribute('title') || '').startsWith('src/index.ts'))?.click();
});
await sleep(600);
await page.screenshot({ path: path.join(outDir, 'ui-editor.png') });
// Back to panels so the remaining dock shots see tabs again.
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')];
  btns.find((b) => (b.title || '').startsWith('Back to panels'))?.click();
});
await sleep(300);

// Terminal tab (P3): xterm with fake session output.
await clickTab('Terminal');
await sleep(500);
await page.screenshot({ path: path.join(outDir, 'ui-terminal.png') });

// Agents tab (P4): swarm launcher form open over the live cards.
await clickTab('Agent team');
await sleep(200);
await clickButton({ text: 'Parallel team' });
await sleep(250);
await page.screenshot({ path: path.join(outDir, 'ui-agents-launch.png') });
await page.keyboard.press('Escape');

// Map tab (P4): graph stats + index actions + impact query.
await clickTab('Code map');
await sleep(250);
await page.screenshot({ path: path.join(outDir, 'ui-map.png') });

// Health tab: engine warnings/errors are durable and the latest one surfaces as a top banner.
await feed({ t: 'event', name: 'log', args: [{
  id: 'diag-1', level: 'warn',
  text: 'Graph persistence is using the in-memory fallback; restart durability is unavailable.',
  timestamp: new Date().toISOString(),
}] });
await clickButton({ title: 'Help and app status' });
await sleep(250);
await page.screenshot({ path: path.join(outDir, 'ui-health.png') });

// Settings dialog (P6): grouped engine-menu entry points.
await clickButton({ title: 'Settings' });
await sleep(350);
await assertVisible('input[placeholder="Search settings"]', 'settings search');
await page.screenshot({ path: path.join(outDir, 'ui-settings.png') });
await page.keyboard.press('Escape');
await sleep(200);

// ⌘K palette
await page.keyboard.down('Meta');
await page.keyboard.press('k');
await page.keyboard.up('Meta');
await sleep(350);
await assertVisible('input[placeholder="Search Bimax…"]', 'command search');
await page.screenshot({ path: path.join(outDir, 'ui-palette.png') });
await page.keyboard.press('Escape');
await sleep(200);

// Approval modal on top of the shell
await feed({ t: 'request', id: 7, kind: 'diff', question: 'Apply this edit to src/api/client.ts?',
  options: ['Approve', 'Reject', 'Always allow edits'],
  body: '@@ -12,6 +12,9 @@\n-  const res = await fetch(url);\n+  const res = await retry(3, () => fetch(url));\n+  // exponential backoff: 250ms, 500ms, 1s\n   if (!res.ok) throw new ApiError(res);' });
await sleep(350);
const unnamedButtons = await page.evaluate(() => [...document.querySelectorAll('button:not([disabled])')]
  .filter((button) => !(button.textContent.trim() || button.title || button.getAttribute('aria-label')))
  .map((button) => button.outerHTML.slice(0, 240)));
if (unnamedButtons.length > 0) throw new Error(`Enabled button(s) have no accessible name: ${unnamedButtons.join(' | ')}`);
if (pageErrors.length > 0) throw new Error(`Renderer errors: ${pageErrors.join(' | ')}`);
await page.screenshot({ path: path.join(outDir, 'ui-modal.png') });

await browser.close();
server.close();
console.log('screenshots:', ['ui-welcome', 'ui-home', 'ui-gallery', 'ui-transcript', 'ui-agents', 'ui-agents-launch', 'ui-map', 'ui-health', 'ui-mind', 'ui-review', 'ui-diff', 'ui-files', 'ui-editor', 'ui-terminal', 'ui-settings', 'ui-palette', 'ui-modal'].map((n) => `release/${n}.png`).join(', '));
