import { stateDir } from '../utils/state.dir';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils';

export interface Checkpoint {
  id: string;
  label: string;
  timestamp: number;
  /** Commit object capturing the full working tree (tracked + untracked) at snapshot time. */
  commit: string;
  /** HEAD at snapshot time, for context. */
  head: string;
  /** true when created automatically before a turn rather than by the user. */
  auto: boolean;
}

/**
 * Time Machine. Each checkpoint is a real git commit object that captures the
 * entire working tree — including untracked files — built in a throwaway index so
 * neither the working tree nor the user's real index/HEAD is touched. Rewinding
 * resets the working tree to that commit's tree. The commit lives only in the
 * object database (never on a branch), so history stays clean.
 */
export class CheckpointManager {
  private readonly dir = stateDir('.breakglass');
  private readonly metaFile = path.join(this.dir, 'checkpoints.json');
  private readonly tmpIndex = path.join(this.dir, 'checkpoint-index');
  private readonly maxAuto = 20;

  private git(args: string[], extraEnv?: Record<string, string>): string {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: { ...process.env, ...extraEnv },
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  }

  isGitRepo(): boolean {
    try {
      return this.git(['rev-parse', '--is-inside-work-tree']) === 'true';
    } catch {
      return false;
    }
  }

  private load(): Checkpoint[] {
    try {
      return JSON.parse(fs.readFileSync(this.metaFile, 'utf-8'));
    } catch {
      return [];
    }
  }

  private save(list: Checkpoint[]) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.metaFile, JSON.stringify(list, null, 2));
  }

  list(): Checkpoint[] {
    return this.load().sort((a, b) => b.timestamp - a.timestamp);
  }

  get(id: string): Checkpoint | undefined {
    return this.load().find(c => c.id === id || c.id.startsWith(id));
  }

  /**
   * Snapshots the working tree. Returns null when not in a git repo.
   */
  create(label: string, auto = false): Checkpoint | null {
    if (!this.isGitRepo()) return null;
    fs.mkdirSync(this.dir, { recursive: true });

    const head = (() => {
      try { return this.git(['rev-parse', 'HEAD']); } catch { return ''; }
    })();

    // Build the snapshot in a private index so the real index is never touched.
    try { fs.rmSync(this.tmpIndex, { force: true }); } catch { /* fresh */ }
    const env = { GIT_INDEX_FILE: this.tmpIndex };
    if (head) this.git(['read-tree', head], env);
    this.git(['add', '-A'], env);
    const tree = this.git(['write-tree'], env);
    const parents = head ? ['-p', head] : [];
    const commit = this.git(['commit-tree', tree, ...parents, '-m', `bimax-checkpoint: ${label}`]);
    try { fs.rmSync(this.tmpIndex, { force: true }); } catch { /* best effort */ }

    const cp: Checkpoint = {
      id: commit.slice(0, 12),
      label,
      timestamp: Date.now(),
      commit,
      head,
      auto,
    };

    let list = this.load();
    list.push(cp);
    // Cap automatic checkpoints to a ring buffer; keep all manual ones.
    const autos = list.filter(c => c.auto).sort((a, b) => a.timestamp - b.timestamp);
    if (autos.length > this.maxAuto) {
      const drop = new Set(autos.slice(0, autos.length - this.maxAuto).map(c => c.id));
      list = list.filter(c => !drop.has(c.id));
    }
    this.save(list);
    Logger.info(`[CheckpointManager] Created checkpoint ${cp.id} (${label})`);
    return cp;
  }

  /**
   * Restores the working tree to a checkpoint. Takes a safety checkpoint of the
   * current state first so the rewind is itself reversible. Returns the safety
   * checkpoint id, or null on failure.
   */
  restore(id: string): { restored: Checkpoint; safety: Checkpoint | null } | null {
    const cp = this.get(id);
    if (!cp || !this.isGitRepo()) return null;

    const safety = this.create(`before rewind to ${cp.id}`, true);

    // --reset discards index state; -u updates the working tree to match the tree,
    // restoring deleted files and reverting tracked changes. Untracked files created
    // after the checkpoint are left in place (conservative, never surprise-deletes).
    this.git(['read-tree', '--reset', '-u', cp.commit]);
    Logger.info(`[CheckpointManager] Restored working tree to checkpoint ${cp.id}`);
    return { restored: cp, safety };
  }
}

export const globalCheckpointManager = new CheckpointManager();
