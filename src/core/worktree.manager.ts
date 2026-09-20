import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';

/**
 * Git-worktree isolation for parallel sub-agents (the Cursor 2.0 / Claude Code
 * `isolation: "worktree"` pattern): each isolated agent gets its own checkout of the repo on its
 * own branch under .bimax/worktrees/<taskId>, so parallel agents can never clobber each other's
 * edits. Worktrees share the object store with the main checkout — creating one is near-instant
 * and costs no re-clone.
 *
 * Lifecycle: create → agent works inside it → settle. Settle removes the worktree AND its branch
 * when the agent changed nothing (no dirty files, no commits); otherwise both are kept and the
 * caller surfaces the path + branch so the user (or the orchestrator) can review/merge.
 *
 * Once distinct from evolution/worktree.manager.ts, which served the swarm/evolution waves (async
 * ops serialized because they fired in Promise.all, commit/merge helpers, .evolution_worktrees/).
 * That file and everything that drove it were archived on 2026-09-19 — see
 * docs/product-reset/58 — so this is now the only worktree manager. It is the spawn-path
 * primitive: synchronous
 * (execFileSync blocks the event loop, so calls can never interleave with each other), falls back
 * to unisolated instead of throwing, and detects "did the agent change anything" against the base
 * commit. git arguments are always argv arrays — never shell strings — since taskIds pass through.
 */

export interface WorktreeInfo {
  /** Absolute path of the worktree checkout the agent should use as cwd. */
  path: string;
  /** The branch created for this worktree (bimax/sub-…). */
  branch: string;
  /** Commit the worktree was created from — the baseline for "did anything change?". */
  baseCommit: string;
  /** The main checkout the worktree belongs to (where `git worktree` bookkeeping lives). */
  repoRoot: string;
}

export interface WorktreeSettle {
  /** True when the worktree was deleted (agent changed nothing). */
  removed: boolean;
  /** True when edits or commits were found and the worktree/branch were kept. */
  changed: boolean;
  /** Human-readable note for the sub-agent result ('' when removed cleanly). */
  note: string;
}

export interface WorktreeIntegration {
  commit: string;
  paths: string[];
  integratedAt: number;
  cleanedUp: boolean;
}

/** Exact paths changed from the worktree's clean base. Throws when inspection is unavailable. */
export function inspectWorktreeChanges(info: WorktreeInfo): string[] {
  const committed = git(info.path, 'diff', '--name-only', `${info.baseCommit}...HEAD`).split('\n');
  // Do not parse porcelain through git(): its intentional trim removes the leading status column
  // (` M src/a.ts` -> `M src/a.ts`) and silently chopped the first character from paths. Diff and
  // ls-files return path-only records, covering staged/unstaged tracked files plus untracked files.
  const dirty = git(info.path, 'diff', '--name-only', 'HEAD').split('\n');
  const untracked = git(info.path, 'ls-files', '--others', '--exclude-standard').split('\n');
  return [...new Set([...committed, ...dirty, ...untracked].map(value => value.trim()).filter(Boolean))].sort();
}

/** Legacy best-effort wrapper; coordinated outcome assignments use the fail-closed inspector. */
export function worktreeChangedPaths(info: WorktreeInfo): string[] {
  try { return inspectWorktreeChanges(info); } catch { return []; }
}

/** Validate that a checkpointed worktree still exists and points at the recorded branch/repo. */
export function validateWorktree(info: WorktreeInfo): boolean {
  try {
    const actualRoot = fs.realpathSync(git(info.path, 'rev-parse', '--show-toplevel'));
    const expectedRoot = fs.realpathSync(info.path);
    const actualRepo = fs.realpathSync(git(info.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    const expectedRepo = fs.realpathSync(git(info.repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    const branch = git(info.path, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(info.path, 'cat-file', '-e', `${info.baseCommit}^{commit}`);
    return actualRoot === expectedRoot && actualRepo === expectedRepo && branch === info.branch;
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function normalizedPaths(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))].sort();
}

function scopeTokens(scope = ''): string[] {
  return scope.split(/[\s,;]+/).map(value => value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean);
}

function pathAllowed(relative: string, scope = ''): boolean {
  const tokens = scopeTokens(scope);
  if (tokens.some(token => token === '*' || token === '.' || token.toLowerCase() === 'repo')) return true;
  return tokens.some(token => relative === token || relative.startsWith(`${token}/`));
}

function parentDirtyPaths(repoRoot: string): string[] {
  return normalizedPaths([
    ...git(repoRoot, 'diff', '--name-only', 'HEAD').split('\n'),
    ...git(repoRoot, 'ls-files', '--others', '--exclude-standard').split('\n'),
  ]);
}

/**
 * Integrate one reviewed isolated assignment into its parent checkout. The operation fails closed:
 * the worktree manifest must still match the receipt, every path must fit the assignment scope,
 * and neither committed nor uncommitted parent work may overlap those paths. Merge conflicts are
 * aborted and the worktree is retained for review. Cleanup happens only after byte-for-byte parent
 * verification, so an integration receipt can never describe work that was merely attempted.
 */
export function integrateWorktree(
  info: WorktreeInfo,
  expectedPaths: string[],
  scope: string,
  taskId: string,
): WorktreeIntegration {
  const expected = normalizedPaths(expectedPaths);
  if (expected.length === 0) throw new Error(`Task ${taskId} has no changed files to integrate.`);
  const current = inspectWorktreeChanges(info);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error(`Task ${taskId}'s worktree changed after settlement; review it again before integration.`);
  }
  const outside = expected.filter(relative => !pathAllowed(relative, scope));
  if (outside.length) throw new Error(`Task ${taskId} changed files outside its scope (${scope || 'unscoped'}): ${outside.join(', ')}`);

  const dirtyOverlap = parentDirtyPaths(info.repoRoot).filter(relative => expected.includes(relative));
  if (dirtyOverlap.length) throw new Error(`Parent checkout has uncommitted changes overlapping task ${taskId}: ${dirtyOverlap.join(', ')}`);
  const parentCommittedOverlap = normalizedPaths(git(info.repoRoot, 'diff', '--name-only', `${info.baseCommit}...HEAD`).split('\n'))
    .filter(relative => expected.includes(relative));
  if (parentCommittedOverlap.length) {
    throw new Error(`Parent branch changed task ${taskId}'s files since assignment: ${parentCommittedOverlap.join(', ')}`);
  }

  // Capture dirty worker edits in an engine-authored commit. Local -c identity avoids mutating the
  // user's repository configuration while still working in fresh repositories.
  if (git(info.path, 'status', '--porcelain')) {
    git(info.path, 'add', '--all');
    git(info.path, '-c', 'user.name=Bimax', '-c', 'user.email=bimax@local', 'commit', '-m', `bimax: integrate ${taskId}`);
  }
  const workerCommit = git(info.path, 'rev-parse', 'HEAD');
  try {
    git(info.repoRoot, '-c', 'user.name=Bimax', '-c', 'user.email=bimax@local', 'merge', '--no-ff', '--no-edit', info.branch);
  } catch (error: any) {
    try { git(info.repoRoot, 'merge', '--abort'); } catch { /* merge may have failed before starting */ }
    throw new Error(`Task ${taskId} could not be merged safely: ${error?.message?.split('\n')[0] || error}`, { cause: error });
  }

  const mismatches = expected.filter(relative => {
    const parentFile = path.join(info.repoRoot, relative);
    const workerFile = path.join(info.path, relative);
    const parentExists = fs.existsSync(parentFile);
    const workerExists = fs.existsSync(workerFile);
    if (parentExists !== workerExists) return true;
    if (!parentExists) return false;
    try { return !fs.readFileSync(parentFile).equals(fs.readFileSync(workerFile)); }
    catch { return true; }
  });
  if (mismatches.length) {
    throw new Error(`Task ${taskId} merged but parent verification differs for: ${mismatches.join(', ')}`);
  }

  let cleanedUp = true;
  try {
    git(info.repoRoot, 'worktree', 'remove', '--force', info.path);
    git(info.repoRoot, 'branch', '-D', info.branch);
  } catch (error: any) {
    cleanedUp = false;
    Logger.warn(`[Worktree] Integrated task ${taskId}, but cleanup failed: ${error?.message?.split('\n')[0]}`);
  }
  return { commit: workerCommit, paths: expected, integratedAt: Date.now(), cleanedUp };
}

/**
 * Create an isolated worktree for a task. Returns null (with a warning) when the cwd isn't a git
 * repo or creation fails — callers fall back to running the sub-agent unisolated, which is the
 * pre-worktree behavior, never a hard failure.
 */
export function createWorktree(cwd: string, taskId: string): WorktreeInfo | null {
  try {
    const repoRoot = git(cwd, 'rev-parse', '--show-toplevel');
    const baseCommit = git(repoRoot, 'rev-parse', 'HEAD');
    // taskId is "subagent-<uuid>" — the uuid tail keeps branch/dir names short but unique.
    const shortId = taskId.replace(/^subagent-/, '').slice(0, 8) || taskId;
    const branch = `bimax/sub-${shortId}`;
    const wtPath = path.join(repoRoot, '.bimax', 'worktrees', shortId);
    git(repoRoot, 'worktree', 'add', '-b', branch, wtPath, 'HEAD');
    Logger.info(`[Worktree] Created ${wtPath} (branch ${branch}) for ${taskId}`);
    return { path: wtPath, branch, baseCommit, repoRoot };
  } catch (e: any) {
    Logger.warn(`[Worktree] Could not create worktree for ${taskId}: ${e?.message?.split('\n')[0]} — running unisolated.`);
    return null;
  }
}

/**
 * Settle a worktree after its agent finished: remove it (and its branch) when nothing changed,
 * keep both and describe them when something did.
 */
export function settleWorktree(info: WorktreeInfo): WorktreeSettle {
  let changed: boolean;
  try {
    const dirty = git(info.path, 'status', '--porcelain');
    const head = git(info.path, 'rev-parse', 'HEAD');
    changed = dirty.length > 0 || head !== info.baseCommit;
  } catch {
    // Worktree already gone (agent or user deleted it) — treat as settled.
    try { git(info.repoRoot, 'worktree', 'prune'); } catch { /* best-effort */ }
    return { removed: true, changed: false, note: '' };
  }

  if (changed) {
    return {
      removed: false,
      changed: true,
      note: `Worktree kept — the sub-agent made changes in ${info.path} on branch ${info.branch}. Review and merge (or discard with \`git worktree remove --force ${info.path}\`).`,
    };
  }

  try {
    git(info.repoRoot, 'worktree', 'remove', '--force', info.path);
    git(info.repoRoot, 'branch', '-D', info.branch);
    Logger.info(`[Worktree] Removed unchanged worktree ${info.path}`);
  } catch (e: any) {
    Logger.warn(`[Worktree] Cleanup of ${info.path} failed: ${e?.message?.split('\n')[0]}`);
  }
  return { removed: true, changed: false, note: '' };
}
