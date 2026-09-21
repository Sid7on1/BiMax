import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { engineEvents } from '../../engine/events';

/**
 * WakeTool (backlog F4): one way for a task to be resumed by an event — a time, a change in a folder, a CI result, or
 * the user's answer — instead of the user coming back to prod it. Folder triggers, Guardian and living deliverables are
 * all "resume this task when X happens", so it is built once.
 *
 * The engine only registers the request. The Bimax app keeps it with the task, waits for the event — an idle task's
 * engine is shut down to save memory, so the engine cannot be the one waiting — and then sends the task a message
 * starting "[Wake]" that says what happened; the saved conversation comes back with it (F2). Without the app
 * (BIMAX_WAKES unset) the tool refuses rather than promise a wake nothing will deliver.
 */

export type WakeKind = 'at' | 'folder' | 'ci' | 'answer';

export interface WakeRequest {
  id: string;
  kind: WakeKind;
  /** What the task should do when woken, in the model's words; repeated back in the wake message. */
  reason: string;
  createdAt: number;
  /** kind 'at': when, in epoch ms. */
  at?: number;
  /** kind 'folder': the folder to watch, and which new or changed files count. */
  path?: string;
  match?: 'any' | 'pdf' | 'image' | 'document';
  /** kind 'ci': the repository folder and the commit whose CI runs to wait for. */
  sha?: string;
  /** kind 'answer': the question the user is asked. */
  question?: string;
}

export const MAX_WAKE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

/** How the tool learns the commit and whether the GitHub CLI can answer. A test seam replaces it. */
export interface WakeProbe {
  head(cwd: string): Promise<string | null>;
  ghReady(cwd: string): Promise<string | null>;
}

const run = (file: string, args: string[], cwd: string): Promise<{ ok: boolean; out: string }> => new Promise((resolve) => {
  execFile(file, args, { cwd, timeout: 8_000 }, (error, stdout, stderr) => resolve({ ok: !error, out: `${stdout}${stderr}`.trim() }));
});

let probe: WakeProbe = {
  async head(cwd) {
    const result = await run('git', ['rev-parse', 'HEAD'], cwd);
    return result.ok && /^[0-9a-f]{40}$/.test(result.out) ? result.out : null;
  },
  async ghReady(cwd) {
    const result = await run('gh', ['auth', 'status'], cwd);
    if (result.ok) return null;
    return /ENOENT|not found/i.test(result.out) || !result.out
      ? 'the GitHub CLI (gh) is not installed'
      : 'the GitHub CLI (gh) is not signed in — run `gh auth login`';
  },
};

/** Test seam: do not use in production code. */
export function __setWakeProbe(value: WakeProbe): void { probe = value; }

/** "14:30" today, or tomorrow once today's has passed; or an ISO date-time. Null when it cannot be read. */
export function parseWakeTime(text: string, now: number): number | null {
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (clock) {
    const [hours, minutes] = [Number(clock[1]), Number(clock[2])];
    if (hours > 23 || minutes > 59) return null;
    const when = new Date(now);
    when.setHours(hours, minutes, 0, 0);
    if (when.getTime() <= now) when.setDate(when.getDate() + 1);
    return when.getTime();
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function describeWake(wake: Pick<WakeRequest, 'kind' | 'at' | 'path' | 'sha' | 'question'>): string {
  if (wake.kind === 'at') return `at ${new Date(wake.at ?? 0).toLocaleString()}`;
  if (wake.kind === 'folder') return `when files change in ${wake.path}`;
  if (wake.kind === 'ci') return `when CI finishes for commit ${String(wake.sha).slice(0, 7)}`;
  return `when the user answers: ${wake.question}`;
}

export const createWakeTool = (governor: IGovernor) => buildTool({
  name: 'WakeTool',
  description: `Resume this task later, when something happens, instead of waiting in the conversation. After registering a wake, end your turn: the task continues with a message starting "[Wake]" that says what happened.

- action "at": at a time — \`time\` as "14:30" (the next one) or an ISO date-time, or \`minutes\` from now.
- action "folder": when files change in a folder (\`path\`, default the task folder; \`match\` any/pdf/image/document).
- action "ci": when the GitHub CI runs for the current commit finish (needs the gh CLI).
- action "answer": when the user answers \`question\`.
- action "cancel": drop a wake by \`id\`, or all of them with id "all".
Always give \`reason\`: what to do when woken. Wakes are at most ${MAX_WAKE_DAYS} days ahead and fire once.`,
  isDestructive: false,
  isConcurrencySafe: false,
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['at', 'folder', 'ci', 'answer', 'cancel'], description: 'What to wait for, or "cancel".' },
      time: { type: 'string', description: 'For "at": "HH:MM" or an ISO date-time.' },
      minutes: { type: 'number', description: 'For "at": minutes from now, instead of time.' },
      path: { type: 'string', description: 'For "folder": the folder to watch; default the task folder.' },
      match: { type: 'string', enum: ['any', 'pdf', 'image', 'document'], description: 'For "folder": which files count (default any).' },
      question: { type: 'string', description: 'For "answer": the question the user is asked.' },
      reason: { type: 'string', description: 'What to do when woken.' },
      id: { type: 'string', description: 'For "cancel": the wake id, or "all".' },
    },
    required: ['action'],
  },
  execute: async (args: { action: WakeKind | 'cancel'; time?: string; minutes?: number; path?: string; match?: WakeRequest['match']; question?: string; reason?: string; id?: string }, context?: any) => {
    if (process.env.BIMAX_WAKES !== '1') {
      throw new Error('Wake-ups are delivered by the Bimax app, and this engine is not running in it, so nothing would wake the task.');
    }
    const tell = (content: string): void => {
      try { engineEvents.emit('message', { id: `wake-${Date.now()}`, role: 'system', level: 'info', content, timestamp: new Date() }); } catch { /* best-effort */ }
    };
    if (args.action === 'cancel') {
      const id = String(args.id ?? '').trim();
      if (!id) throw new Error('Give the id of the wake to cancel, or "all".');
      engineEvents.emit('wake_cancel', { id });
      return id === 'all' ? 'Every wake for this task is cancelled.' : `Wake ${id} is cancelled.`;
    }
    const reason = String(args.reason ?? '').trim();
    if (!reason) throw new Error('Give a reason: what the task should do when it is woken.');
    const now = Date.now();
    const cwd = context?.cwd || process.cwd();
    const wake: WakeRequest = { id: randomUUID().slice(0, 8), kind: args.action, reason: reason.slice(0, 500), createdAt: now };

    if (args.action === 'at') {
      const at = typeof args.minutes === 'number' && args.minutes > 0 ? now + args.minutes * 60_000
        : args.time ? parseWakeTime(args.time, now) : null;
      if (at === null) throw new Error('Give a time as "HH:MM" or an ISO date-time, or minutes from now.');
      if (at <= now) throw new Error('That time has already passed.');
      if (at - now > MAX_WAKE_DAYS * DAY) throw new Error(`A wake can be at most ${MAX_WAKE_DAYS} days ahead.`);
      wake.at = at;
    } else if (args.action === 'folder') {
      const folder = path.resolve(cwd, args.path || '.');
      let stat: fs.Stats | null = null;
      try { stat = fs.statSync(folder); } catch { /* reported below */ }
      if (!stat?.isDirectory()) throw new Error(`${folder} is not a folder.`);
      wake.path = folder;
      wake.match = args.match ?? 'any';
    } else if (args.action === 'ci') {
      const sha = await probe.head(cwd);
      if (!sha) throw new Error('This folder is not a git repository with a commit, so there is no CI run to wait for.');
      const problem = await probe.ghReady(cwd);
      if (problem) throw new Error(`CI results come from GitHub, and ${problem}.`);
      wake.sha = sha;
      wake.path = cwd;
    } else if (args.action === 'answer') {
      const question = String(args.question ?? '').trim();
      if (!question) throw new Error('Give the question the user should answer.');
      wake.question = question.slice(0, 500);
    } else {
      throw new Error(`Unknown action "${String(args.action)}".`);
    }

    engineEvents.emit('wake_request', wake);
    tell(`This task will wake ${describeWake(wake)}, to: ${wake.reason}`);
    return `Registered wake ${wake.id}: ${describeWake(wake)}. End your turn now; the task continues with a "[Wake]" message when it happens.`;
  },
}, governor);
