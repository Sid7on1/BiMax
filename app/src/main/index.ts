import { app, BrowserWindow, ipcMain, dialog, shell, session, systemPreferences, powerMonitor, net, nativeTheme } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { FSWatcher, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import {
  spawnEngineProcess, recentEngineLog, engineProcessProvenance,
} from './engine';
import { buildDiagnosticExport } from './diagnostic.export';
import { DesktopEvidenceStore } from './evidence.store';
import { buildEvidenceTimeline, retentionControls } from '../shared/evidence.timeline';
import type { WindowChromeState } from '../shared/window.chrome';
import { EngineSupervisor } from './supervisor/supervisor';
import { CrashJournal } from './supervisor/journal';
import { SupervisorStatus } from './supervisor/types';
import { gitStatus, gitDiff, gitBranches, gitLog, gitRemoteInfo, gitFetch, gitPull, gitPush } from './git';
import { discoverLocalModels } from './local.models';
import { listDir, readFilePreview, writeFileContent, readSessionMeta, watchProject, searchFiles } from './files';
import { createPty, writePty, resizePty, killPty, killAllPtys } from './pty';
import { pickInitialProject, loadSettings, recordProject, recentProjects, isRealProject } from './settings';
import {
  REQUIRED_WEB_PREFERENCES, RENDERER_CSP, InvalidPayloadError,
  isTrustedSender, isAllowedNavigation, isAllowedPermission,
  asBoundedInt, asFileContent, asPtyInput, asSupervisorAction,
  isProtocolFrame, resolveWithinRoot,
  type SenderIdentity, type TrustedRenderer,
} from './security';
import {
  AdaptiveRuntimePolicy, renderingPolicy,
  type AdaptiveDecision, type RuntimeSignals, type ThermalState,
} from '../phase9/adaptive.policy';
import {
  inspectAlchemistCapabilities, inspectEnvironmentCapabilities,
  type AlchemistCapabilitySnapshot, type EnvironmentCapabilitySnapshot,
} from '../phase9/workspace.capabilities';
import {
  configureProviderCredential, loadProviderCredentials, providerCredentialEnvironment,
  providerCredentialStatuses,
} from './provider.credentials';

/**
 * Bimax desktop shell. One window, ONE authoritative EngineSupervisor owning the engine child
 * lifecycle (spawn/monitor/recover/resume — see supervisor/supervisor.ts). The renderer never
 * touches Node — everything crosses the contextBridge in preload/index.ts:
 *   renderer → main:  'engine:send' (protocol Inbound msg), 'app:pick-folder',
 *                     'supervisor:*' (typed recovery actions + diagnostics),
 *                     git:/files:/pty: (Electron-native Review/Files/Terminal subsystems)
 *   main → renderer:  'engine:msg' (protocol Outbound msg), 'engine:state' (legacy 3-state),
 *                     'supervisor:status' (full typed lifecycle), 'app:project',
 *                     'files:changed', 'pty:data', 'pty:exit'
 */

let win: BrowserWindow | null = null;
let supervisor: EngineSupervisor | null = null;
let projectWatcher: FSWatcher | null = null;
let lastStatus: SupervisorStatus | null = null;
let latestUiSnapshot: unknown = null;
let latestReviewSnapshot: unknown = null;

// Phase 9 S29-F: one automatic decision class. Other runtime/rendering decisions are reported in
// shadow mode; Reduce Motion remains a hard renderer constraint. `off` is the explicit override.
const adaptivePolicy = new AdaptiveRuntimePolicy({
  canaryEnabled: process.env.BIMAX_ADAPTIVE_CONCURRENCY !== 'off',
});
let thermalState: ThermalState = 'unknown';
let lastInteractionAt = Number.NEGATIVE_INFINITY;
let reduceMotion = false;
let capabilityCache: {
  project: string;
  at: number;
  environment: EnvironmentCapabilitySnapshot;
  alchemist: AlchemistCapabilitySnapshot;
} | null = null;

async function workspaceCapabilities(): Promise<{
  environment: EnvironmentCapabilitySnapshot;
  alchemist: AlchemistCapabilitySnapshot;
} | null> {
  const project = projectDir();
  if (!project) return null;
  if (capabilityCache && capabilityCache.project === project && Date.now() - capabilityCache.at < 30_000) {
    return capabilityCache;
  }
  const environment = await inspectEnvironmentCapabilities(project);
  const alchemist = await inspectAlchemistCapabilities(environment);
  capabilityCache = { project, at: Date.now(), environment, alchemist };
  return { environment, alchemist };
}

// One packaged Bimax process owns the coding engine. A second launch only brings it forward.
const ownsSingleInstance = app.requestSingleInstanceLock();
if (!ownsSingleInstance) app.quit();

function revealMainWindow(): void {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  if (app.isReady()) createWindow();
}

app.on('second-instance', revealMainWindow);

function currentRuntimeSignals(): RuntimeSignals {
  const totalMb = os.totalmem() / (1024 * 1024);
  const availableMemoryMb = Math.max(0, Math.round(os.freemem() / (1024 * 1024)));
  const freeRatio = totalMb > 0 ? availableMemoryMb / totalMb : 0;
  return {
    observedAt: Date.now(),
    architecture: process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : 'unknown',
    cpuCount: os.cpus().length,
    availableMemoryMb,
    thermal: thermalState,
    memoryPressure: freeRatio < 0.05 ? 'critical' : freeRatio < 0.12 ? 'warning' : 'normal',
    powerSource: powerMonitor.isOnBatteryPower() ? 'battery' : 'ac',
    // Electron has no stable Low Power Mode query. Unknown is explicit; battery state still feeds
    // the bounded controller and the native layer can add the signal later.
    lowPowerMode: null,
    network: net.isOnline() ? 'unknown' : 'offline',
    activeInteraction: Date.now() - lastInteractionAt < 2_000,
    reduceMotion,
    simulatorReservationMb: 0,
    localModelReservationMb: 0,
  };
}

function adaptiveSnapshot(): { signals: RuntimeSignals; decision: AdaptiveDecision; rendering: ReturnType<typeof renderingPolicy> } {
  const signals = currentRuntimeSignals();
  const decision = adaptivePolicy.decide(signals);
  return { signals, decision, rendering: renderingPolicy(signals, false) };
}

function broadcast(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

/**
 * Whether the window currently owns the whole screen.
 *
 * The renderer's translucent surfaces are a *windowed* treatment. Full screen and a zoomed window
 * sit edge-to-edge against nothing, so a blurred panel there samples the app's own opaque body and
 * reads as haze rather than depth — the effect costs a compositor pass and buys nothing. Main owns
 * this fact because only main sees the window's own state events; the renderer cannot observe them.
 */
/**
 * The user's accent colour, as `#rrggbb`.
 *
 * Prompt 2 §14 and §89: accent communicates hierarchy — selected navigation, the active workspace,
 * meaningful state — and it has to be *the user's*, tested across all eight of them, rather than a
 * brand blue that ignores what they chose. Electron reports it as `RRGGBBAA` with no `#`, and the
 * alpha is always FF, so it is trimmed to the form CSS wants.
 *
 * Returns null rather than a fallback when the platform has no such concept: a null lets the CSS
 * keep its own token, whereas a made-up hex would silently become the design.
 */
function accentColour(): string | null {
  try {
    const raw = systemPreferences.getAccentColor?.();
    if (!raw || raw.length < 6) return null;
    return `#${raw.slice(0, 6).toLowerCase()}`;
  } catch {
    // Not every platform has one, and `getAccentColor` throws rather than returning null there.
    return null;
  }
}

function windowChrome(): WindowChromeState {
  if (!win || win.isDestroyed()) {
    return { fullScreen: false, maximized: false, active: true, accent: null };
  }
  return {
    fullScreen: win.isFullScreen(),
    maximized: win.isMaximized(),
    // AppKit's `appearsActive` (Prompt 2 §15). A Mac app that looks identical whether or not it is
    // the key window is the tell that its chrome is drawn rather than native — but the correction
    // is a subtle one, and lives in CSS, because "not focused" must never mean "hard to read".
    active: win.isFocused(),
    accent: accentColour(),
  };
}

// ------------------------------------------------------------------------------------------------
// IPC boundary. Every privileged channel goes through secureHandle/secureOn — there is no
// ipcMain.handle/ipcMain.on below that skips the sender check. Policy itself lives in security.ts
// (Electron-free, unit-tested); this file only binds it to the real event objects.

/** What the main process currently considers its own renderer. Recomputed per message. */
function trustedRenderer(): TrustedRenderer {
  return {
    webContentsId: win && !win.isDestroyed() ? win.webContents.id : null,
    auxiliaryWebContentsIds: [],
    devServerUrl: process.env.ELECTRON_RENDERER_URL,
  };
}

function senderIdentity(event: IpcMainEvent | IpcMainInvokeEvent): SenderIdentity {
  const frame = event.senderFrame;
  return {
    senderId: event.sender.id,
    // A frame that has already been destroyed throws on .url; treat that as untrusted.
    frameUrl: (() => { try { return frame?.url; } catch { return undefined; } })(),
    isMainFrame: !!frame && frame === frame.top,
  };
}

function refuse(channel: string, reason: string): void {
  console.error(`[ipc] refused ${channel}: ${reason}`);
}

/** invoke-style channel: untrusted sender or bad payload resolves to `fallback`, never throws out. */
/**
 * The Desktop evidence store (Phase 8, owner section 28).
 *
 * One per app process. Records arrive from the engine over the protocol and from the Mac capability
 * provider; the renderer only ever reads a derived timeline. Bounded and user-deletable, per §2.4.
 */
const evidenceStore = new DesktopEvidenceStore();

function secureHandle<T>(
  channel: string,
  fallback: T,
  fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!isTrustedSender(senderIdentity(event), trustedRenderer())) {
      refuse(channel, 'untrusted sender');
      return fallback;
    }
    try {
      return await fn(event, ...args);
    } catch (error) {
      if (error instanceof InvalidPayloadError) {
        refuse(channel, error.message);
        return fallback;
      }
      throw error;
    }
  });
}

/** send-style channel: same gate, no reply. */
function secureOn(channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => void): void {
  ipcMain.on(channel, (event, ...args: unknown[]) => {
    if (!isTrustedSender(senderIdentity(event), trustedRenderer())) {
      refuse(channel, 'untrusted sender');
      return;
    }
    try {
      fn(event, ...args);
    } catch (error) {
      if (error instanceof InvalidPayloadError) refuse(channel, error.message);
      else throw error;
    }
  });
}

// The old 3-state wire ('starting'|'ready'|'exited') stays for renderer parts that only need
// coarse liveness; the full lifecycle rides 'supervisor:status'.
function legacyState(s: SupervisorStatus): { state: string; detail: string } | null {
  switch (s.phase) {
    case 'idle': return null;
    case 'ready':
    case 'degraded': return { state: 'ready', detail: s.message };
    case 'exited':
    case 'failed': return { state: 'exited', detail: s.reason };
    default: return { state: 'starting', detail: s.message };
  }
}

function createSupervisor(): EngineSupervisor {
  const journalPath = path.join(app.getPath('userData'), 'crash-journal.json');
  const journal = new CrashJournal({
    load: () => {
      try { return readFileSync(journalPath, 'utf8'); } catch { return null; }
    },
    save: (text: string) => {
      // Atomic: a crash mid-write must never leave a truncated journal.
      mkdirSync(path.dirname(journalPath), { recursive: true });
      const tmp = `${journalPath}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, journalPath);
    },
  });

  return new EngineSupervisor({
    spawn: (project, extraEnv, callbacks) => {
      const adaptive = adaptiveSnapshot();
      return spawnEngineProcess(project, {
        ...extraEnv,
        ...adaptivePolicy.engineEnvironment(adaptive.decision),
        // Keychain-backed secrets enter only at the child boundary. They never pass through the
        // renderer or the engine protocol and are not written to diagnostics.
        ...providerCredentialEnvironment(),
      }, callbacks);
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
    random: () => Math.random(),
    memory: () => ({ freeBytes: os.freemem(), totalBytes: os.totalmem() }),
    env: process.env,
    journal,
    logTail: () => recentEngineLog(),
    onStatus: (status) => {
      lastStatus = status;
      broadcast('supervisor:status', status);
      const legacy = legacyState(status);
      if (legacy) broadcast('engine:state', legacy.state, legacy.detail);
    },
    onMessage: (msg: any) => {
      if (msg?.t === 'event' && msg.name === 'ui_snapshot') latestUiSnapshot = msg;
      if (msg?.t === 'event' && msg.name === 'review_update') latestReviewSnapshot = msg;
      broadcast('engine:msg', msg);
    },
    // Notices reuse the renderer's existing diagnostics pipeline (the 'log' event fold), so they
    // show up in the Health panel without a parallel plumbing path.
    onNotice: (level, text) => {
      broadcast('engine:msg', {
        t: 'event',
        name: 'log',
        args: [{ id: `sup-${Date.now()}`, level, text: `[supervisor] ${text}`, timestamp: new Date().toISOString() }],
      });
    },
  });
}

function startEngine(projectDir: string): void {
  latestUiSnapshot = null;
  latestReviewSnapshot = null;
  capabilityCache = null;
  // macOS: window-all-closed disposes the supervisor but the app lives on — reopening a window
  // (dock click → activate) needs a fresh instance, since a disposed supervisor never respawns.
  if (!supervisor) supervisor = createSupervisor();
  supervisor.openProject(projectDir);
  projectWatcher?.close();
  projectWatcher = watchProject(projectDir, () => broadcast('files:changed'));
  broadcast('app:project', projectDir);
  // Persist so the NEXT launch resumes here instead of defaulting to $HOME (P0.1).
  recordProject(projectDir);
}

// The active project for native git/files/pty reads. Empty string when no project is open (the
// renderer shows the project-first welcome then) — never $HOME, which caused the Git/genome errors.
function projectDir(): string {
  return supervisor?.currentProject ?? '';
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'Bimax',
    // Fully transparent, and deliberately so: macOS paints the vibrancy material *behind* the web
    // contents, so any opaque window background hides it completely. That is exactly why the
    // sidebar's `backdrop-filter` had nothing to sample but our own `--color-bg` and rendered as a
    // flat grey panel. The renderer keeps `body` transparent and paints every surface that is NOT
    // meant to be glass (see styles.css); this colour is only what shows before the first paint.
    backgroundColor: '#00000000',
    vibrancy: process.platform === 'darwin' ? 'sidebar' : undefined,
    visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      ...REQUIRED_WEB_PREFERENCES,
    },
  });

  // Keep the renderer's chrome-dependent styling in step with the real window state. `resize` is
  // deliberately not in this list: zoom and full screen already emit their own events, and a
  // per-frame broadcast during a drag would repaint the sidebar continuously for no new fact.
  const sendChrome = (): void => {
    const chrome = windowChrome();
    // Full screen and zoomed windows have nothing behind them worth sampling, and the renderer
    // paints the sidebar solid there anyway — so stop paying for the material as well as hiding it.
    if (process.platform === 'darwin' && win && !win.isDestroyed()) {
      win.setVibrancy(chrome.fullScreen || chrome.maximized ? null : 'sidebar');
    }
    broadcast('window:chrome', chrome);
  };
  win.on('enter-full-screen', sendChrome);
  win.on('leave-full-screen', sendChrome);
  win.on('maximize', sendChrome);
  win.on('unmaximize', sendChrome);
  win.on('restore', sendChrome);
  // Key-window state (Prompt 2 §15), and the moment the user is most likely to have just changed
  // their accent colour in System Settings — they left, changed it, and came back.
  win.on('focus', sendChrome);
  win.on('blur', sendChrome);

  // External links open in the system browser, never inside the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The window may only ever be on its own renderer document. A markdown link, a redirect, or a
  // file dropped onto the window cannot navigate the shell out of its own origin — an http: target
  // goes to the system browser instead, exactly like window.open above.
  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url, trustedRenderer())) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    else refuse('will-navigate', url);
  });

  // webviewTag is off, so this should be unreachable; denying it anyway keeps the guarantee from
  // depending on one webPreferences key staying false.
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    refuse('will-attach-webview', 'webviews are not part of this product');
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => { win = null; });
}

/**
 * Session-level guards, installed before the first window loads. The renderer's index.html also
 * carries a CSP meta tag; this header is the copy the renderer cannot edit, and it is what actually
 * governs the packaged file: document. Permissions are denied wholesale — see security.ts.
 */
function hardenSession(): void {
  const ses = session.defaultSession;

  ses.webRequest.onHeadersReceived((details, callback) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    const csp = devUrl
      ? `default-src 'self' ${devUrl}; script-src 'self' 'unsafe-eval' 'unsafe-inline' ${devUrl}; style-src 'self' 'unsafe-inline' ${devUrl}; img-src 'self' data: file: ${devUrl}; font-src 'self' data: ${devUrl}; connect-src 'self' ${devUrl} ws: http:; object-src 'none'; frame-src 'none'; worker-src 'self' blob:; base-uri 'none'; form-action 'none';`
      : RENDERER_CSP;
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    if (!isAllowedPermission()) refuse('permission-request', permission);
    callback(isAllowedPermission());
  });
  ses.setPermissionCheckHandler(() => isAllowedPermission());
}

app.whenReady().then(async () => {
  hardenSession();
  // safeStorage can consult Keychain only after ready. Load before constructing the supervisor so
  // the first engine generation receives the selected provider and its credential.
  loadProviderCredentials();
  // This is an OS-published pressure signal, not a polling guess. It is intentionally kept in
  // main: the renderer may report interaction/accessibility preference but cannot manufacture the
  // thermal state that controls engine concurrency.
  if (process.platform === 'darwin') {
    powerMonitor.on('thermal-state-change', ({ state }) => {
      thermalState = state;
      broadcast('adaptive:changed', adaptiveSnapshot());
    });
  }
  supervisor = createSupervisor();
  createWindow();

  // Launch project: an env override or the last valid saved project — NEVER $HOME. When null, the
  // renderer shows the project-first welcome and we don't boot an engine in the wrong place (P0.1).
  const initialDir = pickInitialProject(loadSettings().lastProject);

  // Protocol messages from the renderer flow through the supervisor: delivered when the engine is
  // interactive, queued when safe to replay, rejected with a visible notice otherwise. The frame
  // shape is checked here so malformed junk never reaches the engine's parser.
  secureOn('engine:send', (_e, msg: unknown) => {
    if (!isProtocolFrame(msg)) throw new InvalidPayloadError('not a protocol frame');
    supervisor?.sendFromRenderer(msg);
  });

  secureHandle<string | null>('app:pick-folder', null, async () => {
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      title: 'Open Project',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const dir = res.filePaths[0];
    startEngine(dir);
    return dir;
  });

  secureHandle<string>('engine:restart', '', () => {
    // Restart the current project, or re-resolve one if none is open. No valid project → stay on
    // the welcome (never boot $HOME).
    const dir = supervisor?.currentProject || pickInitialProject(loadSettings().lastProject);
    if (dir) startEngine(dir);
    else broadcast('app:project', '');
    return supervisor?.currentProject ?? '';
  });

  secureHandle<unknown[]>('providers:credential-status', [], () => providerCredentialStatuses());
  secureHandle<{ ok: boolean; error?: string }>('providers:configure', { ok: false }, (_e, raw: unknown) => {
    const request = raw as { name?: unknown; apiKey?: unknown; baseURL?: unknown } | null;
    if (!request || typeof request.name !== 'string') throw new InvalidPayloadError('provider name is required');
    if (request.apiKey !== undefined && typeof request.apiKey !== 'string') throw new InvalidPayloadError('provider key must be text');
    if (request.baseURL !== undefined && typeof request.baseURL !== 'string') throw new InvalidPayloadError('provider endpoint must be text');
    try {
      configureProviderCredential({
        name: request.name,
        ...(request.apiKey ? { apiKey: request.apiKey } : {}),
        ...(request.baseURL ? { baseURL: request.baseURL } : {}),
      });
      // A child cannot have its environment mutated in place. Start a new generation with the
      // Keychain-backed key and provider route; the provider pane waits for ready before refresh.
      const dir = supervisor?.currentProject || pickInitialProject(loadSettings().lastProject);
      if (dir) startEngine(dir);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message || error) };
    }
  });

  // Supervisor surface: typed state + validated recovery actions. The renderer never gets raw
  // process access — these are the only levers, and the action name must be one of the five.
  secureHandle<unknown>('supervisor:get-status', null, () => lastStatus ?? supervisor?.status() ?? null);
  secureHandle<boolean>('supervisor:action', false, (_e, raw: unknown) =>
    supervisor?.handleAction(asSupervisorAction(raw)) ?? false);
  secureHandle<unknown[]>('supervisor:crash-history', [], () => supervisor?.crashHistory() ?? []);
  secureHandle<string>('supervisor:diagnostics', '', () => supervisor?.diagnosticsText() ?? '');

  // Phase 9 runtime intelligence is read-only across the renderer boundary. Process provenance is
  // limited to children Bimax launched itself; no system-wide inspection or Endpoint Security
  // entitlement is implied. Interaction can only make policy more conservative.
  secureHandle<unknown>('phase9:adaptive-state', null, () => adaptiveSnapshot());
  secureHandle<unknown[]>('phase9:process-provenance', [], () => engineProcessProvenance());
  secureHandle<EnvironmentCapabilitySnapshot | null>('phase9:environment', null, async () =>
    (await workspaceCapabilities())?.environment ?? null);
  secureHandle<AlchemistCapabilitySnapshot | null>('phase9:alchemist-status', null, async () =>
    (await workspaceCapabilities())?.alchemist ?? null);
  secureOn('phase9:interaction', (_e, raw: unknown) => {
    const payload = raw as { active?: unknown; reduceMotion?: unknown } | null;
    if (!payload || typeof payload.active !== 'boolean' || typeof payload.reduceMotion !== 'boolean') {
      throw new InvalidPayloadError('not a runtime interaction signal');
    }
    if (payload.active) lastInteractionAt = Date.now();
    reduceMotion = payload.reduceMotion;
  });

  secureHandle<string>('app:get-project', '', () => projectDir());

  secureHandle<'saved' | 'cancelled' | 'failed'>('trust:export-diagnostics', 'failed', async () => {
    if (!win) return 'failed';
    const selected = await dialog.showSaveDialog(win, {
      title: 'Export private Bimax diagnostics',
      defaultPath: `Bimax-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (selected.canceled || !selected.filePath) return 'cancelled';
    const payload = buildDiagnosticExport({
      now: () => new Date(),
      status: lastStatus ?? supervisor?.status() ?? null,
      crashes: supervisor?.crashHistory() ?? [],
    });
    const tmp = `${selected.filePath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, selected.filePath);
      return 'saved';
    } catch (error) {
      console.error('[diagnostics] export failed:', error);
      return 'failed';
    }
  });

  // Contextual evidence (Phase 8, owner section 28). The renderer receives typed findings and
  // retention controls — never a raw record it could edit and send back, never a native handle.
  // Ingest is one-way from the engine and the Mac provider into main; the renderer only reads.
  secureHandle<unknown>('evidence:timeline', null, (_e, raw: unknown) => {
    const taskIntentId = typeof raw === 'string' && raw ? raw : null;
    const records = taskIntentId ? evidenceStore.forTask(taskIntentId) : evidenceStore.all();
    return buildEvidenceTimeline(records, [...evidenceStore.evictionLog()]);
  });

  secureHandle<unknown[]>('evidence:retention-controls', [], (_e, raw: unknown) => {
    const taskIntentId = typeof raw === 'string' && raw ? raw : null;
    return retentionControls(evidenceStore.all(), taskIntentId);
  });

  // Deletion is real: the records are gone from the store, and the eviction is recorded so the
  // timeline shows an evidence gap rather than a shorter, calmer-looking history.
  secureHandle<number>('evidence:delete', 0, (_e, raw: unknown) => {
    const request = raw as { scope?: unknown; taskIntentId?: unknown } | null;
    const scope = typeof request?.scope === 'string' ? request.scope : '';
    if (scope === 'task') {
      const taskIntentId = typeof request?.taskIntentId === 'string' ? request.taskIntentId : '';
      if (!taskIntentId) throw new InvalidPayloadError('delete scope "task" needs a taskIntentId');
      return evidenceStore.deleteTask(taskIntentId);
    }
    if (scope === 'observations') return evidenceStore.deleteObservations();
    if (scope === 'all') return evidenceStore.deleteAll();
    throw new InvalidPayloadError('unknown evidence delete scope');
  });

  // Recent projects for the welcome screen (validated, most-recent first).
  secureHandle<string[]>('app:recent-projects', [], () => recentProjects());

  // Open a specific recent project by path (from the welcome list). isRealProject is the gate: an
  // arbitrary renderer-supplied path is not a project just because it is a directory.
  secureHandle<string | null>('app:open-project', null, (_e, dir: unknown) => {
    if (typeof dir === 'string' && isRealProject(dir)) { startEngine(dir); return dir; }
    return null;
  });

  // Composer attach: pick files, return paths relative to the project so they insert as @refs.
  secureHandle<string[]>('app:pick-files', [], async () => {
    if (!win) return [];
    const res = await dialog.showOpenDialog(win, {
      title: 'Attach files',
      defaultPath: projectDir() || undefined,
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled) return [];
    const root = projectDir().replace(/\/+$/, '');
    return res.filePaths.map((p) => (p.startsWith(root + '/') ? p.slice(root.length + 1) : p));
  });

  // Review panel — native git reads (writes go through the engine's /git for attribution).
  secureHandle<unknown>('git:status', null, () => gitStatus(projectDir()));
  // gitDiff contains the pathspec against the project itself — see its doc comment.
  secureHandle<string>('git:diff', '', (_e, file: unknown, untracked: unknown) =>
    gitDiff(projectDir(), file, untracked === true));
  secureHandle<unknown>('git:branches', { current: '', all: [] }, () => gitBranches(projectDir()));
  // GitHub lane. Reads are free; the three network verbs are user-initiated only — nothing here is
  // reachable by the engine or the model, and none of them takes or stores a credential.
  secureHandle<unknown>('git:remote', null, () => gitRemoteInfo(projectDir()));
  // Local model runtimes. Read-only probe of this machine — no network, no credentials.
  secureHandle<unknown>('models:local', { runtimes: [], servable: [], scannedAt: '' }, () => discoverLocalModels());
  // Filename search for the Files filter. Read-only, bounded, and confined to the project root by
  // the same resolver the tree uses.
  secureHandle<unknown>('files:search', { hits: [], truncated: false }, (_e, query: unknown) =>
    searchFiles(projectDir(), query));
  secureHandle<unknown>('git:fetch', { ok: false, output: 'unavailable' }, () => gitFetch(projectDir()));
  secureHandle<unknown>('git:pull', { ok: false, output: 'unavailable' }, () => gitPull(projectDir()));
  secureHandle<unknown>('git:push', { ok: false, output: 'unavailable' }, (_e, setUpstream: unknown) =>
    gitPush(projectDir(), setUpstream === true));
  secureHandle<unknown>('git:log', [], (_e, n: unknown) =>
    gitLog(projectDir(), n === undefined ? 15 : asBoundedInt(n, 1, 1000, 'git log count')));

  // Files panel — lazy tree + capped read-only viewer. Every path is resolved inside the project;
  // with no project open the resolver fails closed rather than falling back to the filesystem root.
  secureHandle<unknown>('files:list', [], (_e, rel: unknown) => listDir(projectDir(), rel));
  secureHandle<unknown>('files:read', null, (_e, rel: unknown) => readFilePreview(projectDir(), rel));
  secureHandle<void>('files:reveal', undefined, (_e, rel: unknown) => {
    shell.showItemInFolder(resolveWithinRoot(projectDir(), rel, 'reveal path'));
  });
  // Editor pane ⌘S — the user's own edit, so it writes directly like any IDE (agent edits still
  // flow through the engine's tools + Edit Shield).
  secureHandle<void>('files:write', undefined, (_e, rel: unknown, content: unknown) =>
    writeFileContent(projectDir(), rel, asFileContent(content)));

  // Home dashboard + Sessions gallery: full session history from the engine's meta JSONL.
  secureHandle<unknown>('sessions:meta', [], () => readSessionMeta(projectDir()));

  // Terminal panel — pty lives here so the shell survives renderer tab switches.
  secureHandle<number>('pty:create', -1, (_e, cols: unknown, rows: unknown) =>
    createPty(projectDir(), asBoundedInt(cols, 2, 1000, 'cols'), asBoundedInt(rows, 2, 1000, 'rows'), {
      onData: (id, data) => broadcast('pty:data', id, data),
      onExit: (id, code) => broadcast('pty:exit', id, code),
    }));
  secureOn('pty:input', (_e, id: unknown, data: unknown) =>
    writePty(asBoundedInt(id, 1, Number.MAX_SAFE_INTEGER, 'pty id'), asPtyInput(data)));
  secureOn('pty:resize', (_e, id: unknown, cols: unknown, rows: unknown) =>
    resizePty(
      asBoundedInt(id, 1, Number.MAX_SAFE_INTEGER, 'pty id'),
      asBoundedInt(cols, 2, 1000, 'cols'),
      asBoundedInt(rows, 2, 1000, 'rows'),
    ));
  secureOn('pty:kill', (_e, id: unknown) =>
    killPty(asBoundedInt(id, 1, Number.MAX_SAFE_INTEGER, 'pty id')));

  // Renderer signals it has mounted its listeners; only then spawn (so no early events are lost).
  // With a valid saved/override project we boot it; otherwise we broadcast an empty project so the
  // renderer shows the project-first welcome instead of an engine running in $HOME (P0.1).
  secureHandle('window:chrome', { fullScreen: false, maximized: false, active: true, accent: null }, () => windowChrome());

  // The vibrancy material follows `nativeTheme`, not our CSS. Without this, choosing Moonlight on a
  // Mac set to Light gives a dark panel over a light frosted material — the one surface in the app
  // that ignores the user's appearance choice. 'system' is the correct value for "Match system".
  secureOn('app:appearance', (_e, appearance: unknown) => {
    nativeTheme.themeSource = appearance === 'moonlight' ? 'dark'
      : appearance === 'starlight' ? 'light'
      : 'system';
  });

  secureOn('app:renderer-ready', () => {
    // A renderer that reloads while zoomed or in full screen would otherwise start out translucent
    // and only correct itself at the next window event, which may never come.
    broadcast('window:chrome', windowChrome());
    const dir = projectDir();
    if (dir) {
      broadcast('app:project', dir);
      if (lastStatus) {
        broadcast('supervisor:status', lastStatus);
        const legacy = legacyState(lastStatus);
        if (legacy) broadcast('engine:state', legacy.state, legacy.detail);
      }
      // Renderer reload/reconnect: replay the latest full snapshots so missing intermediate events
      // cannot leave repository or task-review state stale.
      if (latestUiSnapshot) broadcast('engine:msg', latestUiSnapshot);
      if (latestReviewSnapshot) broadcast('engine:msg', latestReviewSnapshot);
      return;
    }
    if (initialDir) startEngine(initialDir);
    else broadcast('app:project', '');
  });

  app.on('activate', () => {
    revealMainWindow();
  });
});

// dispose() supersedes the child and cancels every timer — the supervisor can never relaunch the
// engine while the app is quitting.
app.on('window-all-closed', () => {
  supervisor?.dispose();
  supervisor = null;
  killAllPtys();
  projectWatcher?.close();
  projectWatcher = null;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  supervisor?.dispose();
  supervisor = null;
  killAllPtys();
  projectWatcher?.close();
  projectWatcher = null;
});
