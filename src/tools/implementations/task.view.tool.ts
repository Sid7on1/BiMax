import * as fs from 'fs';
import * as path from 'path';
import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { engineEvents } from '../../engine/events';

/**
 * TaskViewTool (backlog FL8): disposable tools inside a task. Some choices are faster to make by looking than by
 * reading a list — which photos to keep, which bank line matches which invoice, what 30 files should be called. The
 * task opens one of three views in the Bimax app, the person uses it, and what they chose comes back to the task:
 *
 * - `photos`: a contact sheet; the person picks some (or one).
 * - `match`: a matching table; the task proposes pairs, the person keeps, changes or clears each.
 * - `names`: a batch editor; the task proposes new names, the person edits them.
 *
 * The view travels as the JSON body of an ordinary question (so it reaches the ⌘2 bar and the approval popup like
 * any other), and the answer comes back as JSON. A front-end that cannot show it answers in words, and the tool says
 * so, so the task asks in plain words instead of guessing.
 */

export type TaskView =
  | { view: 'photos'; title: string; files: string[]; pick: 'some' | 'one' }
  | { view: 'match'; title: string; left: string[]; right: string[]; pairs: Array<{ left: number; right: number | null }> }
  | { view: 'names'; title: string; items: Array<{ path: string; name: string }> };

export const VIEW_MARKER = 'bimaxView';
const IMAGE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;
const MAX_ITEMS = 200;

const inside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** The view as the app receives it: files inside the task folder, lists bounded, pairs within range. */
export function checkView(raw: Record<string, unknown>, root: string, isFile: (file: string) => boolean): TaskView {
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 120) : 'Choose';
  const list = (value: unknown, what: string): unknown[] => {
    if (!Array.isArray(value) || !value.length) throw new Error(`Give \`${what}\`.`);
    if (value.length > MAX_ITEMS) throw new Error(`At most ${MAX_ITEMS} ${what} at a time.`);
    return value;
  };
  const file = (value: unknown): string => {
    const full = path.resolve(root, String(value ?? ''));
    if (!inside(root, full) || !isFile(full)) throw new Error(`${String(value)} is not a file in the task folder.`);
    return full;
  };
  if (raw.view === 'photos') {
    const files = list(raw.files, 'files').map(file);
    const notImages = files.filter((f) => !IMAGE.test(f));
    if (notImages.length) throw new Error(`A contact sheet shows pictures; these are not: ${notImages.slice(0, 3).map((f) => path.basename(f)).join(', ')}.`);
    return { view: 'photos', title, files, pick: raw.pick === 'one' ? 'one' : 'some' };
  }
  if (raw.view === 'match') {
    const left = list(raw.left, 'left').map((x) => String(x).slice(0, 200));
    const right = list(raw.right, 'right').map((x) => String(x).slice(0, 200));
    const pairs = (Array.isArray(raw.pairs) ? raw.pairs : []).flatMap((p: any) => {
      const l = Number(p?.left);
      const r = p?.right === null || p?.right === undefined ? null : Number(p?.right);
      return Number.isInteger(l) && l >= 0 && l < left.length && (r === null || (Number.isInteger(r) && r >= 0 && r < right.length)) ? [{ left: l, right: r }] : [];
    });
    return { view: 'match', title, left, right, pairs };
  }
  if (raw.view === 'names') {
    const items = list(raw.items, 'items').map((item: any) => {
      const name = String(item?.name ?? '').trim();
      if (!name || name.includes('/') || name.length > 255) throw new Error(`"${name}" is not a file name.`);
      return { path: file(item?.path), name };
    });
    return { view: 'names', title, items };
  }
  throw new Error('`view` must be "photos", "match" or "names".');
}

/** What the person's answer means for the task, in words it can act on. */
export function readAnswer(view: TaskView, answer: string): string {
  let value: any;
  try { value = JSON.parse(answer); } catch { value = null; }
  if (!value || typeof value !== 'object') {
    return /^cancel/i.test(answer.trim())
      ? 'The person closed the view without choosing. Do not assume a choice; ask what they want, or carry on without it.'
      : 'This view could not be shown here, so nothing was chosen. Ask the person in plain words instead.';
  }
  if (view.view === 'photos') {
    const picked = (Array.isArray(value.picked) ? value.picked : []).filter((p: unknown) => typeof p === 'string' && view.files.includes(p));
    return `The person picked ${picked.length} of ${view.files.length}${picked.length ? `:\n${picked.map((p: string) => `- ${p}`).join('\n')}` : '.'}`;
  }
  if (view.view === 'match') {
    const pairs = (Array.isArray(value.pairs) ? value.pairs : []) as Array<{ left?: number; right?: number | null }>;
    const lines = view.left.map((label, i) => {
      const pair = pairs.find((p) => p.left === i);
      const right = pair && typeof pair.right === 'number' && view.right[pair.right] !== undefined ? view.right[pair.right] : null;
      return `- ${label} → ${right ?? '(no match)'}`;
    });
    return `The person confirmed these matches:\n${lines.join('\n')}`;
  }
  const names = (Array.isArray(value.names) ? value.names : []) as Array<{ path?: string; name?: string }>;
  const lines = view.items.map((item) => {
    const edited = names.find((n) => n.path === item.path);
    const name = typeof edited?.name === 'string' && edited.name.trim() && !edited.name.includes('/') ? edited.name.trim() : item.name;
    return `- ${path.basename(item.path)} → ${name}`;
  });
  return `The person settled these names (to rename many files at once, propose them with OrganizePlanTool):\n${lines.join('\n')}`;
}

export const createTaskViewTool = (governor: IGovernor) => buildTool({
  name: 'TaskViewTool',
  description: `Open a small tool for the person when a choice is quicker to make by looking than by reading a list, and get back what they chose:
- view "photos": a contact sheet of \`files\` (pictures in the task folder); \`pick\` "some" or "one".
- view "match": a matching table between \`left\` and \`right\` (lists of short labels, e.g. bank lines and invoices), with your proposed \`pairs\` [{left: index, right: index}] (leave right out for no match); they keep, change or clear each.
- view "names": a batch editor of \`items\` [{path, name}] with your proposed new names; they edit them.
Give a \`title\` that says what to decide. Use it for decisions over many items; for one yes/no question, ask in words.`,
  isDestructive: false,
  isConcurrencySafe: false,
  schema: {
    type: 'object',
    properties: {
      view: { type: 'string', enum: ['photos', 'match', 'names'] },
      title: { type: 'string', description: 'What the person decides.' },
      files: { type: 'array', items: { type: 'string' }, description: 'For photos: the pictures.' },
      pick: { type: 'string', enum: ['some', 'one'], description: 'For photos: how many to pick.' },
      left: { type: 'array', items: { type: 'string' }, description: 'For match: the items to match.' },
      right: { type: 'array', items: { type: 'string' }, description: 'For match: what they can match.' },
      pairs: { type: 'array', items: { type: 'object', properties: { left: { type: 'number' }, right: { type: 'number', description: 'Leave out for no match.' } }, required: ['left'] }, description: 'For match: your proposed pairs.' },
      items: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' } } }, description: 'For names: each file and its proposed new name.' },
    },
    required: ['view'],
  },
  execute: async (args: Record<string, unknown>, context?: any) => {
    const root = path.resolve(process.env.BIMAX_THREAD_ROOT || context?.cwd || process.cwd());
    const isFile = (file: string): boolean => { try { return fs.statSync(file).isFile(); } catch { return false; } };
    const view = checkView(args, root, isFile);
    const answer = await new Promise<string>((resolve) => {
      // The ordinary question event (as AskUserTool uses), with the view as its body; the host sends it as a request.
      engineEvents.emit('veto_prompt', view.title, ['Cancel'], resolve, true, false, JSON.stringify({ [VIEW_MARKER]: view }));
    });
    return readAnswer(view, answer);
  },
}, governor);
