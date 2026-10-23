import * as fs from 'fs';
import * as path from 'path';
import type { ChangePlan } from '../tools/thread.changes';

/**
 * Task grants (backlog N13): "Allow for this task" on a thread's approval card.
 *
 * A thread asked afresh for every existing-file write and every mutating command — the fifth edit to the same file
 * as much as the first. A grant lets the user answer once for an explicitly described change, and it is reused only
 * while the target, the scope and the risk stay the same:
 * - editing one existing file: that exact file, nothing else;
 * - moving, renaming, copying or creating items, or moving them to the Bin: only when every item stays inside the
 *   thread's folder AND the undo journal can reverse it; a change that cannot be undone never gets a grant;
 * - a command the thread cannot describe: that exact command text, in that exact folder.
 * Anything else — another file, another folder, another command, an irreversible change — asks as before.
 *
 * A grant is checked AFTER every floor in the governor's thread path (folder scope, forbidden paths, plan mode,
 * permanent deletes, the user's protected paths), so it can never let through what a floor refuses; it only saves
 * the question. Grants live in the engine, so they end with the task, and `/grants clear` ends them sooner.
 */

export interface TaskGrant {
  key: string;
  /** What it allows, in words, e.g. edits to “math.js”. */
  label: string;
  at: number;
  uses: number;
}

const quote = (name: string): string => `“${name}”`;
const MAX_COMMAND_CHARS = 300;

function real(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function inside(root: string, p: string): boolean {
  const rel = path.relative(real(root), real(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The grant this change could be answered with, or null when it may only be allowed one time. */
export function grantFor(taskType: string, plan: ChangePlan | null, payload: any, root: string, cwd: string): { key: string; label: string } | null {
  if (!plan) return null;
  const folder = quote(path.basename(real(root)) || root);
  if (plan.kind === 'write') {
    if (plan.overwrites.length !== 1 || !inside(root, plan.overwrites[0])) return null;
    const file = plan.overwrites[0];
    return { key: `write:${real(file)}`, label: `edits to ${quote(path.basename(file))}` };
  }
  if (plan.kind === 'command') {
    const command = String(payload?.command ?? '').trim();
    if (taskType !== 'OS_COMMAND' || !command || command.length > MAX_COMMAND_CHARS || /[\r\n]/.test(command)) return null;
    return { key: `command:${real(cwd)}:${command}`, label: `running \`${command}\` in ${quote(path.basename(real(cwd)) || cwd)}` };
  }
  // The rest are the journal's own shapes; a grant covers them only while every item stays in the folder and the
  // change can be put back.
  const paths = [...plan.moves.flatMap((m) => [m.from, m.to]), ...plan.trash, ...plan.creates, ...plan.overwrites];
  if (!plan.undoable || !paths.length || !paths.every((p) => inside(root, p))) return null;
  const labels: Record<string, string> = {
    move: `moving and renaming items inside ${folder} (each can be undone)`,
    copy: `copying items inside ${folder} (each can be undone)`,
    create: `creating files and folders inside ${folder}`,
    trash: `moving items inside ${folder} to the Bin (each can be put back)`,
  };
  const label = labels[plan.kind];
  return label ? { key: `${plan.kind}:${real(root)}`, label } : null;
}

export class TaskGrants {
  private grants = new Map<string, TaskGrant>();

  /** Whether `key` was granted; counts the use. */
  use(key: string): TaskGrant | null {
    const grant = this.grants.get(key);
    if (grant) grant.uses++;
    return grant ?? null;
  }

  add(grant: { key: string; label: string }): void {
    if (!this.grants.has(grant.key)) this.grants.set(grant.key, { ...grant, at: Date.now(), uses: 0 });
  }

  list(): TaskGrant[] { return [...this.grants.values()]; }

  clear(): number {
    const n = this.grants.size;
    this.grants.clear();
    return n;
  }
}

/** The engine's grants: one task per engine, so one set. */
export const taskGrants = new TaskGrants();

/** Grants end with the task: a new task in this engine (`clear`), or a switch to another saved one (`session_changed`). */
export function endGrantsWithTask(events: { on(event: string, fn: () => void): unknown }, grants: TaskGrants = taskGrants): void {
  events.on('clear', () => grants.clear());
  events.on('session_changed', () => grants.clear());
}
