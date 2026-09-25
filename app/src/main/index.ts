import { CapabilityReplay } from './capability.replay';
import { app, BrowserWindow, ipcMain, dialog, shell, session, systemPreferences, powerMonitor, net, nativeTheme, globalShortcut, screen, Menu, Notification, Tray, nativeImage, ShareMenu, powerSaveBlocker, safeStorage, webContents as electronWebContents } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { ThreadManager, threadCapabilityEnvironment, threadIndexEnvironment, threadVoiceEnvironment, workerCapacityEnvironment, spendLedgerEnvironment } from './thread.manager';
import { ThreadStorage } from './thread.storage';
import { createThreadBroker } from './thread.broker';
import { finderContext } from './finder.context';
import type { QuickAttachment, QuickContext, QuickThread, ThreadSummary } from '../shared/threads';
import { threadNotice } from '../shared/threads';
import { QUICK_BAR, quickBarBounds, quickBarOrigin } from './quick.bar';
import { changeHistory, changesSince, filesChangedSince, journalFile, lastUndoable, threadStateEnvironment, threadStateRoot, touchedSince, undoBackTo, undoChange, undoLast } from './thread.undo';
import { insideFolder, needsFolder, PICTURE_EXTENSIONS, screenshotName, validAttachments, withContext } from './quick.context';
import { nextQuickThread, trayEntries, trayTitle, trayTooltip } from './thread.tray';
import { modelMenuItems, quickModelFor, recordTurn, type CatalogModel, type ModelMenuItem, type ModelTime } from './thread.models';
import { cleanRules, rulesEnvironment } from './folder.rules';
import { helperArguments, localeArguments, talkHelper, VoiceSessions, voiceHelperPath, voiceSupported } from './voice';
import { TALK_TURN_HINT, TalkSession, talkModel, type TalkView } from './talk.session';
import { talkTrayTitle } from '../shared/talk';
import { NotchDeck, notchHelperPath } from './notch';
import { Shelf } from './shelf';
import { ClipHistory } from './clipboard';
import { scanFolders } from './secrets';
import { describeSchedule, dueSchedules, newSchedule, type Cadence, type Schedule } from './schedules';
import {
  ARRIVAL_KINDS, FolderTriggers, MAX_TRIGGERS, arrivalLabel, changeListNote, changesDuring, describeTrigger, newTrigger, runMessage,
  triggerFolderProblem, validTriggers, type FolderEntry, type FolderTrigger, type StartResult,
} from './folder.triggers';
import { Wakes, type CiState } from './wakes';
import { conversationHtml, conversationMarkdown, exportFileName, sessionFile, sessionItems } from './thread.export';
import { installQuickAction, openedFilesContext, quickActionPath, QUICK_ACTION_NAME } from './finder.action';
import { onlyBasicVoices, parseVoiceList, pickerVoices, speakingArguments, SPEECH_RATES, validRate, validVoice } from './voice.settings';
import { PUSH_TALK_CHOICES, PushToTalk, pushTalkAnswer, pushTalkChoice, spokenSummary, type PushTalkAnswer, type PushTalkChoice } from './push.talk';
import { shouldSpeakUpdate, spokenUpdate } from './spoken.updates';
import { alreadyARule, correctionRule, sampleApplications, withRule } from './teach';
import { applyReport, cleanGoal, filesToCheck, forgetGone, outcomeEnvironment, outcomeQueue, outcomeTaskWords, queueLine, validOutcomes, type FolderOutcome } from './folder.outcomes';
import { applyPlan, cleanFolder, includeKept, isRevision, keepFile, keepManual, manualEdits, moveFile, moveGroup, planConflicts, previewTree, receivePlan, revisionHint, type AppliedPlan, type OrganizePlan } from './organize.plan';
import { briefing, budgetNote, nightBranch, nightBudget, nightContinue, nightDeadline, nightNext, nightWords, spentBy, worktreeCommand, type NightShift } from './night.shift';
import { saveSkill, skillDraft, skillName, type SkillDraft } from './skill.capture';
import { arrivalsSince, cleanBookmark, whereWasI } from './where.was.i';
import type { TranscriptItem } from '../renderer/src/engine.state';
import { randomUUID } from 'node:crypto';
import { macBin } from './bin';
import { answerFromNotification, notificationChoices } from './approval.notification';
import { linkConfirmation, parseTaskLink } from './bimax.link';
import { DEFAULT_SHORTCUT, SHORTCUT_CHOICES, chosenShortcut, shortcutLabel, switchShortcut } from './quick.shortcut';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync, existsSync, appendFileSync, statSync, readdirSync, watch as watchFolder } from 'node:fs';
import fsp from 'node:fs/promises';
import {
  spawnEngine, recentEngineLog, engineProcessProvenance,
} from './engine';
import { buildDiagnosticExport } from './diagnostic.export';
import { DesktopEvidenceStore } from './evidence.store';
import { buildEvidenceTimeline, retentionControls } from '../shared/evidence.timeline';
import type { WindowChromeState } from '../shared/window.chrome';
import { EngineSupervisor } from './supervisor/supervisor';
import { CrashJournal, redactSecrets } from './supervisor/journal';
import { SupervisorStatus } from './supervisor/types';
import { availableBytes, type SystemMemorySample } from './supervisor/resources';
import { gitDiff, gitBranches, gitLog, gitRemoteInfo, gitFetch, gitPull, gitPush, stampedGitStatus } from './git';
import { discoverLocalModels } from './local.models';
import { listDir, readFilePreview, writeFileContent, readSessionMeta, watchProject, searchFiles, ProjectWatch } from './files';
import { createPty, writePty, resizePty, killPty, killAllPtys } from './pty';
import { pickInitialProject, loadSettings, recordProject, recentProjects, isRealProject, saveSettings } from './settings';
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

// A development run must not BE the installed app. `productName` is "Bimax" in both, so both
// resolved userData to the same ~/Library/Application Support/Bimax — with two consequences that
// look nothing alike. The single-instance lock below is keyed on that directory, so starting
// `npm run dev` while the installed Bimax was open took the `!ownsSingleInstance` branch and
// quit: the dev process exited 0 having printed nothing after "starting electron app...", which
// reads as a broken electron-vite rather than a refusal. And on the runs where dev DID own the
// lock, it read and wrote the user's real threads, settings, provider credentials and
// engine.log — the same hazard the jest suite had when it blanked the configured model, one
// level up and with no BIMAX_BREAKGLASS_DIR in the path.
//
// Separating the directory fixes both. It must happen before requestSingleInstanceLock (which is
// keyed on it) and before anything resolves a path under userData, so it lives here at the top of
// module scope rather than in an app-ready handler.
if (!app.isPackaged) {
  const devUserData = path.join(app.getPath('appData'), 'Bimax (dev)');
  mkdirSync(devUserData, { recursive: true });
  app.setPath('userData', devUserData);
}

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
/** The shortcut chosen for the ⌘2 bar (quick.shortcut.ts), kept even while another app holds it. */
let wantedShortcut = DEFAULT_SHORTCUT;
const shortcutRegistry = {
  register: (accelerator: string, callback: () => void): boolean => globalShortcut.register(accelerator, callback),
  unregister: (accelerator: string): void => globalShortcut.unregister(accelerator),
};
let listTimer: ReturnType<typeof setTimeout> | undefined;
// The ⌘2 bar's own conversation, where the user last put it, and how tall it currently is.
let quickThreadId: string | null = null;
let quickAnchor: { x: number; y: number } | null = null;
let quickHeight: number = QUICK_BAR.collapsedHeight;
let quickMoving = false;
// A folder picker opened from the bar takes focus; that blur must not hide the bar it was opened from.
let quickPicking = false;
function threadList() {
  return {
    activeId: threads?.activeId ?? null, threads: threads?.list() ?? [], shortcutAvailable, shortcut: shortcutLabel(wantedShortcut),
    archivedCount: threadStorage?.archivedCount() ?? 0,
  };
}
function threadChanged(): void {
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = undefined;
    broadcast('threads:list', threadList());
    updateTray();
    const finished = notchDeck?.update(threads.list());
    if (finished?.length) dockFinished(finished);
    if (quickWindow && !quickWindow.isDestroyed()) quickWindow.webContents.send('threads:quick-activity', quickActivity());
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
function auxiliaryWindow(kind: 'quick' | 'approval' | 'organize'): BrowserWindow {
  const mac = process.platform === 'darwin';
  const glass = liquidGlass();
  const window = new BrowserWindow({
    width: kind === 'quick' ? QUICK_BAR.width : kind === 'organize' ? 760 : 520,
    height: kind === 'quick' ? QUICK_BAR.collapsedHeight : kind === 'organize' ? 620 : 380,
    show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: true,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: true, roundedCorners: true,
    ...(mac ? { type: 'panel' as const } : {}),
    ...(mac && !glass ? { vibrancy: 'hud' as const, visualEffectState: 'active' as const } : {}),
    title: kind === 'quick' ? 'Bimax Threads' : kind === 'organize' ? 'Organize preview' : 'Bimax needs your decision',
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
      voice.stop(window.webContents.id);
      // FL11: talking goes on in the background; the menu bar shows it and can stop it. A forgotten conversation still
      // ends by itself after two minutes of silence (talk.session.ts QUIET_END_MS).
      if (talkOwner === 'quick' && talk.active) { talkLog('the ⌘2 bar was hidden: talking goes on in the background'); updateTray(); }
      if (quickThreadId && threads.approvals().some(a => a.threadId === quickThreadId)) showThreadApproval();
    });
    // FL11: back on screen, the bar shows the conversation again, so the menu bar goes back to the tasks.
    window.on('show', () => { if (talkOwner === 'quick' && talk.active) updateTray(); });
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
    const activity = quickActivity();
    return { id: summary.id, title: summary.title, root: summary.root, state, queued: activity?.queued ?? 0, notice: activity?.notice ?? null };
  } catch {
    quickThreadId = null;
    return null;
  }
}
/** The ⌘2 bar's footer: how many messages its task has queued, and why it is waiting (backlog N12). */
function quickActivity(): { id: string; queued: number; notice: string | null } | null {
  if (!quickThreadId) return null;
  try {
    const summary = threads.summary(quickThreadId);
    return { id: summary.id, queued: summary.queued ?? 0, notice: threadNotice(summary) };
  } catch {
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
/** `context`: a folder chosen in Bimax itself (the welcome screen), used instead of Finder's; it never hides the bar. */
async function showQuickBar(context?: QuickContext): Promise<void> {
  if (quickWindow?.isVisible() && !context) { quickWindow.hide(); return; }
  // Freeze the Finder folder BEFORE taking keyboard focus, so the bar never reads its own window. A bar that
  // is already running a task keeps that task's folder.
  if (context) quickContext = context;
  else if (!quickThreadId) quickContext = await finderContext();
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
function loadModelTimes(): Record<string, ModelTime> {
  if (!modelTimesLoaded) { for (const [model, time] of Object.entries(loadSettings().modelTimes ?? {})) modelTimes.set(model, time); modelTimesLoaded = true; }
  return Object.fromEntries(modelTimes);
}
/** A finished turn's time, and whether it failed (FL9: a model that fails often is not "handling tools well"). */
function recordModelTime(id: string, tookMs: number | undefined): void {
  const { summary } = threads.get(id);
  const failed = summary.outcome === 'failed';
  if (!failed && (!tookMs || tookMs < 500)) return;
  loadModelTimes();
  const model = summary.model || bimaxModel();
  if (!model) return;
  modelTimes.set(model, recordTurn(modelTimes.get(model), tookMs ?? 0, failed));
  saveSettings({ modelTimes: Object.fromEntries(modelTimes) });
}
/** The model a new ⌘2 task starts with (FL9: "fastest measured" resolves to a model here). */
function quickModel(): string | undefined {
  return quickModelFor(loadSettings().quickModel, modelCatalog, loadModelTimes());
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
  loadModelTimes();
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
  if (talkOwner === 'quick' && talk.threadId && talk.threadId !== id) talk.end();
  quickThreadId = id;
  if (quickWindow?.isVisible()) { sendQuickThread(); quickWindow.focus(); return; }
  void showQuickBar();
}
/** Open a thread where it lives: a ⌘2 task in the bar, a project in the main window. */
function openThread(id: string): void {
  if (threads.get(id).summary.origin === 'project') { selectThread(id); revealMainWindow(); }
  else showQuickThread(id);
}
/** N9: say a finished task out loud, when the person turned spoken updates on and is not looking at it. */
function speakFinished(id: string): void {
  const { summary, state } = threads.get(id);
  const onScreen = (id === quickThreadId && !!quickWindow?.isVisible()) || (id === threads.activeId && !!win?.isFocused());
  if (!shouldSpeakUpdate({ enabled: loadSettings().speakUpdates === true, onScreen, talking: talk.active, listening: pushTalk.listening })) return;
  const answer = [...state.items].reverse().find((item) => item.kind === 'msg' && item.msg.role === 'assistant');
  speakAloud(spokenUpdate(summary, answer && answer.kind === 'msg' ? answer.msg.content : ''));
}
/** A task finished while it was not on screen: say so, with the start of its answer. */
function notifyFinished(id: string, force = false): void {
  if (!Notification.isSupported()) return;
  const { summary, state } = threads.get(id);
  const onScreen = (id === quickThreadId && quickWindow?.isVisible()) || (id === threads.activeId && win?.isFocused());
  if (onScreen && !force) return;
  const answer = [...state.items].reverse().find((item) => item.kind === 'msg' && item.msg.role === 'assistant');
  const body = answer && answer.kind === 'msg' ? answer.msg.content.replace(/\s+/g, ' ').trim().slice(0, 160) : 'Finished.';
  // The subtitle says what the completion check found (F3), not just that the model stopped.
  const verdict = summary.outcome === 'time-limit' ? 'Stopped at its time limit' : summary.check === 'failed' ? 'Check failed' : summary.check === 'unchecked' ? 'Finished, not checked,' : summary.check === 'passed' ? 'Done, check passed,' : summary.check === 'tests-edited' ? 'Check passed after test edits' : 'Done';
  const note = new Notification({ title: summary.title, subtitle: `${verdict} in ${path.basename(summary.root)}`, body: body || 'Finished.' });
  note.on('click', () => openThread(id));
  note.show();
}
/** Dictation (voice.ts): one on-device helper per dictation; its events go only to the window that started it. */
const voiceHelper = (): string => voiceHelperPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
/**
 * God's Land, stage 1: Bimax in the notch (notch.ts, native/notch). On unless turned off in the menu bar; it needs the
 * helper on disk (a build without it simply has no notch) and a Mac, and it follows the ⌘2 tasks from here on.
 */
let notchDeck: NotchDeck | null = null;
/**
 * Stage 3. Files handed to "Edit with Bimax" wait here until a ⌘2 task is started with them; that task is then a
 * notch task, and when it finishes the files it changed come back to the shelf (the Hatchback). Real paths, so the
 * bar's own resolved attachments match. Forgotten after ten minutes: an edit that was never started is not a task.
 */
let notchEditPending: { files: string[]; at: number } | null = null;
const notchTasks = new Map<string, number>();
const NOTCH_EDIT_WINDOW_MS = 10 * 60_000;
async function editFromNotch(paths: string[]): Promise<void> {
  const files: string[] = [];
  for (const file of paths) { try { files.push(await fsp.realpath(file)); } catch { /* gone since it was dropped */ } }
  if (!files.length) return;
  // Where the bar is about to open — the same placement showQuickBar uses — so the Droplet lands on it.
  const cursorArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const anchor = quickBarOrigin(loadSettings().quickBar, screen.getAllDisplays().map(d => d.workArea), cursorArea);
  const area = screen.getDisplayMatching({ ...anchor, width: QUICK_BAR.width, height: QUICK_BAR.collapsedHeight }).workArea;
  await notchDeck?.playDroplet(quickBarBounds(anchor, QUICK_BAR.collapsedHeight, area), files[0]);
  notchEditPending = { files, at: Date.now() };
  await openFilesInBar(files);
}
/** A ⌘2 task just started: it is a notch task when it carries a file handed over by "Edit with Bimax". */
function noteNotchTask(id: string, attachments: readonly QuickAttachment[]): void {
  const pending = notchEditPending;
  if (!pending || Date.now() - pending.at > NOTCH_EDIT_WINDOW_MS) { notchEditPending = null; return; }
  if (!attachments.some((a) => a.path && pending.files.includes(a.path))) return;
  notchTasks.set(id, Date.now());
  notchEditPending = null;
}
/** The Hatchback: a notch task finished, so the files it made or changed during that turn go to the shelf. */
function dockFinished(finished: readonly ThreadSummary[]): void {
  for (const t of finished) {
    const since = notchTasks.get(t.id);
    if (since === undefined) continue;
    const files = filesChangedSince(threadStateRoot(app.getPath('userData'), t.root, t.origin), since);
    notchDeck?.dock(files, { task: t.title, ...(t.check ? { check: t.check } : {}) });
    notchTasks.set(t.id, Date.now()); // the next turn brings back only its own changes
  }
}
function syncNotch(): void {
  if (process.platform !== 'darwin') return;
  const wanted = loadSettings().notchDeck !== false;
  const helper = notchHelperPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  if (wanted && !notchDeck && existsSync(helper)) {
    const shelfRoot = path.join(app.getPath('userData'), 'gods-land');
    notchDeck = new NotchDeck({
      helper, onOpenTask: (id) => { try { openThread(id); } catch { /* the task is gone */ } }, log: (line) => console.log(`[notch] ${line}`),
      // Stage 2: the shelf, kept beside the app's other state; copies of temporary files live under it.
      shelf: new Shelf(path.join(shelfRoot, 'shelf.json'), path.join(shelfRoot, 'shelf-copies')),
      onEdit: (paths) => { void editFromNotch(paths); },
      // Stage 5: the clipboard history, kept on this Mac only and off until the person turns it on.
      clipboard: (() => {
        // Stage 6: a secret copy is kept sealed by Electron's safeStorage (the Keychain-held key, as provider keys are).
        // It is asked for only when a secret is actually copied or revealed — never at launch.
        const sealer = {
          seal: (text: string) => { if (!safeStorage.isEncryptionAvailable()) throw new Error('no storage key'); return safeStorage.encryptString(text).toString('base64'); },
          open: (sealed: string) => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
        };
        const history = new ClipHistory(path.join(shelfRoot, 'clipboard.json'), Date.now, sealer);
        return {
          enabled: () => loadSettings().clipboardHistory === true,
          setEnabled: (on: boolean) => { saveSettings({ clipboardHistory: on }); updateTray(); },
          add: (text: string, source?: string) => history.add(text, source),
          pin: (id: string, pinned: boolean) => history.pin(id, pinned),
          remove: (id: string) => history.remove(id),
          view: (on: boolean) => history.view(on),
          reveal: (id: string) => history.reveal(id),
        };
      })(),
      // Stage 6: secrets in .env files of the folders opened in Bimax — recent projects and the ⌘2 tasks' folders.
      secrets: {
        scan: () => {
          const settings = loadSettings();
          const roots = [...new Set([settings.lastProject, ...(settings.recentProjects ?? []), ...(threads ? threads.list().map((t) => t.root) : [])].filter((r): r is string => !!r))];
          return scanFolders(roots);
        },
      },
      // Stage 4: a Night Shift task working turns the glass to night (FL5's own list).
      nightIds: () => new Set(nightShifts.keys()),
    });
  }
  if (!notchDeck) return;
  if (!wanted) { if (notchDeck.running()) notchDeck.pause(); return; }
  notchDeck.start();
  if (threads) notchDeck.update(threads.list());
}
const voice = new VoiceSessions({
  spawn: (args) => {
    const child = spawn(voiceHelper(), args, { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.setEncoding('utf8');
    return child;
  },
  send: (owner, event) => {
    if (owner === PUSH_TALK_OWNER) { pushTalk.onEvent(event); return; }
    const target = electronWebContents.fromId(owner);
    if (target && !target.isDestroyed()) target.send('voice:event', event);
    else voice.cancel(owner);
  },
});
/**
 * Talk mode (talk.session.ts): a spoken conversation through one warm on-device helper, in the ⌘2 bar's task or in the
 * project open in the main window, whichever window started it. The engine it talks to writes replies to be heard
 * (BIMAX_THREAD_VOICE) and answers with a quick model (talkModel): a ⌘2 talk task has both from the start, a project
 * only while talking (ThreadManager.setTalk).
 */
let talkRoot: string | null = null;
let talkModelChoice: string | undefined;
let talkOwner: 'quick' | 'main' = 'quick';
let talkShown: { state: string; error: string | null } = { state: 'off', error: null };
/** Talk mode's own trail (userData/talk.log): its states, errors and why it ended. Never what was said. */
function talkLog(line: string): void {
  try {
    const file = path.join(app.getPath('userData'), 'talk.log');
    if (existsSync(file) && statSync(file).size > 512_000) renameSync(file, `${file}.1`);
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch { /* the trail must never get in the way of talking */ }
}
const talkWindow = (): BrowserWindow | null => (talkOwner === 'main' ? win : quickWindow);
const talk = new TalkSession({
  spawn: (onEvent, onExit) => {
    const context = ['Bimax', ...(talkRoot ? [path.basename(talkRoot)] : [])];
    // N7: the voice and speed chosen in Settings → Voice.
    const args = [...helperArguments('--talk', { locales: app.getPreferredSystemLanguages(), context }), ...speakingArguments(loadSettings()),
      ...(loadSettings().talkBargeIn === true ? ['--barge-in'] : [])];
    const child = spawn(voiceHelper(), args, { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.setEncoding('utf8');
    // A command written just as the helper exits must not become an uncaught EPIPE in the main process.
    child.stdin.on('error', () => {});
    child.on('exit', (code, signal) => talkLog(`helper exited code=${code} signal=${signal ?? '-'}`));
    talkLog(`helper starts for the ${talkOwner === 'main' ? 'main window' : '⌘2 bar'}`);
    return talkHelper(child, (event) => {
      if (event.event !== 'partial' && event.event !== 'level') {
        const detail = event.event === 'utterance' ? ` (${String(event.text ?? '').length} chars)`
          : event.event === 'error' ? `: ${event.message}`
          : event.event === 'ready' ? ` voice=${event.voice} quality=${event.quality} locale=${event.locale}` : '';
        talkLog(`helper ${event.event}${detail}`);
      }
      onEvent(event);
    }, onExit);
  },
  openThread: () => {
    if (talkOwner === 'main') {
      const id = threads.activeId;
      if (!id) throw new Error('Open a project to talk about it.');
      threads.setTalk(id, true, talkModelChoice);
      threads.start(id);
      return id;
    }
    // Talking again in the bar's talk task carries on that conversation; otherwise a new task starts in the bar's folder.
    if (!talkRoot) throw new Error('Choose a folder for this task first.');
    const shown = quickThreadSnapshot();
    const id = shown && shown.root === talkRoot && threads.get(shown.id).summary.voice
      ? shown.id
      : threads.create(talkRoot, '', 'quick', talkModelChoice, true);
    quickThreadId = id;
    threads.start(id);
    sendQuickThread();
    return id;
  },
  submit: (id, words, engineText) => threads.submit(id, engineText, words),
  answer: (id, requestId, text) => {
    const pending = threads.approvals().find((a) => a.threadId === id && a.request.id === requestId);
    if (!pending) throw new Error('That question has expired.');
    threads.send(id, { t: 'reply', id: requestId, value: text, approvalToken: pending.token });
    // A window closes a card it answered itself; one answered by voice is closed from the thread's own state.
    if (talkOwner === 'main' && id === threads.activeId) threads.select(id);
    else if (id === quickThreadId) sendQuickThread();
  },
  interrupt: (id) => threads.send(id, { t: 'interrupt' }),
  show: (view) => {
    if (view.state !== talkShown.state || view.error !== talkShown.error) talkLog(`state ${view.state}${view.error ? ` (${view.error})` : ''}`);
    const stateChanged = view.state !== talkShown.state;
    talkShown = { state: view.state, error: view.error };
    // FL11: the menu bar follows the conversation while the bar is hidden.
    if (stateChanged && talkOwner === 'quick' && !quickWindow?.isVisible()) updateTray();
    const target = talkWindow();
    if (target && !target.isDestroyed()) target.webContents.send('talk:state', view);
  },
  // A project goes back to its own model and style once the talking is over.
  closed: (id) => {
    talkLog(`ended${id ? ` in thread ${id}` : ''}`);
    updateTray();
    if (!id || talkOwner !== 'main') return;
    try { threads.setTalk(id, false); } catch { /* the thread is gone */ }
  },
});
/** Threads that were busy when their folder's rules changed: they restart on the new rules when their turn ends. */
const rulesStale = new Set<string>();
/** The rule a correction offered in the ⌘2 bar (N10), until it is saved or another offer replaces it. */
let teachOffer: { root: string; rule: string } | null = null;
/** Save a folder's rules; idle engines there restart on them now (resuming their conversation), busy ones after their turn. */
function saveFolderRules(root: string, rules: { text: string; protect: string[] }, note: string): void {
  const all = { ...(loadSettings().folderRules ?? {}) };
  if (rules.text || rules.protect.length) all[root] = rules;
  else delete all[root];
  saveSettings({ folderRules: all });
  restartThreadsIn(root);
  if (quickThreadId && threads.get(quickThreadId).summary.root === root) threads.addNote(quickThreadId, note);
}
/** A folder's settings changed: idle engines there restart on them now (resuming their conversation), busy ones after their turn. */
function restartThreadsIn(root: string): void {
  for (const thread of threads.list()) {
    if (thread.root !== root || !threads.engine(thread.id)) continue;
    if (!threads.restartIfIdle(thread.id)) rulesStale.add(thread.id);
  }
}
/** The folder whose rules the bar is editing — fixed when the editor opens, so a save cannot land on another folder. */
let rulesEditingRoot: string | null = null;
/** The words the user first gave a task — what a repeat of it asks again. */
function firstPrompt(id: string): string | null {
  const item = threads.get(id).state.items.find((entry) => entry.kind === 'msg' && entry.msg.role === 'user');
  return item && item.kind === 'msg' ? item.msg.content.trim() || null : null;
}
const loadSchedules = (): Schedule[] => loadSettings().schedules ?? [];
function saveSchedules(list: Schedule[]): void { saveSettings({ schedules: list }); updateTray(); }
const removeSchedule = (id: string): void => saveSchedules(loadSchedules().filter((s) => s.id !== id));
/** Resuming counts from now, so a paused schedule never starts a run it missed while paused. */
const setScheduleEnabled = (id: string, enabled: boolean): void =>
  saveSchedules(loadSchedules().map((s) => (s.id === id ? { ...s, enabled, ...(enabled ? { lastRunAt: Date.now() } : {}) } : s)));
/**
 * One run of a repeating task: a new ⌘2 task in its folder, which asks before changing anything like every task.
 * 'busy' (four tasks already running) creates nothing, so the run is tried again a minute later.
 */
async function startScheduled(schedule: Schedule): Promise<'started' | 'busy' | 'failed'> {
  if (threads.list().filter((t) => ['working', 'starting', 'needs-you'].includes(t.status)).length >= 4) return 'busy';
  try {
    const root = await fsp.realpath(schedule.root);
    if (!(await fsp.stat(root)).isDirectory()) throw new Error(`${path.basename(schedule.root)} is not a folder`);
    const id = threads.create(root, '', 'quick', schedule.model || quickModel());
    threads.addNote(id, `${describeSchedule(schedule)} · scheduled task`);
    threads.submit(id, schedule.prompt, schedule.prompt, true);
    if (Notification.isSupported()) {
      const note = new Notification({ title: `Scheduled: ${schedule.title}`, subtitle: `Started in ${path.basename(root)}`, body: 'It will ask before it changes anything.' });
      note.on('click', () => openThread(id));
      note.show();
    }
    return 'started';
  } catch (error) {
    if (Notification.isSupported()) new Notification({ title: `Couldn’t start “${schedule.title}”`, body: (error as Error).message }).show();
    return 'failed';
  }
}
let schedulesRunning = false;
async function runSchedules(): Promise<void> {
  if (schedulesRunning || !threads) return;
  schedulesRunning = true;
  try {
    const now = Date.now();
    const { due, skipped } = dueSchedules(loadSchedules(), now);
    const done = new Set(skipped.map((s) => s.id));
    for (const schedule of due) if ((await startScheduled(schedule)) !== 'busy') done.add(schedule.id);
    if (done.size) saveSchedules(loadSchedules().map((s) => (done.has(s.id) ? { ...s, lastRunAt: now } : s)));
  } finally {
    schedulesRunning = false;
  }
}
async function runScheduleNow(id: string): Promise<void> {
  const schedule = loadSchedules().find((s) => s.id === id);
  if (schedule && (await startScheduled(schedule)) === 'busy') {
    void dialog.showMessageBox({ type: 'info', message: 'Four tasks are already running.', detail: 'Stop one, or let one finish, then run it again.' });
  }
}
/** The menu bar's "Scheduled tasks": each repeating task with Run now, Pause/Resume and Stop repeating. */
function scheduleMenu(): Electron.MenuItemConstructorOptions[] {
  const list = loadSchedules();
  if (!list.length) return [];
  return [
    { label: 'Scheduled tasks', submenu: list.map((s): Electron.MenuItemConstructorOptions => ({
      label: `${s.enabled ? '' : 'Paused · '}${s.title.slice(0, 48)} — ${describeSchedule(s)}`,
      submenu: [
        { label: `In ${path.basename(s.root)}`, enabled: false },
        { label: 'Run now', click: () => void runScheduleNow(s.id) },
        { label: s.enabled ? 'Pause' : 'Resume', click: () => setScheduleEnabled(s.id, !s.enabled) },
        { type: 'separator' },
        { label: 'Stop repeating', click: () => removeSchedule(s.id) },
      ],
    })) },
    { type: 'separator' },
  ];
}
/** Watches folders for their triggers while Bimax is open; created once threads exist. */
let folderTriggers: FolderTriggers | null = null;
/** Wakes tasks asked for (backlog F4, wakes.ts): a time, a folder change, a CI result. Armed once threads load. */
let wakes: Wakes | null = null;

/** The CI runs for one commit, from the GitHub CLI in the task's folder (F4). */
function ciRunsFor(root: string, sha: string): Promise<CiState> {
  return new Promise((resolve) => {
    execFile('gh', ['run', 'list', '--commit', sha, '--json', 'name,status,conclusion,url', '--limit', '30'], { cwd: root, timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) { resolve({ state: 'error', message: (stderr || error.message).trim().split('\n')[0].slice(0, 200) }); return; }
      try {
        const runs = JSON.parse(stdout) as Array<{ name?: string; status?: string; conclusion?: string; url?: string }>;
        if (!runs.length || runs.some((run) => run.status !== 'completed')) { resolve({ state: 'waiting' }); return; }
        resolve({ state: 'done', runs: runs.map((run) => ({ name: String(run.name ?? 'run'), status: String(run.status), conclusion: String(run.conclusion ?? ''), url: run.url })) });
      } catch {
        resolve({ state: 'error', message: 'gh returned something that is not a list of runs' });
      }
    });
  });
}
const loadTriggers = (): FolderTrigger[] => validTriggers(loadSettings().folderTriggers, os.homedir());
function saveTriggers(list: FolderTrigger[]): void {
  saveSettings({ folderTriggers: list });
  updateTray();
  void folderTriggers?.sync(list);
}
const removeTrigger = (id: string): void => saveTriggers(loadTriggers().filter((t) => t.id !== id));
/** Resuming counts from now, like a schedule: files that arrived while it was paused are not run. */
const setTriggerEnabled = (id: string, enabled: boolean): void =>
  saveTriggers(loadTriggers().map((t) => (t.id === id ? { ...t, enabled, pausedReason: undefined } : t)));
/**
 * One run of a folder trigger (folder.triggers.ts, backlog FL1): a new ⌘2 task on the files that arrived, which asks
 * before changing anything like every task. 'busy' (four tasks running, or a task working in or around the folder)
 * creates nothing, so the files wait; a run never shares its folder, so the undo journal's entries are its own.
 */
function startTriggered(trigger: FolderTrigger, files: string[], followUp: boolean): StartResult {
  const running = threads.list().filter((t) => ['working', 'starting', 'needs-you'].includes(t.status));
  if (running.length >= 4 || running.some((t) => insideFolder(t.root, trigger.root) || insideFolder(trigger.root, t.root))) return 'busy';
  try {
    const id = threads.create(trigger.root, '', 'quick', trigger.model || quickModel());
    threads.addNote(id, `${describeTrigger(trigger)} · folder trigger${followUp ? ' · these files appeared while its last run was working' : ''}`);
    const { text, display } = runMessage(trigger, files);
    threads.submit(id, text, display, true);
    if (Notification.isSupported()) {
      const what = files.length === 1 ? path.basename(files[0]) : `${files.length} new files`;
      const note = new Notification({ title: `Started: ${trigger.title}`, subtitle: `${what} in ${path.basename(trigger.root)}`, body: 'It will ask before it changes anything.' });
      note.on('click', () => openThread(id));
      note.show();
    }
    return { threadId: id };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
// ── Folders with an outcome (backlog FL1 part 2, folder.outcomes.ts) ─────────────────────────────
const loadOutcomes = (): Record<string, FolderOutcome> => validOutcomes(loadSettings().folderOutcomes, os.homedir());
function saveOutcomes(all: Record<string, FolderOutcome>): void {
  saveSettings({ folderOutcomes: all });
  updateTray();
}
/** Set or change a folder's outcome. Its trigger runs the outcome's words on every arrival; tasks there restart on it. */
function setOutcome(root: string, goal: string): string | null {
  const problem = triggerFolderProblem(root, os.homedir());
  if (problem) return problem;
  const all = loadOutcomes();
  const existing = all[root];
  if (!existing && Object.keys(all).length >= 20) return 'Bimax already keeps 20 folders ready.';
  const triggers = loadTriggers();
  const current = existing ? triggers.find((t) => t.id === existing.triggerId) : undefined;
  if (!current && triggers.length >= MAX_TRIGGERS) return `Bimax already watches ${MAX_TRIGGERS} folders.`;
  const title = `Keep ${path.basename(root)} ready`;
  const trigger = current ? { ...current, title, prompt: outcomeTaskWords(goal) }
    : newTrigger({ id: randomUUID(), title, root, prompt: outcomeTaskWords(goal), kind: 'any', now: Date.now() });
  saveTriggers([...triggers.filter((t) => t.id !== trigger.id), trigger]);
  all[root] = { root, goal, createdAt: existing?.createdAt ?? Date.now(), triggerId: trigger.id, items: existing?.items ?? {} };
  saveOutcomes(all);
  restartThreadsIn(root);
  return null;
}
function clearOutcome(root: string): void {
  const all = loadOutcomes();
  const outcome = all[root];
  if (!outcome) return;
  delete all[root];
  saveOutcomes(all);
  removeTrigger(outcome.triggerId);
  restartThreadsIn(root);
}
/** A task on the files already in the folder, so the queue does not wait for new arrivals. */
async function checkOutcomeNow(root: string): Promise<string | null> {
  const outcome = loadOutcomes()[root];
  if (!outcome) return 'This folder has no outcome.';
  const running = threads.list().filter((t) => ['working', 'starting', 'needs-you'].includes(t.status));
  if (running.length >= 4 || running.some((t) => insideFolder(t.root, root) || insideFolder(root, t.root))) return 'A task is already working in this folder; check again when it is done.';
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const files = filesToCheck(entries.filter((entry) => entry.isFile()).map((entry) => entry.name), root);
  if (!files.length) return 'There are no files directly in this folder to check.';
  const id = threads.create(root, '', 'quick', quickModel());
  const folder = path.basename(root);
  threads.submit(id, `${outcomeTaskWords(outcome.goal)}\n\n[Check the files already in ${folder}:]\n${files.map((file) => `- ${file}`).join('\n')}`,
    `Check ${files.length} file${files.length === 1 ? '' : 's'} in ${folder} against: ${outcome.goal}`, true);
  showQuickThread(id);
  return null;
}
/** The menu bar's folders with an outcome: what needs you (click to show the file), how many are ready. */
function outcomeMenu(): Electron.MenuItemConstructorOptions[] {
  const all = Object.values(loadOutcomes());
  const header: Electron.MenuItemConstructorOptions[] = [{ label: 'Keep a Folder Ready…', click: () => void pickOutcomeFolder() }];
  if (!all.length) return [...header, { type: 'separator' }];
  return [
    ...all.map((stored): Electron.MenuItemConstructorOptions => {
      const outcome = forgetGone(stored, (file) => existsSync(file));
      const queue = outcomeQueue(outcome);
      return { label: `${path.basename(outcome.root)}: ${queueLine(queue)}`, submenu: [
        { label: outcome.goal.length > 90 ? `${outcome.goal.slice(0, 89)}…` : outcome.goal, enabled: false },
        ...(queue.needsYou.length ? [{ type: 'separator' as const }, { label: 'Needs you', enabled: false },
          ...queue.needsYou.slice(0, 15).map((item): Electron.MenuItemConstructorOptions => ({
            label: `${item.path} — ${item.reason}`.slice(0, 100), click: () => shell.showItemInFolder(path.join(outcome.root, item.path)),
          }))] : []),
        ...(queue.ready.length ? [{ label: `${queue.ready.length} ready`, enabled: false }] : []),
        { type: 'separator' },
        { label: 'Check the Files Here Now', click: () => { void checkOutcomeNow(outcome.root).then((problem) => { if (problem) void dialog.showMessageBox({ type: 'info', message: problem }); }); } },
        { label: 'Change the Outcome…', click: () => void openOutcomeEditor(outcome.root) },
        { label: 'Open Folder', click: () => void shell.openPath(outcome.root) },
        { label: 'Stop Keeping It Ready', click: () => clearOutcome(outcome.root) },
      ] };
    }),
    ...header,
    { type: 'separator' },
  ];
}
let outcomeEditingRoot: string | null = null;
async function openOutcomeEditor(root: string): Promise<void> {
  outcomeEditingRoot = root;
  if (!quickWindow?.isVisible() || (quickThreadSnapshot()?.root ?? quickContext.root) !== root) { quickThreadId = null; await showQuickBar({ root, source: 'Selected folder' }); }
  quickWindow?.webContents.send('threads:open-outcome');
}
async function pickOutcomeFolder(): Promise<void> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Choose a folder to keep ready', buttonLabel: 'Choose' });
  if (result.canceled || !result.filePaths[0]) return;
  await openOutcomeEditor(await fsp.realpath(result.filePaths[0]));
}
// ── A preview you can rearrange (backlog FL2, organize.plan.ts) ──────────────────────────────────
let organizeWindow: BrowserWindow | null = null;
let organizing: OrganizePlan | null = null;
/** What the preview window shows: the tree, what blocks applying, and how many moves the person changed. */
function organizeView(): unknown {
  if (!organizing) return null;
  return {
    id: organizing.id, title: organizing.title, root: organizing.root, total: organizing.moves.length,
    byYou: organizing.moves.filter((m) => m.byYou).length,
    tree: previewTree(organizing), conflicts: planConflicts(organizing, (file) => existsSync(file)),
    kept: (organizing.kept ?? []).map((m) => ({ from: path.relative(organizing!.root, m.from), to: path.relative(organizing!.root, m.to) })),
  };
}
/** The last plan applied in each folder, with each file's inode, so a revision can tell what the person moved since (FL3). */
const organizeHistoryFile = (): string => path.join(app.getPath('userData'), 'organize-history.json');
function loadOrganizeHistory(): Record<string, AppliedPlan> {
  try { const raw = JSON.parse(readFileSync(organizeHistoryFile(), 'utf8')); return raw && typeof raw === 'object' ? raw : {}; } catch { return {}; }
}
function rememberApplied(plan: OrganizePlan): void {
  const placements = plan.moves.filter((m) => existsSync(m.to) && !existsSync(m.from)).map((m) => ({ path: m.to, ino: statSync(m.to).ino }));
  const all = loadOrganizeHistory();
  all[plan.root] = { root: plan.root, threadId: plan.threadId, at: Date.now(), title: plan.title, placements };
  try { writeFileSync(organizeHistoryFile(), JSON.stringify(all)); } catch { /* a revision then simply keeps nothing aside */ }
}
/** Where each wanted inode is now inside the folder, from one bounded walk (skipping .git and node_modules). */
function locateInodes(root: string, wanted: ReadonlySet<number>, limit = 20_000): Map<number, string> {
  const found = new Map<number, string>();
  const queue = [root];
  let seen = 0;
  while (queue.length && found.size < wanted.size && seen < limit) {
    const dir = queue.shift()!;
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > limit) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== '.git' && entry.name !== 'node_modules') queue.push(full); continue; }
      if (!entry.isFile()) continue;
      try { const ino = statSync(full).ino; if (wanted.has(ino)) found.set(ino, full); } catch { /* gone */ }
    }
  }
  return found;
}
function showOrganize(): void {
  if (!organizeWindow || organizeWindow.isDestroyed()) organizeWindow = auxiliaryWindow('organize');
  organizeWindow.setResizable(true);
  organizeWindow.webContents.send('organize:plan', organizeView());
  organizeWindow.show(); organizeWindow.focus();
}
/** A task proposed a plan: it replaces any plan still waiting (that task is told), and the preview opens. */
function receiveOrganizePlan(threadId: string, raw: unknown): void {
  const root = threads.get(threadId).summary.root;
  let plan = receivePlan(raw, threadId, root);
  if (!plan) return;
  // FL3: a revision keeps the files the person moved by hand since the last plan here where they put them.
  const applied = loadOrganizeHistory()[plan.root];
  if (applied) {
    const inodeAt = (file: string): number | null => { try { return statSync(file).ino; } catch { return null; } };
    const missing = applied.placements.filter((p) => inodeAt(p.path) !== p.ino);
    const where = missing.length ? locateInodes(plan.root, new Set(missing.map((p) => p.ino))) : new Map<number, string>();
    const byHand = new Set(manualEdits(applied, inodeAt, (ino) => where.get(ino) ?? null).map((e) => e.now).filter((p): p is string => !!p));
    plan = keepManual(plan, byHand);
    if (plan.kept?.length) threads.addNote(threadId, `${plan.kept.length} file${plan.kept.length === 1 ? '' : 's'} you moved yourself since “${applied.title}” ${plan.kept.length === 1 ? 'is' : 'are'} kept where you put ${plan.kept.length === 1 ? 'it' : 'them'} (“Include anyway” in the preview).`);
    if (!plan.moves.length && !plan.kept?.length) return;
  }
  if (organizing && organizing.threadId !== threadId) threads.addNote(organizing.threadId, 'Its organize plan was replaced by a newer one from another task, and nothing was moved.');
  organizing = plan;
  threads.addNote(threadId, `A plan to move ${plan.moves.length} files is waiting in the Organize preview. Nothing moves until you apply it.`);
  showOrganize();
}
async function applyOrganizePlan(): Promise<{ ok: boolean; error?: string }> {
  const plan = organizing;
  if (!plan) return { ok: false, error: 'There is no plan to apply.' };
  const summary = threads.get(plan.threadId).summary;
  // Protected items (folder rules) never move, whoever planned it.
  const protect = loadSettings().folderRules?.[plan.root]?.protect ?? [];
  const guarded = plan.moves.find((m) => protect.some((p) => insideFolder(p, m.from) || insideFolder(p, m.to)));
  if (guarded) return { ok: false, error: `${path.relative(plan.root, guarded.from)} is protected by this folder's rules.` };
  const stateRoot = threadStateRoot(app.getPath('userData'), summary.root, summary.origin);
  try {
    const result = await applyPlan(plan, {
      exists: (file) => existsSync(file),
      mkdirp: async (dir) => { await fsp.mkdir(dir, { recursive: true }); },
      rename: (from, to) => fsp.rename(from, to),
      journal: async (line) => {
        await fsp.mkdir(path.dirname(journalFile(stateRoot)), { recursive: true });
        await fsp.appendFile(journalFile(stateRoot), `${JSON.stringify(line)}\n`, 'utf8');
      },
    }, Date.now());
    organizing = null;
    organizeWindow?.hide();
    rememberApplied(plan);
    const yours = plan.moves.filter((m) => m.byYou).length;
    threads.addNote(plan.threadId, result.failed.length
      ? `Moved ${result.moved} of ${plan.moves.length} files, then stopped: ${path.basename(result.failed[0]!.from)} — ${result.failed[0]!.error}. ↶ Undo reverses the ones that moved.`
      : `Applied “${plan.title}”: moved ${result.moved} files${yours ? `, ${yours} where you put them` : ''}. ↶ Undo reverses the whole plan in one step.`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

// ── Night shift (backlog FL5, night.shift.ts) ────────────────────────────────────────────────────
const nightShifts = new Map<string, NightShift & { continuations: number; timer?: NodeJS.Timeout }>();
let nightAwake: number | null = null;
const git = (cwd: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile('git', ['-C', cwd, ...args], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message).trim().split('\n')[0])); else resolve(String(stdout));
  });
});
/** The Mac-wide daily cap (N6): Settings wins, then MAX_DAILY_SPEND, then $5; 0 means none. */
function dailyCapUsd(): number {
  try {
    const value = JSON.parse(readFileSync(path.join(os.homedir(), '.breakglass', 'config.json'), 'utf8')).spendDailyCapUsd;
    if (typeof value === 'number' && value >= 0) return value;
  } catch { /* no config yet */ }
  const env = Number(process.env.MAX_DAILY_SPEND);
  return Number.isFinite(env) && env >= 0 ? env : 5;
}
/** Bimax keeps the Mac awake while any shift runs; the shift cannot work while it sleeps. */
function keepAwake(on: boolean): void {
  if (on && nightAwake === null) nightAwake = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && nightAwake !== null && !nightShifts.size) { powerSaveBlocker.stop(nightAwake); nightAwake = null; }
}
async function startNightShift(folder: string, goal: string, rawBudget: unknown, untilText: unknown): Promise<{ ok: boolean; error?: string; note?: string }> {
  const budget = nightBudget(rawBudget);
  if (!budget) return { ok: false, error: 'Give a budget between $1 and $100.' };
  const until = nightDeadline(String(untilText ?? ''), Date.now());
  if (!until) return { ok: false, error: 'Give the morning time as HH:MM, within 16 hours.' };
  if (!goal.trim()) return { ok: false, error: 'Say what the shift should work on.' };
  let repo: string;
  let base: string;
  try {
    repo = (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
    base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  } catch {
    return { ok: false, error: 'A night shift works on its own git branch, and this folder is not in a git repository with a commit.' };
  }
  const branch = nightBranch(new Date());
  const worktree = path.join(app.getPath('userData'), 'night', branch.replace(/\//g, '-'));
  try { await git(repo, worktreeCommand(worktree, branch)); } catch (error) { return { ok: false, error: `Could not make the isolated checkout: ${(error as Error).message}` }; }
  const id = threads.create(worktree, '', 'quick', quickModel());
  threads.rename(id, `Night shift: ${goal.replace(/\s+/g, ' ').trim().slice(0, 60)}`);
  const shift: NightShift & { continuations: number; timer?: NodeJS.Timeout } = { threadId: id, repo, worktree, branch, base, goal, budgetUsd: budget, startedAt: Date.now(), until, continuations: 0 };
  nightShifts.set(id, shift);
  keepAwake(true);
  shift.timer = setTimeout(() => {
    const s = nightShifts.get(id);
    if (!s) return;
    const { status } = threads.get(id).summary;
    if (status === 'working' || status === 'needs-you' || status === 'starting') threads.send(id, { t: 'interrupt' });
    else void endNightShift(id, 'morning');
  }, until - Date.now());
  threads.submit(id, nightWords(goal, branch, budget, until), goal, true);
  const morning = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  threads.addNote(id, `Night shift on ${branch} until ${morning}, at most $${budget}. It works in an isolated checkout, so your working copy is not touched, and Bimax keeps this Mac awake until it is done.`);
  showQuickThread(id);
  return { ok: true, note: budgetNote(budget, dailyCapUsd()) ?? undefined };
}
function readSpendLedger(): unknown {
  try { return JSON.parse(readFileSync(path.join(app.getPath('userData'), 'spend-ledger.json'), 'utf8')); } catch { return null; }
}
const utcDate = (at: number): string => new Date(at).toISOString().slice(0, 10);
/** A shift's turn ended: carry on with the next milestone, or stop and write the briefing. */
function afterNightTurn(id: string): void {
  const shift = nightShifts.get(id);
  if (!shift) return;
  const { summary, state } = threads.get(id);
  const last = [...state.items].reverse().find((item) => item.kind === 'msg' && item.msg.role === 'assistant');
  const answer = last && last.kind === 'msg' ? last.msg.content : '';
  const spent = spentBy(readSpendLedger(), id, utcDate(shift.startedAt));
  const next = nightNext({ now: Date.now(), until: shift.until, spent, budget: shift.budgetUsd, answer, outcome: summary.outcome, continuations: shift.continuations });
  if (next === 'continue') {
    shift.continuations += 1;
    threads.submit(id, nightContinue((shift.until - Date.now()) / 60_000, shift.budgetUsd - spent), 'Night shift: next milestone', true);
    return;
  }
  void endNightShift(id, next);
}
async function endNightShift(id: string, stoppedBy: 'finished' | 'morning' | 'budget' | 'failed' | 'stopped'): Promise<void> {
  const shift = nightShifts.get(id);
  if (!shift) return;
  nightShifts.delete(id);
  if (shift.timer) clearTimeout(shift.timer);
  keepAwake(false);
  const { summary, state } = threads.get(id);
  const last = [...state.items].reverse().find((item) => item.kind === 'msg' && item.msg.role === 'assistant');
  const answer = last && last.kind === 'msg' ? last.msg.content.replace(/NIGHT SHIFT DONE\s*$/, '').trim() : '';
  const commits = await git(shift.worktree, ['log', '--oneline', '--no-decorate', `${shift.base}..HEAD`]).then((out) => out.split('\n').filter(Boolean), () => []);
  const diffstat = await git(shift.worktree, ['diff', '--stat', `${shift.base}..HEAD`]).catch(() => '');
  const questions = await fsp.readFile(path.join(shift.worktree, 'NIGHT-QUESTIONS.md'), 'utf8').then((t) => t.slice(0, 4000), () => '');
  const text = briefing({ goal: shift.goal, branch: shift.branch, repo: shift.repo, worktree: shift.worktree, commits, diffstat, spentUsd: spentBy(readSpendLedger(), id, utcDate(shift.startedAt)), budgetUsd: shift.budgetUsd, check: summary.check, stoppedBy, answer, questions });
  const file = path.join(app.getPath('userData'), 'night', `${shift.branch.replace(/\//g, '-')}-briefing.md`);
  await fsp.writeFile(file, text, 'utf8').catch(() => undefined);
  threads.addNote(id, text);
  if (Notification.isSupported()) {
    const note = new Notification({ title: 'Night shift briefing', subtitle: `${commits.length} commit${commits.length === 1 ? '' : 's'} on ${shift.branch}`, body: text.split('\n')[2] ?? '' });
    note.on('click', () => openThread(id));
    note.show();
  }
}
// ── Muscle memory (backlog FL6, skill.capture.ts) ────────────────────────────────────────────────
/** The draft a "Save as a Skill" card is editing; only its name and description come back from the bar. */
let skillEditing: { threadId: string; draft: SkillDraft } | null = null;
/** Threads already told "its check passed — save it as a skill", so a follow-up does not repeat it. */
const skillHinted = new Set<string>();
function draftSkill(id: string): SkillDraft {
  const { summary, state } = threads.get(id);
  const first = state.items.find((item) => item.kind === 'msg' && item.msg.role === 'user');
  const since = first && first.kind === 'msg' ? Date.parse(String(first.msg.timestamp)) || 0 : 0;
  const touched = touchedSince(threadStateRoot(app.getPath('userData'), summary.root, summary.origin), since);
  return skillDraft({ title: summary.title, request: firstPrompt(id) ?? summary.title, items: state.items, touched });
}
function openSkillCard(id: string): void {
  const draft = draftSkill(id);
  skillEditing = { threadId: id, draft };
  quickWindow?.webContents.send('threads:open-skill', draft);
}

/** The bar's night shift card: the folder it would work on, and the cap to warn about. */
let nightEditingRoot: string | null = null;

/** The menu bar's "Folder triggers": each with why it is paused, Pause/Resume and Stop watching. */
function triggerMenu(): Electron.MenuItemConstructorOptions[] {
  const list = loadTriggers();
  if (!list.length) return [];
  return [
    { label: 'Folder triggers', submenu: list.map((t): Electron.MenuItemConstructorOptions => ({
      label: `${t.enabled ? '' : 'Paused · '}${t.title.slice(0, 48)} — ${describeTrigger(t)}`,
      submenu: [
        { label: t.enabled ? 'Watching while Bimax is open' : (t.pausedReason ?? 'Paused').slice(0, 90), enabled: false },
        { label: t.enabled ? 'Pause' : 'Resume', click: () => setTriggerEnabled(t.id, !t.enabled) },
        { type: 'separator' },
        { label: 'Stop watching', click: () => removeTrigger(t.id) },
      ],
    })) },
    { type: 'separator' },
  ];
}
/**
 * ⋯ in the ⌘2 bar: repeat this task on a schedule (schedules.ts), run it when files arrive (folder.triggers.ts), or edit
 * this folder's rules (folder.rules.ts).
 */
/**
 * Export a conversation (backlog N4). The PDF is printed from a hidden window with JavaScript off, no pop-ups and no
 * navigation, loading a page whose policy allows no script and no network load (thread.export.ts), so nothing in a
 * conversation can act while it is drawn.
 */
async function conversationPdf(markdown: string, title: string): Promise<Buffer> {
  const dir = await fsp.mkdtemp(path.join(app.getPath('temp'), 'bimax-export-'));
  const page = path.join(dir, 'conversation.html');
  const printer = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    printer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await fsp.writeFile(page, conversationHtml(markdown, title), 'utf8');
    await printer.loadFile(page);
    printer.webContents.on('will-navigate', (event) => event.preventDefault());
    return await printer.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
  } finally {
    printer.destroy();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** What an export reads: a live thread, or a session saved by the engine and listed in the Sessions gallery. */
type Conversation = { summary: { title: string; root: string; model?: string }; items: readonly TranscriptItem[]; threadId?: string };

function threadConversation(id: string): Conversation {
  const { summary, state } = threads.get(id);
  return { summary, items: state.items, threadId: id };
}

async function sessionConversation(id: string): Promise<Conversation> {
  const root = projectDir();
  const file = sessionFile(root, id);
  if (!file) throw new Error('That is not a saved session.');
  const meta = (await readSessionMeta(root)).find((m) => m.id === id);
  const title = meta?.title && meta.title !== '(no messages yet)' ? meta.title : `Session ${id}`;
  return { summary: { title, root: meta?.cwd || root }, items: sessionItems(await fsp.readFile(file, 'utf8')) };
}

async function exportConversation(load: () => Conversation | Promise<Conversation>, format: 'md' | 'pdf'): Promise<void> {
  try {
    const { summary, items, threadId } = await load();
    const markdown = conversationMarkdown(summary, items);
    const parent = quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible() ? quickWindow : win;
    const options: Electron.SaveDialogOptions = {
      title: 'Export conversation',
      defaultPath: path.join(app.getPath('documents'), exportFileName(summary.title, format)),
      filters: format === 'md' ? [{ name: 'Markdown', extensions: ['md'] }] : [{ name: 'PDF', extensions: ['pdf'] }],
    };
    const chosen = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (chosen.canceled || !chosen.filePath) return;
    await fsp.writeFile(chosen.filePath, format === 'md' ? markdown : await conversationPdf(markdown, summary.title));
    if (threadId) threads.addNote(threadId, `Exported this conversation to ${path.basename(chosen.filePath)}.`);
    shell.showItemInFolder(chosen.filePath);
  } catch (error) {
    void dialog.showMessageBox({ type: 'warning', message: 'Bimax could not export this conversation', detail: (error as Error).message });
  }
}

/** The share sheet (AirDrop, Mail, Messages…) with the conversation as a Markdown file. */
async function shareConversation(load: () => Conversation | Promise<Conversation>): Promise<void> {
  try {
    const { summary, items } = await load();
    const dir = path.join(app.getPath('temp'), 'bimax-share');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, exportFileName(summary.title, 'md'));
    await fsp.writeFile(file, conversationMarkdown(summary, items), 'utf8');
    const parent = quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible() ? quickWindow : win;
    new ShareMenu({ filePaths: [file] }).popup(parent ? { window: parent } : {});
  } catch (error) {
    void dialog.showMessageBox({ type: 'warning', message: 'Bimax could not share this conversation', detail: (error as Error).message });
  }
}

function exportMenuItems(load: () => Conversation | Promise<Conversation>): Electron.MenuItemConstructorOptions[] {
  return [
    { label: 'Export as Markdown…', click: () => void exportConversation(load, 'md') },
    { label: 'Export as PDF…', click: () => void exportConversation(load, 'pdf') },
    { label: 'Share…', click: () => void shareConversation(load) },
  ];
}

function showMoreMenu(): void {
  if (!quickWindow || quickWindow.isDestroyed()) return;
  const snapshot = quickThreadSnapshot();
  const root = snapshot?.root ?? quickContext.root ?? null;
  const prompt = snapshot ? firstPrompt(snapshot.id) : null;
  const template: Electron.MenuItemConstructorOptions[] = [];
  const existing = snapshot && prompt ? loadSchedules().find((s) => s.root === snapshot.root && s.prompt === prompt) : undefined;
  if (snapshot && prompt && existing) {
    template.push(
      { label: `Repeats ${describeSchedule(existing).replace(/^Every/, 'every')}`, enabled: false },
      { label: 'Stop repeating', click: () => { removeSchedule(existing.id); threads.addNote(snapshot.id, 'This task no longer repeats.'); } },
    );
  } else if (snapshot && prompt) {
    template.push({ label: 'Repeat this task', enabled: false });
    const now = new Date();
    for (const cadence of ['daily', 'weekdays', 'weekly'] as Cadence[]) {
      const draft = newSchedule({ id: randomUUID(), title: snapshot.title, root: snapshot.root, prompt, model: threads.get(snapshot.id).summary.model, cadence, now });
      template.push({ label: describeSchedule(draft), click: () => {
        saveSchedules([...loadSchedules(), draft]);
        threads.addNote(snapshot.id, `Repeats ${describeSchedule(draft).replace(/^Every/, 'every')}. Each run starts a new task in ${path.basename(snapshot.root)} and asks before changing anything. Manage it from Bimax in the menu bar.`);
      } });
    }
  } else {
    template.push({ label: 'Repeat this task', enabled: false, sublabel: 'Send a task first' });
  }
  if (snapshot && prompt) {
    const watching = loadTriggers().find((t) => t.root === snapshot.root && t.prompt === prompt);
    template.push({ type: 'separator' });
    if (watching) {
      template.push(
        { label: `Runs ${describeTrigger(watching).replace(/^When/, 'when')}`, enabled: false },
        { label: 'Stop watching', click: () => { removeTrigger(watching.id); threads.addNote(snapshot.id, 'This task no longer runs when files arrive.'); } },
      );
    } else {
      const refusal = triggerFolderProblem(snapshot.root, os.homedir())
        ?? (loadTriggers().length >= MAX_TRIGGERS ? `Bimax already watches ${MAX_TRIGGERS} folders` : null);
      template.push({ label: `Run this task when files arrive in ${path.basename(snapshot.root)}`, enabled: false, ...(refusal ? { sublabel: refusal } : {}) });
      if (!refusal) {
        for (const kind of ARRIVAL_KINDS) {
          const draft = newTrigger({ id: randomUUID(), title: snapshot.title, root: snapshot.root, prompt, model: threads.get(snapshot.id).summary.model, kind, now: Date.now() });
          template.push({ label: arrivalLabel(kind), click: () => {
            saveTriggers([...loadTriggers(), draft]);
            threads.addNote(snapshot.id, `${describeTrigger(draft)}, Bimax runs this task on the new files while it is open. Each run starts a new task, asks before changing anything, and ends with a list of what it changed. Manage it from Bimax in the menu bar.`);
          } });
        }
      }
    }
  }
  template.push({ type: 'separator' });
  template.push(root
    ? { label: `Rules for ${path.basename(root)}…`, click: () => quickWindow?.webContents.send('threads:open-rules') }
    : { label: 'Rules for this folder…', enabled: false, sublabel: 'Choose a folder first' });
  // FL6: keep what worked as a skill.
  if (snapshot && prompt) template.push({ label: 'Save as a Skill…', click: () => openSkillCard(snapshot.id) });
  // FL5: work on something overnight in an isolated checkout.
  if (root) template.push({ label: 'Work on This Tonight…', click: () => { nightEditingRoot = root; quickWindow?.webContents.send('threads:open-night', { root, goal: snapshot && prompt ? prompt : '', cap: dailyCapUsd() }); } });
  // FL1 part 2: this folder's outcome and its queue.
  if (root) {
    const outcome = loadOutcomes()[root];
    template.push({ label: outcome ? `Keep ${path.basename(root)} ready · ${queueLine(outcomeQueue(forgetGone(outcome, (file) => existsSync(file))))}…` : `Keep ${path.basename(root)} ready…`, click: () => void openOutcomeEditor(root) });
  }
  // N4: this conversation as Markdown, a PDF, or through the share sheet.
  if (snapshot) template.push({ type: 'separator' }, ...exportMenuItems(() => threadConversation(snapshot.id)));
  Menu.buildFromTemplate(template).popup({ window: quickWindow });
}
/** The menu bar's Keyboard shortcut menu (quick.shortcut.ts, backlog N14). A refused choice keeps the shortcut the bar had. */
function chooseShortcut(accelerator: string): void {
  const result = switchShortcut(shortcutRegistry, shortcutAvailable ? wantedShortcut : null, accelerator, () => { void showQuickBar(); });
  if (result.ok) {
    wantedShortcut = accelerator;
    shortcutAvailable = true;
    saveSettings({ quickShortcut: accelerator });
  } else {
    shortcutAvailable = result.active !== null;
    void dialog.showMessageBox({
      type: 'info', message: `${shortcutLabel(accelerator)} is used by another app.`,
      detail: result.active ? `Bimax kept ${shortcutLabel(result.active)}.` : 'Choose another shortcut from Bimax in the menu bar.',
    });
  }
  threadChanged();
  updateTray();
}
let tray: Tray | null = null;
/** The menu bar item: running and waiting tasks at a glance, and a menu of recent ones (thread.tray.ts). */
function updateTray(): void {
  if (process.platform !== 'darwin' || !threads) return;
  const list = threads.list();
  if (!tray) tray = new Tray(nativeImage.createEmpty());
  const talkingInBackground = talkOwner === 'quick' && talk.active && !quickWindow?.isVisible();
  tray.setTitle(pushTalkListening ? '● Listening' : (talkingInBackground ? talkTrayTitle(talk.current) : null) ?? trayTitle(list));
  tray.setToolTip(trayTooltip(list, shortcutLabel(wantedShortcut)));
  const entries = trayEntries(list);
  // FL11: a conversation going on with the ⌘2 bar hidden can be seen and stopped from here.
  const talkControls: Electron.MenuItemConstructorOptions[] = talkOwner === 'quick' && talk.active ? [
    { label: `Talking · ${talkTrayTitle(talk.current)?.replace('🎙 ', '') ?? ''}`, enabled: false },
    ...(['speaking', 'thinking', 'waiting'].includes(talk.current.state) ? [{ label: 'Interrupt and Listen', click: () => talk.interrupt() }] : []),
    { label: 'Show the Conversation', click: () => { if (talk.threadId) showQuickThread(talk.threadId); } },
    { label: 'Stop Talking', click: () => talk.end() },
    { type: 'separator' },
  ] : [];
  const template: Electron.MenuItemConstructorOptions[] = [
    ...talkControls,
    { label: 'Bimax tasks', enabled: false },
    ...(entries.length ? entries.map((entry) => ({ label: entry.label, click: () => openThread(entry.id) })) : [{ label: 'No tasks yet', enabled: false }]),
    { type: 'separator' },
    // FL7: tasks the person bookmarked, to come back to.
    ...(list.some((t) => t.bookmark) ? [{ label: 'Bookmarks', submenu: list.filter((t) => t.bookmark).slice(0, 12).map((t): Electron.MenuItemConstructorOptions => ({
      label: `${t.title.slice(0, 40)} — ${t.bookmark!.note.slice(0, 50)}`, click: () => openThread(t.id),
    })) }, { type: 'separator' as const }] : []),
    ...scheduleMenu(),
    ...outcomeMenu(),
    ...triggerMenu(),
    { label: 'New ⌘2 Task', click: () => { quickThreadId = null; if (quickWindow?.isVisible()) sendQuickThread(); else void showQuickBar(); } },
    { label: `Keyboard shortcut: ${shortcutLabel(wantedShortcut)}`, submenu: [
      ...(shortcutAvailable ? [] : [{ label: `${shortcutLabel(wantedShortcut)} is used by another app. Choose another:`, enabled: false }]),
      ...SHORTCUT_CHOICES.map((choice): Electron.MenuItemConstructorOptions => ({
        label: choice.label, type: 'radio', checked: choice.accelerator === wantedShortcut, enabled: choice.accelerator !== pushTalkShortcut?.accelerator, click: () => chooseShortcut(choice.accelerator),
      })),
    ] },
    { label: `Talk anywhere: ${pushTalkShortcut?.label ?? 'Off'}`, submenu: [
      { label: 'Hold the shortcut in any app, speak, let go', enabled: false },
      { label: 'Off', type: 'radio', checked: !pushTalkShortcut, click: () => choosePushTalk(null) },
      ...PUSH_TALK_CHOICES.map((choice): Electron.MenuItemConstructorOptions => ({
        label: choice.label, type: 'radio', checked: choice.accelerator === pushTalkShortcut?.accelerator, enabled: choice.accelerator !== wantedShortcut, click: () => choosePushTalk(choice),
      })),
      { type: 'separator' },
      { label: 'Answer out loud', type: 'radio', checked: pushTalkAnswer(loadSettings().pushTalkAnswer) === 'voice', click: () => { saveSettings({ pushTalkAnswer: 'voice' }); updateTray(); } },
      { label: 'Answer as a notification', type: 'radio', checked: pushTalkAnswer(loadSettings().pushTalkAnswer) === 'notification', click: () => { saveSettings({ pushTalkAnswer: 'notification' }); updateTray(); } },
    ] },
    { label: 'Speak When a Task Finishes', type: 'checkbox', checked: loadSettings().speakUpdates === true, click: (item) => { saveSettings({ speakUpdates: item.checked }); updateTray(); } },
    ...(existsSync(notchHelperPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })) ? [{
      label: 'Show Bimax in the Notch', type: 'checkbox' as const, checked: loadSettings().notchDeck !== false,
      click: (item: Electron.MenuItem) => { saveSettings({ notchDeck: item.checked }); syncNotch(); updateTray(); },
    }, {
      label: 'Keep Clipboard History in the Notch', type: 'checkbox' as const, checked: loadSettings().clipboardHistory === true,
      enabled: loadSettings().notchDeck !== false,
      click: (item: Electron.MenuItem) => { saveSettings({ clipboardHistory: item.checked }); notchDeck?.sendClips(true); updateTray(); },
    }] : []),
    existsSync(quickActionPath(os.homedir()))
      ? { label: `Remove “${QUICK_ACTION_NAME}” from Finder`, click: () => void removeQuickAction() }
      : { label: `Add “${QUICK_ACTION_NAME}” to Finder…`, click: () => void addQuickAction() },
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
// WP-2 (record 57): the rendering half of the same policy, which until now was hardcoded to shadow
// mode at its only call site — computed every 30 s and thrown away. `off` is the explicit override,
// mirroring BIMAX_ADAPTIVE_CONCURRENCY. Reduce Motion is unaffected either way: renderingPolicy
// treats it as a hard accessibility constraint, not a canary decision.
const adaptiveRenderingEnabled = process.env.BIMAX_ADAPTIVE_RENDERING !== 'off';
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
if (!ownsSingleInstance) {
  // Quitting silently made a refusal indistinguishable from a broken build: the terminal printed
  // "starting electron app..." and then exited 0, with nothing anywhere saying a second instance
  // had been declined. Name the directory that is contended, because that is the actionable part
  // — the holder is frequently the INSTALLED Bimax rather than another dev run, and before the
  // block at the top of this file the two resolved to the very same userData.
  console.error(`[bimax] another Bimax already owns ${app.getPath('userData')} — bringing that one forward instead of starting a second.`);
  app.quit();
}

function revealMainWindow(): void {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  if (app.isReady()) createWindow();
}

app.on('second-instance', revealMainWindow);

// ── bimax://task links (backlog N2) ──────────────────────────────────────────────────────────────
// macOS delivers a link that launched Bimax before the app is ready, so links wait until threads exist.
const pendingTaskLinks: string[] = [];
let taskLinksReady = false;
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (taskLinksReady) void openTaskLink(url);
  else pendingTaskLinks.push(url);
});

// ── Files handed to Bimax (backlog N3) ───────────────────────────────────────────────────────────
// Finder's "Ask Bimax" Quick Action runs `open -b ai.bimax.app <files>`; a drop on the Dock icon and Open With arrive
// the same way. macOS sends one event per file, so they are gathered briefly and open ONE ⌘2 bar with all of them.
const openedFiles: string[] = [];
let openedFilesTimer: NodeJS.Timeout | null = null;
app.on('open-file', (event, file) => {
  event.preventDefault();
  openedFiles.push(file);
  if (taskLinksReady) gatherOpenedFiles();
});
function gatherOpenedFiles(): void {
  if (openedFilesTimer) clearTimeout(openedFilesTimer);
  openedFilesTimer = setTimeout(() => { openedFilesTimer = null; void openFilesInBar(openedFiles.splice(0)); }, 250);
}
/** A new ⌘2 task on the files' folder with the files attached; nothing runs until the person sends (finder.action.ts). */
async function openFilesInBar(files: string[]): Promise<void> {
  if (!files.length) return;
  const context = await openedFilesContext(files, os.homedir());
  if (talkOwner === 'quick') talk.end();
  quickThreadId = null;
  app.focus({ steal: true });
  await showQuickBar(context);
}
const BIMAX_BUNDLE_ID = 'ai.bimax.app';
/** Finder reads ~/Library/Services when asked; without this a new Quick Action can take minutes to appear. */
function refreshServices(): void {
  execFile('/System/Library/CoreServices/pbs', ['-update'], { timeout: 15_000 }, () => undefined);
}
async function addQuickAction(): Promise<void> {
  try {
    const { added } = await installQuickAction(os.homedir(), BIMAX_BUNDLE_ID);
    refreshServices();
    void dialog.showMessageBox({
      type: 'info',
      message: added ? `“${QUICK_ACTION_NAME}” is in Finder` : `“${QUICK_ACTION_NAME}” was already in Finder`,
      detail: 'Select files or a folder in Finder, then Control-click and choose Quick Actions → Ask Bimax (or Services → Ask Bimax). The ⌘2 bar opens with them attached; nothing runs until you send.',
    });
  } catch (error) {
    void dialog.showMessageBox({ type: 'warning', message: `Bimax could not add “${QUICK_ACTION_NAME}” to Finder`, detail: (error as Error).message });
  }
  updateTray();
}
async function removeQuickAction(): Promise<void> {
  try {
    await macBin.moveToBin(quickActionPath(os.homedir()));
    refreshServices();
  } catch (error) {
    void dialog.showMessageBox({ type: 'warning', message: `Bimax could not remove “${QUICK_ACTION_NAME}”`, detail: (error as Error).message });
  }
  updateTray();
}

// ── Talk anywhere (backlog N8, push.talk.ts) ─────────────────────────────────────────────────────
// Hold the chosen shortcut in any app, speak, let go: a ⌘2 task in Finder's folder, answered out loud or by notification.
const PUSH_TALK_OWNER = -2; // the dictation owner that is the main process itself, not a window
let pushTalkShortcut: PushTalkChoice | null = null;
let pushTalkListening = false;
let pushTalkContext: QuickContext | null = null;
/** ⌘2 tasks started by talking anywhere, and how each one's answer comes back when its turn ends. */
const pushTalkThreads = new Map<string, PushTalkAnswer>();
function tellPushTalk(message: string): void {
  if (Notification.isSupported()) new Notification({ title: 'Bimax', body: message }).show();
}
const pushTalk = new PushToTalk({
  listen: (holdKey) => voice.start(PUSH_TALK_OWNER, { locales: app.getPreferredSystemLanguages(), context: ['Bimax'], hold: holdKey }),
  stop: () => voice.stop(PUSH_TALK_OWNER),
  // Read at the press, while the app the person was in is still in front — the same context ⌘2 reads.
  folder: async () => {
    pushTalkContext = await finderContext();
    const root = pushTalkContext.root;
    return root && root !== '/' && root !== os.homedir() ? root : null;
  },
  submit: (root, words) => {
    const answer = pushTalkAnswer(loadSettings().pushTalkAnswer);
    try {
      const id = threads.create(root, '', 'quick', quickModel());
      pushTalkThreads.set(id, answer);
      const request = withContext(words, pushTalkContext?.attachments ?? []);
      threads.submit(id, answer === 'voice' ? `${request}\n\n${TALK_TURN_HINT}` : request, words);
    } catch (error) {
      tellPushTalk((error as Error).message);
    }
  },
  openBar: (words) => { quickThreadId = null; void showQuickBar({ root: null, source: 'Choose a folder', error: 'Choose the folder for what you said.', prompt: words }); },
  indicate: (listening) => { pushTalkListening = listening; updateTray(); },
  tell: tellPushTalk,
});
async function pressPushTalk(): Promise<void> {
  if (!pushTalkShortcut) return;
  if (!pushTalk.listening) {
    if (!voiceSupported(process.platform, os.release(), existsSync(voiceHelper()))) { tellPushTalk('Talking to Bimax needs macOS 26 or later.'); return; }
    const status = systemPreferences.getMediaAccessStatus('microphone');
    const allowed = status === 'granted' || (status === 'not-determined' && await systemPreferences.askForMediaAccess('microphone'));
    if (!allowed) { tellPushTalk('Bimax can’t use the microphone. Turn it on in System Settings → Privacy & Security → Microphone.'); return; }
    if (talk.active) talk.end();
  }
  await pushTalk.press(pushTalkShortcut);
}
/** Change talk anywhere's shortcut (null: off). A shortcut another app holds is refused and the old one kept. */
function choosePushTalk(choice: PushTalkChoice | null): void {
  const previous = pushTalkShortcut;
  if (previous) globalShortcut.unregister(previous.accelerator);
  pushTalkShortcut = null;
  if (choice) {
    if (choice.accelerator !== wantedShortcut && globalShortcut.register(choice.accelerator, () => { void pressPushTalk(); })) pushTalkShortcut = choice;
    else {
      if (previous && globalShortcut.register(previous.accelerator, () => { void pressPushTalk(); })) pushTalkShortcut = previous;
      void dialog.showMessageBox({ type: 'info', message: `${choice.label} is in use`, detail: 'Another app, or the ⌘2 bar, already uses that shortcut. Choose another.' });
    }
  }
  saveSettings({ pushTalkShortcut: pushTalkShortcut?.accelerator });
  updateTray();
}
/** Read a finished spoken request's answer out loud, or show it — once; later turns in the task notify as usual. */
function deliverPushTalkAnswer(id: string, answer: PushTalkAnswer): void {
  if (answer === 'notification') { notifyFinished(id, true); return; }
  const last = [...threads.get(id).state.items].reverse().find((item) => item.kind === 'msg' && item.msg.role === 'assistant');
  speakAloud(last && last.kind === 'msg' ? spokenSummary(last.msg.content) || 'Done.' : 'Done.');
}
/** One spoken line through the voice helper, in the voice and speed chosen in Settings → Voice (N7); a newer one replaces it. */
let speaking: ReturnType<typeof spawn> | null = null;
function speakAloud(text: string, voiceChoice: { talkVoice?: unknown; talkRate?: unknown } = loadSettings()): void {
  if (!existsSync(voiceHelper())) return;
  speaking?.kill();
  const child = spawn(voiceHelper(), ['--say', text.slice(0, 1000), ...localeArguments(app.getPreferredSystemLanguages()), ...speakingArguments(voiceChoice)], { stdio: ['ignore', 'ignore', 'ignore'] });
  speaking = child;
  child.on('error', () => undefined);
  child.on('exit', () => { if (speaking === child) speaking = null; });
}

/** Read a task link, check its folder, and start the task only if the person clicks Start (see bimax.link.ts). */
async function openTaskLink(raw: string): Promise<void> {
  const refuse = (detail: string) => { void dialog.showMessageBox({ type: 'warning', message: 'Bimax could not open that link', detail }); };
  const link = parseTaskLink(raw, os.homedir());
  if (!link.ok) { refuse(link.error); return; }
  let root: string;
  try {
    root = await fsp.realpath(link.folder);
    if (!(await fsp.stat(root)).isDirectory()) throw new Error('not a folder');
  } catch {
    refuse(`That folder does not exist: ${link.folder}`);
    return;
  }
  if (root === '/' || root === os.homedir()) { refuse('Choose a specific folder rather than your whole home folder.'); return; }
  const { options, startIndex } = linkConfirmation(root, link.prompt);
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox(options);
  if (response !== startIndex) return;
  try {
    const id = threads.create(root, '', 'quick', quickModel());
    if (link.prompt) threads.submit(id, link.prompt);
    else threads.start(id);
    showQuickThread(id);
  } catch (error) {
    refuse((error as Error).message);
  }
}

/**
 * Available system memory, counting the page cache macOS will hand back — see availableBytes() in
 * supervisor/resources.ts for the measurement that made this necessary. Falls back to os.freemem()
 * where `process.getSystemMemoryInfo` is absent (it exists in Electron, not in a bare jest run), so
 * the fallback is under-reporting rather than nothing.
 */
function availableMemoryBytes(): number {
  try {
    const sample = (process as unknown as { getSystemMemoryInfo?: () => SystemMemorySample }).getSystemMemoryInfo;
    if (typeof sample === 'function') return availableBytes(sample.call(process));
  } catch { /* fall through to the conservative reading */ }
  return os.freemem();
}

function currentRuntimeSignals(): RuntimeSignals {
  const totalMb = os.totalmem() / (1024 * 1024);
  const availableMemoryMb = Math.max(0, Math.round(availableMemoryBytes() / (1024 * 1024)));
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
  return { signals, decision, rendering: renderingPolicy(signals, adaptiveRenderingEnabled) };
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
    auxiliaryWebContentsIds: [quickWindow, approvalWindow, organizeWindow].filter(w => w && !w.isDestroyed()).map(w => w!.webContents.id),
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
      'threads:undo-info', 'threads:undo', 'threads:history', 'threads:bookmark-set', 'threads:where', 'threads:undo-change', 'threads:undo-back-to', 'threads:open-path', 'threads:quick-switch', 'threads:model-menu',
      'threads:more-menu', 'threads:rules-get', 'threads:rules-set', 'threads:rules-pick', 'threads:screenshot', 'threads:paste-picture', 'threads:teach', 'threads:outcome-get', 'threads:outcome-set', 'threads:outcome-clear', 'threads:night-start', 'threads:skill-save',
      'voice:available', 'voice:start', 'voice:stop', 'voice:cancel', 'talk:start', 'talk:end', 'talk:interrupt', 'talk:current']
    : event.sender.id === organizeWindow?.webContents.id
      ? ['organize:current', 'organize:move', 'organize:move-group', 'organize:keep', 'organize:include', 'organize:apply', 'organize:cancel']
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
      return spawnEngine(project, {
        ...extraEnv,
        ...adaptivePolicy.engineEnvironment(adaptive.decision),
        // One sub-agent worker budget for the whole machine, not one per Bimax Thread. Without
        // this every engine gets its own per-folder lease ledger, so the per-machine ceiling the
        // policy just computed is multiplied by the number of live Threads (WP-1, record 57).
        ...workerCapacityEnvironment(app.getPath('userData')),
        // The same fix for money (backlog F5): one spend ledger for the Mac, and a per-Thread share
        // so one unattended task cannot spend the whole day before the others start.
        // A night shift's own budget replaces the per-task share (FL5); it also runs unattended.
        ...spendLedgerEnvironment(app.getPath('userData'), threadId, (threadId && nightShifts.get(threadId)?.budgetUsd) || loadSettings().perTaskSpendUsd),
        ...(threadId && nightShifts.has(threadId) ? { BIMAX_UNATTENDED: '1' } : {}),
        // Keychain-backed secrets enter only at the child boundary. They never pass through the
        // renderer or the engine protocol and are not written to diagnostics.
        ...providerCredentialEnvironment(),
        // BIMAX_WAKES: this app keeps and delivers the task's wakes (F4), so the engine's WakeTool may promise one.
        ...(threadId ? { ...threadBroker.environment(threadId), BIMAX_THREAD_ROOT: project, WORKSPACE_ROOT: project, BIMAX_WAKES: '1',
          // Which optional subsystems this thread may run, by origin — see threadCapabilityEnvironment.
          // These four used to be pinned off here for every thread, which silenced codebase memory and
          // the drives boot across the whole product once every conversation became a thread.
          ...threadCapabilityEnvironment(threads.get(threadId).summary.origin),
          ...threadIndexEnvironment(threads.get(threadId).summary.origin),
          ...threadStateEnvironment(app.getPath('userData'), project, threads.get(threadId).summary.origin),
          ...rulesEnvironment(loadSettings().folderRules?.[project]),
          ...outcomeEnvironment(loadOutcomes()[project]),
          ...threadVoiceEnvironment(threads.talkState(threadId).voice),
          ...(threads.talkState(threadId).model ? { BIMAX_THREAD_MODEL: threads.talkState(threadId).model } : {}) } : {}),
      }, callbacks);
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
    random: () => Math.random(),
    memory: () => ({ freeBytes: availableMemoryBytes(), totalBytes: os.totalmem() }),
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
  // Talking in the main window follows the conversation on screen: moving to another one ends it.
  if (talkOwner === 'main' && talk.threadId && talk.threadId !== id) { talkLog('ending: the main window moved to another conversation'); talk.end(); }
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
/**
 * One thread per project. Reopening a project (Recents, the Open dialog, a launch) returns to its thread, whose engine
 * resumes the conversation, instead of adding another thread and another engine every time. `restart` starts a new
 * engine generation on the same thread, for new credentials.
 */
function startEngine(projectDir: string, options: { restart?: boolean } = {}): void {
  const root = realpathSync(projectDir);
  const existing = threads.projectThread(root);
  const id = existing ?? threads.create(root, '', 'project');
  // A restart for new credentials is not the user's Stop: queued messages are kept and sent afterwards.
  if (existing && options.restart) threads.stop(id, { keepInputs: true });
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

  win.on('closed', () => { if (talkOwner === 'main' && talk.active) { talkLog('ending: the main window closed'); talk.end(); } win = null; });
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
  let storageNoticeShown = false;
  threadStorage = new ThreadStorage(path.join(app.getPath('userData'), 'threads'), {
    // A thread that cannot be saved is said out loud once, not left to be discovered after a restart (backlog F12).
    onFailure: (message) => {
      if (message === null) { storageNoticeShown = false; console.info('[threads] saving works again'); return; }
      console.warn(`[threads] could not save thread history: ${message}`);
      if (!storageNoticeShown && Notification.isSupported()) {
        storageNoticeShown = true;
        new Notification({ title: 'Bimax could not save your tasks', body: `${message.slice(0, 140)} It keeps trying.` }).show();
      }
    },
  });
  threads = new ThreadManager({
    engine: id => createSupervisor(id), changed: threadChanged,
    wakesChanged: () => wakes?.sync(threads.wakeEntries()),
    // F6: what a turn cut off by a crash or quit had already done, from the thread's undo journal, checked on disk.
    madeSince: (summary, since) => changesSince(threadStateRoot(app.getPath('userData'), summary.root, summary.origin), since),
    // The live-engine budget reads the same corrected availability the capability ladder does, so
    // the two memory decisions in this app cannot disagree about how much room the machine has.
    memory: () => ({ freeBytes: availableMemoryBytes() }),
    // The ⌘2 bar's thread is not `activeId`, so the idle reaper has to be told about it.
    onScreen: () => [quickThreadId],
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
      if (id === talk.threadId) {
        try { talk.onThreadMessage(msg); } catch { /* talk mode must never stop the thread's own delivery */ }
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
        const choices = notificationChoices(value.request);
        const note = new Notification({
          title: `${value.title} needs your decision`, body: value.request.question.slice(0, 160),
          // Allow and Deny on the notification itself (backlog N1). macOS shows them on an alert-style notification, or
          // under Options on a banner; clicking the notification still opens the full card.
          ...(choices ? { actions: [{ type: 'button' as const, text: choices.allow }, { type: 'button' as const, text: choices.deny }], closeButtonText: 'Later' } : {}),
        });
        note.on('click', () => { showThreadApproval(); approvalWindow?.focus(); });
        if (choices) {
          note.on('action', (_event, index) => {
            const answer = answerFromNotification(value, index, choices);
            if (!answer) return;
            // Already answered on the card, or the task moved on: show what is waiting now instead.
            try { threads.send(value.threadId, answer); } catch { showThreadApproval(); }
          });
        }
        note.show();
      }
    },
    // A full list archives its least recently used thread instead of refusing a new task (backlog N11).
    archive: (value) => {
      threadStorage.archive(value).then(threadChanged, (error) => console.warn(`[threads] could not archive ${value.summary.id}: ${(error as Error).message}`));
    },
    save: value => threadStorage.save(value),
    // An accepted or dispatched message is written before the manager returns (backlog F1).
    saveNow: value => threadStorage.saveNow(value),
    // A talk change restarted this thread's engine: re-attach the main window when it is the one on screen.
    restarted: (id) => { if (id === threads.activeId) selectThread(id); },
    organizePlan: (id, plan) => receiveOrganizePlan(id, plan),
    // FL1 part 2: a run's FolderStatusTool report becomes its folder's queue.
    folderStatus: (id, items) => {
      const root = threads.get(id).summary.root;
      const all = loadOutcomes();
      if (!all[root]) return;
      all[root] = applyReport(all[root], items as Array<{ path?: unknown; state?: unknown; reason?: unknown }>, id, Date.now());
      saveOutcomes(all);
    },
    finished: (id, tookMs) => {
      recordModelTime(id, tookMs);
      const spoken = pushTalkThreads.get(id);
      // A night shift (FL5) is continued or briefed, not announced after every milestone.
      if (nightShifts.has(id)) afterNightTurn(id);
      else if (spoken) { pushTalkThreads.delete(id); deliverPushTalkAnswer(id, spoken); } else { notifyFinished(id); speakFinished(id); }
      // FL6: a ⌘2 task whose check passed can become a skill; said once per task.
      const done = threads.get(id).summary;
      if (done.origin !== 'project' && done.check === 'passed' && !nightShifts.has(id) && !skillHinted.has(id)) {
        skillHinted.add(id);
        threads.addNote(id, 'Its check passed. To have Bimax do this kind of job the same way again, ⋯ → Save as a Skill.');
      }
      // Its folder's rules changed mid-turn: restart on them now that the turn is over (unless a message is queued).
      if (rulesStale.delete(id) && !threads.restartIfIdle(id)) rulesStale.add(id);
      // A folder trigger's run may be over, or a trigger may have been waiting for this folder.
      folderTriggers?.finished(id);
    },
  }, threadStorage.load());
  // Hand back the memory of engines nobody is using. An engine costs 227 MB whether it is mid-turn
  // or finished, and before this nothing reclaimed one until a NEW task hit the live-engine limit.
  threads.startIdleReaper();
  // Wakes (F4): armed from what the threads saved, so a wake set before Bimax quit still happens.
  wakes = new Wakes({
    now: () => Date.now(),
    // setTimeout overflows past 24.8 days; the engine refuses a wake more than 7 days ahead, so the cap never shortens one.
    timer: (fn, ms) => { const handle = setTimeout(fn, Math.min(ms, 2 ** 31 - 1)); return () => clearTimeout(handle); },
    watch: (root, changed) => {
      try {
        const watcher = watchFolder(root, { persistent: false, recursive: true }, (_event, file) => changed(String(file ?? '')));
        watcher.on('error', () => { /* the folder went away; the wake waits until it is cancelled */ });
        return () => watcher.close();
      } catch {
        return () => {};
      }
    },
    ci: ciRunsFor,
    fire: (threadId, wake, text) => {
      try { threads.wakeUp(threadId, wake.id, text, text); } catch (error) { console.warn(`[wakes] could not wake ${threadId}: ${(error as Error).message}`); }
    },
  });
  wakes.sync(threads.wakeEntries());
  // Repeating ⌘2 tasks (schedules.ts): checked every minute, shortly after launch, and when the Mac wakes.
  setInterval(() => void runSchedules(), 60_000);
  setTimeout(() => void runSchedules(), 15_000);
  powerMonitor.on('resume', () => { setTimeout(() => void runSchedules(), 5_000); });
  // Folder triggers (folder.triggers.ts, backlog FL1): watched while Bimax is open; each run is a new ⌘2 task.
  folderTriggers = new FolderTriggers({
    list: async (root) => {
      const names = await fsp.readdir(root, { withFileTypes: true });
      const entries = await Promise.all(names.filter((entry) => entry.isFile()).map(async (entry) => {
        const stat = await fsp.lstat(path.join(root, entry.name)).catch(() => null);
        return stat?.isFile() ? { name: entry.name, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs } : null;
      }));
      return entries.filter((entry): entry is FolderEntry => !!entry);
    },
    watch: (root, changed) => {
      try {
        const watcher = watchFolder(root, { persistent: false }, () => changed());
        watcher.on('error', () => { /* the listing every minute still notices arrivals */ });
        return () => watcher.close();
      } catch {
        return () => {};
      }
    },
    timer: (fn, ms) => { const handle = setTimeout(fn, ms); return () => clearTimeout(handle); },
    now: () => Date.now(),
    start: startTriggered,
    active: (id) => {
      try {
        const thread = threads.get(id);
        return !!thread.inputs?.length || ['starting', 'working', 'needs-you'].includes(thread.summary.status);
      } catch {
        return false;
      }
    },
    changes: (trigger, from, to) => {
      let journal = '';
      try { journal = readFileSync(journalFile(threadStateRoot(app.getPath('userData'), trigger.root, 'quick')), 'utf8'); } catch { /* nothing recorded yet */ }
      return changesDuring(journal, from, to);
    },
    report: (id, titles) => { try { threads.addNote(id, changeListNote(titles)); } catch { /* the task is gone */ } },
    paused: (trigger, reason, files) => {
      saveTriggers(loadTriggers().map((t) => (t.id === trigger.id ? { ...t, enabled: false, pausedReason: reason } : t)));
      if (!Notification.isSupported()) return;
      const names = files.map((file) => path.basename(file));
      const left = names.length ? ` Not handled: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}.` : '';
      new Notification({ title: `Paused: ${trigger.title}`, subtitle: describeTrigger(trigger), body: `${reason}${left} Resume it from Bimax in the menu bar.` }).show();
    },
  });
  void folderTriggers.sync(loadTriggers());
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
  // Task links can be handled now that threads exist; one that launched Bimax has been waiting (backlog N2).
  taskLinksReady = true;
  for (const url of pendingTaskLinks.splice(0)) void openTaskLink(url);
  if (openedFiles.length) gatherOpenedFiles();
  if (app.isPackaged) app.setAsDefaultProtocolClient('bimax');
  createWindow();
  updateTray();
  syncNotch();
  wantedShortcut = chosenShortcut(loadSettings().quickShortcut);
  shortcutAvailable = switchShortcut(shortcutRegistry, null, wantedShortcut, () => { void showQuickBar(); }).ok;
  // Talk anywhere (N8), when the person turned it on; a shortcut another app now holds leaves it off, with the menu saying so.
  const savedPushTalk = pushTalkChoice(loadSettings().pushTalkShortcut);
  if (savedPushTalk && savedPushTalk.accelerator !== wantedShortcut && globalShortcut.register(savedPushTalk.accelerator, () => { void pressPushTalk(); })) pushTalkShortcut = savedPushTalk;
  updateTray();
  if (!shortcutAvailable) console.warn(`[threads] ${wantedShortcut} is already registered by another application.`);
  // Launch project: an env override or the last valid saved project — NEVER $HOME. When null, the
  // renderer shows the project-first welcome and we don't boot an engine in the wrong place (P0.1).
  const initialDir = pickInitialProject(loadSettings().lastProject);

  // Protocol messages from the renderer flow through the supervisor: delivered when the engine is
  // interactive, queued when safe to replay, rejected with a visible notice otherwise. The frame
  // shape is checked here so malformed junk never reaches the engine's parser.
  // ---- Embedded research browser -------------------------------------------------------------
  // Every channel goes through secureHandle/secureOn, so an untrusted frame gets the fallback
  // rather than a live browser. Payloads are validated here because the manager trusts its caller.
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
  // The welcome screen's "Start a task in a folder" (backlog N14): choose a folder, and the ⌘2 bar opens on it.
  secureHandle('threads:start-in-folder', false, async (event) => {
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'], title: 'Choose a folder for the task', buttonLabel: 'Start here' };
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return false;
    const root = await fsp.realpath(result.filePaths[0]);
    if (talkOwner === 'quick') talk.end();
    quickThreadId = null;
    await showQuickBar({ root, source: 'Selected folder' });
    return true;
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
        const outside = attachments.find((item) => item.path && needsFolder(item) && !insideFolder(root, item.path));
        if (outside) return { ok: false, error: `“${outside.label}” is outside this task’s folder. Start a New task to use it.` };
        // While the task works, the words reach the running turn at its next step (F7); otherwise they are a new turn.
        // FL3: "Actually, by project" after a plan was applied here: tell the task to revise from the current state.
        const applied = isRevision(prompt) ? loadOrganizeHistory()[root] : undefined;
        const revision = applied && Date.now() - applied.at < 24 * 60 * 60 * 1000 ? `\n\n${revisionHint(applied)}` : '';
        threads.steer(quickThreadId, `${withContext(prompt, attachments)}${revision}`, prompt, false);
        offerRule(root, prompt);
        return { ok: true, id: quickThreadId };
      }
      const chosen = typeof opts.root === 'string' && opts.root ? opts.root : quickContext.root;
      if (!chosen) return { ok: false, error: 'Choose a folder for this task.' };
      const root = await fsp.realpath(chosen);
      if (!(await fsp.stat(root)).isDirectory()) throw new Error('Workspace folder is unavailable');
      if (root === '/' || root === os.homedir()) return { ok: false, error: 'Choose a specific folder rather than your whole home folder.' };
      const outside = attachments.find((item) => item.path && needsFolder(item) && !insideFolder(root, item.path));
      if (outside) return { ok: false, error: `“${outside.label}” is outside ${path.basename(root)}. Choose its folder instead.` };
      const id = threads.create(root, '', 'quick', quickModel());
      quickThreadId = id;
      noteNotchTask(id, attachments);
      threads.submit(id, withContext(prompt, attachments), prompt, false);
      sendQuickThread();
      offerRule(root, prompt);
      return { ok: true, id };
    } catch (error) { return { ok: false, error: (error as Error).message }; }
  });
  // N5: a picture for the task to look at — a screenshot the person drags out, or an image they paste. It is kept in
  // Bimax's temporary folder, never the task's, and the engine sends it to the model as an image.
  secureHandle('threads:screenshot', null as QuickAttachment | null, async () => {
    const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'bimax-picture-')), screenshotName(new Date()));
    quickPicking = true;
    quickWindow?.hide();
    try {
      // -i: the person drags across what to show (Space picks a window, Esc cancels); -x: no camera sound.
      await new Promise<void>((resolve) => { execFile('/usr/sbin/screencapture', ['-i', '-x', file], { timeout: 180_000 }, () => resolve()); });
    } finally {
      quickPicking = false;
      if (quickWindow && !quickWindow.isDestroyed()) { quickWindow.show(); quickWindow.focus(); }
    }
    if (!existsSync(file)) return null; // cancelled
    return { kind: 'picture' as const, label: path.basename(file), path: await fsp.realpath(file) };
  });
  secureHandle('threads:paste-picture', null as QuickAttachment | null, async (_e, name: unknown, bytes: unknown) => {
    const safeName = asPastedFileName(name);
    if (!PICTURE_EXTENSIONS.includes(path.extname(safeName).toLowerCase())) throw new InvalidPayloadError('a pasted picture must be an image');
    const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'bimax-picture-')), safeName);
    await fsp.writeFile(file, asPastedBytes(bytes), { flag: 'wx' });
    return { kind: 'picture' as const, label: safeName, path: await fsp.realpath(file) };
  });
  // N10: a correction offers to become a folder rule (sent after the words, so it follows them in the bar).
  const offerRule = (root: string, prompt: string): void => {
    const rule = correctionRule(prompt);
    if (!rule || !quickWindow || quickWindow.isDestroyed()) return;
    if (alreadyARule(loadSettings().folderRules?.[root]?.text ?? '', rule)) return;
    const earlier: string[] = [];
    for (const thread of threads.list()) {
      if (thread.root !== root) continue;
      for (const item of [...threads.get(thread.id).state.items].reverse()) {
        if (item.kind === 'msg' && item.msg.role === 'user' && item.msg.content.trim() !== prompt.trim()) earlier.push(item.msg.content);
      }
    }
    teachOffer = { root, rule };
    quickWindow.webContents.send('threads:teach-offer', { root, rule, samples: sampleApplications(rule, earlier) });
  };
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
  secureOn('threads:more-menu', () => showMoreMenu());
  // Settings → Voice (backlog N7): the installed voices, the saved choice, and a spoken preview.
  secureHandle('voice:voices', null as unknown, async () => {
    const stdout = await new Promise<string>((resolve) => {
      execFile(voiceHelper(), ['--voices', ...localeArguments(app.getPreferredSystemLanguages())], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (_error, out) => resolve(String(out ?? '')));
    });
    const { voices, automatic } = parseVoiceList(stdout);
    const settings = loadSettings();
    const chosen = validVoice(settings.talkVoice);
    return { voices: pickerVoices(voices, chosen), automatic, chosen: chosen ?? '', rate: validRate(settings.talkRate), rates: SPEECH_RATES, onlyBasic: onlyBasicVoices(voices), speakUpdates: settings.speakUpdates === true, bargeIn: settings.talkBargeIn === true };
  });
  secureHandle('voice:barge-in', false, (_e, on: unknown) => { saveSettings({ talkBargeIn: on === true }); return on === true; });
  secureHandle('voice:speak-updates', false, (_e, on: unknown) => {
    saveSettings({ speakUpdates: on === true });
    updateTray();
    return on === true;
  });
  secureHandle('voice:choose', false, (_e, voiceId: unknown, rate: unknown) => {
    saveSettings({ talkVoice: validVoice(voiceId), talkRate: validRate(rate) });
    return true;
  });
  secureHandle('voice:preview', false, (_e, voiceId: unknown, rate: unknown) => {
    speakAloud('Hello. This is how Bimax sounds when it talks with you.', { talkVoice: voiceId, talkRate: rate });
    return true;
  });
  // Dictation (voice.ts, native/voice): the on-device helper runs only between voice:start and voice:stop / voice:cancel.
  const voiceAvailable = (): boolean => voiceSupported(process.platform, os.release(), existsSync(voiceHelper()));
  // The microphone, for dictation and talk mode. macOS asks once; its prompt takes focus, and an empty ⌘2 bar would
  // otherwise hide itself underneath it.
  const MICROPHONE_OFF = 'Bimax can’t use the microphone. Turn it on in System Settings → Privacy & Security → Microphone.';
  const microphoneAllowed = async (sender: Electron.WebContents): Promise<boolean> => {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return true;
    let granted = false;
    if (status === 'not-determined') {
      quickPicking = true;
      try { granted = await systemPreferences.askForMediaAccess('microphone'); }
      finally {
        quickPicking = false;
        if (sender.id === quickWindow?.webContents.id && quickWindow.isVisible()) quickWindow.focus();
      }
    }
    if (!granted && (status === 'denied' || status === 'restricted')) void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    return granted;
  };
  secureHandle('voice:available', { available: false }, () => ({ available: voiceAvailable() }));
  secureHandle('voice:start', { ok: false } as { ok: boolean; error?: string; code?: string }, async (event, raw: unknown) => {
    if (!voiceAvailable()) return { ok: false, code: 'unsupported', error: 'Dictation needs macOS 26 or later.' };
    if (!(await microphoneAllowed(event.sender))) return { ok: false, code: 'microphone-denied', error: MICROPHONE_OFF };
    const options = (raw && typeof raw === 'object' ? raw : {}) as { context?: unknown };
    const context = Array.isArray(options.context)
      ? options.context.filter((w): w is string => typeof w === 'string' && w.length > 0 && w.length <= 60).slice(0, 40)
      : [];
    talk.end();
    voice.start(event.sender.id, { locales: app.getPreferredSystemLanguages(), context: ['Bimax', ...context] });
    return { ok: true };
  });
  secureOn('voice:stop', (event) => voice.stop(event.sender.id));
  secureOn('voice:cancel', (event) => voice.cancel(event.sender.id));
  // Talk mode (talk.session.ts), from the ⌘2 bar or the main window's composer. One microphone at a time: starting it
  // ends any dictation, and talking in one window ends talking in the other.
  const talkSurface = (sender: Electron.WebContents): 'quick' | 'main' | null =>
    sender.id === quickWindow?.webContents.id ? 'quick' : sender.id === win?.webContents.id ? 'main' : null;
  // A start still waiting (on the microphone prompt) can be called off by End before any helper runs.
  let talkStarting: 'quick' | 'main' | null = null;
  let talkStartCancelled = false;
  secureHandle('talk:start', { ok: false } as { ok: boolean; error?: string; code?: string }, async (event) => {
    const surface = talkSurface(event.sender);
    if (!surface) return { ok: false, error: 'Talk mode runs in the ⌘2 bar or the main window.' };
    talkLog(`start requested in the ${surface === 'main' ? 'main window' : '⌘2 bar'}`);
    if (!voiceAvailable()) return { ok: false, code: 'unsupported', error: 'Talk mode needs macOS 26 or later.' };
    if (talk.active && talkOwner === surface) return { ok: true };
    let root: string | null = null;
    if (surface === 'main') {
      root = threads.activeId ? threads.get(threads.activeId).summary.root : null;
      if (!root) return { ok: false, error: 'Open a project to talk about it.' };
    } else {
      root = quickThreadSnapshot()?.root ?? null;
      if (!root) {
        if (!quickContext.root) return { ok: false, error: 'Choose a folder for this task first.' };
        try {
          root = await fsp.realpath(quickContext.root);
          if (!(await fsp.stat(root)).isDirectory()) throw new Error('not a folder');
        } catch { return { ok: false, error: 'That folder is no longer available. Choose another.' }; }
        if (root === '/' || root === os.homedir()) return { ok: false, error: 'Choose a specific folder rather than your whole home folder.' };
      }
    }
    talkStarting = surface;
    talkStartCancelled = false;
    try {
      if (!(await microphoneAllowed(event.sender))) { talkLog('refused: microphone access is off'); return { ok: false, code: 'microphone-denied', error: MICROPHONE_OFF }; }
      if (talkStartCancelled) { talkLog('start called off before the helper ran'); return { ok: false }; }
      const visible = surface === 'main' ? win?.isVisible() : quickWindow?.isVisible();
      if (!visible) return { ok: false, error: surface === 'main' ? 'The Bimax window was closed.' : 'The ⌘2 bar was closed.' };
      if (talk.active) {
        if (talkOwner === surface) return { ok: true };
        talkLog('ending: talking moved to the other window');
        talk.end();
      }
      voice.cancel(event.sender.id);
      talkOwner = surface;
      talkRoot = root;
      // Talking starts at once, so the model list is never waited for: the list already known decides (none known yet
      // means the talk model), and a fresh one is fetched for next time. Waiting on a booting engine took up to 8s.
      talkModelChoice = talkModel(modelCatalog, loadSettings().quickModel, loadModelTimes());
      void refreshModelCatalog();
      talk.start();
      return { ok: true };
    } finally {
      talkStarting = null;
    }
  });
  secureOn('talk:end', (event) => {
    const surface = talkSurface(event.sender);
    if (surface && talkStarting === surface) talkStartCancelled = true;
    if (!surface || surface !== talkOwner || !talk.active) return;
    talkLog(`ending: End pressed in the ${surface === 'main' ? 'main window' : '⌘2 bar'}`);
    talk.end();
  });
  secureOn('talk:interrupt', (event) => { if (talkSurface(event.sender) === talkOwner) talk.interrupt(); });
  // Only the window that is talking sees the conversation's state; the other one's Talk button stays ready.
  secureHandle('talk:current', null as TalkView | null, (event) => (talkSurface(event.sender) === talkOwner ? talk.current : null));
  // The bar's folder rules editor (folder.rules.ts). Saved in Bimax's settings; engines pick them up when they start.
  secureHandle('threads:rules-get', null as { root: string; text: string; protect: string[] } | null, () => {
    const root = quickThreadSnapshot()?.root ?? quickContext.root ?? null;
    rulesEditingRoot = root;
    if (!root) return null;
    const saved = loadSettings().folderRules?.[root];
    return { root, text: saved?.text ?? '', protect: saved?.protect ?? [] };
  });
  secureHandle('threads:rules-set', { ok: false } as { ok: boolean; error?: string }, (_e, raw: unknown) => {
    const root = rulesEditingRoot;
    if (!root) return { ok: false, error: 'Choose a folder first.' };
    const rules = cleanRules(root, raw);
    saveFolderRules(root, rules, rules.text || rules.protect.length ? `Rules for ${path.basename(root)} saved.` : `Rules for ${path.basename(root)} cleared.`);
    return { ok: true };
  });
  // FL7: a bookmark the person leaves on a task, and what happened since when they come back.
  secureHandle('threads:bookmark-set', false, (_e, id: unknown, note: unknown) => {
    if (typeof id !== 'string') return false;
    try { threads.setBookmark(id, note === null ? null : cleanBookmark(note, Date.now())); updateTray(); return true; } catch { return false; }
  });
  secureHandle('threads:where', null as unknown, async (_e, id: unknown) => {
    if (typeof id !== 'string') return null;
    try {
      const { summary, state } = threads.get(id);
      if (!summary.bookmark) return null;
      const entries = await fsp.readdir(summary.root, { withFileTypes: true }).catch(() => []);
      const born = await Promise.all(entries.slice(0, 2000).map(async (entry) => ({
        name: entry.name, isFile: entry.isFile(), born: await fsp.stat(path.join(summary.root, entry.name)).then((st) => st.birthtimeMs, () => 0),
      })));
      const changes = changesSince(threadStateRoot(app.getPath('userData'), summary.root, summary.origin), summary.bookmark.at);
      return whereWasI({ bookmark: summary.bookmark, items: state.items, changes, arrivals: arrivalsSince(born, summary.bookmark.at) });
    } catch { return null; }
  });
  // FL6: save the skill the card was opened for, with the name and description as edited.
  secureHandle('threads:skill-save', { ok: false } as { ok: boolean; error?: string }, async (_e, rawName: unknown, rawDescription: unknown) => {
    const editing = skillEditing;
    if (!editing) return { ok: false, error: 'There is no skill to save.' };
    const name = skillName(typeof rawName === 'string' ? rawName : editing.draft.name);
    const description = typeof rawDescription === 'string' && rawDescription.trim() ? rawDescription.replace(/\s+/g, ' ').trim().slice(0, 200) : editing.draft.description;
    try {
      const { file, version } = await saveSkill(path.join(os.homedir(), '.bimax', 'skills'), { ...editing.draft, name, description }, new Date());
      skillEditing = null;
      threads.addNote(editing.threadId, `Saved the skill “${name}”${version > 1 ? ` (version ${version}; the earlier one is kept beside it)` : ''} in ${path.dirname(file)}. Every new Bimax task sees it; ask for the same kind of job and it follows these steps — or works it out afresh when the input does not fit.`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });
  // FL5: start a night shift on the folder the card was opened for.
  secureHandle('threads:night-start', { ok: false } as { ok: boolean; error?: string; note?: string }, async (_e, goal: unknown, budget: unknown, until: unknown) => {
    const root = nightEditingRoot;
    if (!root) return { ok: false, error: 'Choose a folder first.' };
    const result = await startNightShift(root, typeof goal === 'string' ? goal.trim().slice(0, 4000) : '', budget, until);
    if (result.ok) nightEditingRoot = null;
    return result;
  });
  // FL2: the Organize preview. Every change comes back as the whole view, so the window never holds its own copy.
  secureHandle('organize:current', null as unknown, () => organizeView());
  secureHandle('organize:move', null as unknown, (_e, from: unknown, rawFolder: unknown) => {
    const folder = cleanFolder(rawFolder);
    if (!organizing || typeof from !== 'string' || folder === null) return null;
    const moved = moveFile(organizing, path.resolve(organizing.root, from), folder);
    if (!moved) return null;
    organizing = moved.plan;
    return { view: organizeView(), offer: moved.others ? { group: moved.group, count: moved.others, folder } : null };
  });
  secureHandle('organize:move-group', null as unknown, (_e, group: unknown, rawFolder: unknown) => {
    const folder = cleanFolder(rawFolder);
    if (!organizing || typeof group !== 'string' || folder === null) return null;
    organizing = moveGroup(organizing, group, folder);
    return organizeView();
  });
  secureHandle('organize:keep', null as unknown, (_e, from: unknown) => {
    if (!organizing || typeof from !== 'string') return null;
    organizing = keepFile(organizing, path.resolve(organizing.root, from));
    if (!organizing.moves.length) { threads.addNote(organizing.threadId, 'Every file was left where it is; nothing moved.'); organizing = null; organizeWindow?.hide(); }
    return organizeView();
  });
  secureHandle('organize:include', null as unknown, (_e, from: unknown) => {
    if (!organizing || typeof from !== 'string') return null;
    organizing = includeKept(organizing, path.resolve(organizing.root, from));
    return organizeView();
  });
  secureHandle('organize:apply', { ok: false } as { ok: boolean; error?: string }, () => applyOrganizePlan());
  secureHandle('organize:cancel', false, () => {
    if (organizing) threads.addNote(organizing.threadId, 'The organize plan was dismissed; nothing moved.');
    organizing = null;
    organizeWindow?.hide();
    return true;
  });
  // FL1 part 2: the bar's outcome editor. Only the folder the editor was opened for can be changed.
  secureHandle('threads:outcome-get', null as unknown, () => {
    const root = outcomeEditingRoot ?? quickThreadSnapshot()?.root ?? quickContext.root ?? null;
    outcomeEditingRoot = root;
    if (!root) return null;
    const outcome = loadOutcomes()[root];
    return { root, goal: outcome?.goal ?? '', queue: outcome ? outcomeQueue(forgetGone(outcome, (file) => existsSync(file))) : null };
  });
  secureHandle('threads:outcome-set', { ok: false } as { ok: boolean; error?: string }, async (_e, raw: unknown, checkNow: unknown) => {
    const root = outcomeEditingRoot;
    const goal = cleanGoal(raw);
    if (!root) return { ok: false, error: 'Choose a folder first.' };
    if (!goal) return { ok: false, error: 'Say what this folder should be ready for.' };
    const problem = setOutcome(root, goal);
    if (problem) return { ok: false, error: problem };
    const later = checkNow === true ? await checkOutcomeNow(root) : null;
    return later ? { ok: true, error: later } : { ok: true };
  });
  secureHandle('threads:outcome-clear', false, () => {
    if (!outcomeEditingRoot) return false;
    clearOutcome(outcomeEditingRoot);
    return true;
  });
  // N10: keep the rule a correction offered (teach.ts). Only the folder of the offer on screen, with the text as edited.
  secureHandle('threads:teach', { ok: false } as { ok: boolean; error?: string }, (_e, raw: unknown) => {
    const offer = teachOffer;
    teachOffer = null;
    const rule = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 400) : '';
    if (!offer || !rule) return { ok: false, error: 'Nothing to save.' };
    const saved = loadSettings().folderRules?.[offer.root] ?? { text: '', protect: [] };
    saveFolderRules(offer.root, cleanRules(offer.root, { ...saved, text: withRule(saved.text, rule) }), `Saved to the rules for ${path.basename(offer.root)}: “${rule}” Change them under ⋯ → Rules for this folder.`);
    return { ok: true };
  });
  secureHandle('threads:rules-pick', [] as string[], async () => {
    const root = rulesEditingRoot;
    if (!root) return [];
    quickPicking = true;
    const result = await dialog.showOpenDialog({ defaultPath: root, title: `Protect items in ${path.basename(root)}`, buttonLabel: 'Protect',
      properties: ['openFile', 'openDirectory', 'multiSelections'] })
      .finally(() => { quickPicking = false; if (quickWindow?.isVisible()) quickWindow.focus(); });
    if (result.canceled) return [];
    const picked = await Promise.all(result.filePaths.map((p) => fsp.realpath(p).catch(() => null)));
    return picked.filter((p): p is string => !!p && p !== root && insideFolder(root, p));
  });
  // ⌘[ / ⌘] in the bar: the previous or next of its recent tasks (thread.tray.ts nextQuickThread).
  secureHandle('threads:quick-switch', null as string | null, (_e, direction: unknown) => {
    if (direction !== 'older' && direction !== 'newer') return null;
    const next = nextQuickThread(threads.list(), quickThreadId, direction);
    if (!next) return null;
    if (talkOwner === 'quick') talk.end();
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
  // FL4: the change history — every change that can be undone, and the commands Bimax cannot undo — and selective undo.
  const commandLine = (input: unknown): string => {
    let text = String(input ?? '');
    try { const args = JSON.parse(text); if (typeof args?.command === 'string') text = args.command; } catch { /* shown as it is */ }
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > 100 ? `${text.slice(0, 99)}…` : text;
  };
  secureHandle('threads:history', null as unknown, (_e, id: unknown) => {
    if (typeof id !== 'string') return null;
    try {
      const { state } = threadUndoPaths(id);
      const commands = threads.get(id).state.items
        .filter((item) => item.kind === 'tool' && item.call.toolName === 'BashTool' && item.call.status === 'success')
        .slice(-30)
        .map((item) => (item.kind === 'tool' ? { title: commandLine(item.call.input), at: Date.parse(String(item.call.startTime)) || 0 } : null))
        .filter((c): c is { title: string; at: number } => !!c && !!c.title);
      return { entries: changeHistory(state), commands };
    } catch { return null; }
  });
  const guardedUndo = async (id: unknown, run: (state: string, root: string) => Promise<string>): Promise<{ ok: boolean; message?: string; error?: string }> => {
    if (typeof id !== 'string') return { ok: false, error: 'No thread was given.' };
    try {
      const { status } = threads.get(id).summary;
      if (status === 'working' || status === 'needs-you' || status === 'starting') return { ok: false, error: 'Wait for this thread to finish before undoing a change.' };
      const { state, root } = threadUndoPaths(id);
      return { ok: true, message: await run(state, root) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  };
  secureHandle('threads:undo-change', { ok: false } as { ok: boolean; message?: string; error?: string }, (_e, id: unknown, changeId: unknown) =>
    guardedUndo(id, async (state, root) => {
      if (typeof changeId !== 'string') throw new Error('No change was given.');
      const { title } = await undoChange(state, root, macBin, changeId);
      threads.noteUndo(id as string, title);
      return `Undid “${title}”.`;
    }));
  secureHandle('threads:undo-back-to', { ok: false } as { ok: boolean; message?: string; error?: string }, (_e, id: unknown, changeId: unknown) =>
    guardedUndo(id, async (state, root) => {
      if (typeof changeId !== 'string') throw new Error('No change was given.');
      const result = await undoBackTo(state, root, macBin, changeId);
      for (const title of result.undone) threads.noteUndo(id as string, title);
      if (result.stoppedAt) throw new Error(`Undid ${result.undone.length} change${result.undone.length === 1 ? '' : 's'}, then stopped: ${result.stoppedAt}`);
      return `Undid ${result.undone.length} change${result.undone.length === 1 ? '' : 's'}.`;
    }));
  secureOn('threads:quick-resize', (_e, height: unknown) => { if (typeof height === 'number') applyQuickBounds(height); });
  secureOn('threads:quick-reset', () => { if (talkOwner === 'quick') talk.end(); quickThreadId = null; sendQuickThread(); });
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
  // A task's priority (F7) and its wakes (F4), from the sidebar.
  secureHandle('threads:priority', false, (_e, id: unknown, priority: unknown) => {
    if (typeof id !== 'string' || (priority !== 'high' && priority !== 'normal' && priority !== 'low')) return false;
    try { threads.setPriority(id, priority); return true; } catch { return false; }
  });
  // N4: export or share a conversation from the sidebar (the ⌘2 bar has it in its More menu).
  secureOn('threads:export-menu', (_e, id: unknown) => {
    if (typeof id !== 'string') return;
    try { threads.get(id); } catch { return; }
    Menu.buildFromTemplate(exportMenuItems(() => threadConversation(id))).popup(win ? { window: win } : {});
  });
  // …and a saved session from the Sessions gallery (right-click a card).
  secureOn('sessions:export-menu', (_e, id: unknown) => {
    if (typeof id !== 'string' || !sessionFile(projectDir(), id)) return;
    Menu.buildFromTemplate(exportMenuItems(() => sessionConversation(id))).popup(win ? { window: win } : {});
  });
  secureHandle('threads:cancel-wakes', 0, (_e, id: unknown) => {
    if (typeof id !== 'string') return 0;
    try { return threads.cancelWakes(id); } catch { return 0; }
  });
  // Drop a task's queued messages; the turn being worked on carries on (backlog N12).
  secureHandle('threads:cancel-queued', 0, (_e, id: unknown) => {
    if (typeof id !== 'string') return 0;
    try { return threads.cancelQueued(id); } catch { return 0; }
  });
  secureHandle('threads:link', false, (_e, a: unknown, b: unknown, enabled: unknown) => {
    if (typeof a !== 'string' || typeof b !== 'string' || typeof enabled !== 'boolean') return false;
    threads.link(a, b, enabled); return true;
  });
  secureHandle('threads:reply', false, (_e, id: unknown, requestId: unknown, value: unknown, token: unknown) => {
    if (typeof id !== 'string' || typeof requestId !== 'number' || typeof value !== 'string') return false;
    try { threads.send(id, { t: 'reply', id: requestId, value, approvalToken: token }); return true; } catch { return false; }
  });
  secureOn('threads:hide', event => BrowserWindow.fromWebContents(event.sender)?.hide());
  // Rename, search, archive, restore and move threads to the Bin (backlog N11). Nothing is deleted outright: an archived
  // thread stays in thread storage's archive folder, and a binned one can be put back from the Bin.
  type ThreadAction = { ok: boolean; error?: string; cancelled?: boolean };
  const refused = (error: unknown): ThreadAction => ({ ok: false, error: (error as Error).message });
  const onScreen = 'This thread is open in the main window. Open another thread first.';
  /** The ⌘2 bar was showing a thread that just left the list: it moves on to a new task. */
  const leftBar = (id: string): void => { if (id === quickThreadId) { quickThreadId = null; sendQuickThread(); } };
  secureHandle('threads:rename', { ok: false } as ThreadAction, (_e, id: unknown, title: unknown) => {
    if (typeof id !== 'string' || typeof title !== 'string') return { ok: false, error: 'No thread was given.' };
    try {
      threads.rename(id, title);
      if (id === quickThreadId) sendQuickThread();
      return { ok: true };
    } catch (error) {
      return refused(error);
    }
  });
  secureHandle('threads:search', [] as string[], (_e, query: unknown) => (typeof query === 'string' ? threads.search(query.slice(0, 200)) : []));
  secureHandle('threads:archived', [] as ThreadSummary[], () => threadStorage.archived());
  secureHandle('threads:archive', { ok: false } as ThreadAction, async (_e, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'No thread was given.' };
    if (id === threads.activeId) return { ok: false, error: onScreen };
    let saved: ReturnType<ThreadManager['release']>;
    try { saved = threads.release(id); } catch (error) { return refused(error); }
    leftBar(id);
    try {
      await threadStorage.archive(saved);
      threadChanged();
      return { ok: true };
    } catch (error) {
      try { threads.restore(saved); } catch { /* still on disk: it is back when Bimax opens */ }
      return { ok: false, error: `Could not archive it: ${(error as Error).message}` };
    }
  });
  secureHandle('threads:unarchive', { ok: false } as ThreadAction, async (_e, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'No thread was given.' };
    try {
      threads.ensureRoom();
      threads.restore(await threadStorage.unarchive(id));
      threadChanged();
      return { ok: true };
    } catch (error) {
      return refused(error);
    }
  });
  secureHandle('threads:bin', { ok: false } as ThreadAction, async (event, id: unknown, archived: unknown) => {
    if (typeof id !== 'string' || typeof archived !== 'boolean') return { ok: false, error: 'No thread was given.' };
    try {
      let title: string;
      if (archived) {
        threadStorage.archivedFile(id);
        title = (await threadStorage.archived()).find((t) => t.id === id)?.title ?? 'this thread';
      } else {
        if (id === threads.activeId) return { ok: false, error: onScreen };
        if (threads.engine(id)) return { ok: false, error: 'Stop this thread first.' };
        title = threads.get(id).summary.title;
      }
      const options: Electron.MessageBoxOptions = {
        type: 'warning', message: `Move “${title}” to the Bin?`, buttons: ['Move to Bin', 'Cancel'], defaultId: 1, cancelId: 1,
        detail: 'Its conversation goes to the Bin, and Finder can put it back from there. Files the thread changed stay as they are.',
      };
      const parent = BrowserWindow.fromWebContents(event.sender);
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      if (response !== 0) return { ok: false, cancelled: true };
      if (archived) {
        await macBin.moveToBin(threadStorage.archivedFile(id));
      } else {
        // Checked again: the thread may have been opened or started while the question was on screen.
        if (id === threads.activeId) return { ok: false, error: onScreen };
        const saved = threads.release(id);
        leftBar(id);
        try {
          await macBin.moveToBin(await threadStorage.writeFinal(saved));
        } catch (error) {
          threadStorage.readmit(id);
          try { threads.restore(saved); } catch { /* still on disk: it is back when Bimax opens */ }
          return { ok: false, error: `Could not move it to the Bin: ${(error as Error).message}` };
        }
      }
      threadChanged();
      return { ok: true };
    } catch (error) {
      return refused(error);
    }
  });

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
      threads.stop(id, { keepInputs: true }); threads.start(id); selectThread(id);
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
      if (dir) startEngine(dir, { restart: true });
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
  // The engine's stderr, live — not only after a crash. A CrashRecord carries a logTail, so the
  // reason a DEAD engine died was already recoverable; the reason a LIVE one is misbehaving was
  // not reachable from inside the app at all. It went to <userData>/engine.log and stayed there,
  // which is why an engine-side fault presented as a spinner that never resolved. Same redaction
  // the crash journal applies, because this tail is read and pasted by the same people.
  secureHandle<string>('supervisor:engine-log', '', () => redactSecrets(recentEngineLog()));

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

let quitCleanupDone = false;
app.on('before-quit', (event) => {
  if (quitCleanupDone) return;
  quitCleanupDone = true;
  talk.end();
  voice.dispose();
  notchDeck?.stop();
  globalShortcut.unregisterAll();
  quickWindow?.destroy(); approvalWindow?.destroy();
  threads?.dispose(); threadBroker?.close();
  if (threadStorage) {
    // Wait for the last thread writes (backlog F12), but never hold quitting for more than three seconds.
    event.preventDefault();
    const storage = threadStorage;
    void Promise.race([storage.flush(), new Promise((resolve) => setTimeout(resolve, 3000))]).finally(() => app.quit());
  }
  supervisor?.dispose();
  supervisor = null;
  killAllPtys();
  projectWatcher?.close();
  projectWatcher = null;
});
