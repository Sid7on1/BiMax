import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Logger } from '../utils';

/**
 * Multi-repo workspace — native cross-repo awareness (docs/UPGRADE_2026_RESEARCH.md PR1).
 *
 * Pattern sources: Claude Code's additional working directories (`--add-dir`) and Plandex's
 * multi-repo planning. BiMax keeps a manifest of every repo the user has registered for this
 * project (`.bimax/workspace.json`), refreshes branch/sync state on session start, detects
 * fresh `git clone`s made mid-session, and scopes edits per-repo: the primary repo is always
 * writable, other repos join read-only until explicitly unlocked ("pull the pattern from repo Y
 * into repo X" needs Y readable, only X writable).
 *
 * Deliberately additive: paths OUTSIDE any registered repo behave exactly as before — this
 * layer only grants awareness of sibling repos and enforces the scope the user chose for them.
 */

export type RepoScope = 'write' | 'read' | 'ignored';

export interface WorkspaceRepo {
  /** Absolute path to the repo root (contains .git). */
  path: string;
  /** Short display name (basename of path unless overridden). */
  name: string;
  /** Why this repo is in the workspace ("upstream reference", "pattern source", …). */
  purpose?: string;
  /** Current branch, refreshed on session start / refresh(). */
  branch?: string;
  /** Last time we refreshed git state for this entry (ISO). */
  lastSynced?: string;
  /** write = editable · read = readable reference · ignored = user declined registration. */
  scope: RepoScope;
  registeredAt: string;
}

interface Manifest { version: 1; repos: WorkspaceRepo[] }

export class WorkspaceManager {
  private manifestPath: string;
  private repos: WorkspaceRepo[] = [];
  /** Freshly-detected clone paths awaiting the one-time "register?" ask. */
  private candidates: string[] = [];

  constructor(private primaryRoot: string) {
    this.manifestPath = path.join(stateDir('.bimax', primaryRoot), 'workspace.json');
    this.load();
  }

  // ---- persistence -------------------------------------------------------------------

  private load(): void {
    try {
      const m = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8')) as Manifest;
      if (Array.isArray(m.repos)) this.repos = m.repos;
    } catch { /* first run — no manifest yet */ }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
      const m: Manifest = { version: 1, repos: this.repos };
      fs.writeFileSync(this.manifestPath, JSON.stringify(m, null, 2));
    } catch (e: any) {
      Logger.warn(`[Workspace] Could not save manifest: ${e?.message ?? e}`);
    }
    // Nudge the UI (status-bar repo chip) — lazy require keeps core free of the CLI layer.
    try { require('../cli/events').cliEvents.emit('workspace_changed'); } catch { /* headless-boot ok */ }
  }

  // ---- git helpers (best-effort, never throw) ------------------------------------------

  private gitBranch(repoPath: string): string | undefined {
    try {
      return execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
    } catch { return undefined; }
  }

  private isGitRepo(p: string): boolean {
    try { return fs.existsSync(path.join(p, '.git')); } catch { return false; }
  }

  // ---- session lifecycle ---------------------------------------------------------------

  /**
   * Session start: make sure the primary repo is registered (always writable), refresh
   * branch/lastSynced on every live entry, drop entries whose directory vanished, and scan the
   * primary root's direct children for unregistered clones (they become ask-once candidates).
   */
  public refresh(): void {
    this.repos = this.repos.filter(r => {
      if (fs.existsSync(r.path)) return true;
      Logger.info(`[Workspace] Repo gone from disk, dropping: ${r.path}`);
      return false;
    });

    if (this.isGitRepo(this.primaryRoot) && !this.find(this.primaryRoot)) {
      this.repos.unshift({
        path: this.primaryRoot,
        name: path.basename(this.primaryRoot),
        purpose: 'primary project',
        scope: 'write',
        registeredAt: new Date().toISOString(),
      });
    }

    const now = new Date().toISOString();
    for (const r of this.repos) {
      if (r.scope === 'ignored') continue;
      const b = this.gitBranch(r.path);
      if (b) { r.branch = b; r.lastSynced = now; }
    }

    this.scan(this.primaryRoot);
    this.save(); // entries and branch refresh both worth persisting
  }

  /** Scan a directory's direct children for git repos not yet registered/ignored. */
  public scan(dir: string): string[] {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (full === this.primaryRoot) continue;
        if (this.isGitRepo(full) && !this.find(full) && !this.candidates.includes(full)) {
          this.candidates.push(full);
        }
      }
    } catch { /* unreadable dir — nothing to scan */ }
    return [...this.candidates];
  }

  /**
   * Sniff a completed shell command for `git clone`; a clone's target directory becomes an
   * ask-once registration candidate. Called by BashTool/GitTool after successful execution.
   */
  public noticeCommand(command: string, cwd: string): void {
    const m = /git\s+clone\s+(?:-[-\w=]+\s+)*(\S+?)(?:\.git)?(?:\s+(\S+))?\s*(?:$|[;&|])/.exec(command);
    if (!m) return;
    const target = m[2] && !m[2].startsWith('-')
      ? m[2]
      : path.basename(m[1].replace(/\.git$/, '').replace(/\/+$/, ''));
    const full = path.resolve(cwd, target);
    // The clone may still be settling; only queue when it really landed as a repo.
    if (this.isGitRepo(full) && !this.find(full) && !this.candidates.includes(full)) {
      this.candidates.push(full);
      Logger.info(`[Workspace] Detected fresh clone: ${full} — awaiting registration decision.`);
    }
  }

  // ---- registration --------------------------------------------------------------------

  public find(repoPath: string): WorkspaceRepo | undefined {
    const norm = path.resolve(repoPath);
    return this.repos.find(r => path.resolve(r.path) === norm);
  }

  public register(repoPath: string, opts?: { purpose?: string; scope?: RepoScope; name?: string }): WorkspaceRepo {
    const full = path.resolve(this.primaryRoot, repoPath);
    const existing = this.find(full);
    if (existing) {
      if (opts?.purpose) existing.purpose = opts.purpose;
      if (opts?.scope) existing.scope = opts.scope;
      if (opts?.name) existing.name = opts.name;
      this.save();
      return existing;
    }
    const repo: WorkspaceRepo = {
      path: full,
      name: opts?.name || path.basename(full),
      purpose: opts?.purpose,
      branch: this.gitBranch(full),
      lastSynced: new Date().toISOString(),
      scope: opts?.scope || 'read', // joins read-only unless the user says otherwise
      registeredAt: new Date().toISOString(),
    };
    this.repos.push(repo);
    this.candidates = this.candidates.filter(c => path.resolve(c) !== full);
    this.save();
    return repo;
  }

  /** The ask-once "no": remembered in the manifest so the repo is never suggested again. */
  public ignore(repoPath: string): void {
    const full = path.resolve(this.primaryRoot, repoPath);
    const existing = this.find(full);
    if (existing) existing.scope = 'ignored';
    else this.repos.push({
      path: full, name: path.basename(full), scope: 'ignored', registeredAt: new Date().toISOString(),
    });
    this.candidates = this.candidates.filter(c => path.resolve(c) !== full);
    this.save();
  }

  public setScope(repoPath: string, scope: RepoScope): WorkspaceRepo | undefined {
    const r = this.find(path.resolve(this.primaryRoot, repoPath));
    if (r) { r.scope = scope; this.save(); }
    return r;
  }

  // ---- queries ---------------------------------------------------------------------------

  /** Registered, non-ignored repos (primary first). */
  public active(): WorkspaceRepo[] {
    return this.repos.filter(r => r.scope !== 'ignored');
  }

  /** Absolute path of the primary project repo (the always-writable one this session opened in). */
  public primaryPath(): string { return this.primaryRoot; }

  /** Fresh clones awaiting the one-time registration ask. */
  public pending(): string[] { return [...this.candidates]; }

  /**
   * Per-repo edit scoping. Purely additive: paths not under ANY registered repo keep today's
   * behavior (allowed). A write landing inside a repo registered read-only is refused with
   * guidance, so "adapt the pattern from repo Y into repo X" edits X, quotes Y — never the
   * reverse by accident.
   */
  public checkWrite(filePath: string): { allowed: boolean; reason?: string } {
    const full = path.resolve(filePath);
    // The INNERMOST containing repo governs scope: a read-only repo nested inside the
    // writable primary (a clone landed in a subdir) must win over the primary, or its
    // files would be writable because the primary's root prefix-matches first. Pick the
    // repo with the longest matching root, not the first in iteration order.
    let best: WorkspaceRepo | undefined;
    let bestLen = -1;
    for (const r of this.active()) {
      const root = path.resolve(r.path);
      if ((full === root || full.startsWith(root + path.sep)) && root.length > bestLen) {
        best = r;
        bestLen = root.length;
      }
    }
    if (!best || best.scope === 'write') return { allowed: true };
    return {
      allowed: false,
      reason: `${best.name} is registered READ-ONLY in this workspace (reference repo). ` +
        `Quote/adapt its code into a writable repo instead — or, if the user explicitly asked to modify ${best.name}, ` +
        `unlock it first with WorkspaceTool {action:"scope", path:"${best.path}", scope:"write"}.`,
    };
  }

  /** System-prompt block: the model's map of what repos are in context and what it may touch. */
  public contextBlock(): string {
    const act = this.active();
    if (act.length <= 1 && this.candidates.length === 0) return '';
    const lines = act.map(r => {
      const tag = r.scope === 'write' ? 'WRITABLE' : 'read-only';
      return `- ${r.name} (${tag}) at ${r.path}${r.branch ? ` [${r.branch}]` : ''}${r.purpose ? ` — ${r.purpose}` : ''}`;
    });
    let block = `### WORKSPACE (${act.length} repos)\nThis session spans multiple repos. Read/cross-reference freely across all of them; edit only WRITABLE ones. Use absolute paths when working outside the primary repo.\n${lines.join('\n')}`;
    if (this.candidates.length > 0) {
      block += `\nUNREGISTERED CLONES DETECTED: ${this.candidates.join(', ')} — ask the user ONCE whether to add each to the workspace, then call WorkspaceTool {action:"register"|"ignore"}.`;
    }
    return block;
  }

  /** Compact snapshot for the ui_snapshot wire (TUI status chip). */
  public snapshot(): { count: number; names: string[]; writable: number } {
    const act = this.active();
    return {
      count: act.length,
      names: act.map(r => r.name),
      writable: act.filter(r => r.scope === 'write').length,
    };
  }
}

let _ws: WorkspaceManager | null = null;

export function initWorkspace(primaryRoot: string): WorkspaceManager {
  _ws = new WorkspaceManager(primaryRoot);
  _ws.refresh();
  return _ws;
}

export function getWorkspace(): WorkspaceManager {
  if (!_ws) throw new Error('WorkspaceManager not initialized');
  return _ws;
}

/** Best-effort accessor for call sites that must never throw (tools, snapshots). */
export function tryGetWorkspace(): WorkspaceManager | null { return _ws; }
