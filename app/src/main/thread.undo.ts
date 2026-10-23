import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where a Bimax Thread's engine keeps its state, and how its file changes are undone.
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
  | { op: 'trash'; path: string; trashPath: string | null }
  | { op: 'unprotected'; path: string; reason: string };

interface Change { type: 'change'; id: string; at: number; title: string; tool: string; ops: JournalOp[]; completed?: Set<number> }

function validOp(value: unknown): value is JournalOp {
  if (!value || typeof value !== 'object') return false;
  const op = value as Record<string, unknown>;
  const absolute = (p: unknown): p is string => typeof p === 'string' && path.isAbsolute(p);
  if (op.op === 'move') return absolute(op.from) && absolute(op.to);
  if (!absolute(op.path)) return false;
  if (op.op === 'create') return true;
  if (op.op === 'restore') return absolute(op.backup);
  if (op.op === 'trash') return op.trashPath === null || absolute(op.trashPath);
  return op.op === 'unprotected' && typeof op.reason === 'string';
}

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
  let text: string;
  try { text = fsSync.readFileSync(journalFile(stateRoot), 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const changes: Change[] = [];
  const byId = new Map<string, Change>();
  const undone = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type === 'change') {
      if (typeof record.id !== 'string' || typeof record.title !== 'string' || !Array.isArray(record.ops) || !record.ops.every(validOp) || byId.has(record.id)) {
        throw new Error('Undo refused: a change in the journal is malformed or has a duplicate ID.');
      }
      const change: Change = { ...record, completed: new Set<number>() };
      changes.push(change); byId.set(change.id, change);
    } else if (record?.type === 'undo-step' && typeof record.id === 'string') {
      const change = byId.get(record.id);
      if (change && Number.isSafeInteger(record.index) && record.index >= 0 && record.index < change.ops.length) change.completed!.add(record.index);
      else throw new Error('Undo refused: a step receipt in the journal is malformed.');
    }
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
  if (op.op === 'unprotected') return null;
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

/**
 * The files a thread made or changed since `since` and that are still there: created, replaced, or the new place of
 * a move — never a trashed one (God's Land stage 3: a task's results come back to the notch's shelf). Newest last,
 * each once.
 */
export function filesChangedSince(stateRoot: string, since: number): string[] {
  const files = new Set<string>();
  for (const change of pendingChanges(stateRoot).filter((c) => c.at >= since)) {
    for (const op of change.ops) {
      const file = op.op === 'move' ? op.to : op.op === 'create' || op.op === 'restore' || op.op === 'unprotected' ? op.path : null;
      if (!file) continue;
      files.delete(file);
      files.add(file);
    }
  }
  return [...files].filter((file) => { try { return fsSync.statSync(file).isFile(); } catch { return false; } });
}

/** The newest change that can still be undone, for the "↶ Undo" button. */
export function lastUndoable(stateRoot: string): { id: string; title: string; at: number } | null {
  const pending = pendingChanges(stateRoot);
  const last = pending[pending.length - 1];
  return last ? { id: last.id, title: last.title, at: last.at } : null;
}

const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, (error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const inside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, path.resolve(child));
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/** Resolve missing destinations through their closest existing parent; never disguise an inaccessible parent. */
async function resolvedPath(p: string): Promise<string> {
  let cursor = path.resolve(p);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(cursor), ...missing.reverse()); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling link is not a missing directory that mkdir may safely recreate.
      try {
        if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Undo refused: a path has a dangling symlink.', { cause: error });
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor)); cursor = parent;
    }
  }
}

async function assertContained(root: string, p: string, followLeaf: boolean, label: string): Promise<void> {
  const resolved = followLeaf ? await resolvedPath(p) : path.join(await resolvedPath(path.dirname(p)), path.basename(p));
  if (!inside(root, resolved)) throw new Error(`Undo refused: ${p} is outside ${label}.`);
}

const activeUndo = new Set<string>();
async function withUndoLock<T>(stateRoot: string, run: (canonicalState: string) => Promise<T>): Promise<T> {
  const key = await fs.realpath(stateRoot);
  if (activeUndo.has(key)) throw new Error('An undo is already in progress for this Bimax Thread journal.');
  activeUndo.add(key);
  try {
    await assertContained(key, journalFile(key), true, 'this Bimax Thread’s state folder');
    if (await exists(journalFile(key)) && (await fs.lstat(journalFile(key))).isSymbolicLink()) throw new Error('Undo refused: the journal is a symlink.');
    return await run(key);
  } finally { activeUndo.delete(key); }
}

interface FileProof { sha256: string; mode: number; size: number }
const MAX_RESTORE_BYTES = 512 * 1024 * 1024;

/** Fixed-size read buffer: verification of a large backup never allocates the whole file. */
async function fileProof(p: string): Promise<FileProof> {
  const handle = await fs.open(p, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_RESTORE_BYTES) throw new Error(`Undo refused: ${p} is not a supported regular saved file.`);
    const buffer = Buffer.alloc(64 * 1024);
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) throw new Error('Undo refused: a file changed while its bytes were being verified.');
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat();
    const atPath = await fs.stat(p);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        after.mode !== before.mode || atPath.dev !== before.dev || atPath.ino !== before.ino) throw new Error('Undo refused: a file changed while its bytes were being verified.');
    return { sha256: hash.digest('hex'), mode: before.mode & 0o7777, size: before.size };
  } finally { await handle.close(); }
}

async function verifyFile(p: string, expected: FileProof): Promise<void> {
  if ((await fs.lstat(p)).isSymbolicLink()) throw new Error('Undo refused: a verified file became a symlink.');
  const actual = await fileProof(p);
  if (actual.sha256 !== expected.sha256 || actual.mode !== expected.mode || actual.size !== expected.size) throw new Error('Undo failed: restored bytes or permissions do not match the saved copy.');
}

/**
 * Where Finder's delete can put an item: the user's Bin, or iCloud Drive's Bin for an item in an iCloud Drive
 * folder — which includes the Desktop and Documents when they sync. MEASURED 2026-09-14: a thread deleted a file
 * on the synced Desktop, Finder reported it in ~/Library/Mobile Documents/.Trash, and undo refused it.
 */
const binRoots = (): string[] => [
  path.join(os.homedir(), '.Trash'),
  path.join(os.homedir(), 'Library', 'Mobile Documents', '.Trash'),
];

async function assertBinPath(p: string): Promise<void> {
  const root = binRoots().find(candidate => inside(candidate, p));
  if (!root) throw new Error('Undo refused: that item is not in the Bin.');
  try {
    const canonicalRoot = path.join(await resolvedPath(path.dirname(root)), path.basename(root));
    await assertContained(canonicalRoot, p, true, 'the Bin');
    if ((await fs.lstat(p)).isSymbolicLink()) throw new Error('Undo refused: a Bin item is a symlink.');
  } catch (error) {
    // Finder may inspect the Bin when this process cannot. Never expand the lexical Bin scope.
    if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

async function assertTarget(root: string, stateRoot: string, p: string, allowLeafLink: boolean): Promise<void> {
  await assertContained(root, p, false, 'this Bimax Thread’s folder');
  const resolved = path.join(await resolvedPath(path.dirname(p)), path.basename(p));
  const undoDir = path.dirname(journalFile(stateRoot));
  if (resolved === undoDir || inside(undoDir, resolved) || inside(resolved, undoDir)) throw new Error('Undo refused: a change touches its own journal or backups.');
  if (!allowLeafLink && await exists(p) && (await fs.lstat(p)).isSymbolicLink()) throw new Error('Undo refused: a Bin or replacement target is a symlink.');
}

/**
 * Reverse the newest change. Every path is checked before anything moves — it must lie inside the thread's
 * folder, the thread's backups or the Bin. Preflight refusals make no file changes; an execution failure leaves
 * verified step receipts so a retry can resume. A replaced file's current version goes to the Bin only after its
 * replacement has been staged and checked.
 */
export async function undoLast(stateRoot: string, threadRoot: string, bin: BinOps): Promise<{ title: string }> {
  return undoChange(stateRoot, threadRoot, bin);
}

/**
 * Reverse one change (the newest when no id is given). An older change is undone on its own only when no later change
 * touched the same files (FL4); otherwise "Undo back to here" reverses the later ones first.
 */
export async function undoChange(stateRoot: string, threadRoot: string, bin: BinOps, id?: string): Promise<{ title: string }> {
  return withUndoLock(stateRoot, canonicalState => undoChangeUnlocked(canonicalState, threadRoot, bin, id));
}

async function undoChangeUnlocked(stateRoot: string, threadRoot: string, bin: BinOps, id?: string): Promise<{ title: string }> {
  const pending = pendingChanges(stateRoot);
  const change = id ? pending.find((c) => c.id === id) : pending[pending.length - 1];
  if (!change) throw new Error(id ? 'That change was already undone.' : 'There is nothing to undo in this thread.');
  const later = laterDependents(pending, change.id);
  if (later.length) throw new Error(`“${change.title}” can’t be undone on its own: ${later.length} later change${later.length === 1 ? '' : 's'} used the same files. Choose “Undo back to here” to reverse ${later.length === 1 ? 'it' : 'them'} too.`);
  const root = await fs.realpath(threadRoot);
  const backups = path.join(stateRoot, '.bimax', 'undo', 'backups');
  const completed = change.completed ?? new Set<number>();
  const ops = change.ops.map((op, index) => ({ op, index })).reverse().filter(step => !completed.has(step.index));
  const proofs = new Map<number, FileProof>();
  const binProofs = new Map<number, FileProof>();
  const binKinds = new Map<number, 'file' | 'directory'>();

  for (const { op, index } of ops) {
    const paths = op.op === 'move' ? [op.from, op.to] : [op.path];
    for (const p of paths) await assertTarget(root, stateRoot, p, op.op === 'move');
    if (op.op === 'unprotected') throw new Error(`Undo refused: ${op.path} has no saved copy (${op.reason}).`);
    if (op.op === 'restore') {
      await assertContained(backups, op.backup, true, 'this Bimax Thread’s undo backup folder');
      try {
        if ((await fs.lstat(op.backup)).isSymbolicLink()) throw new Error('the saved copy is a symlink');
        proofs.set(index, await fileProof(op.backup));
      } catch (error) { throw new Error(`Undo refused: the saved copy for ${op.path} is unavailable (${(error as Error).message}).`, { cause: error }); }
    }
    if (op.op === 'trash') {
      if (!op.trashPath) throw new Error(`“${path.basename(op.path)}” is in the Bin, but its place there is unknown. Open the Bin and choose Put Back.`);
      try {
        await assertBinPath(op.trashPath);
        const source = await fs.lstat(op.trashPath);
        if (!source.isFile() && !source.isDirectory()) throw new Error('Undo refused: the Bin item has an unsupported type.');
        binKinds.set(index, source.isFile() ? 'file' : 'directory');
        if (source.isFile()) binProofs.set(index, await fileProof(op.trashPath));
      } catch (error) {
        if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
  }
  // Checked step by step, as the undo will run: a reversed move frees its place for the next one, so a chain or a swap
  // (an organize plan, FL2) can be undone, while a place someone else filled since still refuses.
  const after = new Map<string, boolean>();
  const present = async (p: string): Promise<boolean> => after.get(p) ?? await exists(p);
  for (const { op } of ops) {
    if (op.op === 'move') {
      const moved = await present(op.to);
      if (moved && await present(op.from)) {
        throw new Error(`Can’t undo “${change.title}”: something named “${path.basename(op.from)}” is already in ${path.dirname(op.from)}.`);
      }
      if (!moved && !(await present(op.from))) throw new Error('Undo refused: neither end of a recorded move exists.');
      if (moved) { after.set(op.to, false); after.set(op.from, true); }
    }
    if (op.op === 'trash' && await exists(op.path)) {
      throw new Error(`Can’t undo “${change.title}”: “${path.basename(op.path)}” already exists again.`);
    }
  }

  try {
    for (const { op, index } of ops) {
      // Repeat containment checks just before the step; preflight alone cannot detect a changed parent.
      for (const p of op.op === 'move' ? [op.from, op.to] : [op.path]) await assertTarget(root, stateRoot, p, op.op === 'move');
      if (op.op === 'move') {
        if (await exists(op.to)) {
          if (await exists(op.from)) throw new Error(`Undo refused: ${op.from} already exists.`);
          const before = await fs.lstat(op.to);
          await fs.mkdir(path.dirname(op.from), { recursive: true });
          await fs.rename(op.to, op.from);
          const after = await fs.lstat(op.from);
          if (await exists(op.to) || before.dev !== after.dev || before.ino !== after.ino) throw new Error('Undo failed: the moved item was not restored at its original path.');
        } else if (!(await exists(op.from))) throw new Error('Undo failed: neither end of the move exists.');
      } else if (op.op === 'create') {
        if (await exists(op.path)) await bin.moveToBin(op.path);
        if (await exists(op.path)) throw new Error('Undo failed: the created item is still present after the Bin operation.');
      } else if (op.op === 'restore') {
        const expected = proofs.get(index)!;
        await assertContained(backups, op.backup, true, 'this Bimax Thread’s undo backup folder');
        await fs.mkdir(path.dirname(op.path), { recursive: true });
        const staged = path.join(path.dirname(op.path), `.bimax-undo-${randomUUID()}`);
        try {
          await fs.copyFile(op.backup, staged, fsSync.constants.COPYFILE_EXCL);
          await fs.chmod(staged, expected.mode);
          await verifyFile(staged, expected);
          await assertTarget(root, stateRoot, op.path, false);
          if (await exists(op.path)) await bin.moveToBin(op.path);
          if (await exists(op.path)) throw new Error('Undo failed: the current version is still present after the Bin operation.');
          await fs.rename(staged, op.path);
          await verifyFile(op.path, expected);
        } finally { await fs.rm(staged, { force: true }).catch(() => {}); }
      } else if (op.op === 'trash') {
        await assertBinPath(op.trashPath!);
        if (await exists(op.path)) throw new Error(`Undo refused: ${op.path} already exists again.`);
        await bin.restoreFromBin(op.trashPath!, op.path);
        if (!(await exists(op.path))) throw new Error('Undo failed: the Bin operation produced no restored item.');
        const expected = binProofs.get(index);
        if (expected) {
          await verifyFile(op.path, expected);
        }
        if (binKinds.has(index)) {
          const restored = await fs.lstat(op.path);
          if (binKinds.get(index) === 'file' ? !restored.isFile() : !restored.isDirectory()) throw new Error('Undo failed: the restored item has the wrong type.');
          if (await exists(op.trashPath!)) throw new Error('Undo failed: the original item is still in the Bin.');
        }
      }
      // A step is recorded only after its independently checked postcondition. Retry skips it.
      await fs.appendFile(journalFile(stateRoot), JSON.stringify({ type: 'undo-step', id: change.id, index, at: Date.now() }) + '\n', 'utf8');
      completed.add(index);
    }
  } catch (error) {
    throw new Error(`Undo stopped after ${completed.size}/${change.ops.length} verified steps: ${(error as Error).message}. The change remains pending; retry resumes the remaining steps.`, { cause: error });
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
function usableBackup(stateRoot: string, backup: string): boolean {
  try {
    const stat = fsSync.lstatSync(backup);
    return !stat.isSymbolicLink() && stat.isFile() && stat.size <= MAX_RESTORE_BYTES &&
      inside(path.join(fsSync.realpathSync(stateRoot), '.bimax', 'undo', 'backups'), fsSync.realpathSync(backup));
  } catch { return false; }
}
export interface HistoryEntry {
  id: string; title: string; at: number;
  /** "partial": a remaining step lacks an accessible saved copy or known Bin location. */
  reversibility: Reversibility;
  /** Whether its effect is on disk now (F6's check). */
  inPlace: boolean | null;
  /** Later changes that must be undone first; 0 means it can be undone on its own. */
  dependents: number;
  /** Files it produced that were changed after it outside Bimax's journal — by the person or a command; on undo their version goes to the Bin, never lost. */
  editedSince: string[];
  /** Verified steps already reversed by an interrupted undo. */
  completedSteps: number;
  totalSteps: number;
}

/** The thread's change history, newest first, each with how honestly it can be undone (FL4). */
export function changeHistory(stateRoot: string): HistoryEntry[] {
  const pending = pendingChanges(stateRoot);
  const laterByBimax = new Set<string>();
  return [...pending].reverse().map((change) => {
    const steps = change.ops.map(stepInPlace);
    // Bimax's own later changes to a file are its dependents, not someone else's edits.
    // A moved file carries later edits back with it; a created or replaced file's current version goes to the Bin.
    const produced = change.ops.flatMap((op) => (op.op === 'create' || op.op === 'restore' ? [op.path] : []));
    const editedSince = produced
      .filter((p) => !laterByBimax.has(path.resolve(p)))
      .filter((p) => { try { return fsSync.statSync(p).mtimeMs > change.at + 2000; } catch { return false; } })
      .map((p) => path.basename(p));
    for (const p of touched(change)) laterByBimax.add(p);
    return {
      id: change.id, title: change.title, at: change.at,
      reversibility: change.ops.some((op, i) => !change.completed?.has(i) && (
        op.op === 'unprotected' || op.op === 'trash' && !op.trashPath || op.op === 'restore' && !usableBackup(stateRoot, op.backup)
      )) ? 'partial' as const : 'full' as const,
      inPlace: steps.every((x) => x === true) ? true : steps.some((x) => x === false) ? false : null,
      dependents: laterDependents(pending, change.id).length,
      editedSince,
      completedSteps: change.completed?.size ?? 0, totalSteps: change.ops.length,
    };
  });
}

/** "Undo back to here": reverse every change from the newest down to this one, stopping at the first that refuses. */
export async function undoBackTo(stateRoot: string, threadRoot: string, bin: BinOps, id: string): Promise<{ undone: string[]; stoppedAt?: string }> {
  return withUndoLock(stateRoot, canonicalState => undoBackToUnlocked(canonicalState, threadRoot, bin, id));
}

async function undoBackToUnlocked(stateRoot: string, threadRoot: string, bin: BinOps, id: string): Promise<{ undone: string[]; stoppedAt?: string }> {
  const undone: string[] = [];
  if (!pendingChanges(stateRoot).some((c) => c.id === id)) throw new Error('That change was already undone.');
  for (;;) {
    const pending = pendingChanges(stateRoot);
    const newest = pending[pending.length - 1];
    if (!newest) break;
    try {
      undone.push((await undoChangeUnlocked(stateRoot, threadRoot, bin, newest.id)).title);
    } catch (error) {
      return { undone, stoppedAt: (error as Error).message };
    }
    if (newest.id === id) break;
  }
  return { undone };
}

/** The files a thread's changes from `since` on produced or moved (FL6: a skill's sample files and input kinds). */
export function touchedSince(stateRoot: string, since: number): string[] {
  const out = new Set<string>();
  for (const change of pendingChanges(stateRoot)) {
    if (change.at < since) continue;
    for (const op of change.ops) {
      const file = op.op === 'move' ? op.to : op.op === 'trash' ? null : op.path;
      if (file) out.add(file);
    }
  }
  return [...out];
}
