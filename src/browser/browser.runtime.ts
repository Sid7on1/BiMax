import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Browser, CDPSession, Dialog, ElementHandle, HTTPResponse, Page } from 'puppeteer';
import { SafetyPolicy } from '../governor/policy.engine';

export type BrowserWaitUntil = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';

export interface BrowserAssertion {
  selector?: string;
  exists?: boolean;
  textIncludes?: string;
  urlIncludes?: string;
  titleIncludes?: string;
  noConsoleErrors?: boolean;
  noFailedRequests?: boolean;
  statusBelow?: number;
}

export interface BrowserCommand {
  action: 'navigate' | 'snapshot' | 'click' | 'type' | 'press' | 'select' | 'hover'
    | 'scroll' | 'wait' | 'inspect' | 'screenshot' | 'compare'
    | 'assert' | 'viewport' | 'upload' | 'back' | 'reload' | 'tabs' | 'switch_tab'
    | 'close_tab' | 'dialogs'
    | 'download_prepare' | 'downloads' | 'download_wait' | 'download_cancel'
    | 'status' | 'close';
  /** Opaque live-tab identity returned by tabs/snapshot/navigation receipts. */
  tabRef?: string;
  /** Exact document epoch. A navigation or reload makes the prior ref stale. */
  documentRef?: string;
  url?: string;
  selector?: string;
  elementIndex?: number | string;
  /** Opaque observation-scoped ref returned beside each snapshot element. Preferred over the
   * compatibility index because it cannot silently rebind when a later snapshot reuses an index. */
  elementRef?: string;
  /** Opaque identity of a download returned by downloads/download_wait. */
  downloadRef?: string;
  /** Maximum bytes accepted by a one-shot download permit. */
  maxBytes?: number;
  text?: string;
  key?: string;
  values?: string[];
  x?: number;
  y?: number;
  path?: string;
  baseline?: string;
  fullPage?: boolean;
  width?: number;
  height?: number;
  pixels?: number;
  timeout?: number;
  retries?: number;
  waitUntil?: BrowserWaitUntil;
  clear?: boolean;
  allowPrivate?: boolean;
  assertion?: BrowserAssertion;
  maxElements?: number;
  /** snapshot: only index elements whose name/role/tag/value matches this substring (progressive
   * query — ask for "submit" instead of paging through 200 rows; borrowed from Pi's search_ui). */
  filter?: string;
  /** Mutating actions: how long to let the page react before the automatic fresh observation
   * (0–5000 ms, default 800). The wait ends at the FIRST DOM mutation — it never sleeps blind. */
  settleMs?: number;
  /** click: interpret x/y in the 0–1000 normalized space some vision models emit
   * convention) and scale to the live viewport before dispatching. */
  normalized?: boolean;
  /** wait: resolve when the DOM mutates (or the timeout elapses) instead of sleeping blind —
   * change detection à la Pi's wait_for. */
  forChange?: boolean;
}

export interface BrowserCommandResult {
  ok: boolean;
  action: BrowserCommand['action'];
  url?: string;
  title?: string;
  status?: number;
  summary: string;
  data?: unknown;
  screenshot?: string;
  consoleErrors: string[];
  failedRequests: string[];
  attempts: number;
  durationMs: number;
  target?: BrowserDocumentTarget;
  navigation?: BrowserNavigationOutcome;
  dialog?: BrowserDialogInfo;
  download?: BrowserDownloadInfo;
}

export interface BrowserDocumentTarget {
  tabRef: string;
  documentRef: string;
}

export interface BrowserTabInfo extends BrowserDocumentTarget {
  url: string;
  title: string;
  active: boolean;
}

export interface BrowserNavigationOutcome {
  kind: 'navigate' | 'back' | 'reload' | 'action';
  from: BrowserDocumentTarget;
  to: BrowserDocumentTarget;
  url: string;
  documentChanged: boolean;
  status?: number;
}

export interface BrowserDialogInfo extends BrowserDocumentTarget {
  dialogRef: string;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultValue?: string;
  openedAt: number;
  resolution?: 'dismissed_safely';
}

export interface BrowserDownloadInfo extends BrowserDocumentTarget {
  downloadRef: string;
  url: string;
  suggestedFilename: string;
  state: 'in_progress' | 'completed' | 'canceled' | 'failed';
  receivedBytes: number;
  totalBytes?: number;
  maxBytes: number;
  path?: string;
  sha256?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export interface BrowserRuntimePort {
  run(command: BrowserCommand, context?: { cwd?: string; signal?: AbortSignal }): Promise<BrowserCommandResult>;
  close(): Promise<void>;
  /** URL of the live page WITHOUT launching a browser — null when no page is open. Optional so
   * lightweight test doubles only need run/close. */
  currentUrl?(): string | null;
  /** Value-safe metadata of one element from the CURRENT observation (null when the index is not
   * part of it). Lets the tool layer classify impact before acting. Optional for test doubles. */
  indexedElementInfo?(index: number | string | undefined, elementRef?: string): SnapshotElementInfo | null;
  /** Synchronous no-I/O target check so stale tab/document refs are refused before approval. */
  preflightTarget?(command: BrowserCommand): { ok: true } | { ok: false; error: string };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_DIAGNOSTICS = 100;
const DEFAULT_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
/** Hard cap on live pages. target=_blank links and window.open popups create pages this runtime
 * never drives; unchecked they accumulate for hours (tab explosion → memory growth → crash). */
const MAX_PAGES = 4;
/** Consecutive identical failures before the result starts telling the model to change approach. */
const FAILURE_LOOP_THRESHOLD = 3;

/** True when an error means the browser PROCESS or its CDP connection died — not that the page
 * merely misbehaved. These must reset the runtime (next action relaunches) instead of leaving a
 * dead handle that fails every subsequent action forever. */
export function isBrowserCrashError(message: string): boolean {
  return /Protocol error|Target closed|Session closed|Connection closed|browser has disconnected|WebSocket is not open|Navigating frame was detached|Browser closed unexpectedly/i
    .test(message);
}

/** Stable identity of an attempted action (what was tried, not how it failed) for consecutive-
 * failure tracking. Deliberately excludes typed text content — retyping different text into the
 * same field is the same failing approach. */
export function browserActionKey(command: BrowserCommand): string {
  return [
    command.action, command.url || '', command.selector || '',
    command.tabRef || '', command.documentRef || '', command.elementRef || '',
    command.downloadRef || '',
    String(command.elementIndex ?? ''), command.key || '',
  ].join('|');
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

export function validateBrowserUrl(raw: string, allowPrivate = false): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try { url = new URL(raw); }
  catch { return { ok: false, reason: `Invalid URL: ${raw}` }; }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, reason: `Only http/https browser URLs are allowed (got ${url.protocol})` };
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '0.0.0.0' || host === '[::1]' || host === '::1' || /^127\./.test(host);
  const privateHost = /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^169\.254\./.test(host) || host.endsWith('.local') || host.endsWith('.internal');
  // Localhost is a first-class target for UI verification. Other private-network targets require
  // an explicit per-call acknowledgement so a webpage cannot silently turn the browser into SSRF.
  if (privateHost && !loopback && !allowPrivate) {
    return { ok: false, reason: `Private-network host requires allowPrivate=true: ${host}` };
  }
  return { ok: true, url };
}

/** The observation-stable identity of one indexed element (tag/role/name/state, not position). */
export interface SnapshotElementInfo {
  tag: string;
  role: string;
  type?: string;
  name: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
}

/** Stable per-element signature for successor diffs. Deliberately excludes rect: scrolling or a
 * layout shift must not read as "the UI changed". */
export function elementSignature(info: SnapshotElementInfo): string {
  return [info.tag, info.role, info.type || '', info.name, info.value ?? '', info.checked ?? '', info.disabled ? 'disabled' : '']
    .join('|');
}

export interface SnapshotDiff {
  /** Sample of appeared/disappeared signatures (capped at 20 each for readability). */
  added: string[];
  removed: string[];
  /** TRUE totals — never understated by the sample caps. */
  addedCount: number;
  removedCount: number;
  changed: boolean;
}

/** Successor diff between two consecutive snapshots (Pi's compact-diff idea): what appeared and
 * what disappeared, by signature, order-insensitive. Samples are capped; counts are exact. */
export function diffSnapshots(previous: string[], next: string[]): SnapshotDiff {
  const count = (list: string[]) => {
    const m = new Map<string, number>();
    for (const s of list) m.set(s, (m.get(s) || 0) + 1);
    return m;
  };
  const prev = count(previous);
  const added: string[] = [];
  for (const sig of next) {
    const left = prev.get(sig) || 0;
    if (left > 0) prev.set(sig, left - 1);
    else added.push(sig);
  }
  const removed: string[] = [];
  for (const [sig, n] of prev) for (let i = 0; i < n; i++) removed.push(sig);
  return {
    added: added.slice(0, 20),
    removed: removed.slice(0, 20),
    addedCount: added.length,
    removedCount: removed.length,
    changed: added.length > 0 || removed.length > 0,
  };
}

/** Case-insensitive substring match over an element's identity fields (progressive query). */
export function matchesElementFilter(info: SnapshotElementInfo, filter?: string): boolean {
  if (!filter || !filter.trim()) return true;
  const q = filter.trim().toLowerCase();
  return [info.name, info.role, info.tag, info.type || '', info.value || '']
    .some(field => field.toLowerCase().includes(q));
}

/** Map one coordinate from the 0–1000 normalized space VLMs emit to real pixels (Gemini
 * normalized denormalization: value / 1000 × size, clamped into the viewport). */
export function denormalizeCoordinate(value: number, size: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(size) || size <= 0) return 0;
  return Math.min(Math.max(Math.round((value / 1000) * size), 0), Math.max(0, Math.round(size) - 1));
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'page';
}

/** Resolve a model-supplied destination without allowing a symlinked existing ancestor to escape
 * the active workspace. The Governor repeats this check at the policy boundary; the runtime keeps
 * its own fail-closed check because it is the component that eventually writes bytes. */
export function resolveBrowserWorkspacePath(root: string, requested: string):
  { ok: true; path: string } | { ok: false; reason: string } {
  const workspace = path.resolve(root);
  const candidate = path.resolve(workspace, requested);
  if (!within(workspace, candidate)) return { ok: false, reason: 'Path must stay inside the active workspace.' };
  try {
    const workspaceReal = fs.realpathSync(workspace);
    let existing = candidate;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const existingReal = fs.realpathSync(existing);
    if (!within(workspaceReal, existingReal)) {
      return { ok: false, reason: 'Path resolves outside the active workspace through a symlink.' };
    }
  } catch {
    return { ok: false, reason: 'Could not verify the destination against the active workspace.' };
  }
  return { ok: true, path: candidate };
}

function safeDownloadFilename(value: string): string {
  const withoutControls = Array.from(value || 'download')
    .filter(character => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
    .join('');
  const leaf = path.basename(withoutControls)
    .replace(/^\.+/, '')
    .slice(0, 180);
  return leaf || 'download';
}

function availableDownloadPath(root: string, filename: string): string {
  const parsed = path.parse(filename);
  for (let i = 0; i < 10_000; i++) {
    const suffix = i === 0 ? '' : `-${i + 1}`;
    const candidate = path.join(root, `${parsed.name || 'download'}${suffix}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(root, `${parsed.name || 'download'}-${crypto.randomUUID()}${parsed.ext}`);
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

export function findBrowserExecutable(): string | undefined {
  // Default Puppeteer owns the browser revision it was tested against. Never silently attach the
  // user's personal Chrome binary: that makes Chrome bounce in the Dock, blurs profile boundaries
  // and can drift out of protocol compatibility. A system browser is an expert opt-in only.
  const configured = process.env.BIMAX_BROWSER_EXECUTABLE || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!configured) return undefined;
  try { return fs.statSync(configured).isFile() ? configured : undefined; } catch { return undefined; }
}

/** Page-side mutation counter & stealth shield: lets the runtime detect "the page reacted" without
 * blind sleeps, neuters anti-debugging loops, and triggers framework semantic trees (Flutter/Docs).
 * Installed at page creation AND on every new document, so it survives navigations. */
const MUTATION_COUNTER_SCRIPT = `(() => {
  try {
    // 1. Neuter anti-debugging loops (Function/eval debugger traps)
    const origFunc = window.Function;
    const patchedFunc = function(...args) {
      if (args.some(a => typeof a === 'string' && /debugger/i.test(a))) {
        return function() {};
      }
      return origFunc.apply(this, args);
    };
    patchedFunc.prototype = origFunc.prototype;
    window.Function = patchedFunc;

    // 2. Trigger framework accessibility trees (Flutter Web & Canvas apps)
    const triggerFlutterSemantics = () => {
      try {
        // NO TypeScript in here, and no backticks either. This whole constant is a template
        // literal injected into the page as JavaScript, so the compiler never sees inside it:
        // a TS cast type-checks as part of a string and then throws
        // SyntaxError: Unexpected identifier 'as' in the browser, killing the ENTIRE script at its
        // first occurrence. That is what shipped — the mutation counter below never installed, so
        // "did the page react?" silently degraded to blind waiting, and the anti-debugging shield
        // never ran. A backtick in a comment ends the literal early, which is the same class of
        // trap one level up.
        const placeholder = document.querySelector('flt-semantics-placeholder');
        if (placeholder) placeholder.click();
        if (window.flutterConfiguration && window.flutterConfiguration.ensureSemantics) {
          window.flutterConfiguration.ensureSemantics();
        }
      } catch { /* Ignore */ }
    };
    triggerFlutterSemantics();
  } catch { /* Best-effort stealth */ }

  if (window.__bimaxObs) return;
  window.__bimaxMutations = 0;
  const observer = new MutationObserver(records => { window.__bimaxMutations += records.length; });
  const start = () => {
    try {
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      window.__bimaxObs = true;
    } catch { /* no documentElement yet */ }
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})()`;

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('Browser action interrupted.');
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(new Error('Browser action interrupted.')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * One persistent browser profile per project. Cookies, local storage, downloads, and Chromium
 * session data survive CLI restarts through userDataDir; lightweight navigation metadata is also
 * checkpointed so recovery can explain where the previous run stopped.
 */
interface PendingBrowserDialog {
  dialog: Dialog;
  info: BrowserDialogInfo;
}

interface ArmedBrowserDownload {
  root: string;
  maxBytes: number;
  target: BrowserDocumentTarget;
}

interface BrowserDownloadRecord {
  guid: string;
  root: string;
  internalPath: string;
  info: BrowserDownloadInfo;
}

export class BrowserRuntime implements BrowserRuntimePort {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private consoleErrors: string[] = [];
  private failedRequests: string[] = [];
  private lastStatus?: number;
  private projectRoot = '';
  // Task-workspace id for the live browser session (task.registry) — null when no session.
  private taskId: string | null = null;
  /** Element handles from the latest OBSERVATION. Identity is observation-scoped: every action
   * attempt CONSUMES the observation (handles are invalidated success or failure) and a fresh one
   * is captured automatically, so an index is only ever valid against the state it described. */
  private indexedElements = new Map<number, ElementHandle<Element>>();
  /** Value-safe metadata mirror of indexedElements, for impact classification and state surfaces. */
  private indexedElementMeta = new Map<number, SnapshotElementInfo>();
  private indexedElementRefs = new Map<string, number>();
  private readonly tabRefs = new Map<Page, string>();
  private readonly pagesByTabRef = new Map<string, Page>();
  private readonly documentRefs = new Map<Page, string>();
  private readonly initializedPages = new WeakSet<Page>();
  private readonly pendingDialogs = new Map<Page, PendingBrowserDialog>();
  private readonly dialogResolutions = new Map<Page, Promise<void>>();
  private readonly recentDialogs: BrowserDialogInfo[] = [];
  private downloadSession: CDPSession | null = null;
  private armedDownload: ArmedBrowserDownload | null = null;
  private readonly downloadRecords = new Map<string, BrowserDownloadRecord>();
  private readonly downloadRefsByGuid = new Map<string, string>();
  /** Signatures of the previous snapshot's elements (same filter only), fueling successor diffs. */
  private lastSnapshotSignatures: string[] | null = null;
  private lastSnapshotFilter = '';

  /** URL of the live page without launching anything (for status surfaces and approval scoping). */
  currentUrl(): string | null {
    try { return this.page && !this.page.isClosed() ? this.page.url() : null; } catch { return null; }
  }

  /** Value-safe metadata of an element in the CURRENT observation, or null. Never launches. */
  indexedElementInfo(raw: number | string | undefined, elementRef?: string): SnapshotElementInfo | null {
    if (elementRef !== undefined) {
      const refIndex = this.indexedElementRefs.get(elementRef);
      if (refIndex === undefined || (raw !== undefined && raw !== null && raw !== '' && Number(raw) !== refIndex)) return null;
      return this.indexedElementMeta.get(refIndex) || null;
    }
    if (raw === undefined || raw === null || raw === '') return null;
    const index = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(index) || index < 0) return null;
    return this.indexedElementMeta.get(index) || null;
  }

  private pendingDialogInfo(dialogRef?: string): BrowserDialogInfo | null {
    const pending = this.page ? this.pendingDialogs.get(this.page) : undefined;
    if (!pending || (dialogRef && pending.info.dialogRef !== dialogRef)) return null;
    return { ...pending.info };
  }

  preflightTarget(command: BrowserCommand): { ok: true } | { ok: false; error: string } {
    let target = this.page;
    if (command.tabRef) {
      target = this.pagesByTabRef.get(command.tabRef) || null;
      if (!target || target.isClosed()) return { ok: false, error: 'tabRef is stale. Call tabs for current refs.' };
      if (!['switch_tab', 'close_tab'].includes(command.action) && target !== this.page) {
        return { ok: false, error: 'tabRef is not active. Call switch_tab before operating it.' };
      }
    } else if (command.documentRef) {
      return { ok: false, error: 'documentRef requires tabRef.' };
    }
    if (target && command.documentRef && this.documentRefs.get(target) !== command.documentRef) {
      return { ok: false, error: 'documentRef is stale because that tab navigated or reloaded.' };
    }
    const pending = target ? this.pendingDialogs.get(target) : undefined;
    const allowedWhileDialogOpen = ['dialogs', 'tabs', 'switch_tab', 'close_tab', 'status', 'close'];
    if (pending && !allowedWhileDialogOpen.includes(command.action)) {
      return { ok: false, error: `A ${pending.info.type} dialog is blocking this tab. Inspect, accept, or dismiss it first.` };
    }
    return { ok: true };
  }

  private newOpaqueRef(kind: 'tab' | 'document' | 'dialog' | 'download'): string {
    return `bimax-browser-${kind}-${crypto.randomUUID()}`;
  }

  private bindPage(page: Page): BrowserDocumentTarget {
    let tabRef = this.tabRefs.get(page);
    if (!tabRef) {
      tabRef = this.newOpaqueRef('tab');
      this.tabRefs.set(page, tabRef);
      this.pagesByTabRef.set(tabRef, page);
    }
    let documentRef = this.documentRefs.get(page);
    if (!documentRef) {
      documentRef = this.newOpaqueRef('document');
      this.documentRefs.set(page, documentRef);
    }
    return { tabRef, documentRef };
  }

  private rotateDocument(page: Page): BrowserDocumentTarget {
    const target = this.bindPage(page);
    const documentRef = this.newOpaqueRef('document');
    this.documentRefs.set(page, documentRef);
    if (page === this.page) void this.clearIndexedElements();
    return { tabRef: target.tabRef, documentRef };
  }

  private targetFor(page: Page | null = this.page): BrowserDocumentTarget | undefined {
    return page && !page.isClosed() ? this.bindPage(page) : undefined;
  }

  private async initializePage(page: Page): Promise<void> {
    this.bindPage(page);
    if (this.initializedPages.has(page)) return;
    this.initializedPages.add(page);
    page.on('console', message => {
      if (message.type() === 'error') this.consoleErrors.push(message.text().slice(0, 2000));
      if (this.consoleErrors.length > MAX_DIAGNOSTICS) this.consoleErrors.shift();
    });
    page.on('pageerror', error => {
      this.consoleErrors.push(String(error).slice(0, 2000));
      if (this.consoleErrors.length > MAX_DIAGNOSTICS) this.consoleErrors.shift();
    });
    page.on('requestfailed', request => {
      this.failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText || 'failed'}`.slice(0, 2500));
      if (this.failedRequests.length > MAX_DIAGNOSTICS) this.failedRequests.shift();
    });
    page.on('dialog', dialog => {
      const target = this.bindPage(page);
      const defaultValue = dialog.defaultValue();
      const pending: PendingBrowserDialog = {
        dialog,
        info: {
          ...target,
          dialogRef: this.newOpaqueRef('dialog'),
          type: dialog.type(),
          message: dialog.message().slice(0, 4000),
          ...(defaultValue ? { defaultValue: defaultValue.slice(0, 2000) } : {}),
          openedAt: Date.now(),
        },
      };
      this.pendingDialogs.set(page, pending);
      // Chromium's trusted-input command stays blocked until the modal is resolved. A deferred
      // model/human decision therefore deadlocks the page. Fail safe: dismiss immediately, retain
      // the typed receipt for inspection, and do not advertise accept/dismiss as supported.
      const resolution = dialog.dismiss().then(() => {
        if (this.pendingDialogs.get(page) === pending) this.pendingDialogs.delete(page);
        pending.info.resolution = 'dismissed_safely';
        this.recentDialogs.unshift({ ...pending.info });
        if (this.recentDialogs.length > 50) this.recentDialogs.length = 50;
      }).finally(() => {
        if (this.dialogResolutions.get(page) === resolution) this.dialogResolutions.delete(page);
      });
      void resolution.catch(() => { /* the triggering BrowserTool action reports the failure */ });
      this.dialogResolutions.set(page, resolution);
      void this.clearIndexedElements();
    });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) this.rotateDocument(page);
    });
    page.once('close', () => {
      const ref = this.tabRefs.get(page);
      if (ref) this.pagesByTabRef.delete(ref);
      this.tabRefs.delete(page);
      this.documentRefs.delete(page);
      this.pendingDialogs.delete(page);
      this.dialogResolutions.delete(page);
    });
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    await page.evaluateOnNewDocument(MUTATION_COUNTER_SCRIPT);
    await page.evaluate(MUTATION_COUNTER_SCRIPT).catch(() => { /* about:blank etc. */ });
  }

  private async syncPages(): Promise<Page[]> {
    if (!this.browser?.connected) return [];
    const pages = (await this.browser.pages()).filter(page => !page.isClosed());
    await Promise.all(pages.map(page => this.initializePage(page)));
    return pages;
  }

  private async tabInfos(): Promise<BrowserTabInfo[]> {
    const pages = await this.syncPages();
    return Promise.all(pages.map(async page => ({
      ...this.bindPage(page), url: page.url(),
      title: String(await page.title().catch(() => '')).slice(0, 500), active: page === this.page,
    })));
  }

  private downloadInfos(): BrowserDownloadInfo[] {
    return Array.from(this.downloadRecords.values())
      .map(record => ({ ...record.info }))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 50);
  }

  private async denyDownloads(): Promise<void> {
    this.armedDownload = null;
    await this.downloadSession?.send('Browser.setDownloadBehavior', {
      behavior: 'deny', eventsEnabled: true,
    }).catch(() => {});
  }

  private async initializeDownloads(): Promise<void> {
    if (!this.browser || this.downloadSession) return;
    const session = await this.browser.target().createCDPSession();
    this.downloadSession = session;
    session.on('Browser.downloadWillBegin', (event: {
      guid: string; url: string; suggestedFilename: string;
    }) => {
      const armed = this.armedDownload;
      if (!armed) {
        void session.send('Browser.cancelDownload', { guid: event.guid }).catch(() => {});
        return;
      }
      this.armedDownload = null;
      const downloadRef = this.newOpaqueRef('download');
      const record: BrowserDownloadRecord = {
        guid: event.guid,
        root: armed.root,
        internalPath: path.join(armed.root, event.guid),
        info: {
          ...armed.target,
          downloadRef,
          url: event.url.slice(0, 4000),
          suggestedFilename: safeDownloadFilename(event.suggestedFilename),
          state: 'in_progress', receivedBytes: 0, maxBytes: armed.maxBytes,
          startedAt: Date.now(),
        },
      };
      this.downloadRecords.set(downloadRef, record);
      this.downloadRefsByGuid.set(event.guid, downloadRef);
    });
    session.on('Browser.downloadProgress', (event: {
      guid: string; totalBytes: number; receivedBytes: number;
      state: 'inProgress' | 'completed' | 'canceled';
    }) => { void this.updateDownloadProgress(event); });
    await this.denyDownloads();
  }

  private async updateDownloadProgress(event: {
    guid: string; totalBytes: number; receivedBytes: number;
    state: 'inProgress' | 'completed' | 'canceled';
  }): Promise<void> {
    const ref = this.downloadRefsByGuid.get(event.guid);
    const record = ref ? this.downloadRecords.get(ref) : undefined;
    if (!record) return;
    record.info.receivedBytes = Math.max(0, event.receivedBytes);
    if (event.totalBytes > 0) record.info.totalBytes = event.totalBytes;

    if (event.receivedBytes > record.info.maxBytes || event.totalBytes > record.info.maxBytes) {
      record.info.state = 'canceled';
      record.info.error = `Download exceeded the approved ${record.info.maxBytes}-byte limit.`;
      record.info.completedAt = Date.now();
      await this.downloadSession?.send('Browser.cancelDownload', { guid: event.guid }).catch(() => {});
      fs.rmSync(record.internalPath, { force: true });
      this.downloadRefsByGuid.delete(event.guid);
      await this.denyDownloads();
      return;
    }
    if (event.state === 'inProgress') return;

    if (event.state === 'canceled') {
      record.info.state = 'canceled';
      record.info.completedAt = Date.now();
      record.info.error ||= 'Chromium canceled the download.';
      fs.rmSync(record.internalPath, { force: true });
      this.downloadRefsByGuid.delete(event.guid);
      await this.denyDownloads();
      return;
    }

    try {
      const filename = safeDownloadFilename(record.info.suggestedFilename);
      const finalPath = availableDownloadPath(record.root, filename);
      const normalized = finalPath.toLowerCase();
      if (SafetyPolicy.forbiddenExtensions.includes(path.extname(normalized))
        || SafetyPolicy.forbiddenRegex.some(pattern => pattern.test(normalized))) {
        throw new Error('Downloaded filename is blocked by the workspace file policy.');
      }
      const actualBytes = fs.statSync(record.internalPath).size;
      if (actualBytes > record.info.maxBytes) throw new Error(`Download exceeded the approved ${record.info.maxBytes}-byte limit.`);
      fs.renameSync(record.internalPath, finalPath);
      record.info.state = 'completed';
      record.info.receivedBytes = actualBytes;
      record.info.path = path.relative(this.projectRoot, finalPath);
      record.info.sha256 = await sha256File(finalPath);
      record.info.completedAt = Date.now();
    } catch (error: any) {
      record.info.state = 'failed';
      record.info.error = String(error?.message || error).slice(0, 1000);
      record.info.completedAt = Date.now();
      fs.rmSync(record.internalPath, { force: true });
    } finally {
      this.downloadRefsByGuid.delete(event.guid);
      await this.denyDownloads();
    }
  }

  private navigationOutcome(
    kind: BrowserNavigationOutcome['kind'],
    from: BrowserDocumentTarget,
    page: Page,
    status?: number,
  ): BrowserNavigationOutcome {
    let to = this.targetFor(page)!;
    // Puppeteer normally emits main-frame navigation before the awaited command resolves. Keep
    // the epoch contract independent of that event timing: every successful explicit reload or
    // navigation gets a new document ref even if an exotic target omitted the event.
    if (to.documentRef === from.documentRef) to = this.rotateDocument(page);
    return { kind, from, to, url: page.url(), documentChanged: true, status };
  }

  private roots(cwd: string) {
    const root = path.resolve(cwd);
    return {
      root,
      profile: path.join(root, '.bimax', 'browser', 'profile'),
      state: path.join(root, '.bimax', 'browser', 'state.json'),
      evidence: path.join(root, '.bimax', 'evidence', 'browser'),
    };
  }

  private checkpoint(cwd: string): void {
    if (!this.page) return;
    const roots = this.roots(cwd);
    try {
      fs.mkdirSync(path.dirname(roots.state), { recursive: true });
      fs.writeFileSync(roots.state, JSON.stringify({
        version: 1,
        url: this.page.url(),
        lastStatus: this.lastStatus,
        consoleErrors: this.consoleErrors.slice(-20),
        failedRequests: this.failedRequests.slice(-20),
        updatedAt: Date.now(),
      }, null, 2));
    } catch { /* browser evidence must never crash the turn */ }
  }

  private async clearIndexedElements(): Promise<void> {
    const handles = Array.from(this.indexedElements.values());
    this.indexedElements.clear();
    this.indexedElementMeta.clear();
    this.indexedElementRefs.clear();
    await Promise.all(handles.map(handle => handle.dispose().catch(() => {})));
  }

  /** Resolve an elementIndex against the CURRENT observation. `{stale}` means the caller passed a
   * real index that is no longer part of it (consumed by an action or navigation) — the action
   * must fail truthfully instead of falling back to a misleading "requires selector" message. */
  private resolveIndexed(raw: number | string | undefined, elementRef?: string):
    { handle: ElementHandle<Element> } | { error: string } | null {
    if (elementRef !== undefined) {
      if (typeof elementRef !== 'string' || !elementRef || elementRef.length > 128 || elementRef.includes('\0')) {
        return { error: 'elementRef is malformed. Take a fresh snapshot.' };
      }
      const refIndex = this.indexedElementRefs.get(elementRef);
      if (refIndex === undefined) {
        return { error: 'elementRef is stale: its observation was consumed or replaced. Take a fresh snapshot.' };
      }
      if (raw !== undefined && raw !== null && raw !== '' && Number(raw) !== refIndex) {
        return { error: 'elementRef and elementIndex identify different elements. Take a fresh snapshot.' };
      }
      const handle = this.indexedElements.get(refIndex);
      return handle ? { handle } : { error: 'elementRef is stale: its element is no longer retained.' };
    }
    if (raw === undefined || raw === null || raw === '') return null;
    const index = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(index) || index < 0) return null;
    const handle = this.indexedElements.get(index);
    return handle ? { handle } : { error: `elementIndex ${index} is stale: the observation it came from was consumed by a previous action or navigation. Use the fresh \`observation.elements\` returned by your last action, or take a new snapshot.` };
  }

  private staleTargetResult(base: (ok: boolean, summary: string, data?: unknown) => BrowserCommandResult, error: string): BrowserCommandResult {
    return base(false, error);
  }

  private async ensure(cwd: string): Promise<Page> {
    const roots = this.roots(cwd);
    // Health check: the page handle alone is not enough — after a browser-process crash the CDP
    // connection is gone while the Page object still looks open. `connected` is the truth.
    if (this.page && this.projectRoot === roots.root && !this.page.isClosed() && this.browser?.connected) {
      return this.page;
    }
    if (this.browser) await this.close();
    fs.mkdirSync(roots.profile, { recursive: true });
    fs.mkdirSync(roots.evidence, { recursive: true });
    const puppeteer = await import('puppeteer');
    const args = process.env.BIMAX_BROWSER_NO_SANDBOX === '1'
      ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];
    const executablePath = findBrowserExecutable();
    this.browser = await puppeteer.launch({
      // puppeteer 23 removed the `'new'` literal — `true` IS the new headless mode from v22 on.
      // Left as the string, launch throws before Chromium is ever started.
      headless: process.env.BIMAX_BROWSER_HEADFUL !== '1',
      userDataDir: roots.profile,
      args,
      ...(executablePath ? { executablePath } : {}),
    });
    this.projectRoot = roots.root;
    this.page = (await this.browser.pages())[0] || await this.browser.newPage();
    await this.initializePage(this.page);
    await this.initializeDownloads();
    // Task workspace: a live automated browser is a first-class task — visible in the task panel,
    // cancellable (closes the browser). No pause: CDP sessions have no real suspend (honesty rule).
    try {
      const { getTaskRegistry } = require('../core/task.registry');
      const reg = getTaskRegistry();
      const task = reg.create({
        kind: 'browser', title: 'Browser session',
        handle: { cancel: () => { void this.close(); } },
        supports: { cancel: true, pause: false, resume: false },
      });
      this.taskId = task.id;
      reg.transition(task.id, 'starting', 'browser launched');
      reg.transition(task.id, 'running');
    } catch { /* registry optional (tests) */ }
    return this.page;
  }

  /** Deliver one browser click through Chromium's mouse at the target's live clickable point.
   * ElementHandle.click() is convenient, but its opaque scroll/hit-test path can report success
   * when an overlay intercepted the point. We make the geometry and obstruction check explicit,
   * then post exactly one mouse down/up pair (never retry after delivery may have begun). */
  private async clickElementWithMouse(page: Page, target: ElementHandle<Element>): Promise<{ x: number; y: number; target: string }> {
    await target.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
    const point = await target.clickablePoint();
    // Hit-test in the element's OWN document using its own client rect: clickablePoint() is in
    // main-frame viewport coordinates, which are wrong inside an iframe's elementFromPoint.
    const hit = await target.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const p = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const actual = document.elementFromPoint(p.x, p.y);
      const ownsPoint = !!actual && (actual === element || element.contains(actual) || actual.contains(element));
      const describe = (node: Element | null) => {
        if (!node) return '(nothing)';
        const html = node as HTMLElement;
        const name = html.getAttribute('aria-label') || html.getAttribute('title')
          || (html.innerText || html.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        return `${html.tagName.toLowerCase()}${html.id ? `#${html.id}` : ''}${name ? ` "${name}"` : ''}`;
      };
      return { ownsPoint, actual: describe(actual), target: describe(element) };
    });
    if (!hit.ownsPoint) {
      throw new Error(`browser click target is obscured at ${Math.round(point.x)},${Math.round(point.y)}: expected ${hit.target}, hit ${hit.actual}; take a fresh snapshot or dismiss the overlay`);
    }
    await this.deliverMouseClick(page, point.x, point.y);
    return { x: Math.round(point.x), y: Math.round(point.y), target: hit.target };
  }

  /** Chromium may withhold the mouse-release acknowledgement while a JavaScript modal is open.
   * Race that acknowledgement against the dialog event so the caller receives the dialogRef needed
   * to resolve it instead of deadlocking behind the very modal it just opened. */
  private async deliverMouseClick(page: Page, x: number, y: number): Promise<void> {
    let onDialog: (() => void) | undefined;
    const dialogOpened = new Promise<'dialog'>(resolve => {
      onDialog = () => resolve('dialog');
      page.once('dialog', onDialog);
    });
    const inputSession = await page.target().createCDPSession();
    try {
      await inputSession.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y, button: 'none', buttons: 0,
      });
      await inputSession.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
      });
      await delay(8);
      const release = inputSession.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
      }).then(() => 'released' as const);
      const first = await Promise.race([release, dialogOpened]);
      if (first === 'dialog') {
        await this.dialogResolutions.get(page);
        await release;
      } else {
        // CDP can acknowledge input immediately before dispatching the dialog event. Give that
        // event one short task turn so finishAction does not start a blocked DOM observation.
        await Promise.race([dialogOpened, delay(25)]);
      }
    } finally {
      if (onDialog) page.off('dialog', onDialog);
      await inputSession.detach().catch(() => {});
    }
  }

  private async clickViewportPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number; target: string }> {
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      throw new Error(`browser click ${x},${y} is outside the live viewport (${viewport.width}x${viewport.height})`);
    }
    const target = await page.evaluate((point) => {
      const node = document.elementFromPoint(point.x, point.y) as HTMLElement | null;
      if (!node) return '(nothing)';
      const name = node.getAttribute('aria-label') || node.getAttribute('title')
        || (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${name ? ` "${name}"` : ''}`;
    }, { x, y });
    if (target === '(nothing)') throw new Error(`browser click ${x},${y} has no live DOM target; take a fresh screenshot or snapshot`);
    await this.deliverMouseClick(page, x, y);
    return { x: Math.round(x), y: Math.round(y), target };
  }

  /** Capture the interactive-element observation: (re)indexes handles + value-safe metadata.
   * ALWAYS consumes the previous observation first — identity is strictly observation-scoped. */
  private async captureSnapshot(page: Page, filter: string, maxElements: number): Promise<{
    elements: Array<Record<string, unknown>>;
    signatures: string[];
    truncated: boolean;
    target: BrowserDocumentTarget;
  }> {
    await this.clearIndexedElements();
    const candidates = await page.$$('a[href], area[href], button, input:not([type="hidden"]), textarea, select, summary, [contenteditable="true"], [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="treeitem"], [role="gridcell"], [role="option"], [role="switch"], [tabindex]:not([tabindex="-1"]), flt-semantics, flt-semantics-placeholder');
    const elements: Array<Record<string, unknown>> = [];
    for (const handle of candidates) {
      if (elements.length >= maxElements) { await handle.dispose().catch(() => {}); continue; }
      const info = await handle.evaluate(element => {
        const node = element as HTMLElement;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0;
        if (!visible) return null;
        const input = node as HTMLInputElement;
        const type = (input.type || '').toLowerCase();
        const role = node.getAttribute('role') || node.tagName.toLowerCase();
        const name = node.getAttribute('aria-label') || node.getAttribute('alt')
          || node.getAttribute('title') || input.placeholder
          || (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        return {
          tag: node.tagName.toLowerCase(), role, type: type || undefined,
          name: name.slice(0, 500),
          value: type === 'password' ? undefined : (input.value || undefined),
          href: node instanceof HTMLAnchorElement ? node.href : undefined,
          disabled: (node as HTMLButtonElement).disabled || node.getAttribute('aria-disabled') === 'true',
          checked: typeof input.checked === 'boolean' && ['checkbox', 'radio'].includes(type) ? input.checked : undefined,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        };
      }).catch(() => null);
      if (!info || !matchesElementFilter(info as SnapshotElementInfo, filter)) { await handle.dispose().catch(() => {}); continue; }
      const index = elements.length;
      const ref = `bimax-browser-element-${crypto.randomUUID()}`;
      this.indexedElements.set(index, handle);
      this.indexedElementRefs.set(ref, index);
      this.indexedElementMeta.set(index, {
        tag: String(info.tag), role: String(info.role), type: info.type as string | undefined,
        name: String(info.name), value: info.value as string | undefined,
        checked: info.checked as boolean | undefined, disabled: !!info.disabled,
      });
      elements.push({ index, ref, ...info });
    }
    return {
      elements,
      signatures: elements.map(e => elementSignature(e as unknown as SnapshotElementInfo)),
      truncated: candidates.length > maxElements,
      target: this.targetFor(page)!,
    };
  }

  /**
   * The observe→act→observe loop's back half: after a mutating action, wait (bounded,
   * interruptible, first-mutation-exit — never a blind sleep) for the page to react, then capture
   * a FRESH observation and its successor diff against the observation the action consumed.
   * The fresh indexes ship in the same result, so the next reasoning step acts on current state.
   */
  private async observeAfterAction(page: Page, preMutations: number, signal: AbortSignal | undefined, settleMs: number): Promise<Record<string, unknown>> {
    if (settleMs > 0) {
      try {
        const current = await page.evaluate(() => (window as any).__bimaxMutations || 0) as number;
        if (current <= preMutations) {
          let onAbort: (() => void) | undefined;
          const aborted = new Promise<void>(resolve => {
            onAbort = () => resolve();
            signal?.addEventListener('abort', onAbort, { once: true });
          });
          await Promise.race([
            page.waitForFunction(
              (n: number) => ((window as any).__bimaxMutations || 0) > n,
              { timeout: settleMs, polling: 100 },
              preMutations,
            ).catch(() => { /* no mutation within budget — observe anyway */ }),
            aborted,
          ]);
          if (onAbort) signal?.removeEventListener('abort', onAbort);
        }
      } catch { /* settle is best-effort; the observation below is what matters */ }
      if (signal?.aborted) throw new Error('Browser action interrupted.');
    }
    const filter = this.lastSnapshotFilter;
    const previous = this.lastSnapshotSignatures;
    const captured = await this.captureSnapshot(page, filter, 200);
    const diff = previous !== null ? diffSnapshots(previous, captured.signatures) : null;
    this.lastSnapshotSignatures = captured.signatures;
    return {
      target: captured.target,
      ...(filter ? { filter } : {}),
      elements: captured.elements.slice(0, 60),
      truncated: captured.truncated || captured.elements.length > 60,
      ...(diff ? { diff } : {}),
    };
  }

  /** One-line truth about what the action did to the page, appended to action summaries. */
  private observationNote(observation: Record<string, unknown>): string {
    const diff = observation.diff as SnapshotDiff | undefined;
    if (!diff) return ' Fresh observation attached (no prior snapshot to diff against).';
    return diff.changed
      ? ` Page updated: +${diff.addedCount} −${diff.removedCount} element(s); fresh indexes attached.`
      : ' Page elements unchanged; fresh indexes attached.';
  }

  /** Close stray pages (popups, target=_blank tabs) beyond MAX_PAGES, never the driven page.
   * Newest strays survive — a popup the flow just opened may matter; hour-old ones do not. */
  private async prunePages(): Promise<void> {
    if (!this.browser?.connected) return;
    try {
      const pages = await this.browser.pages();
      const strays = pages.filter(p => p !== this.page && !p.isClosed());
      const excess = pages.length - MAX_PAGES;
      if (excess <= 0) return;
      await Promise.all(strays.slice(0, excess).map(p => p.close().catch(() => {})));
    } catch { /* pruning is hygiene, never a turn-breaker */ }
  }

  private async retry<T>(attempts: number, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<{ value: T; attempts: number }> {
    let error: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try { return { value: await fn(), attempts: attempt }; }
      catch (caught) {
        error = caught;
        if (attempt === attempts || signal?.aborted) break;
        await delay(Math.min(2500, 300 * (2 ** (attempt - 1))), signal);
      }
    }
    throw error;
  }

  /** Consecutive-failure memory: the last failed action's key and how many times in a row it
   * failed. Any success clears it. Powers the "stop repeating this exact action" nudge. */
  private failureLoop: { key: string; count: number } | null = null;

  async run(command: BrowserCommand, context: { cwd?: string; signal?: AbortSignal } = {}): Promise<BrowserCommandResult> {
    const result = await this.dispatch(command, context);
    if (result.ok) {
      this.failureLoop = null;
      return result;
    }
    const key = browserActionKey(command);
    this.failureLoop = this.failureLoop?.key === key
      ? { key, count: this.failureLoop.count + 1 }
      : { key, count: 1 };
    if (this.failureLoop.count >= FAILURE_LOOP_THRESHOLD) {
      result.summary += ` This exact action has now failed ${this.failureLoop.count} times in a row — repeating it is unlikely to work. Take a fresh snapshot and try a different element, selector, or route.`;
    }
    return result;
  }

  private async dispatch(command: BrowserCommand, context: { cwd?: string; signal?: AbortSignal } = {}): Promise<BrowserCommandResult> {
    const started = Date.now();
    const cwd = path.resolve(context.cwd || process.cwd());
    const timeout = boundedInt(command.timeout, DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS);
    const maxAttempts = boundedInt(command.retries, 2, 1, 4);
    let attempts = 1;
    let response: HTTPResponse | null;
    const base = (ok: boolean, summary: string, data?: unknown): BrowserCommandResult => ({
      ok, action: command.action, url: this.page?.url(), status: this.lastStatus,
      summary, data, consoleErrors: this.consoleErrors.slice(-20), failedRequests: this.failedRequests.slice(-20),
      attempts, durationMs: Date.now() - started, target: this.targetFor(),
      ...(this.pendingDialogInfo() ? { dialog: this.pendingDialogInfo()! } : {}),
    });

    try {
      if (command.action === 'close') {
        await this.close();
        return base(true, 'Persistent browser closed cleanly.');
      }
      const page = await this.ensure(cwd);
      page.setDefaultTimeout(timeout);
      if (context.signal?.aborted) throw new Error('Browser action interrupted.');
      const targetCheck = this.preflightTarget(command);
      if (!targetCheck.ok) return base(false, targetCheck.error);
      const beforeTarget = this.targetFor(page)!;

      // Observe→act→observe: mutating actions consume the current observation and return a fresh
      // one. Read the page's mutation counter BEFORE acting so the settle wait can end at the
      // first post-action mutation instead of sleeping blind.
      const isMutatingAction = [
        'click', 'type', 'press', 'select', 'hover', 'upload',
      ].includes(command.action);
      const settleMs = boundedInt(command.settleMs, 800, 0, 5000);
      const preMutations = isMutatingAction
        ? (await page.evaluate(() => (window as any).__bimaxMutations || 0).catch(() => 0)) as number
        : 0;
      const finishAction = async (ok: boolean, summary: string, extra?: Record<string, unknown>): Promise<BrowserCommandResult> => {
        // A JavaScript dialog blocks every DOM/CDP evaluation in its page. Returning its exact
        // typed ref is the only honest post-action observation; DOM observation resumes after the
        // caller accepts or dismisses it. Waiting here would deadlock until the page timeout.
        const observation = this.pendingDialogs.has(page) ? null
          : await this.observeAfterAction(page, preMutations, context.signal, settleMs)
            .catch((e: any) => { if (context.signal?.aborted) throw e; return null; });
        this.checkpoint(cwd);
        const afterTarget = this.targetFor(page)!;
        const navigation: BrowserNavigationOutcome | undefined = beforeTarget.documentRef !== afterTarget.documentRef
          ? {
            kind: 'action', from: beforeTarget, to: afterTarget, url: page.url(),
            documentChanged: true, status: this.lastStatus,
          } : undefined;
        const download = this.downloadInfos().find(item => item.startedAt >= started);
        const dialog = this.recentDialogs.find(item => item.openedAt >= started);
        return { ...base(ok, `${summary}${observation ? this.observationNote(observation) : ''}`, {
          ...(extra || {}),
          ...(observation ? { observation } : {}),
        }), ...(navigation ? { navigation } : {}), ...(download ? { download } : {}),
        ...(dialog ? { dialog: { ...dialog } } : {}) };
      };

      switch (command.action) {
        case 'navigate': {
          const check = validateBrowserUrl(String(command.url || ''), command.allowPrivate === true);
          if (!check.ok) return base(false, check.reason);
          const run = await this.retry(maxAttempts, context.signal, async () => {
            const result = await page.goto(check.url.toString(), { waitUntil: command.waitUntil || 'networkidle2', timeout });
            if (!result) throw new Error('Navigation returned no response.');
            return result;
          });
          response = run.value; attempts = run.attempts; this.lastStatus = response.status();
          await this.clearIndexedElements();
          await this.prunePages();
          const title = await page.title();
          this.checkpoint(cwd);
          return {
            ...base(response.ok(), `Loaded ${page.url()} (${response.status()})`), title,
            navigation: this.navigationOutcome('navigate', beforeTarget, page, response.status()),
          };
        }
        case 'snapshot': {
          await this.prunePages();
          const maxElements = boundedInt(command.maxElements, 200, 1, 1000);
          const filter = (command.filter || '').trim();
          const captured = await this.captureSnapshot(page, filter, maxElements);
          // Successor diff (Pi): what appeared/disappeared since the previous same-filter snapshot,
          // so the model reads "what my action changed" instead of re-scanning the whole list.
          const diff = this.lastSnapshotSignatures !== null && this.lastSnapshotFilter === filter
            ? diffSnapshots(this.lastSnapshotSignatures, captured.signatures)
            : null;
          this.lastSnapshotSignatures = captured.signatures;
          this.lastSnapshotFilter = filter;
          const bodyText = await page.$eval('body', node => (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20_000));
          return {
            ...base(true, `Captured ${captured.elements.length} indexed interactive element(s)${filter ? ` matching "${filter}"` : ''}${diff ? ` (${diff.changed ? `since last snapshot: +${diff.addedCount} −${diff.removedCount}` : 'no element changes since last snapshot'})` : ''}. Indexes are valid until your next action, navigation, or snapshot.`, {
              target: captured.target,
              text: bodyText,
              elements: captured.elements,
              truncated: captured.truncated,
              ...(diff ? { diff } : {}),
            }),
            title: await page.title(),
          };
        }
        case 'click': {
          const resolved = this.resolveIndexed(command.elementIndex, command.elementRef);
          if (resolved && 'error' in resolved) return this.staleTargetResult(base, resolved.error);
          const indexed = resolved && 'handle' in resolved ? resolved.handle : null;
          const hasCoordinates = Number.isFinite(command.x) && Number.isFinite(command.y);
          if (!command.selector && !indexed && !hasCoordinates) return base(false, 'click requires selector, elementIndex from snapshot, or x/y coordinates.');
          let click: { x: number; y: number; target: string };
          if (indexed) {
            click = await this.clickElementWithMouse(page, indexed);
          } else if (hasCoordinates) {
            let px = Number(command.x), py = Number(command.y);
            if (command.normalized) {
              const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
              px = denormalizeCoordinate(px, viewport.width);
              py = denormalizeCoordinate(py, viewport.height);
            }
            click = await this.clickViewportPoint(page, px, py);
          } else {
            const located = await this.retry(maxAttempts, context.signal, async () => {
              const target = await page.waitForSelector(command.selector!, { visible: true, timeout });
              if (!target) throw new Error('Browser click target was not found.');
              return target;
            });
            attempts = located.attempts;
            click = await this.clickElementWithMouse(page, located.value);
          }
          return finishAction(true, indexed ? `Mouse-clicked elementIndex ${command.elementIndex} at ${click.x},${click.y}.`
            : hasCoordinates ? `Mouse-clicked ${click.x},${click.y}.` : `Mouse-clicked ${command.selector} at ${click.x},${click.y}.`, { input: click });
        }
        case 'type': {
          const resolved = this.resolveIndexed(command.elementIndex, command.elementRef);
          if (resolved && 'error' in resolved) return this.staleTargetResult(base, resolved.error);
          const indexed = resolved && 'handle' in resolved ? resolved.handle : null;
          if (!command.selector && !indexed) return base(false, 'type requires selector or elementIndex from snapshot.');
          const run = await this.retry(maxAttempts, context.signal, async () => {
            const target = indexed || await page.waitForSelector(command.selector!, { visible: true, timeout });
            if (!target) throw new Error('Type target was not found.');
            if (command.clear !== false) {
              await target.focus();
              await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
              await page.keyboard.press('A');
              await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
              await page.keyboard.press('Backspace');
            }
            await target.type(String(command.text || ''));
          });
          attempts = run.attempts;
          return finishAction(true, `Typed ${String(command.text || '').length} character(s) into ${indexed ? `elementIndex ${command.elementIndex}` : command.selector}.`);
        }
        case 'press': {
          if (!command.key) return base(false, 'press requires key.');
          const resolved = this.resolveIndexed(command.elementIndex, command.elementRef);
          if (resolved && 'error' in resolved) return this.staleTargetResult(base, resolved.error);
          const indexed = resolved && 'handle' in resolved ? resolved.handle : null;
          if (indexed) await indexed.focus();
          else if (command.selector) {
            const target = await page.waitForSelector(command.selector, { visible: true, timeout });
            if (!target) return base(false, `Press target not found: ${command.selector}`);
            await target.focus();
          }
          await page.keyboard.press(command.key as any);
          return finishAction(true, `Pressed ${command.key}${indexed ? ` on elementIndex ${command.elementIndex}` : ''}.`);
        }
        case 'select': {
          const resolved = this.resolveIndexed(command.elementIndex, command.elementRef);
          if (resolved && 'error' in resolved) return this.staleTargetResult(base, resolved.error);
          const indexed = resolved && 'handle' in resolved ? resolved.handle : null;
          if (!command.selector && !indexed) return base(false, 'select requires selector or elementIndex from snapshot.');
          if (!command.values?.length) return base(false, 'select requires at least one value.');
          const target = indexed || await page.waitForSelector(command.selector!, { visible: true, timeout });
          if (!target) return base(false, 'Select target was not found.');
          const selected = await (target as ElementHandle<HTMLSelectElement>).select(...command.values);
          return finishAction(true, `Selected ${selected.join(', ') || '(none)'}.`, { selected });
        }
        case 'hover': {
          const resolved = this.resolveIndexed(command.elementIndex, command.elementRef);
          if (resolved && 'error' in resolved) return this.staleTargetResult(base, resolved.error);
          const indexed = resolved && 'handle' in resolved ? resolved.handle : null;
          if (!command.selector && !indexed) return base(false, 'hover requires selector or elementIndex from snapshot.');
          const target = indexed || await page.waitForSelector(command.selector!, { visible: true, timeout });
          if (!target) return base(false, 'Hover target was not found.');
          await target.hover();
          return finishAction(true, `Hovered ${indexed ? `elementIndex ${command.elementIndex}` : command.selector}.`);
        }
        case 'scroll': {
          const pixels = boundedInt(command.pixels, 700, -20_000, 20_000);
          await page.evaluate(value => window.scrollBy(0, value), pixels);
          return base(true, `Scrolled ${pixels}px.`);
        }
        case 'wait': {
          if (command.forChange) {
            // Change detection (Pi wait_for): resolve on the first DOM mutation instead of
            // sleeping blind; report truthfully when nothing changed within the budget.
            const changed = await page.evaluate(budgetMs => new Promise<boolean>(resolve => {
              const observer = new MutationObserver(() => { observer.disconnect(); resolve(true); });
              observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
              setTimeout(() => { observer.disconnect(); resolve(false); }, budgetMs);
            }), timeout);
            return base(changed, changed ? 'DOM changed.' : `No DOM change within ${timeout}ms.`);
          }
          if (command.selector) await page.waitForSelector(command.selector, { timeout });
          else await delay(timeout, context.signal);
          return base(true, command.selector ? `Found ${command.selector}.` : `Waited ${timeout}ms.`);
        }
        case 'viewport': {
          const width = boundedInt(command.width, 1440, 320, 7680);
          const height = boundedInt(command.height, 900, 240, 4320);
          await page.setViewport({ width, height, deviceScaleFactor: 1 });
          return base(true, `Viewport set to ${width}×${height}.`);
        }
        case 'upload': {
          if (!command.selector || !command.path) return base(false, 'upload requires selector and path.');
          const target = path.resolve(cwd, command.path);
          if (!within(cwd, target)) return base(false, 'Upload path must stay inside the active workspace.');
          if (!fs.statSync(target).isFile()) return base(false, `Upload file not found: ${target}`);
          const input = await page.waitForSelector(command.selector, { timeout });
          const handle = input?.asElement();
          if (!handle) return base(false, `Upload selector is not an element: ${command.selector}`);
          await (handle as any).uploadFile(target);
          return finishAction(true, `Uploaded ${path.relative(cwd, target)} through ${command.selector}.`);
        }
        case 'back':
          response = await page.goBack({ waitUntil: command.waitUntil || 'networkidle2', timeout });
          await this.clearIndexedElements();
          this.lastStatus = response?.status(); this.checkpoint(cwd);
          return response ? {
            ...base(response.ok(), `Navigated back to ${page.url()}.`),
            navigation: this.navigationOutcome('back', beforeTarget, page, response.status()),
          } : base(false, 'No browser history entry was available to navigate back to.');
        case 'reload':
          response = await page.reload({ waitUntil: command.waitUntil || 'networkidle2', timeout });
          await this.clearIndexedElements();
          this.lastStatus = response?.status(); this.checkpoint(cwd);
          return {
            ...base(!!response?.ok(), `Reloaded ${page.url()}.`),
            navigation: this.navigationOutcome('reload', beforeTarget, page, response?.status()),
          };
        case 'tabs': {
          const tabs = await this.tabInfos();
          return base(true, `Found ${tabs.length} live browser tab(s).`, { tabs });
        }
        case 'switch_tab': {
          if (!command.tabRef) return base(false, 'switch_tab requires tabRef from tabs.');
          const targetPage = this.pagesByTabRef.get(command.tabRef);
          if (!targetPage || targetPage.isClosed()) return base(false, 'tabRef is stale. Call tabs for current refs.');
          await this.clearIndexedElements();
          this.page = targetPage;
          await this.initializePage(targetPage);
          await targetPage.bringToFront();
          this.lastSnapshotSignatures = null;
          this.checkpoint(cwd);
          const active = (await this.tabInfos()).find(tab => tab.tabRef === command.tabRef)!;
          return { ...base(true, `Switched to tab at ${targetPage.url()}.`, { tab: active }), title: active.title };
        }
        case 'close_tab': {
          if (!command.tabRef) return base(false, 'close_tab requires tabRef from tabs.');
          const targetPage = this.pagesByTabRef.get(command.tabRef);
          if (!targetPage || targetPage.isClosed()) return base(false, 'tabRef is stale. Call tabs for current refs.');
          const closingActive = targetPage === this.page;
          await targetPage.close();
          if (closingActive) {
            const remaining = await this.syncPages();
            this.page = remaining.at(-1) || await this.browser!.newPage();
            await this.initializePage(this.page);
            await this.page.bringToFront();
            await this.clearIndexedElements();
            this.lastSnapshotSignatures = null;
          }
          const tabs = await this.tabInfos();
          this.checkpoint(cwd);
          return base(true, `Closed browser tab; ${tabs.length} tab(s) remain.`, { tabs });
        }
        case 'dialogs': {
          const pending = Array.from(this.pendingDialogs.entries())
            .filter(([dialogPage]) => !dialogPage.isClosed())
            .map(([, pending]) => ({ ...pending.info }));
          const dialogs = [...pending, ...this.recentDialogs]
            .filter((dialog, index, all) => all.findIndex(item => item.dialogRef === dialog.dialogRef) === index)
            .slice(0, 50);
          return base(true, `Found ${dialogs.length} recorded browser dialog(s).`, { dialogs });
        }
        case 'download_prepare': {
          if (!command.path) return base(false, 'download_prepare requires a destination directory path.');
          if (this.armedDownload) return base(false, 'A one-shot download permit is already armed. Trigger it or close the browser before arming another.');
          const resolved = resolveBrowserWorkspacePath(cwd, command.path);
          if (!resolved.ok) return base(false, resolved.reason);
          const requestedMax = command.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
          if (!Number.isInteger(requestedMax) || requestedMax < 1 || requestedMax > MAX_DOWNLOAD_BYTES) {
            return base(false, `maxBytes must be an integer from 1 to ${MAX_DOWNLOAD_BYTES}.`);
          }
          fs.mkdirSync(resolved.path, { recursive: true });
          const permit: ArmedBrowserDownload = {
            root: resolved.path, maxBytes: requestedMax, target: beforeTarget,
          };
          this.armedDownload = permit;
          try {
            await this.downloadSession!.send('Browser.setDownloadBehavior', {
              behavior: 'allowAndName', downloadPath: resolved.path, eventsEnabled: true,
            });
          } catch (error) {
            this.armedDownload = null;
            throw error;
          }
          return base(true, `Armed one download to ${path.relative(cwd, resolved.path)} with a ${requestedMax}-byte limit.`, {
            prepared: { ...beforeTarget, path: path.relative(cwd, resolved.path), maxBytes: requestedMax, oneShot: true },
          });
        }
        case 'downloads': {
          const downloads = this.downloadInfos();
          return base(true, `Found ${downloads.length} recorded browser download(s).`, { downloads });
        }
        case 'download_wait': {
          if (!command.downloadRef) return base(false, 'download_wait requires downloadRef from downloads or the triggering action result.');
          let record = this.downloadRecords.get(command.downloadRef);
          if (!record) return base(false, 'downloadRef is stale or unknown. Call downloads for current records.');
          const deadline = Date.now() + timeout;
          while (record.info.state === 'in_progress' && Date.now() < deadline) {
            await delay(Math.min(100, Math.max(1, deadline - Date.now())), context.signal);
            record = this.downloadRecords.get(command.downloadRef)!;
          }
          const done = record.info.state !== 'in_progress';
          const ok = record.info.state === 'completed';
          return {
            ...base(ok, done
              ? `Download ${record.info.state}${record.info.path ? ` at ${record.info.path}` : ''}.`
              : `Download is still in progress after ${timeout}ms.`, { download: { ...record.info } }),
            download: { ...record.info },
          };
        }
        case 'download_cancel': {
          if (!command.downloadRef) return base(false, 'download_cancel requires downloadRef from downloads.');
          const record = this.downloadRecords.get(command.downloadRef);
          if (!record) return base(false, 'downloadRef is stale or unknown. Call downloads for current records.');
          if (record.info.state !== 'in_progress') {
            return { ...base(false, `Download is already ${record.info.state}.`, { download: { ...record.info } }), download: { ...record.info } };
          }
          await this.downloadSession!.send('Browser.cancelDownload', { guid: record.guid });
          record.info.state = 'canceled';
          record.info.error = 'Canceled by BrowserTool.';
          record.info.completedAt = Date.now();
          fs.rmSync(record.internalPath, { force: true });
          this.downloadRefsByGuid.delete(record.guid);
          await this.denyDownloads();
          return { ...base(true, 'Canceled browser download.', { download: { ...record.info } }), download: { ...record.info } };
        }
        case 'inspect': {
          const selector = command.selector || 'body';
          const data = await page.$eval(selector, element => ({
            tag: element.tagName.toLowerCase(),
            text: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20_000),
            html: element.outerHTML.slice(0, 20_000),
          }));
          return { ...base(true, `Inspected ${selector}.`, data), title: await page.title() };
        }
        case 'screenshot': {
          const roots = this.roots(cwd);
          const requested = command.path ? path.resolve(cwd, command.path) : path.join(
            roots.evidence, `${Date.now()}-${safeName(await page.title())}.png`,
          );
          if (!within(cwd, requested)) return base(false, 'Screenshot path must stay inside the active workspace.');
          fs.mkdirSync(path.dirname(requested), { recursive: true });
          await page.screenshot({ path: requested, fullPage: command.fullPage !== false });
          this.checkpoint(cwd);
          return { ...base(true, `Captured screenshot ${path.relative(cwd, requested)}.`), screenshot: requested, title: await page.title() };
        }
        case 'compare': {
          if (!command.baseline) return base(false, 'compare requires a baseline path.');
          const roots = this.roots(cwd);
          const baseline = path.resolve(cwd, command.baseline);
          if (!within(cwd, baseline)) return base(false, 'Baseline path must stay inside the active workspace.');
          if (!fs.existsSync(baseline)) return base(false, `Baseline does not exist: ${path.relative(cwd, baseline)}`);
          const actual = path.join(roots.evidence, `${Date.now()}-${safeName(await page.title())}-comparison.png`);
          fs.mkdirSync(path.dirname(actual), { recursive: true });
          const bytes = Buffer.from(await page.screenshot({ path: actual, fullPage: command.fullPage !== false }));
          const expectedBytes = fs.readFileSync(baseline);
          const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
          const baselineSha256 = crypto.createHash('sha256').update(expectedBytes).digest('hex');
          const identical = bytes.equals(expectedBytes);
          this.checkpoint(cwd);
          return {
            ...base(identical, identical ? 'Screenshot exactly matches the visual baseline.' : 'Screenshot differs from the visual baseline.', {
              baseline: path.relative(cwd, baseline), actual: path.relative(cwd, actual),
              baselineSha256, actualSha256, exactMatch: identical,
            }),
            screenshot: actual,
            title: await page.title(),
          };
        }
        case 'assert': {
          const assertion = command.assertion || {};
          const checks: Array<{ check: string; ok: boolean; actual?: unknown }> = [];
          if (assertion.selector) {
            const element = await page.$(assertion.selector);
            const exists = !!element;
            checks.push({ check: `${assertion.selector} ${assertion.exists === false ? 'absent' : 'exists'}`, ok: assertion.exists === false ? !exists : exists, actual: exists });
            if (assertion.textIncludes !== undefined) {
              const text = element ? await page.$eval(assertion.selector, node => (node.textContent || '').replace(/\s+/g, ' ').trim()) : '';
              checks.push({ check: `${assertion.selector} text includes ${JSON.stringify(assertion.textIncludes)}`, ok: text.includes(assertion.textIncludes), actual: text.slice(0, 1000) });
            }
          } else if (assertion.textIncludes !== undefined) {
            const text = await page.$eval('body', node => (node.textContent || '').replace(/\s+/g, ' ').trim());
            checks.push({ check: `body text includes ${JSON.stringify(assertion.textIncludes)}`, ok: text.includes(assertion.textIncludes), actual: text.slice(0, 1000) });
          }
          if (assertion.urlIncludes !== undefined) checks.push({ check: `URL includes ${assertion.urlIncludes}`, ok: page.url().includes(assertion.urlIncludes), actual: page.url() });
          if (assertion.titleIncludes !== undefined) {
            const title = await page.title();
            checks.push({ check: `title includes ${assertion.titleIncludes}`, ok: title.includes(assertion.titleIncludes), actual: title });
          }
          if (assertion.noConsoleErrors) checks.push({ check: 'no console errors', ok: this.consoleErrors.length === 0, actual: this.consoleErrors.slice(-10) });
          if (assertion.noFailedRequests) checks.push({ check: 'no failed requests', ok: this.failedRequests.length === 0, actual: this.failedRequests.slice(-10) });
          if (assertion.statusBelow !== undefined) checks.push({ check: `status below ${assertion.statusBelow}`, ok: this.lastStatus !== undefined && this.lastStatus < assertion.statusBelow, actual: this.lastStatus });
          if (checks.length === 0) return base(false, 'assert requires at least one concrete assertion.');
          const ok = checks.every(check => check.ok);
          return { ...base(ok, `${checks.filter(check => check.ok).length}/${checks.length} browser assertion(s) passed.`, checks), title: await page.title() };
        }
        case 'status': {
          return { ...base(true, `Browser is open at ${page.url()}.`, {
            viewport: page.viewport(), stateFile: this.roots(cwd).state,
          }), title: await page.title() };
        }
      }
      return base(false, `Unsupported browser action: ${String((command as { action?: unknown }).action)}.`);
    } catch (error: any) {
      const message = String(error?.message || error);
      // The browser process (or its CDP connection) died. Reset fully: keeping the dead handle
      // would fail every later action forever; a reset means the next action relaunches with the
      // same persistent profile, so cookies/logins survive the crash.
      if (isBrowserCrashError(message)) {
        await this.close();
        return base(false, `Browser disconnected mid-action (${message.slice(0, 160)}). The runtime was reset — your next action relaunches the browser with the same profile; take a fresh snapshot before acting.`);
      }
      // A failed action attempt still CONSUMED its observation — the page may have half-reacted,
      // so surviving indexes would be lies. Invalidate; the caller re-observes with a snapshot.
      if (['click', 'type', 'press', 'select', 'hover', 'upload'].includes(command.action)) {
        await this.clearIndexedElements();
        this.lastSnapshotSignatures = null;
      }
      this.checkpoint(cwd);
      return base(false, message);
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    const downloadSession = this.downloadSession;
    await this.clearIndexedElements();
    this.lastSnapshotSignatures = null;
    this.lastSnapshotFilter = '';
    this.page = null; this.browser = null; this.projectRoot = '';
    this.downloadSession = null;
    this.armedDownload = null;
    this.failureLoop = null;
    // Close out the browser task honestly: cancelled if a cancel was requested, completed otherwise.
    if (this.taskId) {
      try {
        const { getTaskRegistry } = require('../core/task.registry');
        const reg = getTaskRegistry();
        const t = reg.get(this.taskId);
        if (t && t.state === 'cancelling') reg.transition(this.taskId, 'cancelled', 'browser closed');
        else if (t && !['cancelled', 'completed', 'failed', 'failed-resumable'].includes(t.state)) {
          reg.transition(this.taskId, 'completed', 'browser closed');
        }
      } catch { /* registry optional */ }
      this.taskId = null;
    }
    if (browser) {
      // Bounded close: on a crashed browser the graceful close can hang on a dead CDP socket.
      // After the budget, hard-kill the child so a long session never accumulates zombie Chromes.
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise<void>(resolve => setTimeout(resolve, 3000)),
      ]);
      try { browser.process()?.kill('SIGKILL'); } catch { /* already gone */ }
    }
    this.tabRefs.clear();
    this.pagesByTabRef.clear();
    this.documentRefs.clear();
    this.pendingDialogs.clear();
    this.dialogResolutions.clear();
    this.recentDialogs.length = 0;
    for (const record of this.downloadRecords.values()) {
      if (record.info.state === 'in_progress') fs.rmSync(record.internalPath, { force: true });
    }
    this.downloadRecords.clear();
    this.downloadRefsByGuid.clear();
    await downloadSession?.detach().catch(() => {});
  }
}

export const globalBrowserRuntime = new BrowserRuntime();
