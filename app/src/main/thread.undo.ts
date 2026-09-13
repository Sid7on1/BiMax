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
 * Reverse the newest change. Every path is checked before anything moves — it must lie inside the thread's
 * folder, the thread's backups or the Bin — and so is every conflict, so a refused undo changes nothing and
 * says why. A replaced file's current version goes to the Bin before the saved copy is put back.
 */
export async function undoLast(stateRoot: string, threadRoot: string, bin: BinOps): Promise<{ title: string }> {
  const pending = pendingChanges(stateRoot);
  const change = pending[pending.length - 1];
  if (!change) throw new Error('There is nothing to undo in this thread.');
  const root = await fs.realpath(threadRoot).catch(() => path.resolve(threadRoot));
  const trashRoot = path.join(os.homedir(), '.Trash');
  const backups = path.join(stateRoot, '.bimax', 'undo', 'backups');
  const ops = [...change.ops].reverse();

  for (const op of ops) {
    const paths = op.op === 'move' ? [op.from, op.to] : [op.path];
    for (const p of paths) {
      if (typeof p !== 'string' || !inside(root, p)) throw new Error(`Undo refused: ${p} is outside this thread’s folder.`);
    }
    if (op.op === 'restore' && (typeof op.backup !== 'string' || !inside(backups, op.backup))) throw new Error('Undo refused: the saved copy is not in this thread’s undo folder.');
    if (op.op === 'trash' && op.trashPath && !inside(trashRoot, op.trashPath)) throw new Error('Undo refused: that item is not in the Bin.');
  }
  for (const op of ops) {
    if (op.op === 'move' && await exists(op.to) && await exists(op.from)) {
      throw new Error(`Can’t undo “${change.title}”: something named “${path.basename(op.from)}” is already in ${path.dirname(op.from)}.`);
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
