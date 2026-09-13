import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { stateDir } from '../utils/state.dir';
import type { ChangePlan } from './thread.changes';

/**
 * The undo journal of a Bimax thread: every file change it makes, recorded just before it happens, in the form
 * the desktop app needs to reverse it ("↶ Undo" in the ⌘2 bar; app/src/main/thread.undo.ts).
 *
 * Append-only JSON lines in `<state>/.bimax/undo/journal.jsonl`. A file about to be replaced is copied to
 * `<state>/.bimax/undo/backups/<entry>/` first. The app appends `{ "type": "undo" }` lines when it reverses an
 * entry. Nothing is recorded outside a desktop thread (BIMAX_THREAD_ROOT).
 */
export type JournalOp =
  | { op: 'move'; from: string; to: string }
  | { op: 'create'; path: string }
  | { op: 'restore'; path: string; backup: string }
  | { op: 'trash'; path: string; trashPath: string | null };

export interface JournalEntry { type: 'change'; id: string; at: number; title: string; tool: string; ops: JournalOp[] }

/** Files larger than this are not copied before being replaced; that part of the change cannot be undone. */
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

export function journalDir(root = process.env.BIMAX_THREAD_ROOT): string {
  return path.join(stateDir('.bimax', root), 'undo');
}

async function append(entry: JournalEntry): Promise<void> {
  const dir = journalDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, 'journal.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
}

/** Record a move, copy, creation or replacement before it runs. Bin moves are recorded once they have happened. */
export async function recordBeforeChange(plan: ChangePlan, tool: string): Promise<JournalEntry | null> {
  if (!process.env.BIMAX_THREAD_ROOT || !plan.undoable || plan.kind === 'trash') return null;
  const id = randomUUID();
  const ops: JournalOp[] = [];
  for (const move of plan.moves) ops.push({ op: 'move', from: move.from, to: move.to });
  for (const created of plan.creates) ops.push({ op: 'create', path: created });
  let n = 0;
  for (const target of plan.overwrites) {
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > MAX_BACKUP_BYTES) continue;
      const backup = path.join(journalDir(), 'backups', id, `${n++}-${path.basename(target)}`);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.copyFile(target, backup);
      ops.push({ op: 'restore', path: target, backup });
    } catch { /* unreadable: there is nothing to restore, so no step for it */ }
  }
  if (!ops.length) return null;
  const entry: JournalEntry = { type: 'change', id, at: Date.now(), title: plan.title, tool, ops };
  await append(entry);
  return entry;
}

/** Record items the Bimax app moved to the Bin, with where each one landed. */
export async function recordTrash(title: string, tool: string, moved: Array<{ path: string; trashPath: string | null }>): Promise<void> {
  if (!process.env.BIMAX_THREAD_ROOT || !moved.length) return;
  await append({ type: 'change', id: randomUUID(), at: Date.now(), title, tool, ops: moved.map((m) => ({ op: 'trash', path: m.path, trashPath: m.trashPath })) });
}
