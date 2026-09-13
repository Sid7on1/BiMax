import { CapabilityReplay } from './capability.replay';
import { app, BrowserWindow, ipcMain, dialog, shell, session, systemPreferences, powerMonitor, net, nativeTheme, globalShortcut, screen, Menu, Notification, Tray, nativeImage } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { ThreadManager, threadIndexEnvironment } from './thread.manager';
import { ThreadStorage } from './thread.storage';
import { createThreadBroker } from './thread.broker';
import { finderContext } from './finder.context';
import type { QuickContext, QuickThread } from '../shared/threads';
import { QUICK_BAR, quickBarBounds, quickBarOrigin } from './quick.bar';
import { lastUndoable, threadStateEnvironment, threadStateRoot, undoLast } from './thread.undo';
import { insideFolder, validAttachments, withContext } from './quick.context';
import { nextQuickThread, trayEntries, trayTitle, trayTooltip } from './thread.tray';
import { modelMenuItems, type CatalogModel, type ModelMenuItem, type ModelTime } from './thread.models';
import { macBin } from './bin';
import os from 'node:os';
import { readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'node:fs';
import fsp from 'node:fs/promises';
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
import { gitDiff, gitBranches, gitLog, gitRemoteInfo, gitFetch, gitPull, gitPush, stampedGitStatus } from './git';
import { discoverLocalModels } from './local.models';
import { listDir, readFilePreview, writeFileContent, readSessionMeta, watchProject, searchFiles, ProjectWatch } from './files';
import { createPty, writePty, resizePty, killPty, killAllPtys } from './pty';
import { pickInitialProject, loadSettings, recordProject, recentProjects, isRealProject, saveSettings } from './settings';
import { embeddedBrowserManager, type ViewBounds } from './embedded.browser.manager';
import { CredentialVaultBridge } from './credential.vault.bridge';
import {
  REQUIRED_WEB_PREFERENCES, RENDERER_CSP, InvalidPayloadError,
  isTrustedSender, isAllowedNavigation, isAllowedPermission,
  asBoundedInt, asFileContent, asPtyInput, asSupervisorAction,
  asPastedFileName, asPastedBytes,
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
// Bimax Threads: one engine, history and approval namespace per folder-bound conversation (thread.manager.ts).
let threads: ThreadManager;
let threadStorage: ThreadStorage;
let threadBroker: Awaited<ReturnType<typeof createThreadBroker>>;
let quickWindow: BrowserWindow | null = null;
let approvalWindow: BrowserWindow | null = null;
let quickContext: QuickContext = { root: null, source: 'Choose a folder' };
let shortcutAvailable = false;
let listTimer: ReturnType<typeof setTimeout> | undefined;
// The ⌘2 bar's own conversation, where the user last put it, and how tall it currently is.
let quickThreadId: string | null = null;
let quickAnchor: { x: number; y: number } | null = null;
let quickHeight: number = QUICK_BAR.collapsedHeight;
let quickMoving = false;
// A folder picker opened from the bar takes focus; that blur must not hide the bar it was opened from.
let quickPicking = false;
function threadList() { return { activeId: threads?.activeId ?? null, threads: threads?.list() ?? [], shortcutAvailable }; }
function threadChanged(): void {
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = undefined;
    broadcast('threads:list', threadList());
    updateTray();
    if (approvalWindow && !approvalWindow.isDestroyed()) {
      approvalWindow.webContents.send('threads:approvals', threads.approvals());
      if (!threads.approvals().length) approvalWindow.hide();
    }
  }, 100);
}
/**
 * Native Liquid Glass (macOS 26+, via `electron-liquid-glass`), or null where it is unavailable — an older
 * macOS, another platform, or the add-on failing to load — in which case the panels use `hud` vibrancy.
 */
interface LiquidGlass { addView(handle: Buffer, options?: { cornerRadius?: number; tintColor?: string; opaque?: boolean }): number }
let liquidGlassModule: LiquidGlass | null | undefined;
function liquidGlass(): LiquidGlass | null {
  if (liquidGlassModule !== undefined) return liquidGlassModule;
  liquidGlassModule = null;
  if (process.platform !== 'darwin') return null;
  try {
    const loaded = require('electron-liquid-glass');
    liquidGlassModule = (loaded?.default ?? loaded) as LiquidGlass;
  } catch (error) {
    console.warn('[threads] Liquid Glass unavailable; using system vibrancy:', (error as Error).message);
  }
  return liquidGlassModule;
}

/**
 * The ⌘2 bar and the approval popup: frameless floating glass panels, dragged by their header and footer
 * (styles.css `.quick-drag`), and limited to their own IPC channels.
 */
function auxiliaryWindow(kind: 'quick' | 'approval'): BrowserWindow {
  const mac = process.platform === 'darwin';
  const glass = liquidGlass();
  const window = new BrowserWindow({
    width: kind === 'quick' ? QUICK_BAR.width : 520,
    height: kind === 'quick' ? QUICK_BAR.collapsedHeight : 380,
    show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: true,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: true, roundedCorners: true,
    ...(mac ? { type: 'panel' as const } : {}),
    ...(mac && !glass ? { vibrancy: 'hud' as const, visualEffectState: 'active' as const } : {}),
    title: kind === 'quick' ? 'Bimax Threads' : 'Bimax needs your decision',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), ...REQUIRED_WEB_PREFERENCES },
  });
  let glassMode: 'native' | 'vibrancy' = 'vibrancy';
  if (glass) {
    try {
      glass.addView(window.getNativeWindowHandle(), { cornerRadius: kind === 'quick' ? 28 : 22 });
      glassMode = 'native';
    } catch (error) {
      console.warn('[threads] Liquid Glass failed to attach; using system vibrancy:', (error as Error).message);
      if (mac) window.setVibrancy('hud');
    }
  }
  window.setAlwaysOnTop(true, 'floating');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => { event.preventDefault(); window.hide(); });
  if (kind === 'quick') {
    // A drag the user made is remembered; the bar resizing itself to its content is not a drag.
    window.on('moved', () => {
      if (quickMoving) return;
      const [x, y] = window.getPosition();
      quickAnchor = { x, y };
      saveSettings({ quickBar: quickAnchor });
    });
    // Like Spotlight, an empty bar goes away when you click elsewhere. One running a task stays up.
    window.on('blur', () => { if (!quickThreadId && !quickPicking && window.isVisible()) window.hide(); });
    // Hiding the bar must not strand a question its task is waiting on: it moves to the approval popup.
    window.on('hide', () => {
      if (quickThreadId && threads.approvals().some(a => a.threadId === quickThreadId)) showThreadApproval();
    });
  }
  const query = { surface: kind, glass: glassMode };
  const url = process.env.ELECTRON_RENDERER_URL;
  if (url) void window.loadURL(`${url}?${new URLSearchParams(query)}`);
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'), { query });
  return window;
}
function quickThreadSnapshot(): QuickThread | null {
  if (!quickThreadId) return null;
  try {
    const { summary, state } = threads.get(quickThreadId);
    return { id: summary.id, title: summary.title, root: summary.root, state };
  } catch {
    quickThreadId = null;
    return null;
  }
}
function sendQuickThread(): void {
  if (quickWindow && !quickWindow.isDestroyed()) quickWindow.webContents.send('threads:quick-thread', quickThreadSnapshot());
}
/** Size the bar to its content, growing from where the user put it (see quick.bar.ts). */
function applyQuickBounds(requestedHeight: number): void {
  if (!quickWindow || quickWindow.isDestroyed()) return;
  const current = quickWindow.getBounds();
  const anchor = quickAnchor ?? { x: current.x, y: current.y };
  const area = screen.getDisplayMatching({ ...current, ...anchor }).workArea;
  const next = quickBarBounds(anchor, requestedHeight, area);
  if (next.x === current.x && next.y === current.y && next.width === current.width && next.height === current.height) return;
  quickHeight = next.height;
  quickMoving = true;
  // Animated only for a real change of shape (pill to conversation); streaming growth is a few pixels at a time.
  quickWindow.setBounds(next, process.platform === 'darwin' && Math.abs(next.height - current.height) > 48);
  setTimeout(() => { quickMoving = false; }, 250);
}
async function showQuickBar(): Promise<void> {
  if (quickWindow?.isVisible()) { quickWindow.hide(); return; }
  // Freeze the Finder folder BEFORE taking keyboard focus, so the bar never reads its own window. A bar that
  // is already running a task keeps that task's folder.
  if (!quickThreadId) quickContext = await finderContext();
  if (!quickWindow || quickWindow.isDestroyed()) quickWindow = auxiliaryWindow('quick');
  const cursorArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  quickAnchor = quickBarOrigin(loadSettings().quickBar, screen.getAllDisplays().map(d => d.workArea), cursorArea);
  applyQuickBounds(quickHeight);
  quickWindow.webContents.send('threads:context', quickContext);
  sendQuickThread();
  quickWindow.show(); quickWindow.focus();
}
/** The Work model in Bimax's own settings, for the "Same as Bimax" menu entry. */
function bimaxModel(): string {
  try { return String(JSON.parse(readFileSync(path.join(os.homedir(), '.breakglass', 'config.json'), 'utf8')).model || ''); } catch { return ''; }
}
// How long turns have taken with each model on this Mac: a running average over the last 20 turns, kept in settings.
const modelTimes = new Map<string, ModelTime>();
let modelTimesLoaded = false;
function recordModelTime(id: string, tookMs: number | undefined): void {
  if (!tookMs || tookMs < 500) return;
  if (!modelTimesLoaded) { for (const [model, time] of Object.entries(loadSettings().modelTimes ?? {})) modelTimes.set(model, time); modelTimesLoaded = true; }
  const model = threads.get(id).summary.model || bimaxModel();
  if (!model) return;
  const prior = modelTimes.get(model) ?? { avgMs: tookMs, turns: 0 };
  const turns = Math.min(prior.turns + 1, 20);
  modelTimes.set(model, { avgMs: Math.round(prior.avgMs + (tookMs - prior.avgMs) / turns), turns });
  saveSettings({ modelTimes: Object.fromEntries(modelTimes) });
}
// The provider's model list, asked of a running thread engine (catalogGet) and remembered for when none is running.
let modelCatalog: CatalogModel[] = [];
const catalogWaiters = new Map<number, (models: CatalogModel[]) => void>();
let catalogRequest = 1_000_000_000;
function refreshModelCatalog(): Promise<CatalogModel[]> {
  const running = [quickThreadId, threads.activeId, ...threads.list().map((t) => t.id)].find((id): id is string => !!id && !!threads.engine(id));
  if (!running) return Promise.resolve(modelCatalog);
  const id = ++catalogRequest;
  return new Promise((resolve) => {
    catalogWaiters.set(id, resolve);
    setTimeout(() => { if (catalogWaiters.delete(id)) resolve(modelCatalog); }, 8000);
    threads.send(running, { t: 'catalogGet', id, refresh: false });
  });
}
/** The ⌘2 bar's model menu (thread.models.ts): choose this task's model, or answer again with another. */
async function showModelMenu(mode: 'switch' | 'retry'): Promise<void> {
  const id = quickThreadId;
  if (!id || !quickWindow || quickWindow.isDestroyed()) return;
  if (!modelTimesLoaded) { for (const [model, time] of Object.entries(loadSettings().modelTimes ?? {})) modelTimes.set(model, time); modelTimesLoaded = true; }
  const models = await refreshModelCatalog();
  const items: ModelMenuItem[] = modelMenuItems({
    models, current: threads.get(id).summary.model ?? null, bimaxModel: bimaxModel(),
    quickDefault: loadSettings().quickModel ?? null, times: Object.fromEntries(modelTimes), mode,
  });
  const template: Electron.MenuItemConstructorOptions[] = items.map((item) => {
    if (item.kind === 'separator') return { type: 'separator' };
    if (item.kind === 'header') return { label: item.label, enabled: false };
    if (item.kind === 'default') return { label: item.label, type: 'checkbox', checked: item.checked, click: () => saveSettings({ quickModel: item.model ?? undefined }) };
    return {
      label: item.label, type: mode === 'switch' ? 'checkbox' : 'normal', checked: item.checked,
      click: () => {
        try { if (mode === 'retry') threads.retryWith(id, item.model); else threads.setModel(id, item.model); }
        catch (error) { void dialog.showMessageBox({ type: 'info', message: (error as Error).message }); }
      },
    };
  });
  Menu.buildFromTemplate(template).popup({ window: quickWindow });
}
/** Bring a ⌘2 task back into the bar — from the menu bar, a notification, or ⌘[ / ⌘]. */
function showQuickThread(id: string): void {
  quickThreadId = id;
  if (quickWindow?.isVisible()) { sendQuickThread(); quickWindow.focus(); return; }
  void showQuickBar();
}
/** Open a thread where it lives: a ⌘2 task in the bar, a project in the main window. */
function openThread(id: string): void {
  if (threads.get(id).summary.origin === 'project') { selectThread(id); revealMainWindow(); }
  else showQuickThread(id);
}
/** A task finished while it was not on screen: say so, with the start of its answer. */
function notifyFinished(id: string): void {
  if (!Notification.isSupported()) return;
  const { summary, state } = threads.get(id);
  const onScreen = (id === quickThreadId && quickWindow?.isVisible()) || (id === threads.activeId && win?.isFocused());
  if (onScreen) return;
  const answer = [...state.items].reverse().find((item) => item.kind === 'msg' && item.msg.role === 'assistant');
  const body = answer && answer.kind === 'msg' ? answer.msg.content.replace(/\s+/g, ' ').trim().slice(0, 160) : 'Finished.';
  const note = new Notification({ title: summary.title, subtitle: `Done in ${path.basename(summary.root)}`, body: body || 'Finished.' });
  note.on('click', () => openThread(id));
  note.show();
}
let tray: Tray | null = null;
/** The menu bar item: running and waiting tasks at a glance, and a menu of recent ones (thread.tray.ts). */
function updateTray(): void {
  if (process.platform !== 'darwin' || !threads) return;
  const list = threads.list();
  if (!tray) tray = new Tray(nativeImage.createEmpty());
  tray.setTitle(trayTitle(list));
  tray.setToolTip(trayTooltip(list));
  const entries = trayEntries(list);
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'Bimax tasks', enabled: false },
    ...(entries.length ? entries.map((entry) => ({ label: entry.label, click: () => openThread(entry.id) })) : [{ label: 'No tasks yet', enabled: false }]),
    { type: 'separator' },
    { label: 'New ⌘2 Task', click: () => { quickThreadId = null; if (quickWindow?.isVisible()) sendQuickThread(); else void showQuickBar(); } },
    { label: 'Open Bimax', click: () => revealMainWindow() },
    { type: 'separator' },
    { label: 'Quit Bimax', role: 'quit' },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}
function showThreadApproval(): void {
  if (!approvalWindow || approvalWindow.isDestroyed()) approvalWindow = auxiliaryWindow('approval');
  approvalWindow.webContents.send('threads:approvals', threads.approvals());
  approvalWindow.showInactive();
}
let projectWatcher: ProjectWatch | null = null;
const capabilityReplay = new CapabilityReplay();
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
    totalMemoryMb: Math.round(totalMb),
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
    auxiliaryWebContentsIds: [quickWindow, approvalWindow].filter(w => w && !w.isDestroyed()).map(w => w!.webContents.id),
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

/** The main window may use every channel; the prompt bar and approval popup only their own few. */
function auxiliaryChannelAllowed(event: IpcMainEvent | IpcMainInvokeEvent, channel: string): boolean {
  if (event.sender.id === win?.webContents.id) return true;
  const allowed = event.sender.id === quickWindow?.webContents.id
    ? ['threads:context', 'threads:pick-folder', 'threads:quick-submit', 'threads:hide', 'threads:list', 'threads:reply',
      'threads:quick-current', 'threads:quick-reset', 'threads:quick-interrupt', 'threads:quick-resize', 'threads:quick-open',
      'threads:undo-info', 'threads:undo', 'threads:open-path', 'threads:quick-switch', 'threads:model-menu']
    : ['threads:approvals', 'threads:reply', 'threads:hide', 'threads:stop'];
  return allowed.includes(channel);
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
    if (!isTrustedSender(senderIdentity(event), trustedRenderer()) || !auxiliaryChannelAllowed(event, channel)) {
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
    if (!isTrustedSender(senderIdentity(event), trustedRenderer()) || !auxiliaryChannelAllowed(event, channel)) {
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

function createSupervisor(threadId?: string): EngineSupervisor {
  const journalPath = path.join(app.getPath('userData'), threadId ? `thread-crash-${threadId}.json` : 'crash-journal.json');
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
        ...(threadId ? { ...threadBroker.environment(threadId), BIMAX_THREAD_ROOT: project, WORKSPACE_ROOT: project,
          BIMAX_AUTO_INDEX: '0', BIMAX_DISABLE_CODEMEM: '1', BIMAX_DISABLE_CODEBASE_MEMORY: '1', BIMAX_DRIVES_BOOT: '0',
          ...threadIndexEnvironment(threads.get(threadId).summary.origin),
          ...threadStateEnvironment(app.getPath('userData'), project, threads.get(threadId).summary.origin),
          ...(threads.get(threadId).summary.model ? { BIMAX_THREAD_MODEL: threads.get(threadId).summary.model } : {}) } : {}),
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
      if (threadId) threads.lifecycle(threadId, status.phase, status.message);
      if (threadId && threads.activeId !== threadId) return;
      lastStatus = status;
      broadcast('supervisor:status', status);
      const legacy = legacyState(status);
      if (legacy) broadcast('engine:state', legacy.state, legacy.detail);
    },
    onMessage: (msg: any) => {
      if (threadId) { threads.receive(threadId, msg); return; }
      capabilityReplay.accept(msg);
      if (msg?.t === 'event' && msg.name === 'ui_snapshot') latestUiSnapshot = msg;
      if (msg?.t === 'event' && msg.name === 'review_update') latestReviewSnapshot = msg;
      broadcast('engine:msg', msg);
    },
    // Notices reuse the renderer's existing diagnostics pipeline (the 'log' event fold), so they
    // show up in the Health panel without a parallel plumbing path.
    onNotice: (level, text) => {
      if (threadId && threads.activeId !== threadId) return;
      broadcast('engine:msg', {
        t: 'event',
        name: 'log',
        args: [{ id: `sup-${Date.now()}`, level, text: `[supervisor] ${text}`, timestamp: new Date().toISOString() }],
      });
    },
  });
}

function selectThread(id: string): void {
  const root = threads.get(id).summary.root;
  capabilityReplay.clear();
  latestUiSnapshot = null;
  latestReviewSnapshot = null;
  capabilityCache = null;
  supervisor = (threads.engine(id) as EngineSupervisor | undefined) ?? null;
  // Every project session gets a monotonically rising generation. It rides on change broadcasts and
  // on git replies so the renderer can drop an answer that describes a project it has already left.
  const generation = ++projectGeneration;
  // `watchProject`'s handle cancels its own debounce timer on close, so the watcher for the project
  // we just left cannot wake the one we just opened.
  projectWatcher?.close();
  projectWatcher = watchProject(root, () => broadcast('files:changed', generation));
  broadcast('app:project', root, generation);
  threads.select(id);
  lastStatus = supervisor ? supervisor.status() : null;
  broadcast('supervisor:status', lastStatus);
}

/** Opening a folder starts a thread for it: its own engine, history and approvals (thread.manager.ts). */
function startEngine(projectDir: string): void {
  const id = threads.create(realpathSync(projectDir), '', 'project');
  threads.start(id);
  selectThread(id);
}

/**
 * A project the user opened in the main window — the Open Project dialog, a recent project, or a launch
 * from a folder. Only these become Recent Projects. A folder a thread works in (a ⌘2 task, a thread
 * switch, "Open in Bimax", an engine restart) was never chosen as a project, so it stays off the welcome.
 */
function openProject(projectDir: string): void {
  startEngine(projectDir);
  recordProject(realpathSync(projectDir));
}

// The active project for native git/files/pty reads. Empty string when no project is open (the
// renderer shows the project-first welcome then) — never $HOME, which caused the Git/genome errors.
function projectDir(): string {
  return threads?.activeId ? threads.get(threads.activeId).summary.root : '';
}

/**
 * Monotonic project-session counter. Rises on every `startEngine`, including a restart of the same
 * directory, and is stamped onto replies and change broadcasts so a slow answer about a retired
 * session is identifiable as one instead of being applied to whatever is open now.
 */
let projectGeneration = 0;

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
  threadStorage = new ThreadStorage(path.join(app.getPath('userData'), 'threads'));
  threads = new ThreadManager({
    engine: id => createSupervisor(id), changed: threadChanged,
    selected: value => broadcast('threads:selected', value),
    message: (id, msg) => {
      // A model list this process asked for (the ⌘2 model menu) is answered here, not shown in a window.
      if (msg.t === 'catalogResult' && catalogWaiters.has(msg.id)) {
        const done = catalogWaiters.get(msg.id)!;
        catalogWaiters.delete(msg.id);
        modelCatalog = (msg.models ?? []) as CatalogModel[];
        done(modelCatalog);
        return;
      }
      if (threads.activeId === id) broadcast('engine:msg', msg, id);
      if (id === quickThreadId && quickWindow && !quickWindow.isDestroyed()) quickWindow.webContents.send('threads:quick-msg', msg);
    },
    // The ⌘2 bar answers its own task's questions inline while it is on screen; everything else gets the popup.
    approval: (value) => {
      if (value.threadId === quickThreadId && quickWindow?.isVisible()) return;
      showThreadApproval();
      // Away from Bimax: say so where the person will see it; the popup is already waiting when they come back.
      if (Notification.isSupported() && !BrowserWindow.getFocusedWindow()) {
        const note = new Notification({ title: `${value.title} needs your decision`, body: value.request.question.slice(0, 160) });
        note.on('click', () => { showThreadApproval(); approvalWindow?.focus(); });
        note.show();
      }
    },
    save: value => threadStorage.save(value),
    finished: (id, tookMs) => { recordModelTime(id, tookMs); notifyFinished(id); },
  }, threadStorage.load());
  threadBroker = await createThreadBroker(threads, async (from, to) => {
    const a = threads.get(from).summary, b = threads.get(to).summary;
    const result = await dialog.showMessageBox({ type: 'question', title: 'Link Bimax threads?',
      message: `Allow “${a.title}” and “${b.title}” to communicate?`,
      detail: `${a.root}\n${b.root}\n\nThey can exchange task messages. Their folders and action permissions stay separate.`,
      buttons: ['Cancel', 'Link threads'], defaultId: 0, cancelId: 0 });
    return result.response === 1;
  }, {
    // A thread's `rm` and DeleteTool end up here: only items inside that thread's own folder, only ones that exist,
    // each through Finder so the thread's undo knows its place in the Bin (main/bin.ts).
    moveToBin: async (paths, root) => {
      const realRoot = await fsp.realpath(root);
      const moved: Array<{ path: string; trashPath: string | null }> = [];
      for (const requested of paths) {
        try {
          const target = path.join(await fsp.realpath(path.dirname(path.resolve(requested))), path.basename(requested));
          const rel = path.relative(realRoot, target);
          if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${requested} is outside this thread’s folder`);
          await fsp.lstat(target);
          moved.push({ path: target, trashPath: await macBin.moveToBin(target) });
        } catch (error) {
          return { moved, error: (error as Error).message };
        }
      }
      return { moved, error: null };
    },
  });
  createWindow();
  updateTray();
  shortcutAvailable = globalShortcut.register('CommandOrControl+2', () => { void showQuickBar(); });
  if (!shortcutAvailable) console.warn('[threads] Cmd+2 is already registered by another application.');
  // The embedded browser attaches its BrowserViews to this window. A BrowserView is an OS-level
  // overlay painted ABOVE the renderer, not a DOM node, so it needs the real BrowserWindow and it
  // needs to be told where the React layout wants it (see 'browser:bounds' below).
  if (win) embeddedBrowserManager.setWindow(win);

  // Launch project: an env override or the last valid saved project — NEVER $HOME. When null, the
  // renderer shows the project-first welcome and we don't boot an engine in the wrong place (P0.1).
  const initialDir = pickInitialProject(loadSettings().lastProject);

  // Protocol messages from the renderer flow through the supervisor: delivered when the engine is
  // interactive, queued when safe to replay, rejected with a visible notice otherwise. The frame
  // shape is checked here so malformed junk never reaches the engine's parser.
  // ---- Embedded research browser -------------------------------------------------------------
  // Every channel goes through secureHandle/secureOn, so an untrusted frame gets the fallback
  // rather than a live browser. Payloads are validated here because the manager trusts its caller.
  const asString = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value) throw new InvalidPayloadError(`${field} must be text`);
    return value;
  };
  const asBounds = (value: unknown): ViewBounds => {
    const b = value as Record<string, unknown> | null;
    if (!b || typeof b !== 'object') throw new InvalidPayloadError('bounds must be an object');
    for (const key of ['x', 'y', 'width', 'height']) {
      if (!Number.isFinite(b[key] as number)) throw new InvalidPayloadError(`bounds.${key} must be a number`);
    }
    return { x: Math.round(b.x as number), y: Math.round(b.y as number),
             width: Math.round(b.width as number), height: Math.round(b.height as number) };
  };
  const browserState = (): { tabs: unknown[]; activeTabId: string | null } =>
    ({ tabs: embeddedBrowserManager.getTabs(), activeTabId: embeddedBrowserManager.getActiveTabId() });

  secureHandle('browser:state', { tabs: [], activeTabId: null }, () => browserState());
  secureHandle('browser:newTab', { tabs: [], activeTabId: null }, (_e, url: unknown) => {
    embeddedBrowserManager.createTab(typeof url === 'string' && url ? url : undefined);
    return browserState();
  });
  secureHandle('browser:selectTab', { tabs: [], activeTabId: null }, (_e, id: unknown) => {
    embeddedBrowserManager.selectTab(asString(id, 'tab id'));
    return browserState();
  });
  secureHandle('browser:closeTab', { tabs: [], activeTabId: null }, (_e, id: unknown) => {
    embeddedBrowserManager.closeTab(asString(id, 'tab id'));
    return browserState();
  });
  secureHandle('browser:navigate', { tabs: [], activeTabId: null }, (_e, url: unknown) => {
    embeddedBrowserManager.navigate(asString(url, 'url'));
    return browserState();
  });
  for (const verb of ['back', 'forward', 'reload'] as const) {
    secureHandle(`browser:${verb}`, { tabs: [], activeTabId: null }, () => {
      if (verb === 'back') embeddedBrowserManager.goBack();
      else if (verb === 'forward') embeddedBrowserManager.goForward();
      else embeddedBrowserManager.reload();
      return browserState();
    });
  }
  // Layout is renderer-owned: React measures the container and tells main where to paint. Sending
  // bounds and visibility separately is what lets the lane hide the view instantly on a tab switch
  // without tearing down the page.
  /**
   * Zero-knowledge autofill for the browser lane.
   *
   * The secret never crosses this boundary in either direction: the renderer sends a DOMAIN and
   * main types the stored password straight into the page with CDP `Input.insertText`. `has` is the
   * only read, and it answers with the username and a boolean — never the secret — so a UI can show
   * "signed in as …" without the value ever entering the renderer, the model's context, or a
   * transcript. That property is the entire reason this bridge exists, so the channels are shaped
   * to make leaking it impossible rather than merely discouraged.
   */
  secureHandle('browser:credentials:has', { exists: false }, (_e, domain: unknown) =>
    CredentialVaultBridge.hasCredentials(asString(domain, 'domain')));
  secureHandle('browser:credentials:store', false, (_e, domain: unknown, username: unknown, secret: unknown) => {
    CredentialVaultBridge.storeCredential(asString(domain, 'domain'), asString(username, 'username'), asString(secret, 'secret'));
    return true;
  });
  secureHandle('browser:credentials:autofill', { ok: false, summary: 'no active page' },
    async (_e, domain: unknown) => {
      const contents = embeddedBrowserManager.getActiveWebContents();
      if (!contents) return { ok: false, summary: 'no active page' };
      return CredentialVaultBridge.autofill(contents, asString(domain, 'domain'));
    });

  secureOn('browser:bounds', (_e, bounds: unknown) => embeddedBrowserManager.setBounds(asBounds(bounds)));
  secureOn('browser:visible', (_e, visible: unknown) => embeddedBrowserManager.setVisible(visible === true));

  secureHandle('threads:list', { activeId: null, threads: [], shortcutAvailable: false } as any, () => threadList());
  secureHandle('threads:context', { root: null, source: 'Choose a folder' } as QuickContext, () => quickContext);
  secureHandle('threads:approvals', [] as any[], () => threads.approvals());
  secureHandle('threads:pick-folder', null as string | null, async () => {
    quickPicking = true;
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Choose this thread’s workspace' })
      .finally(() => { quickPicking = false; if (quickWindow?.isVisible()) quickWindow.focus(); });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = await fsp.realpath(result.filePaths[0]);
    quickContext = { root, source: 'Selected folder' }; return root;
  });
  secureHandle('threads:quick-submit', { ok: false } as any, async (_e, prompt: unknown, options: unknown) => {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000) return { ok: false, error: 'Enter a prompt.' };
    const opts = (options && typeof options === 'object' ? options : {}) as { attachments?: unknown; root?: unknown };
    try {
      // What was open or dropped reaches the engine ahead of the words (quick.context.ts); the bar has already
      // painted the words alone, so the thread records them without echoing them back (thread.manager.ts).
      const attachments = await validAttachments(opts.attachments);
      if (quickThreadId && quickThreadSnapshot()) {
        const { root } = threads.get(quickThreadId).summary;
        const outside = attachments.find((item) => item.path && !insideFolder(root, item.path));
        if (outside) return { ok: false, error: `“${outside.label}” is outside this task’s folder. Start a New task to use it.` };
        threads.submit(quickThreadId, withContext(prompt, attachments), prompt, false);
        return { ok: true, id: quickThreadId };
      }
      const chosen = typeof opts.root === 'string' && opts.root ? opts.root : quickContext.root;
      if (!chosen) return { ok: false, error: 'Choose a folder for this task.' };
      const root = await fsp.realpath(chosen);
      if (!(await fsp.stat(root)).isDirectory()) throw new Error('Workspace folder is unavailable');
      if (root === '/' || root === os.homedir()) return { ok: false, error: 'Choose a specific folder rather than your whole home folder.' };
      const outside = attachments.find((item) => item.path && !insideFolder(root, item.path));
      if (outside) return { ok: false, error: `“${outside.label}” is outside ${path.basename(root)}. Choose its folder instead.` };
      const id = threads.create(root, '', 'quick', loadSettings().quickModel || undefined);
      quickThreadId = id;
      threads.submit(id, withContext(prompt, attachments), prompt, false);
      sendQuickThread();
      return { ok: true, id };
    } catch (error) { return { ok: false, error: (error as Error).message }; }
  });
  // A path in an answer: Quick Look, or ⌘-click to show it in Finder. Relative paths resolve in the task's folder.
  secureHandle('threads:open-path', { ok: false } as { ok: boolean; error?: string }, async (_e, raw: unknown, mode: unknown) => {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 1000) return { ok: false, error: 'No path was given.' };
    const base = quickThreadSnapshot()?.root ?? quickContext.root ?? os.homedir();
    const text = raw.trim();
    const target = text === '~' || text.startsWith('~/') ? path.join(os.homedir(), text.slice(1)) : path.resolve(base, text);
    try {
      const stat = await fsp.stat(target);
      if (mode === 'reveal') shell.showItemInFolder(target);
      else if (stat.isDirectory()) await shell.openPath(target);
      else quickWindow?.previewFile(target);
      return { ok: true };
    } catch {
      return { ok: false, error: `Could not find “${text}” in ${path.basename(base)}.` };
    }
  });
  secureOn('threads:model-menu', (_e, mode: unknown) => { void showModelMenu(mode === 'retry' ? 'retry' : 'switch'); });
  // ⌘[ / ⌘] in the bar: the previous or next of its recent tasks (thread.tray.ts nextQuickThread).
  secureHandle('threads:quick-switch', null as string | null, (_e, direction: unknown) => {
    if (direction !== 'older' && direction !== 'newer') return null;
    const next = nextQuickThread(threads.list(), quickThreadId, direction);
    if (!next) return null;
    quickThreadId = next;
    sendQuickThread();
    return next;
  });
  secureHandle('threads:quick-current', null as QuickThread | null, () => quickThreadSnapshot());
  // "↶ Undo" in the ⌘2 bar: the newest change a thread made that can still be reversed, and reversing it.
  const threadUndoPaths = (id: string): { state: string; root: string } => {
    const { summary } = threads.get(id);
    return { state: threadStateRoot(app.getPath('userData'), summary.root, summary.origin), root: summary.root };
  };
  secureHandle('threads:undo-info', null as { id: string; title: string; at: number } | null, (_e, id: unknown) => {
    if (typeof id !== 'string') return null;
    try { return lastUndoable(threadUndoPaths(id).state); } catch { return null; }
  });
  secureHandle('threads:undo', { ok: false } as { ok: boolean; title?: string; error?: string }, async (_e, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'No thread was given.' };
    try {
      const { status } = threads.get(id).summary;
      if (status === 'working' || status === 'needs-you' || status === 'starting') {
        return { ok: false, error: 'Wait for this thread to finish before undoing a change.' };
      }
      const { state, root } = threadUndoPaths(id);
      const { title } = await undoLast(state, root, macBin);
      threads.noteUndo(id, title);
      return { ok: true, title };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });
  secureOn('threads:quick-resize', (_e, height: unknown) => { if (typeof height === 'number') applyQuickBounds(height); });
  secureOn('threads:quick-reset', () => { quickThreadId = null; sendQuickThread(); });
  secureOn('threads:quick-interrupt', () => { if (quickThreadId) threads.send(quickThreadId, { t: 'interrupt' }); });
  secureOn('threads:quick-open', () => {
    if (!quickThreadId) return;
    selectThread(quickThreadId);
    revealMainWindow();
    quickWindow?.hide();
  });
  secureHandle('threads:new', null as string | null, () => {
    const root = projectDir(); if (!root) return null;
    const origin = threads.activeId ? threads.get(threads.activeId).summary.origin : undefined;
    const id = threads.create(root, '', origin === 'project' ? 'project' : 'quick'); threads.start(id); selectThread(id); return id;
  });
  secureHandle('threads:select', false, (_e, id: unknown) => { if (typeof id !== 'string') return false; selectThread(id); return true; });
  secureHandle('threads:start', false, (_e, id: unknown) => { if (typeof id !== 'string') return false; threads.start(id); selectThread(id); return true; });
  secureHandle('threads:stop', false, (_e, id: unknown) => { if (typeof id !== 'string') return false; threads.stop(id); if (id === threads.activeId) selectThread(id); return true; });
  secureHandle('threads:link', false, (_e, a: unknown, b: unknown, enabled: unknown) => {
    if (typeof a !== 'string' || typeof b !== 'string' || typeof enabled !== 'boolean') return false;
    threads.link(a, b, enabled); return true;
  });
  secureHandle('threads:reply', false, (_e, id: unknown, requestId: unknown, value: unknown, token: unknown) => {
    if (typeof id !== 'string' || typeof requestId !== 'number' || typeof value !== 'string') return false;
    try { threads.send(id, { t: 'reply', id: requestId, value, approvalToken: token }); return true; } catch { return false; }
  });
  secureOn('threads:hide', event => BrowserWindow.fromWebContents(event.sender)?.hide());

  secureOn('engine:send', (_e, msg: unknown, threadId: unknown) => {
    if (!isProtocolFrame(msg)) throw new InvalidPayloadError('not a protocol frame');
    // Frames are addressed to a thread. One from a renderer still showing a thread it has left is dropped
    // rather than delivered to whichever engine happens to be selected now.
    if (typeof threadId !== 'string' || threadId !== threads.activeId) return;
    threads.send(threadId, msg);
    supervisor = (threads.engine(threadId) as EngineSupervisor | undefined) ?? null;
  });

  secureHandle<string | null>('app:pick-folder', null, async () => {
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      title: 'Open Project',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const dir = res.filePaths[0];
    openProject(dir);
    return dir;
  });

  secureHandle<string>('engine:restart', '', () => {
    // Restart the current project, or re-resolve one if none is open. No valid project → stay on
    // the welcome (never boot $HOME).
    if (threads.activeId) {
      const id = threads.activeId;
      threads.stop(id); threads.start(id); selectThread(id);
      return projectDir();
    }
    const dir = pickInitialProject(loadSettings().lastProject);
    if (dir) openProject(dir);
    else broadcast('app:project', '');
    return projectDir();
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
    if (typeof dir === 'string' && isRealProject(dir)) { openProject(dir); return dir; }
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

  /**
   * Give pasted clipboard content a path, so it can travel the same route as a dropped file.
   *
   * A screenshot on the clipboard is a `File` with no backing path — `webUtils.getPathForFile`
   * returns '' for it — and a pasted log is not a file at all. Both were therefore unattachable:
   * the composer's only sources of context were the picker and drag-and-drop, which is why a
   * screenshot pasted into the prompt did nothing at all.
   *
   * The bytes land in a fresh `mkdtemp` directory, never in the project. Writing into the project
   * would dirty the user's working tree on a keystroke; a temp directory is also why the filename
   * validator can be strict without having to reason about an existing file being overwritten.
   */
  secureHandle<string>('app:stash-paste', '', async (_e, name: unknown, bytes: unknown) => {
    const safeName = asPastedFileName(name);
    const content = asPastedBytes(bytes);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bimax-paste-'));
    const target = path.join(dir, safeName);
    await fsp.writeFile(target, content, { flag: 'wx' });
    return target;
  });

  /**
   * The real macOS icon for a file, as a data URL.
   *
   * `app.getFileIcon` asks Launch Services for the SAME icon Finder draws — a red Acrobat sheet for
   * a PDF, the green grid for a spreadsheet. That is the point: an attachment should look like the
   * document the user recognises, not like a filename in a monospace font. Generic per-extension
   * glyphs would be a different, worse thing that only resembles this.
   *
   * Resolved per file and cached by the renderer. A failure returns '' rather than throwing, so one
   * unreadable file cannot take down the whole attachment tray.
   */
  // NOTE: there is deliberately NO `app:file-icon` handler here.
  //
  // Attachment tiles used to show the real Finder icon via `app.getFileIcon`. That API is backed by
  // NSWorkspace, and AppKit is main-thread-only on macOS. Called immediately after the native Open
  // panel dismisses, it crashed the WHOLE APP — EXC_BREAKPOINT/SIGTRAP with faultingThread 4, i.e. a
  // spawned thread, no stderr and no JS stack. An uncaught fault in main takes the window with it.
  //
  // A cosmetic icon is not worth a crash on the primary attach flow, so tiles are drawn in the
  // renderer from the file extension instead. If real Finder icons are wanted later, they must be
  // fetched off the modal-dismiss path and proven not to fault before shipping.

  // Review panel — native git reads (writes go through the engine's /git for attribution).
  // Stamped with the project and generation captured BEFORE the read starts. A `git status` on a
  // large repository is not instant, and without the stamp a reply that began under the previous
  // project would be applied to the current one.
  secureHandle<unknown>('git:status', null, () => stampedGitStatus(projectDir(), projectGeneration));
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
    if (threads.activeId) { selectThread(threads.activeId); return; }
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
      for (const notice of capabilityReplay.snapshot()) broadcast('engine:msg', notice);
      return;
    }
    if (initialDir) openProject(initialDir);
    else broadcast('app:project', '');
  });

  app.on('activate', () => {
    revealMainWindow();
  });
});

// dispose() supersedes the child and cancels every timer — the supervisor can never relaunch the
// engine while the app is quitting.
app.on('window-all-closed', () => {
  // Threads keep working with the window closed; engines stop only when the app quits.
  killAllPtys();
  projectWatcher?.close();
  projectWatcher = null;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  quickWindow?.destroy(); approvalWindow?.destroy();
  threads?.dispose(); threadBroker?.close();
  void threadStorage?.flush();
  supervisor?.dispose();
  supervisor = null;
  killAllPtys();
  projectWatcher?.close();
  projectWatcher = null;
});
