import { BrowserWindow, screen, shell, nativeImage, app, systemPreferences } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { REQUIRED_WEB_PREFERENCES } from './security';
import { hostGrants, invalidateHostGrants, type Disposition } from './host.grants';

/**
 * The permission drag coach.
 *
 * macOS's Accessibility, Screen Recording and Full Disk Access lists are add-by-drag: the most
 * direct way in is to drag the responsible bundle onto them. A first-time user cannot guess that,
 * so this floats a draggable Bimax icon over System Settings, exactly where the drop has to land.
 *
 * The overlay is a compact interactive drag source rather than a sheet-sized click blocker. We
 * previously tried to hand mouse ownership back and forth with `setIgnoreMouseEvents`; that race
 * made the icon intermittently impossible to grab. The window now occupies only the visible coach
 * tile, so the rest of System Settings remains directly interactive.
 *
 * The drag itself is a real native file drag of the app bundle (`webContents.startDrag`), which is
 * what System Settings accepts. We never claim to grant anything: macOS does the granting, and the
 * pane polls the true reading afterwards.
 */

let coach: BrowserWindow | null = null;
let preparedDragIcon: Electron.NativeImage | null = null;
let preparedDragBundle: string | null = null;
let restoreMainWindow: (() => void) | null = null;
let nativeDragActive = false;
let completedNativeDrag = false;
let watchGrantAfterCompletedDrag = false;
let droppedPane: string | null = null;
let droppedIdentityOwner: 'host' | 'service' = 'host';
let deferredStopReason: string | null = null;
let destroyTimer: NodeJS.Timeout | null = null;
let grantWatch: {
  pane: string;
  identityOwner: 'host' | 'service';
  startedAt: number;
  timer: NodeJS.Timeout;
  onActive: () => void;
  restore: (() => void) | null;
} | null = null;

// A dropped running .app can receive an application-reopen Apple event while Electron is still
// unwinding `webContents.startDrag`. Destroying that WebContents in the same turn leaves Electron
// dispatching the reopen event through a dead V8 wrapper (SIGTRAP on the browser main thread).
// Hiding is immediate; destruction happens only after the native drag and reopen event have had a
// complete turn to finish.
const DRAG_SETTLE_MS = 1_200;

/**
 * How long we keep watching for a grant that the drop only *started*.
 *
 * Dropping a bundle on the Accessibility list does not grant anything — macOS then raises an
 * authentication sheet, and the grant lands whenever the user finishes with it. A person who has to
 * fetch a password, or who reads the sheet before deciding, can easily take minutes.
 */
const GRANT_WATCH_MS = 5 * 60_000;
const GRANT_POLL_MS = 1_000;

/**
 * How long an activation is attributed to the drag rather than to the user.
 *
 * macOS hands this app a reopen Apple event as System Settings resolves the dropped bundle, and it
 * arrives with roughly the timing of the drop, not of the user's return. Treating that as "the user
 * came back" is what used to throw the window in front of the password sheet. Anything this soon
 * after the tile disappears is the drag's own echo; the user's real return comes later.
 */
const ACTIVATION_IS_OURS_MS = 4_000;

function logCoach(event: string, detail: Record<string, unknown> = {}): void {
  // Deliberately contains no file contents, credentials or user input. These lifecycle markers are
  // enough to distinguish load failure, renderer death and an explicit stop in packaged runs.
  console.info(`[permission-coach] ${JSON.stringify({ event, ...detail })}`);
}

/** The panes we can deep-link. Fixed map — never a caller-supplied URL. */
const PANES: Record<string, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
};

async function openPermissionPane(url: string): Promise<void> {
  await shell.openExternal(url);
  // On macOS 26, activating an already-running System Settings process can consume the first
  // x-apple.systempreferences event and leave it on General. Once Settings is frontmost the same
  // fixed, allow-listed URL resolves correctly. The small retry happens before the coach appears,
  // so the user sees one settled destination rather than a draggable tile over the wrong pane.
  // Electron exposes the host OS version on its augmented `process`, not on `app`. Calling
  // `app.getSystemVersion()` opens System Settings and then throws before the coach window is
  // created, leaving Bimax hidden with no draggable source — exactly the worst point to fail.
  const major = Number.parseInt(process.getSystemVersion().split('.')[0] || '0', 10);
  if (Number.isFinite(major) && major >= 26) {
    await new Promise<void>((resolve) => setTimeout(resolve, 420));
    await shell.openExternal(url);
  }
}

export type CoachPane = keyof typeof PANES;

/** Re-exported so existing importers keep their import path; the type is owned by host.grants. */
export type { Disposition };

/**
 * Whether the drop that just happened still has an unfinished macOS approval behind it.
 *
 * Every add-by-drag TCC list works the same way: the drop is a *request*, macOS raises an
 * authentication sheet, and the grant is recorded only once the user satisfies it. Nothing in the
 * drag's own lifecycle reports that moment, so the coach waits instead of assuming.
 *
 * This is deliberately keyed on "does the drop raise a sheet", NOT on "can we observe the result".
 * Keying it on observability was the first attempt and it left Full Disk Access — whose result IS
 * directly observable via a file read — restoring the window straight onto its password prompt. The
 * sheet is what the user is busy with; whether we can later read the answer is a separate question.
 */
export function permissionDragNeedsGrantWatch(
  pane: string,
  _identityOwner: 'host' | 'service' = 'host',
): boolean {
  return pane === 'accessibility' || pane === 'screenRecording' || pane === 'fullDisk';
}

function toDisposition(raw: unknown): Disposition {
  if (raw === true || raw === 'granted') return 'granted';
  if (raw === false || raw === 'denied' || raw === 'restricted') return 'denied';
  if (raw === 'not-determined' || raw === 'unknown') return 'not-determined';
  return 'unavailable';
}

/**
 * The live reading that would tell us the drop succeeded, or `unavailable` when this process is not
 * the one that can see it.
 *
 * A service drag grants a separate XPC identity, which main cannot read at all — that one is proven
 * by the renderer's handshake poll, which calls `stopCoach()` on success and settles the watch that
 * way. Returning `unavailable` here says so honestly rather than polling something unrelated and
 * calling a host reading the service's answer.
 */
function grantReading(pane: string, identityOwner: 'host' | 'service'): Disposition {
  if (process.platform !== 'darwin' || identityOwner === 'service') return 'unavailable';
  // Through `hostGrants()`, never `systemPreferences` directly: this is polled once a second by a
  // watch whose entire job is to notice a change, and the in-process API is the one thing here that
  // provably cannot report one. See host.grants.ts for the measurement.
  if (pane === 'accessibility') return hostGrants().accessibility;
  if (pane === 'screenRecording') return hostGrants().screenRecording;
  if (pane === 'fullDisk') return probeFullDisk();
  return 'unavailable';
}

/**
 * End the watch. `restore` decides whether the main window comes back with it — abandoning the
 * watch because a new coach started or the app is quitting must NOT drag the window into view.
 */
export function endGrantWatch(reason = 'superseded', restore: 'restore' | 'leave-hidden' = 'leave-hidden'): void {
  if (!grantWatch) return;
  const watch = grantWatch;
  grantWatch = null;
  clearInterval(watch.timer);
  app.removeListener('did-become-active', watch.onActive);
  app.removeListener('activate', watch.onActive);
  logCoach('grant-watch-end', {
    pane: watch.pane,
    reason,
    waitedMs: Date.now() - watch.startedAt,
    reading: grantReading(watch.pane, watch.identityOwner),
    restored: restore === 'restore',
  });
  if (restore === 'restore') watch.restore?.();
}

/** True while a dropped host permission is still waiting on the macOS authentication sheet. */
export function isAwaitingHostGrant(): boolean {
  return grantWatch !== null;
}

/**
 * Wait for the grant the drop asked for, and bring Bimax back only once something says so.
 *
 * This replaces an unconditional relaunch fired 1.2s after the mouse came up. That timer was the
 * cause of three separate reports, all from the same mistaken premise that a completed drag is a
 * completed grant:
 *
 *   - Bimax reappeared over the password sheet the user was still filling in, and
 *   - the process it relaunched into started BEFORE the grant existed, so it read "not granted" and
 *     — because a running process cannot be sure of seeing a later change — kept reporting Off long
 *     after macOS had recorded the approval.
 *
 * There are exactly two honest signals that the journey is over, and neither is a timer:
 * the reading itself flipping, or the user coming back to Bimax of their own accord. Wait for one.
 */
function beginGrantWatch(
  pane: string,
  identityOwner: 'host' | 'service',
  restore: (() => void) | null,
): void {
  endGrantWatch('restarted');
  const startedAt = Date.now();
  // The drop just happened, so any reading taken before it is answering a stale question.
  invalidateHostGrants();

  const settle = (reason: string): void => endGrantWatch(reason, 'restore');

  const onActive = (): void => {
    // The drag's own reopen event looks exactly like an activation. Only time separates them.
    if (Date.now() - startedAt < ACTIVATION_IS_OURS_MS) {
      logCoach('grant-watch-ignored-activation', { pane, sinceMs: Date.now() - startedAt });
      return;
    }
    settle('user-returned');
  };

  grantWatch = {
    pane,
    identityOwner,
    startedAt,
    onActive,
    restore,
    timer: setInterval(() => {
      // `unavailable` (a service identity) never settles here — the renderer's handshake poll owns
      // that one and settles the watch through stopCoach(). Falling back to a host reading would be
      // answering a question about the service with a fact about ourselves.
      if (grantReading(pane, identityOwner) === 'granted') { settle('granted'); return; }
      if (Date.now() - startedAt >= GRANT_WATCH_MS) settle('timed-out');
    }, GRANT_POLL_MS),
  };
  app.on('did-become-active', onActive);
  app.on('activate', onActive);
  logCoach('grant-watch-start', { pane, identityOwner, reading: grantReading(pane, identityOwner) });
}

export interface PermissionProbe {
  readings: Record<string, Disposition>;
  /** Whether Accessibility/Screen Recording came from the live helper or the stale fallback. */
  readingSource: 'helper' | 'in-process';
  /** The bundle macOS actually attributes these grants to, and its display name. */
  responsibleBundle: string;
  responsibleName: string;
  /** True when that bundle is not Bimax itself — i.e. a dev run under Electron. */
  isDevHost: boolean;
}

/**
 * Read every permission live, and say WHOSE permissions they are.
 *
 * macOS grants TCC permissions to the running executable, which in a dev run is Electron.app, not
 * Bimax.app. Toggling the "Bimax" row in System Settings then changes nothing about this process,
 * and the pane keeps reporting the grant Electron was given long ago. That is not a stale cache —
 * it is the honest answer to a question the user did not think they were asking, and the only fix
 * is to name the bundle instead of showing a bare green tick.
 */
export function probePermissions(): PermissionProbe {
  const darwin = process.platform === 'darwin';
  const bundle = draggableBundlePath() ?? process.execPath;
  const name = path.basename(bundle, '.app');
  // Read the pair once. Besides avoiding duplicate work, this keeps their values and provenance an
  // atomic snapshot for the renderer: the UI must never explain a fresh value as a cached one.
  const host = hostGrants();

  const probe: PermissionProbe = {
    responsibleBundle: bundle,
    responsibleName: name,
    readingSource: host.source,
    // Anything whose bundle name is not Bimax is a host we are borrowing — the grant belongs to it.
    isDevHost: darwin && !/^bimax$/i.test(name),
    readings: {
      // Fresh-child readings. This probe is what the Trust Center renders, so a stale positive here
      // is what made the app insist a granted permission was off no matter how many times the user
      // granted it.
      accessibility: darwin ? host.accessibility : 'unavailable',
      screenRecording: darwin ? host.screenRecording : 'unavailable',
      // Microphone stays in-process: it is prompt-driven, and the prompt's own callback updates
      // this process, so there is no staleness to correct.
      microphone: darwin
        ? toDisposition(systemPreferences.getMediaAccessStatus('microphone'))
        : 'unavailable',
      // There is no query API for Full Disk Access, so probe it the only honest way: attempt a read
      // that ONLY succeeds with the grant. TCC.db is the canonical marker and the read is harmless.
      fullDisk: darwin ? probeFullDisk() : 'unavailable',
    },
  };
  // "I enabled it in System Settings and Bimax still says off" is unanswerable without knowing what
  // the OS actually told THIS process, and which bundle it answered for. Log both: it is the
  // difference between a stale TCC row, a grant on the wrong bundle, and a bug in our own layer.
  // Contains no user data — four enum values and our own bundle path.
  logCoach('probe', {
    ...probe.readings,
    readingSource: probe.readingSource,
    responsible: bundle,
    isDevHost: probe.isDevHost,
  });
  return probe;
}

/** Full Disk Access has no API — a successful read of the TCC database is the proof. */
function probeFullDisk(): Disposition {
  const tcc = path.join(app.getPath('home'), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db');
  try {
    fs.accessSync(tcc, fs.constants.R_OK);
    return 'granted';
  } catch (error: any) {
    // EPERM/EACCES is a real refusal; ENOENT means the file is not there to prove anything with,
    // which is "we cannot tell", not "denied".
    return error?.code === 'ENOENT' ? 'not-determined' : 'denied';
  }
}

/**
 * The .app bundle to drag.
 *
 * `process.execPath` is the binary inside the bundle; System Settings wants the bundle itself, so
 * walk up out of `Contents/MacOS`. In a dev run this is Electron.app — which is correct, because in
 * dev that IS the process macOS will attribute the grant to. Handing the user a path to a bundle
 * that is not the responsible process produces a grant that silently does nothing.
 */
export function draggableBundlePath(): string | null {
  if (process.platform !== 'darwin') return null;
  const exe = process.execPath;
  const marker = '.app/Contents/MacOS/';
  const at = exe.indexOf(marker);
  if (at === -1) return null;
  const bundle = exe.slice(0, at + '.app'.length);
  try { return fs.existsSync(bundle) ? bundle : null; } catch { return null; }
}

/**
 * A deterministic in-memory drag icon.
 *
 * Do not call `app.getFileIcon()` here. On macOS 26.5.2 with Electron 43.3.0 that asynchronous
 * Launch Services lookup can trap inside AppKit's `NSImage` worker for the ad-hoc Electron host,
 * terminating the entire app exactly when the user presses Enable. The icon is only drag feedback;
 * the payload and visible coach still name the exact responsible bundle. Generating it in memory
 * removes filesystem/icon-cache/signature state from this security-critical path.
 */
function bundleIcon(): Electron.NativeImage {
  // `createFromDataURL()` returned an empty image for both SVG and PNG data URLs in the packaged
  // Electron 43/macOS 26 build. Use raw pixels so this security-critical drag source does not
  // depend on an image codec, file lookup, Launch Services or a cache. Electron's bitmap contract
  // is four bytes per pixel in BGRA order.
  const width = 64;
  const height = 64;
  const radius = 14;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nearestX = Math.min(x, width - 1 - x);
      const nearestY = Math.min(y, height - 1 - y);
      const cornerX = Math.max(0, radius - nearestX);
      const cornerY = Math.max(0, radius - nearestY);
      const inside = cornerX * cornerX + cornerY * cornerY <= radius * radius;
      const offset = (y * width + x) * 4;
      const shade = Math.round(52 - (30 * (x + y)) / (width + height - 2));
      pixels[offset] = shade; // blue
      pixels[offset + 1] = shade; // green
      pixels[offset + 2] = shade; // red
      pixels[offset + 3] = inside ? 255 : 0; // alpha
    }
  }
  return nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 });
}

/**
 * Open the requested System Settings pane and float the coach beside it.
 *
 * Returns false when the pane is unknown or we are not on macOS, so the caller can show the manual
 * instructions instead of a coach pointing at nothing.
 */
export async function startCoach(
  pane: string,
  stepAside?: () => void,
  restore?: () => void,
  dragBundleOverride?: string,
  identityOwner: 'host' | 'service' = dragBundleOverride ? 'service' : 'host',
): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const url = PANES[pane];
  if (!url) return false;
  const bundle = dragBundleOverride || draggableBundlePath();
  const dragToAdd = !!dragBundleOverride
    || pane === 'accessibility'
    || pane === 'screenRecording'
    || pane === 'fullDisk';
  if (destroyTimer) {
    clearTimeout(destroyTimer);
    destroyTimer = null;
  }
  // A second Enable supersedes whatever the previous drop was still waiting for.
  endGrantWatch('new-coach');
  deferredStopReason = null;
  preparedDragIcon = dragToAdd && bundle ? bundleIcon() : null;
  preparedDragBundle = dragToAdd && bundle ? bundle : null;
  if (dragToAdd && (!bundle || !preparedDragIcon || preparedDragIcon.isEmpty())) {
    logCoach('prepare-failed', { pane, hasBundle: !!bundle, hasIcon: !!preparedDragIcon });
    return false;
  }
  logCoach('start', { pane, dragToAdd, bundleName: bundle ? path.basename(bundle) : null });

  // Get out of the way BEFORE opening the pane. System Settings has to be the frontmost window for
  // the drop to land, and a Bimax window sitting in front of it — with a modal dialog open, no
  // less — is the difference between "drag this there" and "drag this onto the thing you cannot
  // see". The coach itself stays above everything; only the main window steps back.
  // Only add-by-drag panes need Bimax fully out of the way. Toggle-only panes have no floating
  // coach from which the user could return, so opening Settings normally is the correct behavior.
  if (dragToAdd) {
    restoreMainWindow = restore ?? null;
    stepAside?.();
  }
  await openPermissionPane(url);

  // Toggle-only panes need no floating file source. The in-app coach still names the switch and
  // polls the live reading, while System Settings gets the whole screen without an overlay.
  if (!dragToAdd) {
    stopCoach();
    return true;
  }

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x: workX, y: workY, width, height } = display.workArea;
  const size = { width: 260, height: 220 };

  if (coach && !coach.isDestroyed()) coach.destroy();
  completedNativeDrag = false;
  droppedPane = pane;
  droppedIdentityOwner = identityOwner;
  watchGrantAfterCompletedDrag = permissionDragNeedsGrantWatch(pane, identityOwner);
  coach = new BrowserWindow({
    ...size,
    // Over the System Settings window, not the desktop below it. Settings opens centred at roughly
    // 800x600, so its list occupies the middle of the screen; the coach sits just below centre —
    // on the sheet, under the drop target, close enough that the drag is a short deliberate move
    // rather than a trip across the display.
    x: workX + Math.round((width - size.width) / 2) + 140,
    y: workY + Math.round(height - size.height - 42),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // A native drag must originate from an interactive WebContents. `showInactive` below keeps
    // System Settings frontmost until the person actually grabs the compact drag tile.
    focusable: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      ...REQUIRED_WEB_PREFERENCES,
    },
  });

  // Visible over System Settings AND over full-screen spaces, without joining the app switcher.
  coach.setAlwaysOnTop(true, 'screen-saver');
  coach.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  coach.webContents.on('did-fail-load', (_event, code, description) => {
    logCoach('load-failed', { code, description });
  });
  coach.webContents.on('render-process-gone', (_event, details) => {
    logCoach('renderer-gone', { reason: details.reason, exitCode: details.exitCode });
  });
  coach.on('unresponsive', () => logCoach('unresponsive'));
  coach.once('closed', () => {
    logCoach('closed');
    coach = null;
    preparedDragBundle = null;
    preparedDragIcon = null;
    const pendingPane = completedNativeDrag && watchGrantAfterCompletedDrag ? droppedPane : null;
    const pendingOwner = droppedIdentityOwner;
    completedNativeDrag = false;
    watchGrantAfterCompletedDrag = false;
    droppedPane = null;
    const restoreWindow = restoreMainWindow;
    restoreMainWindow = null;
    if (pendingPane) {
      // The drop only asked; macOS is asking the user right now. Coming back here would land the
      // window on top of the authentication sheet, so hand off to the watch and stay out of sight.
      beginGrantWatch(pendingPane, pendingOwner, restoreWindow);
      return;
    }
    restoreWindow?.();
  });

  const route = 'permission-coach';
  try {
    if (process.env.ELECTRON_RENDERER_URL) {
      await coach.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${route}`);
    } else {
      await coach.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: route });
    }
  } catch (error) {
    logCoach('load-threw', { error: error instanceof Error ? error.message : String(error) });
    stopCoach('load-threw');
    return false;
  }
  coach.showInactive();
  logCoach('shown', { webContentsId: coach.webContents.id });
  return true;
}

/** Compatibility shim for renderer bundles built before the compact coach replaced mouse handoff. */
export function setCoachInteractive(interactive: boolean): void {
  if (!coach || coach.isDestroyed()) return;
  // Kept as a compatibility no-op for older renderer bundles. The coach is now a compact window
  // whose whole visible area is the drag source; click-through mouse handoff was both unnecessary
  // and the source of the race that made the icon intermittently impossible to grab.
  void interactive;
}

/** Begin the native file drag of the app bundle. Returns false when there is nothing to drag. */
export function startBundleDrag(event: Electron.IpcMainEvent): boolean {
  const bundle = preparedDragBundle;
  if (!bundle || !preparedDragIcon || preparedDragIcon.isEmpty()) return false;
  nativeDragActive = true;
  logCoach('drag-started', { bundleName: path.basename(bundle) });
  try {
    event.sender.startDrag({ file: bundle, icon: preparedDragIcon });
    completedNativeDrag = true;
    return true;
  } catch (error) {
    logCoach('drag-failed', { error: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    nativeDragActive = false;
    logCoach('drag-ended');
    if (deferredStopReason) {
      const reason = deferredStopReason;
      deferredStopReason = null;
      scheduleCoachDestruction(reason);
    } else {
      // The native drag returning is the one lifecycle boundary we own, and it means the mouse came
      // up — nothing more. Retire the tile on it, because a floating tile over a password sheet is
      // pure obstruction, but do NOT treat it as the end of the journey: the close callback hands
      // host panes to the grant watch instead of restoring the window.
      scheduleCoachDestruction('drag-completed');
    }
  }
}

/** The coach window's webContents id, so main can admit its IPC. Null when no coach is open. */
export function coachWebContentsId(): number | null {
  return coach && !coach.isDestroyed() ? coach.webContents.id : null;
}

/** The exact payload currently under the coach tile (host app or native CU service bundle). */
export function coachBundlePath(): string {
  return preparedDragBundle || draggableBundlePath() || '';
}

function clearCoachState(): void {
  coach = null;
  preparedDragBundle = null;
  preparedDragIcon = null;
  const pendingPane = completedNativeDrag && watchGrantAfterCompletedDrag ? droppedPane : null;
  const pendingOwner = droppedIdentityOwner;
  completedNativeDrag = false;
  watchGrantAfterCompletedDrag = false;
  droppedPane = null;
  const restoreWindow = restoreMainWindow;
  restoreMainWindow = null;
  if (pendingPane) {
    beginGrantWatch(pendingPane, pendingOwner, restoreWindow);
    return;
  }
  restoreWindow?.();
}

function scheduleCoachDestruction(reason: string): void {
  if (!coach || coach.isDestroyed()) {
    clearCoachState();
    return;
  }
  coach.hide();
  if (destroyTimer) clearTimeout(destroyTimer);
  logCoach('destroy-scheduled', { reason, settleMs: DRAG_SETTLE_MS });
  destroyTimer = setTimeout(() => {
    destroyTimer = null;
    if (coach && !coach.isDestroyed()) coach.destroy();
    else clearCoachState();
  }, DRAG_SETTLE_MS);
}

export function stopCoach(reason = 'requested'): void {
  logCoach('stop', {
    reason, hasWindow: !!coach && !coach.isDestroyed(), nativeDragActive, awaitingGrant: !!grantWatch,
  });
  if (reason === 'before-quit') {
    // Nothing may outlive the app — least of all a watch whose whole purpose is to bring a window
    // back. Drop the pending hand-off too, so tearing the tile down cannot start one.
    endGrantWatch('before-quit');
    completedNativeDrag = false;
    watchGrantAfterCompletedDrag = false;
    droppedPane = null;
  } else if (grantWatch) {
    // An explicit stop is the user saying they are finished with System Settings, which is the same
    // thing the watch is waiting to hear. Honour it and bring the window back now.
    endGrantWatch(reason, 'restore');
  }
  if (coach && !coach.isDestroyed()) {
    coach.hide();
    if (reason === 'before-quit') {
      if (destroyTimer) clearTimeout(destroyTimer);
      destroyTimer = null;
      coach.destroy();
    } else if (nativeDragActive) {
      deferredStopReason = reason;
      logCoach('stop-deferred', { reason });
    } else {
      scheduleCoachDestruction(reason);
    }
    return;
  }
  clearCoachState();
}

/** Nothing should outlive the app; a stray always-on-top window is unclosable for the user. */
app.on('before-quit', () => stopCoach('before-quit'));
