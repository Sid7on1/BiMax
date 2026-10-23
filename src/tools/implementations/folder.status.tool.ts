import * as path from 'path';
import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { engineEvents } from '../../engine/events';

/**
 * FolderStatusTool (backlog FL1, part 2: folders with an outcome). A folder can have a stated outcome — "keep this
 * folder ready for my accountant: every receipt a PDF named by date, in its month's folder". A task working there
 * reports, file by file, whether each one now meets it ("ready") or needs the person ("needs-you", with what they
 * must do). The Bimax app keeps that as the folder's queue: what is ready, and what needs you.
 *
 * The verdicts come from this tool, never from the wording of an answer, so a weak model's prose cannot put a file
 * in the wrong list. Without an outcome (BIMAX_FOLDER_OUTCOME unset) the tool refuses: there is nothing to report
 * against, and no app would keep the queue.
 */

export type FolderItemState = 'ready' | 'needs-you';
export interface FolderStatusItem { path: string; state: FolderItemState; reason?: string }

export const MAX_STATUS_ITEMS = 200;

/** The report as the app receives it: paths absolute and inside the task's folder, a reason for every needs-you. */
export function checkStatusItems(raw: unknown, root: string): FolderStatusItem[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Give `items`: one entry per file, each with `path` and `state`.');
  if (raw.length > MAX_STATUS_ITEMS) throw new Error(`Report at most ${MAX_STATUS_ITEMS} files at a time.`);
  const folder = path.resolve(root);
  const out: FolderStatusItem[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    const file = typeof entry?.path === 'string' ? entry.path.trim() : '';
    if (!file) throw new Error('Every item needs a `path`.');
    const full = path.resolve(folder, file);
    const rel = path.relative(folder, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${file} is not inside this task's folder.`);
    if (entry.state !== 'ready' && entry.state !== 'needs-you') throw new Error(`The state of ${file} must be "ready" or "needs-you".`);
    const reason = typeof entry.reason === 'string' ? entry.reason.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    if (entry.state === 'needs-you' && !reason) throw new Error(`Say what the person must do about ${file}: give a \`reason\`.`);
    out.push({ path: full, state: entry.state, ...(reason ? { reason } : {}) });
  }
  return out;
}

export const createFolderStatusTool = (governor: IGovernor) => buildTool({
  name: 'FolderStatusTool',
  description: `Report where files stand against this folder's outcome (the goal the person set for the folder). For each file you handled or checked, give its path and state:
- "ready": it now meets the outcome.
- "needs-you": it cannot meet the outcome without the person, and \`reason\` says exactly what they must do (e.g. "no date on the receipt — which month is it?").
Use the file's path AFTER any rename or move. Only report files inside the task folder. Call this once near the end of the task, with every file.`,
  isDestructive: false,
  isConcurrencySafe: false,
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'One entry per file.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The file, relative to the task folder or absolute.' },
            state: { type: 'string', enum: ['ready', 'needs-you'] },
            reason: { type: 'string', description: 'For needs-you: what the person must do.' },
          },
          required: ['path', 'state'],
        },
      },
    },
    required: ['items'],
  },
  execute: async (args: { items?: unknown }, context?: any) => {
    const outcome = process.env.BIMAX_FOLDER_OUTCOME?.trim();
    if (!outcome) throw new Error('This folder has no outcome set, so there is nothing to report against. The person sets one from the ⌘2 bar’s ⋯ menu.');
    const items = checkStatusItems(args.items, process.env.BIMAX_THREAD_ROOT || context?.cwd || process.cwd());
    engineEvents.emit('folder_status', { items });
    const waiting = items.filter((item) => item.state === 'needs-you').length;
    return `Recorded ${items.length} file${items.length === 1 ? '' : 's'}: ${items.length - waiting} ready, ${waiting} needing the person. They appear in the folder's queue.`;
  },
}, governor);
