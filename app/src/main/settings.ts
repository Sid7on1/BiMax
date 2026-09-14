import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Persistent desktop settings (P0.1). The app used to default a launch to $HOME, which the engine
 * treats as a scratch dir — surfacing as Git and genome errors and forcing the user to re-pick a
 * project every time. We now persist the last valid project and a small recents list, and NEVER
 * auto-open $HOME. When there's no valid project to resume, the renderer shows a project-first
 * welcome instead of booting an engine in the wrong place.
 *
 * The pure helpers (isRealProject / pickInitialProject / withRecent) take their inputs explicitly so
 * they're unit-testable without Electron; only load/save touch the userData file.
 */

export interface AppSettings {
  lastProject?: string;
  recentProjects?: string[];
  /** Where the ⌘2 bar was last dragged to (its top-left, in screen coordinates). */
  quickBar?: { x: number; y: number };
  /** The model new ⌘2 tasks start with; absent means Bimax's own. */
  quickModel?: string;
  /** How long turns have taken with each model on this Mac, for the model menu (thread.models.ts). */
  modelTimes?: Record<string, { avgMs: number; turns: number }>;
  /** Each folder's rules, keyed by its real path (folder.rules.ts) — kept here, never in the folder. */
  folderRules?: Record<string, { text: string; protect: string[] }>;
  /** Repeating ⌘2 tasks (schedules.ts). */
  schedules?: import('./schedules').Schedule[];
  /** ⌘2 tasks that run when files arrive in a folder (folder.triggers.ts). */
  folderTriggers?: import('./folder.triggers').FolderTrigger[];
}

const MAX_RECENTS = 8;

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    return raw && typeof raw === 'object' ? (raw as AppSettings) : {};
  } catch {
    return {}; // first run / unreadable — defaults
  }
}

export function saveSettings(patch: Partial<AppSettings>): void {
  try {
    const next = { ...loadSettings(), ...patch };
    mkdirSync(path.dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch {
    /* best-effort — a settings write must never crash the app */
  }
}

/**
 * A "real project" is an existing directory that is NOT the user's home root. The engine treats a
 * bare $HOME as a scratch session (no repo → Git/genome errors), so it must never be auto-opened.
 */
export function isRealProject(dir: string | undefined | null): boolean {
  if (!dir || typeof dir !== 'string') return false;
  try {
    const full = path.resolve(dir);
    if (full === path.resolve(os.homedir())) return false;
    return existsSync(full) && statSync(full).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The project to open on launch.
 *
 * Only an EXPLICIT instruction opens a project automatically: `$BIMAX_CWD`, or launching from a
 * folder. The last-used project is deliberately NOT reopened — a coding session is scoped to a
 * repository, and silently resuming the previous one means the app starts doing work in a project
 * the user may not have meant to be in, with no moment at which they chose it. Reopening was also
 * indistinguishable from "the app ignored me": there was no way to get to the picker except by
 * closing a project you never asked to open.
 *
 * `null` sends the renderer to the project-first welcome, where the recents list makes returning to
 * yesterday's repository one click — chosen rather than assumed.
 */
export function pickInitialProject(saved: string | undefined, envCwd: string | undefined = process.env.BIMAX_CWD): string | null {
  if (isRealProject(envCwd)) return path.resolve(envCwd!);
  void saved; // kept in settings for the recents list; never auto-opened
  return null;
}

/** Fold a newly-opened project into the recents list: most-recent first, deduped, capped. */
export function withRecent(recents: string[] | undefined, dir: string): string[] {
  const norm = path.resolve(dir);
  const rest = (recents ?? []).map((r) => path.resolve(r)).filter((r) => r !== norm);
  return [norm, ...rest].slice(0, MAX_RECENTS);
}

/** Record a project as opened: updates lastProject + recents, dropping any that no longer exist. */
export function recordProject(dir: string): void {
  if (!isRealProject(dir)) return;
  const cur = loadSettings();
  const recents = withRecent(cur.recentProjects, dir).filter(isRealProject);
  saveSettings({ lastProject: path.resolve(dir), recentProjects: recents });
}

/** Valid, still-existing recent projects for the welcome screen (most recent first). */
export function recentProjects(): string[] {
  return (loadSettings().recentProjects ?? []).filter(isRealProject);
}
