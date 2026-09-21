import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { engineEvents } from '../../engine/events';

/**
 * OrganizePlanTool (backlog FL2): before organizing many files, propose the whole plan instead of moving them one by
 * one. The Bimax app shows it as a preview of the new folder tree that the person can rearrange — dragging one invoice
 * elsewhere offers "Put all Invoices here?" — and applies the approved moves itself, in one step that ↶ Undo reverses
 * as a whole. Nothing moves until the person applies it.
 *
 * Registered only in a desktop thread (BIMAX_THREAD_ROOT), where an app is there to show the preview.
 */

export interface PlannedMove { from: string; to: string; group: string }
export const MAX_PLAN_MOVES = 2000;

const inside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** A group label for a move the model did not label: its kind of file ("PDF files"), so similar files still travel together. */
export function defaultGroup(file: string): string {
  const ext = path.extname(file).slice(1).toUpperCase();
  return ext ? `${ext} files` : 'Other files';
}

/**
 * The plan as the app receives it: absolute paths inside the folder, existing files only, no two moves to the same
 * place, nothing moved onto a file that stays, and no move that changes nothing. Every problem is named together.
 */
export function checkPlan(raw: unknown, root: string, exists: (file: string) => 'file' | 'dir' | null): PlannedMove[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Give `moves`: one entry per file, each with `from` and `to`.');
  if (raw.length > MAX_PLAN_MOVES) throw new Error(`A plan can move at most ${MAX_PLAN_MOVES} files.`);
  const folder = path.resolve(root);
  const problems: string[] = [];
  const moves: PlannedMove[] = [];
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const entry of raw as Array<Record<string, unknown>>) {
    const fromRaw = typeof entry?.from === 'string' ? entry.from.trim() : '';
    const toRaw = typeof entry?.to === 'string' ? entry.to.trim() : '';
    if (!fromRaw || !toRaw) { problems.push('every move needs `from` and `to`'); continue; }
    const from = path.resolve(folder, fromRaw);
    let to = path.resolve(folder, toRaw);
    // "to" naming a folder (ending in / or an existing folder) keeps the file's name.
    if (toRaw.endsWith('/') || exists(to) === 'dir') to = path.join(to, path.basename(from));
    if (!inside(folder, from) || !inside(folder, to)) { problems.push(`${fromRaw} → ${toRaw} leaves the task folder`); continue; }
    if (from === to) continue;
    if (exists(from) !== 'file') { problems.push(`${fromRaw} is not a file here`); continue; }
    if (sources.has(from)) { problems.push(`${fromRaw} is moved twice`); continue; }
    if (targets.has(to.toLowerCase())) { problems.push(`two files would become ${path.relative(folder, to)}`); continue; }
    sources.add(from);
    targets.add(to.toLowerCase());
    const group = typeof entry.group === 'string' && entry.group.trim() ? entry.group.trim().slice(0, 60) : defaultGroup(from);
    moves.push({ from, to, group });
  }
  for (const move of moves) {
    if (exists(move.to) && !sources.has(move.to)) problems.push(`${path.relative(folder, move.to)} already exists`);
  }
  if (problems.length) throw new Error(`The plan has problems: ${[...new Set(problems)].slice(0, 8).join('; ')}.`);
  if (!moves.length) throw new Error('Nothing in the plan changes where a file is.');
  return moves;
}

export const createOrganizePlanTool = (governor: IGovernor) => buildTool({
  name: 'OrganizePlanTool',
  description: `Propose how to organize files, instead of moving them one by one, when a task moves or renames more than a few files. The person sees the plan as a preview of the new folder tree, can rearrange it, and applies it; the approved moves are then made in one step that ↶ Undo reverses as a whole.
- \`moves\`: every file to move, with \`from\` and \`to\` (paths in the task folder; \`to\` may be a folder ending in "/"), and \`group\`: a short label for what kind of file it is ("Invoices", "Photos 2024"), used to move similar files together.
- \`title\`: what the plan does, e.g. "Sort Downloads by type and year".
After calling it, end your turn and say the plan is waiting for their review; do not move the files yourself.`,
  isDestructive: false,
  isConcurrencySafe: false,
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What the plan does.' },
      moves: {
        type: 'array',
        description: 'Every file to move.',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string', description: 'The new path, or a folder ending in "/".' },
            group: { type: 'string', description: 'What kind of file this is, e.g. "Invoices".' },
          },
          required: ['from', 'to'],
        },
      },
    },
    required: ['moves'],
  },
  execute: async (args: { title?: unknown; moves?: unknown }) => {
    const root = process.env.BIMAX_THREAD_ROOT;
    if (!root) throw new Error('A plan needs the Bimax app to show it, and this engine is not running in it. Move the files directly.');
    const exists = (file: string): 'file' | 'dir' | null => {
      try { const stat = fs.statSync(file); return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : null; } catch { return null; }
    };
    const moves = checkPlan(args.moves, root, exists);
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 120) : `Organize ${moves.length} files`;
    const plan = { id: randomUUID().slice(0, 8), title, root: path.resolve(root), moves };
    engineEvents.emit('organize_plan', plan);
    const groups = new Set(moves.map((move) => move.group)).size;
    return `The plan (${moves.length} moves in ${groups} group${groups === 1 ? '' : 's'}) is shown to the person as a preview they can rearrange. End your turn now and say it is waiting for their review; nothing moves until they apply it.`;
  },
}, governor);
