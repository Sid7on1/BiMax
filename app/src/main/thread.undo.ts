import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where a thread's engine keeps its own state, and how the file changes a thread made are undone.
 *
 * A ⌘2 thread's engine writes its sessions, logs, ledger and undo journal under Bimax's app data
 * (`thread-state/<folder id>/`), never into the folder it works in — the Desktop used to collect `.bimax` and
 * `.breakglass`. A project opened in the main window keeps them in the repository, where they belong.
 */
export type ThreadOrigin = 'quick' | 'project' | undefined;

export function threadStateRoot(userData: string, root: string, origin: ThreadOrigin): string {
  if (origin === 'project') return root;
  const id = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(userData, 'thread-state', id);
}

/** BIMAX_STATE_DIR for a thread's engine (src/utils/state.dir.ts); nothing for a project, which keeps its own. */
export function threadStateEnvironment(userData: string, root: string, origin: ThreadOrigin): Record<string, string> {
  return origin === 'project' ? {} : { BIMAX_STATE_DIR: threadStateRoot(userData, root, origin) };
}

type JournalOp =
  | { op: 'move'; from: string; to: string }
  | { op: 'create'; path: string }
  | { op: 'restore'; path: string; backup: string }
  | { op: 'trash'; path: string; trashPath: string | null };

interface Change { type: 'change'; id: string; at: number; title: string; tool: string; ops: JournalOp[] }

export interface BinOps {
  /** Move an item to the Bin; returns where it landed, or null when that is unknown. */
  moveToBin(target: string): Promise<string | null>;
  /** Put an item from the Bin back at its original path. */
  restoreFromBin(trashPath: string, original: string): Promise<void>;
}

export function journalFile(stateRoot: string): string {
  return path.join(stateRoot, '.bimax', 'undo', 'journal.jsonl');
}

/** Changes not yet undone, oldest first. The engine writes `change` lines; this module appends `undo` lines. */
function pendingChanges(stateRoot: string): Change[] {
  let text = '';
  try { text = fsSync.readFileSync(journalFile(stateRoot), 'utf8'); } catch { return []; }
  const changes: Change[] = [];
  const undone = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type === 'change' && typeof record.id === 'string' && typeof record.title === 'string' && Array.isArray(record.ops)) changes.push(record);
    else if (record?.type === 'undo' && typeof record.id === 'string') undone.add(record.id);
  }
  return changes.filter((change) => !undone.has(change.id));
}

/** A change a thread made and has not undone, and whether its effect is on disk now (backlog F6). */
export interface MadeChange { title: string; at: number; inPlace: boolean | null }

const MAX_COMPARE_BYTES = 16 * 1024 * 1024;

/** Whether one recorded step's effect is on disk now: true, false, or null when that cannot be told. */
function stepInPlace(op: JournalOp): boolean | null {
  const there = (p: string): boolean => { try { fsSync.lstatSync(p); return true; } catch { return false; } };
  if (op.op === 'move') return there(op.to) ? (there(op.from) ? null : true) : false;
  if (op.op === 'create') return there(op.path);
  if (op.op === 'trash') return !there(op.path);
  // A replaced file: in place when it differs from the copy taken before it was replaced.
  try {
    const now = fsSync.statSync(op.path);
    const before = fsSync.statSync(op.backup);
    if (now.size !== before.size) return true;
    if (now.size > MAX_COMPARE_BYTES) return null;
    return !fsSync.readFileSync(op.path).equals(fsSync.readFileSync(op.backup));
  } catch {
    return there(op.path) ? null : false;
  }
}

/**
 * The changes a thread made from `since` on that were not undone, each checked against the disk (backlog F6). The
 * journal is written just BEFORE a change runs, so an entry alone does not prove it happened — a command that failed
 * still left one; the check says whether its effect is there now.
 */
export function changesSince(stateRoot: string, since: number): MadeChange[] {
  return pendingChanges(stateRoot).filter((change) => change.at >= since).map((change) => {
    const steps = change.ops.map(stepInPlace);
    const inPlace = steps.every((s) => s === true) ? true : steps.some((s) => s === false) ? false : null;
    return { title: change.title, at: change.at, inPlace };
  });
}

/** The newest change that can still be undone, for the "↶ Undo" button. */
export function lastUndoable(stateRoot: string): { id: string; title: string; at: number } | null {
  const pending = pendingChanges(stateRoot);
  const last = pending[pending.length - 1];
  return last ? { id: last.id, title: last.title, at: last.at } : null;
}

const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false);
const inside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Where Finder's delete can put an item: the user's Bin, or iCloud Drive's Bin for an item in an iCloud Drive
 * folder — which includes the Desktop and Documents when they sync. MEASURED 2026-09-14: a thread deleted a file
 * on the synced Desktop, Finder reported it in ~/Library/Mobile Documents/.Trash, and undo refused it.
 */
const binRoots = (): string[] => [
  path.join(os.homedir(), '.Trash'),
  path.join(os.homedir(), 'Library', 'Mobile Documents', '.Trash'),
];

/**
 * Reverse the newest change. Every path is checked before anything moves — it must lie inside the thread's
 * folder, the thread's backups or the Bin — and so is every conflict, so a refused undo changes nothing and
 * says why. A replaced file's current version goes to the Bin before the saved copy is put back.
 */
export async function undoLast(stateRoot: string, threadRoot: string, bin: BinOps): Promise<{ title: string }> {
  return undoChange(stateRoot, threadRoot, bin);
}

/**
 * Reverse one change (the newest when no id is given). An older change is undone on its own only when no later change
 * touched the same files (FL4); otherwise "Undo back to here" reverses the later ones first.
 */
export async function undoChange(stateRoot: string, threadRoot: string, bin: BinOps, id?: string): Promise<{ title: string }> {
  const pending = pendingChanges(stateRoot);
  const change = id ? pending.find((c) => c.id === id) : pending[pending.length - 1];
  if (!change) throw new Error(id ? 'That change was already undone.' : 'There is nothing to undo in this thread.');
  const later = laterDependents(pending, change.id);
  if (later.length) throw new Error(`“${change.title}” can’t be undone on its own: ${later.length} later change${later.length === 1 ? '' : 's'} used the same files. Choose “Undo back to here” to reverse ${later.length === 1 ? 'it' : 'them'} too.`);
  const root = await fs.realpath(threadRoot).catch(() => path.resolve(threadRoot));
  const bins = binRoots();
  const backups = path.join(stateRoot, '.bimax', 'undo', 'backups');
  const ops = [...change.ops].reverse();

  for (const op of ops) {
    const paths = op.op === 'move' ? [op.from, op.to] : [op.path];
    for (const p of paths) {
      if (typeof p !== 'string' || !inside(root, p)) throw new Error(`Undo refused: ${p} is outside this thread’s folder.`);
    }
    if (op.op === 'restore' && (typeof op.backup !== 'string' || !inside(backups, op.backup))) throw new Error('Undo refused: the saved copy is not in this thread’s undo folder.');
    if (op.op === 'trash' && op.trashPath && !bins.some((bin) => inside(bin, op.trashPath!))) throw new Error('Undo refused: that item is not in the Bin.');
  }
  // Checked step by step, as the undo will run: a reversed move frees its place for the next one, so a chain or a swap
  // (an organize plan, FL2) can be undone, while a place someone else filled since still refuses.
  const after = new Map<string, boolean>();
  const present = async (p: string): Promise<boolean> => after.get(p) ?? await exists(p);
  for (const op of ops) {
    if (op.op === 'move') {
      const moved = await present(op.to);
      if (moved && await present(op.from)) {
        throw new Error(`Can’t undo “${change.title}”: something named “${path.basename(op.from)}” is already in ${path.dirname(op.from)}.`);
      }
      if (moved) { after.set(op.to, false); after.set(op.from, true); }
    }
    if (op.op === 'trash' && await exists(op.path)) {
      throw new Error(`Can’t undo “${change.title}”: “${path.basename(op.path)}” already exists again.`);
    }
    if (op.op === 'trash' && !op.trashPath) {
      throw new Error(`“${path.basename(op.path)}” is in the Bin, but its place there is unknown. Open the Bin and choose Put Back.`);
    }
  }

  for (const op of ops) {
    if (op.op === 'move') {
      if (!(await exists(op.to))) continue; // the move never ran, or was already reversed by hand
      await fs.mkdir(path.dirname(op.from), { recursive: true });
      await fs.rename(op.to, op.from);
    } else if (op.op === 'create') {
      if (await exists(op.path)) await bin.moveToBin(op.path);
    } else if (op.op === 'restore') {
      if (!(await exists(op.backup))) continue;
      if (await exists(op.path)) await bin.moveToBin(op.path);
      await fs.mkdir(path.dirname(op.path), { recursive: true });
      await fs.copyFile(op.backup, op.path);
    } else {
      await bin.restoreFromBin(op.trashPath!, op.path);
    }
  }
  await fs.appendFile(journalFile(stateRoot), JSON.stringify({ type: 'undo', id: change.id, at: Date.now() }) + '\n', 'utf8');
  return { title: change.title };
}

// ── Change history and selective undo (backlog FL4) ─────────────────────────────────────────────

/** Every path a change touched. Two changes that share one depend on each other's order. */
function touched(change: Change): Set<string> {
  const paths = new Set<string>();
  for (const op of change.ops) {
    if (op.op === 'move') { paths.add(path.resolve(op.from)); paths.add(path.resolve(op.to)); } else paths.add(path.resolve(op.path));
  }
  return paths;
}

/** The later pending changes that build on this one (directly, or through each other): they must be undone first. */
export function laterDependents(pending: readonly Change[], id: string): string[] {
  const index = pending.findIndex((c) => c.id === id);
  if (index < 0) return [];
  const reach = touched(pending[index]!);
  const out: string[] = [];
  for (const later of pending.slice(index + 1)) {
    const paths = touched(later);
    if ([...paths].some((p) => reach.has(p))) { out.push(later.id); for (const p of paths) reach.add(p); }
  }
  return out;
}

export type Reversibility = 'full' | 'partial';
export interface HistoryEntry {
  id: string; title: string; at: number;
  /** "partial": an item went to the Bin at a place Bimax could not see, so Put Back is by hand. */
  reversibility: Reversibility;
  /** Whether its effect is on disk now (F6's check). */
  inPlace: boolean | null;
  /** Later changes that must be undone first; 0 means it can be undone on its own. */
  dependents: number;
  /** Files it produced that were changed after it outside Bimax's journal — by the person or a command; on undo their version goes to the Bin, never lost. */
  editedSince: string[];
}

/** The thread's change history, newest first, each with how honestly it can be undone (FL4). */
export function changeHistory(stateRoot: string): HistoryEntry[] {
  const pending = pendingChanges(stateRoot);
  return pending.map((change, index) => {
    const steps = change.ops.map(stepInPlace);
    // Bimax's own later changes to a file are its dependents, not someone else's edits.
    const laterByBimax = new Set(pending.slice(index + 1).flatMap((later) => [...touched(later)]));
    // A moved file carries later edits back with it; a created or replaced file's current version goes to the Bin.
    const produced = change.ops.flatMap((op) => (op.op === 'create' || op.op === 'restore' ? [op.path] : []));
    const editedSince = produced
      .filter((p) => !laterByBimax.has(path.resolve(p)))
      .filter((p) => { try { return fsSync.statSync(p).mtimeMs > change.at + 2000; } catch { return false; } })
      .map((p) => path.basename(p));
    return {
      id: change.id, title: change.title, at: change.at,
      reversibility: change.ops.some((op) => op.op === 'trash' && !op.trashPath) ? 'partial' as const : 'full' as const,
      inPlace: steps.every((x) => x === true) ? true : steps.some((x) => x === false) ? false : null,
      dependents: laterDependents(pending, change.id).length,
      editedSince,
    };
  }).reverse();
}

/** "Undo back to here": reverse every change from the newest down to this one, stopping at the first that refuses. */
export async function undoBackTo(stateRoot: string, threadRoot: string, bin: BinOps, id: string): Promise<{ undone: string[]; stoppedAt?: string }> {
  const undone: string[] = [];
  if (!pendingChanges(stateRoot).some((c) => c.id === id)) throw new Error('That change was already undone.');
  for (;;) {
    const pending = pendingChanges(stateRoot);
    const newest = pending[pending.length - 1];
    if (!newest) break;
    try {
      undone.push((await undoChange(stateRoot, threadRoot, bin, newest.id)).title);
    } catch (error) {
      return { undone, stoppedAt: (error as Error).message };
    }
    if (newest.id === id) break;
  }
  return { undone };
}
